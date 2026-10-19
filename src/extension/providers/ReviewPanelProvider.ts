import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/protocol';
import { isWebviewMessage } from '../../shared/protocol';
import type { WorkspaceService } from '../services/WorkspaceService';
import type { SettingsService } from '../services/SettingsService';
import type { StateService } from '../services/StateService';
import type { GitService } from '../services/GitService';
import { gitErrorMessage } from '../services/GitService';
import { createWebviewHtml } from '../webview/html';
import { WebviewBridgeProxy } from '../bridge/transport/webviewProxy';
import type { BridgeService } from '../bridge/service';
import type { ReferenceEditorService } from '../services/ReferenceEditorService';
import { BridgeError, publicError } from '../bridge/errors';
import type { ReviewFindingChange } from '../../shared/review';

interface PanelServices {
  workspace: Pick<WorkspaceService, 'read'>;
  settings: Pick<SettingsService, 'read'>;
  state: Pick<StateService, 'read' | 'incrementMessageCount'>;
  git: Pick<
    GitService,
    'read' | 'stage' | 'unstage' | 'commit' | 'stageAll' | 'unstageAll' | 'push' | 'undoCommit'
  >;
  bridge?: Pick<BridgeService, 'request'>;
  referenceEditor?: Pick<ReferenceEditorService, 'open'>;
}

export class ReviewPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'meerkat.panel';
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private listeners: vscode.Disposable[] = [];
  private bridgeProxy: WebviewBridgeProxy | undefined;
  private snapshotRevision = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: PanelServices,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
    if (this.services.bridge)
      this.bridgeProxy = new WebviewBridgeProxy(
        (path, method, body, signal) => this.services.bridge!.request(path, method, body, signal),
        (message) => this.post(view, message),
      );
    const resourceRoot = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [resourceRoot] };
    this.listeners.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!isWebviewMessage(message)) {
          this.output.warn('Ignored invalid webview message');
          return;
        }
        void this.handleMessage(view, message);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          void this.refresh();
          if (this.ready) void this.post(view, { type: 'host/review-refresh' });
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.dispose();
      }),
    );
    view.webview.html = this.html(view.webview);
  }

  async refresh(): Promise<void> {
    const view = this.view;
    if (!view || !this.ready) return;
    try {
      await this.sendSnapshot(view);
    } catch (error) {
      await this.reportError(view, error);
    }
  }

  async findingChanged(change: ReviewFindingChange): Promise<void> {
    if (this.view && this.ready)
      await this.post(this.view, { type: 'host/review-finding-changed', ...change });
  }

  reload(): void {
    if (!this.view) return;
    this.ready = false;
    this.bridgeProxy?.dispose();
    this.view.webview.html = this.html(this.view.webview);
  }

  private html(webview: vscode.Webview): string {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    return createWebviewHtml({
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(root, 'style.css')).toString(),
      cspSource: webview.cspSource,
    });
  }

  private async handleMessage(
    view: vscode.WebviewView,
    message: WebviewToExtensionMessage,
  ): Promise<void> {
    try {
      switch (message.type) {
        case 'bridge/request':
          if (this.bridgeProxy) await this.bridgeProxy.send(message);
          break;
        case 'bridge/ack':
          this.bridgeProxy?.ack(message.requestId);
          break;
        case 'bridge/cancel':
          this.bridgeProxy?.cancel(message.requestId);
          break;
        case 'webview/ready':
          this.ready = true;
          await this.sendSnapshot(view);
          break;
        case 'workspace/refresh':
          await this.sendSnapshot(view, message.requestId);
          break;
        case 'git/stage':
          await this.services.git.stage(message.repositoryUri, message.uri);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'git/unstage':
          await this.services.git.unstage(message.repositoryUri, message.uri);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'git/commit':
          await this.services.git.commit(message.repositoryUri, message.message);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'git/stage-all':
          await this.services.git.stageAll(message.repositoryUri);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'git/unstage-all':
          await this.services.git.unstageAll(message.repositoryUri);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'git/push':
          await this.services.git.push(message.repositoryUri, message.branch, message.head);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'git/undo-commit':
          await this.services.git.undoCommit(message.repositoryUri, message.branch, message.head);
          await this.sendGitResult(view, message.requestId);
          break;
        case 'settings/open':
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            '@ext:local-dev.meerkat',
          );
          await this.post(view, { type: 'host/action', requestId: message.requestId });
          break;
        case 'clipboard/write':
          await vscode.env.clipboard.writeText(message.text);
          await this.post(view, { type: 'host/action', requestId: message.requestId });
          break;
        case 'code/open': {
          const language =
            (
              {
                ts: 'typescript',
                tsx: 'typescriptreact',
                js: 'javascript',
                jsx: 'javascriptreact',
                py: 'python',
                sh: 'shellscript',
                md: 'markdown',
              } as Record<string, string>
            )[message.language] ?? message.language;
          const document = await vscode.workspace.openTextDocument({
            content: message.code,
            language: language || 'plaintext',
          });
          await vscode.window.showTextDocument(document, { preview: false });
          await this.post(view, { type: 'host/action', requestId: message.requestId });
          break;
        }
        case 'file/open': {
          const uri = vscode.Uri.parse(message.uri, true);
          if (
            !['file', 'vscode-remote'].includes(uri.scheme) ||
            !vscode.workspace.getWorkspaceFolder(uri)
          )
            throw new Error('File is outside the workspace');
          const document = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true });
          await this.post(view, { type: 'host/action', requestId: message.requestId });
          break;
        }
        case 'reference/open': {
          if (!this.services.referenceEditor)
            throw new BridgeError('reference_unavailable', 'Reference navigation is unavailable.');
          await this.services.referenceEditor.open(message.sessionId, message.referenceId);
          await this.post(view, { type: 'host/action', requestId: message.requestId });
          break;
        }
        case 'demo/hello': {
          const state = await this.services.state.incrementMessageCount();
          const name = message.name.trim() || '开发者';
          await this.post(view, {
            type: 'host/hello',
            requestId: message.requestId,
            message: `${name}，${this.services.settings.read().greeting}`,
            messageCount: state.messageCount,
          });
          break;
        }
      }
    } catch (error) {
      await this.reportError(
        view,
        error,
        'requestId' in message ? message.requestId : undefined,
        message.type === 'reference/open'
          ? referenceErrorMessage(error)
          : message.type.startsWith('git/')
            ? gitErrorMessage(error)
            : undefined,
      );
    }
  }

  private async sendGitResult(view: vscode.WebviewView, requestId: string): Promise<void> {
    try {
      await this.sendSnapshot(view, requestId);
    } catch (error) {
      this.output.warn('Git operation succeeded but panel refresh failed', error);
      await this.post(view, { type: 'host/action', requestId });
      await this.post(view, {
        type: 'host/error',
        message: 'Git 操作已成功，但刷新状态失败，请刷新工作区。',
      });
    }
  }

  private async sendSnapshot(view: vscode.WebviewView, requestId?: string): Promise<void> {
    const revision = ++this.snapshotRevision;
    const git = await this.services.git.read();
    // Git count queries may finish out of order. Acknowledge superseded requests
    // without replacing a newer snapshot with their older repository state.
    if (revision !== this.snapshotRevision) {
      if (requestId) await this.post(view, { type: 'host/ack', requestId });
      return;
    }
    await this.post(view, {
      type: 'host/snapshot',
      ...(requestId ? { requestId } : {}),
      snapshot: {
        workspace: this.services.workspace.read(),
        settings: this.services.settings.read(),
        state: this.services.state.read(),
        git,
      },
    });
  }

  private async reportError(
    view: vscode.WebviewView,
    error: unknown,
    requestId?: string,
    message = '面板操作失败，请重试；文件可能已被删除或不在当前工作区中。',
  ): Promise<void> {
    this.output.error('Panel operation failed', error);
    await this.post(view, {
      type: 'host/error',
      message,
      ...(requestId ? { requestId } : {}),
    });
  }

  private async post(view: vscode.WebviewView, message: ExtensionToWebviewMessage): Promise<void> {
    if (this.view !== view) return;
    try {
      await view.webview.postMessage(message);
    } catch (error) {
      this.output.debug('Webview no longer accepts messages', error);
    }
  }

  dispose(): void {
    this.bridgeProxy?.dispose();
    this.bridgeProxy = undefined;
    this.view = undefined;
    this.ready = false;
    this.listeners.splice(0).forEach((listener) => listener.dispose());
  }
}

function referenceErrorMessage(error: unknown): string {
  switch (publicError(error).code) {
    case 'session_not_found':
    case 'reference_not_found':
    case 'review_not_found':
    case 'bridge_closed':
      return '代码引用已失效（会话或快照已结束），请重新生成引用。';
    case 'workspace_untrusted':
      return '请先信任当前工作区，再打开代码引用。';
    case 'repository_unavailable':
      return '引用所属仓库已不在当前工作区，请重新打开仓库。';
    case 'reference_corrupt':
      return '已保存的代码引用损坏或不完整，请重新生成引用。';
    case 'reference_unavailable':
      return '暂时无法读取已保存的代码引用，请重试。';
    default:
      return '无法打开代码引用，请重新生成引用或重试。';
  }
}
