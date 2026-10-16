import type { ReviewChatMessage } from '@shared/chat';
import type { ReviewRunState, ReviewSnapshotState, SubmitReviewResult } from '@shared/review';

export const emptyReviews = (): ReviewSnapshotState => ({ runs: [], findings: [] });

export function interruptExpiredReviews(
  reviews?: ReviewSnapshotState,
): ReviewSnapshotState | undefined {
  if (!reviews || !reviews.runs.some((run) => run.status === 'running')) return reviews;
  return {
    ...reviews,
    runs: reviews.runs.map((run) =>
      run.status !== 'running'
        ? run
        : {
            ...run,
            status: 'incomplete',
            summary: `审查已中断，已收录 ${run.issueCount} 条问题。`,
            unfinishedItems: [...run.unfinishedItems, 'Host 会话已结束，无法确认审查完成。'],
          },
    ),
  };
}

export function mergeReviewReceipt(
  previous: ReviewSnapshotState | undefined,
  run: ReviewRunState,
  result?: SubmitReviewResult,
): ReviewSnapshotState {
  const state = previous ?? emptyReviews();
  return {
    runs: [...state.runs.filter(({ id }) => id !== run.id), run],
    findings: result
      ? [...state.findings.filter(({ id }) => id !== result.finding.id), result.finding]
      : state.findings,
  };
}

// Reconstruct only server receipts, never streamed args or model prose. The same
// toolCallId and assistant ID reconcile replay, reload and a lost output chunk.
export function restoreReviewMessages(
  messages: ReviewChatMessage[],
  reviews?: ReviewSnapshotState,
): ReviewChatMessage[] {
  if (!reviews) return messages;
  const restored = [...messages];
  for (const run of reviews.runs) {
    const id = `review-${run.id}`;
    const index = restored.findIndex((message) => message.id === id);
    const receipts: ReviewChatMessage['parts'] = reviews.findings
      .filter((finding) => finding.runId === run.id)
      .map((finding) => ({
        type: 'tool-submit_review',
        toolCallId: finding.toolCallId,
        state: 'output-available',
        input: {
          reviewId: finding.references[0]!.reviewId,
          title: finding.title,
          priority: finding.priority,
          description: finding.description,
          referenceIds: finding.references.map((ref) => ref.referenceId),
        },
        output: { accepted: true, duplicate: false, finding },
      }));
    const remaining = new Map(
      receipts.map((part) => [part.type === 'tool-submit_review' ? part.toolCallId : '', part]),
    );
    const parts: ReviewChatMessage['parts'] = [];
    // Keep the live tool trace and card positions when reconciling a finished
    // stream; a reload with only text summaries rebuilds the same receipts.
    for (const part of restored[index]?.parts ?? []) {
      if (part.type === 'text' || part.type === 'data-review-status') continue;
      if (part.type === 'tool-submit_review') {
        const saved = remaining.get(part.toolCallId);
        if (saved) {
          parts.push(saved);
          remaining.delete(part.toolCallId);
        }
      } else parts.push(part);
    }
    parts.push(...remaining.values(), { type: 'data-review-status', id: run.id, data: run });
    const message: ReviewChatMessage = { id, role: 'assistant', parts };
    if (index === -1) restored.push(message);
    else restored[index] = message;
  }
  return restored;
}
