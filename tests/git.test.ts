import { expect, test } from 'bun:test';
import { changeCounts, gitChangeKind } from '../src/shared/git';
import type { GitRepositoryInfo } from '../src/shared/models';

test('public Git status values distinguish additions, deletions, renames, and all conflicts', () => {
  for (const status of [1, 4, 7, 9]) expect(gitChangeKind(status)).toBe('added');
  for (const status of [2, 6]) expect(gitChangeKind(status)).toBe('deleted');
  for (const status of [3, 10]) expect(gitChangeKind(status)).toBe('renamed');
  for (const status of [0, 5, 11]) expect(gitChangeKind(status)).toBe('modified');
  for (const status of [12, 13, 14, 15, 16, 17, 18]) expect(gitChangeKind(status)).toBe('conflict');
});

test('file counts deduplicate partially staged files and retain conflict information', () => {
  const repository: GitRepositoryInfo = {
    rootUri: 'file:///repo',
    name: 'repo',
    branch: 'main',
    remotes: [],
    changes: [
      { uri: 'file:///repo/new.ts', path: 'new.ts', kind: 'modified' },
      { uri: 'file:///repo/conflict.ts', path: 'conflict.ts', kind: 'conflict' },
      { uri: 'file:///repo/deleted.ts', path: 'deleted.ts', kind: 'deleted' },
    ],
    stagedChanges: [
      { uri: 'file:///repo/new.ts', path: 'new.ts', kind: 'added' },
      { uri: 'file:///repo/conflict.ts', path: 'conflict.ts', kind: 'modified' },
      { uri: 'file:///repo/renamed.ts', path: 'renamed.ts', kind: 'renamed' },
      { uri: 'file:///repo/deleted.ts', path: 'deleted.ts', kind: 'modified' },
    ],
  };
  expect(changeCounts(repository)).toEqual({
    total: 4,
    added: 1,
    modified: 1,
    deleted: 1,
    conflicts: 1,
  });
  expect(changeCounts(undefined).total).toBe(0);
});
