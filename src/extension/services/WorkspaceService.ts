import * as vscode from 'vscode';
import type { WorkspaceInfo } from '../../shared/models';

export class WorkspaceService {
  read(): WorkspaceInfo {
    return {
      name: vscode.workspace.name ?? null,
      trusted: vscode.workspace.isTrusted,
      folders: (vscode.workspace.workspaceFolders ?? []).map(({ name, uri }) => ({
        name,
        uri: uri.toString(),
        path: uri.scheme === 'file' ? uri.fsPath : uri.toString(),
      })),
    };
  }
}
