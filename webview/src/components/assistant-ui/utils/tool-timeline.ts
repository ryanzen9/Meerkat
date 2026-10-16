import {
  FileDiffIcon,
  FileTextIcon,
  FolderGit2Icon,
  LinkIcon,
  ListTreeIcon,
  SearchIcon,
  StethoscopeIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';
import type { TimelineStat, TimelineStep } from '../elements/tool-timeline';

/**
 * The slice of a tool call the timeline summarizes. A message part and the
 * props handed to a tool renderer both satisfy it, so one mapping serves a
 * single call and a whole run of them.
 */
export type ToolCallSummary = {
  id?: string | undefined;
  toolName: string;
  args: unknown;
  argsText?: string | undefined;
  result?: unknown;
  isError?: boolean | undefined;
  status?:
    | {
        readonly type: string;
        readonly reason?: string | undefined;
        readonly error?: unknown;
      }
    | undefined;
};

/**
 * Whether a call renders outside a timeline: it waits on the host for an answer,
 * or its UI is registered by name for the tool. Either owns its own surface, so
 * a timeline leaves the call out instead of swallowing its controls or UI.
 */
export function ownsItsUi(call: {
  status?: { readonly type: string } | undefined;
  approval?: unknown;
  interrupt?: unknown;
  hasRegisteredUi?: boolean | undefined;
}) {
  return (
    call.status?.type === 'requires-action' ||
    call.approval != null ||
    call.interrupt != null ||
    call.hasRegisteredUi === true
  );
}

/** A chip stays a glance long; past this the target is clipped. */
const CHIP_LIMIT = 56;

/** Longest target a path or query keeps before it is clipped. */
const TARGET_LIMIT = 36;

/** At most this many files reach the stat row; the panel is a summary. */
const MAX_STAT_FILES = 6;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const plural = (count: number, noun: string, pluralForm: string = `${noun}s`) =>
  `${count} ${count === 1 ? noun : pluralForm}`;

const clip = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

const join = (...parts: readonly (string | undefined)[]) =>
  clip(
    parts.filter((part): part is string => part !== undefined && part !== '').join(' · '),
    CHIP_LIMIT,
  );

/**
 * Bridge tools deliver their result through the stream, so a value that was
 * serialized on the way in arrives as JSON text. Only the JSON-looking
 * strings are parsed: a plain text result stays text.
 */
const parseResult = (result: unknown): unknown => {
  if (typeof result !== 'string') return result;
  const body = result.trim();
  if (!body.startsWith('{') && !body.startsWith('[')) return result;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return result;
  }
};

/**
 * The failure a call reports. The Bridge answers with `{ error: { message } }`,
 * the AI SDK runtime replaces a thrown tool error with `{ error: "text" }`, and
 * an incomplete part may carry the reason on its status instead.
 */
const toolFailure = (call: ToolCallSummary, result: Record<string, unknown> | undefined) => {
  const failure = result?.['error'];
  const message =
    text(failure) ??
    text(record(failure)?.['message']) ??
    text(call.status?.error) ??
    text(record(call.status?.error)?.['message']);
  if (message !== undefined) {
    return {
      message,
      code: text(record(failure)?.['code']) ?? text(record(call.status?.error)?.['code']),
    };
  }
  if (call.isError !== true) return undefined;
  return {
    message: text(call.result) ?? 'Tool execution failed.',
    code: undefined,
  };
};

const outcomeText = (call: ToolCallSummary) => {
  if (call.status?.type !== 'incomplete') return undefined;
  return call.status.reason === 'cancelled' ? 'cancelled' : 'failed';
};

/** One or many paths as a chip target. */
const pathsText = (paths: readonly string[]) => {
  const first = paths[0];
  if (first === undefined) return undefined;
  return paths.length === 1 ? clip(first, TARGET_LIMIT) : `${paths.length} paths`;
};

/**
 * A tool call as one timeline step. The verb says what the agent did, the chip
 * names the target, and whatever the result settled — a count, a truncation, a
 * failure — rides along so the row still carries the Bridge's answer. A failure
 * replaces the counts: what came back is the message, not how much of it did.
 */
export function toolCallStep(call: ToolCallSummary): TimelineStep {
  const args = record(call.args) ?? {};
  const result = record(parseResult(call.result));
  const step = describe(call, args, result);
  const error = toolFailure(call, result);
  const failure =
    error === undefined ? outcomeText(call) : `failed: ${clip(error.message, TARGET_LIMIT)}`;
  const chip = join(...step.target, ...(failure === undefined ? step.outcome : [failure]));
  const status =
    call.status?.type === 'incomplete' && call.status.reason === 'cancelled'
      ? 'cancelled'
      : failure !== undefined
        ? 'failed'
        : call.status?.type === 'running'
          ? 'running'
          : 'complete';
  const verb = status === 'running' ? (ACTIVE_VERBS[step.verb] ?? step.verb) : step.verb;

  return {
    ...(call.id === undefined ? {} : { id: call.id }),
    verb,
    chip,
    icon: step.icon,
    status,
    ...(status === 'failed'
      ? {
          error:
            error === undefined
              ? 'Tool execution failed.'
              : [error.code, error.message].filter(Boolean).join(': '),
        }
      : {}),
  };
}

const ACTIVE_VERBS: Readonly<Record<string, string>> = {
  Read: 'Reading',
  Listed: 'Listing',
  Cited: 'Citing',
  Searched: 'Searching',
  Checked: 'Checking',
  Ran: 'Running',
};

type StepDescription = {
  verb: string;
  icon: LucideIcon;
  /** What the call acted on, kept even when the call failed. */
  target: readonly (string | undefined)[];
  /** What the result settled on, dropped in favor of a failure. */
  outcome: readonly (string | undefined)[];
};

const describe = (
  call: ToolCallSummary,
  args: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): StepDescription => {
  switch (call.toolName) {
    case 'get_review_context': {
      const repository = record(result?.['repository']);
      const activeFile = record(result?.['activeFile']);
      return {
        verb: 'Read',
        icon: FolderGit2Icon,
        target: ['review context', text(repository?.['branch']), text(activeFile?.['path'])],
        outcome: [],
      };
    }
    case 'list_changes': {
      const changes = list(result?.['changes']).length;
      return {
        verb: 'Listed',
        icon: ListTreeIcon,
        target: [text(args['scope']) ?? 'working-tree'],
        outcome: [Array.isArray(result?.['changes']) ? plural(changes, 'file') : undefined],
      };
    }
    case 'get_diff': {
      const paths = list(args['paths']).filter((path): path is string => text(path) !== undefined);
      return {
        verb: 'Read',
        icon: FileDiffIcon,
        target: [pathsText(paths)],
        outcome: [result?.['truncated'] === true ? 'more pages' : undefined],
      };
    }
    case 'read_file': {
      const start = countOf(args['startLine']);
      const end = countOf(args['endLine']);
      const range = start === undefined || end === undefined ? undefined : `L${start}-${end}`;
      return {
        verb: 'Read',
        icon: FileTextIcon,
        target: [text(args['path']), range, text(args['version'])],
        outcome: [result?.['truncated'] === true ? 'more below' : undefined],
      };
    }
    case 'cite_files': {
      const references = list(result?.['references']).length;
      return {
        verb: 'Cited',
        icon: LinkIcon,
        target: [],
        outcome: [
          Array.isArray(result?.['references']) ? plural(references, 'reference') : undefined,
        ],
      };
    }
    case 'search_code': {
      const query = text(args['query']);
      const matches = list(result?.['matches']).length;
      return {
        verb: 'Searched',
        icon: SearchIcon,
        target: [query === undefined ? undefined : `“${clip(query, TARGET_LIMIT)}”`],
        outcome: [
          Array.isArray(result?.['matches']) ? plural(matches, 'match', 'matches') : undefined,
          result?.['truncated'] === true ? 'truncated' : undefined,
        ],
      };
    }
    case 'get_diagnostics': {
      const paths = list(args['paths']).length;
      const diagnostics = list(result?.['diagnostics']).length;
      return {
        verb: 'Checked',
        icon: StethoscopeIcon,
        target: [plural(paths, 'path')],
        outcome: [
          Array.isArray(result?.['diagnostics']) ? plural(diagnostics, 'diagnostic') : undefined,
          result?.['truncated'] === true ? 'truncated' : undefined,
        ],
      };
    }
    default:
      return {
        verb: 'Ran',
        icon: WrenchIcon,
        target: [call.toolName],
        outcome: [],
      };
  }
};

/** The changed lines a diff page carries, tallied from its hunks. */
const hunkCounts = (file: Record<string, unknown>) => {
  let added = 0;
  let removed = 0;
  for (const hunk of list(file['hunks'])) {
    for (const line of list(record(hunk)?.['lines'])) {
      const type = text(record(line)?.['type']);
      if (type === 'added') added++;
      else if (type === 'removed') removed++;
    }
  }
  return { added, removed };
};

/**
 * Per-file line counts for the diffs a run read, so the timeline can show what
 * the session touched. Files the pages returned without changed lines stay out,
 * and the busiest files come first.
 */
export function toolCallStats(calls: readonly ToolCallSummary[]): TimelineStat[] {
  const files = new Map<string, { added: number; removed: number }>();
  const pages = new Set<string>();

  for (const call of calls) {
    if (call.toolName !== 'get_diff' || toolCallStep(call).status !== 'complete') continue;
    const result = record(parseResult(call.result));
    for (const entry of list(result?.['files'])) {
      const file = record(entry);
      const path = text(file?.['path']) ?? text(file?.['newPath']);
      if (file === undefined || path === undefined) continue;
      // Re-reading the same snapshot page must not multiply its line counts.
      const reviewId = text(result?.['reviewId']);
      const offset = countOf(file['patchOffset']);
      if (reviewId !== undefined && offset !== undefined) {
        const key = JSON.stringify([reviewId, path, offset]);
        if (pages.has(key)) continue;
        pages.add(key);
      }
      const counted = hunkCounts(file);
      if (counted.added === 0 && counted.removed === 0) continue;
      const total = files.get(path) ?? { added: 0, removed: 0 };
      files.set(path, {
        added: total.added + counted.added,
        removed: total.removed + counted.removed,
      });
    }
  }

  return (
    [...files]
      // Only the sides a file has: the element renders every count it is given,
      // so a file that only lost lines reads "−12", not "+0 −12".
      .map(([file, counted]) => ({
        file,
        ...(counted.added > 0 ? { added: counted.added } : {}),
        ...(counted.removed > 0 ? { removed: counted.removed } : {}),
      }))
      // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array with the ES2022 API.
      .sort((a, b) => (b.added ?? 0) + (b.removed ?? 0) - ((a.added ?? 0) + (a.removed ?? 0)))
      .slice(0, MAX_STAT_FILES)
  );
}
