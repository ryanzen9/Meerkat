import { expect, test } from 'bun:test';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { createBridgeApi, type BridgeApiOptions } from '../src/extension/bridge/server/api';
import { BridgeHttpServer } from '../src/extension/bridge/server/httpServer';
import { WebviewBridgeProxy } from '../src/extension/bridge/transport/webviewProxy';
import { publicError } from '../src/extension/bridge/errors';
import type { HttpFetch } from '../src/extension/bridge/http';
import type { ReasoningEffort } from '../src/shared/agentModels';
import type { ExtensionToWebviewMessage } from '../src/shared/protocol';
import { isWebviewMessage, isExtensionMessage } from '../src/shared/protocol';
import { signedInAuth, responseEvents, sse } from './bridgeFixture';

function setup(http?: HttpFetch, timeoutMs?: number, decideMode?: BridgeApiOptions['decideMode']) {
  const registry = new ProviderRegistry();
  const models: HttpFetch = async (url, init) =>
    String(url).endsWith('/models')
      ? Response.json({
          models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
        })
      : http
        ? http(url, init)
        : sse(responseEvents('Hello'));
  registry.register(() => new OpenAIChatGPTProvider(signedInAuth(), models));
  const runtime = new BridgeRuntime(registry, { idleTimeoutMs: timeoutMs });
  const api = createBridgeApi({
    runtime,
    callbackUri: () => 'http://127.0.0.1:1234/auth/callback',
    openBrowser: async () => {},
    ...(decideMode ? { decideMode } : {}),
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

test('turn routes reject invalid reasoning effort values before dispatch', async () => {
  const { runtime, api } = setup();
  try {
    const id = await session(api);
    const messages = [
      { id: 'question', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
    ];
    for (const reasoningEffort of ['invalid', 10, null, { effort: 'high' }]) {
      expect(
        (await api(request('/v1/chat', 'POST', { sessionId: id, messages, reasoningEffort })))
          .status,
      ).toBe(400);
      expect(
        (
          await api(
            request(`/v1/sessions/${id}/messages`, 'POST', { text: 'Question', reasoningEffort }),
          )
        ).status,
      ).toBe(400);
    }
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

test('per-session exclusion, pre-consumption cancellation and idle timeout never strand shutdown', async () => {
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

test('progress across multiple model rounds resets inactivity instead of limiting run duration', async () => {
  let calls = 0;
  const f = setup(async () => {
    await Bun.sleep(40);
    calls++;
    return sse(
      responseEvents(
        'Review completed',
        calls <= 5
          ? [
              {
                id: `fc_${calls}`,
                type: 'function_call',
                call_id: `call_${calls}`,
                name: 'search_code',
                namespace: 'review',
                arguments: JSON.stringify({ query: 'progress' }),
                status: 'completed',
              },
            ]
          : undefined,
      ),
    );
  }, 120);
  try {
    const id = await session(f.api);
    const response = await f.api(
      request(`/v1/sessions/${id}/messages`, 'POST', { text: 'Long review' }),
    );
    const text = await response.text();
    expect(calls).toBe(6);
    expect(text).toContain('Review completed');
    expect(text).not.toContain('run_idle_timeout');
    expect(f.runtime.status(response.headers.get('x-bridge-run-id')!).status).toBe('completed');
  } finally {
    await f.runtime.dispose();
  }
});

test('a model request with no response is cancelled by inactivity and aborts its fetch', async () => {
  let aborted = false;
  const f = setup(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      }),
    40,
  );
  try {
    const id = await session(f.api);
    const response = await f.api(
      request(`/v1/sessions/${id}/messages`, 'POST', { text: 'Wait for response' }),
    );
    const text = await response.text();
    expect(text).toContain('run_idle_timeout');
    expect(aborted).toBe(true);
    expect(f.runtime.status(response.headers.get('x-bridge-run-id')!).status).toBe('cancelled');
    // The user turn is durable before inference starts, so even a run that
    // receives no model response keeps its request for a later continuation.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (f.runtime.sessions.get(id).history.getMessages().length > 0) break;
      await Bun.sleep(5);
    }
    expect(f.runtime.sessions.get(id).history.getMessages()).toEqual([
      { role: 'user', content: 'Wait for response' },
    ]);
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
      // A 413 can arrive before Bun finishes uploading; keep that rejected
      // upload's socket out of the next request's connection pool.
      headers: { ...headers, 'content-type': 'application/json', connection: 'close' },
      body: 'a'.repeat(1048577),
    });
    expect(large.status).toBe(413);
    // Consume the complete rejection response as well as checking its status.
    await large.arrayBuffer();
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

test('Host proxy keeps an active stream alive past its inactivity interval', async () => {
  const sent: ExtensionToWebviewMessage[] = [];
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(output) {
      await Bun.sleep(35);
      if (++index <= 5) output.enqueue(new TextEncoder().encode('progress'));
      else output.close();
    },
  });
  const proxy = new WebviewBridgeProxy(
    async () => new Response(body),
    async (message) => {
      sent.push(message);
      if (message.type === 'host/bridge-chunk') queueMicrotask(() => proxy.ack(message.requestId));
    },
    100,
  );
  try {
    await proxy.send({ requestId: 'progress', path: '/v1/providers', method: 'GET' });
    expect(sent.filter((message) => message.type === 'host/bridge-chunk')).toHaveLength(5);
    expect(sent.at(-1)?.type).toBe('host/bridge-end');
  } finally {
    proxy.dispose();
  }
});

test('Host proxy cancels a transport that never returns a response', async () => {
  const sent: ExtensionToWebviewMessage[] = [];
  let aborted = false;
  const proxy = new WebviewBridgeProxy(
    async (_path, _method, _body, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    async (message) => {
      sent.push(message);
    },
    25,
  );
  try {
    await proxy.send({ requestId: 'idle', path: '/v1/providers', method: 'GET' });
    expect(aborted).toBe(true);
    expect(sent.at(-1)).toMatchObject({
      type: 'host/bridge-error',
      message: expect.stringContaining('bridge_idle_timeout'),
    });
  } finally {
    proxy.dispose();
  }
});

test('an explicit client mode bypasses automatic routing', async () => {
  let decisions = 0;
  const { runtime, api } = setup(undefined, undefined, async () => {
    decisions++;
    return 'review';
  });
  try {
    const id = await session(api);
    const response = await api(
      request(`/v1/sessions/${id}/messages`, 'POST', { text: 'Hello', mode: 'chat' }),
    );
    const output = await response.text();
    expect(decisions).toBe(0);
    expect(output).not.toContain('data-review-status');
    expect(output).toContain('"status":"completed"');
    expect(output).toContain('Hello');
  } finally {
    await runtime.dispose();
  }
});

test('automatic routing runs the turn as a review when the model decides review', async () => {
  const decisions: { text: string; reasoningEffort?: ReasoningEffort }[] = [];
  const { runtime, api } = setup(undefined, undefined, async ({ text, reasoningEffort }) => {
    decisions.push({ text, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) });
    return 'review';
  });
  try {
    const id = await session(api);
    const response = await api(
      request(`/v1/sessions/${id}/messages`, 'POST', { text: '审查当前工作区的改动' }),
    );
    const output = await response.text();
    expect(decisions).toEqual([{ text: '审查当前工作区的改动' }]);
    // The review wrapper starts before the agent runs and requires finish_review.
    expect(output).toContain('data-review-status');
    expect(output).toContain('review_incomplete');
    const snapshot = (await (await api(request(`/v1/sessions/${id}/reviews`))).json()) as {
      runs: { text: string; status: string }[];
    };
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ text: '审查当前工作区的改动', status: 'failed' });
  } finally {
    await runtime.dispose();
  }
});

test('automatic routing receives the selected reasoning effort unchanged', async () => {
  const decisions: { reasoningEffort?: ReasoningEffort }[] = [];
  const { runtime, api } = setup(undefined, undefined, async ({ reasoningEffort }) => {
    decisions.push(reasoningEffort !== undefined ? { reasoningEffort } : {});
    return 'chat';
  });
  try {
    const id = await session(api);
    const response = await api(
      request(`/v1/sessions/${id}/messages`, 'POST', { text: 'Hello', reasoningEffort: 'high' }),
    );
    await response.text();
    expect(decisions).toEqual([{ reasoningEffort: 'high' }]);
  } finally {
    await runtime.dispose();
  }
});
