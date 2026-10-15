import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse } from 'ai';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import { validatePlanRequest } from '../src/extension/bridge/providers/openai/compatibility';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';
import { reviewFixture } from './reviewFixture';
import type { FileReference } from '../src/extension/bridge/tools/reviewWorkspace';

test('all seven registered workspace tools round-trip through the real SDK, provider, runtime and session history', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'one\ninserted\ntwo\nthree\n');
  const names = [
    'get_review_context',
    'list_changes',
    'get_diff',
    'read_file',
    'search_code',
    'get_diagnostics',
    'cite_files',
  ];
  let calls = 0;
  let reviewId = '';
  let followup = false;
  let citation: { referenceId: string; markdown: string } | undefined;
  let fileCitation: { referenceId: string; markdown: string } | undefined;
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
        const instructions = JSON.stringify(input.filter((item) => item.role === 'developer'));
        expect(instructions).toContain('call cite_files');
        expect(instructions).toContain('Use each returned markdown verbatim');
        expect(instructions).toContain('Use scope: file');
        expect(instructions).toContain('Use scope: range');
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
          {
            reviewId,
            references: [
              { path: 'file.ts', version: 'new', startLine: 2, endLine: 3 },
              { path: 'file.ts', version: 'new', scope: 'file' },
              { path: 'file.ts', version: 'new', scope: 'range', startLine: 2, endLine: 3 },
            ],
          },
        ];
        const index = calls++;
        if (index >= names.length && !followup) {
          if (!citation) {
            const result = input.filter((item) => item.type === 'function_call_output').at(-1)!;
            const references = (
              JSON.parse(result.output as string) as { references: FileReference[] }
            ).references;
            citation = references[0]!;
            fileCitation = references[1]!;
            expect(citation).toMatchObject({ scope: 'range', startLine: 2, endLine: 3 });
            expect(fileCitation).toMatchObject({ scope: 'file', label: 'file.ts' });
            expect(references[2]!.referenceId).toBe(citation.referenceId);
          }
          return sse(
            responseEvents(`Review complete: ${fileCitation!.markdown} ${citation.markdown}`),
          );
        }
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
    expect(calls).toBe(8);
    expect(output.match(/"type":"tool-output-available"/g)).toHaveLength(7);
    expect(output).toContain('Review complete');
    expect(output).toContain('inserted');
    expect(output).toContain(citation!.markdown);
    expect(output).toContain(fileCitation!.markdown);
    expect(
      (await runtime.readFileReference(session.id, fileCitation!.referenceId)).reference,
    ).toMatchObject({ scope: 'file', path: 'file.ts' });
    expect(await contexts[0]!.getFileReference(citation!.referenceId)).toMatchObject({
      reviewId,
      path: 'file.ts',
      version: 'new',
      startLine: 2,
      endLine: 3,
    });
    expect((await runtime.readFileReference(session.id, citation!.referenceId)).content).toBe(
      'one\ninserted\ntwo\nthree\n',
    );
    const otherSession = runtime.sessions.create(provider.id, session.provider);
    await expect(
      runtime.readFileReference(otherSession.id, citation!.referenceId),
    ).rejects.toMatchObject({ code: 'reference_not_found' });
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
      runtime.readFileReference(session.id, citation!.referenceId),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(contexts[0]!.getFileReference(citation!.referenceId)).rejects.toMatchObject({
      code: 'reference_not_found',
    });
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
