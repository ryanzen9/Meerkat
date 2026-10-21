import { randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { UIMessageChunk } from 'ai';
import { BridgeError } from '../errors';
import {
  SESSION_ARCHIVE_VERSION,
  sessionHistorySnapshotSchema,
  sessionMetaSchema,
  sessionTurnSchema,
  type SessionHistorySnapshot,
  type SessionMeta,
  type SessionMode,
  type SessionTurn,
  type SessionTurnError,
  type SessionTurnStatus,
} from '../../../shared/sessionArchive';

export const SESSION_ARCHIVE_DIRECTORY = 'sessions-v1';

const SESSION_ID = /^[\w-]{1,128}$/;
const RUN_ID = /^[\w-]{1,128}$/;
const TURN_FILE = /^([\w-]{1,128})\.json$/;
const FLUSH_THRESHOLD_BYTES = 64 * 1024;

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_TURNS_PER_SESSION = 200;
const DEFAULT_TRANSCRIPT_BYTES_PER_TURN = 8 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export interface SessionArchiveOptions {
  /** Diagnostics only: archive failures degrade durability, never chat itself. */
  log?: (message: string, error?: unknown) => void;
  maxSessions?: number;
  maxTurnsPerSession?: number;
  transcriptBytesPerTurn?: number;
  maxTotalBytes?: number;
}

interface HistoryWriteState {
  writing: boolean;
  pending: SessionHistorySnapshot | undefined;
  promise: Promise<void>;
}

export interface TurnJournalOptions {
  sessionId: string;
  runId: string;
  text: string;
  mode: SessionMode;
  reviewRunId?: string;
}

// Host-owned durable conversation archive. Model history checkpoints make a
// conversation resumable after a restart; turn journals replay what the user
// actually saw (tool calls, partial prose) independently of the model context.
export class SessionArchive {
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private readonly historyWrites = new Map<string, HistoryWriteState>();
  private readonly journals = new Map<string, TurnJournal>();
  private readonly deleted = new Set<string>();
  private readonly maxSessions: number;
  private readonly maxTurnsPerSession: number;
  private readonly transcriptBytesPerTurn: number;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly directory: string,
    private readonly options: SessionArchiveOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxTurnsPerSession = options.maxTurnsPerSession ?? DEFAULT_MAX_TURNS_PER_SESSION;
    this.transcriptBytesPerTurn =
      options.transcriptBytesPerTurn ?? DEFAULT_TRANSCRIPT_BYTES_PER_TURN;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  report(message: string, error?: unknown): void {
    this.options.log?.(message, error);
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async flush(): Promise<void> {
    await Promise.allSettled([...this.journals.values()].map((journal) => journal.flush()));
    await Promise.allSettled(this.sessionQueues.values());
    await Promise.allSettled([...this.historyWrites.values()].map((state) => state.promise));
  }

  async flushSession(sessionId: string): Promise<void> {
    await Promise.allSettled(
      [...this.journals.values()]
        .filter((journal) => journal.sessionId === sessionId)
        .map((journal) => journal.flush()),
    );
    await this.sessionQueues.get(sessionId)?.catch(() => undefined);
    const state = this.historyWrites.get(sessionId);
    if (state) await state.promise.catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.flush();
  }

  // ---- session metadata ----

  async writeMeta(meta: SessionMeta): Promise<void> {
    const parsed = sessionMetaSchema.parse(meta);
    await this.exclusive(parsed.id, async () => {
      await mkdir(this.sessionDir(parsed.id), { recursive: true, mode: 0o700 });
      await this.atomicWrite(this.metaPath(parsed.id), JSON.stringify(parsed));
    });
  }

  async readMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.readJson(this.metaPath(sessionId), sessionMetaSchema);
  }

  async listMeta(): Promise<SessionMeta[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      const meta = await this.readMeta(entry.name);
      if (meta && meta.id === entry.name) metas.push(meta);
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- Entries were freshly collected.
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  // ---- model history checkpoints ----

  writeHistory(snapshot: SessionHistorySnapshot): Promise<void> {
    const parsed = sessionHistorySnapshotSchema.safeParse(snapshot);
    if (!parsed.success)
      return Promise.reject(
        new BridgeError('session_save_failed', '会话历史检查点无效，已跳过保存。', 503),
      );
    const { sessionId } = parsed.data;
    if (this.deleted.has(sessionId))
      return Promise.reject(
        new BridgeError('session_not_found', 'Saved session was deleted.', 404),
      );
    let state = this.historyWrites.get(sessionId);
    if (!state) {
      state = { writing: false, pending: undefined, promise: Promise.resolve() };
      this.historyWrites.set(sessionId, state);
    }
    state.pending = parsed.data;
    if (state.writing) return state.promise;
    state.writing = true;
    state.promise = (async () => {
      try {
        while (state.pending) {
          const next = state.pending;
          state.pending = undefined;
          await this.writeHistoryFile(next);
        }
      } finally {
        state.writing = false;
        if (this.historyWrites.get(sessionId) === state && !state.pending)
          this.historyWrites.delete(sessionId);
      }
    })();
    return state.promise;
  }

  async readHistory(sessionId: string): Promise<SessionHistorySnapshot | undefined> {
    let text: string;
    try {
      text = await readFile(this.historyPath(sessionId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new BridgeError('session_corrupt', 'Saved conversation history is corrupt.', 409);
    }
    const parsed = sessionHistorySnapshotSchema.safeParse(data);
    if (!parsed.success || parsed.data.sessionId !== sessionId)
      throw new BridgeError('session_corrupt', 'Saved conversation history is corrupt.', 409);
    return parsed.data;
  }

  // ---- turn journals ----

  journal(options: TurnJournalOptions): TurnJournal {
    this.assertSessionId(options.sessionId);
    this.assertRunId(options.runId);
    const journal = new TurnJournal(this, options, this.transcriptBytesPerTurn);
    this.journals.set(options.runId, journal);
    return journal;
  }

  forgetJournal(runId: string): void {
    this.journals.delete(runId);
  }

  async startTurn(turn: SessionTurn): Promise<void> {
    const parsed = sessionTurnSchema.parse(turn);
    await this.exclusive(parsed.sessionId, async () => {
      if (this.deleted.has(parsed.sessionId))
        throw new BridgeError('session_not_found', 'Saved session was deleted.', 404);
      await mkdir(this.turnsDir(parsed.sessionId), { recursive: true, mode: 0o700 });
      await this.atomicWrite(this.turnPath(parsed.sessionId, parsed.runId), JSON.stringify(parsed));
      await this.noteStarted(parsed);
    });
  }

  async finishTurn(turn: SessionTurn): Promise<void> {
    const parsed = sessionTurnSchema.parse(turn);
    await this.exclusive(parsed.sessionId, async () => {
      if (this.deleted.has(parsed.sessionId))
        throw new BridgeError('session_not_found', 'Saved session was deleted.', 404);
      await mkdir(this.turnsDir(parsed.sessionId), { recursive: true, mode: 0o700 });
      await this.atomicWrite(this.turnPath(parsed.sessionId, parsed.runId), JSON.stringify(parsed));
      await this.noteFinished(parsed);
    });
  }

  appendTurnChunks(sessionId: string, runId: string, text: string): Promise<void> {
    this.assertSessionId(sessionId);
    this.assertRunId(runId);
    if (this.deleted.has(sessionId))
      return Promise.reject(
        new BridgeError('session_not_found', 'Saved session was deleted.', 404),
      );
    return appendFile(this.turnChunksPath(sessionId, runId), text, { mode: 0o600 });
  }

  /** Byte size of one turn's UI journal, used to bound transcript replay. */
  async turnChunkBytes(sessionId: string, runId: string): Promise<number> {
    this.assertSessionId(sessionId);
    this.assertRunId(runId);
    try {
      return (await stat(this.turnChunksPath(sessionId, runId))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async readTurnChunks(sessionId: string, runId: string): Promise<unknown[]> {
    this.assertSessionId(sessionId);
    this.assertRunId(runId);
    let text: string;
    try {
      text = await readFile(this.turnChunksPath(sessionId, runId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const chunks: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        chunks.push(JSON.parse(line));
      } catch {
        // A crash may leave a partial tail line; the completed prefix is still
        // exactly what the user saw before the host stopped.
        break;
      }
    }
    return chunks;
  }

  /** Chunk-journal ids, including journals whose turn record was lost. */
  async listTurnChunkIds(sessionId: string): Promise<string[]> {
    this.assertSessionId(sessionId);
    let entries;
    try {
      entries = await readdir(this.turnsDir(sessionId), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const runId = entry.name.slice(0, -6);
      if (RUN_ID.test(runId)) ids.push(runId);
    }
    return ids;
  }

  async listTurns(sessionId: string): Promise<SessionTurn[]> {
    this.assertSessionId(sessionId);
    let entries;
    try {
      entries = await readdir(this.turnsDir(sessionId), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const turns: SessionTurn[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !TURN_FILE.test(entry.name)) continue;
      const turn = await this.readJson(
        this.turnPath(sessionId, entry.name.slice(0, -5)),
        sessionTurnSchema,
      );
      if (turn && turn.sessionId === sessionId) turns.push(turn);
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- Freshly collected turns.
    turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return turns;
  }

  // ---- recovery and retention ----

  /**
   * Runs once per Host start, before the API accepts requests. Turns still
   * marked running belong to a previous process: they are interrupted rather
   * than silently presented as completed.
   */
  async recover(): Promise<void> {
    await this.initialize();
    const metas = await this.listMeta();
    const now = new Date().toISOString();
    for (const meta of metas) {
      const turns = await this.listTurns(meta.id);
      let lastStatus = meta.lastTurnStatus;
      for (const turn of turns) {
        if (turn.status !== 'running') {
          lastStatus = turn.status;
          continue;
        }
        const recovered: SessionTurn = {
          ...turn,
          status: 'interrupted',
          endedAt: now,
          error: {
            code: 'host_restart',
            message: 'Host 会话已结束，上一轮回答被中断。',
          },
        };
        try {
          await this.finishTurn(recovered);
          lastStatus = 'interrupted';
        } catch (error) {
          this.report(`Unable to mark archived turn ${turn.runId} interrupted`, error);
        }
      }
      if (lastStatus && lastStatus !== meta.lastTurnStatus) {
        try {
          await this.writeMeta({ ...meta, lastTurnStatus: lastStatus, updatedAt: meta.updatedAt });
        } catch (error) {
          this.report(`Unable to record recovered status for ${meta.id}`, error);
        }
      }
      await this.pruneTurns(meta.id);
    }
    await this.pruneSessions(metas);
    await this.enforceBudget(metas);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.assertSessionId(sessionId);
    this.deleted.add(sessionId);
    await this.flushSession(sessionId);
    await this.exclusive(sessionId, async () => {
      await rm(this.sessionDir(sessionId), { recursive: true, force: true });
    });
    this.historyWrites.delete(sessionId);
    for (const [runId, journal] of this.journals) {
      if (journal.sessionId === sessionId) this.journals.delete(runId);
    }
  }

  private async writeHistoryFile(snapshot: SessionHistorySnapshot): Promise<void> {
    await mkdir(this.sessionDir(snapshot.sessionId), { recursive: true, mode: 0o700 });
    await this.atomicWrite(this.historyPath(snapshot.sessionId), JSON.stringify(snapshot));
  }

  private async noteStarted(turn: SessionTurn): Promise<void> {
    const meta = await this.readMeta(turn.sessionId);
    if (!meta) return;
    const title = meta.title || turn.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    await this.writeMetaUnsafe({ ...meta, title, updatedAt: turn.startedAt });
  }

  private async noteFinished(turn: SessionTurn): Promise<void> {
    const meta = await this.readMeta(turn.sessionId);
    if (!meta) return;
    await this.writeMetaUnsafe({
      ...meta,
      updatedAt: turn.endedAt ?? meta.updatedAt,
      lastTurnStatus: turn.status,
    });
  }

  private async writeMetaUnsafe(meta: SessionMeta): Promise<void> {
    const parsed = sessionMetaSchema.parse(meta);
    await mkdir(this.sessionDir(parsed.id), { recursive: true, mode: 0o700 });
    await this.atomicWrite(this.metaPath(parsed.id), JSON.stringify(parsed));
  }

  private async pruneTurns(sessionId: string): Promise<void> {
    const turns = await this.listTurns(sessionId);
    if (turns.length <= this.maxTurnsPerSession) return;
    const removed = turns.slice(0, turns.length - this.maxTurnsPerSession);
    for (const turn of removed) {
      await rm(this.turnPath(sessionId, turn.runId), { force: true }).catch(() => undefined);
      await rm(this.turnChunksPath(sessionId, turn.runId), { force: true }).catch(() => undefined);
    }
  }

  private async pruneSessions(metas: SessionMeta[]): Promise<void> {
    for (const meta of metas.slice(this.maxSessions)) {
      await rm(this.turnsDir(meta.id), { recursive: true, force: true }).catch((error: unknown) => {
        this.report(`Unable to prune archived transcript for ${meta.id}`, error);
      });
    }
  }

  private async enforceBudget(metas: SessionMeta[]): Promise<void> {
    let bytes = await directorySize(this.directory);
    if (bytes <= this.maxTotalBytes) return;
    for (let index = metas.length - 1; index >= 0; index--) {
      if (bytes <= this.maxTotalBytes) return;
      const meta = metas[index]!;
      const turns = this.turnsDir(meta.id);
      const size = await directorySize(turns);
      if (!size) continue;
      await rm(turns, { recursive: true, force: true }).catch(() => undefined);
      bytes -= size;
    }
    // Still over budget: drop the oldest conversations' metadata and history too.
    for (const meta of metas.slice(this.maxSessions)) {
      if (bytes <= this.maxTotalBytes) return;
      const dir = this.sessionDir(meta.id);
      bytes -= await directorySize(dir);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---- paths and low-level IO ----

  private exclusive<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    this.assertSessionId(sessionId);
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.sessionQueues.set(sessionId, operation);
    void operation
      .finally(() => {
        if (this.sessionQueues.get(sessionId) === operation) this.sessionQueues.delete(sessionId);
      })
      .catch(() => undefined);
    return operation;
  }

  private async readJson<T>(
    path: string,
    schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  ): Promise<T | undefined> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.report(`Unable to read ${path}`, error);
      return undefined;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.report(`Corrupt JSON in ${path}`);
      return undefined;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      this.report(`Invalid archive data in ${path}`);
      return undefined;
    }
    return parsed.data;
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID.test(sessionId))
      throw new BridgeError('session_not_found', 'Session not found.', 404);
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID.test(runId)) throw new BridgeError('run_not_found', 'Run not found.', 404);
  }

  private sessionDir(sessionId: string): string {
    this.assertSessionId(sessionId);
    return join(this.directory, sessionId);
  }

  private metaPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'meta.json');
  }

  private historyPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'history.json');
  }

  private turnsDir(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'turns');
  }

  private turnPath(sessionId: string, runId: string): string {
    this.assertRunId(runId);
    return join(this.turnsDir(sessionId), `${runId}.json`);
  }

  private turnChunksPath(sessionId: string, runId: string): string {
    this.assertRunId(runId);
    return join(this.turnsDir(sessionId), `${runId}.jsonl`);
  }
}

export class TurnJournal {
  readonly sessionId: string;
  readonly runId: string;
  private readonly startedAt = new Date().toISOString();
  private readonly text: string;
  private readonly mode: SessionMode;
  private readonly reviewRunId: string | undefined;
  private readonly maxBytes: number;
  private status: SessionTurnStatus = 'running';
  private steps = 0;
  private truncated = false;
  private failed = false;
  private closed = false;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  // Bytes already appended to the on-disk journal. Buffered bytes reset after
  // every flush, so the per-turn limit must also include persisted bytes.
  private persistedBytes = 0;
  private queue: Promise<void>;

  constructor(
    private readonly archive: SessionArchive,
    options: TurnJournalOptions,
    maxBytes: number,
  ) {
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.text = options.text;
    this.mode = options.mode;
    this.reviewRunId = options.reviewRunId;
    this.maxBytes = maxBytes;
    this.queue = archive.startTurn(this.record()).catch((error: unknown) => {
      this.failed = true;
      archive.report('Unable to start turn journal', error);
    });
  }

  append(chunk: UIMessageChunk): void {
    if (this.closed || this.truncated || this.failed) return;
    const value = chunk as UIMessageChunk & { transient?: unknown };
    if (value.transient === true) return;
    // Stream errors are surfaced through the turn record; replaying them would
    // make the archived transcript fail to reconstruct.
    if (value.type === 'error') return;
    let line: string;
    try {
      line = JSON.stringify(chunk);
    } catch {
      return;
    }
    const lineBytes = Buffer.byteLength(`${line}\n`);
    if (this.persistedBytes + this.bufferedBytes + lineBytes > this.maxBytes) {
      this.truncated = true;
      return;
    }
    this.buffer.push(`${line}\n`);
    this.bufferedBytes += lineBytes;
    if (this.bufferedBytes >= FLUSH_THRESHOLD_BYTES) void this.flush();
  }

  checkpoint(steps: number): void {
    this.steps = Math.max(this.steps, steps);
  }

  flush(): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(() => this.writeBuffer());
    return this.queue;
  }

  async finish(status: SessionTurnStatus, error?: SessionTurnError): Promise<void> {
    if (this.closed) {
      await this.flush();
      return;
    }
    this.closed = true;
    this.status = status;
    await this.flush();
    try {
      await this.archive.finishTurn(this.record(error));
    } catch (failure) {
      this.archive.report('Unable to finish turn journal', failure);
    } finally {
      this.archive.forgetJournal(this.runId);
    }
  }

  record(error?: SessionTurnError): SessionTurn {
    return {
      version: SESSION_ARCHIVE_VERSION,
      runId: this.runId,
      sessionId: this.sessionId,
      text: this.text,
      mode: this.mode,
      status: this.status,
      checkpoints: this.steps,
      ...(this.reviewRunId ? { reviewRunId: this.reviewRunId } : {}),
      startedAt: this.startedAt,
      ...(this.status !== 'running' ? { endedAt: new Date().toISOString() } : {}),
      ...(error ? { error } : {}),
      ...(this.truncated ? { transcriptTruncated: true } : {}),
    };
  }

  private async writeBuffer(): Promise<void> {
    if (!this.buffer.length || this.failed) return;
    const data = this.buffer.join('');
    const bytes = Buffer.byteLength(data);
    this.buffer = [];
    this.bufferedBytes = 0;
    try {
      await this.archive.appendTurnChunks(this.sessionId, this.runId, data);
      this.persistedBytes += bytes;
    } catch (error) {
      this.failed = true;
      this.archive.report('Unable to append turn transcript', error);
    }
  }
}

async function directorySize(path: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch {
        // Ignore files that disappeared during the scan.
      }
    }
  }
  return total;
}
