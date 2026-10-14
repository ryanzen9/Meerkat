import type { GitChangeKind, GitFileChange, GitRepositoryInfo } from './models';

// Numeric values from the built-in Git extension's public Status enum (API v1).
export function gitChangeKind(status: number): GitChangeKind {
  if (status >= 12) return 'conflict';
  if ([1, 4, 7, 9].includes(status)) return 'added';
  if ([2, 6].includes(status)) return 'deleted';
  if ([3, 10].includes(status)) return 'renamed';
  return 'modified';
}

export function uniqueChanges(repository: GitRepositoryInfo | undefined): GitFileChange[] {
  if (!repository) return [];
  const changes = new Map<string, GitFileChange>();
  const priority: Record<GitChangeKind, number> = {
    modified: 0,
    renamed: 1,
    added: 2,
    deleted: 3,
    conflict: 4,
  };
  // Count each file once, keeping additions, deletions and conflicts visible.
  for (const change of [...repository.changes, ...repository.stagedChanges]) {
    const previous = changes.get(change.uri);
    if (!previous || priority[change.kind] > priority[previous.kind])
      changes.set(change.uri, change);
  }
  return [...changes.values()];
}

export function changeCounts(repository: GitRepositoryInfo | undefined) {
  const changes = uniqueChanges(repository);
  return {
    total: changes.length,
    added: changes.filter(({ kind }) => kind === 'added').length,
    modified: changes.filter(({ kind }) => kind === 'modified' || kind === 'renamed').length,
    deleted: changes.filter(({ kind }) => kind === 'deleted').length,
    conflicts: changes.filter(({ kind }) => kind === 'conflict').length,
  };
}
