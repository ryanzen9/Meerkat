import { mkdir, open, readFile, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from '../errors';

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

export type Exclusive = <T>(operation: () => Promise<T>) => Promise<T>;

function missingProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
async function reclaim(path: string): Promise<void> {
  // Re-read the owner while holding a separate recovery lease: two windows
  // reclaiming the same dead PID must never unlink a newly acquired live lease.
  const recoveryPath = `${path}.reclaim`;
  let recovery: FileHandle;
  try {
    recovery = await open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return;
    throw error;
  }
  try {
    const owner = Number(await readFile(path, 'utf8').catch(() => ''));
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (missingProcess(error)) await rm(path, { force: true });
      }
    }
  } finally {
    await recovery.close();
    await rm(recoveryPath, { force: true });
  }
}

// The same credential vault may be shared by several VS Code windows. Serialize
// rotating refresh tokens across processes, then reload the vault inside the lease.
export function fileMutex(path: string): Exclusive {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 30_000;
      let handle: FileHandle;
      while (true) {
        try {
          handle = await open(path, 'wx', 0o600);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST')
            throw error;
          // Reclaim only a lease whose owning process has exited; never expire a live owner.
          await reclaim(path);
          if (Date.now() >= deadline)
            throw new BridgeError(
              'credentials_busy',
              'Credentials are in use by another window.',
              409,
            );
          await delay(100);
        }
      }
      try {
        await handle.writeFile(String(process.pid));
        return await operation();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    });
    queue = result.catch(() => undefined);
    return result;
  };
}
