import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitCommands } from '../src/extension/services/GitCommands';
import { reviewFixture } from './reviewFixture';

test('unpublished counts come from reachable commits and remote refs without an upstream', async () => {
  const { root, git, write } = await reviewFixture();
  const commands = new GitCommands();
  const first = await git('rev-parse', 'HEAD');
  expect(await commands.unpublishedCount('git', root, first)).toBe(1);
  await write('file.ts', 'second\n');
  await git('add', '.');
  await git('commit', '-m', 'second');
  const second = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/remotes/origin/main', first);
  expect(await commands.unpublishedCount('git', root, second)).toBe(1);
  await git('update-ref', 'refs/remotes/origin/main', second);
  expect(await commands.unpublishedCount('git', root, second)).toBe(0);
});

test('undo restores the parent while preserving the exact index, unstaged edits and untracked files', async () => {
  const { root, git, write } = await reviewFixture();
  const parent = await git('rev-parse', 'HEAD');
  await write('file.ts', 'committed\n');
  await git('add', '.');
  await git('commit', '-m', 'undo me');
  const head = await git('rev-parse', 'HEAD');
  await write('file.ts', 'unstaged edit\n');
  await write('other.ts', 'already staged\n');
  await git('add', 'other.ts');
  await write('untracked.ts', 'keep me\n');
  const index = await git('write-tree');
  const commands = new GitCommands();
  await commands.undo('git', root, 'main', head);
  expect(await git('rev-parse', 'HEAD')).toBe(parent);
  expect(await git('write-tree')).toBe(index);
  expect(await readFile(join(root, 'file.ts'), 'utf8')).toBe('unstaged edit\n');
  expect(await readFile(join(root, 'untracked.ts'), 'utf8')).toBe('keep me\n');
  expect((await git('diff', '--cached', '--name-only')).split('\n')).toEqual([
    'file.ts',
    'other.ts',
  ]);
  await expect(commands.undo('git', root, 'main', head)).rejects.toThrow();
  expect(await git('rev-parse', 'HEAD')).toBe(parent);
});

test('undoing the initial commit returns to an unborn branch with all staged contents intact', async () => {
  const { root, git, write } = await reviewFixture({});
  await write('file.ts', 'first\n');
  await git('add', '.');
  await git('commit', '-m', 'first');
  const head = await git('rev-parse', 'HEAD');
  const index = await git('write-tree');
  await new GitCommands().undo('git', root, 'main', head);
  expect(await git('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  await expect(git('rev-parse', '--verify', 'HEAD')).rejects.toThrow();
  expect(await git('write-tree')).toBe(index);
  expect(await git('diff', '--cached', '--name-only')).toBe('file.ts');
});

test('undo refuses a different branch or an in-progress merge before changing any ref', async () => {
  const { root, git, write } = await reviewFixture();
  const head = await git('rev-parse', 'HEAD');
  const commands = new GitCommands();
  await expect(commands.undo('git', root, 'other', head)).rejects.toThrow('分支已变化');
  await write('.git/MERGE_HEAD', head);
  await expect(commands.undo('git', root, 'main', head)).rejects.toThrow('合并');
  expect(await git('rev-parse', 'HEAD')).toBe(head);
});
