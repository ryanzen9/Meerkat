import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireWatchLock } from './watchLock';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const targets = ['extension', 'webview'] as const;
type Target = (typeof targets)[number];
const targetFiles: Record<Target, string[]> = {
  extension: ['src/extension', 'vite.config.ts', 'tsconfig.extension.json'],
  webview: [
    'webview/src',
    'webview/package.json',
    'webview/vite.config.ts',
    'webview/tsconfig.json',
  ],
};

let stopping = false;
let activeBuild: { kill(signal?: number): void } | undefined;
let killTimeout: ReturnType<typeof setTimeout> | undefined;

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  if (activeBuild) {
    activeBuild.kill();
    killTimeout = setTimeout(() => activeBuild?.kill(9), 2000);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

// Poll a small source tree. Native fs.watch/Rolldown watchers are unreliable on
// mounted/network volumes; this detects new files and atomic editor saves too.
async function fingerprint(path: string): Promise<string> {
  const info = await stat(path).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return `${path}:missing`;
  if (!info.isDirectory()) return `${path}:${info.mtimeMs}:${info.size}`;
  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((entry) => !entry.isSymbolicLink())
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((entry) => fingerprint(join(path, entry.name))),
  );
  return `${path}/|${children.join('|')}`;
}

async function fingerprints(): Promise<Record<Target, string>> {
  const common = await Promise.all(
    [
      'src/shared',
      'package.json',
      'bun.lock',
      'bunfig.toml',
      'tsconfig.base.json',
      'tsconfig.json',
    ].map((path) => fingerprint(join(projectRoot, path))),
  );
  const [extension, webview] = await Promise.all(
    targets.map(async (target) => {
      const files = await Promise.all(
        targetFiles[target].map((path) => fingerprint(join(projectRoot, path))),
      );
      return [...common, ...files].join('|');
    }),
  );
  return { extension: extension!, webview: webview! };
}

async function build(target: Target): Promise<void> {
  console.log(`[watch] building ${target}`);
  const targetRoot = target === 'webview' ? join(projectRoot, 'webview') : projectRoot;
  const child = Bun.spawn(
    [
      'node',
      join(projectRoot, 'scripts/watchBuild.mjs'),
      join(targetRoot, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      'vite.config.ts',
      '--mode',
      'development',
    ],
    { cwd: targetRoot, stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' },
  );
  activeBuild = child;
  try {
    await lock.setBuild(child.pid);
    if (stopping) child.kill();
    else {
      child.stdin.write('start\n');
      await child.stdin.flush();
    }
    const exitCode = await child.exited;
    if (stopping) return;
    if (exitCode !== 0) throw new Error(`${target} build failed (exit ${exitCode})`);
    console.log(`[watch] built ${target}`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    child.stdin.end();
    activeBuild = undefined;
    await lock.setBuild(undefined);
  }
}

await mkdir(join(projectRoot, 'dist'), { recursive: true });
const lockPath = join(projectRoot, 'dist/.watch.lock');
const lock = await acquireWatchLock(lockPath);

try {
  console.log('[watch] starting');
  const previous: Partial<Record<Target, string>> = {};
  const failed: Partial<Record<Target, string>> = {};
  let ready = false;

  // Signal handlers update this condition while builds or polling are awaited.
  // oxlint-disable-next-line no-unmodified-loop-condition
  while (!stopping) {
    try {
      const current = await fingerprints();
      let attempted = false;
      for (const target of targets) {
        if (stopping) break;
        if (current[target] === previous[target] || current[target] === failed[target]) continue;
        attempted = true;
        try {
          await build(target);
          if (!stopping) {
            previous[target] = current[target];
            delete failed[target];
          }
        } catch (error) {
          console.error(error);
          failed[target] = current[target];
        }
      }
      // Do not release F5 against stale output, including edits made during a build.
      const latest = await fingerprints();
      if (
        !stopping &&
        (attempted || !ready) &&
        targets.every((target) => previous[target] === latest[target])
      ) {
        ready = true;
        console.log('[watch] ready');
      }
    } catch (error) {
      console.error(error);
    }
    if (!stopping) await Bun.sleep(500);
  }
} finally {
  if (killTimeout) clearTimeout(killTimeout);
  await lock.release();
}
