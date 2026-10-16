import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWatchLock } from '../scripts/watchLock';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'meerkat-watch-lock-'));
  folders.push(root);
  return { root, path: join(root, '.watch.lock') };
}

test('dead PID-only locks and interrupted recovery leases are reclaimed without residue', async () => {
  const { root, path } = await fixture();
  for (const suffix of ['', '.reclaim', '.reclaim.reclaim'])
    await writeFile(`${path}${suffix}`, '2147483647');
  const lock = await acquireWatchLock(path);
  try {
    expect(await Bun.file(path).json()).toMatchObject({ pid: process.pid });
    expect(await readdir(root)).toEqual(['.watch.lock']);
  } finally {
    await lock.release();
  }
  expect(await readdir(root)).toEqual([]);
});

test('a live PID-only owner is preserved and the error identifies its process', async () => {
  const { root, path } = await fixture();
  await writeFile(path, String(process.pid));
  await expect(acquireWatchLock(path)).rejects.toThrow(`Lock held by PID ${process.pid}`);
  expect(await Bun.file(path).text()).toBe(String(process.pid));
  expect(await readdir(root)).toEqual(['.watch.lock']);
});

test('release never removes a lock that has been replaced by a different owner token', async () => {
  const { path } = await fixture();
  const lock = await acquireWatchLock(path);
  const replacement = { pid: process.pid, token: 'replacement' };
  await writeFile(path, JSON.stringify(replacement));
  await lock.release();
  expect(await Bun.file(path).json()).toEqual(replacement);
});

test('empty or malformed legacy locks are preserved rather than assumed dead', async () => {
  const { root, path } = await fixture();
  for (const text of ['', 'broken', '{"pid":0}', '{"pid":"123"}', '2147483648']) {
    await writeFile(path, text);
    await expect(acquireWatchLock(path)).rejects.toThrow('Cannot determine the owner');
    expect(await Bun.file(path).text()).toBe(text);
    expect(await readdir(root)).toEqual(['.watch.lock']);
  }
});

test('a dead coordinator is not reclaimed until its recorded build process has exited', async () => {
  const { path } = await fixture();
  const build = Bun.spawn([process.execPath, '--eval', 'setTimeout(() => {}, 30000)'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const abandoned = { pid: 2147483647, token: 'abandoned', buildPid: build.pid };
  await writeFile(path, JSON.stringify(abandoned));
  let lock: Awaited<ReturnType<typeof acquireWatchLock>> | undefined;
  try {
    const pending = acquireWatchLock(path);
    await Bun.sleep(50);
    expect(await Bun.file(path).json()).toEqual(abandoned);
    build.kill();
    await build.exited;
    lock = await pending;
    expect(await Bun.file(path).json()).toMatchObject({ pid: process.pid });
  } finally {
    if (build.exitCode === null) build.kill(9);
    await build.exited;
    await lock?.release();
  }
});

test('filesystem failures retain their actual cause instead of reporting an active dev task', async () => {
  const { path } = await fixture();
  await writeFile(path, 'not a directory');
  await expect(acquireWatchLock(join(path, 'lock'))).rejects.toMatchObject({ code: 'ENOTDIR' });
});

async function firstLine(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('\n')) {
      const next = await reader.read();
      if (next.done) throw new Error(`Lock worker exited without a report: ${text}`);
      text += decoder.decode(next.value, { stream: true });
    }
    return text.split('\n')[0];
  } finally {
    reader.releaseLock();
  }
}

test('concurrent processes reclaiming the same stale lock admit exactly one live owner', async () => {
  const { root, path } = await fixture();
  await writeFile(path, '2147483647');
  await writeFile(`${path}.reclaim`, '2147483647');
  const modulePath = new URL('../scripts/watchLock.ts', import.meta.url).href;
  const source = `
    import { acquireWatchLock } from ${JSON.stringify(modulePath)};
    try {
      const lock = await acquireWatchLock(${JSON.stringify(path)});
      const finished = new Promise(resolve => {
        process.stdin.once('end', resolve);
        process.stdin.resume();
      });
      console.log('acquired');
      await finished;
      await lock.release();
    } catch (error) {
      console.log('blocked');
      console.error(error.message);
      process.exitCode = 1;
    }
  `;
  const workers = Array.from({ length: 4 }, () =>
    Bun.spawn([process.execPath, '--eval', source], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  try {
    const reports = await Promise.all(workers.map((worker) => firstLine(worker.stdout)));
    expect(reports.filter((report) => report === 'acquired')).toHaveLength(1);
    expect(reports.filter((report) => report === 'blocked')).toHaveLength(3);
    const winner = workers[reports.indexOf('acquired')]!;
    expect(await Bun.file(path).json()).toMatchObject({ pid: winner.pid });
    expect(await readdir(root)).toEqual(['.watch.lock']);
    for (const [index, worker] of workers.entries()) {
      if (worker === winner) continue;
      expect(await worker.exited).toBe(1);
      expect(reports[index]).toBe('blocked');
      expect(await new Response(worker.stderr).text()).toContain('Terminate the existing dev task');
    }
    await winner.stdin.end();
    expect(await winner.exited).toBe(0);
    expect(await readdir(root)).toEqual([]);
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill(9);
    await Promise.all(workers.map((worker) => worker.exited));
  }
});
