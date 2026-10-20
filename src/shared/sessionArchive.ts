import { z } from 'zod';

// Durable conversation metadata. JSON-only: this module is shared by the Host
// (file archive) and the Webview (transcript hydration), so it must not import
// Node, Bun, VS Code or React APIs.

export const SESSION_ARCHIVE_VERSION = 1;
export const sessionTurnStatuses = [
  'running',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
] as const;
export type SessionTurnStatus = (typeof sessionTurnStatuses)[number];

export const sessionModeSchema = z.enum(['chat', 'review']);
export type SessionMode = z.infer<typeof sessionModeSchema>;

const sessionIdSchema = z.string().regex(/^[\w-]{1,128}$/);
const runIdSchema = z.string().regex(/^[\w-]{1,128}$/);
const turnErrorSchema = z
  .object({ code: z.string().min(1).max(128), message: z.string().max(2000) })
  .strict();

export interface SessionMeta {
  version: typeof SESSION_ARCHIVE_VERSION;
  id: string;
  providerId: string;
  model: string;
  accountId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastTurnStatus?: SessionTurnStatus | undefined;
}

export const sessionMetaSchema: z.ZodType<SessionMeta> = z
  .object({
    version: z.literal(SESSION_ARCHIVE_VERSION),
    id: sessionIdSchema,
    providerId: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    accountId: z.string().max(128),
    title: z.string().max(120),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastTurnStatus: z.enum(sessionTurnStatuses).optional(),
  })
  .strict();

export interface SessionHistoryCheckpoint {
  runId: string;
  steps: number;
  at: string;
  /** Present when the checkpoint exceeded the Host history budget and was not written. */
  skipped?: boolean | undefined;
}

export interface SessionHistorySnapshot {
  version: typeof SESSION_ARCHIVE_VERSION;
  sessionId: string;
  /** Untrusted JSON shape is validated by the Host before it reaches the agent. */
  messages: unknown[];
  checkpoint: SessionHistoryCheckpoint;
}

export const sessionHistorySnapshotSchema: z.ZodType<SessionHistorySnapshot> = z
  .object({
    version: z.literal(SESSION_ARCHIVE_VERSION),
    sessionId: sessionIdSchema,
    messages: z.array(z.unknown()).max(20000),
    checkpoint: z
      .object({
        runId: runIdSchema,
        steps: z.number().int().min(0).max(10000),
        at: z.string().datetime(),
        skipped: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export interface SessionTurnError {
  code: string;
  message: string;
}

export interface SessionTurn {
  version: typeof SESSION_ARCHIVE_VERSION;
  runId: string;
  sessionId: string;
  text: string;
  mode: SessionMode;
  status: SessionTurnStatus;
  checkpoints: number;
  reviewRunId?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  error?: SessionTurnError | undefined;
  transcriptTruncated?: boolean | undefined;
}

export type SessionTurnSummary = Omit<SessionTurn, 'version' | 'sessionId'>;

const turnFields = {
  runId: runIdSchema,
  text: z.string().max(100000),
  mode: sessionModeSchema,
  status: z.enum(sessionTurnStatuses),
  checkpoints: z.number().int().min(0).max(10000),
  reviewRunId: runIdSchema.optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  error: turnErrorSchema.optional(),
  transcriptTruncated: z.boolean().optional(),
};

export const sessionTurnSchema: z.ZodType<SessionTurn> = z
  .object({
    version: z.literal(SESSION_ARCHIVE_VERSION),
    sessionId: sessionIdSchema,
    ...turnFields,
  })
  .strict();

export const sessionTurnSummarySchema: z.ZodType<SessionTurnSummary> = z
  .object(turnFields)
  .strict();

export interface StoredUIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: unknown[];
}

export const storedUIMessageSchema = z
  .object({
    id: z.string().min(1).max(256),
    role: z.enum(['user', 'assistant', 'system']),
    parts: z.array(z.unknown()).max(2000),
  })
  .passthrough();

export interface SessionTranscript {
  messages: StoredUIMessage[];
  turns: SessionTurnSummary[];
  truncated: boolean;
}

export const sessionTranscriptSchema: z.ZodType<SessionTranscript> = z
  .object({
    messages: z.array(storedUIMessageSchema).max(2000),
    turns: z.array(sessionTurnSummarySchema).max(1000),
    truncated: z.boolean(),
  })
  .strict();

export interface SessionListItem {
  id: string;
  providerId: string;
  model: string;
  accountId: string;
  createdAt: string;
  updatedAt?: string | undefined;
  title?: string | undefined;
  live: boolean;
  archived: boolean;
  lastTurnStatus?: SessionTurnStatus | undefined;
}

export function toTurnSummary(turn: SessionTurn): SessionTurnSummary {
  const { version: _version, sessionId: _sessionId, ...summary } = turn;
  return summary;
}
