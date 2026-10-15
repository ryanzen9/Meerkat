import { agentHarness } from './bridgeFixture';
import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse } from 'ai';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import {
  unsupportedFields,
  validatePlanRequest,
} from '../src/extension/bridge/providers/openai/compatibility';
import type { HttpFetch } from '../src/extension/bridge/http';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';

test('real AI SDK agent emits compliant requests and official UI streams with full multi-turn history', async () => {
  const bodies: Record<string, unknown>[] = [];
  const http: HttpFetch = async (url, init) => {
    expect(String(url)).toStartWith('https://api.openai.com/v1/');
    if (String(url).endsWith('/models'))
      return Response.json({
        models: [
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' },
        ],
      });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-secret');
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    bodies.push(body);
    return sse(responseEvents('Hello 世界'));
  };
  const provider = agentHarness(new OpenAIChatGPTProvider(signedInAuth(), http));
  const signal = new AbortController().signal;
  expect(await provider.listModels(signal)).toEqual([
    { id: 'fixture-model', name: 'Fixture', supportedReasoningEfforts: [] },
  ]);
  const session = await provider.createSession('fixture-model', signal);
  for (const text of ['first user turn', 'second user turn']) {
    const stream = await provider.run(session, text, signal);
    const response = createUIMessageStreamResponse({ stream });
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    const output = await response.text();
    expect(output).toContain('text-delta');
    expect(output).toContain('Hello 世界');
    expect(output).toContain('[DONE]');
  }
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    validatePlanRequest(body);
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    for (const key of unsupportedFields) expect(body[key]).toBeUndefined();
    expect(JSON.stringify(body.tools)).toContain('"type":"namespace"');
    expect(JSON.stringify(body.tools)).toContain('inspect_text');
  }
  expect(JSON.stringify(bodies[1]!.input)).toContain('first user turn');
  expect(JSON.stringify(bodies[1]!.input)).toContain('second user turn');
  expect(JSON.stringify(bodies[1]!.input)).toContain('Hello 世界');
});

test('real AI SDK Function Tool execution round-trips through SDK and produces tool input/output UI events', async () => {
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const provider = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      bodies.push(JSON.parse(init!.body as string));
      calls++;
      return calls === 1
        ? sse(
            responseEvents('', [
              {
                id: 'fc_fixture',
                type: 'function_call',
                call_id: 'call_fixture',
                name: 'inspect_text',
                namespace: 'review',
                arguments: JSON.stringify({ text: '// TODO: inspect\nconst a = 1;' }),
                status: 'completed',
              },
            ]),
          )
        : sse(responseEvents('Inspected'));
    }),
  );
  const signal = new AbortController().signal;
  const session = await provider.createSession('fixture-model', signal);
  const output = await createUIMessageStreamResponse({
    stream: await provider.run(session, 'inspect this', signal),
  }).text();
  expect(calls).toBe(2);
  expect(output).toContain('tool-input-available');
  expect(output).toContain('tool-output-available');
  expect(output).toContain('lineCount');
  expect(JSON.stringify(bodies[1]!.input)).toContain('function_call_output');
  validatePlanRequest(bodies[1]);
  await createUIMessageStreamResponse({
    stream: await provider.run(session, 'follow up after using tools', signal),
  }).text();
  const nextInput = bodies[2]!.input as Record<string, unknown>[];
  expect(nextInput.find((item) => item.type === 'function_call')).toMatchObject({
    namespace: 'review',
    name: 'inspect_text',
    call_id: 'call_fixture',
  });
  expect(JSON.stringify(nextInput)).toContain('function_call_output');
  expect(JSON.stringify(nextInput)).toContain('lineCount');
});

test('SDK failures and truncated streams do not commit an unsuccessful turn', async () => {
  for (const mode of ['truncated', 'failed', 'incomplete']) {
    const provider = agentHarness(
      new OpenAIChatGPTProvider(signedInAuth(), async (url) => {
        if (String(url).endsWith('/models'))
          return Response.json({
            models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
          });
        const events = responseEvents('partial');
        if (mode === 'truncated') events.pop();
        else
          events[events.length - 1] = {
            type: `response.${mode}`,
            response: {
              ...(events.at(-1)!.response as object),
              status: mode,
              error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'quota' },
            },
          };
        return sse(events);
      }),
    );
    const signal = new AbortController().signal;
    const session = await provider.createSession('fixture-model', signal);
    await expect(
      createUIMessageStreamResponse({ stream: await provider.run(session, 'fail', signal) }).text(),
    ).rejects.toThrow();
    const state = session.history;
    expect(await state.getMessages()).toEqual([]);
  }
});

test('temporary usage check failure reports 503, preserves credentials and permits a later retry', async () => {
  const auth = signedInAuth();
  let fail = true;
  const provider = agentHarness(
    new OpenAIChatGPTProvider(auth, async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      const events = responseEvents(fail ? 'partial' : 'recovered');
      if (fail)
        events[events.length - 1] = {
          type: 'response.failed',
          response: {
            ...(events.at(-1)!.response as object),
            status: 'failed',
            error: {
              code: 'subscription_sharing_usage_unavailable',
              message: 'Bearer test-access-secret',
            },
          },
        };
      return sse(events);
    }),
  );
  const signal = new AbortController().signal;
  const session = await provider.createSession('fixture-model', signal);
  await expect(
    createUIMessageStreamResponse({ stream: await provider.run(session, 'first', signal) }).text(),
  ).rejects.toMatchObject({
    code: 'chatgpt_usage_unavailable',
    status: 503,
    message: 'ChatGPT usage availability is temporarily unavailable. Please retry later.',
  });
  expect((await auth.status()).authenticated).toBe(true);
  const state = session.history;
  expect(await state.getMessages()).toEqual([]);
  fail = false;
  const output = await createUIMessageStreamResponse({
    stream: await provider.run(session, 'retry', signal),
  }).text();
  expect(output).toContain('recovered');
  expect(JSON.stringify(await state.getMessages())).not.toContain('partial');
});

test('compatibility layer rejects unsupported fields, nonnamespace tools and system input', () => {
  const valid = {
    model: 'fixture',
    stream: true,
    store: false,
    input: [{ role: 'user', content: 'hi' }],
  };
  validatePlanRequest(valid);
  for (const key of unsupportedFields)
    expect(() => validatePlanRequest({ ...valid, [key]: 'unsupported' })).toThrow();
  expect(() =>
    validatePlanRequest({ ...valid, tools: [{ type: 'function', name: 'flat' }] }),
  ).toThrow('namespaced');
  expect(() =>
    validatePlanRequest({ ...valid, input: [{ type: 'message', role: 'system', content: 'bad' }] }),
  ).toThrow('developer');
});

test('the shared AI SDK agent bounds a repeated tool loop and preserves prior successful history', async () => {
  let looping = false;
  let calls = 0;
  const backend = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      calls++;
      return sse(
        responseEvents(
          'saved answer',
          looping
            ? [
                {
                  id: `fc_${calls}`,
                  type: 'function_call',
                  call_id: `call_${calls}`,
                  name: 'inspect_text',
                  namespace: 'review',
                  arguments: JSON.stringify({ text: '// TODO: repeated' }),
                  status: 'completed',
                },
              ]
            : undefined,
        ),
      );
    }),
  );
  const signal = new AbortController().signal;
  const session = await backend.createSession('fixture-model', signal);
  await createUIMessageStreamResponse({
    stream: await backend.run(session, 'saved question', signal),
  }).text();
  const original = session.history.getMessages();
  looping = true;
  await expect(
    createUIMessageStreamResponse({
      stream: await backend.run(session, 'loop forever', signal),
    }).text(),
  ).rejects.toMatchObject({ code: 'inference_incomplete' });
  expect(calls).toBe(9); // One successful turn, then the configured eight-step limit.
  expect(session.history.getMessages()).toEqual(original);
});

test('stateless reasoning metadata survives the shared history and stays out of the UI stream', async () => {
  const bodies: Record<string, unknown>[] = [];
  const backend = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [
            {
              slug: 'fixture-model',
              display_name: 'Fixture',
              visibility: 'list',
              supported_reasoning_levels: [{ effort: 'high', description: 'Thorough' }],
              default_reasoning_level: 'high',
            },
          ],
        });
      bodies.push(JSON.parse(init!.body as string));
      const reasoning = {
        id: `rs_${bodies.length}`,
        type: 'reasoning',
        summary: [],
        encrypted_content: 'opaque-encrypted-reasoning',
      };
      const events = responseEvents('answer').map((event) =>
        typeof event.output_index === 'number'
          ? { ...event, output_index: event.output_index + 1 }
          : event,
      );
      events.splice(
        1,
        0,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...reasoning, encrypted_content: undefined },
        },
        { type: 'response.output_item.done', output_index: 0, item: reasoning },
      );
      const terminal = events.at(-1)!.response as { output: unknown[] };
      terminal.output.unshift(reasoning);
      return sse(events);
    }),
  );
  const signal = new AbortController().signal;
  const session = await backend.createSession('fixture-model', signal);
  for (const text of ['first', 'second']) {
    const output = await createUIMessageStreamResponse({
      stream: await backend.run(session, text, signal),
    }).text();
    expect(output).not.toContain('opaque-encrypted-reasoning');
  }
  expect(JSON.stringify(bodies[1]!.input)).toContain('opaque-encrypted-reasoning');
  expect(JSON.stringify(bodies[1]!.input)).toContain('first');
});

test('upstream authentication failure clears credentials and never retries or returns token details', async () => {
  const auth = signedInAuth();
  let calls = 0;
  const backend = agentHarness(
    new OpenAIChatGPTProvider(auth, async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      calls++;
      return Response.json({ error: { message: 'Bearer test-access-secret' } }, { status: 401 });
    }),
  );
  const signal = new AbortController().signal;
  const session = await backend.createSession('fixture-model', signal);
  await expect(
    createUIMessageStreamResponse({ stream: await backend.run(session, 'hello', signal) }).text(),
  ).rejects.toMatchObject({ code: 'sign_in_required', status: 401 });
  expect(calls).toBe(1);
  expect((await auth.status()).authenticated).toBe(false);
  expect(session.history.getMessages()).toEqual([]);
});
