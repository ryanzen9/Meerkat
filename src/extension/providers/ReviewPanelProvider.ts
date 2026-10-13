import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/protocol';
import { isWebviewMessage } from '../../shared/protocol';
import type { WorkspaceService } from '../services/WorkspaceService';
import type { SettingsService } from '../services/SettingsService';
import type { StateService } from '../services/StateService';
import type { GitService } from '../services/GitService';
import { createWebviewHtml } from '../webview/html';

interface PanelServices {
  workspace: Pick<WorkspaceService, 'read'>;
  settings: Pick<SettingsService, 'read'>;
  state: Pick<StateService, 'read' | 'incrementMessageCount'>;
  git: Pick<GitService, 'read'>;
}

export class ReviewPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'reviewBot.panel';
  private view: vscode.WebviewView | undefined;
  private ready = false;
  private listeners: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly services: PanelServices,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dispose();
    this.view = view;
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
        if (view.visible) void this.refresh();
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

  reload(): void {
    if (!this.view) return;
    this.ready = false;
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
        case 'webview/ready':
          this.ready = true;
          await this.sendSnapshot(view);
          break;
        case 'workspace/refresh':
          await this.sendSnapshot(view, message.requestId);
          break;
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
      await this.reportError(view, error, 'requestId' in message ? message.requestId : undefined);
    }
  }

  private async sendSnapshot(view: vscode.WebviewView, requestId?: string): Promise<void> {
    const git = await this.services.git.read();
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
  ): Promise<void> {
    this.output.error('Panel operation failed', error);
    await this.post(view, {
      type: 'host/error',
      message: '读取面板数据失败，请刷新重试。',
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
    this.view = undefined;
    this.ready = false;
    this.listeners.splice(0).forEach((listener) => listener.dispose());
  }
}
