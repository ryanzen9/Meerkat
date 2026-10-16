import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { createBridgeApi } from '../src/extension/bridge/server/api';
import { finishReviewSchema, submitReviewSchema } from '../src/shared/review';
import { reviewFixture } from './reviewFixture';
import { ReviewJournal } from '../src/extension/bridge/sessions/reviews';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';

type Action = {
  name: string;
  input: (state: { reviewId: string; referenceId: string }) => unknown;
};
const setupActions: Action[] = [
  { name: 'list_changes', input: () => ({ scope: 'all' }) },
  { name: 'get_diff', input: ({ reviewId }) => ({ reviewId, paths: ['file.ts'] }) },
  {
    name: 'cite_files',
    input: ({ reviewId }) => ({
      reviewId,
      references: [{ path: 'file.ts', version: 'new', startLine: 2, endLine: 2 }],
    }),
  },
];
const finding = ({ reviewId, referenceId }: { reviewId: string; referenceId: string }) => ({
  reviewId,
  title: 'Missing validation',
  priority: 'P1',
  description: 'The inserted value reaches the caller without validation.',
  referenceIds: [referenceId],
});
const submit: Action = { name: 'submit_review', input: finding };
const finish: Action = {
  name: 'finish_review',
  input: () => ({ status: 'completed', unfinishedItems: [], limitations: [] }),
};

async function setup(actions: Action[], after?: (signal: AbortSignal) => Promise<Response>) {
  const fixture = await reviewFixture();
  await fixture.write('file.ts', 'one\ninserted\nthree\n');
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register(
    () =>
      new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
        if (String(url).endsWith('/models'))
          return Response.json({
            models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
          });
        const body = JSON.parse(init!.body as string) as {
          input: { type: string; output?: string }[];
        };
        const results = body.input
          .filter((item) => item.type === 'function_call_output')
          .map((item) => JSON.parse(item.output!) as Record<string, unknown>);
        const state = {
          reviewId:
            (results.find((item) => typeof item.reviewId === 'string')?.reviewId as string) ?? '',
          referenceId:
            (
              results.find((item) => Array.isArray(item.references))?.references as
                | { referenceId: string }[]
                | undefined
            )?.[0]?.referenceId ?? '',
        };
        const index = calls++;
        const action = actions[index];
        if (!action) {
          if (after) return after(init!.signal as AbortSignal);
          throw new Error('Model must not be called after accepted finish_review');
        }
        return sse(
          responseEvents('', [
            {
              id: `fc_${index}`,
              type: 'function_call',
              call_id: `call_${index}`,
              name: action.name,
              namespace: 'review',
              arguments: JSON.stringify(action.input(state)),
              status: 'completed',
            },
          ]),
        );
      }),
  );
  const runtime = new BridgeRuntime(registry, {}, () => fixture.context);
  const api = createBridgeApi({ runtime, callbackUri: () => '', openBrowser: async () => {} });
  const provider = registry.list()[0]!;
  const signal = new AbortController().signal;
  const session = runtime.sessions.create(
    provider.id,
    await registry.get(provider.id).createSession('fixture-model', signal),
  );
  return { fixture, runtime, api, session, signal, calls: () => calls };
}

test('incremental submissions validate, deduplicate, retry finish and stop without a summary model call', async () => {
  const actions = [
    setupActions[0]!,
    finish,
    setupActions[1]!,
    setupActions[2]!,
    {
      name: 'submit_review',
      input: (state: Parameters<typeof finding>[0]) => ({
        ...finding(state),
        referenceIds: [`ref_${'a'.repeat(64)}`],
      }),
    },
    submit,
    submit,
    {
      name: 'finish_review',
      input: () => ({ status: 'completed', unfinishedItems: [], limitations: [], findings: [] }),
    },
    finish,
  ];
  const f = await setup(actions);
  try {
    const run = f.runtime.start(f.session.id, 'Review all changes', f.signal, undefined, 'review');
    const output = await createUIMessageStreamResponse({ stream: run.stream }).text();
    expect(f.calls()).toBe(actions.length);
    expect(output).toContain('review_incomplete');
    expect(output).toContain('reference_not_found');
    expect(output).toContain('"duplicate":true');
    expect(output).not.toContain('"type":"text-delta"');
    expect(f.runtime.status(run.runId).status).toBe('completed');
    const saved = f.session.reviews.snapshot();
    expect(saved.findings).toHaveLength(1);
    expect(saved.runs[0]).toMatchObject({
      status: 'completed',
      issueCount: 1,
      summary: '审查已完成，已收录 1 条问题。',
    });
    expect(saved.findings[0]!.references[0]).toMatchObject({
      path: 'file.ts',
      scope: 'range',
      startLine: 2,
      endLine: 2,
    });
    expect(JSON.stringify(f.session.history.getMessages())).toContain('submit_review');
    const response = await f.api(
      new Request(`http://localhost/v1/sessions/${f.session.id}/reviews`),
    );
    expect(await response.json()).toEqual(saved);
    saved.findings[0]!.title = 'mutated';
    expect(f.session.reviews.snapshot().findings[0]!.title).toBe('Missing validation');
  } finally {
    await f.runtime.dispose();
  }
});

for (const outcome of ['cancelled', 'failed'] as const) {
  test(`saved finding is recoverable before finish and after ${outcome}`, async () => {
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const f = await setup([...setupActions, submit], async (signal) => {
      arrived();
      if (outcome === 'failed') return new Response('unavailable', { status: 503 });
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    try {
      const run = f.runtime.start(
        f.session.id,
        'Review all changes',
        f.signal,
        undefined,
        'review',
      );
      const consume = createUIMessageStreamResponse({ stream: run.stream }).text();
      await waiting;
      expect(f.session.reviews.snapshot().findings).toHaveLength(1);
      if (outcome === 'cancelled') f.runtime.cancel(run.runId);
      const output = await consume;
      expect(f.runtime.status(run.runId).status).toBe(outcome);
      expect(f.session.reviews.snapshot().runs[0]).toMatchObject({
        status: outcome,
        issueCount: 1,
      });
      expect(f.session.reviews.snapshot().findings).toHaveLength(1);
      expect(f.session.history.getMessages()).toEqual([]);
      expect(output).toContain('tool-output-available');
      expect(output).not.toContain('审查已完成');
    } finally {
      await f.runtime.dispose();
    }
  });
}

test('ordinary prose cannot complete or become a review report; chat still streams it', async () => {
  const f = await setup([], async () => sse(responseEvents('Claimed complete with 99 issues')));
  try {
    const run = f.runtime.start(f.session.id, 'Review', f.signal, undefined, 'review');
    const chunks: UIMessageChunk[] = [];
    const reader = run.stream.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false);
    expect(f.session.reviews.snapshot().runs[0]).toMatchObject({ status: 'failed', issueCount: 0 });
    expect(f.session.reviews.snapshot().findings).toEqual([]);
    const chat = f.runtime.start(f.session.id, 'Hello', f.signal);
    const output = await createUIMessageStreamResponse({ stream: chat.stream }).text();
    expect(output).toContain('Claimed complete with 99 issues');
    expect(output).not.toContain('data-review-status');
  } finally {
    await f.runtime.dispose();
  }
});

test('submission contracts reject empty findings and finish lists/counts', () => {
  expect(
    submitReviewSchema.safeParse({
      ...finding({ reviewId: crypto.randomUUID(), referenceId: `ref_${'a'.repeat(64)}` }),
      title: ' ',
    }).success,
  ).toBe(false);
  for (const extra of [{ findings: [] }, { issueCount: 100 }])
    expect(
      finishReviewSchema.safeParse({
        status: 'completed',
        unfinishedItems: [],
        limitations: [],
        ...extra,
      }).success,
    ).toBe(false);
});

test('an accepted incomplete finish remains incomplete in both run status and restored review state', async () => {
  const f = await setup([
    setupActions[0]!,
    {
      name: 'finish_review',
      input: () => ({
        status: 'incomplete',
        unfinishedItems: ['Diff inspection remains'],
        limitations: ['Context unavailable'],
      }),
    },
  ]);
  try {
    const run = f.runtime.start(f.session.id, 'Review', f.signal, undefined, 'review');
    const output = await createUIMessageStreamResponse({ stream: run.stream }).text();
    expect(f.calls()).toBe(2);
    expect(f.runtime.status(run.runId).status).toBe('incomplete');
    expect(f.session.reviews.snapshot().runs[0]).toMatchObject({
      status: 'incomplete',
      issueCount: 0,
    });
    expect(output).toContain('审查未完成');
    expect(output).not.toContain('审查已完成');
  } finally {
    await f.runtime.dispose();
  }
});

test('completion checks contiguous diff pages; incomplete finish preserves actual unread work', async () => {
  const f = await reviewFixture({
    'file.ts': Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n'),
  });
  await f.write('file.ts', Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n'));
  const journal = new ReviewJournal();
  const run = journal.start(crypto.randomUUID(), crypto.randomUUID(), 'Review', f.context);
  const snapshot = await run.track('list_changes', () => f.context.listChanges({ scope: 'all' }));
  let diff = await run.track('get_diff', () =>
    f.context.getDiff({ reviewId: snapshot.reviewId, paths: ['file.ts'] }),
  );
  expect(diff.truncated).toBe(true);
  expect(() => run.finish({ status: 'completed', unfinishedItems: [], limitations: [] })).toThrow(
    'Read every diff page',
  );
  while (diff.nextCursor) {
    const cursor = diff.nextCursor;
    diff = await run.track('get_diff', () =>
      f.context.getDiff({ reviewId: snapshot.reviewId, paths: ['file.ts'], cursor }),
    );
  }
  expect(run.finish({ status: 'completed', unfinishedItems: [], limitations: [] }).accepted).toBe(
    true,
  );
  expect(run.settle('completed')).toMatchObject({ status: 'completed', issueCount: 0 });
  const partial = journal.start(crypto.randomUUID(), crypto.randomUUID(), 'Review', f.context);
  await partial.track('list_changes', () => f.context.listChanges({ scope: 'all' }));
  partial.finish({ status: 'incomplete', unfinishedItems: ['Need more time'], limitations: [] });
  expect(partial.settle('completed')).toMatchObject({ status: 'incomplete', issueCount: 0 });
  expect(partial.state.unfinishedItems).toContain('尚未完整读取 diff：file.ts');
});

test('findings require this run snapshot and range citations; concurrent duplicates commit once', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'one\ninserted\nthree\n');
  const other = await f.context.listChanges({ scope: 'all' });
  const oldRefs = await f.context.citeFiles({
    reviewId: other.reviewId,
    references: [{ path: 'file.ts', version: 'new', startLine: 2, endLine: 2 }],
  });
  const journal = new ReviewJournal();
  const run = journal.start(crypto.randomUUID(), crypto.randomUUID(), 'Review', f.context);
  const snapshot = await run.track('list_changes', () => f.context.listChanges({ scope: 'all' }));
  await expect(
    run.submit(
      finding({
        reviewId: snapshot.reviewId,
        referenceId: oldRefs.references[0]!.referenceId,
      }) as Parameters<typeof run.submit>[0],
      'wrong-snapshot',
    ),
  ).rejects.toMatchObject({ code: 'review_reference_invalid' });
  const refs = await f.context.citeFiles({
    reviewId: snapshot.reviewId,
    references: [
      { path: 'file.ts', version: 'new', scope: 'file' },
      { path: 'file.ts', version: 'new', startLine: 2, endLine: 2 },
    ],
  });
  await expect(
    run.submit(
      finding({
        reviewId: snapshot.reviewId,
        referenceId: refs.references[0]!.referenceId,
      }) as Parameters<typeof run.submit>[0],
      'whole-file',
    ),
  ).rejects.toMatchObject({ code: 'review_reference_invalid' });
  const input = submitReviewSchema.parse(
    finding({ reviewId: snapshot.reviewId, referenceId: refs.references[1]!.referenceId }),
  );
  const results = await Promise.all([
    run.submit(input, 'original'),
    run.submit({ ...input, referenceIds: [...input.referenceIds, ...input.referenceIds] }, 'retry'),
  ]);
  expect(results.map((result) => result.duplicate)).toEqual([false, true]);
  expect(journal.snapshot().findings).toHaveLength(1);
  run.settle('cancelled');
  await expect(run.submit(input, 'late')).rejects.toMatchObject({ code: 'review_closed' });
  expect(journal.snapshot().findings).toHaveLength(1);
});
