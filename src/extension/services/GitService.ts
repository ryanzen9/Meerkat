import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { GitSummary } from '../../shared/models';
import { gitChangeKind } from '../../shared/git';
import { isRecord } from '../../shared/protocol';

// A structural subset of the built-in Git extension's public API v1.
// Extend from https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
// rather than importing private VS Code implementation modules.
interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string } | undefined;
    readonly remotes: readonly { readonly name: string }[];
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly mergeChanges: readonly GitChange[];
    readonly untrackedChanges: readonly GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export class GitService implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watchedApi: GitApi | undefined;
  private apiListeners: vscode.Disposable[] = [];
  private repositoryListeners = new Map<GitRepository, vscode.Disposable>();
  private disposed = false;
  constructor(private readonly output: vscode.LogOutputChannel) {}

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
      repositories:
        api?.repositories.map(({ rootUri, state }) => ({
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
        })) ?? [],
    };
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
