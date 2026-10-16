import { z } from 'zod';
import type { FileReference } from '../extension/bridge/tools/reviewWorkspace';

export type InteractionMode = 'chat' | 'review';
export const submitReviewSchema = z
  .object({
    reviewId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    priority: z.enum(['P0', 'P1', 'P2', 'P3']),
    description: z.string().trim().min(1).max(12000),
    referenceIds: z
      .array(z.string().regex(/^ref_[a-f0-9]{64}$/))
      .min(1)
      .max(20),
  })
  .strict();
export const finishReviewSchema = z
  .object({
    status: z.enum(['completed', 'incomplete']),
    unfinishedItems: z.array(z.string().trim().min(1).max(2000)).max(100),
    limitations: z.array(z.string().trim().min(1).max(2000)).max(100),
  })
  .strict();
export type SubmitReviewInput = z.infer<typeof submitReviewSchema>;
export type FinishReviewInput = z.infer<typeof finishReviewSchema>;
export interface ReviewFinding {
  id: string;
  runId: string;
  toolCallId: string;
  title: string;
  priority: SubmitReviewInput['priority'];
  description: string;
  references: FileReference[];
  savedAt: string;
}
export interface SubmitReviewResult {
  accepted: true;
  duplicate: boolean;
  finding: ReviewFinding;
}
export type ReviewStatus = 'running' | 'completed' | 'incomplete' | 'cancelled' | 'failed';
export interface ReviewRunState {
  id: string;
  sessionId: string;
  text: string;
  status: ReviewStatus;
  findingIds: string[];
  issueCount: number;
  unfinishedItems: string[];
  limitations: string[];
  summary: string;
  startedAt: string;
}
export interface ReviewSnapshotState {
  runs: ReviewRunState[];
  findings: ReviewFinding[];
}

const referenceDetails = z.object({
  referenceId: z.string().regex(/^ref_[a-f0-9]{64}$/),
  reviewId: z.string().uuid(),
  repository: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  version: z.enum(['old', 'new']),
  label: z.string().max(8192),
  markdown: z.string().max(16384),
});
export const reviewFindingSchema: z.ZodType<ReviewFinding> = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().uuid(),
  toolCallId: z.string().min(1).max(256),
  title: submitReviewSchema.shape.title,
  priority: submitReviewSchema.shape.priority,
  description: submitReviewSchema.shape.description,
  savedAt: z.string().datetime(),
  references: z
    .array(
      z.union([
        referenceDetails.extend({ scope: z.literal('file') }),
        referenceDetails.extend({
          scope: z.literal('range'),
          startLine: z.number().int().min(1),
          endLine: z.number().int().min(1),
        }),
      ]),
    )
    .min(1)
    .max(20),
});
export const reviewRunStateSchema: z.ZodType<ReviewRunState> = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  text: z.string().max(100000),
  status: z.enum(['running', 'completed', 'incomplete', 'cancelled', 'failed']),
  findingIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000),
  issueCount: z.number().int().min(0).max(1000),
  unfinishedItems: z.array(z.string().max(8192)).max(2000),
  limitations: z.array(z.string().max(8192)).max(2000),
  summary: z.string().max(1000),
  startedAt: z.string().datetime(),
});
export const reviewReceiptSchema = z.object({
  run: reviewRunStateSchema,
  result: z.object({
    accepted: z.literal(true),
    duplicate: z.boolean(),
    finding: reviewFindingSchema,
  }),
});
export const reviewSnapshotSchema: z.ZodType<ReviewSnapshotState> = z.object({
  runs: z.array(reviewRunStateSchema).max(1000),
  findings: z.array(reviewFindingSchema).max(1000),
});
