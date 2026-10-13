import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension, projectRoot } from './build-extension';

// Poll a small source tree. Native fs.watch/Rolldown watchers are unreliable on
// mounted/network volumes; this detects new files and atomic editor saves too.
async function fingerprint(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) return `${path}:${info.mtimeMs}:${info.size}`;
  const entries = await readdir(path, { withFileTypes: true });
  const children = await Promise.all(
    entries
      .filter((entry) => !entry.isSymbolicLink())
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((entry) => fingerprint(join(path, entry.name))),
  );
  return children.join('|');
}

async function fingerprints() {
  const [extension, shared, webview, config] = await Promise.all([
    fingerprint(join(projectRoot, 'src/extension')),
    fingerprint(join(projectRoot, 'src/shared')),
    fingerprint(join(projectRoot, 'src/webview')),
    fingerprint(join(projectRoot, 'vite.config.ts')),
  ]);
  return { extension: `${extension}|${shared}`, webview: `${webview}|${shared}|${config}` };
}

async function buildWebview(): Promise<void> {
  const child = Bun.spawn(
    [
      'node',
      fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
      'build',
      '--mode',
      'development',
    ],
    { cwd: projectRoot, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await child.exited) !== 0) throw new Error('Webview build failed');
}

console.log('[watch] starting');
let previous = await fingerprints();
await buildExtension();
await buildWebview();
console.log('[watch] ready');

let running = false;
let stopping = false;
const poll = setInterval(() => {
  if (running || stopping) return;
  running = true;
  void (async () => {
    try {
      const current = await fingerprints();
      const extensionChanged = current.extension !== previous.extension;
      const webviewChanged = current.webview !== previous.webview;
      previous = current;
      if (extensionChanged) await buildExtension();
      if (webviewChanged) await buildWebview();
    } catch (error) {
      console.error(error);
    } finally {
      running = false;
      if (stopping) process.exit(0);
    }
  })();
}, 500);

const shutdown = () => {
  stopping = true;
  clearInterval(poll);
  if (!running) process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
