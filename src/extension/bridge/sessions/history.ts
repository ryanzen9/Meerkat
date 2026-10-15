import type { ModelMessage } from 'ai';
import { BridgeError } from '../errors';

// The Host owns complete, provider-neutral history, including tool results and
// provider metadata (for example encrypted reasoning and tool namespaces).
export class SessionHistory {
  private messages: ModelMessage[] = [];

  getMessages(): ModelMessage[] {
    return structuredClone(this.messages);
  }

  commit(messages: ModelMessage[]): void {
    const next = structuredClone(messages);
    if (Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024)
      throw new BridgeError('session_full', 'Session history is full. Start a new session.', 413);
    this.messages = next;
  }

  clear(): void {
    this.messages = [];
  }
}
