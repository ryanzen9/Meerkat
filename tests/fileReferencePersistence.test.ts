import { expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FileReferenceArchive,
  type ReferenceDocument,
  type SessionFileReferences,
} from '../src/extension/bridge/sessions/fileReferenceArchive';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import type { ReviewStorage } from '../src/extension/bridge/sessions/reviewArchive';
import type { ReviewSnapshotState } from '../src/shared/review';
import { reviewFixture } from './reviewFixture';

const region = { path: 'file.ts', version: 'new' as const, startLine: 2, endLine: 3 };
const wholeFile = { path: 'file.ts', version: 'new' as const, scope: 'file' as const };

test('conversation references preserve exact old, unsaved, deleted and whole-file source across Host replacement', async () => {
  const original = 'one\r\ntwo\r\nthree\r\n';
  const unsaved = 'one\r\nunsaved\r\nthree\r\n' + 'x'.repeat(25000) + '\r\n';
  const f = await reviewFixture({
    'file.ts': original,
    'deleted.ts': 'deleted source\n',
    '目录/[empty].ts': '',
  });
  f.state.dirtyDocuments.push({ path: join(f.root, 'file.ts'), text: unsaved });
  await rm(join(f.root, 'deleted.ts'));
  const directory = join(f.root, '.git', 'saved-references');
  const id = crypto.randomUUID();
  let archive = new FileReferenceArchive(directory);
  let context = new ReviewContext(f.workspace, archive.session(id));
  const { reviewId } = await context.listChanges({ scope: 'all' });
  const input = {
    reviewId,
    references: [
      region,
      wholeFile,
      { ...region, version: 'old' as const },
      { path: 'deleted.ts', version: 'old' as const, startLine: 1, endLine: 1 },
      { path: '目录/[empty].ts', version: 'new' as const, scope: 'file' as const },
    ],
  };
  const { references } = await context.citeFiles(input);
  expect((await context.citeFiles(input)).references).toEqual(references);
  // The range and whole-file references share the same complete source blob.
  const files = await readdir(join(directory, id));
  expect(files.filter((file) => file.endsWith('.txt'))).toHaveLength(4);
  const manifest = JSON.parse(await readFile(join(directory, id, 'manifest.json'), 'utf8'));
  expect(manifest.documents).toHaveLength(5);
  const expected = [unsaved, unsaved, original, 'deleted source\n', ''];

  // Evict and then expire all live snapshots. Navigation survives; the model
  // cannot reuse archived evidence for a new submit_review.
  for (let index = 0; index < 4; index++) await context.listChanges({ scope: 'all' });
  await expect(context.getFileReference(references[0]!.referenceId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
  const now = Date.now;
  Date.now = () => now() + 16 * 60 * 1000;
  try {
    expect((await context.readFileReference(references[0]!.referenceId)).content).toBe(unsaved);
  } finally {
    Date.now = now;
  }
  context.dispose();
  await archive.close();
  f.state.dirtyDocuments.length = 0;
  await f.write('file.ts', 'entirely different\n');
  archive = new FileReferenceArchive(directory);
  context = new ReviewContext(f.workspace, archive.session(id));
  try {
    for (let index = 0; index < references.length; index++)
      expect(await context.readFileReference(references[index]!.referenceId)).toEqual({
        reference: references[index]!,
        content: expected[index]!,
      });
    await expect(context.getFileReference(references[0]!.referenceId)).rejects.toMatchObject({
      code: 'reference_not_found',
    });
    const other = new ReviewContext(f.workspace, archive.session(crypto.randomUUID()));
    await expect(other.readFileReference(references[0]!.referenceId)).rejects.toMatchObject({
      code: 'reference_not_found',
    });
    f.state.trusted = false;
    await expect(context.readFileReference(references[0]!.referenceId)).rejects.toMatchObject({
      code: 'workspace_untrusted',
    });
    f.state.trusted = true;
    f.state.repositories = [];
    await expect(context.readFileReference(references[0]!.referenceId)).rejects.toMatchObject({
      code: 'repository_unavailable',
    });
  } finally {
    context.dispose();
    await archive.close();
  }
});

test('cite_files publishes only after the whole batch is saved and a failed write can be retried', async () => {
  const f = await reviewFixture();
  const archive = new FileReferenceArchive(join(f.root, '.git', 'saved-references'));
  const id = crypto.randomUUID();
  const persistence = archive.session(id);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing!: () => void;
  const started = new Promise<void>((resolve) => {
    writing = resolve;
  });
  const adapter: SessionFileReferences = {
    read: persistence.read,
    write: async (documents) => {
      writing();
      await gate;
      await persistence.write(documents);
    },
  };
  const context = new ReviewContext(f.workspace, adapter);
  const { reviewId } = await context.listChanges({ scope: 'all' });
  let acknowledged = false;
  const citation = context.citeFiles({ reviewId, references: [region] }).then((result) => {
    acknowledged = true;
    return result;
  });
  await started;
  expect(acknowledged).toBe(false);
  expect(await archive.has(id)).toBe(false);
  release();
  const { references } = await citation;
  expect(await persistence.read(references[0]!.referenceId)).toEqual({
    reference: references[0]!,
    content: 'one\ntwo\nthree\n',
  });
  let failedBatch: ReferenceDocument[] = [];
  adapter.write = async (documents) => {
    failedBatch = documents;
    throw new Error('Unavailable storage');
  };
  await expect(context.citeFiles({ reviewId, references: [wholeFile] })).rejects.toThrow(
    'Unavailable storage',
  );
  const failedId = failedBatch[0]!.reference.referenceId;
  expect(await persistence.read(failedId)).toBeUndefined();
  await expect(context.getFileReference(failedId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
  adapter.write = persistence.write;
  await context.citeFiles({ reviewId, references: [wholeFile] });
  expect(await persistence.read(failedId)).toBeDefined();
  // Disk failures also remain recoverable and publish no partial manifest.
  const unavailable = join(f.root, '.git', 'not-a-directory');
  await writeFile(unavailable, 'block writes');
  const brokenArchive = new FileReferenceArchive(unavailable);
  await expect(brokenArchive.session(id).write(failedBatch)).rejects.toMatchObject({
    code: 'reference_save_failed',
  });
  await brokenArchive.close();
  context.dispose();
  await archive.close();
});

test('reference writes serialize concurrent batches, deduplicate blobs and reject writes after deletion', async () => {
  const f = await reviewFixture();
  const directory = join(f.root, '.git', 'saved-references');
  const archive = new FileReferenceArchive(directory);
  const id = crypto.randomUUID();
  const context = new ReviewContext(f.workspace, archive.session(id));
  const { reviewId } = await context.listChanges({ scope: 'all' });
  const results = await Promise.all([
    context.citeFiles({ reviewId, references: [region] }),
    context.citeFiles({ reviewId, references: [wholeFile] }),
  ]);
  const references = results.flatMap(({ references: items }) => items);
  const manifest = JSON.parse(await readFile(join(directory, id, 'manifest.json'), 'utf8'));
  expect(manifest.documents).toHaveLength(2);
  expect((await readdir(join(directory, id))).filter((file) => file.endsWith('.txt'))).toHaveLength(
    1,
  );
  const document = (await archive.session(id).read(references[0]!.referenceId))!;
  // The queued stale write cannot recreate an explicitly deleted conversation.
  const deletion = archive.delete(id);
  const staleWrite = archive.session(id).write([document]);
  await deletion;
  await expect(staleWrite).rejects.toMatchObject({ code: 'reference_not_found' });
  expect(await archive.has(id)).toBe(false);
  expect(await archive.session(id).read(references[0]!.referenceId)).toBeUndefined();
  expect(await new FileReferenceArchive(directory).has(id)).toBe(false);
  await archive.close();
});

test('corrupt archives never open another path or substitute current source text', async () => {
  const f = await reviewFixture();
  const directory = join(f.root, '.git', 'saved-references');
  const id = crypto.randomUUID();
  const archive = new FileReferenceArchive(directory);
  const context = new ReviewContext(f.workspace, archive.session(id));
  const { reviewId } = await context.listChanges({ scope: 'all' });
  const reference = (await context.citeFiles({ reviewId, references: [region] })).references[0]!;
  const path = join(directory, id, 'manifest.json');
  const text = await readFile(path, 'utf8');
  const manifest = JSON.parse(text);
  const blob = join(directory, id, `${manifest.documents[0].contentId}.txt`);
  await writeFile(blob, 'wrong source');
  await expect(context.readFileReference(reference.referenceId)).rejects.toMatchObject({
    code: 'reference_corrupt',
  });
  await rm(blob);
  await expect(context.readFileReference(reference.referenceId)).rejects.toMatchObject({
    code: 'reference_corrupt',
  });
  await writeFile(blob, 'one\ntwo\nthree\n');
  for (const change of [
    { sessionId: crypto.randomUUID() },
    { documents: [{ ...manifest.documents[0], contentId: '../../outside' }] },
    { documents: [{ ...manifest.documents[0], reference: { ...reference, path: '../outside' } }] },
    { documents: [{ ...manifest.documents[0], reference: { ...reference, startLine: 1 } }] },
  ]) {
    await writeFile(path, JSON.stringify({ ...manifest, ...change }));
    await expect(context.readFileReference(reference.referenceId)).rejects.toBeDefined();
  }
  await writeFile(path, text);
  expect((await context.readFileReference(reference.referenceId)).content).toBe(
    'one\ntwo\nthree\n',
  );
  expect(() => archive.session('../outside')).toThrow();
  expect(await archive.session(id).read('ref_../../outside')).toBeUndefined();
  await archive.close();
});

test('archived navigation restores persisted finding status without recreating model sessions and deletes chat-only citations', async () => {
  const f = await reviewFixture();
  const directory = join(f.root, '.git', 'saved-references');
  const saved = new Map<string, ReviewSnapshotState>();
  const reviewStorage: ReviewStorage = {
    read: (id) => structuredClone(saved.get(id)),
    write: async (id, value) => {
      if (value) saved.set(id, structuredClone(value));
      else saved.delete(id);
    },
  };
  let archive = new FileReferenceArchive(directory);
  let runtime = new BridgeRuntime(
    new ProviderRegistry(),
    {},
    (references) => new ReviewContext(f.workspace, references),
    reviewStorage,
    archive,
  );
  const session = runtime.sessions.create('fixture', { model: 'fixture', accountId: 'account' });
  const context = new ReviewContext(f.workspace, archive.session(session.id));
  await f.write('file.ts', 'one\nunchecked\nthree\n');
  const run = session.reviews.start(crypto.randomUUID(), session.id, 'Review', context);
  const { reviewId } = await run.track('list_changes', () => context.listChanges({ scope: 'all' }));
  await run.track('get_diff', () => context.getDiff({ reviewId, paths: ['file.ts'] }));
  const reference = (await context.citeFiles({ reviewId, references: [region] })).references[0]!;
  const receipt = await run.submit(
    {
      reviewId,
      title: 'Missing validation',
      priority: 'P1',
      description: `Validate ${reference.markdown}.`,
      referenceIds: [reference.referenceId],
    },
    'saved',
  );
  await session.reviews.setFindingStatus(receipt.finding.id, 'resolved');
  await session.reviews.updateFinding(receipt.finding.id, { editorArchived: true });
  run.settle('cancelled');
  await session.reviews.save();
  const release = runtime.releaseSession(session.id);
  expect(runtime.releaseSession(session.id)).toBe(release);
  expect(() => runtime.start(session.id, 'racing turn', new AbortController().signal)).toThrow(
    'being released',
  );
  await release;
  expect(runtime.sessions.list()).toHaveLength(0);
  expect(
    (await runtime.readFileReference(session.id, reference.referenceId)).findings[0],
  ).toMatchObject({ editorArchived: true, status: 'resolved' });
  // Chat-only references have no persisted review journal at all.
  const chatId = crypto.randomUUID();
  await archive.session(chatId).write([{ reference, content: 'one\nunchecked\nthree\n' }]);
  context.dispose();
  await runtime.dispose();
  await f.write('file.ts', 'changed after review\n');
  archive = new FileReferenceArchive(directory);
  runtime = new BridgeRuntime(
    new ProviderRegistry(),
    {},
    (references) => new ReviewContext(f.workspace, references),
    reviewStorage,
    archive,
  );
  try {
    const restored = await runtime.readFileReference(session.id, reference.referenceId);
    expect(restored).toMatchObject({
      reference,
      content: 'one\nunchecked\nthree\n',
      findings: [
        { id: receipt.finding.id, status: 'resolved', editorArchived: true, statusRevision: 2 },
      ],
    });
    expect(runtime.sessions.list()).toHaveLength(0);
    expect(() => runtime.sessions.get(session.id)).toThrow();
    expect(runtime.sessions.reviews.get(session.id).snapshot().runs[0]!.status).toBe('cancelled');
    expect((await runtime.readFileReference(chatId, reference.referenceId)).findings).toEqual([]);
    await expect(
      runtime.readFileReference(crypto.randomUUID(), reference.referenceId),
    ).rejects.toMatchObject({ code: 'reference_not_found' });
    await runtime.deleteSession(session.id);
    expect(saved.has(session.id)).toBe(false);
    expect(await archive.has(session.id)).toBe(false);
    await expect(
      runtime.readFileReference(session.id, reference.referenceId),
    ).rejects.toMatchObject({ code: 'reference_not_found' });
    await runtime.deleteSession(chatId);
    expect(await archive.has(chatId)).toBe(false);
    const orphanId = crypto.randomUUID();
    await mkdir(join(directory, orphanId), { recursive: true });
    await writeFile(join(directory, orphanId, 'orphan.txt'), 'Interrupted initial write');
    await runtime.deleteSession(orphanId);
    expect(await archive.has(orphanId)).toBe(false);
  } finally {
    await runtime.dispose();
  }
});
