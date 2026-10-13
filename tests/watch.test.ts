import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectFixture, runCommand } from './projectFixture';

function startWatcher(root: string) {
  // Launch the TS runner directly so signals address the coordinator itself.
  const child = Bun.spawn([process.execPath, 'scripts/watch.ts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  let stopped: Promise<number> | undefined;
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      output += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  };
  const collected = Promise.all([collect(child.stdout), collect(child.stderr)]);
  return {
    output: () => output,
    async waitFor(marker: string, offset = 0) {
      const deadline = Date.now() + 15000;
      while (!output.slice(offset).includes(marker)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`Watcher did not produce ${marker}:\n${output}`);
        await Bun.sleep(25);
      }
    },
    async stop() {
      stopped ??= (async () => {
        if (child.exitCode === null) child.kill();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            child.exited,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                if (child.exitCode === null) child.kill(9);
                reject(new Error('Watcher did not stop within 5 seconds'));
              }, 5000);
            }),
          ]);
          await collected;
          return result;
        } finally {
          clearTimeout(timeout);
        }
      })();
      return stopped;
    },
  };
}

test('watch rebuilds the right targets, tracks new files/config, and recovers from errors', async () => {
  const root = await createProjectFixture();
  const watcher = startWatcher(root);
  try {
    await watcher.waitFor('[watch] ready');
    expect(await Bun.file(join(root, 'dist/extension/extension.cjs.map')).exists()).toBe(true);
    expect(await Bun.file(join(root, 'dist/webview/main.js.map')).exists()).toBe(true);
    const duplicate = await runCommand(root, [process.execPath, 'scripts/watch.ts']);
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.stderr).toContain('Terminate the existing dev task first');

    const change = async (path: string, content: string, expected: string[]) => {
      const offset = watcher.output().length;
      await Bun.write(join(root, path), content);
      await watcher.waitFor('[watch] ready', offset);
      const cycle = watcher.output().slice(offset);
      for (const target of ['extension', 'webview']) {
        expect(cycle.includes(`[watch] built ${target}`)).toBe(expected.includes(target));
      }
    };
    const entryPath = 'src/extension/index.ts';
    const originalEntry = await Bun.file(join(root, entryPath)).text();
    const entry = `${originalEntry}\nconsole.log('watch-extension-marker');\n`;
    await change(entryPath, entry, ['extension']);
    expect(await Bun.file(join(root, 'dist/extension/extension.cjs')).text()).toContain(
      'watch-extension-marker',
    );
    const appPath = 'src/webview/App.tsx';
    const app = await Bun.file(join(root, appPath)).text();
    await change(appPath, app.replace('Review Bot 面板', 'watch-webview-marker'), ['webview']);
    expect(await Bun.file(join(root, 'dist/webview/main.js')).text()).toContain(
      'watch-webview-marker',
    );
    const sharedPath = 'src/shared/models.ts';
    await change(sharedPath, `${await Bun.file(join(root, sharedPath)).text()}\n// shared edit\n`, [
      'extension',
      'webview',
    ]);
    const extraPath = 'src/webview/watch-added.ts';
    await change(extraPath, 'export const added = true;', ['webview']);
    let offset = watcher.output().length;
    await rm(join(root, extraPath));
    await watcher.waitFor('[watch] ready', offset);
    expect(watcher.output().slice(offset)).toContain('[watch] built webview');
    for (const target of ['extension', 'webview']) {
      const path = `vite.config.${target}.ts`;
      await change(path, `${await Bun.file(join(root, path)).text()}\n// config edit\n`, [target]);
    }
    const tsconfigPath = 'tsconfig.extension.json';
    await change(tsconfigPath, `${await Bun.file(join(root, tsconfigPath)).text()}\n`, [
      'extension',
    ]);

    offset = watcher.output().length;
    await Bun.write(join(root, entryPath), `${entry}\nexport const broken = ;`);
    await watcher.waitFor('extension build failed', offset);
    expect(watcher.output().slice(offset)).not.toContain('[watch] ready');
    await change(entryPath, entry, ['extension']);
  } finally {
    expect(await watcher.stop()).toBe(0);
    expect(await Bun.file(join(root, 'dist/.watch.lock')).exists()).toBe(false);
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

test('an initial build failure keeps F5 waiting until the source is fixed', async () => {
  const root = await createProjectFixture();
  const entryPath = join(root, 'src/extension/index.ts');
  const entry = await Bun.file(entryPath).text();
  await Bun.write(entryPath, 'export const broken = ;');
  const watcher = startWatcher(root);
  try {
    await watcher.waitFor('extension build failed');
    await watcher.waitFor('[watch] built webview');
    await Bun.sleep(600);
    expect(watcher.output()).not.toContain('[watch] ready');
    await Bun.write(entryPath, entry);
    await watcher.waitFor('[watch] ready');
  } finally {
    expect(await watcher.stop()).toBe(0);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test('stopping during the first build terminates the Vite child and removes the lock', async () => {
  const root = await createProjectFixture();
  const configPath = join(root, 'vite.config.extension.ts');
  const config = await Bun.file(configPath).text();
  await Bun.write(
    configPath,
    config.replace(
      'publicDir: false,',
      `publicDir: false,
       plugins: [{ name: 'pause-build', async buildStart() {
         console.log('fixture-child-pid:' + process.pid);
         await new Promise(resolve => setTimeout(resolve, 30000));
       } }],`,
    ),
  );
  const watcher = startWatcher(root);
  try {
    await watcher.waitFor('fixture-child-pid:');
    const pid = Number(watcher.output().match(/fixture-child-pid:(\d+)/)?.[1]);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    expect(await watcher.stop()).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await Bun.file(join(root, 'dist/.watch.lock')).exists()).toBe(false);
  } finally {
    await watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
