import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

export class GitCommandStateError extends Error {}

/** Small host-only commands missing from the public VS Code Git API. */
export class GitCommands {
  async run(
    executable: string,
    root: string,
    args: string[],
    allowedCodes = [0],
    timeout = 15000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        executable,
        ['--no-pager', '--literal-pathspecs', ...args],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout) => {
          if (error && !allowedCodes.includes(Number(error.code))) reject(error);
          else resolve(stdout.trimEnd());
        },
      );
    });
  }

  async unpublishedCount(executable: string, root: string, head: string): Promise<number> {
    const result = await this.run(executable, root, [
      'rev-list',
      '--count',
      head,
      '--not',
      '--remotes',
    ]);
    const count = Number(result);
    if (!/^\d+$/.test(result) || !Number.isSafeInteger(count)) throw new Error('Invalid Git count');
    return count;
  }

  async undo(executable: string, root: string, branch: string, head: string): Promise<void> {
    const directory = resolvePath(
      root,
      await this.run(executable, root, ['rev-parse', '--git-dir']),
    );
    const pending = await Promise.all(
      ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'].map(
        async (name) => {
          try {
            await access(resolvePath(directory, name));
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          }
        },
      ),
    );
    if (pending.some(Boolean))
      throw new GitCommandStateError('请先完成或中止当前合并、变基或挑拣操作，再撤销提交。');
    const currentBranch = await this.run(executable, root, ['symbolic-ref', '--quiet', 'HEAD']);
    if (currentBranch !== `refs/heads/${branch}`)
      throw new GitCommandStateError('当前分支已变化，请刷新后重试。');
    const parent = await this.run(executable, root, ['rev-list', '--parents', '-n', '1', head]);
    const [, previous] = parent.split(' ');
    // A compare-and-swap on the branch ref prevents a stale/repeated request from undoing
    // another commit. Like a soft reset, this leaves the index and worktree untouched.
    await this.run(
      executable,
      root,
      previous
        ? ['update-ref', '-m', 'meerkat: undo last commit', currentBranch, previous, head]
        : ['update-ref', '-d', currentBranch, head],
      [0],
      0,
    );
  }
}
