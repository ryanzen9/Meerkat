import { randomUUID } from 'node:crypto';
import type { UIMessageChunk } from 'ai';
import { BridgeError, publicError } from '../errors';
import type { ProviderRegistry } from '../providers/registry';
import { SessionStore } from '../sessions/store';
import type { ReasoningEffort } from '../../../shared/agentModels';
import { streamReviewAgent, type ReviewAgentOptions } from './reviewAgent';
import type { ReviewContext } from '../tools/reviewContext';
import { AGENT_IDLE_TIMEOUT_MS, createIdleTimer } from '../../../shared/bridgeTiming';
import type { InteractionMode } from '../../../shared/review';
import type { ReviewStorage } from '../sessions/reviewArchive';
import type { FileReferenceArchive, SessionFileReferences } from '../sessions/fileReferenceArchive';

export type RunStatus = 'running' | 'completed' | 'incomplete' | 'cancelled' | 'failed';
interface Run {
  id: string;
  sessionId: string;
  providerId: string;
  status: RunStatus;
  settled: boolean;
  controller: AbortController;
  ended: Promise<void>;
  finish(): void;
}
export class BridgeRuntime {
  readonly sessions: SessionStore;
  private readonly runs = new Map<string, Run>();
  private closed = false;
  private readonly reviewContexts = new Map<string, ReviewContext>();
  private readonly releases = new Map<string, Promise<void>>();
  constructor(
    readonly registry: ProviderRegistry,
    private readonly options: ReviewAgentOptions = {},
    private readonly createReviewContext?: (references?: SessionFileReferences) => ReviewContext,
    reviewStorage?: ReviewStorage,
    private readonly fileReferences?: FileReferenceArchive,
  ) {
    this.sessions = new SessionStore(reviewStorage);
  }

  start(
    sessionId: string,
    text: string,
    signal: AbortSignal,
    reasoningEffort?: ReasoningEffort,
    mode: InteractionMode = 'chat',
  ): { runId: string; stream: ReadableStream<UIMessageChunk> } {
    if (this.closed) throw new BridgeError('bridge_closed', 'Bridge is shutting down.', 503);
    const session = this.sessions.get(sessionId);
    if (this.releases.has(sessionId))
      throw new BridgeError('session_busy', 'The model session is being released.', 409);
    if (!this.reviewContexts.has(sessionId) && this.createReviewContext)
      this.reviewContexts.set(
        sessionId,
        this.createReviewContext(this.fileReferences?.session(sessionId)),
      );
    const reviewContext = this.reviewContexts.get(sessionId);
    if ([...this.runs.values()].some((r) => r.sessionId === sessionId && !r.settled))
      throw new BridgeError('session_busy', 'A run is already active in this session.', 409);
    const runId = randomUUID();
    const reviewRun =
      mode === 'review' ? session.reviews.start(runId, sessionId, text, reviewContext) : undefined;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const idle = createIdleTimer(
      () =>
        controller.abort(
          new BridgeError(
            'run_idle_timeout',
            'No model or tool response was received within the inactivity timeout.',
            408,
          ),
        ),
      this.options.idleTimeoutMs ?? AGENT_IDLE_TIMEOUT_MS,
    );
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run: Run = {
      id: runId,
      sessionId,
      providerId: session.providerId,
      status: 'running',
      settled: false,
      controller,
      ended,
      finish,
    };
    // Keep bounded status history; running records are never evicted.
    for (const [id, old] of this.runs) {
      if (this.runs.size < 200) break;
      if (old.settled) this.runs.delete(id);
    }
    this.runs.set(run.id, run);
    const provider = this.registry.get(session.providerId);
    const agentOptions = { ...this.options, reviewRun };
    const reviewState = (
      status: 'completed' | 'cancelled' | 'failed',
    ): UIMessageChunk | undefined =>
      reviewRun
        ? { type: 'data-review-status', id: run.id, data: reviewRun.settle(status) }
        : undefined;
    const state = (): UIMessageChunk => ({
      type: 'data-run-state',
      data: {
        runId: run.id,
        sessionId,
        status: run.status,
      },
      transient: true,
    });
    let reader: ReadableStreamDefaultReader<UIMessageChunk> | undefined;
    let opening: Promise<ReadableStreamDefaultReader<UIMessageChunk>> | undefined;
    let terminal = false;
    let first = true;
    let finishChunk: UIMessageChunk | undefined;
    let abortOutput: (() => void) | undefined;
    const cleanup = () => {
      idle.dispose();
      terminal = true;
      run.settled = true;
      combined.removeEventListener('abort', aborted);
      // Cancellation can close the stream before another pull. Flush its final
      // state before shutdown/deletion considers the run fully settled.
      if (!reviewRun) {
        run.finish();
        return;
      }
      void session.reviews
        .flush()
        .catch(() => {})
        .then(() => session.reviews.save())
        .catch(() => {})
        .finally(() => run.finish());
    };
    const aborted = () => {
      if (terminal) return;
      terminal = true;
      run.status = 'cancelled';
      abortOutput?.();
      void (async () => {
        try {
          await (reader ?? (await opening))?.cancel();
        } catch {
          /* Reader may already be closed. */
        } finally {
          cleanup();
        }
      })();
    };
    const stream = new ReadableStream<UIMessageChunk>({
      start(output) {
        abortOutput = () => {
          const failure =
            combined.reason instanceof BridgeError
              ? combined.reason
              : new BridgeError('run_cancelled', 'Run cancelled.', 408);
          const review = reviewState('cancelled');
          if (review) output.enqueue(review);
          output.enqueue({
            type: 'error',
            errorText: `${failure.code}: ${failure.message}`,
          });
          output.enqueue(state());
          output.close();
        };
        combined.addEventListener('abort', aborted, { once: true });
        if (reviewRun) output.enqueue({ type: 'start', messageId: `review-${run.id}` });
        if (reviewRun)
          output.enqueue({
            type: 'data-review-status',
            id: run.id,
            data: structuredClone(reviewRun.state),
            transient: true,
          });
        if (combined.aborted) aborted();
      },
      async pull(output) {
        if (terminal) return;
        try {
          if (first) {
            first = false;
            output.enqueue(state());
            return;
          }
          combined.throwIfAborted();
          opening ??= streamReviewAgent(
            provider,
            session,
            text,
            combined,
            reasoningEffort,
            reviewContext,
            agentOptions,
          ).then((source) => source.getReader());
          reader ??= await opening;
          let next = await reader.read();
          if (reviewRun) {
            while (!next.done && (next.value.type === 'start' || next.value.type === 'finish')) {
              if (next.value.type === 'finish') finishChunk = next.value;
              idle.reset();
              next = await reader.read();
            }
          }
          if (terminal) return;
          if (!next.done) {
            idle.reset();
            output.enqueue(next.value);
            if (reviewRun && next.value.type === 'tool-output-available') {
              const receipt = next.value.output as { accepted?: boolean; finding?: unknown };
              if (receipt?.accepted && receipt.finding)
                output.enqueue({
                  type: 'data-review-receipt',
                  data: { run: structuredClone(reviewRun.state), result: receipt },
                  transient: true,
                });
            }
            return;
          }
          run.status = 'completed';
          const review = reviewState('completed');
          if (review) await session.reviews.save();
          if (terminal) return;
          if (reviewRun?.state.status === 'incomplete') run.status = 'incomplete';
          if (review) output.enqueue(review);
          if (finishChunk) output.enqueue(finishChunk);
          output.enqueue(state());
          output.close();
          cleanup();
        } catch (error) {
          if (terminal) return;
          const failure = combined.aborted
            ? combined.reason instanceof BridgeError
              ? combined.reason
              : new BridgeError('run_cancelled', 'Run cancelled.', 408)
            : publicError(error);
          run.status =
            combined.aborted || failure.code === 'tool_idle_timeout' ? 'cancelled' : 'failed';
          const review = reviewState(run.status);
          if (review) output.enqueue(review);
          output.enqueue({ type: 'error', errorText: `${failure.code}: ${failure.message}` });
          output.enqueue(state());
          output.close();
          cleanup();
        }
      },
      async cancel() {
        if (!terminal) {
          reviewRun?.settle('cancelled');
          abortOutput = undefined;
          controller.abort();
          await run.ended;
        }
      },
    });
    return { runId: run.id, stream };
  }

  status(id: string) {
    const run = this.runs.get(id);
    if (!run) throw new BridgeError('run_not_found', 'Run not found.', 404);
    return { id: run.id, sessionId: run.sessionId, status: run.status };
  }
  async readFileReference(sessionId: string, referenceId: string) {
    if (this.closed) throw new BridgeError('bridge_closed', 'Bridge is shutting down.', 503);
    let context = this.reviewContexts.get(sessionId);
    // Opening a saved citation must not depend on (or recreate) a provider/model
    // session. Ordinary chat citations may also exist without a review journal.
    if (!context && this.createReviewContext && (await this.fileReferences?.has(sessionId))) {
      context = this.createReviewContext(this.fileReferences?.session(sessionId));
      this.reviewContexts.set(sessionId, context);
    }
    if (!context)
      throw new BridgeError('reference_not_found', 'File reference expired or is unknown.', 404);
    const result = await context.readFileReference(referenceId);
    let journal;
    try {
      journal = this.sessions.reviews.get(sessionId);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'review_not_found') throw error;
    }
    await journal?.flush();
    // The editor receives only committed receipts from the reference's own session.
    return { ...result, findings: journal?.findingsForReference(referenceId) ?? [] };
  }
  cancel(id: string): void {
    const run = this.runs.get(id);
    if (!run) throw new BridgeError('run_not_found', 'Run not found.', 404);
    if (run.status === 'running') run.controller.abort();
  }
  async cancelProvider(providerId: string): Promise<void> {
    const active = [...this.runs.values()].filter((r) => r.providerId === providerId && !r.settled);
    active.forEach((r) => r.controller.abort());
    await Promise.all(active.map((r) => r.ended));
  }
  async deleteSession(id: string): Promise<void> {
    let journal;
    try {
      journal = this.sessions.reviews.get(id);
    } catch (error) {
      if (
        !(error instanceof BridgeError) ||
        error.code !== 'review_not_found' ||
        !(await this.fileReferences?.has(id))
      )
        throw error;
    }
    const active = [...this.runs.values()].find((r) => r.sessionId === id && !r.settled);
    if (active) {
      active.controller.abort();
      await active.ended;
    }
    await this.fileReferences?.delete(id);
    if (journal) await this.sessions.reviews.delete(id);
    this.sessions.delete(id);
    this.reviewContexts.get(id)?.dispose();
    this.reviewContexts.delete(id);
  }
  releaseSession(id: string): Promise<void> {
    const existing = this.releases.get(id);
    if (existing) return existing;
    const session = this.sessions.get(id);
    const operation = (async () => {
      const active = [...this.runs.values()].find((run) => run.sessionId === id && !run.settled);
      if (active) {
        active.controller.abort();
        await active.ended;
      }
      await session.reviews.flush();
      if (session.reviews.snapshot().runs.length) await session.reviews.save();
      // Bound live model histories without deleting accepted findings or the
      // exact reference documents belonging to the historical conversation.
      this.sessions.delete(id);
      this.reviewContexts.get(id)?.dispose();
      this.reviewContexts.delete(id);
    })();
    this.releases.set(id, operation);
    void operation.finally(() => this.releases.delete(id)).catch(() => {});
    return operation;
  }
  async dispose(): Promise<void> {
    this.closed = true;
    await Promise.all(this.registry.list().map((p) => this.cancelProvider(p.id)));
    await Promise.allSettled(this.releases.values());
    for (const session of this.sessions.list()) {
      await session.reviews.flush();
      if (session.reviews.snapshot().runs.length) await session.reviews.save();
      this.sessions.delete(session.id);
    }
    for (const context of this.reviewContexts.values()) context.dispose();
    this.reviewContexts.clear();
    await this.fileReferences?.close();
    await this.registry.dispose();
  }
}
