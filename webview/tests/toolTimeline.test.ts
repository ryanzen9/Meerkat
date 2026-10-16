import { expect, test } from 'bun:test';
import {
  ownsItsUi,
  toolCallStats,
  toolCallStep,
  type ToolCallSummary,
} from '../src/components/assistant-ui/utils/tool-timeline';

const call = (over: Partial<ToolCallSummary> & { toolName: string }): ToolCallSummary => ({
  args: {},
  ...over,
});

test('a counted tool result folds into the step chip', () => {
  const step = toolCallStep(
    call({
      id: 'search-call',
      toolName: 'search_code',
      args: { query: 'TODO' },
      // Results serialized in a stream still carry the search summary.
      result: JSON.stringify({
        matches: [{ path: 'file.ts', line: 1, text: '// TODO: inspect this change' }],
        truncated: false,
      }),
    }),
  );

  expect(step.id).toBe('search-call');
  expect(step.verb).toBe('Searched');
  expect(step.chip).toBe('“TODO” · 1 match');
});

test('read_file names the path, range and side it read', () => {
  const step = toolCallStep(
    call({
      toolName: 'read_file',
      args: { reviewId: 'x', path: 'src/agent.ts', version: 'new', startLine: 10, endLine: 40 },
      result: { lines: [] },
    }),
  );

  expect(step.verb).toBe('Read');
  expect(step.chip).toBe('src/agent.ts · L10-40 · new');
});

test('search_code carries the query, the match count and a truncation', () => {
  const step = toolCallStep(
    call({
      toolName: 'search_code',
      args: { query: 'useChatRuntime' },
      result: { matches: [{}, {}, {}], truncated: true },
    }),
  );

  expect(step.chip).toBe('“useChatRuntime” · 3 matches · truncated');
});

test('a tool error reported as a result reads as a failure, not a count', () => {
  const step = toolCallStep(
    call({
      toolName: 'list_changes',
      args: { scope: 'staged' },
      result: { error: { code: 'review_unavailable', message: 'Review workspace is unavailable' } },
    }),
  );

  expect(step.chip).toBe('staged · failed: Review workspace is unavailable');
});

test('the runtime shapes of a tool failure all read as a failure', () => {
  // The AI SDK runtime replaces a thrown tool error with a text payload.
  const thrown = toolCallStep(
    call({
      toolName: 'read_file',
      args: { path: 'src/a.ts' },
      result: { error: 'Tool execution failed' },
    }),
  );
  expect(thrown.chip).toBe('src/a.ts · failed: Tool execution failed');

  // An incomplete part can carry the reason on its status instead.
  const incomplete = toolCallStep(
    call({
      toolName: 'search_code',
      args: { query: 'timeline' },
      status: { type: 'incomplete', reason: 'error', error: { message: 'Search index missing' } },
    }),
  );
  expect(incomplete.chip).toBe('“timeline” · failed: Search index missing');
});

test('a long failure is clipped to the chip limit', () => {
  const step = toolCallStep(
    call({
      toolName: 'read_file',
      args: { path: 'src/agent.ts', version: 'new', startLine: 1, endLine: 20 },
      result: {
        error: { code: 'read_failed', message: 'The snapshot expired before this page was read' },
      },
    }),
  );

  expect(step.chip).toBe('src/agent.ts · L1-20 · new · failed: The snapshot expir…');
  expect(step.chip.length).toBe(56);
  expect(step.error).toBe('read_failed: The snapshot expired before this page was read');
});

test('a failed route-file read preserves the complete error outside the clipped chip', () => {
  const step = toolCallStep(
    call({
      toolName: 'read_file',
      args: { path: 'app/[locale]/projects/page.tsx', startLine: 1, endLine: 100, version: 'new' },
      result: JSON.stringify({
        error: {
          code: 'file_not_found',
          message: 'File does not exist in the requested snapshot version.',
        },
      }),
    }),
  );
  expect(step.chip).toBe('app/[locale]/projects/page.tsx · L1-100 · new · failed:…');
  expect(step.error).toBe('file_not_found: File does not exist in the requested snapshot version.');
});

test('a cancelled call is marked on the step', () => {
  const step = toolCallStep(
    call({
      toolName: 'get_diff',
      args: { paths: ['a.ts'] },
      status: { type: 'incomplete', reason: 'cancelled' },
    }),
  );

  expect(step.chip).toBe('a.ts · cancelled');
});

test('an unknown tool still names itself', () => {
  const step = toolCallStep(call({ toolName: 'list_changes', args: { scope: 'all' } }));

  expect(step.verb).toBe('Listed');

  const unknown = toolCallStep(call({ toolName: 'mcp__docs__search' }));
  expect(unknown.verb).toBe('Ran');
  expect(unknown.chip).toBe('mcp__docs__search');
});

test('streaming calls show their activity without inventing an empty result', () => {
  for (const toolName of ['list_changes', 'search_code', 'get_diagnostics', 'cite_files']) {
    const step = toolCallStep(call({ toolName, status: { type: 'running' } }));
    expect(step.status).toBe('running');
    expect(step.chip).not.toMatch(/\b0 (files|matches|diagnostics|references)\b/);
  }
  expect(toolCallStep(call({ toolName: 'search_code', status: { type: 'running' } })).verb).toBe(
    'Searching',
  );
  expect(toolCallStep(call({ toolName: 'search_code', result: { matches: [] } })).chip).toBe(
    '0 matches',
  );
});

test('a long target cannot hide a failed or cancelled step status', () => {
  const args = { path: 'src/components/assistant-ui/elements/tool-timeline.aui.tsx' };
  expect(
    toolCallStep(call({ toolName: 'read_file', args, isError: true, result: 'Read failed' }))
      .status,
  ).toBe('failed');
  expect(
    toolCallStep(
      call({ toolName: 'read_file', args, status: { type: 'incomplete', reason: 'cancelled' } }),
    ).status,
  ).toBe('cancelled');
});

const diffPage = (files: unknown[]) => ({
  reviewId: 'r',
  files,
  truncated: false,
  nextCursor: null,
});
const diffFile = (path: string, added: number, removed: number) => ({
  path,
  hunks: [
    {
      header: '@@',
      lines: [
        ...Array.from({ length: added }, () => ({ type: 'added', text: '+' })),
        ...Array.from({ length: removed }, () => ({ type: 'removed', text: '-' })),
      ],
    },
  ],
});

test('diff pages tally into one stat per file, busiest first', () => {
  const stats = toolCallStats([
    call({
      toolName: 'get_diff',
      args: { paths: ['src/a.ts'] },
      result: diffPage([diffFile('src/a.ts', 2, 1)]),
    }),
    // A follow-up page for the same file counts into the same stat.
    call({
      toolName: 'get_diff',
      args: { paths: ['src/a.ts'] },
      result: diffPage([diffFile('src/a.ts', 1, 0), diffFile('src/b.ts', 9, 0)]),
    }),
    // Not a diff: it contributes no lines.
    call({ toolName: 'list_changes', args: { scope: 'all' }, result: { changes: [] } }),
  ]);

  expect(stats).toEqual([
    // A file with only added lines keeps only the side it has.
    { file: 'src/b.ts', added: 9 },
    { file: 'src/a.ts', added: 3, removed: 1 },
  ]);
});

test('a file that only lost lines carries a removal, not a zero addition', () => {
  expect(
    toolCallStats([
      call({
        toolName: 'get_diff',
        args: { paths: ['src/legacy.ts'] },
        result: diffPage([diffFile('src/legacy.ts', 0, 12)]),
      }),
    ]),
  ).toEqual([{ file: 'src/legacy.ts', removed: 12 }]);
});

const page = (offset: number) =>
  call({
    toolName: 'get_diff',
    result: diffPage([{ ...diffFile('src/a.ts', 2, 1), patchOffset: offset }]),
  });

test('repeated diff pages count once while distinct pages still accumulate', () => {
  expect(toolCallStats([page(0), page(0), page(100)])).toEqual([
    { file: 'src/a.ts', added: 4, removed: 2 },
  ]);
});

test('a call that owns its UI is kept out of the timeline', () => {
  expect(ownsItsUi({})).toBe(false);
  expect(ownsItsUi({ approval: null, interrupt: null })).toBe(false);
  expect(ownsItsUi({ status: { type: 'running' } })).toBe(false);
  expect(ownsItsUi({ status: { type: 'complete' } })).toBe(false);
  // Waiting on the host: an approval gate, an interrupt, or a parked call.
  expect(ownsItsUi({ status: { type: 'requires-action' } })).toBe(true);
  expect(ownsItsUi({ status: { type: 'complete' }, approval: { id: 'gate' } })).toBe(true);
  expect(ownsItsUi({ status: { type: 'complete' }, interrupt: { type: 'human' } })).toBe(true);
  // A UI registered by name for the tool renders itself, whatever its status.
  expect(ownsItsUi({ status: { type: 'complete' }, hasRegisteredUi: true })).toBe(true);
});

test('a diff page with no changed lines contributes no stat', () => {
  expect(
    toolCallStats([
      call({
        toolName: 'get_diff',
        args: { paths: ['bin/logo.png'] },
        result: diffPage([{ path: 'bin/logo.png', hunks: [] }]),
      }),
    ]),
  ).toEqual([]);
});
