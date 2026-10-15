import { cp, mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function createProjectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'review-bot-build-'));
  await Promise.all(
    [
      'src',
      'webview',
      'scripts',
      'resources',
      'package.json',
      'vite.config.ts',
      'tsconfig.json',
      'tsconfig.base.json',
      'tsconfig.extension.json',
      'bunfig.toml',
      'bun.lock',
      '.vscodeignore',
      'README.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'CHANGELOG.md',
    ].map((path) =>
      cp(join(projectRoot, path), join(root, path), {
        recursive: true,
        filter: (source) => !source.split(/[\\/]/).includes('node_modules'),
      }),
    ),
  );
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  await symlink(
    join(projectRoot, 'webview/node_modules'),
    join(root, 'webview/node_modules'),
    'junction',
  );
  return root;
}

export async function runCommand(root: string, command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export async function runBuild(root: string, target: 'extension' | 'webview', development = false) {
  const result = await runCommand(root, [
    process.execPath,
    'run',
    `build:${target}`,
    ...(development ? ['--mode', 'development'] : []),
  ]);
  if (result.exitCode !== 0) throw new Error(result.stdout + result.stderr);
}
