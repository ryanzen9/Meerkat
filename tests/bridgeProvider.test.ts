import { expect, test } from 'bun:test';
import { createUIMessageStreamResponse } from 'ai';
import { OpenAIAgentsProvider } from '../src/extension/bridge/providers/openai/provider';
import {
  unsupportedFields,
  validatePlanRequest,
} from '../src/extension/bridge/providers/openai/compatibility';
import type { HttpFetch } from '../src/extension/bridge/http';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';

test('real Agents SDK emits compliant requests and official UI streams with full multi-turn history', async () => {
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
  const provider = new OpenAIAgentsProvider(signedInAuth(), http);
  const signal = new AbortController().signal;
  expect(await provider.listModels(signal)).toEqual([{ id: 'fixture-model', name: 'Fixture' }]);
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

test('real Function Tool execution round-trips through SDK and produces tool input/output UI events', async () => {
  let calls = 0;
  const bodies: Record<string, unknown>[] = [];
  const provider = new OpenAIAgentsProvider(signedInAuth(), async (url, init) => {
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
  });
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
});

test('SDK failures and truncated streams do not commit an unsuccessful turn', async () => {
  for (const mode of ['truncated', 'failed', 'incomplete']) {
    const provider = new OpenAIAgentsProvider(signedInAuth(), async (url) => {
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
    });
    const signal = new AbortController().signal;
    const session = await provider.createSession('fixture-model', signal);
    await expect(
      createUIMessageStreamResponse({ stream: await provider.run(session, 'fail', signal) }).text(),
    ).rejects.toThrow();
    const state = session.state as { getItems(): Promise<unknown[]> };
    expect(await state.getItems()).toEqual([]);
  }
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
