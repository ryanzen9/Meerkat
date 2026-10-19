import { expect, test } from 'bun:test';
import {
  appendTurn,
  createSession,
  restoreReviewState,
  sessionMarkdown,
  startNewReviewSession,
} from '../src/state/reviewState';

test('invalid saved state recovers to a usable chat session', () => {
  for (const saved of [
    undefined,
    null,
    [],
    { sessions: [null, { id: 'broken' }], activeTab: 'unknown' },
  ]) {
    const state = restoreReviewState(saved);
    expect(state.activeTab).toBe('chat');
    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe(state.sessions[0]!.id);
  }
});

test('a conversation restores its messages, draft, selected tab and repository', () => {
  const session = { ...createSession(), draft: '检查这个 diff' };
  const state = restoreReviewState({
    sessions: [session],
    activeSessionId: session.id,
    activeTab: 'files',
    repositoryUri: 'file:///repo',
  });
  const next = appendTurn(state, '检查布局', '模型尚未配置');
  expect(next.activeTab).toBe('chat');
  expect(next.sessions[0]?.messages.map(({ role }) => role)).toEqual(['user', 'assistant']);
  expect(next.sessions[0]?.draft).toBe('');
  expect(next.sessions[0]?.title).toBe('检查布局');
  expect(state.sessions[0]?.draft).toBe('检查这个 diff');
  const restored = restoreReviewState(JSON.parse(JSON.stringify(next)));
  expect(restored).toEqual(next);
  expect(
    restoreReviewState({ ...next, sessions: [next.sessions[0], next.sessions[0]] }).sessions,
  ).toHaveLength(1);
  expect(sessionMarkdown(restored.sessions[0]!)).toContain(
    '## You\n\n检查布局\n\n## Review\n\n模型尚未配置',
  );
});

test('switching sessions preserves other conversations and bounds retained history', () => {
  const first = createSession();
  const second = createSession();
  let state = restoreReviewState({ sessions: [first, second], activeSessionId: second.id });
  for (let index = 0; index < 55; index++) state = appendTurn(state, `问题 ${index}`, '回复');
  expect(state.sessions[0]).toEqual(first);
  expect(state.sessions[1]?.messages).toHaveLength(100);
  expect(state.sessions[1]?.messages[0]?.text).toBe('问题 5');
  const invalid = {
    ...first,
    messages: [{ id: 'bad', role: 'assistant', text: 'bad', createdAt: 'not-a-date' }],
  };
  expect(restoreReviewState({ sessions: [invalid] }).sessions[0]?.messages).toEqual([]);
});

test('the recent model window retains all conversations and their review metadata', () => {
  const first = appendTurn(restoreReviewState({}), 'first retained review', 'saved receipt');
  first.sessions[0]!.bridgeSessionId = crypto.randomUUID();
  const original = structuredClone(first.sessions[0]!);
  let state = first;
  for (let index = 0; index < 25; index++) {
    state = startNewReviewSession(state);
    state = appendTurn(state, `question-${index}`, 'answer');
  }
  expect(state.sessions).toHaveLength(26);
  expect(state.sessions[0]).toEqual(original);
  expect(state.pendingBridgeSessionReleases).toContain(original.bridgeSessionId!);
  const restored = restoreReviewState(JSON.parse(JSON.stringify(state)));
  expect(restored.sessions).toEqual(state.sessions);
  expect(restored.pendingBridgeSessionReleases).toEqual(state.pendingBridgeSessionReleases);
  // Once released, restoration must not enqueue the same historical IDs again.
  expect(
    restoreReviewState({ ...restored, pendingBridgeSessionReleases: [] })
      .pendingBridgeSessionReleases,
  ).toEqual([]);
  const legacy = restoreReviewState({ pendingBridgeSessionDeletes: [crypto.randomUUID()] });
  expect(legacy.pendingBridgeSessionReleases).toHaveLength(1);
});

test('reasoning settings restore per session and invalid saved settings preserve the transcript', () => {
  const original = { ...createSession(), reasoningEffort: 'high' as const };
  const state = appendTurn(restoreReviewState({ sessions: [original] }), 'Question', 'Answer');
  expect(restoreReviewState(state).sessions[0]!.reasoningEffort).toBe('high');
  const restored = restoreReviewState({
    ...state,
    sessions: [{ ...state.sessions[0], reasoningEffort: 'invalid' }],
  });
  expect(restored.sessions[0]!.messages).toHaveLength(2);
  expect(restored.sessions[0]!.reasoningEffort).toBeUndefined();
  const empty = restoreReviewState({ sessions: [original] });
  const next = startNewReviewSession(empty);
  expect(next.sessions[0]!.reasoningEffort).toBeUndefined();
  expect(empty.sessions[0]!.reasoningEffort).toBe('high');
});
