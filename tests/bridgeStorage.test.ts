import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileMutex } from '../src/extension/bridge/auth/storage';

test('independent credential mutexes serialize access and safely reclaim a dead owner', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bridge-lock-'));
  try {
    const path = join(folder, 'oauth.lock');
    await writeFile(path, '2147483647');
    const locks = [fileMutex(path), fileMutex(path), fileMutex(path)];
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      locks.map((exclusive) =>
        exclusive(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(3);
          active--;
        }),
      ),
    );
    expect(maxActive).toBe(1);
    expect(await Bun.file(path).exists()).toBe(false);
    const error = Object.assign(new Error('Storage failed'), { code: 'EEXIST' });
    await expect(
      locks[0]!(async () => {
        throw error;
      }),
    ).rejects.toThrow('Storage failed');
    expect(await locks[0]!(async () => 42)).toBe(42);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
