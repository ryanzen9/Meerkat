import type { ModelMessage } from 'ai';
import { BridgeError } from '../errors';

/** Bounded per-session model context. Also enforced before durable checkpoints. */
export const MAX_SESSION_HISTORY_BYTES = 2 * 1024 * 1024;

/** Serialized byte size used for durable history budgets. */
export function messageBytes(messages: ModelMessage[]): number {
  return Buffer.byteLength(JSON.stringify(messages));
}

/**
 * Enforces the context budget without failing the turn. Tool exchanges are the
 * expendable part: their full payloads remain in the UI transcript and review
 * archives, while user turns and visible assistant text stay in model history.
 * Tool calls are removed together with their results so the request never
 * contains an orphaned tool call.
 */
export function compactModelMessages(
  messages: ModelMessage[],
  maxBytes = MAX_SESSION_HISTORY_BYTES,
): ModelMessage[] {
  if (messageBytes(messages) <= maxBytes) return messages;
  const compacted: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    if (message.role !== 'assistant') {
      compacted.push(message);
      continue;
    }
    if (typeof message.content === 'string') {
      if (message.content.trim()) compacted.push({ role: 'assistant', content: message.content });
      continue;
    }
    const text: { type: 'text'; text: string }[] = [];
    for (const part of message.content) {
      if (part.type === 'text') text.push({ type: 'text', text: part.text });
    }
    // Drop tool-call/reasoning/file parts and assistant messages that only
    // existed to carry a tool call.
    if (text.length) compacted.push({ role: 'assistant', content: text });
  }
  return compacted;
}

// The Host owns complete, provider-neutral history, including tool results and
// provider metadata (for example encrypted reasoning and tool namespaces).
// When that exceeds the byte budget, tool exchanges are compacted away first.
export class SessionHistory {
  private messages: ModelMessage[] = [];

  constructor(messages: ModelMessage[] = []) {
    this.messages = this.prepare(messages);
  }

  getMessages(): ModelMessage[] {
    return structuredClone(this.messages);
  }

  commit(messages: ModelMessage[]): void {
    this.messages = this.prepare(messages);
  }

  /**
   * Called before starting a new turn. Returns true when tool history had to be
   * removed, so callers can surface a diagnostic without failing the request.
   */
  compact(): boolean {
    const next = compactModelMessages(this.messages);
    if (next === this.messages) return false;
    this.assertSize(next);
    this.messages = next;
    return true;
  }

  clear(): void {
    this.messages = [];
  }

  private prepare(messages: ModelMessage[]): ModelMessage[] {
    const next = compactModelMessages(structuredClone(messages));
    this.assertSize(next);
    return next;
  }

  private assertSize(messages: ModelMessage[]): void {
    if (messageBytes(messages) > MAX_SESSION_HISTORY_BYTES)
      throw new BridgeError('session_full', 'Session history is full. Start a new session.', 413);
  }
}
