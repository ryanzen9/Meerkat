import * as vscode from 'vscode';
import { ReviewPanelProvider } from './providers/ReviewPanelProvider';
import { WorkspaceService } from './services/WorkspaceService';
import { SettingsService } from './services/SettingsService';
import { StateService } from './services/StateService';
import { GitService } from './services/GitService';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Review Bot', { log: true });
  const provider = new ReviewPanelProvider(
    context.extensionUri,
    {
      workspace: new WorkspaceService(),
      settings: new SettingsService(),
      state: new StateService(context.workspaceState),
      git: new GitService(output),
    },
    output,
  );

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider(ReviewPanelProvider.viewId, provider),
    vscode.commands.registerCommand('reviewBot.showPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.scm');
      await vscode.commands.executeCommand(`${ReviewPanelProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('reviewBot.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('reviewBot.reloadWebview', () => provider.reload()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void provider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('reviewBot') || event.affectsConfiguration('git.enabled'))
        void provider.refresh();
    }),
  );
  output.info('Review Bot activated in the Node.js Extension Host');
}

// All listeners, commands, and the view provider are owned by context.subscriptions.
export function deactivate(): void {}
