import { expect, test } from 'bun:test';
import { ReviewArchive, type ReviewStorage } from '../src/extension/bridge/sessions/reviewArchive';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import { createBridgeApi } from '../src/extension/bridge/server/api';
import type { ReviewFindingChange, ReviewSnapshotState } from '../src/shared/review';
import { isExtensionMessage } from '../src/shared/protocol';
import { reviewFixture } from './reviewFixture';

const request = (path: string, method = 'GET', body?: unknown) =>
  new Request(`http://bridge${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function storageFixture() {
  const saved = new Map<string, ReviewSnapshotState>();
  const storage: ReviewStorage = {
    read: (id) => structuredClone(saved.get(id)),
    write: async (id, state) => {
      if (state) saved.set(id, structuredClone(state));
      else saved.delete(id);
    },
  };
  return { saved, storage };
}

async function findingFixture(archive: ReviewArchive, id = crypto.randomUUID()) {
  const fixture = await reviewFixture();
  await fixture.write('file.ts', 'one\nunchecked\nthree\n');
  const journal = archive.create(id);
  const run = journal.start(crypto.randomUUID(), id, 'Review', fixture.context);
  const snapshot = await run.track('list_changes', () =>
    fixture.context.listChanges({ scope: 'all' }),
  );
  const { references } = await fixture.context.citeFiles({
    reviewId: snapshot.reviewId,
    references: [{ path: 'file.ts', version: 'new', startLine: 2, endLine: 2 }],
  });
  const input = {
    reviewId: snapshot.reviewId,
    title: 'Unchecked value',
    priority: 'P1' as const,
    description: 'The inserted value is not validated.',
    referenceIds: [references[0]!.referenceId],
  };
  return { id, run, journal, input };
}

test('a receipt is acknowledged only after durable storage and failed writes can be retried', async () => {
  const { storage, saved } = storageFixture();
  const write = storage.write;
  let release!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  storage.write = async (id, state) => {
    arrived();
    await gate;
    await write(id, state);
  };
  const f = await findingFixture(new ReviewArchive(storage));
  let acknowledged = false;
  const submission = f.run.submit(f.input, 'original').then((result) => {
    acknowledged = true;
    return result;
  });
  await started;
  expect(acknowledged).toBe(false);
  expect(saved.has(f.id)).toBe(false);
  release();
  const result = await submission;
  expect(saved.get(f.id)!.findings).toEqual([result.finding]);
  expect(result.finding.status).toBe('unresolved');

  storage.write = async () => {
    throw new Error('Disk unavailable');
  };
  await expect(f.journal.setFindingStatus(result.finding.id, 'resolved')).rejects.toMatchObject({
    code: 'review_save_failed',
  });
  expect(f.journal.snapshot().findings[0]!.status).toBe('unresolved');
  expect(saved.get(f.id)!.findings[0]!.status).toBe('unresolved');
  storage.write = write;
  const resolved = await f.journal.setFindingStatus(result.finding.id, 'resolved');
  expect(resolved).toMatchObject({ status: 'resolved', statusRevision: 1 });
  expect(saved.get(f.id)!.findings[0]).toEqual(resolved);
  expect(await f.run.submit(f.input, 'duplicate')).toMatchObject({
    duplicate: true,
    finding: resolved,
  });

  let failWrite!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    failWrite = resolve;
  });
  let writing!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    writing = resolve;
  });
  let failNext = true;
  storage.write = async (id, state) => {
    if (failNext) {
      failNext = false;
      writing();
      await failureGate;
      throw new Error('Temporary write failure');
    }
    await write(id, state);
  };
  const failedStatus = f.journal
    .setFindingStatus(result.finding.id, 'unresolved')
    .catch((error: unknown) => error);
  await writeStarted;
  const checkpoint = f.journal.save();
  failWrite();
  expect(await failedStatus).toMatchObject({ code: 'review_save_failed' });
  await checkpoint;
  expect(saved.get(f.id)!.findings[0]).toMatchObject({ status: 'resolved', statusRevision: 1 });
  storage.write = write;

  const other = await findingFixture(new ReviewArchive(storage));
  storage.write = async () => {
    throw new Error('Disk unavailable');
  };
  await expect(other.run.submit(other.input, 'failed')).rejects.toMatchObject({
    code: 'review_save_failed',
  });
  expect(other.journal.snapshot().findings).toHaveLength(0);
  expect(other.run.state.issueCount).toBe(0);
  storage.write = write;
  expect((await other.run.submit(other.input, 'retry')).duplicate).toBe(false);
  expect(saved.get(other.id)!.findings).toHaveLength(1);
});

test('archived reviews survive Host replacement, isolate sessions, update status and delete durably', async () => {
  const { storage, saved } = storageFixture();
  const f = await findingFixture(new ReviewArchive(storage));
  const receipt = await f.run.submit(f.input, 'saved');
  f.run.finish({ status: 'incomplete', unfinishedItems: ['More context'], limitations: [] });
  f.run.settle('completed');
  await f.journal.save();
  const runtime = new BridgeRuntime(new ProviderRegistry(), {}, undefined, storage);
  const changes: ReviewFindingChange[] = [];
  const api = createBridgeApi({
    runtime,
    callbackUri: () => '',
    openBrowser: async () => {},
    onFindingChanged: (change) => changes.push(change),
  });

  const base = `/v1/sessions/${f.id}`;
  const endpoint = `${base}/reviews/${receipt.finding.id}`;
  try {
    expect((await api(request(base))).status).toBe(404);
    const recovered = await (await api(request(`${base}/reviews`))).json();
    expect(recovered.runs[0]).toMatchObject({ status: 'incomplete', issueCount: 1 });
    expect(recovered.findings[0].id).toBe(receipt.finding.id);
    const resolved = await api(request(endpoint, 'POST', { status: 'resolved' }));
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ status: 'resolved', statusRevision: 1 });
    const notification = { type: 'host/review-finding-changed', ...changes[0]! };
    expect(isExtensionMessage(notification)).toBe(true);
    for (const invalid of [
      { ...notification, sessionId: '../other' },
      { ...notification, finding: { ...notification.finding, status: 'completed' } },
      { ...notification, finding: null },
      { ...notification, requestId: 'unrelated-request' },
    ])
      expect(isExtensionMessage(invalid)).toBe(false);
    expect(isExtensionMessage({ type: 'host/review-refresh' })).toBe(true);
    expect(
      isExtensionMessage({ type: 'host/review-refresh', requestId: 'unrelated-request' }),
    ).toBe(false);
    const duplicate = await api(request(endpoint, 'POST', { status: 'resolved' }));
    expect(await duplicate.json()).toMatchObject({ statusRevision: 1 });
    expect(new ReviewArchive(storage).get(f.id).snapshot().findings[0]!.status).toBe('resolved');
    const write = storage.write;
    const notificationsBefore = changes.length;
    storage.write = async () => {
      throw new Error('Persistence unavailable');
    };
    expect((await api(request(endpoint, 'POST', { status: 'unresolved' }))).status).toBe(503);
    expect(changes).toHaveLength(notificationsBefore);
    storage.write = write;
    expect((await api(request(endpoint, 'POST', { status: 'invalid' }))).status).toBe(400);
    expect(
      (await api(request(endpoint, 'POST', { status: 'resolved', finding: receipt.finding })))
        .status,
    ).toBe(400);
    expect(
      (
        await api(
          request(`/v1/sessions/${crypto.randomUUID()}/reviews/${receipt.finding.id}`, 'POST', {
            status: 'resolved',
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(request(`${base}/reviews/${'f'.repeat(64)}`, 'POST', { status: 'resolved' })))
        .status,
    ).toBe(404);
    await Promise.all([
      api(request(endpoint, 'POST', { status: 'unresolved' })),
      api(request(endpoint, 'POST', { status: 'resolved' })),
    ]);
    expect(saved.get(f.id)!.findings[0]).toMatchObject({ status: 'resolved', statusRevision: 3 });
    expect(saved.get(f.id)!.runs[0]!.issueCount).toBe(1);
    const staleJournal = runtime.sessions.reviews.get(f.id);
    expect((await api(request(base, 'DELETE'))).status).toBe(204);
    await expect(
      staleJournal.setFindingStatus(receipt.finding.id, 'unresolved'),
    ).rejects.toMatchObject({ code: 'review_not_found' });
    expect(saved.has(f.id)).toBe(false);
    expect((await api(request(`${base}/reviews`))).status).toBe(404);
  } finally {
    await runtime.dispose();
  }
});

test('an interrupted archived run remains incomplete while cancellation and failure retain saved findings', async () => {
  const { storage, saved } = storageFixture();
  const f = await findingFixture(new ReviewArchive(storage));
  const receipt = await f.run.submit(f.input, 'saved');
  delete saved.get(f.id)!.findings[0]!.status;
  delete saved.get(f.id)!.findings[0]!.statusRevision;
  const recovered = new ReviewArchive(storage).get(f.id).snapshot();
  expect(recovered.runs[0]).toMatchObject({ status: 'incomplete', issueCount: 1 });
  expect(recovered.findings).toEqual([receipt.finding]);
  for (const outcome of ['cancelled', 'failed'] as const) {
    f.run.settle(outcome);
    await f.journal.save();
    expect(new ReviewArchive(storage).get(f.id).snapshot().runs[0]!.status).toBe(outcome);
    expect(new ReviewArchive(storage).get(f.id).snapshot().findings).toHaveLength(1);
  }
});

test('normal Host shutdown preserves the final journal instead of deleting its conversation archive', async () => {
  const { storage } = storageFixture();
  const runtime = new BridgeRuntime(new ProviderRegistry(), {}, undefined, storage);
  const session = runtime.sessions.create('fixture', { model: 'fixture', accountId: 'account' });
  const run = session.reviews.start(crypto.randomUUID(), session.id, 'Review');
  run.finish({ status: 'incomplete', unfinishedItems: ['More context'], limitations: [] });
  run.settle('completed');
  await session.reviews.save();
  run.settle('cancelled');
  await runtime.dispose();
  const archived = new ReviewArchive(storage).get(session.id).snapshot();
  expect(archived.runs[0]).toMatchObject({ status: 'cancelled', issueCount: 0 });
});

test('editor archiving is durable, reversible and independent of resolution, receipts and counts', async () => {
  const { storage, saved } = storageFixture();
  const f = await findingFixture(new ReviewArchive(storage));
  const receipt = await f.run.submit(f.input, 'saved');
  const runtime = new BridgeRuntime(new ProviderRegistry(), {}, undefined, storage);
  const changes: ReviewFindingChange[] = [];
  const api = createBridgeApi({
    runtime,
    callbackUri: () => '',
    openBrowser: async () => {},
    onFindingChanged: (change) => changes.push(change),
  });
  const endpoint = `/v1/sessions/${f.id}/reviews/${receipt.finding.id}`;
  try {
    const archived = await api(request(endpoint, 'POST', { editorArchived: true }));
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({
      editorArchived: true,
      status: 'unresolved',
      statusRevision: 1,
    });
    const recovered = new ReviewArchive(storage).get(f.id);
    expect(recovered.snapshot().findings[0]).toMatchObject({
      ...receipt.finding,
      editorArchived: true,
      statusRevision: 1,
    });
    expect(recovered.snapshot().runs[0]!.issueCount).toBe(1);
    expect(changes[0]!.finding.editorArchived).toBe(true);
    expect(
      await (await api(request(endpoint, 'POST', { editorArchived: true }))).json(),
    ).toMatchObject({ statusRevision: 1 });
    await Promise.all([
      api(request(endpoint, 'POST', { status: 'resolved' })),
      api(request(endpoint, 'POST', { editorArchived: false })),
    ]);
    expect(saved.get(f.id)!.findings[0]).toMatchObject({
      editorArchived: false,
      status: 'resolved',
      statusRevision: 3,
    });
    for (const invalid of [
      {},
      { editorArchived: 'true' },
      { editorArchived: true, finding: receipt.finding },
      { status: 'archived' },
    ])
      expect((await api(request(endpoint, 'POST', invalid))).status).toBe(400);
    const notifyCount = changes.length;
    const write = storage.write;
    storage.write = async () => {
      throw new Error('Disk unavailable');
    };
    expect((await api(request(endpoint, 'POST', { editorArchived: true }))).status).toBe(503);
    expect(changes).toHaveLength(notifyCount);
    expect(runtime.sessions.reviews.get(f.id).snapshot().findings[0]!.editorArchived).toBe(false);
    expect(saved.get(f.id)!.findings[0]!.editorArchived).toBe(false);
    storage.write = write;
    expect((await api(request(endpoint, 'POST', { editorArchived: true }))).status).toBe(200);
    expect(saved.get(f.id)!.findings[0]).toMatchObject({
      editorArchived: true,
      status: 'resolved',
      statusRevision: 4,
    });
  } finally {
    await runtime.dispose();
  }
});
