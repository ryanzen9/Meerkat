import { randomUUID } from 'node:crypto';
import { BridgeError } from '../errors';
import { SessionHistory } from './history';
import { ReviewJournal } from './reviews';
import type { ProviderSession } from '../providers/types';

export interface BridgeSession {
  id: string;
  providerId: string;
  createdAt: string;
  provider: ProviderSession;
  history: SessionHistory;
  reviews: ReviewJournal;
}
export function sessionInfo(session: BridgeSession) {
  return {
    id: session.id,
    providerId: session.providerId,
    model: session.provider.model,
    accountId: session.provider.accountId,
    createdAt: session.createdAt,
  };
}
export class SessionStore {
  private readonly sessions = new Map<string, BridgeSession>();
  create(providerId: string, provider: ProviderSession): BridgeSession {
    if (this.sessions.size >= 100)
      throw new BridgeError('sessions_full', 'Delete a session before creating another.', 429);
    const session = {
      id: randomUUID(),
      providerId,
      provider,
      history: new SessionHistory(),
      reviews: new ReviewJournal(),
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string): BridgeSession {
    const session = this.sessions.get(id);
    if (!session) throw new BridgeError('session_not_found', 'Session not found.', 404);
    return session;
  }
  list(): BridgeSession[] {
    return [...this.sessions.values()];
  }
  delete(id: string): void {
    this.sessions.get(id)?.history.clear();
    this.sessions.delete(id);
  }
}
