import * as vscode from 'vscode';
import { isAbsolute, posix, relative, sep } from 'node:path';
import type { GitSummary, GitSyncInfo } from '../../shared/models';
import { gitChangeKind } from '../../shared/git';
import { isRecord } from '../../shared/protocol';
import { GitCommands, GitCommandStateError } from './GitCommands';

// A structural subset of the built-in Git extension's public API v1.
// Extend from https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
// rather than importing private VS Code implementation modules.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri?: vscode.Uri;
  readonly renameUri?: vscode.Uri;
  readonly status: number;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD:
      | {
          readonly name?: string;
          readonly commit?: string;
          readonly upstream?: { readonly remote: string; readonly name: string };
          readonly ahead?: number;
          readonly behind?: number;
        }
      | undefined;
    readonly remotes: readonly { readonly name: string; readonly isReadOnly?: boolean }[];
    readonly rebaseCommit?: unknown;
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly mergeChanges: readonly GitChange[];
    readonly untrackedChanges: readonly GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  commit(message: string, options: { all: false; postCommitCommand: null }): Promise<void>;
  status(): Promise<void>;
  push(remoteName: string, branchName: string, setUpstream: boolean): Promise<void>;
}

export interface GitApi {
  readonly git?: { readonly path: string };
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export class GitOperationError extends Error {}

export function gitErrorMessage(error: unknown): string {
  if (error instanceof GitOperationError || error instanceof GitCommandStateError)
    return error.message;
  const code = isRecord(error) ? error.gitErrorCode : undefined;
  switch (code) {
    case 'NoUserNameConfigured':
    case 'NoUserEmailConfigured':
      return '请先配置 Git 的 user.name 和 user.email，再重试提交。';
    case 'UnmergedChanges':
      return '请先解决并暂存所有冲突，再提交。';
    case 'EmptyCommitMessage':
      return '请输入提交消息。';
    case 'PushRejected':
    case 'BranchFastForwardRejected':
      return '推送被拒绝，请先拉取并整合远程分支的更新后重试。';
    case 'AuthenticationFailed':
      return 'Git 远程认证失败，请更新 VS Code 的 Git 凭据后重试。';
    default:
      return gitHookErrorMessage(error) ?? 'Git 操作失败，请查看 VS Code 的 Git 输出，修复后重试。';
  }
}

function gitHookErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  // Recognize known diagnostics without exposing arbitrary hook output or credentials.
  const diagnostic = [error.stdout, error.stderr]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.slice(-16_384))
    .join('\n');
  const hook =
    /\bhusky\s*-\s*(pre-commit|commit-msg|pre-push)\s+(?:script failed|hook exited with code [1-9])/i
      .exec(diagnostic)?.[1]
      ?.toLowerCase();
  if (hook === 'pre-commit') {
    if (/\boxfmt\b/.test(diagnostic) && /Format issues found/i.test(diagnostic))
      return '提交被 pre-commit 校验拦截：文件格式检查未通过。请格式化相关文件并重新暂存后重试；详情见 VS Code 的 Git 输出。';
    return '提交被 pre-commit 校验拦截。请查看 VS Code 的 Git 输出，修复检查错误并重新暂存后重试。';
  }
  if (hook === 'commit-msg')
    return '提交消息未通过 commit-msg 校验，请按仓库的提交消息规范修改后重试；详情见 VS Code 的 Git 输出。';
  if (hook === 'pre-push')
    return '推送被 pre-push 校验拦截。请查看 VS Code 的 Git 输出，修复检查错误后重试。';
  return undefined;
}

export class GitService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watchedApi: GitApi | undefined;
  private apiListeners: vscode.Disposable[] = [];
  private repositoryListeners = new Map<GitRepository, vscode.Disposable>();
  private operations = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(
    private readonly output: vscode.LogOutputChannel,
    private readonly commands = new GitCommands(),
  ) {}

  async getApi(): Promise<GitApi | undefined> {
    if (!vscode.workspace.isTrusted) return undefined;
    const extension = vscode.extensions.getExtension<unknown>('vscode.git');
    if (!extension) return undefined;
    try {
      const exports: unknown = extension.isActive ? extension.exports : await extension.activate();
      if (!isRecord(exports) || exports.enabled !== true || typeof exports.getAPI !== 'function')
        return undefined;
      return (exports as unknown as GitExtensionExports).getAPI(1);
    } catch (error) {
      this.output.debug('Optional Git API unavailable', error);
      return undefined;
    }
  }

  async read(): Promise<GitSummary> {
    const api = await this.getApi();
    if (this.disposed) return { available: false, repositories: [] };
    this.watch(api);
    return {
      available: api !== undefined,
      repositories: await Promise.all(
        api?.repositories.map(async (repository) => {
          const { rootUri, state } = repository;
          const snapshot = {
            rootUri: rootUri.toString(),
            name: posix.basename(rootUri.path),
            branch: state.HEAD?.name ?? null,
            remotes: state.remotes.map(({ name }) => name),
            changes: this.changes(rootUri, [
              ...state.workingTreeChanges,
              ...state.untrackedChanges,
              ...state.mergeChanges,
            ]),
            stagedChanges: this.changes(rootUri, state.indexChanges),
          };
          return { ...snapshot, sync: await this.synchronization(repository, api.git?.path) };
        }) ?? [],
      ),
    };
  }

  async stage(repositoryUri: string, fileUri: string): Promise<void> {
    await this.mutate(repositoryUri, async (repository) => {
      const paths = this.filePaths(repository, fileUri, [
        ...repository.state.workingTreeChanges,
        ...repository.state.untrackedChanges,
        ...repository.state.mergeChanges,
      ]);
      await repository.add(paths);
    });
  }

  async unstage(repositoryUri: string, fileUri: string): Promise<void> {
    await this.mutate(repositoryUri, async (repository) => {
      const paths = this.filePaths(repository, fileUri, repository.state.indexChanges);
      // The public API calls unstaging "revert"; it preserves working tree contents.
      await repository.revert(paths);
    });
  }

  async stageAll(repositoryUri: string): Promise<void> {
    await this.mutate(repositoryUri, async (repository) => {
      // Unresolved merge entries require an explicit per-file resolution.
      const changes = [
        ...repository.state.workingTreeChanges,
        ...repository.state.untrackedChanges,
      ].filter(({ status }) => status !== 8 && status < 12);
      const paths = [...new Set(changes.flatMap((change) => this.changePaths(repository, change)))];
      if (paths.length) await repository.add(paths);
    });
  }

  async unstageAll(repositoryUri: string): Promise<void> {
    await this.mutate(repositoryUri, async (repository) => {
      if (repository.state.indexChanges.length) await repository.revert([]);
    });
  }

  async push(repositoryUri: string, branch: string, head: string): Promise<void> {
    await this.mutate(repositoryUri, async (repository) => {
      const current = this.pushHead(repository, branch, head);
      const upstreamRemote = current.upstream?.remote;
      const upstreamBranch = current.upstream?.name;
      const remotes = repository.state.remotes.filter((remote) => !remote.isReadOnly);
      if (!remotes.length) throw new GitOperationError('请先配置可写的 Git 远程仓库。');
      const remote =
        upstreamRemote ??
        (remotes.length === 1
          ? remotes[0]!.name
          : await vscode.window.showQuickPick(
              remotes.map(({ name }) => name),
              { placeHolder: '选择要推送到的 Git 远程仓库' },
            ));
      if (!remote) return;
      const validateTarget = () => {
        const latest = this.pushHead(repository, branch, head);
        if (latest.upstream?.remote !== upstreamRemote || latest.upstream?.name !== upstreamBranch)
          throw new GitOperationError('当前上游分支已变化，请刷新后重试推送。');
        if (
          !repository.state.remotes.some(({ name, isReadOnly }) => name === remote && !isReadOnly)
        )
          throw new GitOperationError('当前远程仓库不可写或已不可用，请检查 Git 配置。');
      };
      await repository.status();
      validateTarget();
      const { ahead } = await this.synchronization(repository, (await this.getApi())?.git?.path);
      const targetBranch = upstreamBranch ?? branch;
      const confirmLabel = upstreamRemote ? '推送' : '发布并推送';
      const confirmation = await vscode.window.showInformationMessage(
        '确认推送到远程仓库？',
        {
          modal: true,
          detail: `仓库：${repository.rootUri.fsPath}\n本地分支：${branch}\n远程目标：${remote}/${targetBranch}\n未推送提交：${ahead ?? '无法确定'}`,
        },
        confirmLabel,
      );
      if (confirmation !== confirmLabel) return;
      // The picker and confirmation can remain open while Git changes elsewhere.
      await repository.status();
      validateTarget();
      await repository.push(remote, `${branch}:${targetBranch}`, !upstreamRemote);
    });
  }

  async undoCommit(repositoryUri: string, branch: string, head: string): Promise<void> {
    await this.mutate(repositoryUri, async (repository) => {
      this.assertHead(repository, branch, head);
      const executable = (await this.getApi())?.git?.path;
      const sync = await this.synchronization(repository, executable);
      if (!sync.canUndo || !executable)
        throw new GitOperationError('仅可撤销当前分支最后一次尚未推送的提交。');
      if ((await this.commands.unpublishedCount(executable, repository.rootUri.fsPath, head)) === 0)
        throw new GitOperationError('此提交已存在于远程分支中，不能撤销。');
      await this.commands.undo(executable, repository.rootUri.fsPath, branch, head);
    });
  }

  private assertHead(repository: GitRepository, branch: string, head: string): void {
    if (repository.state.HEAD?.name !== branch || repository.state.HEAD.commit !== head)
      throw new GitOperationError('当前分支或提交已变化，请刷新后重试。');
  }

  private pushHead(repository: GitRepository, branch: string, head: string) {
    this.assertHead(repository, branch, head);
    const current = repository.state.HEAD!;
    if (current.behind && current.behind > 0)
      throw new GitOperationError('远程分支有新提交，请先拉取并整合后再推送。');
    if (current.upstream && current.ahead === 0)
      throw new GitOperationError('当前没有未推送的提交。');
    return current;
  }

  private async synchronization(
    repository: GitRepository,
    executable?: string,
  ): Promise<GitSyncInfo> {
    const head = repository.state.HEAD;
    let ahead = head?.upstream ? (head.ahead ?? null) : head?.commit ? null : 0;
    if (head?.commit && !head.upstream && executable) {
      try {
        ahead = await this.commands.unpublishedCount(
          executable,
          repository.rootUri.fsPath,
          head.commit,
        );
      } catch (error) {
        this.output.debug('Unpublished Git count unavailable', error);
      }
    }
    return {
      head: head?.commit ?? null,
      upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : null,
      ahead,
      behind: head?.upstream ? (head.behind ?? null) : 0,
      canUndo: Boolean(
        head?.name &&
        head.commit &&
        ahead !== null &&
        ahead > 0 &&
        !repository.state.mergeChanges.length &&
        !repository.state.rebaseCommit,
      ),
    };
  }

  async commit(repositoryUri: string, message: string): Promise<void> {
    const commitMessage = message.trim();
    if (!commitMessage) throw new GitOperationError('请输入提交消息。');
    await this.mutate(repositoryUri, async (repository) => {
      if (repository.state.mergeChanges.length > 0)
        throw new GitOperationError('请先解决并暂存所有冲突，再提交。');
      if (repository.state.indexChanges.length === 0)
        throw new GitOperationError('暂存区为空，没有可提交的更改。');
      await repository.commit(commitMessage, { all: false, postCommitCommand: null });
    });
  }

  private async mutate(
    rootUri: string,
    operation: (repository: GitRepository) => Promise<void>,
  ): Promise<void> {
    // Serialize per root URI: public API repository wrappers can change between reads.
    const previous = this.operations.get(rootUri);
    const current = (async () => {
      await previous?.catch(() => {});
      if (this.disposed) throw new GitOperationError('Git 服务已关闭。');
      const repository = await this.repository(rootUri);
      await repository.status();
      await operation(repository);
      try {
        await repository.status();
      } catch (error) {
        // A refresh failure must never turn a successful commit into a failed commit.
        this.output.warn('Git operation succeeded but status refresh failed', error);
      }
      if (!this.disposed) this.changed.fire();
    })();
    this.operations.set(rootUri, current);
    try {
      await current;
    } finally {
      if (this.operations.get(rootUri) === current) this.operations.delete(rootUri);
    }
  }

  private async repository(rootUri: string): Promise<GitRepository> {
    const api = await this.getApi();
    const repository = api?.repositories.find((item) => item.rootUri.toString() === rootUri);
    if (!repository) throw new GitOperationError('Git 仓库已不可用，请刷新后重试。');
    return repository;
  }

  private filePaths(
    repository: GitRepository,
    value: string,
    changes: readonly GitChange[],
  ): string[] {
    const change = changes.find((item) => item.uri.toString() === value);
    if (!change) throw new GitOperationError('文件状态已变化，请刷新后重试。');
    return this.changePaths(repository, change);
  }

  private changePaths(repository: GitRepository, change: GitChange): string[] {
    const uris = [change.uri];
    // A rename consists of both paths; resetting only the destination leaves a staged deletion.
    if (change.status === 3 || change.status === 10) {
      if (change.originalUri) uris.push(change.originalUri);
      if (change.renameUri) uris.push(change.renameUri);
    }
    return [...new Set(uris.map((uri) => this.repositoryPath(repository, uri)))];
  }

  private repositoryPath(repository: GitRepository, uri: vscode.Uri): string {
    if (uri.scheme !== repository.rootUri.scheme || uri.authority !== repository.rootUri.authority)
      throw new GitOperationError('文件不属于当前 Git 仓库。');
    const path = relative(repository.rootUri.fsPath, uri.fsPath);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
      throw new GitOperationError('文件不属于当前 Git 仓库。');
    return uri.fsPath;
  }

  private changes(rootUri: vscode.Uri, changes: readonly GitChange[]) {
    const files = new Map(
      changes
        .filter(({ status }) => status !== 8)
        .map(({ uri, status }) => [
          uri.toString(),
          {
            uri: uri.toString(),
            path: posix.relative(rootUri.path, uri.path),
            kind: gitChangeKind(status),
          },
        ]),
    );
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array with the ES2022 API.
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  private watch(api: GitApi | undefined): void {
    if (api === this.watchedApi) return;
    this.clearListeners();
    this.watchedApi = api;
    if (!api) return;
    const watchRepository = (repository: GitRepository) => {
      if (!this.repositoryListeners.has(repository))
        this.repositoryListeners.set(
          repository,
          repository.state.onDidChange(() => this.changed.fire()),
        );
    };
    api.repositories.forEach(watchRepository);
    this.apiListeners.push(
      api.onDidOpenRepository((repository) => {
        watchRepository(repository);
        this.changed.fire();
      }),
      api.onDidCloseRepository((repository) => {
        this.repositoryListeners.get(repository)?.dispose();
        this.repositoryListeners.delete(repository);
        this.changed.fire();
      }),
    );
  }

  private clearListeners(): void {
    this.apiListeners.splice(0).forEach((listener) => listener.dispose());
    this.repositoryListeners.forEach((listener) => listener.dispose());
    this.repositoryListeners.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clearListeners();
    this.watchedApi = undefined;
    this.changed.dispose();
  }
}
