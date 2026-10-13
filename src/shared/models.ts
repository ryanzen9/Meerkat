// JSON-only data: no VS Code, Node, Bun, or React imports in this layer.
export interface WorkspaceFolderInfo {
  name: string;
  uri: string;
  path: string;
}

export interface WorkspaceInfo {
  name: string | null;
  folders: WorkspaceFolderInfo[];
  trusted: boolean;
}

export interface PanelSettings {
  greeting: string;
  showWorkspacePaths: boolean;
}

export interface PanelState {
  messageCount: number;
}

export interface GitSummary {
  available: boolean;
  repositories: { rootUri: string; branch: string | null }[];
}

export interface PanelSnapshot {
  workspace: WorkspaceInfo;
  settings: PanelSettings;
  state: PanelState;
  git: GitSummary;
}

// Local UI state survives webview hiding/recreation via getState/setState.
export interface WebviewState {
  draftName: string;
}
