import * as vscode from 'vscode';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BridgeService } from '../bridge/service';
import type { FileReference } from '../bridge/tools/reviewWorkspace';
import { BridgeError } from '../bridge/errors';
import { inside } from '../bridge/tools/reviewGit';
import { isFileReferenceId } from '../../shared/protocol';

const SNAPSHOT_SCHEME = 'meerkat-review';

export class ReferenceEditorService implements vscode.Disposable {
  private readonly registration: vscode.Disposable;

  constructor(private readonly bridge: Pick<BridgeService, 'readFileReference'>) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        const query = new URLSearchParams(uri.query);
        const sessionId = query.get('sessionId');
        const referenceId = query.get('referenceId');
        if (!sessionId || !/^[\w-]{1,128}$/.test(sessionId) || !isFileReferenceId(referenceId))
          throw new BridgeError('reference_not_found', 'Invalid file reference.');
        const result = await this.bridge.readFileReference(sessionId, referenceId);
        if (uri.path !== `/${result.reference.version}/${result.reference.path}`)
          throw new BridgeError('reference_not_found', 'File reference path does not match.');
        return result.content;
      },
    });
  }

  async open(sessionId: string, referenceId: string): Promise<void> {
    const { reference, content } = await this.bridge.readFileReference(sessionId, referenceId);
    const fileUri = vscode.Uri.file(resolve(reference.repository, reference.path));
    if (!vscode.workspace.getWorkspaceFolder(fileUri))
      throw new BridgeError('repository_unavailable', 'Reference is outside the workspace.');
    let document =
      reference.version === 'new'
        ? await this.currentDocument(fileUri, reference, content)
        : undefined;
    document ??= await vscode.workspace.openTextDocument(
      vscode.Uri.from({
        scheme: SNAPSHOT_SCHEME,
        path: `/${reference.version}/${reference.path}`,
        query: new URLSearchParams({ sessionId, referenceId }).toString(),
      }),
    );
    let selection: vscode.Range | undefined;
    if (reference.scope !== 'file') {
      if (reference.endLine > document.lineCount)
        throw new BridgeError('range_invalid', 'File reference range is no longer available.');
      selection = new vscode.Range(
        reference.startLine - 1,
        0,
        reference.endLine - 1,
        document.lineAt(reference.endLine - 1).text.length,
      );
    }
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preview: true,
      preserveFocus: false,
      ...(selection ? { selection } : {}),
    });
    if (selection)
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async currentDocument(
    uri: vscode.Uri,
    reference: FileReference,
    content: string,
  ): Promise<vscode.TextDocument | undefined> {
    try {
      // Do not follow a replaced symlink outside the repository, even to compare text.
      const [root, file, info] = await Promise.all([
        realpath(reference.repository),
        realpath(uri.fsPath),
        lstat(uri.fsPath),
      ]);
      if (!inside(root, file) || !info.isFile()) return undefined;
      const document = await vscode.workspace.openTextDocument(uri);
      if (document.getText() === content) return document;
    } catch {
      // Deleted or inaccessible current files remain available in the review snapshot.
    }
    return undefined;
  }

  dispose(): void {
    this.registration.dispose();
  }
}
