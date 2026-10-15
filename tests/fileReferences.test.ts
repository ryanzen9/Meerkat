import { expect, test } from 'bun:test';
import { asSchema } from 'ai';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import { reviewTools } from '../src/extension/bridge/tools/reviewTools';
import { reviewFixture } from './reviewFixture';
import type { FileReferenceTarget } from '../src/extension/bridge/tools/reviewWorkspace';

const region = { path: 'file.ts', version: 'new' as const, startLine: 2, endLine: 3 };
const capacityRegion = (index: number) => ({
  ...region,
  startLine: Math.floor(index / 100) + 1,
  endLine: (index % 100) + 20,
});

test('mixed file and range references have distinct identities and preserve legacy range calls', async () => {
  const f = await reviewFixture();
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const file = { path: 'file.ts', version: 'new' as const, scope: 'file' as const };
  const { references } = await f.context.citeFiles({
    reviewId,
    references: [
      file,
      region,
      { ...region, scope: 'range' },
      file,
      { ...file, version: 'old' },
      { ...region, startLine: 1, endLine: 3 },
    ],
  });
  expect(references[0]).toMatchObject({ ...file, reviewId, repository: f.root, label: 'file.ts' });
  expect(Object.hasOwn(references[0]!, 'startLine')).toBe(false);
  expect(Object.hasOwn(references[0]!, 'endLine')).toBe(false);
  expect(references[0]!.markdown).toBe(`[file.ts](review-file:${references[0]!.referenceId})`);
  expect(references[0]!.referenceId).toBe(references[3]!.referenceId);
  expect(references[1]).toMatchObject({ scope: 'range', startLine: 2, endLine: 3 });
  expect(references[1]).toEqual(references[2]!);
  expect(references[4]!.label).toBe('file.ts (old)');
  expect(new Set(references.map(({ referenceId }) => referenceId)).size).toBe(4);
  expect(await f.context.readFileReference(references[0]!.referenceId)).toEqual({
    reference: references[0]!,
    content: 'one\ntwo\nthree\n',
  });
  const next = await f.context.listChanges({ scope: 'all' });
  expect(
    (await f.context.citeFiles({ reviewId: next.reviewId, references: [file] })).references[0]!
      .referenceId,
  ).not.toBe(references[0]!.referenceId);
});

test('whole-file references support empty and long text files while keeping range and file checks', async () => {
  const f = await reviewFixture({
    'file.ts': Array.from({ length: 600 }, () => 'line').join('\n'),
    'empty.ts': '',
    'long.ts': 'x'.repeat(24001),
    'binary.dat': Buffer.from([0, 1]),
  });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const { references } = await f.context.citeFiles({
    reviewId,
    references: ['file.ts', 'empty.ts', 'long.ts'].map((path) => ({
      path,
      version: 'new',
      scope: 'file',
    })),
  });
  expect(references.map(({ scope, label }) => ({ scope, label }))).toEqual([
    { scope: 'file', label: 'file.ts' },
    { scope: 'file', label: 'empty.ts' },
    { scope: 'file', label: 'long.ts' },
  ]);
  expect((await f.context.readFileReference(references[1]!.referenceId)).content).toBe('');
  expect((await f.context.readFileReference(references[2]!.referenceId)).content.length).toBe(
    24001,
  );
  await expect(
    f.context.citeFiles({ reviewId, references: [{ ...region, startLine: 1, endLine: 600 }] }),
  ).rejects.toMatchObject({ code: 'range_invalid' });
  for (const [path, code] of [
    ['missing.ts', 'file_not_found'],
    ['binary.dat', 'file_binary'],
    ['../outside', 'path_invalid'],
    ['.git/config', 'path_invalid'],
  ]) {
    await expect(
      f.context.citeFiles({
        reviewId,
        references: [{ path: path!, version: 'new', scope: 'file' }],
      }),
    ).rejects.toMatchObject({ code: code! });
  }
  for (const scope of ['file', 'unknown']) {
    const invalid = { ...region, scope } as unknown as FileReferenceTarget;
    await expect(f.context.citeFiles({ reviewId, references: [invalid] })).rejects.toMatchObject({
      code: 'reference_scope_invalid',
    });
  }
  f.context.dispose();
  await expect(f.context.readFileReference(references[0]!.referenceId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
});

test('reference document reads preserve full snapshot text beyond the paginated read limit', async () => {
  const content = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\r\n') + '\r\n';
  const f = await reviewFixture({ 'file.ts': content });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const reference = (await f.context.citeFiles({ reviewId, references: [region] })).references[0]!;
  await f.write('file.ts', 'later\n');
  expect(await f.context.readFileReference(reference.referenceId)).toEqual({ reference, content });
  f.context.dispose();
  await expect(f.context.readFileReference(reference.referenceId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
});

test('reference IDs bind exact snapshot regions and resolve independently of later editor changes', async () => {
  const f = await reviewFixture({ 'file.ts': 'one\ntwo\nthree\n', 'other.ts': 'a\nb\nc\n' });
  f.state.dirtyDocuments.push({ path: join(f.root, 'file.ts'), text: 'one\nunsaved\nthree\n' });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const input = { reviewId, references: [region] };
  const {
    references: [reference],
  } = await f.context.citeFiles(input);
  expect(reference).toMatchObject({
    ...region,
    reviewId,
    repository: f.root,
    label: 'file.ts:2–3',
  });
  expect(reference!.referenceId).toMatch(/^ref_[a-f0-9]{64}$/);
  expect(reference!.markdown).toBe(`[file.ts:2–3](review-file:${reference!.referenceId})`);
  expect((await f.context.citeFiles(input)).references).toEqual([reference!]);
  const distinct = await f.context.citeFiles({
    reviewId,
    references: [
      { ...region, endLine: 2 },
      { ...region, version: 'old' },
      { ...region, path: 'other.ts' },
      region,
      region,
    ],
  });
  expect(new Set(distinct.references.map((item) => item.referenceId)).size).toBe(4);
  expect(distinct.references[0]!.label).toBe('file.ts:2');
  expect(distinct.references[1]!.label).toBe('file.ts:2–3 (old)');
  await f.write('file.ts', 'later\n');
  f.state.dirtyDocuments.length = 0;
  expect(await f.context.getFileReference(reference!.referenceId)).toEqual(reference!);
  const fresh = await f.context.listChanges({ scope: 'all' });
  const freshReference = await f.context.citeFiles({
    reviewId: fresh.reviewId,
    references: [{ ...region, path: 'other.ts' }],
  });
  expect(freshReference.references[0]!.referenceId).not.toBe(distinct.references[2]!.referenceId);
  // Caller mutations cannot alter the Host's registered location.
  const id = reference!.referenceId;
  reference!.endLine = 99;
  const resolved = await f.context.getFileReference(id);
  expect(resolved.endLine).toBe(3);
  resolved.path = 'other.ts';
  expect((await f.context.getFileReference(id)).path).toBe('file.ts');
});

test('citations preserve old and new rename paths and deleted-file locations', async () => {
  const f = await reviewFixture({ 'old.ts': 'one\ntwo\nthree\n', 'deleted.ts': 'gone\n' });
  await f.git('mv', 'old.ts', 'new.ts');
  await rm(join(f.root, 'deleted.ts'));
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const { references } = await f.context.citeFiles({
    reviewId,
    references: [
      { ...region, path: 'old.ts', version: 'old' },
      { ...region, path: 'new.ts' },
      { path: 'deleted.ts', version: 'old', startLine: 1, endLine: 1 },
    ],
  });
  expect(references.map(({ path, version }) => ({ path, version }))).toEqual([
    { path: 'old.ts', version: 'old' },
    { path: 'new.ts', version: 'new' },
    { path: 'deleted.ts', version: 'old' },
  ]);
  await expect(
    f.context.citeFiles({ reviewId, references: [{ ...region, path: 'old.ts' }] }),
  ).rejects.toMatchObject({ code: 'file_not_found' });
});

test('citation ranges are inclusive, reject invalid coordinates and never clamp to EOF', async () => {
  const f = await reviewFixture({
    'file.ts': Array.from({ length: 501 }, () => 'line').join('\n'),
  });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const result = await f.context.citeFiles({
    reviewId,
    references: [{ ...region, startLine: 2, endLine: 501 }],
  });
  expect(result.references[0]).toMatchObject({ startLine: 2, endLine: 501 });
  for (const [startLine, endLine] of [
    [0, 1],
    [-1, 1],
    [1.5, 2],
    [1, 2.5],
    [NaN, 2],
    [1, Infinity],
    [1, Number.MAX_SAFE_INTEGER + 1],
    [3, 2],
    [1, 501],
    [500, 502],
    [502, 502],
  ]) {
    await expect(
      f.context.citeFiles({
        reviewId,
        references: [{ ...region, startLine: startLine!, endLine: endLine! }],
      }),
    ).rejects.toMatchObject({ code: 'range_invalid' });
  }
  for (const references of [[], Array.from({ length: 21 }, () => region)])
    await expect(f.context.citeFiles({ reviewId, references })).rejects.toMatchObject({
      code: 'references_invalid',
    });
});

test('citations reject missing, binary, empty and truncated source regions and unsafe paths', async () => {
  const f = await reviewFixture({
    'file.ts': 'one\ntwo\nthree\n',
    'empty.ts': '',
    'binary.dat': Buffer.from([0, 1, 2]),
    'long.ts': 'x'.repeat(24001),
  });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  for (const [path, code] of [
    ['missing.ts', 'file_not_found'],
    ['empty.ts', 'range_invalid'],
    ['binary.dat', 'file_binary'],
    ['long.ts', 'reference_truncated'],
    ['../outside.ts', 'path_invalid'],
    ['/etc/passwd', 'path_invalid'],
    ['.git/config', 'path_invalid'],
    ['dir\\file.ts', 'path_invalid'],
  ]) {
    await expect(
      f.context.citeFiles({
        reviewId,
        references: [{ ...region, path: path!, startLine: 1, endLine: 1 }],
      }),
    ).rejects.toMatchObject({ code: code! });
  }
});

test('reference Markdown escapes filenames while retaining their exact navigation paths', async () => {
  const path = '目录/[a](b)<tag>`code`*_.ts\nnext';
  const f = await reviewFixture({ [path]: 'one\r\ntwo' });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const {
    references: [reference],
  } = await f.context.citeFiles({
    reviewId,
    references: [{ path, version: 'new', startLine: 1, endLine: 2 }],
  });
  expect(reference!.path).toBe(path);
  expect(reference!.markdown).toBe(
    `[目录/\\[a\\]\\(b\\)\\<tag\\>\\\`code\\\`\\*\\_.ts\\\\nnext:1–2](review-file:${reference!.referenceId})`,
  );
  expect((await f.context.getFileReference(reference!.referenceId)).path).toBe(path);
});

test('references are session-local and follow snapshot eviction, expiry, trust and disposal', async () => {
  const f = await reviewFixture();
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const {
    references: [reference],
  } = await f.context.citeFiles({ reviewId, references: [region] });
  const other = new ReviewContext(f.workspace);
  await expect(other.citeFiles({ reviewId, references: [region] })).rejects.toMatchObject({
    code: 'review_not_found',
  });
  await expect(other.getFileReference(reference!.referenceId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
  f.state.trusted = false;
  await expect(f.context.citeFiles({ reviewId, references: [region] })).rejects.toMatchObject({
    code: 'workspace_untrusted',
  });
  await expect(f.context.getFileReference(reference!.referenceId)).rejects.toMatchObject({
    code: 'workspace_untrusted',
  });
  f.state.trusted = true;
  f.state.repositories = [];
  await expect(f.context.getFileReference(reference!.referenceId)).rejects.toMatchObject({
    code: 'repository_unavailable',
  });
  f.state.repositories = [f.root];
  for (let index = 0; index < 4; index++) await f.context.listChanges({ scope: 'all' });
  await expect(f.context.getFileReference(reference!.referenceId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
  const latest = await f.context.listChanges({ scope: 'all' });
  const fresh = (await f.context.citeFiles({ reviewId: latest.reviewId, references: [region] }))
    .references[0]!;
  const now = Date.now;
  Date.now = () => now() + 16 * 60 * 1000;
  try {
    await expect(f.context.getFileReference(fresh.referenceId)).rejects.toMatchObject({
      code: 'reference_not_found',
    });
  } finally {
    Date.now = now;
  }
  const last = await f.context.listChanges({ scope: 'all' });
  const disposed = (await f.context.citeFiles({ reviewId: last.reviewId, references: [region] }))
    .references[0]!;
  f.context.dispose();
  await expect(f.context.getFileReference(disposed.referenceId)).rejects.toMatchObject({
    code: 'reference_not_found',
  });
});

test('citation tool validates its schema, returns recoverable errors and propagates cancellation', async () => {
  const f = await reviewFixture();
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const input = { reviewId, references: [region] };
  const tools = reviewTools(f.context);
  const schema = asSchema(tools.cite_files.inputSchema);
  expect((await schema.validate!(input)).success).toBe(true);
  expect(
    (await schema.validate!({ ...input, references: [{ ...region, scope: 'range' }] })).success,
  ).toBe(true);
  expect(
    (
      await schema.validate!({
        ...input,
        references: [{ path: 'file.ts', version: 'new', scope: 'file' }],
      })
    ).success,
  ).toBe(true);
  for (const value of [
    { ...input, reviewId: 'invented' },
    { ...input, references: [] },
    { ...input, references: Array.from({ length: 21 }, () => region) },
    { ...input, references: [{ ...region, startLine: 0 }] },
    { ...input, references: [{ ...region, endLine: 2.5 }] },
    { ...input, references: [{ ...region, version: 'current' }] },
    { ...input, references: [{ path: 'file.ts', version: 'new' }] },
    { ...input, references: [{ ...region, scope: 'file' }] },
    { ...input, references: [{ path: 'file.ts', version: 'new', scope: 'file', startLine: 1 }] },
    { ...input, references: [{ path: 'file.ts', version: 'new', scope: 'range', startLine: 1 }] },
    { ...input, references: [{ ...region, scope: 'unknown' }] },
  ])
    expect((await schema.validate!(value)).success).toBe(false);
  const options = { toolCallId: 'citation', messages: [], context: {} };
  expect(await reviewTools().cite_files.execute!(input, options)).toMatchObject({
    error: { code: 'review_unavailable' },
  });
  expect(
    await tools.cite_files.execute!(
      { reviewId, references: [{ ...region, endLine: 99 }] },
      options,
    ),
  ).toMatchObject({ error: { code: 'range_invalid' } });
  const abort = new AbortController();
  abort.abort(new Error('cancel citation'));
  await expect(
    tools.cite_files.execute!(input, { ...options, abortSignal: abort.signal }),
  ).rejects.toThrow('cancel citation');
  // Cancellation during an asynchronous workspace read also remains cancellation.
  const active = new AbortController();
  const getState = f.workspace.getState;
  f.workspace.getState = async () => {
    active.abort(new Error('cancel during citation'));
    return getState();
  };
  await expect(
    tools.cite_files.execute!(input, { ...options, abortSignal: active.signal }),
  ).rejects.toThrow('cancel during citation');
});

test('reference batches are atomic and bounded, and duplicate regions do not consume capacity', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', Array.from({ length: 120 }, () => 'line').join('\n'));
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  for (let offset = 0; offset < 980; offset += 20)
    await f.context.citeFiles({
      reviewId,
      references: Array.from({ length: 20 }, (_, index) => capacityRegion(offset + index)),
    });
  await f.context.citeFiles({
    reviewId,
    references: Array.from({ length: 19 }, (_, index) => capacityRegion(980 + index)),
  });
  // A valid first region must not be published when a later region is invalid.
  await expect(
    f.context.citeFiles({
      reviewId,
      references: [capacityRegion(999), { ...region, endLine: 121 }],
    }),
  ).rejects.toMatchObject({ code: 'range_invalid' });
  // A batch that exceeds capacity must not consume the one remaining slot either.
  await expect(
    f.context.citeFiles({
      reviewId,
      references: [capacityRegion(999), capacityRegion(1000)],
    }),
  ).rejects.toMatchObject({ code: 'reference_limit' });
  expect(
    (await f.context.citeFiles({ reviewId, references: [capacityRegion(1000)] })).references,
  ).toHaveLength(1);
  expect(
    (await f.context.citeFiles({ reviewId, references: [capacityRegion(0), capacityRegion(0)] }))
      .references,
  ).toHaveLength(2);
  await expect(
    f.context.citeFiles({ reviewId, references: [capacityRegion(999)] }),
  ).rejects.toMatchObject({
    code: 'reference_limit',
  });
  await expect(
    f.context.citeFiles({
      reviewId,
      references: [{ path: 'file.ts', version: 'new', scope: 'file' }],
    }),
  ).rejects.toMatchObject({ code: 'reference_limit' });
});
