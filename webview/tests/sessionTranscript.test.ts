import { expect, test } from 'bun:test';
import type { ReviewSnapshotState } from '@shared/review';
import type { SessionTranscript } from '@shared/sessionArchive';
import {
  continuationPrompt,
  parseSessionTranscript,
  restoreTranscriptMessages,
  sessionRecovery,
  transcriptMessages,
} from '../src/state/sessionTranscript';

const sessionId = '00000000-0000-4000-8000-000000000001';
const reviewRunId = '00000000-0000-4000-8000-0000000000aa';

function transcript(overrides: Partial<SessionTranscript> = {}): SessionTranscript {
  return {
    messages: [
      { id: 'user-run-1', role: 'user', parts: [{ type: 'text', text: 'Explain' }] },
      {
        id: 'assistant-run-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Partial answer' },
          {
            type: 'tool-read_file',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { path: 'a.ts' },
            output: { content: 'export const a = 1;' },
          },
        ],
      },
    ],
    turns: [
      {
        runId: 'run-1',
        text: 'Explain',
        mode: 'chat',
        status: 'interrupted',
        checkpoints: 2,
        startedAt: '2026-10-20T00:00:00.000Z',
        endedAt: '2026-10-20T00:00:01.000Z',
        error: { code: 'host_restart', message: 'Host 会话已结束，上一轮回答被中断。' },
      },
    ],
    truncated: true,
    ...overrides,
  };
}

const reviewSnapshot = (): ReviewSnapshotState => ({
  runs: [
    {
      id: reviewRunId,
      sessionId,
      text: 'Review changes',
      status: 'completed',
      findingIds: ['a'.repeat(64)],
      issueCount: 1,
      unfinishedItems: [],
      limitations: [],
      summary: '审查已完成，已收录 1 条问题。',
      startedAt: '2026-10-20T00:00:00.000Z',
    },
  ],
  findings: [
    {
      id: 'a'.repeat(64),
      runId: reviewRunId,
      toolCallId: 'call-submit',
      title: 'Missing check',
      priority: 'P1',
      description: 'Validate the value.',
      references: [
        {
          referenceId: `ref_${'b'.repeat(64)}`,
          reviewId: '00000000-0000-4000-8000-0000000000bb',
          repository: '/repo',
          path: 'a.ts',
          version: 'new',
          scope: 'range',
          startLine: 1,
          endLine: 1,
          label: 'a.ts:1',
          markdown: `[a.ts:1](review-file:ref_${'b'.repeat(64)})`,
        },
      ],
      savedAt: '2026-10-20T00:00:00.000Z',
      status: 'resolved',
      statusRevision: 1,
    },
  ],
});

test('transcripts are validated before touching runtime state', () => {
  expect(parseSessionTranscript(transcript())).toMatchObject({ truncated: true });
  expect(parseSessionTranscript(undefined)).toBeUndefined();
  expect(parseSessionTranscript({ messages: [], turns: [] })).toBeUndefined();
  expect(parseSessionTranscript({ ...transcript(), truncated: 'no' })).toBeUndefined();
  expect(
    parseSessionTranscript({
      ...transcript(),
      messages: [{ id: '', role: 'assistant', parts: [] }],
    }),
  ).toBeUndefined();
});

test('host transcript messages keep tool parts and reconcile review receipts', () => {
  expect(transcriptMessages(transcript()).map((message) => message.id)).toEqual([
    'user-run-1',
    'assistant-run-1',
  ]);
  const restored = restoreTranscriptMessages(
    transcript({
      messages: [
        {
          id: `review-${reviewRunId}`,
          role: 'assistant',
          parts: [{ type: 'text', text: '' }],
        },
      ],
      turns: [
        {
          runId: reviewRunId,
          text: 'Review changes',
          mode: 'review',
          status: 'completed',
          checkpoints: 1,
          startedAt: '2026-10-20T00:00:00.000Z',
        },
      ],
    }),
    reviewSnapshot(),
  );
  const parts = restored[0]!.parts;
  expect(parts.some((part) => part.type === 'tool-submit_review')).toBe(true);
  expect(parts.some((part) => part.type === 'data-review-status')).toBe(true);
  const receipt = parts.find((part) => part.type === 'tool-submit_review');
  expect(receipt).toMatchObject({
    toolCallId: 'call-submit',
    output: { accepted: true, finding: { status: 'resolved' } },
  });
});

test('only incomplete last turns produce a recovery notice and continuation prompt', () => {
  const interrupted = sessionRecovery(transcript());
  expect(interrupted).toMatchObject({
    status: 'interrupted',
    mode: 'chat',
    turn: { checkpoints: 2 },
  });
  expect(continuationPrompt(interrupted)).toBe('继续');
  expect(
    sessionRecovery(
      transcript({
        turns: [
          {
            runId: 'run-2',
            text: 'Review',
            mode: 'review',
            status: 'cancelled',
            checkpoints: 0,
            startedAt: '2026-10-20T00:00:00.000Z',
          },
        ],
      }),
    ),
  ).toMatchObject({ status: 'cancelled', mode: 'review' });
  expect(
    continuationPrompt(
      sessionRecovery(transcript({ turns: [{ ...transcript().turns[0]!, mode: 'review' }] })),
    ),
  ).toBe('继续审查剩下的文件');
  expect(
    sessionRecovery(transcript({ turns: [{ ...transcript().turns[0]!, status: 'completed' }] })),
  ).toBeUndefined();
  expect(continuationPrompt(undefined)).toBe('继续');
  expect(sessionRecovery(transcript({ turns: [] }))).toBeUndefined();
  expect(continuationPrompt(sessionRecovery(undefined))).toBe('继续');
});
