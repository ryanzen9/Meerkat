import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import {
  toTurnSummary,
  type SessionTranscript,
  type SessionTurnSummary,
  type StoredUIMessage,
} from '../../../shared/sessionArchive';
import type { SessionArchive } from './sessionArchive';

const MAX_TRANSCRIPT_TURNS = 100;
const MAX_TRANSCRIPT_MESSAGES = 500;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

// Replays persisted UI message chunks into the exact assistant messages the
// user saw. The journal is archive-owned JSON, so a corrupt line only shortens
// the replayed turn instead of breaking the whole conversation.
export async function buildSessionTranscript(
  archive: SessionArchive,
  sessionId: string,
): Promise<SessionTranscript | undefined> {
  const meta = await archive.readMeta(sessionId);
  if (!meta) return undefined;
  const turns = await archive.listTurns(sessionId);
  const recent = turns.slice(-MAX_TRANSCRIPT_TURNS);
  let truncated = turns.length > recent.length;
  const recordedRuns = new Set(turns.map((turn) => turn.runId));
  if ((await archive.listTurnChunkIds(sessionId)).some((runId) => !recordedRuns.has(runId)))
    truncated = true;
  // Replay newest first against a hard byte budget so one huge archived run
  // cannot force the Webview to parse an unbounded response.
  let remainingBytes = MAX_TRANSCRIPT_BYTES;
  const visible: typeof recent = [];
  for (let index = recent.length - 1; index >= 0; index--) {
    const turn = recent[index]!;
    const bytes = await archive.turnChunkBytes(sessionId, turn.runId);
    if (bytes > remainingBytes) {
      truncated = true;
      continue;
    }
    remainingBytes -= bytes;
    visible.unshift(turn);
  }
  const messages: StoredUIMessage[] = [];
  for (const turn of visible) {
    messages.push({
      id: `user-${turn.runId}`,
      role: 'user',
      parts: [{ type: 'text', text: turn.text }],
    });
    if (turn.transcriptTruncated) truncated = true;
    const chunks = (await archive.readTurnChunks(sessionId, turn.runId)) as UIMessageChunk[];
    if (!chunks.length) {
      if (turn.status !== 'running') truncated = true;
      continue;
    }
    const assistant = await replayTurn(chunks, `assistant-${turn.runId}`);
    if (!assistant) {
      truncated = true;
      continue;
    }
    messages.push(...assistant);
  }
  const limited = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  if (limited.length < messages.length) truncated = true;
  return {
    messages: limited,
    turns: visible.map((turn): SessionTurnSummary => toTurnSummary(turn)),
    truncated,
  };
}

async function replayTurn(
  chunks: UIMessageChunk[],
  fallbackId: string,
): Promise<StoredUIMessage[]> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const ordered: StoredUIMessage[] = [];
  const indexes = new Map<string, number>();
  try {
    for await (const message of readUIMessageStream({
      stream,
      onError: () => undefined,
      terminateOnError: false,
    })) {
      const stored = toStoredMessage(message, fallbackId);
      if (!stored) continue;
      const index = indexes.get(stored.id);
      if (index === undefined) {
        indexes.set(stored.id, ordered.length);
        ordered.push(stored);
      } else ordered[index] = stored;
    }
  } catch {
    // Partial tool calls or a truncated final line: keep what was replayed.
  }
  return ordered;
}

function toStoredMessage(message: UIMessage, fallbackId: string): StoredUIMessage | undefined {
  if (message.role !== 'assistant' && message.role !== 'user') return undefined;
  return {
    // Chat streams do not always carry a message id; a deterministic fallback
    // keeps reloads stable without colliding with the user turn id.
    id: message.id || fallbackId,
    role: message.role,
    parts: message.parts as unknown[],
  };
}
