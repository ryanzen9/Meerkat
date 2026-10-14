import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const path = process.argv[2];
if (!path) throw new Error('Usage: bun run bridge:smoke /absolute/path/to/bridge-PID.json');
const connection = z
  .object({
    baseUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
    authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]{43}$/),
  })
  .parse(JSON.parse(await readFile(path, 'utf8')));
const api = async (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${connection.baseUrl}${route}`, {
    method,
    headers: { Authorization: connection.authorization, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(150000),
  });
  if (!response.ok) {
    const error = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .parse(await response.json());
    throw new Error(`${error.error.code}: ${error.error.message}`);
  }
  return response;
};
const status = z
  .object({ authenticated: z.boolean() })
  .parse(await (await api('/v1/providers/openai-agents/auth')).json());
if (!status.authenticated) throw new Error('Use Continue with ChatGPT in VS Code first.');
const models = z
  .array(z.object({ id: z.string(), name: z.string() }))
  .parse(await (await api('/v1/providers/openai-agents/models')).json());
const selected = models[0];
if (!selected) throw new Error('No models available for this account.');
console.log(`Available models: ${models.map((model) => model.id).join(', ')}`);
const session = z
  .object({ id: z.string() })
  .parse(
    await (await api('/v1/sessions', { providerId: 'openai-agents', model: selected.id })).json(),
  );
try {
  const response = await api(`/v1/sessions/${session.id}/messages`, {
    text: 'Say exactly: Hello, world!',
  });
  if (response.headers.get('x-vercel-ai-ui-message-stream') !== 'v1')
    throw new Error('Missing official UI stream header');
  const runId = response.headers.get('x-bridge-run-id');
  if (!runId) throw new Error('Missing Bridge run ID');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const text = decoder.decode(next.value, { stream: true });
    process.stdout.write(text);
    output += text;
  }
  const result = z
    .object({ status: z.string() })
    .parse(await (await api(`/v1/runs/${runId}`)).json());
  if (result.status !== 'completed' || !output.includes('[DONE]') || !output.includes('text-delta'))
    throw new Error(`Stream verification failed (${result.status})`);
  console.log('Verified completed inference and AI SDK UI Message Stream.');
} finally {
  await api(`/v1/sessions/${session.id}`, undefined, 'DELETE');
}
