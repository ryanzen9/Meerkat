import type * as vscode from 'vscode';
import type { PanelState } from '../../shared/models';

export class StateService {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: vscode.Memento) {}

  read(): PanelState {
    const value = this.storage.get<unknown>('meerkat.messageCount', 0);
    return {
      messageCount:
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0,
    };
  }

  incrementMessageCount(): Promise<PanelState> {
    const next = this.writes.then(async () => {
      const messageCount = Math.min(this.read().messageCount + 1, Number.MAX_SAFE_INTEGER);
      await this.storage.update('meerkat.messageCount', messageCount);
      return { messageCount };
    });
    this.writes = next.catch(() => undefined);
    return next;
  }
}
