import { expect, test } from 'bun:test';
import {
  appendTurn,
  createSession,
  restoreReviewState,
  sessionMarkdown,
} from '../src/webview/state/reviewState';

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
