import { tool } from 'ai';
import { z } from 'zod';
import { BridgeError, publicError } from '../errors';
import type { ReviewToolContext } from './reviewWorkspace';

const path = z.string().min(1).max(4096);
const paths = z.array(path).min(1).max(100);
const reviewId = z.string().uuid();

export function reviewTools(context?: ReviewToolContext) {
  async function execute<T>(
    signal: AbortSignal | undefined,
    action: (service: ReviewToolContext) => Promise<T>,
  ) {
    signal?.throwIfAborted();
    try {
      if (!context)
        throw new BridgeError(
          'review_unavailable',
          'Review workspace is unavailable in this host.',
        );
      const result = await action(context);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const safe = publicError(error);
      return { error: { code: safe.code, message: safe.message } };
    }
  }
  return {
    get_review_context: tool({
      description:
        'Get the current repository, branch, HEAD, active file, selection, unsaved files and project configuration entry points. Call first to identify the review project. Coordinates are 1-based.',
      inputSchema: z.object({}),
      execute: (_input, { abortSignal }) =>
        execute(abortSignal, (service) => service.getReviewContext(abortSignal)),
    }),
    list_changes: tool({
      description:
        'Create an immutable review snapshot and list changed paths/status/rename paths. staged compares HEAD to index; working-tree compares index to disk plus unsaved buffers and untracked files; all compares HEAD to those local contents; branch compares the merge base of baseRef and HEAD to HEAD. Snapshots expire after 15 minutes; only the latest four per session are retained.',
      inputSchema: z.object({
        scope: z.enum(['staged', 'working-tree', 'all', 'branch']),
        baseRef: z.string().min(1).max(256).optional(),
      }),
      execute: (input, { abortSignal }) =>
        execute(abortSignal, (service) => service.listChanges(input, abortSignal)),
    }),
    get_diff: tool({
      description:
        'Read a real Git unified patch and structured hunks with old/new line numbers from a review snapshot. Follow nextCursor using the same reviewId and paths until truncated is false. Pages may contain part of a patch; concatenate patch fragments in order.',
      inputSchema: z.object({ reviewId, paths, cursor: z.string().max(4096).optional() }),
      execute: (input, { abortSignal }) =>
        execute(abortSignal, (service) => service.getDiff(input, abortSignal)),
    }),
    read_file: tool({
      description:
        'Read numbered lines from the old or new side of a review snapshot, including unchanged files. Use the appropriate original/renamed path. For staged reviews, new is the Git index: untracked files and new files that have not been staged are unavailable, even if search_code finds them. On file_not_found, verify the exact path and version from list_changes/get_diff; preserve the requested review scope. Ranges are 1-based, inclusive, up to 500 lines. Follow nextStartLine for further context; contentTruncated flags an overlong line.',
      inputSchema: z.object({
        reviewId,
        path,
        version: z.enum(['old', 'new']),
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
      }),
      execute: (input, { abortSignal }) =>
        execute(abortSignal, (service) => service.readFile(input, abortSignal)),
    }),
    cite_files: tool({
      description:
        'Create validated file or code-region references before pointing to repository files or answering with concrete code findings. Use a reviewId from list_changes and verified paths and old/new versions. Batch 1 to 20 references, mixing both scopes if needed. Use scope: file with no line fields to reference a whole text file, including empty files or files over 500 lines; clicking opens the file without selecting all its text. Use scope: range with startLine and endLine verified with read_file or get_diff for exact code evidence; range scope may be omitted for existing callers. Ranges are 1-based, inclusive, at most 500 lines, and must exist in full. Returns referenceId, explicit scope, location and ready-to-use markdown. Copy the returned markdown verbatim into the answer; never invent IDs or links. This tool only registers references and does not open an editor.',
      inputSchema: z.object({
        reviewId,
        references: z
          .array(
            z.union([
              z
                .object({ path, version: z.enum(['old', 'new']), scope: z.literal('file') })
                .strict(),
              z.object({
                path,
                version: z.enum(['old', 'new']),
                scope: z.literal('range').optional(),
                startLine: z.number().int().min(1),
                endLine: z.number().int().min(1),
              }),
            ]),
          )
          .min(1)
          .max(20),
      }),
      execute: (input, { abortSignal }) =>
        execute(abortSignal, (service) => service.citeFiles(input, abortSignal)),
    }),
    search_code: tool({
      description:
        'Search current repository files for a case-sensitive literal query, optionally filtered by a VS Code glob. Returns 1-based locations and surrounding lines, including unsaved overlays. This is a live search, not a snapshot search: matches can include untracked or unstaged files absent from a staged snapshot. Confirm snapshot availability before using a match as review evidence. Binary, large and inaccessible files are skipped; scans at most 2,000 files.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .max(500)
          .refine((query) => !/[\r\n]/.test(query), 'Use a single-line literal query.'),
        glob: z.string().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: (input, { abortSignal }) =>
        execute(abortSignal, (service) => service.searchCode(input, abortSignal)),
    }),
    get_diagnostics: tool({
      description:
        'Get current VS Code diagnostics for repository-relative paths, including source, severity, code and 1-based locations. Diagnostic range ends are exclusive. Results are live and may lag editor changes; they are supporting evidence rather than a completed build.',
      inputSchema: z.object({ paths }),
      execute: (input, { abortSignal }) =>
        execute(abortSignal, (service) => service.getDiagnostics(input, abortSignal)),
    }),
  };
}
