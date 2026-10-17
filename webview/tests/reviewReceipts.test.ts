import { expect, test } from 'bun:test';
import type {
  ReviewFinding,
  ReviewSnapshotState,
  SubmitReviewResult,
} from '../../src/shared/review';
import type { ReviewChatMessage } from '../../src/shared/chat';
import {
  interruptExpiredReviews,
  mergeReviewReceipt,
  restoreReviewMessages,
} from '../src/state/reviewReceipts';
import { createSession, restoreReviewState, sessionMarkdown } from '../src/state/reviewState';

function receipts(): ReviewSnapshotState {
  const runId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const first: ReviewFinding = {
    id: 'a'.repeat(64),
    runId,
    toolCallId: 'original',
    title: 'Missing check',
    priority: 'P1',
    description: 'A verified failure.',
    savedAt: new Date().toISOString(),
    references: [
      {
        referenceId: `ref_${'b'.repeat(64)}`,
        reviewId: crypto.randomUUID(),
        repository: '/repo',
        path: 'file.ts',
        version: 'new',
        scope: 'range',
        startLine: 1,
        endLine: 2,
        label: 'file.ts:1–2',
        markdown: `[file.ts:1–2](review-file:ref_${'b'.repeat(64)})`,
      },
    ],
  };
  return {
    runs: [
      {
        id: runId,
        sessionId,
        text: 'Review',
        status: 'running',
        findingIds: [first.id],
        issueCount: 1,
        unfinishedItems: [],
        limitations: [],
        summary: '正在审查，已收录 1 条问题。',
        startedAt: new Date().toISOString(),
      },
    ],
    findings: [first],
  };
}

test('replayed receipts keep one card and recovery preserves the original live tool trace', () => {
  const saved = receipts();
  const result: SubmitReviewResult = {
    accepted: true,
    duplicate: false,
    finding: saved.findings[0]!,
  };
  const twice = mergeReviewReceipt(
    mergeReviewReceipt(saved, saved.runs[0]!, result),
    saved.runs[0]!,
    { ...result, duplicate: true },
  );
  expect(twice.findings).toHaveLength(1);
  const live: ReviewChatMessage[] = [
    {
      id: `review-${saved.runs[0]!.id}`,
      role: 'assistant',
      parts: [
        { type: 'text', text: 'An unsubmitted opinion must not appear' },
        {
          type: 'tool-search_code',
          toolCallId: 'search',
          state: 'input-available',
          input: { query: 'lookup' },
        },
      ],
    },
  ];
  const recovered = restoreReviewMessages(restoreReviewMessages(live, twice), twice);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.parts.filter((part) => part.type === 'tool-submit_review')).toHaveLength(1);
  expect(recovered[0]!.parts.some((part) => part.type === 'tool-search_code')).toBe(true);
  expect(recovered[0]!.parts.some((part) => part.type === 'text')).toBe(false);
  const second = {
    ...saved.findings[0]!,
    id: 'c'.repeat(64),
    toolCallId: 'second',
    title: 'Another failure',
  };
  const more = { ...twice, findings: [...twice.findings, second] };
  expect(
    restoreReviewMessages(recovered, more)[0]!.parts.filter(
      (part) => part.type === 'tool-submit_review',
    ),
  ).toHaveLength(2);
});

test('expired Host keeps cached findings, marks running work incomplete and exports receipts', () => {
  const saved = receipts();
  const interrupted = interruptExpiredReviews(saved)!;
  expect(interrupted.findings).toEqual(saved.findings);
  expect(interrupted.runs[0]).toMatchObject({ status: 'incomplete', issueCount: 1 });
  const session = {
    ...createSession(),
    mode: 'review' as const,
    reviews: interrupted,
    messages: [
      {
        id: `review-${saved.runs[0]!.id}`,
        role: 'assistant' as const,
        reviewRunId: saved.runs[0]!.id,
        text: 'unsubmitted prose',
        createdAt: new Date().toISOString(),
      },
    ],
  };
  const restored = restoreReviewState({ sessions: [session] }).sessions[0]!;
  expect(restored.reviews).toEqual(interrupted);
  const markdown = sessionMarkdown(restored);
  expect(markdown).toContain('[P1] Missing check');
  expect(markdown).toContain('A verified failure.');
  expect(markdown).toContain('审查已中断，已收录 1 条问题。');
  expect(markdown).not.toContain('Host 会话已结束');
  expect(markdown).not.toContain('unsubmitted prose');
  const malformed = restoreReviewState({
    sessions: [{ ...session, reviews: { findings: [null] } }],
  }).sessions[0]!;
  expect(malformed.reviews).toBeUndefined();
  expect(malformed.messages).toHaveLength(1);
});

test('exported reviews include saved issues and actual status without closing notes', () => {
  const saved = receipts();
  const run = saved.runs[0]!;
  run.status = 'incomplete';
  run.summary = '审查未完成，已收录 1 条问题。';
  run.unfinishedItems = ['Remaining review work'];
  run.limitations = ['Static review only'];
  const markdown = sessionMarkdown({
    ...createSession(),
    reviews: saved,
    messages: [
      {
        id: `review-${run.id}`,
        role: 'assistant',
        reviewRunId: run.id,
        text: 'unsubmitted prose',
        createdAt: run.startedAt,
      },
    ],
  });
  expect(markdown).toContain('[P1] Missing check');
  expect(markdown).toContain(run.summary);
  expect(markdown).not.toContain('Remaining review work');
  expect(markdown).not.toContain('Static review only');
  expect(markdown).not.toContain('unsubmitted prose');
});
