import { createHash } from 'node:crypto';
import type {
  FinishReviewInput,
  ReviewFinding,
  ReviewRunState,
  ReviewSnapshotState,
  SubmitReviewInput,
  SubmitReviewResult,
} from '../../../shared/review';
import { BridgeError } from '../errors';
import { MAX_REVIEW_STATE_ITEMS } from '../../../shared/review';
import type { ReviewContext } from '../tools/reviewContext';
import type { ReviewToolContext } from '../tools/reviewWorkspace';

type Changes = Awaited<ReturnType<ReviewToolContext['listChanges']>>;
type Diff = Awaited<ReturnType<ReviewToolContext['getDiff']>>;
const normalize = (text: string) =>
  text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

function boundedStateItems(items: string[]): string[] {
  const unique = [...new Set(items)];
  if (unique.length <= MAX_REVIEW_STATE_ITEMS) return unique;
  const visible = MAX_REVIEW_STATE_ITEMS - 1;
  return [...unique.slice(0, visible), `另有 ${unique.length - visible} 项未展示。`];
}

// The session owns receipts independently of model history and stream delivery.
export class ReviewJournal {
  private readonly findings = new Map<string, ReviewFinding>();
  private readonly runs = new Map<string, ReviewRunState>();

  start(id: string, sessionId: string, text: string, context?: ReviewContext): ReviewRun {
    if (this.runs.size >= 1000)
      throw new BridgeError('review_full', 'Start a new session to continue reviewing.', 413);
    const state: ReviewRunState = {
      id,
      sessionId,
      text,
      status: 'running',
      findingIds: [],
      issueCount: 0,
      unfinishedItems: [],
      limitations: [],
      summary: '正在审查，已收录 0 条问题。',
      startedAt: new Date().toISOString(),
    };
    this.runs.set(id, state);
    return new ReviewRun(state, this.findings, context);
  }

  snapshot(): ReviewSnapshotState {
    return structuredClone({
      runs: [...this.runs.values()],
      findings: [...this.findings.values()],
    });
  }
}

export class ReviewRun {
  private snapshot: Changes | undefined;
  private readonly patches = new Map<string, { spans: Map<number, number>; end?: number }>();
  private readonly errors = new Map<string, string>();
  private readonly limitations = new Set<string>();
  private pending = 0;
  private finishIsAlone = true;
  finishInput: FinishReviewInput | undefined;

  constructor(
    readonly state: ReviewRunState,
    private readonly findings: Map<string, ReviewFinding>,
    private readonly context?: ReviewContext,
  ) {}

  private assertOpen() {
    if (this.finishInput || this.state.status !== 'running')
      throw new BridgeError('review_closed', 'Review is already closed.');
  }

  recordToolError(name: string) {
    // A successful finish is committed; late SDK notifications cannot reopen it.
    if (this.finishInput || this.state.status !== 'running') return;
    this.errors.set(name, `工具 ${name} 参数或执行失败，尚未修正。`);
  }

  prepareToolStep(toolNames: readonly string[]) {
    this.finishIsAlone = toolNames.length === 1 && toolNames[0] === 'finish_review';
  }

  async track<T>(name: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.pending++;
    try {
      const result = await action();
      this.assertOpen();
      this.errors.delete(name);
      if (name === 'list_changes') {
        const changes = result as Changes;
        this.snapshot = changes;
        this.patches.clear();
      } else if (name === 'get_diff') {
        const diff = result as Diff;
        if (diff.reviewId === this.snapshot?.reviewId) {
          for (const file of diff.files) {
            const progress = this.patches.get(file.path) ?? { spans: new Map<number, number>() };
            progress.spans.set(file.patchOffset, file.patchOffset + file.patch.length);
            if (file.patchEnd) progress.end = file.patchOffset + file.patch.length;
            this.patches.set(file.path, progress);
            if (file.binary) this.limitations.add(`二进制文件未进行源码审查：${file.path}`);
          }
        }
      } else if (name === 'read_file') {
        const file = result as Awaited<ReturnType<ReviewToolContext['readFile']>>;
        if (file.contentTruncated) this.limitations.add(`文件内容被截断：${file.path}`);
      } else if (name === 'search_code') {
        const search = result as Awaited<ReturnType<ReviewToolContext['searchCode']>>;
        if (search.truncated || search.skippedFiles)
          this.limitations.add('实时搜索有截断或跳过的文件。');
      } else if (name === 'get_diagnostics' && (result as { truncated: boolean }).truncated) {
        this.limitations.add('编辑器诊断有截断。');
      }
      return result;
    } catch (error) {
      this.errors.set(name, error instanceof BridgeError ? error.message : `${name} failed`);
      throw error;
    } finally {
      this.pending--;
    }
  }

  async submit(
    input: SubmitReviewInput,
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<SubmitReviewResult> {
    this.assertOpen();
    this.pending++;
    try {
      const context = this.context;
      if (!context) throw new BridgeError('review_unavailable', 'Review workspace is unavailable.');
      if (input.reviewId !== this.snapshot?.reviewId)
        throw new BridgeError(
          'review_scope_invalid',
          'Use the current run snapshot from list_changes.',
        );
      const references = await Promise.all(
        [...new Set(input.referenceIds)].map((id) => context.getFileReference(id, signal)),
      );
      if (references.some((ref) => ref.reviewId !== input.reviewId || ref.scope !== 'range'))
        throw new BridgeError(
          'review_reference_invalid',
          'Findings require verified code ranges from the same review snapshot.',
        );
      signal?.throwIfAborted();
      this.assertOpen();
      const locations = references.map((ref) => [
        ref.repository,
        ref.path,
        ref.version,
        ref.startLine,
        ref.endLine,
      ]);
      // oxlint-disable-next-line unicorn/no-array-sort -- The extension targets ES2022.
      locations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const id = createHash('sha256')
        .update(JSON.stringify([normalize(input.title), normalize(input.description), locations]))
        .digest('hex');
      const existing = this.findings.get(id);
      if (!existing && this.findings.size >= 1000)
        throw new BridgeError('review_full', 'Start a new session to continue reviewing.', 413);
      const finding: ReviewFinding = existing ?? {
        id,
        runId: this.state.id,
        toolCallId,
        title: input.title,
        priority: input.priority,
        description: input.description,
        references,
        savedAt: new Date().toISOString(),
      };
      // No await between validation and commit: parallel retries see this receipt.
      this.findings.set(id, finding);
      this.errors.delete('submit_review');
      if (!this.state.findingIds.includes(id)) this.state.findingIds.push(id);
      this.refreshSummary();
      return {
        accepted: true,
        duplicate: existing !== undefined,
        finding: structuredClone(finding),
      };
    } catch (error) {
      this.errors.set(
        'submit_review',
        error instanceof BridgeError ? error.message : 'Finding submission failed.',
      );
      throw error;
    } finally {
      this.pending--;
    }
  }

  private missingPaths(): string[] {
    return (
      this.snapshot?.changes
        .filter(({ path }) => {
          const progress = this.patches.get(path);
          if (!progress || progress.end === undefined) return true;
          let offset = 0;
          // oxlint-disable-next-line unicorn/no-array-sort -- The extension targets ES2022.
          const spans = [...progress.spans].sort(([a], [b]) => a - b);
          for (const [start, end] of spans) {
            if (start > offset) return true;
            offset = Math.max(offset, end);
          }
          return offset < progress.end;
        })
        .map(({ path }) => path) ?? []
    );
  }

  finish(input: FinishReviewInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.assertOpen();
    if (!this.finishIsAlone)
      throw new BridgeError(
        'review_finish_must_be_alone',
        'Call finish_review alone, in a separate model step after all other tool results.',
      );
    this.errors.delete('finish_review');
    if (this.pending)
      throw new BridgeError(
        'review_tools_pending',
        'Wait for other tools, then call finish_review alone.',
      );
    const missing = this.missingPaths();
    if (
      input.status === 'completed' &&
      (!this.snapshot || missing.length || input.unfinishedItems.length || this.errors.size)
    )
      throw new BridgeError(
        'review_incomplete',
        `Cannot complete: ${!this.snapshot ? 'list_changes is required. ' : ''}${missing.length ? `Read every diff page for: ${missing.join(', ')}. ` : ''}${input.unfinishedItems.length ? 'Unfinished items remain. ' : ''}${[...this.errors.values()].join('; ')}`,
      );
    if (input.status === 'incomplete' && !input.unfinishedItems.length && !input.limitations.length)
      throw new BridgeError(
        'review_incomplete',
        'Describe the unfinished items or review limitations.',
      );
    this.finishInput = structuredClone(input);
    this.state.unfinishedItems = boundedStateItems([
      ...input.unfinishedItems,
      ...missing.map((path) => `尚未完整读取 diff：${path}`),
    ]);
    this.state.limitations = boundedStateItems([
      ...input.limitations,
      ...this.limitations,
      ...this.errors.values(),
    ]);
    return { accepted: true as const, status: input.status };
  }

  settle(status: 'completed' | 'cancelled' | 'failed') {
    this.state.status =
      status === 'completed' ? (this.finishInput?.status ?? 'incomplete') : status;
    if (!this.finishInput) {
      this.state.unfinishedItems = boundedStateItems([
        '审查未通过 finish_review 收尾校验。',
        ...this.missingPaths().map((path) => `尚未完整读取 diff：${path}`),
      ]);
      this.state.limitations = boundedStateItems([...this.limitations, ...this.errors.values()]);
    }
    this.refreshSummary();
    return structuredClone(this.state);
  }

  private refreshSummary() {
    this.state.issueCount = this.state.findingIds.length;
    const label = {
      running: '正在审查',
      completed: '审查已完成',
      incomplete: '审查未完成',
      cancelled: '审查已取消',
      failed: '审查失败',
    }[this.state.status];
    this.state.summary = `${label}，已收录 ${this.state.issueCount} 条问题。`;
  }
}
