import type { ReviewChatMessage } from '@shared/chat';
import type { ReviewSnapshotState } from '@shared/review';
import {
  sessionTranscriptSchema,
  type SessionTranscript,
  type SessionTurnSummary,
} from '@shared/sessionArchive';
import { restoreReviewMessages } from './reviewReceipts';

export type RecoveryStatus = 'interrupted' | 'cancelled' | 'failed' | 'running';

export interface SessionRecovery {
  status: RecoveryStatus;
  mode: SessionTurnSummary['mode'];
  turn: SessionTurnSummary;
}

export function parseSessionTranscript(value: unknown): SessionTranscript | undefined {
  const parsed = sessionTranscriptSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function transcriptMessages(transcript: SessionTranscript): ReviewChatMessage[] {
  return transcript.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.role as 'user' | 'assistant',
      parts: message.parts as ReviewChatMessage['parts'],
    }));
}

/**
 * Host transcript is authoritative for a durable conversation. Saved review
 * receipts still reconcile the review cards and status parts on top of it.
 */
export function restoreTranscriptMessages(
  transcript: SessionTranscript,
  reviews?: ReviewSnapshotState,
): ReviewChatMessage[] {
  return restoreReviewMessages(transcriptMessages(transcript), reviews);
}

export function sessionRecovery(
  transcript: SessionTranscript | undefined,
): SessionRecovery | undefined {
  const turn = transcript?.turns.at(-1);
  if (!turn || turn.status === 'completed') return undefined;
  return { status: turn.status, mode: turn.mode, turn };
}

/** Manual continuation avoids silently re-running tools or spending quota. */
export function continuationPrompt(recovery: SessionRecovery | undefined): string {
  return recovery?.mode === 'review' ? '继续审查剩下的文件' : '继续';
}
