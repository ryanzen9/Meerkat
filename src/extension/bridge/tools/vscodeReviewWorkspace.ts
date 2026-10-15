import * as vscode from 'vscode';
import { relative, sep } from 'node:path';
import { GitService } from '../../services/GitService';
import { inside } from './reviewGit';
import type { ReviewDiagnostic, ReviewWorkspace } from './reviewWorkspace';

const position = (value: vscode.Position) => ({
  line: value.line + 1,
  column: value.character + 1,
});

export class VSCodeReviewWorkspace implements ReviewWorkspace {
  private readonly git: GitService;
  gitPath = 'git';
  constructor(output: vscode.LogOutputChannel) {
    this.git = new GitService(output);
  }

  async getState() {
    const api = await this.git.getApi();
    this.gitPath = api?.git?.path ?? 'git';
    const editor = vscode.window.activeTextEditor;
    return {
      trusted: vscode.workspace.isTrusted,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? [])
        .filter(({ uri }) => uri.scheme === 'file')
        .map(({ name, uri }) => ({ name, path: uri.fsPath })),
      repositories: (api?.repositories ?? [])
        .filter(({ rootUri }) => rootUri.scheme === 'file')
        .map(({ rootUri }) => rootUri.fsPath),
      activeFile: editor
        ? {
            path: editor.document.uri.scheme === 'file' ? editor.document.uri.fsPath : null,
            uri: editor.document.uri.toString(),
            languageId: editor.document.languageId,
            selection: {
              start: position(editor.selection.start),
              end: position(editor.selection.end),
            },
          }
        : null,
      dirtyDocuments: vscode.workspace.textDocuments
        .filter((document) => document.isDirty && document.uri.scheme === 'file')
        .map((document) => ({ path: document.uri.fsPath, text: document.getText() })),
      unsavedFiles: vscode.workspace.textDocuments
        .filter((document) => document.isDirty)
        .map((document) => ({
          path: document.uri.scheme === 'file' ? document.uri.fsPath : null,
          uri: document.uri.toString(),
          isUntitled: document.isUntitled,
        })),
    };
  }

  async findFiles(root: string, glob: string, limit: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, glob),
        '**/{.git,node_modules,dist,build}/**',
        limit,
        cancellation.token,
      );
      signal?.throwIfAborted();
      return (
        files
          .filter((uri) => uri.scheme === 'file' && inside(root, uri.fsPath))
          .map((uri) => relative(root, uri.fsPath).split(sep).join('/'))
          // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array with the ES2022 API.
          .sort()
      );
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }

  getDiagnostics(paths: string[]): ReviewDiagnostic[] {
    const severity = ['error', 'warning', 'information', 'hint'] as const;
    return paths.flatMap((path) =>
      vscode.languages.getDiagnostics(vscode.Uri.file(path)).map((diagnostic) => ({
        path,
        source: diagnostic.source ?? null,
        severity: severity[diagnostic.severity] ?? 'information',
        message: diagnostic.message,
        code:
          typeof diagnostic.code === 'object' ? diagnostic.code.value : (diagnostic.code ?? null),
        range: { start: position(diagnostic.range.start), end: position(diagnostic.range.end) },
      })),
    );
  }

  dispose() {
    this.git.dispose();
  }
}
