import * as vscode from 'vscode';
import type { PanelSettings } from '../../shared/models';

export class SettingsService {
  read(): PanelSettings {
    const configuration = vscode.workspace.getConfiguration('meerkat');
    return {
      greeting: configuration.get<string>('greeting', '你好，来自 Extension Host！'),
      showWorkspacePaths: configuration.get<boolean>('showWorkspacePaths', true),
    };
  }
  // Add typed configuration.update(..., ConfigurationTarget.Workspace) methods here
  // when the panel needs editable settings; VS Code owns settings persistence.
}
