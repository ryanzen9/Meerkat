import * as vscode from 'vscode';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BridgeService } from '../bridge/service';
import type { FileReference } from '../bridge/tools/reviewWorkspace';
import { BridgeError } from '../bridge/errors';
import { inside } from '../bridge/tools/reviewGit';
import { isFileReferenceId } from '../../shared/protocol';
import type { ReviewFinding } from '../../shared/review';

const SNAPSHOT_SCHEME = 'meerkat-review';

export class ReferenceEditorService implements vscode.Disposable {
  private readonly registration: vscode.Disposable;
  private controller: vscode.CommentController | undefined;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private editorColumn: vscode.ViewColumn | undefined;
  private disposed = false;

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
    this.assertOpen();
    const { reference, content, findings } = await this.bridge.readFileReference(
      sessionId,
      referenceId,
    );
    this.assertOpen();
    const fileUri = vscode.Uri.file(resolve(reference.repository, reference.path));
    if (!vscode.workspace.getWorkspaceFolder(fileUri))
      throw new BridgeError('repository_unavailable', 'Reference is outside the workspace.');
    let document =
      reference.version === 'new'
        ? await this.currentDocument(fileUri, reference, content)
        : undefined;
    document ??= await vscode.workspace.openTextDocument(this.snapshotUri(sessionId, reference));
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
    this.assertOpen();
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: findings.length
        ? (this.editorColumn ?? vscode.ViewColumn.Beside)
        : vscode.ViewColumn.Active,
      preview: true,
      preserveFocus: false,
      ...(selection ? { selection } : {}),
    });
    if (selection)
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.assertOpen();
    if (findings.length) {
      this.editorColumn = editor.viewColumn;
      this.showFindings(sessionId, referenceId, document.uri, selection, findings);
    }
  }

  private snapshotUri(sessionId: string, reference: FileReference): vscode.Uri {
    return vscode.Uri.from({
      scheme: SNAPSHOT_SCHEME,
      path: `/${reference.version}/${reference.path}`,
      query: new URLSearchParams({ sessionId, referenceId: reference.referenceId }).toString(),
    });
  }

  private showFindings(
    sessionId: string,
    referenceId: string,
    uri: vscode.Uri,
    range: vscode.Range | undefined,
    findings: readonly ReviewFinding[],
  ): void {
    this.controller ??= vscode.comments.createCommentController('meerkat.review', 'Meerkat 审查');
    for (const finding of findings) {
      const key = JSON.stringify([sessionId, finding.id, referenceId]);
      let thread = this.threads.get(key);
      // When the live file changes, move the receipt to its exact snapshot.
      if (thread && thread.uri.toString() !== uri.toString()) {
        thread.dispose();
        this.threads.delete(key);
        thread = undefined;
      }
      if (!thread) {
        const body = new vscode.MarkdownString();
        body.isTrusted = false;
        body.supportHtml = false;
        body.appendText(`[${finding.priority}] ${finding.title}`);
        body.appendMarkdown('\n\n');
        body.appendMarkdown(
          finding.description.replace(/\]\(review-file:([^\s)]+)\)/g, (_match, target: string) => {
            let id: string;
            try {
              id = decodeURIComponent(target);
            } catch {
              return ']()';
            }
            const reference = finding.references.find((item) => item.referenceId === id);
            if (!reference) return ']()';
            const targetUri = id === referenceId ? uri : this.snapshotUri(sessionId, reference);
            const fragment =
              reference.scope === 'range' ? `#L${reference.startLine}-L${reference.endLine}` : '';
            return `](<${targetUri.toString()}${fragment}>)`;
          }),
        );
        thread = this.controller.createCommentThread(
          uri,
          // Findings currently require ranges; keep a file-level anchor for compatibility.
          range ?? new vscode.Range(0, 0, 0, 0),
          [
            {
              body,
              author: { name: 'Meerkat' },
              mode: vscode.CommentMode.Preview,
              timestamp: new Date(finding.savedAt),
            },
          ],
        );
        thread.canReply = false;
        thread.label = `[${finding.priority}] ${finding.title}`;
        this.threads.set(key, thread);
      }
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }
  }

  private assertOpen(): void {
    if (this.disposed)
      throw new BridgeError('bridge_closed', 'Reference editor has been disposed.');
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
    this.disposed = true;
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.controller?.dispose();
    this.registration.dispose();
  }
}
