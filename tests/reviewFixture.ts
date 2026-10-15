import { afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import type {
  ReviewDiagnostic,
  ReviewHostState,
  ReviewWorkspace,
} from '../src/extension/bridge/tools/reviewWorkspace';
import { runCommand } from './projectFixture';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

export async function reviewFixture(
  initial: Record<string, string | Buffer> = { 'file.ts': 'one\ntwo\nthree\n' },
) {
  const root = await mkdtemp(join(tmpdir(), 'review-tools-'));
  folders.push(root);
  const git = async (...args: string[]) => {
    const result = await runCommand(root, ['git', '-c', 'core.fsmonitor=false', ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trimEnd();
  };
  const write = async (path: string, text: string | Buffer) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.name', 'Review fixture');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.autocrlf', 'false');
  for (const [path, text] of Object.entries(initial)) await write(path, text);
  if (Object.keys(initial).length) {
    await git('add', '.');
    await git('commit', '-m', 'initial');
  }
  const state: ReviewHostState = {
    trusted: true,
    workspaceFolders: [{ name: 'fixture', path: root }],
    repositories: [root],
    activeFile: {
      path: join(root, 'file.ts'),
      languageId: 'typescript',
      selection: { start: { line: 2, column: 1 }, end: { line: 3, column: 2 } },
    },
    dirtyDocuments: [],
  };
  const diagnostics: ReviewDiagnostic[] = [];
  const workspace: ReviewWorkspace = {
    getState: async () => state,
    async findFiles(_root, glob, limit) {
      const paths = (await git('ls-files', '--cached', '--others', '--exclude-standard', '-z'))
        .split('\0')
        .filter(Boolean);
      return [...new Set(paths)]
        .toSorted()
        .filter((path) => new Bun.Glob(glob).match(path))
        .slice(0, limit);
    },
    getDiagnostics: (paths) => diagnostics.filter((diagnostic) => paths.includes(diagnostic.path)),
  };
  return { root, git, write, state, workspace, diagnostics, context: new ReviewContext(workspace) };
}
