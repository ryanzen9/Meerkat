import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessageChunk } from 'ai';
import {
  SESSION_ARCHIVE_DIRECTORY,
  SessionArchive,
  type SessionArchiveOptions,
} from '../src/extension/bridge/sessions/sessionArchive';
import { buildSessionTranscript } from '../src/extension/bridge/sessions/transcript';
import { SESSION_ARCHIVE_VERSION, type SessionMeta } from '../src/shared/sessionArchive';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
});

async function createArchive(options: SessionArchiveOptions = {}): Promise<{
  directory: string;
  archive: SessionArchive;
}> {
  const root = await mkdtemp(join(tmpdir(), 'meerkat-session-'));
  const directory = join(root, SESSION_ARCHIVE_DIRECTORY);
  directories.push(root);
  const archive = new SessionArchive(directory, options);
  await archive.initialize();
  return { directory, archive };
}

function meta(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  const now = new Date().toISOString();
  return {
    version: SESSION_ARCHIVE_VERSION,
    id,
    providerId: 'fixture',
    model: 'fixture-model',
    accountId: 'account-1',
    title: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const startRun = (runId: string) =>
  [
    { type: 'start', messageId: `assistant-${runId}` },
    { type: 'text-start', id: `text-${runId}` },
    { type: 'text-delta', id: `text-${runId}`, delta: 'Hello' },
    { type: 'text-end', id: `text-${runId}` },
    {
      type: 'tool-input-available',
      toolCallId: `call-${runId}`,
      toolName: 'read_file',
      input: { path: 'a.ts' },
    },
    {
      type: 'tool-output-available',
      toolCallId: `call-${runId}`,
      output: { content: 'export const a = 1;' },
    },
    { type: 'finish' },
  ] as unknown as UIMessageChunk[];

test('session metadata, model checkpoint and UI journal round-trip into a transcript', async () => {
  const { archive } = await createArchive();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await archive.writeMeta(meta(sessionId));
  await archive.writeHistory({
    version: SESSION_ARCHIVE_VERSION,
    sessionId,
    messages: [
      { role: 'user', content: 'Explain a.ts' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    ],
    checkpoint: { runId, steps: 1, at: new Date().toISOString() },
  });
  const journal = archive.journal({
    sessionId,
    runId,
    text: 'Explain a.ts',
    mode: 'chat',
  });
  for (const chunk of startRun(runId)) journal.append(chunk);
  // Transient data parts never enter the archive.
  journal.append({ type: 'data-run-state', transient: true, data: { status: 'running' } });
  journal.checkpoint(2);
  await journal.finish('completed');

  const stored = await archive.readMeta(sessionId);
  expect(stored).toMatchObject({ title: 'Explain a.ts', lastTurnStatus: 'completed' });
  expect(await archive.readHistory(sessionId)).toMatchObject({
    checkpoint: { runId, steps: 1 },
    messages: [{ role: 'user' }, { role: 'assistant' }],
  });
  const turns = await archive.listTurns(sessionId);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ status: 'completed', checkpoints: 2, mode: 'chat' });
  const persisted = await archive.readTurnChunks(sessionId, runId);
  expect(persisted).toHaveLength(startRun(runId).length);

  const transcript = await buildSessionTranscript(archive, sessionId);
  expect(transcript?.turns[0]).toMatchObject({ status: 'completed', checkpoints: 2 });
  expect(transcript?.truncated).toBe(false);
  expect(transcript?.messages[0]).toMatchObject({
    id: `user-${runId}`,
    role: 'user',
    parts: [{ type: 'text', text: 'Explain a.ts' }],
  });
  expect(transcript?.messages[1]).toMatchObject({ id: `assistant-${runId}`, role: 'assistant' });
  const parts = transcript?.messages[1]?.parts as { type: string; text?: string }[];
  expect(parts.find((part) => part.type === 'text')).toMatchObject({ text: 'Hello' });
  expect(parts.find((part) => part.type === 'tool-read_file')).toMatchObject({
    state: 'output-available',
    output: { content: 'export const a = 1;' },
  });
});

test('a fresh archive marks turns left running by a previous host as interrupted', async () => {
  const { directory, archive } = await createArchive();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await archive.writeMeta(meta(sessionId));
  const journal = archive.journal({ sessionId, runId, text: 'Half a question', mode: 'chat' });
  journal.append({ type: 'start', messageId: `assistant-${runId}` });
  journal.append({ type: 'text-start', id: 'text-1' });
  journal.append({ type: 'text-delta', id: 'text-1', delta: 'Partial answer' });
  await journal.flush();

  const restarted = new SessionArchive(directory);
  await restarted.recover();
  const recovered = await restarted.readMeta(sessionId);
  expect(recovered?.lastTurnStatus).toBe('interrupted');
  const [turn] = await restarted.listTurns(sessionId);
  expect(turn).toMatchObject({
    runId,
    status: 'interrupted',
    error: { code: 'host_restart' },
  });
  expect(turn?.endedAt).toBeString();

  const transcript = await buildSessionTranscript(restarted, sessionId);
  expect(transcript?.turns[0]?.status).toBe('interrupted');
  const parts = transcript?.messages[1]?.parts as { type: string; text?: string }[];
  expect(parts.find((part) => part.type === 'text')).toMatchObject({ text: 'Partial answer' });
  // The abandoned in-process journal must remain hidden from the recovered view.
  await journal.finish('cancelled');
});

test('retention prunes old turn transcripts but keeps metadata and history', async () => {
  const { directory, archive } = await createArchive({ maxTurnsPerSession: 2, maxSessions: 1 });
  const kept = crypto.randomUUID();
  const dropped = crypto.randomUUID();
  await archive.writeMeta(meta(dropped, { updatedAt: '2026-01-01T00:00:00.000Z' }));
  await archive.writeMeta(meta(kept, { updatedAt: '2026-01-02T00:00:00.000Z' }));
  for (const sessionId of [dropped, kept]) {
    for (let index = 0; index < 3; index++) {
      const runId = crypto.randomUUID();
      const journal = archive.journal({
        sessionId,
        runId,
        text: `turn ${index}`,
        mode: 'chat',
      });
      journal.append({ type: 'start', messageId: `assistant-${runId}` });
      await Bun.sleep(2);
      await journal.finish('completed');
    }
  }
  await archive.writeHistory({
    version: SESSION_ARCHIVE_VERSION,
    sessionId: dropped,
    messages: [{ role: 'user', content: 'kept history' }],
    checkpoint: { runId: crypto.randomUUID(), steps: 1, at: new Date().toISOString() },
  });

  const restarted = new SessionArchive(directory, { maxTurnsPerSession: 2, maxSessions: 1 });
  await restarted.recover();
  expect(await restarted.listTurns(kept)).toHaveLength(2);
  expect(await restarted.readMeta(dropped)).toBeDefined();
  expect((await readdir(join(directory, dropped))).includes('turns')).toBe(false);
  expect((await restarted.readHistory(dropped))?.messages).toEqual([
    { role: 'user', content: 'kept history' },
  ]);
});

test('corrupt metadata and turn files are ignored without breaking the archive', async () => {
  const { directory, archive } = await createArchive();
  const valid = crypto.randomUUID();
  const corrupt = crypto.randomUUID();
  await archive.writeMeta(meta(valid));
  await archive.writeMeta(meta(corrupt));
  const runId = crypto.randomUUID();
  const journal = archive.journal({ sessionId: valid, runId, text: 'hello', mode: 'chat' });
  journal.append({ type: 'start', messageId: `assistant-${runId}` });
  journal.append({ type: 'text-start', id: 'text-1' });
  journal.append({ type: 'text-delta', id: 'text-1', delta: 'ok' });
  await journal.finish('completed');

  await writeFile(join(directory, corrupt, 'meta.json'), '{not json');
  await writeFile(join(directory, valid, 'turns', `${runId}.json`), '{not json');
  const restarted = new SessionArchive(directory);
  await restarted.recover();
  expect((await restarted.listMeta()).map((entry) => entry.id)).toEqual([valid]);
  expect(await restarted.listTurns(valid)).toEqual([]);
  const transcript = await buildSessionTranscript(restarted, valid);
  expect(transcript?.turns).toEqual([]);
  expect(transcript?.truncated).toBe(true);
});

test('deleting a session removes its archive even with a live turn journal', async () => {
  const { directory, archive } = await createArchive();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await archive.writeMeta(meta(sessionId));
  const journal = archive.journal({ sessionId, runId, text: 'delete me', mode: 'chat' });
  journal.append({ type: 'start', messageId: `assistant-${runId}` });
  await journal.flush();
  await archive.deleteSession(sessionId);
  await journal.finish('cancelled');
  await expect(stat(join(directory, sessionId))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await archive.readMeta(sessionId)).toBeUndefined();
});

test('turn chunk files tolerate a partial tail line from a crash', async () => {
  const { directory, archive } = await createArchive();
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await archive.writeMeta(meta(sessionId));
  const journal = archive.journal({ sessionId, runId, text: 'crash', mode: 'chat' });
  journal.append({ type: 'start', messageId: `assistant-${runId}` });
  journal.append({ type: 'text-start', id: 'text-1' });
  journal.append({ type: 'text-delta', id: 'text-1', delta: 'before crash' });
  await journal.finish('completed');
  const path = join(directory, sessionId, 'turns', `${runId}.jsonl`);
  await writeFile(path, `${await readFile(path, 'utf8')}{"type":"text-de`, 'utf8');
  expect(await archive.readTurnChunks(sessionId, runId)).toHaveLength(3);
  const restarted = new SessionArchive(directory);
  await restarted.recover();
  const transcript = await buildSessionTranscript(restarted, sessionId);
  const parts = transcript?.messages[1]?.parts as { type: string; text?: string }[];
  expect(parts.find((part) => part.type === 'text')).toMatchObject({ text: 'before crash' });
});
