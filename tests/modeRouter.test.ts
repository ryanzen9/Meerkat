import { expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import type { ModelProvider } from '../src/extension/bridge/providers/types';
import type { ReasoningEffort } from '../src/shared/agentModels';
import { BridgeError } from '../src/extension/bridge/errors';
import type { HttpFetch } from '../src/extension/bridge/http';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { resolveInteractionMode } from '../src/extension/bridge/runtime/modeRouter';
import { SessionStore } from '../src/extension/bridge/sessions/store';
import { responseEvents, signedInAuth, sse } from './bridgeFixture';

type TestChunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never;
const finishChunk = (reason: 'stop' | 'tool-calls'): TestChunk => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
});
const routeCall = (input: unknown): TestChunk[] => [
  {
    type: 'tool-call',
    toolCallId: 'router-call',
    toolName: 'select_interaction_mode',
    input: JSON.stringify(input),
  },
  finishChunk('tool-calls'),
];
const textAnswer = (text: string): TestChunk[] => [
  { type: 'text-start', id: 'answer' },
  { type: 'text-delta', id: 'answer', delta: text },
  { type: 'text-end', id: 'answer' },
  finishChunk('stop'),
];

function modelProvider(resolveModel: ModelProvider['resolveModel']): ModelProvider {
  return {
    info: {
      id: 'fixture',
      name: 'Fixture',
      capabilities: { streaming: true, functionTools: true, sessions: true, cancellation: true },
    },
    initialize: async () => {},
    authStatus: async () => ({ authenticated: true, accounts: [] }),
    login: async () => '',
    callback: async () => {},
    logout: async () => ({ remoteRevocationConfirmed: true }),
    listModels: async () => [],
    createSession: async (model) => ({ accountId: 'account', model }),
    resolveModel,
    dispose: async () => {},
  };
}

function fixture(respond: (prompt: string) => TestChunk[]) {
  const efforts: (ReasoningEffort | undefined)[] = [];
  const prompts: string[] = [];
  const provider = modelProvider(async (session, signal, reasoningEffort) => {
    efforts.push(reasoningEffort);
    signal.throwIfAborted();
    const model = new MockLanguageModelV4({
      modelId: session.model,
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        const chunks = respond(JSON.stringify(prompt));
        return {
          stream: new ReadableStream<TestChunk>({
            start(output) {
              for (const chunk of chunks) output.enqueue(chunk);
              output.close();
            },
          }),
        };
      },
    });
    return { model };
  });
  const session = new SessionStore().create('fixture', {
    model: 'fixture-model',
    accountId: 'account',
  });
  return { provider, efforts, prompts, session };
}

test('routes an explicit review request to review with the user-selected reasoning effort', async () => {
  const f = fixture(() =>
    routeCall({ mode: 'review', confidence: 'high', reason: 'asks to review changes' }),
  );
  const decision = await resolveInteractionMode(
    f.provider,
    f.session,
    '审查当前工作区的改动',
    'high',
    new AbortController().signal,
  );
  expect(decision.mode).toBe('review');
  expect(decision.confidence).toBe('high');
  expect(decision.reason).toBe('asks to review changes');
  expect(decision.fallback).toBeUndefined();
  expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
  // The router must not pick its own model or effort.
  expect(f.efforts).toEqual(['high']);
  expect(f.prompts[0]).toContain('审查当前工作区的改动');
});

test('routes discussion and explanation to chat with an unchanged undefined effort', async () => {
  const f = fixture(() => routeCall({ mode: 'chat', confidence: 'high' }));
  const decision = await resolveInteractionMode(
    f.provider,
    f.session,
    '总结这次改动的内容、影响面与风险',
    undefined,
    new AbortController().signal,
  );
  expect(decision.mode).toBe('chat');
  expect(decision.confidence).toBe('high');
  expect(decision.fallback).toBeUndefined();
  expect(f.efforts).toEqual([undefined]);
});

test('treats a low-confidence review decision as chat', async () => {
  const f = fixture(() => routeCall({ mode: 'review', confidence: 'low' }));
  const decision = await resolveInteractionMode(
    f.provider,
    f.session,
    '看看这段',
    'low',
    new AbortController().signal,
  );
  expect(decision.mode).toBe('chat');
  expect(decision.confidence).toBe('low');
  expect(decision.fallback).toBeUndefined();
});

test('gives the router recent user turns so follow-ups can stay in review', async () => {
  const f = fixture(() => routeCall({ mode: 'review', confidence: 'high' }));
  f.session.history.commit([
    { role: 'user', content: '审查 src/a.ts 的改动' },
    { role: 'assistant', content: '已收录 2 条问题。' },
  ]);
  const decision = await resolveInteractionMode(
    f.provider,
    f.session,
    '继续审查剩下的文件',
    undefined,
    new AbortController().signal,
  );
  expect(decision.mode).toBe('review');
  expect(f.prompts[0]).toContain('审查 src/a.ts 的改动');
  expect(f.prompts[0]).toContain('继续审查剩下的文件');
});

test('falls back to chat when the model does not call the routing tool', async () => {
  const f = fixture(() => textAnswer('plain answer'));
  const decision = await resolveInteractionMode(
    f.provider,
    f.session,
    'hello',
    undefined,
    new AbortController().signal,
  );
  expect(decision.mode).toBe('chat');
  expect(decision.fallback).toBe('invalid_decision');
});

test('falls back to chat for an invalid routing decision', async () => {
  const f = fixture(() => routeCall({ mode: 'banana', confidence: 'high' }));
  const decision = await resolveInteractionMode(
    f.provider,
    f.session,
    'hello',
    undefined,
    new AbortController().signal,
  );
  expect(decision.mode).toBe('chat');
  expect(decision.fallback).toBeDefined();
});

test('falls back to chat when resolving the model fails', async () => {
  const provider = modelProvider(async () => {
    throw new BridgeError('sign_in_required', 'Continue with ChatGPT first.', 401);
  });
  const session = new SessionStore().create('fixture', {
    model: 'fixture-model',
    accountId: 'account',
  });
  const decision = await resolveInteractionMode(
    provider,
    session,
    '审查当前工作区的改动',
    'high',
    new AbortController().signal,
  );
  expect(decision.mode).toBe('chat');
  expect(decision.fallback).toBe('sign_in_required');
});

test('rethrows cancellation instead of silently falling back', async () => {
  const f = fixture(() => routeCall({ mode: 'review', confidence: 'high' }));
  const controller = new AbortController();
  controller.abort(new Error('cancelled by user'));
  await expect(
    resolveInteractionMode(
      f.provider,
      f.session,
      '审查当前工作区的改动',
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow('cancelled by user');
});

test('the router request satisfies the ChatGPT plan contract through the real provider', async () => {
  let responses = 0;
  const http: HttpFetch = async (url, init) => {
    if (String(url).endsWith('/models'))
      return Response.json({
        models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
      });
    responses++;
    // planFetch already validated this serialized request; inspect the shape too.
    const body = JSON.parse(init!.body as string) as {
      stream: boolean;
      tools: { type: string; tools?: { name: string }[] }[];
    };
    expect(body.stream).toBe(true);
    expect(
      body.tools
        .filter((tool) => tool.type === 'namespace')
        .flatMap((tool) => tool.tools?.map((entry) => entry.name) ?? []),
    ).toContain('select_interaction_mode');
    return sse(
      responseEvents('', [
        {
          id: 'fc_router',
          type: 'function_call',
          call_id: 'call_router',
          name: 'select_interaction_mode',
          namespace: 'review',
          arguments: JSON.stringify({
            mode: 'review',
            confidence: 'high',
            reason: 'explicit review',
          }),
          status: 'completed',
        },
      ]),
    );
  };
  const provider = new OpenAIChatGPTProvider(signedInAuth(), http);
  const session = new SessionStore().create(
    provider.info.id,
    await provider.createSession('fixture-model', new AbortController().signal),
  );
  const decision = await resolveInteractionMode(
    provider,
    session,
    '审查当前工作区的改动',
    undefined,
    new AbortController().signal,
  );
  expect(responses).toBe(1);
  expect(decision.mode).toBe('review');
  expect(decision.fallback).toBeUndefined();
});
