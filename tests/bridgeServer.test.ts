import { expect, test } from 'bun:test';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { OpenAIAgentsProvider } from '../src/extension/bridge/providers/openai/provider';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { createBridgeApi } from '../src/extension/bridge/server/api';
import { BridgeHttpServer } from '../src/extension/bridge/server/httpServer';
import { WebviewBridgeProxy } from '../src/extension/bridge/transport/webviewProxy';
import { publicError } from '../src/extension/bridge/errors';
import type { HttpFetch } from '../src/extension/bridge/http';
import type { ExtensionToWebviewMessage } from '../src/shared/protocol';
import { isWebviewMessage, isExtensionMessage } from '../src/shared/protocol';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';

function setup(http?: HttpFetch, timeoutMs?: number) {
  const registry = new ProviderRegistry();
  const models: HttpFetch = async (url, init) =>
    String(url).endsWith('/models')
      ? Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        })
      : http
        ? http(url, init)
        : sse(responseEvents('Hello'));
  registry.register(() => new OpenAIAgentsProvider(signedInAuth(), models));
  const runtime = new BridgeRuntime(registry, timeoutMs);
  const api = createBridgeApi({
    runtime,
    callbackUri: () => 'http://127.0.0.1:1234/auth/callback',
    openBrowser: async () => {},
  });
  return { registry, runtime, api };
}
const request = (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
  new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
async function session(api: ReturnType<typeof createBridgeApi>) {
  const response = await api(
    request('/v1/sessions', 'POST', { providerId: 'openai-agents', model: 'fixture-model' }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test('API manages sessions, provider/model lists and official SSE with run state', async () => {
  const { runtime, api } = setup();
  try {
    expect((await api(request('/v1/providers'))).status).toBe(200);
    expect((await api(request('/v1/providers/openai-agents/models'))).status).toBe(200);
    const id = await session(api);
    const response = await api(request(`/v1/sessions/${id}/messages`, 'POST', { text: 'Hello' }));
    const runId = response.headers.get('x-bridge-run-id')!;
    const output = await response.text();
    expect(output).toContain('data-run-state');
    expect(output).toContain('"status":"completed"');
    expect(output).toContain('[DONE]');
    expect(runtime.status(runId).status).toBe('completed');
    const serialized = JSON.stringify(await (await api(request('/v1/sessions'))).json());
    expect(serialized).not.toMatch(/tokens|test-access|state/);
    expect((await api(request(`/v1/sessions/${id}`, 'DELETE'))).status).toBe(204);
    expect((await api(request(`/v1/sessions/${id}`))).status).toBe(404);
  } finally {
    await runtime.dispose();
  }
});

test('validates input, provider/model selection and accepts only new text user turns', async () => {
  const { runtime, api } = setup();
  try {
    expect(
      (
        await api(
          request('/v1/sessions', 'POST', { providerId: 'missing', model: 'fixture-model' }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(request('/v1/sessions', 'POST', { providerId: 'openai-agents', model: 'hidden' })))
        .status,
    ).toBe(422);
    expect(
      (
        await api(
          request('/v1/sessions', 'POST', {
            providerId: 'openai-agents',
            model: 'fixture-model',
            apiKey: 'bad',
          }),
        )
      ).status,
    ).toBe(400);
    const id = await session(api);
    expect((await api(request(`/v1/sessions/${id}/messages`, 'POST', { text: '' }))).status).toBe(
      400,
    );
    const bad = await api(
      request('/v1/chat', 'POST', {
        sessionId: id,
        messages: [{ id: 'm1', role: 'assistant', parts: [] }],
      }),
    );
    expect(bad.status).toBe(400);
    const output = await (
      await api(
        request('/v1/chat', 'POST', {
          sessionId: id,
          messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
          tools: { injected: {} },
          system: 'ignored',
        }),
      )
    ).text();
    expect(output).toContain('Hello');
  } finally {
    await runtime.dispose();
  }
});

test('a quota failure after streaming starts yields a safe error and a failed run', async () => {
  const f = setup(async () => {
    const events = responseEvents('partial');
    events[events.length - 1] = {
      type: 'response.failed',
      response: {
        ...(events.at(-1)!.response as object),
        status: 'failed',
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'Bearer test-access-secret',
        },
      },
    };
    return sse(events);
  });
  try {
    const id = await session(f.api);
    const response = await f.api(request(`/v1/sessions/${id}/messages`, 'POST', { text: 'hi' }));
    const text = await response.text();
    expect(text).toContain('chatgpt_usage_limit');
    expect(text).toContain('"status":"failed"');
    expect(text).not.toContain('test-access-secret');
    expect(f.runtime.status(response.headers.get('x-bridge-run-id')!).status).toBe('failed');
  } finally {
    await f.runtime.dispose();
  }
});

test('per-session exclusion, pre-consumption cancellation and run timeout never strand shutdown', async () => {
  const f = setup(undefined, 20);
  try {
    const id = await session(f.api);
    const started = f.runtime.start(id, 'Hello', new AbortController().signal);
    expect(() => f.runtime.start(id, 'concurrent', new AbortController().signal)).toThrow(
      'already active',
    );
    f.runtime.cancel(started.runId);
    const reader = started.stream.getReader();
    while (!(await reader.read()).done) {}
    expect(f.runtime.status(started.runId).status).toBe('cancelled');
    const timeout = f.runtime.start(id, 'never read', new AbortController().signal);
    await Bun.sleep(30);
    expect(f.runtime.status(timeout.runId).status).toBe('cancelled');
    await f.runtime.cancelProvider('openai-agents');
  } finally {
    await f.runtime.dispose();
  }
});

test('cancellation propagates AbortSignal to an in-flight real SDK fetch', async () => {
  let aborted = false;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = setup(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        entered();
        init!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new DOMException('Abort', 'AbortError'));
          },
          { once: true },
        );
      }),
  );
  try {
    const id = await session(f.api);
    const response = await f.api(request(`/v1/sessions/${id}/messages`, 'POST', { text: 'hi' }));
    const consume = response.text();
    await ready;
    const runId = response.headers.get('x-bridge-run-id')!;
    await f.api(request(`/v1/runs/${runId}/cancel`, 'POST', {}));
    expect(await consume).toContain('cancelled');
    expect(aborted).toBe(true);
  } finally {
    await f.runtime.dispose();
  }
});

test('loopback server enforces bearer capability, origin whitelist, Host and size limits', async () => {
  const f = setup();
  const server = new BridgeHttpServer({ handle: f.api, allowedOrigins: ['https://allowed.test'] });
  try {
    const connection = await server.start();
    const headers = { Authorization: connection.authorization };
    expect((await fetch(`${connection.baseUrl}/v1/providers`)).status).toBe(401);
    expect(
      (
        await fetch(`${connection.baseUrl}/v1/providers`, {
          headers: { ...headers, Origin: 'https://evil.test' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${connection.baseUrl}/v1/providers`, {
          headers: { ...headers, Host: 'evil.test' },
        })
      ).status,
    ).toBe(403);
    const ok = await fetch(`${connection.baseUrl}/v1/providers`, {
      headers: { ...headers, Origin: 'https://allowed.test' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://allowed.test');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const large = await fetch(`${connection.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: 'a'.repeat(1048577),
    });
    expect(large.status).toBe(413);
    expect((await fetch(`${connection.baseUrl}/auth/callback?state=invalid`)).status).toBe(400);
  } finally {
    await server.close();
    await f.runtime.dispose();
  }
});

test('webview proxy validates IPC, preserves UTF-8 and waits for ACK before another chunk', async () => {
  const sent: ExtensionToWebviewMessage[] = [];
  const source = `${'x'.repeat(32767)}😀你好`;
  let proxy: WebviewBridgeProxy;
  proxy = new WebviewBridgeProxy(
    async () => new Response(source),
    async (message) => {
      expect(isExtensionMessage(message)).toBe(true);
      sent.push(message);
      if (message.type === 'host/bridge-chunk') queueMicrotask(() => proxy.ack(message.requestId));
    },
  );
  await proxy.send({ requestId: 'one', path: '/v1/providers', method: 'GET' });
  const chunks = sent.filter((m) => m.type === 'host/bridge-chunk');
  expect(chunks.map((m) => m.text).join('')).toBe(source);
  expect(sent.at(-1)?.type).toBe('host/bridge-end');
  expect(
    isWebviewMessage({
      type: 'bridge/request',
      requestId: '1',
      path: 'https://evil.test',
      method: 'POST',
    }),
  ).toBe(false);
  expect(
    isExtensionMessage({
      type: 'host/bridge-head',
      requestId: '1',
      status: 200,
      headers: { authorization: 'secret' },
    }),
  ).toBe(false);
  expect(publicError(new Error('Bearer test-access-secret')).message).not.toContain('secret');
  proxy.dispose();
});
