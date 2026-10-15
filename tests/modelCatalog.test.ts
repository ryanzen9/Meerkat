import { agentHarness } from './bridgeFixture';
import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse } from 'ai';
import { parseModelCatalog } from '../src/extension/bridge/providers/openai/models';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';

const planCatalog = {
  models: [
    { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
    {
      slug: 'fixture-model',
      display_name: 'Fixture',
      visibility: 'list',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' },
        { effort: 'high', description: 'Thorough' },
      ],
      default_reasoning_level: 'low',
    },
    { slug: 'plain-model', display_name: 'Plain', visibility: 'list' },
  ],
};

test('ChatGPT OAuth catalog preserves visibility and order and normalizes reasoning metadata', () => {
  expect(parseModelCatalog(planCatalog)).toEqual([
    {
      id: 'fixture-model',
      name: 'Fixture',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'high', description: 'Thorough' },
      ],
      defaultReasoningEffort: 'low',
    },
    { id: 'plain-model', name: 'Plain', supportedReasoningEfforts: [] },
  ]);
});

test('public data/id catalogs and camel-case capabilities normalize without inventing effort options', () => {
  expect(
    parseModelCatalog({
      object: 'list',
      data: [
        { id: 'api-model', object: 'model', created: 1, owned_by: 'openai' },
        {
          id: 'reasoning-model',
          displayName: 'Reasoning',
          defaultReasoningEffort: 'high',
          supportedReasoningEfforts: [
            { reasoningEffort: 'high', description: 'Thorough' },
            { reasoningEffort: 'future-unsupported', description: 'Future' },
          ],
        },
        { id: 'invalid-default', defaultReasoningEffort: 'high' },
      ],
    }),
  ).toEqual([
    { id: 'api-model', name: 'api-model', supportedReasoningEfforts: [] },
    {
      id: 'reasoning-model',
      name: 'Reasoning',
      supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Thorough' }],
      defaultReasoningEffort: 'high',
    },
    { id: 'invalid-default', name: 'invalid-default', supportedReasoningEfforts: [] },
  ]);
  for (const invalid of [null, {}, { data: [{}] }, { models: [{ slug: 'broken' }] }])
    expect(() => parseModelCatalog(invalid)).toThrow('Unexpected model catalog format');
});

test('selected reasoning effort reaches the real AI SDK agent request without restarting its conversation', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json(planCatalog);
      bodies.push(JSON.parse(init!.body as string));
      return sse(responseEvents('Answer'));
    }),
  );
  const signal = new AbortController().signal;
  const session = await provider.createSession('fixture-model', signal);
  for (const [text, effort] of [
    ['default', undefined],
    ['deeper', 'high'],
  ] as const) {
    await createUIMessageStreamResponse({
      stream: await provider.run(session, text, signal, effort),
    }).text();
  }
  expect(bodies.map((body) => (body.reasoning as { effort: string }).effort)).toEqual([
    'low',
    'high',
  ]);
  expect(JSON.stringify(bodies[1]!.input)).toContain('default');
  expect(JSON.stringify(bodies[1]!.input)).toContain('deeper');
  await expect(provider.run(session, 'invalid effort', signal, 'medium')).rejects.toMatchObject({
    code: 'reasoning_effort_unavailable',
    status: 422,
  });
  const plain = await provider.createSession('plain-model', signal);
  await expect(provider.run(plain, 'unsupported', signal, 'high')).rejects.toMatchObject({
    code: 'reasoning_effort_unavailable',
  });
  expect(bodies).toHaveLength(2);
});
