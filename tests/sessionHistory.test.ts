import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  MAX_SESSION_HISTORY_BYTES,
  SessionHistory,
  compactModelMessages,
  messageBytes,
} from '../src/extension/bridge/sessions/history';

function oversizedHistory(): ModelMessage[] {
  const hugeOutput = 'x'.repeat(MAX_SESSION_HISTORY_BYTES + 1024);
  return [
    { role: 'user', content: 'Question' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me inspect the file.' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'read_file',
          input: { path: 'a.ts' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read_file',
          output: { type: 'text', value: hugeOutput },
        },
      ],
    },
    { role: 'assistant', content: 'Final answer.' },
    { role: 'user', content: 'Next question' },
  ];
}

test('oversized histories drop tool exchanges but keep user and assistant text', () => {
  const compacted = compactModelMessages(oversizedHistory());
  expect(messageBytes(compacted)).toBeLessThanOrEqual(MAX_SESSION_HISTORY_BYTES);
  expect(compacted).toEqual([
    { role: 'user', content: 'Question' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Let me inspect the file.' }],
    },
    { role: 'assistant', content: 'Final answer.' },
    { role: 'user', content: 'Next question' },
  ]);
  const serialized = JSON.stringify(compacted);
  expect(serialized).not.toContain('tool-call');
  expect(serialized).not.toContain('tool-result');
});

test('histories under the budget are returned untouched', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Answer' },
  ];
  expect(compactModelMessages(messages)).toBe(messages);
  expect(new SessionHistory(messages).getMessages()).toEqual(messages);
});

test('rehydrated and committed histories compact instead of becoming read-only', () => {
  const restored = new SessionHistory(oversizedHistory());
  expect(messageBytes(restored.getMessages())).toBeLessThanOrEqual(MAX_SESSION_HISTORY_BYTES);
  expect(restored.getMessages().some((message) => message.role === 'tool')).toBe(false);

  const committed = new SessionHistory();
  committed.commit(oversizedHistory());
  expect(messageBytes(committed.getMessages())).toBeLessThanOrEqual(MAX_SESSION_HISTORY_BYTES);
  expect(committed.getMessages().map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'assistant',
    'user',
  ]);
  expect(committed.compact()).toBe(false);
});

test('text-only history that still exceeds the budget keeps the explicit error', () => {
  expect(
    () =>
      new SessionHistory([{ role: 'user', content: 'y'.repeat(MAX_SESSION_HISTORY_BYTES + 1) }]),
  ).toThrow('Session history is full');
});
