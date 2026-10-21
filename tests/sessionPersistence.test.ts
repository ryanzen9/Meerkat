import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai';
import { OpenAIChatGPTProvider } from '../src/extension/bridge/providers/openai/provider';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { createBridgeApi } from '../src/extension/bridge/server/api';
import {
  SESSION_ARCHIVE_DIRECTORY,
  SessionArchive,
} from '../src/extension/bridge/sessions/sessionArchive';
import { SessionStore } from '../src/extension/bridge/sessions/store';
import { sessionTranscriptSchema } from '../src/shared/sessionArchive';
import { responseEvents, signedInAuth, sse } from './bridgeFixture';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

type Script = (call: number, body: string) => Response;

interface Host {
  root: string;
  archive: SessionArchive;
  registry: ProviderRegistry;
  runtime: BridgeRuntime;
  requests: string[];
}

interface HostOptions {
  catalog?: unknown;
}

const defaultCatalog = {
  models: [{ slug: 'fixture-model', display_name: 'Fixture', visibility: 'list' }],
};

async function hostFixture(
  script: Script,
  root?: string,
  options: HostOptions = {},
): Promise<Host> {
  const directory = root ?? (await mkdtemp(join(tmpdir(), 'meerkat-session-host-')));
  if (!root) roots.push(directory);
  const archive = new SessionArchive(join(directory, SESSION_ARCHIVE_DIRECTORY));
  await archive.initialize();
  const requests: string[] = [];
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register(
    () =>
      new OpenAIChatGPTProvider(signedInAuth(), async (url, init) => {
        if (String(url).endsWith('/models'))
          return Response.json(options.catalog ?? defaultCatalog);
        const body = String(init?.body ?? '');
        requests.push(body);
        return script(calls++, body);
      }),
  );
  await registry.initialize();
  const runtime = new BridgeRuntime(registry, {}, undefined, undefined, undefined, archive);
  return { root: directory, archive, registry, runtime, requests };
}

async function newSession(host: Host) {
  const provider = host.registry.list()[0]!;
  return host.runtime.sessions.create(
    provider.id,
    await host.registry
      .get(provider.id)
      .createSession('fixture-model', new AbortController().signal),
  );
}

const consume = (run: { stream: ReadableStream<UIMessageChunk> }) =>
  createUIMessageStreamResponse({ stream: run.stream }).text();

const answerTwo: Script = () => sse(responseEvents('Answer two'));

function apiRequest(path: string, method = 'GET') {
  return new Request(`http://bridge${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

const toolCall = () =>
  sse(
    responseEvents('', [
      {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_review_context',
        namespace: 'review',
        arguments: '{}',
        status: 'completed',
      },
    ]),
  );

const firstTurnScript: Script = (call) =>
  call === 0 ? toolCall() : sse(responseEvents(call === 1 ? 'Answer one' : 'Answer two'));
const reasoningTurnScript: Script = (call) =>
  sse(responseEvents(call === 0 ? 'Answer one' : 'Answer two'));

test('archived sessions keep model reasoning capabilities across a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meerkat-session-caps-'));
  roots.push(directory);
  const archiveDirectory = join(directory, SESSION_ARCHIVE_DIRECTORY);
  const archive = new SessionArchive(archiveDirectory);
  await archive.initialize();
  const store = new SessionStore(undefined, archive);
  const session = store.create('openai-agents', {
    model: 'fixture-model',
    accountId: 'account-a',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'high', description: 'Thorough' },
    ],
    defaultReasoningEffort: 'low',
  });
  await archive.flush();

  const restarted = new SessionStore(undefined, new SessionArchive(archiveDirectory));
  const restored = await restarted.ensure(session.id);
  expect(restored.provider).toEqual({
    model: 'fixture-model',
    accountId: 'account-a',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'high', description: 'Thorough' },
    ],
    defaultReasoningEffort: 'low',
  });
});

test('a restarted conversation accepts its reasoning effort for the next turn', async () => {
  const catalog = {
    models: [
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
    ],
  };
  const first = await hostFixture(reasoningTurnScript, undefined, { catalog });
  const hosts: Host[] = [first];
  try {
    const session = await newSession(first);
    const run = first.runtime.start(
      session.id,
      'Reasoned question',
      new AbortController().signal,
      'high',
    );
    await consume(run);
    expect(JSON.parse(first.requests.at(-1)!).reasoning).toMatchObject({ effort: 'high' });

    const second = await hostFixture(reasoningTurnScript, first.root, { catalog });
    hosts.push(second);
    await second.archive.recover();
    const restored = await second.runtime.ensureSession(session.id);
    expect(restored.provider).toMatchObject({
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'high', description: 'Thorough' },
      ],
      defaultReasoningEffort: 'low',
    });
    const follow = second.runtime.start(session.id, '继续', new AbortController().signal, 'high');
    const followOutput = await consume(follow);
    expect(followOutput).toContain('Answer one');
    const followBody = second.requests.at(-1)!;
    expect(followBody).toContain('Reasoned question');
    expect(followBody).toContain('继续');
    expect(JSON.parse(followBody).reasoning).toMatchObject({ effort: 'high' });
  } finally {
    for (const host of hosts) await host.runtime.dispose().catch(() => undefined);
  }
});

async function waitForTurn(archive: SessionArchive, sessionId: string, runId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const turn = (await archive.listTurns(sessionId)).find((item) => item.runId === runId);
    if (turn && turn.status !== 'running') return turn;
    await Bun.sleep(10);
  }
  throw new Error(`Turn ${runId} did not settle`);
}

test('completed turns, tool checkpoints and context survive a host restart', async () => {
  const first = await hostFixture(firstTurnScript);
  const hosts: Host[] = [first];
  try {
    const session = await newSession(first);
    const run = first.runtime.start(session.id, 'First question', new AbortController().signal);
    const output = await consume(run);
    expect(output).toContain('Answer one');
    expect(first.runtime.status(run.runId).status).toBe('completed');

    const [turn] = await first.archive.listTurns(session.id);
    expect(turn).toMatchObject({ status: 'completed', mode: 'chat' });
    expect(turn?.checkpoints).toBeGreaterThanOrEqual(2);
    const history = await first.archive.readHistory(session.id);
    expect(history?.messages[0]).toMatchObject({ role: 'user' });
    expect(history?.messages.some((message) => (message as { role: string }).role === 'tool')).toBe(
      true,
    );
    const transcript = await first.runtime.transcript(session.id);
    expect(transcript.turns[0]).toMatchObject({ status: 'completed', text: 'First question' });
    expect(transcript.messages).toHaveLength(2);
    const parts = transcript.messages[1]!.parts as { type: string; text?: string }[];
    expect(parts.find((part) => part.type === 'text')).toMatchObject({ text: 'Answer one' });
    expect(parts.find((part) => part.type === 'tool-get_review_context')).toMatchObject({
      state: 'output-available',
    });

    // A new Host process over the same storage directory recovers the session.
    const second = await hostFixture(answerTwo, first.root);
    hosts.push(second);
    await second.archive.recover();
    expect(
      (await second.runtime.listSessions()).find((item) => item.id === session.id),
    ).toMatchObject({
      live: false,
      archived: true,
      title: 'First question',
      lastTurnStatus: 'completed',
    });
    const restored = await second.runtime.ensureSession(session.id);
    expect(restored.provider).toMatchObject({ model: 'fixture-model', accountId: 'account-1' });
    expect(
      (await second.runtime.listSessions()).find((item) => item.id === session.id),
    ).toMatchObject({ live: true, archived: false });
    const replay = await second.runtime.transcript(session.id);
    expect(replay.messages).toHaveLength(2);
    expect(replay.turns[0]).toMatchObject({ status: 'completed' });

    const followUp = second.runtime.start(session.id, 'Follow up', new AbortController().signal);
    const followOutput = await consume(followUp);
    expect(followOutput).toContain('Answer two');
    const lastBody = second.requests.at(-1)!;
    expect(lastBody).toContain('First question');
    expect(lastBody).toContain('Answer one');
    await waitForTurn(second.archive, session.id, followUp.runId);
    expect(await second.archive.listTurns(session.id)).toHaveLength(2);
  } finally {
    for (const host of hosts) await host.runtime.dispose().catch(() => undefined);
  }
});

test('a released model session rehydrates from the archive for transcript and follow-up', async () => {
  const host = await hostFixture(() => sse(responseEvents('released answer')));
  try {
    const session = await newSession(host);
    const run = host.runtime.start(session.id, 'First', new AbortController().signal);
    expect(await consume(run)).toContain('released answer');
    await waitForTurn(host.archive, session.id, run.runId);
    await host.runtime.releaseSession(session.id);
    expect(host.runtime.sessions.list()).toHaveLength(0);
    expect((await host.runtime.transcript(session.id)).messages).toHaveLength(2);
    await host.runtime.ensureSession(session.id);
    const follow = host.runtime.start(session.id, 'Again', new AbortController().signal);
    expect(await consume(follow)).toContain('released answer');
  } finally {
    await host.runtime.dispose();
  }
});

test('cancelling keeps the visible partial answer and transcript trace', async () => {
  const host = await hostFixture(() => sse(responseEvents('partial answer')));
  try {
    const session = await newSession(host);
    const run = host.runtime.start(session.id, 'Explain', new AbortController().signal);
    const reader = run.stream.getReader();
    let sawDelta = false;
    for (let index = 0; index < 100 && !sawDelta; index++) {
      const next = await reader.read();
      if (next.done) break;
      sawDelta = (next.value as { type?: string }).type === 'text-delta';
    }
    expect(sawDelta).toBe(true);
    host.runtime.cancel(run.runId);
    while (!(await reader.read()).done) {
      // Drain the cancelled stream.
    }
    const turn = await waitForTurn(host.archive, session.id, run.runId);
    expect(turn).toMatchObject({ status: 'cancelled' });
    // No step completed, but the interrupted user turn is still durable so a
    // continuation keeps the request in model context. Partial assistant
    // output remains display-only.
    expect(await host.archive.readHistory(session.id)).toMatchObject({
      checkpoint: { steps: 0 },
      messages: [{ role: 'user', content: 'Explain' }],
    });
    expect(host.runtime.sessions.get(session.id).history.getMessages()).toEqual([
      { role: 'user', content: 'Explain' },
    ]);
    const transcript = await host.runtime.transcript(session.id);
    expect(transcript.turns[0]).toMatchObject({ status: 'cancelled', text: 'Explain' });
    const parts = transcript.messages[1]!.parts as { type: string; text?: string }[];
    expect(parts.find((part) => part.type === 'text')).toMatchObject({ text: 'partial answer' });
  } finally {
    await host.runtime.dispose();
  }
});

test('a host replacement marks a live turn interrupted and preserves its partial output', async () => {
  const host = await hostFixture(() => sse(responseEvents('before restart')));
  const hosts: Host[] = [host];
  let runId = '';
  try {
    const session = await newSession(host);
    const run = host.runtime.start(session.id, 'Interrupted', new AbortController().signal);
    runId = run.runId;
    const reader = run.stream.getReader();
    let sawDelta = false;
    for (let index = 0; index < 100 && !sawDelta; index++) {
      const next = await reader.read();
      if (next.done) break;
      sawDelta = (next.value as { type?: string }).type === 'text-delta';
    }
    expect(sawDelta).toBe(true);
    await host.archive.flush();

    const restarted = await hostFixture(() => sse(responseEvents('unused')), host.root);
    hosts.push(restarted);
    await restarted.archive.recover();
    const [turn] = await restarted.archive.listTurns(session.id);
    expect(turn).toMatchObject({
      runId: run.runId,
      status: 'interrupted',
      error: { code: 'host_restart' },
    });
    const transcript = await restarted.runtime.transcript(session.id);
    expect(transcript.turns[0]).toMatchObject({ status: 'interrupted' });
    const parts = transcript.messages[1]!.parts as { type: string; text?: string }[];
    expect(parts.find((part) => part.type === 'text')).toMatchObject({ text: 'before restart' });

    // A continuation sees the original request (and any model step that had
    // already completed before the Host stopped).
    const restored = await restarted.runtime.ensureSession(session.id);
    const restoredMessages = restored.history.getMessages();
    expect(restoredMessages[0]).toEqual({ role: 'user', content: 'Interrupted' });
    expect(JSON.stringify(restoredMessages)).toContain('before restart');
    const follow = restarted.runtime.start(session.id, '继续', new AbortController().signal);
    expect(await consume(follow)).toContain('unused');
    expect(restarted.requests.at(-1)).toContain('Interrupted');
    expect(restarted.requests.at(-1)).toContain('继续');
  } finally {
    host.runtime.cancel(runId);
    for (const item of hosts) await item.runtime.dispose().catch(() => undefined);
  }
});

test('a corrupt archived history is viewable but read-only', async () => {
  const host = await hostFixture(() => sse(responseEvents('answer')));
  const hosts: Host[] = [host];
  try {
    const session = await newSession(host);
    const run = host.runtime.start(session.id, 'Question', new AbortController().signal);
    await consume(run);
    await waitForTurn(host.archive, session.id, run.runId);
    await writeFile(
      join(host.root, SESSION_ARCHIVE_DIRECTORY, session.id, 'history.json'),
      '{corrupt',
      'utf8',
    );

    const restarted = await hostFixture(() => sse(responseEvents('unused')), host.root);
    hosts.push(restarted);
    await restarted.archive.recover();
    const restored = await restarted.runtime.ensureSession(session.id);
    expect(restored.readOnly).toBe(true);
    expect(() =>
      restarted.runtime.start(session.id, 'new turn', new AbortController().signal),
    ).toThrow('only be viewed');
    const transcript = await restarted.runtime.transcript(session.id);
    expect(transcript.messages).toHaveLength(2);
  } finally {
    for (const item of hosts) await item.runtime.dispose().catch(() => undefined);
  }
});

test('the bridge API lists, rehydrates and replays archived sessions after restart', async () => {
  const host = await hostFixture(() => sse(responseEvents('archived answer')));
  const hosts: Host[] = [host];
  try {
    const session = await newSession(host);
    const run = host.runtime.start(session.id, 'Archived question', new AbortController().signal);
    await consume(run);
    await waitForTurn(host.archive, session.id, run.runId);

    const restarted = await hostFixture(() => sse(responseEvents('follow up answer')), host.root);
    hosts.push(restarted);
    await restarted.archive.recover();
    const api = createBridgeApi({
      runtime: restarted.runtime,
      callbackUri: () => 'http://127.0.0.1:1/auth/callback',
      openBrowser: async () => undefined,
    });
    const list = (await (await api(apiRequest('/v1/sessions'))).json()) as unknown[];
    expect(list).toContainEqual(
      expect.objectContaining({ id: session.id, archived: true, live: false }),
    );
    const metadata = await api(apiRequest(`/v1/sessions/${session.id}`));
    expect(metadata.status).toBe(200);
    expect((await metadata.json()) as { model: string }).toMatchObject({ model: 'fixture-model' });

    const transcriptResponse = await api(apiRequest(`/v1/sessions/${session.id}/transcript`));
    expect(transcriptResponse.status).toBe(200);
    const transcript = sessionTranscriptSchema.parse(await transcriptResponse.json());
    expect(transcript.messages).toHaveLength(2);
    expect(transcript.turns[0]).toMatchObject({ status: 'completed' });

    const follow = await api(
      new Request(`http://bridge/v1/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Continue archived' }),
      }),
    );
    expect(follow.status).toBe(200);
    expect(await follow.text()).toContain('follow up answer');
    const remove = await api(
      new Request(`http://bridge/v1/sessions/${session.id}`, { method: 'DELETE' }),
    );
    expect(remove.status).toBe(204);
    const gone = await api(apiRequest(`/v1/sessions/${session.id}/transcript`));
    expect(gone.status).toBe(404);
  } finally {
    for (const item of hosts) await item.runtime.dispose().catch(() => undefined);
  }
});
