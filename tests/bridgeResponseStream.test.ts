import { agentHarness } from './bridgeFixture';
import { expect, test } from 'bun:test';
import type { UIMessageChunk } from 'ai';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { restoreCompletedOutput } from '../src/extension/bridge/providers/openai/responseStream';
import { responseEvents, signedInAuth, sse } from './bridgeFixture';
import { reviewFixture } from './reviewFixture';

function missingTerminalOutput(events: Record<string, unknown>[]) {
  return events.map((event) =>
    event.type === 'response.completed'
      ? { ...event, response: { ...(event.response as object), output: [] } }
      : event,
  );
}
async function chunks(stream: ReadableStream<UIMessageChunk>) {
  const result: UIMessageChunk[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return result;
      result.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}
const text = (parts: UIMessageChunk[]) =>
  parts.flatMap((part) => (part.type === 'text-delta' ? [part.delta] : [])).join('');
const models = () =>
  Response.json({
    models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
  });
const outputMessage = (id: string) => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: '你好' }],
});

for (const terminalStatus of ['completed', undefined, 'in_progress']) {
  for (const contentType of [true, false]) {
    test(`a streamed greeting with empty output, ${terminalStatus ?? 'missing'} status and ${contentType ? 'present' : 'missing'} content-type makes one inference and preserves complete multi-turn history`, async () => {
      const bodies: Record<string, unknown>[] = [];
      const provider = agentHarness(
        new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
          if (String(url).endsWith('/models')) return models();
          bodies.push(JSON.parse(init!.body as string));
          const response = sse(
            missingTerminalOutput(responseEvents(`answer-${bodies.length}`)).map((event) =>
              event.type === 'response.completed'
                ? { ...event, response: { ...(event.response as object), status: terminalStatus } }
                : event,
            ),
          );
          if (!contentType) response.headers.delete('content-type');
          return response;
        }),
      );
      const signal = new AbortController().signal;
      const session = await provider.createSession('fixture-model', signal);
      try {
        const first = await chunks(await provider.run(session, 'hello', signal));
        expect(bodies).toHaveLength(1);
        expect(text(first)).toBe('answer-1');
        expect(first.filter((part) => part.type === 'start-step')).toHaveLength(1);
        const second = await chunks(await provider.run(session, 'follow up', signal));
        expect(bodies).toHaveLength(2);
        expect(text(second)).toBe('answer-2');
        const history = JSON.stringify(bodies[1]!.input);
        expect(history).toContain('hello');
        expect(history).toContain('answer-1');
        expect(history).toContain('follow up');
      } finally {
        await provider.deleteSession(session);
        await provider.dispose();
      }
    });
  }
}

test('missing terminal output still executes a Function Tool and stops after its answer', async () => {
  const fixture = await reviewFixture({ 'file.ts': '// TODO: inspect' });
  const bodies: Record<string, unknown>[] = [];
  const provider = agentHarness(
    new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
      if (String(url).endsWith('/models')) return models();
      bodies.push(JSON.parse(init!.body as string));
      const events =
        bodies.length === 1
          ? responseEvents('', [
              {
                id: 'fc_fixture',
                type: 'function_call',
                call_id: 'call_fixture',
                name: 'search_code',
                namespace: 'review',
                arguments: JSON.stringify({ query: 'TODO' }),
                status: 'completed',
              },
            ])
          : responseEvents('Searched');
      const response = sse(missingTerminalOutput(events));
      response.headers.delete('content-type');
      return response;
    }),
    {},
    fixture.context,
  );
  const signal = new AbortController().signal;
  const session = await provider.createSession('fixture-model', signal);
  try {
    const parts = await chunks(await provider.run(session, 'search this', signal));
    expect(bodies).toHaveLength(2);
    expect(parts.filter((part) => part.type === 'tool-input-available')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'tool-output-available')).toHaveLength(1);
    expect(text(parts)).toBe('Searched');
    expect(JSON.stringify(bodies[1]!.input)).toContain('function_call_output');
    expect(JSON.stringify(bodies[1]!.input)).toContain('matches');
    expect(JSON.stringify(bodies[1]!.input)).toContain('file.ts');
  } finally {
    await provider.deleteSession(session);
    await provider.dispose();
  }
});

for (const mode of ['missing', 'unfinished-sibling']) {
  test(`empty terminal output with ${mode} items fails once without committing partial history`, async () => {
    let calls = 0;
    const provider = agentHarness(
      new OpenAIChatGPTProvider(signedInAuth(), async (url) => {
        if (String(url).endsWith('/models')) return models();
        calls++;
        const events = missingTerminalOutput(
          responseEvents('partial').filter((event) => event.type !== 'response.output_item.done'),
        );
        if (mode === 'unfinished-sibling')
          events.splice(-1, 0, {
            type: 'response.output_item.done',
            output_index: 1,
            item: { id: 'rs_fixture', type: 'reasoning', summary: [] },
          });
        return sse(events);
      }),
    );
    const signal = new AbortController().signal;
    const session = await provider.createSession('fixture-model', signal);
    try {
      await expect(chunks(await provider.run(session, 'hello', signal))).rejects.toThrow();
      expect(calls).toBe(1);
      expect(session.history.getMessages()).toEqual([]);
    } finally {
      await provider.deleteSession(session);
      await provider.dispose();
    }
  });
}

test('normalization preserves separate identical messages, output order and fragmented UTF-8/CRLF frames', async () => {
  const events = [
    { type: 'response.output_item.done', output_index: 1, item: outputMessage('second') },
    { type: 'response.output_item.done', output_index: 0, item: outputMessage('first') },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ];
  const raw =
    events
      .map(
        (event, i) => `event: ${event.type}\r\nid: ${i}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
      )
      .join('') + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(raw);
  const source = new ReadableStream<Uint8Array>({
    start(output) {
      for (const byte of bytes) output.enqueue(new Uint8Array([byte]));
      output.close();
    },
  });
  const response = restoreCompletedOutput(
    new Response(source, {
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-fixture' },
    }),
  );
  const output = await response.text();
  const completed = output
    .split('\n')
    .filter((line) => line.startsWith('data: {'))
    .map((line) => JSON.parse(line.slice(6)))
    .at(-1);
  expect(completed.response.output.map((entry: { id: string }) => entry.id)).toEqual([
    'first',
    'second',
  ]);
  expect(
    completed.response.output.map(
      (entry: { content: { text: string }[] }) => entry.content[0]!.text,
    ),
  ).toEqual(['你好', '你好']);
  expect(output).toContain('event: response.completed\nid: 2\n');
  expect(output).toContain('data: [DONE]');
  expect(response.headers.get('x-request-id')).toBe('request-fixture');
});

test('a populated terminal response remains authoritative and failed responses stay failed', async () => {
  for (const type of ['response.completed', 'response.failed', 'response.incomplete']) {
    const event = {
      type,
      response: {
        status: type.slice('response.'.length),
        output: [{ id: 'authoritative', type: 'message' }],
      },
    };
    const response = restoreCompletedOutput(
      sse([
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'streamed', type: 'message' },
        },
        event,
      ]),
    );
    const output = await response.text();
    const last = output
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .at(-1)!;
    expect(JSON.parse(last.slice(6))).toMatchObject(event);
  }
  const denied = Response.json({ error: 'unauthorized' }, { status: 401 });
  expect(restoreCompletedOutput(denied)).toBe(denied);
});

test('an empty terminal output never repairs an unsuccessful status or a provider error', async () => {
  for (const response of [
    { status: 'failed', output: [] },
    { status: 'incomplete', output: [] },
    { output: [], error: { code: 'subscription_sharing_usage_limit_exceeded' } },
    { status: 'completed', output: [], error: { code: 'subscription_sharing_usage_unavailable' } },
  ]) {
    const event = { type: 'response.completed', response };
    const output = await restoreCompletedOutput(
      sse([
        { type: 'response.output_item.done', output_index: 0, item: outputMessage('streamed') },
        event,
      ]),
    ).text();
    const last = output
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .at(-1)!;
    expect(JSON.parse(last.slice(6))).toMatchObject(event);
  }
});

test('cancelling the normalized stream cancels its upstream response body', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(output) {
      output.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = restoreCompletedOutput(
    new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(0);
  expect(cancelled).toBe(true);
});
