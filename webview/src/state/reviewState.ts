import type { ChatMessage, ChatSession, ReviewTab, WebviewState } from '@shared/models';
import { isRecord } from '@shared/protocol';
import { isReasoningEffort } from '@shared/agentModels';
import { reviewSnapshotSchema } from '@shared/review';

export interface ReviewState {
  activeTab: ReviewTab;
  repositoryUri: string;
  activeSessionId: string;
  sessions: ChatSession[];
  pendingBridgeSessionReleases: string[];
}

export function createSession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    draft: '',
    messages: [],
    mode: 'chat',
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' || value.role === 'assistant') &&
    typeof value.text === 'string' &&
    value.text.length <= 4000 &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

function isSession(value: unknown): value is ChatSession {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    typeof value.draft === 'string' &&
    (value.bridgeSessionId === undefined ||
      (typeof value.bridgeSessionId === 'string' &&
        /^[\w-]{1,128}$/.test(value.bridgeSessionId))) &&
    (value.model === undefined || (typeof value.model === 'string' && value.model.length <= 128)) &&
    (value.accountId === undefined ||
      (typeof value.accountId === 'string' && /^[\w-]{1,128}$/.test(value.accountId))) &&
    Array.isArray(value.messages) &&
    value.messages.every(isChatMessage) &&
    new Set(value.messages.map(({ id }) => id)).size === value.messages.length
  );
}

export function restoreReviewState(saved: unknown): ReviewState {
  const data: WebviewState = isRecord(saved) ? saved : {};
  const valid = Array.isArray(data.sessions) ? data.sessions.filter(isSession) : [];
  const allSessions = [...new Map(valid.map((session) => [session.id, session])).values()];
  const sessions = allSessions.map((session) => {
    const restored = {
      ...session,
      title: session.title.slice(0, 80),
      draft: session.draft.slice(0, 4000),
      messages: session.messages.slice(-100),
    };
    if (!isReasoningEffort(restored.reasoningEffort)) delete restored.reasoningEffort;
    if (restored.mode !== 'chat' && restored.mode !== 'review') restored.mode = 'chat';
    const reviews = reviewSnapshotSchema.safeParse(restored.reviews);
    if (reviews.success) restored.reviews = reviews.data;
    else delete restored.reviews;
    return restored;
  });
  if (!sessions.length) sessions.push(createSession());
  const activeSessionId = sessions.some(({ id }) => id === data.activeSessionId)
    ? data.activeSessionId!
    : sessions[0]!.id;
  return {
    activeTab: data.activeTab === 'files' || data.activeTab === 'history' ? data.activeTab : 'chat',
    repositoryUri: typeof data.repositoryUri === 'string' ? data.repositoryUri : '',
    activeSessionId,
    sessions,
    pendingBridgeSessionReleases: pendingReleases(
      // Older versions queued destructive deletion for the history window.
      // Migrate that queue to model-only release and preserve stored reviews.
      [
        ...(Array.isArray(data.pendingBridgeSessionReleases)
          ? data.pendingBridgeSessionReleases
          : []),
        ...(Array.isArray(data.pendingBridgeSessionDeletes)
          ? data.pendingBridgeSessionDeletes
          : []),
      ]
        .filter((id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,128}$/.test(id))
        .slice(-1000),
      Array.isArray(data.pendingBridgeSessionReleases) ? [] : allSessions.slice(0, -20),
      sessions.slice(-20),
    ),
  };
}

function pendingReleases(
  previous: string[],
  removed: ChatSession[],
  retained: ChatSession[],
): string[] {
  const active = new Set(retained.map((session) => session.bridgeSessionId));
  return [
    ...new Set([
      ...previous,
      ...removed.flatMap((session) => (session.bridgeSessionId ? [session.bridgeSessionId] : [])),
    ]),
  ].filter((id) => !active.has(id));
}

export function startNewReviewSession(state: ReviewState): ReviewState {
  const empty = state.sessions.find(
    ({ messages, draft, bridgeSessionId }) => !messages.length && !draft && !bridgeSessionId,
  );
  const next = empty ? { ...empty } : createSession();
  delete next.reasoningEffort;
  const candidates = empty
    ? state.sessions.map((session) => (session.id === next.id ? next : session))
    : [...state.sessions, next];
  const recent = candidates.slice(-20);
  return {
    ...state,
    activeTab: 'chat',
    activeSessionId: next.id,
    sessions: candidates,
    pendingBridgeSessionReleases: pendingReleases(
      state.pendingBridgeSessionReleases,
      state.sessions.slice(-20).filter((item) => !recent.some(({ id }) => id === item.id)),
      recent,
    ),
  };
}

export function appendTurn(state: ReviewState, text: string, reply: string): ReviewState {
  const now = new Date().toISOString();
  return {
    ...state,
    activeTab: 'chat',
    sessions: state.sessions.map((session) =>
      session.id !== state.activeSessionId
        ? session
        : {
            ...session,
            title: session.messages.length ? session.title : text.replace(/\s+/g, ' ').slice(0, 60),
            updatedAt: now,
            draft: '',
            messages: [
              ...session.messages,
              { id: crypto.randomUUID(), role: 'user' as const, text, createdAt: now },
              { id: crypto.randomUUID(), role: 'assistant' as const, text: reply, createdAt: now },
            ].slice(-100),
          },
    ),
  };
}

export function sessionMarkdown(session: ChatSession): string {
  return `# ${session.title}\n\n${session.messages
    .map(({ role, text, reviewRunId }) => {
      if (!reviewRunId) return `## ${role === 'user' ? 'You' : 'Review'}\n\n${text}`;
      const run = session.reviews?.runs.find(({ id }) => id === reviewRunId);
      const findings =
        session.reviews?.findings.filter((finding) => finding.runId === reviewRunId) ?? [];
      return `## Review\n\n${findings.map((finding) => `### [${finding.priority}] ${finding.title}\n\n状态：${finding.status === 'resolved' ? '已解决' : '未解决'}\n\n${finding.description}\n\n${finding.references.map((ref) => ref.markdown).join(' · ')}`).join('\n\n')}\n\n${run?.summary ?? '审查未完成。'}`;
    })
    .join('\n\n')}`;
}
