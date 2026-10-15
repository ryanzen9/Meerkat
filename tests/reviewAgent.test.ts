import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse } from 'ai';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import { validatePlanRequest } from '../src/extension/bridge/providers/openai/compatibility';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';
import { reviewFixture } from './reviewFixture';

test('all six registered workspace tools round-trip through the real SDK, provider, runtime and session history', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'one\ninserted\ntwo\nthree\n');
  const names = [
    'get_review_context',
    'list_changes',
    'get_diff',
    'read_file',
    'search_code',
    'get_diagnostics',
  ];
  let calls = 0;
  let reviewId = '';
  let followup = false;
  const registry = new ProviderRegistry();
  registry.register(
    () =>
      new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
        if (String(url).endsWith('/models'))
          return Response.json({
            models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
          });
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        validatePlanRequest(body);
        for (const name of names) expect(JSON.stringify(body.tools)).toContain(`"name":"${name}"`);
        const input = body.input as Record<string, unknown>[];
        if (calls === 2) {
          const result = input.filter((item) => item.type === 'function_call_output').at(-1)!;
          reviewId = (JSON.parse(result.output as string) as { reviewId: string }).reviewId;
          expect(reviewId).toBeString();
        }
        const args = [
          {},
          { scope: 'all' },
          { reviewId, paths: ['file.ts'] },
          { reviewId, path: 'file.ts', version: 'new', startLine: 1, endLine: 20 },
          { query: 'inserted', glob: '**/*.ts', limit: 10 },
          { paths: ['file.ts'] },
        ];
        const index = calls++;
        if (index >= names.length && !followup) return sse(responseEvents('Review complete'));
        const name = followup ? 'read_file' : names[index]!;
        const toolArguments = followup ? args[3] : args[index];
        followup = false;
        return sse(
          responseEvents('', [
            {
              id: `fc_${calls}`,
              type: 'function_call',
              call_id: `call_${calls}`,
              name,
              namespace: 'review',
              arguments: JSON.stringify(toolArguments),
              status: 'completed',
            },
          ]),
        );
      }),
  );
  const contexts: ReviewContext[] = [];
  const runtime = new BridgeRuntime(registry, 120000, () => {
    const context = new ReviewContext(f.workspace);
    contexts.push(context);
    return context;
  });
  try {
    await registry.initialize();
    const provider = registry.list()[0]!;
    const signal = new AbortController().signal;
    const session = runtime.sessions.create(
      provider.id,
      await registry.get(provider.id).createSession('fixture-model', signal),
    );
    const run = runtime.start(session.id, 'Review all local changes', signal);
    const output = await createUIMessageStreamResponse({ stream: run.stream }).text();
    expect(runtime.status(run.runId).status).toBe('completed');
    expect(calls).toBe(7);
    expect(output.match(/"type":"tool-output-available"/g)).toHaveLength(6);
    expect(output).toContain('Review complete');
    expect(output).toContain('inserted');
    const history = JSON.stringify(session.history.getMessages());
    for (const name of names) expect(history).toContain(name);
    expect(history).not.toContain('review_unavailable');
    expect(history).not.toContain('internal_error');
    await f.write('file.ts', 'changed after snapshot\n');
    followup = true;
    const second = runtime.start(session.id, 'Read the same snapshot again', signal);
    const secondOutput = await createUIMessageStreamResponse({ stream: second.stream }).text();
    expect(secondOutput).toContain('inserted');
    expect(secondOutput).not.toContain('changed after snapshot');
    expect(contexts).toHaveLength(1);
    await runtime.deleteSession(session.id);
    await expect(
      contexts[0]!.readFile({
        reviewId,
        path: 'file.ts',
        version: 'new',
        startLine: 1,
        endLine: 1,
      }),
    ).rejects.toMatchObject({ code: 'review_not_found' });
  } finally {
    await runtime.dispose();
  }
});
