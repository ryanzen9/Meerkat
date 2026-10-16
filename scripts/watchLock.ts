import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

interface Owner {
  pid: number;
  token?: string;
  buildPid?: number;
}

export interface WatchLock {
  release(): Promise<void>;
  setBuild(pid: number | undefined): Promise<void>;
}

class WatchLockBusyError extends Error {}

const hasCode = (error: unknown, code: string) =>
  error instanceof Error && 'code' in error && error.code === code;

const isPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647;

async function readOwner(path: string): Promise<Owner | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    // Accept PID-only locks left by earlier versions of the watcher.
    const value: unknown = JSON.parse(text);
    if (isPid(value)) return { pid: value };
    if (
      typeof value === 'object' &&
      value !== null &&
      'pid' in value &&
      isPid(value.pid) &&
      'token' in value &&
      typeof value.token === 'string' &&
      value.token.length > 0 &&
      (!('buildPid' in value) || isPid(value.buildPid))
    )
      return {
        pid: value.pid,
        token: value.token,
        ...('buildPid' in value ? { buildPid: value.buildPid as number } : {}),
      };
  } catch {
    // An unreadable owner cannot safely be assumed to have exited.
  }
  throw new Error(
    `Cannot determine the owner of ${path}. Confirm dev has stopped before removing this lock.`,
  );
}

function liveOwner(owner: Owner): number | undefined {
  for (const pid of [owner.pid, owner.buildPid]) {
    if (pid === undefined) continue;
    try {
      process.kill(pid, 0);
      return pid;
    } catch (error) {
      // EPERM also means a process may still be alive; only ESRCH proves exit.
      if (hasCode(error, 'EPERM')) return pid;
      if (!hasCode(error, 'ESRCH')) throw error;
    }
  }
  return undefined;
}

async function publish(path: string, owner: Owner, replace = false): Promise<boolean> {
  const temporary = `${path}.${owner.pid}.${owner.token}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(owner));
    try {
      // Publish a complete record atomically: a crash cannot leave an empty
      // canonical lock between creating the file and writing its PID.
      if (replace) await rename(temporary, path);
      else await link(temporary, path);
      return true;
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false;
      throw error;
    }
  } finally {
    try {
      await file.close();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function acquire(path: string, owner: Owner, deadline: number): Promise<() => Promise<void>> {
  while (true) {
    if (await publish(path, owner))
      return async () => {
        const current = await readOwner(path);
        if (current?.token === owner.token && current?.pid === owner.pid)
          await rm(path, { force: true });
      };

    const current = await readOwner(path);
    if (!current) continue;
    const livePid = liveOwner(current);
    if (livePid !== undefined) {
      // A force-killed coordinator closes its build's stdin pipe. Give that
      // child time to exit before allowing a replacement to write the output.
      if (livePid !== current.pid && Date.now() < deadline) {
        await delay(25);
        continue;
      }
      throw new WatchLockBusyError(
        `Cannot start dev. Lock held by PID ${livePid}. Terminate the existing dev task first.`,
      );
    }

    // Serialize reclamation so a second starter cannot unlink the first one's
    // new live lock. Recovery leases use the same protocol: even a process
    // killed during recovery can be recovered on the next start.
    let release: () => Promise<void>;
    try {
      release = await acquire(`${path}.reclaim`, owner, deadline);
    } catch (error) {
      if (!(error instanceof WatchLockBusyError)) throw error;
      if (Date.now() >= deadline)
        throw new WatchLockBusyError(`Cannot start dev. Another startup is recovering ${path}.`);
      await delay(25);
      continue;
    }
    try {
      const latest = await readOwner(path);
      if (latest && liveOwner(latest) === undefined) await rm(path, { force: true });
    } finally {
      await release();
    }
  }
}

export async function acquireWatchLock(path: string): Promise<WatchLock> {
  const owner: Owner = { pid: process.pid, token: randomUUID() };
  const release = await acquire(path, owner, Date.now() + 3000);
  return {
    release,
    async setBuild(pid) {
      const current = await readOwner(path);
      if (!current || current.token !== owner.token || current.pid !== owner.pid)
        throw new Error(
          `Lost ownership of ${path}. Stop dev before cleaning its output directory.`,
        );
      if (pid === undefined) delete owner.buildPid;
      else owner.buildPid = pid;
      await publish(path, owner, true);
    },
  };
}
