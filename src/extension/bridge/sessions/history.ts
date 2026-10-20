import type { ModelMessage } from 'ai';
import { BridgeError } from '../errors';

/** Bounded per-session model context. Also enforced before durable checkpoints. */
export const MAX_SESSION_HISTORY_BYTES = 2 * 1024 * 1024;

// The Host owns complete, provider-neutral history, including tool results and
// provider metadata (for example encrypted reasoning and tool namespaces).
export class SessionHistory {
  private messages: ModelMessage[] = [];

  constructor(messages: ModelMessage[] = []) {
    const next = structuredClone(messages);
    this.assertSize(next);
    this.messages = next;
  }

  getMessages(): ModelMessage[] {
    return structuredClone(this.messages);
  }

  commit(messages: ModelMessage[]): void {
    const next = structuredClone(messages);
    this.assertSize(next);
    this.messages = next;
  }

  clear(): void {
    this.messages = [];
  }

  private assertSize(messages: ModelMessage[]): void {
    if (Buffer.byteLength(JSON.stringify(messages)) > MAX_SESSION_HISTORY_BYTES)
      throw new BridgeError('session_full', 'Session history is full. Start a new session.', 413);
  }
}
