import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { BridgeError } from '../errors';
import { SessionHistory } from './history';
import type { ReviewJournal } from './reviews';
import { ReviewArchive, type ReviewStorage } from './reviewArchive';
import type { ProviderSession } from '../providers/types';
import type { SessionArchive } from './sessionArchive';
import { SESSION_ARCHIVE_VERSION, type SessionMeta } from '../../../shared/sessionArchive';

export interface BridgeSession {
  id: string;
  providerId: string;
  createdAt: string;
  provider: ProviderSession;
  history: SessionHistory;
  reviews: ReviewJournal;
  /** A corrupt archive can be inspected but must not accept new inference. */
  readOnly?: boolean;
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
  private readonly hydrating = new Map<string, Promise<BridgeSession>>();
  readonly reviews: ReviewArchive;
  readonly archive: SessionArchive | undefined;
  constructor(storage?: ReviewStorage, archive?: SessionArchive) {
    this.reviews = new ReviewArchive(storage);
    this.archive = archive;
  }
  create(providerId: string, provider: ProviderSession): BridgeSession {
    if (this.sessions.size >= 100)
      throw new BridgeError('sessions_full', 'Delete a session before creating another.', 429);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const session = {
      id,
      providerId,
      provider,
      history: new SessionHistory(),
      reviews: this.reviews.create(id),
      createdAt,
    };
    this.sessions.set(session.id, session);
    if (this.archive)
      void this.archive
        .writeMeta({
          version: SESSION_ARCHIVE_VERSION,
          id,
          providerId,
          model: provider.model,
          accountId: provider.accountId,
          title: '',
          createdAt,
          updatedAt: createdAt,
          ...(provider.supportedReasoningEfforts
            ? { supportedReasoningEfforts: provider.supportedReasoningEfforts }
            : {}),
          ...(provider.defaultReasoningEffort
            ? { defaultReasoningEffort: provider.defaultReasoningEffort }
            : {}),
        })
        .catch((error: unknown) => this.archive?.report(`Unable to persist session ${id}`, error));
    return session;
  }
  get(id: string): BridgeSession {
    const session = this.sessions.get(id);
    if (!session) throw new BridgeError('session_not_found', 'Session not found.', 404);
    return session;
  }
  /**
   * Returns a live session, lazily rehydrating a durable conversation after a
   * Host restart. A corrupt archive becomes a read-only session instead of a
   * silent, context-free new conversation.
   */
  async ensure(id: string): Promise<BridgeSession> {
    const live = this.sessions.get(id);
    if (live) return live;
    const pending = this.hydrating.get(id);
    if (pending) return pending;
    const operation = this.hydrate(id);
    this.hydrating.set(id, operation);
    try {
      return await operation;
    } finally {
      this.hydrating.delete(id);
    }
  }
  list(): BridgeSession[] {
    return [...this.sessions.values()];
  }
  async listArchived(): Promise<SessionMeta[]> {
    return (await this.archive?.listMeta()) ?? [];
  }
  delete(id: string): void {
    this.sessions.get(id)?.history.clear();
    this.sessions.delete(id);
  }
  private async hydrate(id: string): Promise<BridgeSession> {
    const archive = this.archive;
    if (!archive) throw new BridgeError('session_not_found', 'Session not found.', 404);
    const meta = await archive.readMeta(id);
    if (!meta || meta.id !== id)
      throw new BridgeError('session_not_found', 'Session not found.', 404);
    let readOnly = false;
    let history = new SessionHistory();
    try {
      const saved = await archive.readHistory(id);
      if (saved) history = new SessionHistory(saved.messages as ModelMessage[]);
    } catch (error) {
      readOnly = true;
      archive.report(`Unable to restore conversation history ${id}`, error);
    }
    let reviews: ReviewJournal;
    try {
      reviews = this.reviews.get(id);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'review_not_found') {
        readOnly = true;
        archive.report(`Unable to restore review journal ${id}`, error);
      }
      reviews = this.reviews.create(id);
    }
    const session: BridgeSession = {
      id,
      providerId: meta.providerId,
      createdAt: meta.createdAt,
      provider: {
        model: meta.model,
        accountId: meta.accountId,
        ...(meta.supportedReasoningEfforts
          ? { supportedReasoningEfforts: meta.supportedReasoningEfforts }
          : {}),
        ...(meta.defaultReasoningEffort
          ? { defaultReasoningEffort: meta.defaultReasoningEffort }
          : {}),
      },
      history,
      reviews,
      ...(readOnly ? { readOnly: true } : {}),
    };
    this.sessions.set(id, session);
    return session;
  }
}
