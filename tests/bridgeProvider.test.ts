import { agentHarness } from './bridgeFixture';
import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse, hasToolCall } from 'ai';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import {
  unsupportedFields,
  validatePlanRequest,
} from '../src/extension/bridge/providers/openai/compatibility';
import type { HttpFetch } from '../src/extension/bridge/http';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';
import { reviewFixture } from './reviewFixture';

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
    const namespaces = body.tools as { name: string; tools: { name: string }[] }[];
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]!.name).toBe('review');
    expect(namespaces[0]!.tools.map((tool) => tool.name).toSorted()).toEqual([
      'cite_files',
      'get_diagnostics',
      'get_diff',
      'get_review_context',
      'list_changes',
      'read_file',
      'search_code',
    ]);
  }
  expect(JSON.stringify(bodies[1]!.input)).toContain('first user turn');
  expect(JSON.stringify(bodies[1]!.input)).toContain('second user turn');
  expect(JSON.stringify(bodies[1]!.input)).toContain('Hello 世界');
});

test('real AI SDK Function Tool execution round-trips through SDK and produces tool input/output UI events', async () => {
  const fixture = await reviewFixture({ 'file.ts': '// TODO: inspect\nconst a = 1;' });
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
                name: 'search_code',
                namespace: 'review',
                arguments: JSON.stringify({ query: 'TODO' }),
                status: 'completed',
              },
            ]),
          )
        : sse(responseEvents('Searched'));
    }),
    {},
    fixture.context,
  );
  const signal = new AbortController().signal;
  const session = await provider.createSession('fixture-model', signal);
  const output = await createUIMessageStreamResponse({
    stream: await provider.run(session, 'inspect this', signal),
  }).text();
  expect(calls).toBe(2);
  expect(output).toContain('tool-input-available');
  expect(output).toContain('tool-output-available');
  expect(output).toContain('matches');
  expect(output).toContain('file.ts');
  expect(JSON.stringify(bodies[1]!.input)).toContain('function_call_output');
  validatePlanRequest(bodies[1]);
  await createUIMessageStreamResponse({
    stream: await provider.run(session, 'follow up after using tools', signal),
  }).text();
  const nextInput = bodies[2]!.input as Record<string, unknown>[];
  expect(nextInput.find((item) => item.type === 'function_call')).toMatchObject({
    namespace: 'review',
    name: 'search_code',
    call_id: 'call_fixture',
  });
  expect(JSON.stringify(nextInput)).toContain('function_call_output');
  expect(JSON.stringify(nextInput)).toContain('matches');
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

const searchResponse = (step: number) =>
  sse(
    responseEvents('', [
      {
        id: `fc_${step}`,
        type: 'function_call',
        call_id: `call_${step}`,
        name: 'search_code',
        namespace: 'review',
        arguments: JSON.stringify({ query: `search ${step}` }),
        status: 'completed',
      },
    ]),
  );

test('reviews run beyond SDK and previous step caps until the model finishes', async () => {
  let calls = 0;
  const backend = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      validatePlanRequest(JSON.parse(init!.body as string));
      calls++;
      expect(JSON.parse(init!.body as string).tool_choice).not.toBe('none');
      return calls <= 40
        ? searchResponse(calls)
        : sse(responseEvents('Review completed after forty tool rounds.'));
    }),
  );
  const signal = new AbortController().signal;
  const session = await backend.createSession('fixture-model', signal);
  const output = await createUIMessageStreamResponse({
    stream: await backend.run(session, 'Review these changes', signal),
  }).text();
  expect(calls).toBe(41);
  expect(output.match(/"type":"tool-output-available"/g)).toHaveLength(40);
  expect(output).toContain('Review completed after forty tool rounds.');
  expect(JSON.stringify(session.history.getMessages())).toContain(
    'Review completed after forty tool rounds.',
  );
});

test('a configured stop condition can end the loop on a tool result', async () => {
  let calls = 0;
  const backend = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      return searchResponse(++calls);
    }),
    { stopWhen: hasToolCall('search_code') },
  );
  const signal = new AbortController().signal;
  const session = await backend.createSession('fixture-model', signal);
  const output = await createUIMessageStreamResponse({
    stream: await backend.run(session, 'Search the code', signal),
  }).text();
  expect(calls).toBe(1);
  expect(output).toContain('tool-output-available');
  expect(JSON.stringify(session.history.getMessages())).toContain('search 1');
});

test('explicit cancellation stops a continuing loop and preserves prior successful history', async () => {
  let looping = false;
  let calls = 0;
  const controller = new AbortController();
  const backend = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        });
      calls++;
      if (looping && calls === 42) controller.abort();
      return looping ? searchResponse(calls) : sse(responseEvents('saved answer'));
    }),
  );
  const session = await backend.createSession('fixture-model', controller.signal);
  await createUIMessageStreamResponse({
    stream: await backend.run(session, 'saved question', controller.signal),
  }).text();
  const original = session.history.getMessages();
  looping = true;
  await expect(
    createUIMessageStreamResponse({
      stream: await backend.run(session, 'keep reviewing', controller.signal),
    }).text(),
  ).rejects.toMatchObject({ code: 'run_cancelled' });
  expect(calls).toBe(42);
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
