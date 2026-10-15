import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  readlink,
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BridgeError } from '../errors';
import type { ReviewChange, ReviewHostState, ReviewScope } from './reviewWorkspace';

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 24 * MAX_FILE_BYTES;
const MAX_FILES = 20000;

export function reviewError(code: string, message: string): never {
  throw new BridgeError(code, message);
}

export function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

export function reviewPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '.' || part.toLowerCase() === '.git')
  )
    reviewError(
      'path_invalid',
      'Use a repository-relative path without traversal or Git metadata.',
    );
  return path;
}

export async function diskFile(root: string, path: string): Promise<Buffer> {
  reviewPath(path);
  const full = resolve(root, path);
  if (!inside(await realpath(root), await realpath(full)))
    reviewError('path_outside_repository', 'File resolves outside the repository.');
  const info = await lstat(full);
  if (!info.isFile()) reviewError('file_unsupported', 'Only regular files can be searched.');
  if (info.size > MAX_FILE_BYTES) reviewError('file_too_large', 'File exceeds the 1 MiB limit.');
  const data = await readFile(full);
  if (data.length > MAX_FILE_BYTES) reviewError('file_too_large', 'File exceeds the 1 MiB limit.');
  return data;
}

export class ReviewGit {
  constructor(
    readonly root: string,
    private readonly executable = 'git',
  ) {}

  async run(args: string[], signal?: AbortSignal, allowedCodes: number[] = [0]): Promise<Buffer> {
    signal?.throwIfAborted();
    return new Promise((accept, reject) => {
      execFile(
        this.executable,
        [
          '--no-pager',
          args[0] === 'check-ignore' ? '--no-literal-pathspecs' : '--literal-pathspecs',
          '-c',
          'core.fsmonitor=false',
          ...args,
        ],
        {
          cwd: this.root,
          encoding: 'buffer',
          maxBuffer: MAX_SNAPSHOT_BYTES,
          timeout: 15000,
          ...(signal ? { signal } : {}),
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout) => {
          if (signal?.aborted) return reject(signal.reason);
          if (error && !allowedCodes.includes(Number(error.code)))
            return reject(
              new BridgeError('git_failed', 'Unable to read Git data for this review.'),
            );
          accept(stdout);
        },
      );
    });
  }

  async text(args: string[], signal?: AbortSignal, allowedCodes?: number[]): Promise<string> {
    return (await this.run(args, signal, allowedCodes)).toString('utf8').trimEnd();
  }

  async head(signal?: AbortSignal): Promise<string | null> {
    return (await this.text(['rev-parse', '--verify', '--quiet', 'HEAD'], signal, [0, 1])) || null;
  }

  async tree(ref: string | null, signal?: AbortSignal): Promise<Map<string, Entry>> {
    if (!ref) return new Map();
    const entries = (await this.run(['ls-tree', '-rz', ref], signal)).toString('utf8').split('\0');
    const result = new Map<string, Entry>();
    for (const record of entries) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const [mode, , oid] = record.slice(0, tab).split(' ');
      result.set(record.slice(tab + 1), { mode: mode!, oid: oid! });
    }
    if (result.size > MAX_FILES)
      reviewError('review_too_large', 'Repository exceeds 20,000 files.');
    return result;
  }

  async content(entry: Entry, signal?: AbortSignal): Promise<Buffer> {
    if (entry.content) return entry.content;
    if (entry.mode === '160000') return Buffer.from(`Subproject commit ${entry.oid}\n`);
    const size = Number(await this.text(['cat-file', '-s', entry.oid], signal));
    if (size > MAX_FILE_BYTES) reviewError('file_too_large', 'File exceeds the 1 MiB limit.');
    return this.run(['cat-file', 'blob', entry.oid], signal);
  }
}

export interface Entry {
  mode: string;
  oid: string;
  content?: Buffer;
}

export interface ReviewSnapshot {
  id: string;
  createdAt: string;
  root: string;
  head: string | null;
  base: string | null;
  scope: ReviewScope;
  old: Map<string, Entry>;
  new: Map<string, Entry>;
  changes: ReviewChange[];
  patches: Map<string, string>;
}

export async function captureReview(
  git: ReviewGit,
  scope: ReviewScope,
  baseRef: string | undefined,
  state: ReviewHostState,
  signal?: AbortSignal,
): Promise<ReviewSnapshot> {
  const head = await git.head(signal);
  let base = head;
  if (scope === 'branch') {
    if (!head || !baseRef || baseRef.startsWith('-') || /[\0\r\n]/.test(baseRef))
      reviewError('base_ref_invalid', 'Branch reviews require an existing HEAD and baseRef.');
    const ref = await git.text(
      ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
      signal,
    );
    base = await git.text(['merge-base', head, ref], signal);
  } else if (baseRef !== undefined) {
    reviewError('base_ref_invalid', 'baseRef is only supported for branch reviews.');
  }
  const old = await git.tree(base, signal);
  let next: Map<string, Entry>;
  const conflicts = new Set<string>();
  if (scope === 'branch') {
    next = await git.tree(head, signal);
  } else {
    next = new Map();
    const records = (await git.run(['ls-files', '--stage', '-z'], signal))
      .toString('utf8')
      .split('\0');
    for (const record of records) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const [mode, oid, stage] = record.slice(0, tab).split(' ');
      const path = record.slice(tab + 1);
      if (stage !== '0') conflicts.add(path);
      if (stage === '0' || (stage === '2' && scope !== 'staged'))
        next.set(path, { mode: mode!, oid: oid! });
    }
    if (scope === 'working-tree') {
      old.clear();
      for (const [path, entry] of next) old.set(path, entry);
    }
    if (scope !== 'staged') {
      const paths = new Set(
        (await git.run(['ls-files', '-m', '-d', '-o', '--exclude-standard', '-z'], signal))
          .toString('utf8')
          .split('\0')
          .filter(Boolean),
      );
      const dirty = new Map<string, string>();
      for (const document of state.dirtyDocuments) {
        if (!inside(git.root, document.path)) continue;
        const path = relative(git.root, document.path).split(sep).join('/');
        reviewPath(path);
        // Include unsaved, newly created files unless Git excludes them.
        if (!next.has(path) && (await git.text(['check-ignore', '--', path], signal, [0, 1])))
          continue;
        dirty.set(path, document.text);
        paths.add(path);
      }
      if (paths.size > MAX_FILES) reviewError('review_too_large', 'Review exceeds 20,000 files.');
      const algorithm = await git.text(['rev-parse', '--show-object-format'], signal);
      let bytes = 0;
      for (const path of paths) {
        signal?.throwIfAborted();
        reviewPath(path);
        const parent = await realpath(dirname(join(git.root, path))).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          },
        );
        if (parent && !inside(await realpath(git.root), parent))
          reviewError('path_outside_repository', 'File parent resolves outside the repository.');
        let content: Buffer;
        let mode = next.get(path)?.mode ?? '100644';
        if (dirty.has(path)) {
          content = Buffer.from(dirty.get(path)!);
        } else {
          const full = join(git.root, path);
          let info;
          try {
            info = await lstat(full);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            next.delete(path);
            continue;
          }
          if (info.isDirectory()) {
            if (mode === '160000') {
              const commit = await git.text(['-C', full, 'rev-parse', '--verify', 'HEAD'], signal);
              next.set(path, { mode, oid: commit });
            }
            continue;
          }
          if (info.isSymbolicLink()) {
            content = Buffer.from(await readlink(full));
            mode = '120000';
          } else {
            content = await diskFile(git.root, path);
            mode = info.mode & 0o111 ? '100755' : '100644';
          }
        }
        bytes += content.length;
        if (content.length > MAX_FILE_BYTES || bytes > MAX_SNAPSHOT_BYTES)
          reviewError('review_too_large', 'Snapshot exceeds the 1 MiB file or 24 MiB total limit.');
        const oid = createHash(algorithm)
          .update(`blob ${content.length}\0`)
          .update(content)
          .digest('hex');
        next.set(path, { mode, oid, content });
      }
    }
  }
  if (next.size > MAX_FILES) reviewError('review_too_large', 'Repository exceeds 20,000 files.');
  const changes = new Map<string, ReviewChange>();
  for (const path of new Set([...old.keys(), ...next.keys(), ...conflicts])) {
    const before = old.get(path),
      after = next.get(path);
    if (before?.oid === after?.oid && before?.mode === after?.mode && !conflicts.has(path))
      continue;
    changes.set(path, {
      path,
      oldPath: before ? path : null,
      newPath: after ? path : null,
      status: conflicts.has(path)
        ? 'conflict'
        : !before
          ? 'added'
          : !after
            ? 'deleted'
            : before.mode.slice(0, 3) !== after.mode.slice(0, 3)
              ? 'type-changed'
              : 'modified',
    });
  }
  // Git's rename detection supplies edited renames as well as exact renames.
  const diffArgs = [
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--no-ext-diff',
    '--no-textconv',
  ];
  if (scope === 'branch') diffArgs.push(base!, head!);
  else if (scope === 'staged') diffArgs.push('--cached', ...(head ? [head] : []));
  else if (scope === 'all' && head) diffArgs.push(head);
  const statuses = (await git.run([...diffArgs, '--'], signal)).toString('utf8').split('\0');
  for (let i = 0; i < statuses.length - 1;) {
    const status = statuses[i++]!,
      path = statuses[i++]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = statuses[i++]!;
      if (
        status.startsWith('R') &&
        changes.get(path)?.status === 'deleted' &&
        changes.get(target)?.status === 'added'
      ) {
        changes.delete(path);
        changes.set(target, { path: target, oldPath: path, newPath: target, status: 'renamed' });
      }
    }
  }
  // An unsaved rename may not be visible to Git. Preserve exact content renames too.
  for (const change of changes.values()) {
    if (change.status !== 'added') continue;
    const deleted = [...changes.values()].find(
      (candidate) =>
        candidate.status === 'deleted' &&
        old.get(candidate.path)?.oid === next.get(change.path)?.oid,
    );
    if (deleted) {
      changes.delete(deleted.path);
      changes.set(change.path, { ...change, oldPath: deleted.path, status: 'renamed' });
    }
  }
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    root: git.root,
    head,
    base,
    scope,
    old,
    new: next,
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array with the ES2022 API.
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    patches: new Map(),
  };
}

function quotedPath(prefix: string, path: string): string {
  const value = prefix + path;
  return /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

export async function snapshotPatch(
  git: ReviewGit,
  snapshot: ReviewSnapshot,
  change: ReviewChange,
  signal?: AbortSignal,
): Promise<string> {
  const cached = snapshot.patches.get(change.path);
  if (cached !== undefined) return cached;
  if (snapshot.scope === 'staged' && change.status === 'conflict')
    reviewError(
      'index_unmerged',
      'Unmerged index entries have no staged patch. Use an all or working-tree snapshot to review conflict markers.',
    );
  const before = change.oldPath ? snapshot.old.get(change.oldPath) : undefined;
  const after = change.newPath ? snapshot.new.get(change.newPath) : undefined;
  const oldPath = quotedPath('a/', change.oldPath ?? change.path);
  const newPath = quotedPath('b/', change.newPath ?? change.path);
  let patch = `diff --git ${oldPath} ${newPath}\n`;
  if (!before) patch += `new file mode ${after!.mode}\n`;
  else if (!after) patch += `deleted file mode ${before.mode}\n`;
  else if (before.mode !== after.mode) patch += `old mode ${before.mode}\nnew mode ${after.mode}\n`;
  if (change.status === 'renamed')
    patch += `rename from ${quotedPath('', change.oldPath!)}\nrename to ${quotedPath('', change.newPath!)}\n`;
  const a = before ? await git.content(before, signal) : Buffer.alloc(0);
  const b = after ? await git.content(after, signal) : Buffer.alloc(0);
  if (!a.equals(b)) {
    // Git generates real unified hunks from captured bytes; no repository/index writes.
    const folder = await mkdtemp(join(tmpdir(), 'meerkat-diff-'));
    try {
      await mkdir(join(folder, 'old'));
      await mkdir(join(folder, 'new'));
      const oldFile = join(folder, 'old', 'file'),
        newFile = join(folder, 'new', 'file');
      await writeFile(oldFile, a);
      await writeFile(newFile, b);
      const raw = (
        await git.run(
          [
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--no-textconv',
            '--no-color',
            '--unified=3',
            '--',
            oldFile,
            newFile,
          ],
          signal,
          [0, 1],
        )
      ).toString('utf8');
      if (a.includes(0) || b.includes(0)) {
        patch += `Binary files ${before ? oldPath : '/dev/null'} and ${after ? newPath : '/dev/null'} differ\n`;
      } else {
        const hunk = raw.indexOf('\n@@ ');
        if (hunk >= 0)
          patch += `--- ${before ? oldPath : '/dev/null'}\n+++ ${after ? newPath : '/dev/null'}${raw.slice(hunk)}`;
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  snapshot.patches.set(change.path, patch);
  return patch;
}
