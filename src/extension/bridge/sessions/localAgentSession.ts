import type { AgentInputItem, Session } from '@openai/agents';
import { BridgeError } from '../errors';

// Local full-history replay is required by ChatGPT's store:false HTTP contract.
// Implement the SDK Session contract; no Conversations API or response-ID continuation.
export class LocalAgentSession implements Session {
  private items: AgentInputItem[] = [];
  constructor(private readonly id: string) {}
  async getSessionId(): Promise<string> {
    return this.id;
  }
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return structuredClone(
      limit === undefined ? this.items : limit === 0 ? [] : this.items.slice(-limit),
    );
  }
  async addItems(items: AgentInputItem[]): Promise<void> {
    const next = [...this.items, ...structuredClone(items)];
    if (Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024)
      throw new BridgeError('session_full', 'Session history is full. Start a new session.', 413);
    this.items = next;
  }
  async popItem(): Promise<AgentInputItem | undefined> {
    return this.items.pop();
  }
  async clearSession(): Promise<void> {
    this.items = [];
  }
  async fork(): Promise<LocalAgentSession> {
    const staged = new LocalAgentSession(this.id);
    await staged.addItems(await this.getItems());
    return staged;
  }
  async commit(staged: LocalAgentSession): Promise<void> {
    this.items = await staged.getItems();
  }
}
