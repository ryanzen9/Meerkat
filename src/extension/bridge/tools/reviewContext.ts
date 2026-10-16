import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { BridgeError } from '../errors';
import {
  captureReview,
  diskFile,
  inside,
  ReviewGit,
  reviewError,
  reviewPath,
  snapshotPatch,
  MAX_FILE_BYTES,
} from './reviewGit';
import type { ReviewSnapshot } from './reviewGit';
import type {
  DiffHunk,
  FileReference,
  FileReferenceRange,
  FileReferenceTarget,
  FileVersion,
  ReviewHostState,
  ReviewScope,
  ReviewToolContext,
  ReviewWorkspace,
  WholeFileReference,
} from './reviewWorkspace';

const PAGE_CHARS = 24000;
const MAX_SNAPSHOTS = 4;
const SNAPSHOT_TTL = 15 * 60 * 1000;
const MAX_FILE_REFERENCES = 1000;
const SNAPSHOT_SOURCES: Record<ReviewScope, Record<FileVersion, string>> = {
  staged: { old: 'HEAD', new: 'Git index' },
  'working-tree': { old: 'Git index', new: 'captured working tree and unsaved buffers' },
  all: { old: 'HEAD', new: 'captured working tree and unsaved buffers' },
  branch: { old: 'merge base', new: 'HEAD' },
};
const CONFIG_GLOB =
  '**/{AGENTS.md,package.json,bun.lock,bunfig.toml,tsconfig*.json,jsconfig.json,pyproject.toml,Cargo.toml,go.mod,pom.xml,build.gradle*,CMakeLists.txt,*.sln,*.csproj,vite.config.*,vitest.config.*,eslint.config.*,biome.json,.eslintrc*,.vscode/settings.json}';

function pageHunks(patch: string, start: number, end: number) {
  const hunks: DiffHunk[] = [];
  let offset = 0,
    oldLine = 0,
    newLine = 0;
  let hunk: (typeof hunks)[number] | undefined;
  for (const raw of patch.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (match) {
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: raw,
        oldStart: oldLine,
        oldCount: Number(match[2] ?? 1),
        newStart: newLine,
        newCount: Number(match[4] ?? 1),
        lines: [],
      };
      continue;
    }
    if (!hunk || !raw) continue;
    const kind =
      raw[0] === '+' ? 'added' : raw[0] === '-' ? 'removed' : raw[0] === ' ' ? 'context' : 'marker';
    const oldNumber = kind === 'added' || kind === 'marker' ? null : oldLine++;
    const newNumber = kind === 'removed' || kind === 'marker' ? null : newLine++;
    if (offset <= start || lineStart >= end) continue;
    if (!hunks.includes(hunk)) hunks.push(hunk);
    hunk.lines.push({
      type: kind,
      oldLine: oldNumber,
      newLine: newNumber,
      text: raw.slice(Math.max(1, start - lineStart), Math.min(raw.length, end - lineStart)),
      partial: start > lineStart || end < lineStart + raw.length,
    });
  }
  return hunks;
}

export class ReviewContext implements ReviewToolContext {
  private readonly snapshots = new Map<string, ReviewSnapshot>();
  private readonly fileReferences = new Map<string, Map<string, FileReference>>();
  constructor(private readonly workspace: ReviewWorkspace) {}

  private async state(signal?: AbortSignal): Promise<ReviewHostState> {
    signal?.throwIfAborted();
    const state = await this.workspace.getState();
    signal?.throwIfAborted();
    if (!state.trusted)
      reviewError('workspace_untrusted', 'Trust the workspace before reading review context.');
    return state;
  }

  private repository(state: ReviewHostState): string {
    const activePath = state.activeFile?.path;
    const candidates = activePath
      ? state.repositories.filter((root) => inside(root, activePath))
      : [];
    const root =
      candidates.reduce<string | undefined>(
        (longest, item) => (!longest || item.length > longest.length ? item : longest),
        undefined,
      ) ?? (state.repositories.length === 1 ? state.repositories[0] : undefined);
    if (!root)
      reviewError(
        'repository_unavailable',
        'Open a file in the repository to select a review project.',
      );
    return root;
  }

  private git(root: string): ReviewGit {
    return new ReviewGit(root, this.workspace.gitPath);
  }

  async getReviewContext(signal?: AbortSignal) {
    const state = await this.state(signal);
    let root: string | null = null;
    try {
      root = this.repository(state);
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== 'repository_unavailable') throw error;
    }
    const git = root ? this.git(root) : null;
    const head = git ? await git.head(signal) : null;
    const branch = git
      ? (await git.text(['symbolic-ref', '--quiet', '--short', 'HEAD'], signal, [0, 1])) || null
      : null;
    const configs = root ? await this.workspace.findFiles(root, CONFIG_GLOB, 101, signal) : [];
    return {
      workspaceFolders: state.workspaceFolders,
      repositories: state.repositories,
      repository: root ? { root, branch, head } : null,
      activeFile: state.activeFile,
      unsavedFiles: state.unsavedFiles ?? state.dirtyDocuments.map(({ path }) => ({ path })),
      configurationFiles: configs.slice(0, 100),
      configurationFilesTruncated: configs.length > 100,
      coordinates: 'Lines and columns are 1-based; range ends are exclusive.',
    };
  }

  async listChanges(
    input: { scope: ReviewScope; baseRef?: string | undefined },
    signal?: AbortSignal,
  ) {
    const state = await this.state(signal);
    const snapshot = await captureReview(
      this.git(this.repository(state)),
      input.scope,
      input.baseRef,
      state,
      signal,
    );
    signal?.throwIfAborted();
    this.prune();
    while (this.snapshots.size >= MAX_SNAPSHOTS)
      this.deleteSnapshot(this.snapshots.keys().next().value!);
    this.snapshots.set(snapshot.id, snapshot);
    return {
      reviewId: snapshot.id,
      createdAt: snapshot.createdAt,
      expiresAt: new Date(Date.parse(snapshot.createdAt) + SNAPSHOT_TTL).toISOString(),
      repository: snapshot.root,
      head: snapshot.head,
      base: snapshot.base,
      scope: snapshot.scope,
      changes: snapshot.changes,
    };
  }

  private prune() {
    for (const [id, snapshot] of this.snapshots) {
      if (Date.now() - Date.parse(snapshot.createdAt) >= SNAPSHOT_TTL) this.deleteSnapshot(id);
    }
  }

  private deleteSnapshot(id: string) {
    this.snapshots.delete(id);
    this.fileReferences.delete(id);
  }

  private async snapshot(id: string, signal?: AbortSignal): Promise<ReviewSnapshot> {
    const state = await this.state(signal);
    this.prune();
    const snapshot = this.snapshots.get(id);
    if (!snapshot)
      reviewError(
        'review_not_found',
        'Review snapshot expired or is unknown. Call list_changes again.',
      );
    if (!state.repositories.includes(snapshot.root))
      reviewError('repository_unavailable', 'The snapshot repository is no longer open.');
    return snapshot;
  }

  async getDiff(
    input: { reviewId: string; paths: string[]; cursor?: string | undefined },
    signal?: AbortSignal,
  ) {
    const snapshot = await this.snapshot(input.reviewId, signal);
    const paths = [...new Set(input.paths.map(reviewPath))];
    const changes = paths
      .map((path) => {
        const change = snapshot.changes.find((item) => item.path === path || item.oldPath === path);
        if (!change) reviewError('change_not_found', 'Requested path is not in this review.');
        return change;
      })
      .filter((change, index, all) => all.indexOf(change) === index);
    const key = createHash('sha256').update(JSON.stringify(paths)).digest('hex');
    let file = 0,
      offset = 0;
    if (input.cursor) {
      try {
        const cursor: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (!cursor || typeof cursor !== 'object') throw new Error();
        const value = cursor as Record<string, unknown>;
        if (
          value.id !== snapshot.id ||
          value.key !== key ||
          !Number.isInteger(value.file) ||
          !Number.isInteger(value.offset)
        )
          throw new Error();
        file = value.file as number;
        offset = value.offset as number;
        if (file < 0 || file >= changes.length || offset < 0) throw new Error();
      } catch {
        reviewError('cursor_invalid', 'Cursor does not belong to these review paths.');
      }
    }
    const change = changes[file]!;
    const patch = await snapshotPatch(this.git(snapshot.root), snapshot, change, signal);
    if (offset >= patch.length)
      reviewError('cursor_invalid', 'Cursor offset is outside the patch.');
    let end = Math.min(patch.length, offset + PAGE_CHARS);
    if (end < patch.length) {
      const newline = patch.lastIndexOf('\n', end - 1);
      if (newline >= offset) end = newline + 1;
    }
    const complete = end === patch.length;
    const nextFile = complete ? file + 1 : file;
    const nextCursor =
      nextFile < changes.length
        ? Buffer.from(
            JSON.stringify({ id: snapshot.id, key, file: nextFile, offset: complete ? 0 : end }),
          ).toString('base64url')
        : null;
    return {
      reviewId: snapshot.id,
      files: [
        {
          ...change,
          binary: patch.includes('\nBinary files '),
          patch: patch.slice(offset, end),
          patchOffset: offset,
          patchComplete: offset === 0 && complete,
          patchEnd: complete,
          hunks: pageHunks(patch, offset, end),
        },
      ],
      truncated: nextCursor !== null,
      nextCursor,
    };
  }

  async readFile(
    input: {
      reviewId: string;
      path: string;
      version: FileVersion;
      startLine: number;
      endLine: number;
    },
    signal?: AbortSignal,
  ) {
    const snapshot = await this.snapshot(input.reviewId, signal);
    const path = reviewPath(input.path);
    if (input.endLine < input.startLine || input.endLine - input.startLine >= 500)
      reviewError('range_invalid', 'Request 1 to 500 lines with endLine >= startLine.');
    const source = (await this.fileContent(snapshot, path, input.version, signal)).split('\n');
    if (source.at(-1) === '') source.pop();
    if (input.startLine > source.length && source.length !== 0)
      reviewError('range_invalid', 'startLine is past the end of the file.');
    const lines = [];
    let budget = PAGE_CHARS;
    let contentTruncated = false;
    for (let index = input.startLine - 1; index < Math.min(source.length, input.endLine); index++) {
      const text = source[index]!;
      if (text.length > budget && lines.length) break;
      lines.push({ line: index + 1, text: text.slice(0, budget) });
      contentTruncated ||= text.length > budget;
      budget -= Math.min(text.length, budget);
      if (budget === 0) break;
    }
    const endLine = lines.at(-1)?.line ?? 0;
    return {
      reviewId: snapshot.id,
      path,
      version: input.version,
      startLine: input.startLine,
      endLine,
      totalLines: source.length,
      lines,
      truncated: contentTruncated || endLine < Math.min(input.endLine, source.length),
      contentTruncated,
      nextStartLine: endLine && endLine < source.length ? endLine + 1 : null,
    };
  }

  private async fileContent(
    snapshot: ReviewSnapshot,
    path: string,
    version: FileVersion,
    signal?: AbortSignal,
  ): Promise<string> {
    const entry = snapshot[version].get(path);
    if (!entry) {
      const otherVersion = version === 'new' ? 'old' : 'new';
      reviewError(
        'file_not_found',
        [
          `File ${JSON.stringify(path)} does not exist in version "${version}" of the "${snapshot.scope}" review snapshot (${SNAPSHOT_SOURCES[snapshot.scope][version]}).`,
          snapshot.scope === 'staged' && version === 'new'
            ? 'Untracked files and unstaged new files are excluded.'
            : undefined,
          snapshot[otherVersion].has(path)
            ? `This path exists in version "${otherVersion}"; check whether the request needs that side.`
            : undefined,
          'search_code searches live files; its matches may be absent from this snapshot.',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
    if (entry.mode === '160000')
      reviewError('file_unsupported', 'Submodule entries do not contain source text.');
    const content = await this.git(snapshot.root).content(entry, signal);
    if (content.includes(0))
      reviewError('file_binary', 'Binary files cannot be read as source text.');
    signal?.throwIfAborted();
    return content.toString('utf8');
  }

  async citeFiles(
    input: { reviewId: string; references: FileReferenceTarget[] },
    signal?: AbortSignal,
  ): Promise<{ references: FileReference[] }> {
    const snapshot = await this.snapshot(input.reviewId, signal);
    if (!input.references.length || input.references.length > 20)
      reviewError('references_invalid', 'Request 1 to 20 file references.');
    const references: FileReference[] = [];
    for (const target of input.references) {
      const path = reviewPath(target.path);
      let location: WholeFileReference | (FileReferenceRange & { scope: 'range' });
      if (target.scope === 'file') {
        if ('startLine' in target || 'endLine' in target)
          reviewError('reference_scope_invalid', 'Whole-file references must omit line fields.');
        await this.fileContent(snapshot, path, target.version, signal);
        location = { path, version: target.version, scope: 'file' };
      } else {
        if (target.scope !== undefined && target.scope !== 'range')
          reviewError('reference_scope_invalid', 'Use file or range reference scope.');
        if (
          !Number.isSafeInteger(target.startLine) ||
          !Number.isSafeInteger(target.endLine) ||
          target.startLine < 1 ||
          target.endLine < target.startLine ||
          target.endLine - target.startLine >= 500
        )
          reviewError('range_invalid', 'Request 1 to 500 lines with endLine >= startLine.');
        const file = await this.readFile({ ...target, path, reviewId: snapshot.id }, signal);
        if (target.endLine > file.totalLines)
          reviewError('range_invalid', 'The entire reference range must exist in the file.');
        if (file.truncated)
          reviewError(
            'reference_truncated',
            'Reference content is truncated. Select a smaller range.',
          );
        location = {
          path,
          version: target.version,
          scope: 'range',
          startLine: target.startLine,
          endLine: target.endLine,
        };
      }
      // Keep legacy range identities stable; whole-file identities are a distinct target.
      const identity =
        location.scope === 'file'
          ? [snapshot.id, path, location.version, 'file']
          : [snapshot.id, path, location.version, location.startLine, location.endLine];
      const referenceId = `ref_${createHash('sha256')
        .update(JSON.stringify(identity))
        .digest('hex')}`;
      const displayPath = path.replace(/[\r\n\t]/g, (character) =>
        character === '\r' ? '\\r' : character === '\n' ? '\\n' : '\\t',
      );
      const lineLabel =
        location.scope === 'file'
          ? ''
          : `:${location.startLine}${location.endLine === location.startLine ? '' : `–${location.endLine}`}`;
      const label = `${displayPath}${lineLabel}${location.version === 'old' ? ' (old)' : ''}`;
      const escapedLabel = label.replace(/[\\`*_[\]<>!|(){}]/g, '\\$&');
      references.push({
        ...location,
        referenceId,
        reviewId: snapshot.id,
        repository: snapshot.root,
        label,
        markdown: `[${escapedLabel}](review-file:${referenceId})`,
      });
    }
    // Validate the whole batch before publishing anything, including after async reads.
    await this.snapshot(snapshot.id, signal);
    const registered = this.fileReferences.get(snapshot.id) ?? new Map<string, FileReference>();
    const newIds = new Set(references.map(({ referenceId }) => referenceId));
    for (const id of registered.keys()) newIds.delete(id);
    if (registered.size + newIds.size > MAX_FILE_REFERENCES)
      reviewError('reference_limit', 'Review exceeds 1,000 file references. Create a new review.');
    for (const reference of references) registered.set(reference.referenceId, { ...reference });
    this.fileReferences.set(snapshot.id, registered);
    return { references };
  }

  async getFileReference(referenceId: string, signal?: AbortSignal): Promise<FileReference> {
    await this.state(signal);
    this.prune();
    for (const references of this.fileReferences.values()) {
      const reference = references.get(referenceId);
      if (!reference) continue;
      await this.snapshot(reference.reviewId, signal);
      return { ...reference };
    }
    return reviewError(
      'reference_not_found',
      'File reference expired or is unknown. Call cite_files again.',
    );
  }

  async readFileReference(referenceId: string, signal?: AbortSignal) {
    const reference = await this.getFileReference(referenceId, signal);
    const snapshot = await this.snapshot(reference.reviewId, signal);
    const content = await this.fileContent(snapshot, reference.path, reference.version, signal);
    // Preserve exact text, including CRLF and the final newline, for editor comparison.
    await this.snapshot(reference.reviewId, signal);
    return { reference, content };
  }

  async searchCode(
    input: { query: string; glob?: string | undefined; limit?: number | undefined },
    signal?: AbortSignal,
  ) {
    const state = await this.state(signal);
    const root = this.repository(state);
    const limit = input.limit ?? 50;
    const files = await this.workspace.findFiles(root, input.glob ?? '**/*', 2001, signal);
    const matches: {
      path: string;
      line: number;
      column: number;
      text: string;
      context: { line: number; text: string }[];
    }[] = [];
    const dirty = new Map(state.dirtyDocuments.map((item) => [item.path, item.text]));
    let skippedFiles = 0;
    for (const path of files.slice(0, 2000)) {
      signal?.throwIfAborted();
      let text: string;
      try {
        const data = await diskFile(root, path);
        if (data.includes(0)) {
          skippedFiles++;
          continue;
        }
        // Validate the disk path before reading an unsaved overlay as well.
        text = dirty.get(`${root}${sep}${path.split('/').join(sep)}`) ?? data.toString('utf8');
        if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
          skippedFiles++;
          continue;
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (
          error instanceof BridgeError ||
          ['ENOENT', 'EACCES', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        ) {
          skippedFiles++;
          continue;
        }
        throw error;
      }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index++) {
        const column = lines[index]!.indexOf(input.query);
        if (column < 0) continue;
        if (matches.length === limit)
          return { repository: root, matches, truncated: true, skippedFiles };
        const start = Math.max(0, column - 150);
        matches.push({
          path,
          line: index + 1,
          column: column + 1,
          text: lines[index]!.slice(start, start + 600),
          context: lines.slice(Math.max(0, index - 1), index + 2).map((line, delta) => ({
            line: Math.max(0, index - 1) + delta + 1,
            text: line.slice(0, 600),
          })),
        });
      }
    }
    return { repository: root, matches, truncated: files.length > 2000, skippedFiles };
  }

  async getDiagnostics(input: { paths: string[] }, signal?: AbortSignal) {
    const state = await this.state(signal);
    const root = this.repository(state);
    const paths = input.paths.map(
      (path) => `${root}${sep}${reviewPath(path).split('/').join(sep)}`,
    );
    const diagnostics = this.workspace.getDiagnostics(paths);
    return {
      repository: root,
      diagnostics: diagnostics.slice(0, 200).map((item) => ({
        ...item,
        path: relative(root, item.path).split(sep).join('/'),
        message: item.message.slice(0, 4000),
      })),
      truncated: diagnostics.length > 200,
    };
  }

  dispose() {
    this.snapshots.clear();
    this.fileReferences.clear();
  }
}
