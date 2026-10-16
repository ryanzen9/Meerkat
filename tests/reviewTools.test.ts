import { expect, test } from 'bun:test';
import { chmod, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import { reviewTools } from '../src/extension/bridge/tools/reviewTools';
import { runCommand } from './projectFixture';
import { reviewFixture } from './reviewFixture';

test('context identifies the project, editor selection, HEAD, dirty files and configuration', async () => {
  const f = await reviewFixture({
    'file.ts': 'one\n',
    'package.json': '{}\n',
    'tsconfig.json': '{}\n',
  });
  f.state.dirtyDocuments.push({ path: join(f.root, 'file.ts'), text: 'unsaved\n' });
  const result = await f.context.getReviewContext();
  expect(result.repository).toEqual({
    root: f.root,
    branch: 'main',
    head: await f.git('rev-parse', 'HEAD'),
  });
  expect(result.activeFile?.selection).toEqual(f.state.activeFile!.selection);
  expect(result.unsavedFiles).toEqual([{ path: join(f.root, 'file.ts') }]);
  expect(result.configurationFiles).toEqual(['package.json', 'tsconfig.json']);
  expect(JSON.stringify(result)).not.toContain('unsaved\\n');
  await f.git('checkout', '--detach');
  expect((await f.context.getReviewContext()).repository?.branch).toBeNull();
});

test('staged, working-tree and all pin their own versions including unsaved buffers', async () => {
  const f = await reviewFixture({ 'file.ts': 'HEAD\n', 'unchanged.ts': 'stable\n' });
  await f.write('file.ts', 'index\n');
  await f.git('add', 'file.ts');
  await f.write('file.ts', 'disk\n');
  f.state.dirtyDocuments.push({ path: join(f.root, 'file.ts'), text: 'editor\n' });
  const scopes = [
    ['staged', 'HEAD', 'index'],
    ['working-tree', 'index', 'editor'],
    ['all', 'HEAD', 'editor'],
  ] as const;
  for (const [scope, oldText, newText] of scopes) {
    const { reviewId } = await f.context.listChanges({ scope });
    for (const [version, text] of [
      ['old', oldText],
      ['new', newText],
    ] as const) {
      const file = await f.context.readFile({
        reviewId,
        path: 'file.ts',
        version,
        startLine: 1,
        endLine: 10,
      });
      expect(file.lines).toEqual([{ line: 1, text }]);
    }
    await f.write('unchanged.ts', 'later edit\n');
    const unchanged = await f.context.readFile({
      reviewId,
      path: 'unchanged.ts',
      version: 'new',
      startLine: 1,
      endLine: 1,
    });
    expect(unchanged.lines[0]?.text).toBe(scope === 'staged' ? 'stable' : 'later edit');
  }
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  await f.write('file.ts', 'after snapshot\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'later');
  f.state.dirtyDocuments.length = 0;
  const result = await f.context.readFile({
    reviewId,
    path: 'file.ts',
    version: 'new',
    startLine: 1,
    endLine: 1,
  });
  expect(result.lines[0]?.text).toBe('editor');
  const diff = await f.context.getDiff({ reviewId, paths: ['file.ts'] });
  expect(diff.files[0]?.patch).toContain('-HEAD\n+editor\n');
  expect(diff.files[0]?.patch).not.toContain('after snapshot');
});

test('Git hunks have correct insertion coordinates and produce an applicable patch', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'one\ninserted\ntwo\nthree\n');
  const indexBefore = await readFile(join(f.root, '.git', 'index'));
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const diff = await f.context.getDiff({ reviewId, paths: ['file.ts'] });
  const file = diff.files[0]!;
  expect(file.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 });
  expect(file.hunks[0]?.lines).toContainEqual({
    type: 'added',
    oldLine: null,
    newLine: 2,
    text: 'inserted',
    partial: false,
  });
  expect(file.hunks[0]?.lines).toContainEqual({
    type: 'context',
    oldLine: 2,
    newLine: 3,
    text: 'two',
    partial: false,
  });
  await f.write('review.patch', file.patch);
  const check = await runCommand(f.root, ['git', 'apply', '--check', '--reverse', 'review.patch']);
  expect(check.exitCode).toBe(0);
  expect(await readFile(join(f.root, '.git', 'index'))).toEqual(indexBefore);
  expect(diff.truncated).toBe(false);
});

test('staged route-file reads treat brackets literally and accept an end past EOF', async () => {
  const path = 'app/[locale]/projects/page.tsx';
  const f = await reviewFixture({ [path]: 'export default "HEAD";\n' });
  await f.write(path, 'export default "staged";\n');
  await f.git('add', '--', path);
  await f.write(path, 'export default "working-tree";\n');
  const { reviewId } = await f.context.listChanges({ scope: 'staged' });
  const result = await f.context.readFile({
    reviewId,
    path,
    version: 'new',
    startLine: 1,
    endLine: 100,
  });
  expect(result.lines).toEqual([{ line: 1, text: 'export default "staged";' }]);
  expect(result.endLine).toBe(1);
  expect(result.truncated).toBe(false);
});

test('live search can find an untracked route that a staged snapshot cannot read', async () => {
  const f = await reviewFixture();
  const path = 'app/[locale]/projects/page.tsx';
  const body = 'export default "untracked projects page";\n';
  await f.write('file.ts', 'staged change\n');
  await f.git('add', 'file.ts');
  await f.write(path, body);
  const staged = await f.context.listChanges({ scope: 'staged' });
  expect(staged.changes.map((change) => change.path)).toEqual(['file.ts']);
  const found = await f.context.searchCode({ query: 'untracked projects page' });
  expect(found.matches[0]?.path).toBe(path);
  const tools = reviewTools(f.context);
  const result = await tools.read_file.execute!(
    { reviewId: staged.reviewId, path, version: 'new', startLine: 1, endLine: 100 },
    { toolCallId: 'read', messages: [], context: {} },
  );
  expect(result).toMatchObject({ error: { code: 'file_not_found' } });
  if (!('error' in result)) throw new Error('Expected a snapshot mismatch');
  expect(result.error.message).toContain(path);
  expect(result.error.message).toContain('"staged" review snapshot (Git index)');
  expect(result.error.message).toContain('Untracked files');
  expect(result.error.message).toContain('search_code searches live files');
  expect(JSON.stringify(result)).not.toContain(body.trim());
  const all = await f.context.listChanges({ scope: 'all' });
  expect(
    (
      await f.context.readFile({
        reviewId: all.reviewId,
        path,
        version: 'new',
        startLine: 1,
        endLine: 100,
      })
    ).lines,
  ).toEqual([{ line: 1, text: body.trim() }]);
  // A later snapshot that includes the path never changes the staged snapshot.
  await expect(
    f.context.readFile({
      reviewId: staged.reviewId,
      path,
      version: 'new',
      startLine: 1,
      endLine: 100,
    }),
  ).rejects.toMatchObject({ code: 'file_not_found' });
});

test('additions, deletions, edited renames, binary files and executable modes are represented', async () => {
  const f = await reviewFixture({
    'old name.ts': 'one\ntwo\nthree\nfour\nfive\n',
    'delete.ts': 'gone\n',
    'mode.sh': '#!/bin/sh\n',
  });
  await f.git('mv', 'old name.ts', '新 name.ts');
  await f.write('新 name.ts', 'one\ntwo\nchanged\nfour\nfive\n');
  await f.git('add', '.');
  await rm(join(f.root, 'delete.ts'));
  await f.write('new\tfile.ts', 'added\n');
  await f.write('binary.dat', Buffer.from([0, 1, 2, 3]));
  await chmod(join(f.root, 'mode.sh'), 0o755);
  const result = await f.context.listChanges({ scope: 'all' });
  expect(result.changes).toContainEqual({
    path: '新 name.ts',
    oldPath: 'old name.ts',
    newPath: '新 name.ts',
    status: 'renamed',
  });
  expect(result.changes.find((item) => item.path === 'delete.ts')?.status).toBe('deleted');
  expect(result.changes.find((item) => item.path === 'new\tfile.ts')?.status).toBe('added');
  const rename = await f.context.getDiff({ reviewId: result.reviewId, paths: ['old name.ts'] });
  expect(rename.files[0]?.patch).toContain('rename from "old name.ts"');
  expect(rename.files[0]?.patch).toContain('-three\n+changed');
  const binary = await f.context.getDiff({ reviewId: result.reviewId, paths: ['binary.dat'] });
  expect(binary.files[0]?.binary).toBe(true);
  await expect(
    f.context.readFile({
      reviewId: result.reviewId,
      path: 'binary.dat',
      version: 'new',
      startLine: 1,
      endLine: 10,
    }),
  ).rejects.toMatchObject({ code: 'file_binary' });
  const mode = await f.context.getDiff({ reviewId: result.reviewId, paths: ['mode.sh'] });
  expect(mode.files[0]?.patch).toContain('old mode 100644\nnew mode 100755');
});

test('unborn repositories, empty files and ignored files have explicit scope semantics', async () => {
  const f = await reviewFixture({});
  await f.write('.gitignore', 'ignored.txt\n');
  await f.git('add', '.gitignore');
  await f.write('new.ts', 'new\n');
  await f.write('empty.ts', '');
  await f.write('ignored.txt', 'secret');
  f.state.dirtyDocuments.push({ path: join(f.root, 'ignored.txt'), text: 'unsaved secret' });
  const staged = await f.context.listChanges({ scope: 'staged' });
  expect(staged.head).toBeNull();
  expect(staged.changes.map((item) => item.path)).toEqual(['.gitignore']);
  const all = await f.context.listChanges({ scope: 'all' });
  expect(all.changes.map((item) => item.path)).toEqual(['.gitignore', 'empty.ts', 'new.ts']);
  const empty = await f.context.getDiff({ reviewId: all.reviewId, paths: ['empty.ts'] });
  expect(empty.files[0]?.patch).toContain('new file mode 100644');
  expect(
    (
      await f.context.readFile({
        reviewId: all.reviewId,
        path: 'empty.ts',
        version: 'new',
        startLine: 1,
        endLine: 1,
      })
    ).lines,
  ).toEqual([]);
});

test('branch scope uses merge-base and pins HEAD despite local and later branch changes', async () => {
  const f = await reviewFixture();
  await f.git('branch', 'base');
  await f.write('file.ts', 'branch\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'branch');
  await f.git('checkout', 'base');
  await f.write('other.ts', 'base only\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'advance base');
  await f.git('checkout', 'main');
  await f.write('file.ts', 'local\n');
  const snapshot = await f.context.listChanges({ scope: 'branch', baseRef: 'base' });
  expect(snapshot.changes.map((item) => item.path)).toEqual(['file.ts']);
  expect(
    (
      await f.context.readFile({
        reviewId: snapshot.reviewId,
        path: 'file.ts',
        version: 'new',
        startLine: 1,
        endLine: 1,
      })
    ).lines[0]?.text,
  ).toBe('branch');
  await expect(
    f.context.listChanges({ scope: 'branch', baseRef: '--output=x' }),
  ).rejects.toMatchObject({ code: 'base_ref_invalid' });
  await expect(f.context.listChanges({ scope: 'all', baseRef: 'base' })).rejects.toMatchObject({
    code: 'base_ref_invalid',
  });
});

test('paginated patches preserve trailing whitespace and missing final newlines', async () => {
  const f = await reviewFixture({ 'file.ts': 'old\n' });
  const text = Array.from(
    { length: 2000 },
    (_, index) => `new line ${index} with trailing spaces  `,
  ).join('\n');
  await f.write('file.ts', text);
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  let cursor: string | undefined;
  let patch = '',
    pages = 0;
  do {
    const result = await f.context.getDiff({
      reviewId,
      paths: ['file.ts'],
      ...(cursor ? { cursor } : {}),
    });
    patch += result.files[0]!.patch;
    pages++;
    cursor = result.nextCursor ?? undefined;
    expect(result.files[0]!.patch.length).toBeLessThanOrEqual(24000);
    expect(pages).toBeLessThan(20);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(patch).toContain('+new line 1999 with trailing spaces  \n\\ No newline at end of file\n');
  await f.write('review.patch', patch);
  expect(
    (await runCommand(f.root, ['git', 'apply', '--check', '--reverse', 'review.patch'])).exitCode,
  ).toBe(0);
  await expect(
    f.context.getDiff({ reviewId, paths: ['file.ts'], cursor: 'invalid' }),
  ).rejects.toMatchObject({ code: 'cursor_invalid' });
});

test('live literal search honors globs, unsaved content, locations, context and result limits', async () => {
  const f = await reviewFixture({
    'file.ts': 'before\nfind.*me\nafter\nfind.*me\n',
    'other.json': 'find.*me\n',
  });
  f.state.dirtyDocuments.push({
    path: join(f.root, 'file.ts'),
    text: 'before\n  editor.*query\nafter\neditor.*query\n',
  });
  const result = await f.context.searchCode({ query: 'editor.*query', glob: '**/*.ts', limit: 1 });
  expect(result.matches[0]).toMatchObject({
    path: 'file.ts',
    line: 2,
    column: 3,
    context: [
      { line: 1, text: 'before' },
      { line: 2, text: '  editor.*query' },
      { line: 3, text: 'after' },
    ],
  });
  expect(result.truncated).toBe(true);
  expect((await f.context.searchCode({ query: 'find.*me', glob: '**/*.ts' })).matches).toEqual([]);
});

test('diagnostics retain current severity, source, code and locations', async () => {
  const f = await reviewFixture();
  f.diagnostics.push({
    path: join(f.root, 'file.ts'),
    source: 'typescript',
    severity: 'error',
    code: 2322,
    message: 'Type mismatch',
    range: { start: { line: 2, column: 1 }, end: { line: 2, column: 4 } },
  });
  expect((await f.context.getDiagnostics({ paths: ['file.ts'] })).diagnostics[0]).toEqual({
    ...f.diagnostics[0]!,
    path: 'file.ts',
  });
});

test('snapshots are isolated by session, bounded, cleared on dispose and require current workspace trust', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'changed\n');
  const first = await f.context.listChanges({ scope: 'all' });
  const request = {
    reviewId: first.reviewId,
    path: 'file.ts',
    version: 'new' as const,
    startLine: 1,
    endLine: 1,
  };
  await expect(new ReviewContext(f.workspace).readFile(request)).rejects.toMatchObject({
    code: 'review_not_found',
  });
  for (let index = 0; index < 4; index++) await f.context.listChanges({ scope: 'all' });
  await expect(f.context.readFile(request)).rejects.toMatchObject({ code: 'review_not_found' });
  const last = await f.context.listChanges({ scope: 'all' });
  f.state.trusted = false;
  await expect(
    f.context.getDiff({ reviewId: last.reviewId, paths: ['file.ts'] }),
  ).rejects.toMatchObject({ code: 'workspace_untrusted' });
  f.state.trusted = true;
  f.context.dispose();
  await expect(f.context.readFile({ ...request, reviewId: last.reviewId })).rejects.toMatchObject({
    code: 'review_not_found',
  });
});

test('path traversal and metadata access are rejected, symlink targets are never searched', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'changed\n');
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  for (const path of [
    '../outside',
    '/etc/passwd',
    '.git/config',
    'dir/../../outside',
    'dir\\outside',
  ]) {
    await expect(
      f.context.readFile({ reviewId, path, version: 'new', startLine: 1, endLine: 1 }),
    ).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(f.context.getDiagnostics({ paths: [path] })).rejects.toMatchObject({
      code: 'path_invalid',
    });
  }
  const outside = await reviewFixture({ 'secret.ts': 'outside secret\n' });
  await symlink(join(outside.root, 'secret.ts'), join(f.root, 'link.ts'));
  const result = await f.context.searchCode({ query: 'outside secret' });
  expect(result.matches).toEqual([]);
  expect(result.skippedFiles).toBe(1);
  const links = await f.context.listChanges({ scope: 'all' });
  const file = await f.context.readFile({
    reviewId: links.reviewId,
    path: 'link.ts',
    version: 'new',
    startLine: 1,
    endLine: 1,
  });
  expect(file.lines[0]?.text).toBe(join(outside.root, 'secret.ts'));
});

test('ranges, oversized files, unavailable hosts and cancellation fail explicitly', async () => {
  const f = await reviewFixture();
  await f.write('file.ts', 'changed\n');
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  await expect(
    f.context.readFile({ reviewId, path: 'file.ts', version: 'new', startLine: 2, endLine: 1 }),
  ).rejects.toMatchObject({ code: 'range_invalid' });
  await f.write('large.ts', 'x'.repeat(1024 * 1024 + 1));
  await expect(f.context.listChanges({ scope: 'all' })).rejects.toMatchObject({
    code: 'file_too_large',
  });
  const tools = reviewTools();
  const options = { toolCallId: 'test', messages: [], context: {} };
  expect(await tools.get_review_context.execute!({}, options)).toMatchObject({
    error: { code: 'review_unavailable' },
  });
  const abort = new AbortController();
  abort.abort();
  await expect(f.context.searchCode({ query: 'one' }, abort.signal)).rejects.toBeDefined();
  await expect(
    tools.get_review_context.execute!({}, { ...options, abortSignal: abort.signal }),
  ).rejects.toBeDefined();
});

test('conflicts expose working conflict markers and reject a nonexistent stage-0 patch', async () => {
  const f = await reviewFixture({ 'file.ts': 'base\n' });
  await f.git('checkout', '-b', 'other');
  await f.write('file.ts', 'theirs\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'other');
  await f.git('checkout', 'main');
  await f.write('file.ts', 'ours\n');
  await f.git('add', '.');
  await f.git('commit', '-m', 'main');
  expect((await runCommand(f.root, ['git', 'merge', 'other'])).exitCode).toBe(1);
  const all = await f.context.listChanges({ scope: 'all' });
  expect(all.changes[0]?.status).toBe('conflict');
  const file = await f.context.readFile({
    reviewId: all.reviewId,
    path: 'file.ts',
    version: 'new',
    startLine: 1,
    endLine: 20,
  });
  expect(file.lines.some((line) => line.text.startsWith('<<<<<<<'))).toBe(true);
  expect(
    (await f.context.getDiff({ reviewId: all.reviewId, paths: ['file.ts'] })).files[0]?.patch,
  ).toContain('+<<<<<<<');
  const staged = await f.context.listChanges({ scope: 'staged' });
  expect(staged.changes[0]?.status).toBe('conflict');
  await expect(
    f.context.getDiff({ reviewId: staged.reviewId, paths: ['file.ts'] }),
  ).rejects.toMatchObject({ code: 'index_unmerged' });
  await expect(
    f.context.readFile({
      reviewId: staged.reviewId,
      path: 'file.ts',
      version: 'new',
      startLine: 1,
      endLine: 10,
    }),
  ).rejects.toMatchObject({ code: 'file_not_found' });
});

test('multi-file cursors preserve requested order, reject changed paths and retain overlong lines', async () => {
  const f = await reviewFixture({ 'file.ts': 'before\n', 'other.ts': 'unchanged\n' });
  await f.write('file.ts', 'x'.repeat(50000));
  await f.write('other.ts', 'after\n');
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const paths = ['other.ts', 'file.ts'];
  const first = await f.context.getDiff({ reviewId, paths });
  expect(first.files[0]?.path).toBe('other.ts');
  expect(first.nextCursor).toBeString();
  await expect(
    f.context.getDiff({ reviewId, paths: ['file.ts'], cursor: first.nextCursor! }),
  ).rejects.toMatchObject({ code: 'cursor_invalid' });
  let cursor = first.nextCursor;
  let patch = '';
  let fragments = 0;
  while (cursor) {
    const next = await f.context.getDiff({ reviewId, paths, cursor });
    patch += next.files[0]!.patch;
    fragments += next.files[0]!.hunks.flatMap((hunk) => hunk.lines).filter(
      (line) => line.partial,
    ).length;
    cursor = next.nextCursor;
  }
  expect(fragments).toBeGreaterThan(1);
  expect(patch).toContain('+' + 'x'.repeat(50000) + '\n');
  const read = await f.context.readFile({
    reviewId,
    path: 'file.ts',
    version: 'new',
    startLine: 1,
    endLine: 10,
  });
  expect(read.contentTruncated).toBe(true);
  expect(read.lines[0]?.text.length).toBe(24000);
});

test('repository selection handles nested repositories, ambiguous roots and expired snapshots', async () => {
  const f = await reviewFixture();
  const other = await reviewFixture();
  f.state.repositories.push(other.root);
  f.state.activeFile = null;
  expect((await f.context.getReviewContext()).repository).toBeNull();
  await expect(f.context.listChanges({ scope: 'all' })).rejects.toMatchObject({
    code: 'repository_unavailable',
  });
  f.state.activeFile = {
    path: join(f.root, 'file.ts'),
    languageId: 'typescript',
    selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
  };
  expect((await f.context.getReviewContext()).repository?.root).toBe(f.root);
  await f.write('file.ts', 'changed\n');
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const now = Date.now;
  Date.now = () => now() + 16 * 60 * 1000;
  try {
    await expect(f.context.getDiff({ reviewId, paths: ['file.ts'] })).rejects.toMatchObject({
      code: 'review_not_found',
    });
  } finally {
    Date.now = now;
  }
});
