import * as vscode from 'vscode';
import type { GitSummary } from '../../shared/models';
import { isRecord } from '../../shared/protocol';

// A structural subset of the built-in Git extension's public API v1.
// Extend from https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
// rather than importing private VS Code implementation modules.
export interface GitApi {
  readonly repositories: readonly {
    readonly rootUri: vscode.Uri;
    readonly state: { readonly HEAD: { readonly name?: string } | undefined };
  }[];
}

interface GitExtensionExports {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export class GitService {
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
    return {
      available: api !== undefined,
      repositories:
        api?.repositories.map(({ rootUri, state }) => ({
          rootUri: rootUri.toString(),
          branch: state.HEAD?.name ?? null,
        })) ?? [],
    };
  }
}
