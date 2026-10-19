import * as vscode from 'vscode';
import { ReviewPanelProvider } from './providers/ReviewPanelProvider';
import { WorkspaceService } from './services/WorkspaceService';
import { SettingsService } from './services/SettingsService';
import { StateService } from './services/StateService';
import { GitService } from './services/GitService';
import { BridgeService } from './bridge/service';
import { publicError } from './bridge/errors';
import { ReferenceEditorService } from './services/ReferenceEditorService';

let bridge: BridgeService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Meerkat', { log: true });
  const git = new GitService(output);
  bridge = new BridgeService(context, output);
  const referenceEditor = new ReferenceEditorService(bridge);
  const provider = new ReviewPanelProvider(
    context.extensionUri,
    {
      workspace: new WorkspaceService(),
      settings: new SettingsService(),
      state: new StateService(context.workspaceState),
      git,
      bridge,
      referenceEditor,
    },
    output,
  );

  context.subscriptions.push(
    output,
    git,
    bridge,
    referenceEditor,
    bridge.onDidChangeFinding((change) => {
      void provider.findingChanged(change);
    }),
    vscode.commands.registerCommand('meerkat.chatgptSignIn', async () => {
      try {
        const response = await bridge!.request(
          '/v1/providers/openai-agents/auth',
          'GET',
          undefined,
          new AbortController().signal,
        );
        const status = (await response.json()) as { accounts?: { id: string }[] };
        const result = await bridge!.request(
          '/v1/providers/openai-agents/login',
          'POST',
          JSON.stringify(status.accounts?.[0] ? { accountId: status.accounts[0].id } : {}),
          new AbortController().signal,
        );
        if (!result.ok)
          void vscode.window.showErrorMessage(
            ((await result.json()) as { error: { message: string } }).error.message,
          );
      } catch (error) {
        void vscode.window.showErrorMessage(publicError(error).message);
      }
    }),
    vscode.commands.registerCommand('meerkat.bridgeConnection', async () => {
      try {
        const path = await bridge!.exportConnection();
        void vscode.window.showInformationMessage(`Bridge connection saved to ${path}`);
      } catch (error) {
        void vscode.window.showErrorMessage(publicError(error).message);
      }
    }),
    git.onDidChange(() => {
      void provider.refresh();
    }),
    provider,
    vscode.window.registerWebviewViewProvider(ReviewPanelProvider.viewId, provider),
    vscode.commands.registerCommand('meerkat.showPanel', async () => {
      await vscode.commands.executeCommand(`${ReviewPanelProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('meerkat.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('meerkat.reloadWebview', () => provider.reload()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void provider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('meerkat') || event.affectsConfiguration('git.enabled'))
        void provider.refresh();
    }),
  );
  output.info('Meerkat activated in the Node.js Extension Host');
}

// All listeners, commands, and the view provider are owned by context.subscriptions.
export async function deactivate(): Promise<void> {
  await bridge?.close();
  bridge = undefined;
}
