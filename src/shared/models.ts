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

export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict';

export interface GitFileChange {
  uri: string;
  path: string;
  kind: GitChangeKind;
}

export interface GitRepositoryInfo {
  rootUri: string;
  name: string;
  branch: string | null;
  remotes: string[];
  changes: GitFileChange[];
  stagedChanges: GitFileChange[];
}

export interface GitSummary {
  available: boolean;
  repositories: GitRepositoryInfo[];
}

export interface PanelSnapshot {
  workspace: WorkspaceInfo;
  settings: PanelSettings;
  state: PanelState;
  git: GitSummary;
  review?: ReviewInfo;
}

// Optional metadata supplied by a future PR / review service.
export interface ReviewInfo {
  repositoryUri: string;
  pullRequestNumber?: number;
  status: 'idle' | 'analyzing' | 'ready';
  issueCount: number;
}

// Local UI state survives webview hiding/recreation via getState/setState.
export interface WebviewState {
  draftName?: string;
  activeTab?: ReviewTab;
  repositoryUri?: string;
  activeSessionId?: string;
  sessions?: ChatSession[];
}

export type ReviewTab = 'chat' | 'files' | 'history';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  draft: string;
  messages: ChatMessage[];
}
