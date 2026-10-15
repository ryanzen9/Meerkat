export interface EditorPosition {
  line: number;
  column: number;
}

export interface ReviewHostState {
  trusted: boolean;
  workspaceFolders: { name: string; path: string }[];
  repositories: string[];
  activeFile: {
    path: string | null;
    uri?: string;
    languageId: string;
    selection: { start: EditorPosition; end: EditorPosition };
  } | null;
  dirtyDocuments: { path: string; text: string }[];
  unsavedFiles?: { path: string | null; uri: string; isUntitled: boolean }[];
}

export interface ReviewDiagnostic {
  path: string;
  source: string | null;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  code: string | number | null;
  range: { start: EditorPosition; end: EditorPosition };
}

// The backend is independent of the VS Code module and can run against real Git fixtures.
export interface ReviewWorkspace {
  getState(): Promise<ReviewHostState>;
  findFiles(root: string, glob: string, limit: number, signal?: AbortSignal): Promise<string[]>;
  getDiagnostics(paths: string[]): ReviewDiagnostic[];
  gitPath?: string;
}

export type ReviewScope = 'staged' | 'working-tree' | 'all' | 'branch';
export type FileVersion = 'old' | 'new';

export interface FileReferenceRange {
  path: string;
  version: FileVersion;
  // Optional on input for compatibility with existing range-only callers.
  scope?: 'range' | undefined;
  startLine: number;
  endLine: number;
}

export interface WholeFileReference {
  path: string;
  version: FileVersion;
  scope: 'file';
  startLine?: never;
  endLine?: never;
}

export type FileReferenceTarget = WholeFileReference | FileReferenceRange;

interface FileReferenceDetails {
  referenceId: string;
  reviewId: string;
  repository: string;
  label: string;
  markdown: string;
}

// Registered targets always have an explicit scope; range coordinates are 1-based, inclusive.
export type FileReference = FileReferenceDetails &
  (WholeFileReference | (FileReferenceRange & { scope: 'range' }));

export interface ReviewChange {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed' | 'conflict';
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed' | 'marker';
  oldLine: number | null;
  newLine: number | null;
  text: string;
  partial: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

// A browser-safe contract: UI message inference must not import Node/VS Code services.
export interface ReviewToolContext {
  getReviewContext(signal?: AbortSignal): Promise<{
    workspaceFolders: ReviewHostState['workspaceFolders'];
    repositories: string[];
    repository: { root: string; branch: string | null; head: string | null } | null;
    activeFile: ReviewHostState['activeFile'];
    unsavedFiles: { path: string | null; uri?: string; isUntitled?: boolean }[];
    configurationFiles: string[];
    configurationFilesTruncated: boolean;
    coordinates: string;
  }>;
  listChanges(
    input: { scope: ReviewScope; baseRef?: string | undefined },
    signal?: AbortSignal,
  ): Promise<{
    reviewId: string;
    createdAt: string;
    expiresAt: string;
    repository: string;
    head: string | null;
    base: string | null;
    scope: ReviewScope;
    changes: ReviewChange[];
  }>;
  getDiff(
    input: { reviewId: string; paths: string[]; cursor?: string | undefined },
    signal?: AbortSignal,
  ): Promise<{
    reviewId: string;
    files: (ReviewChange & {
      binary: boolean;
      patch: string;
      patchOffset: number;
      patchComplete: boolean;
      hunks: DiffHunk[];
    })[];
    truncated: boolean;
    nextCursor: string | null;
  }>;
  readFile(
    input: {
      reviewId: string;
      path: string;
      version: FileVersion;
      startLine: number;
      endLine: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    reviewId: string;
    path: string;
    version: FileVersion;
    startLine: number;
    endLine: number;
    totalLines: number;
    lines: { line: number; text: string }[];
    truncated: boolean;
    contentTruncated: boolean;
    nextStartLine: number | null;
  }>;
  citeFiles(
    input: { reviewId: string; references: FileReferenceTarget[] },
    signal?: AbortSignal,
  ): Promise<{ references: FileReference[] }>;
  searchCode(
    input: { query: string; glob?: string | undefined; limit?: number | undefined },
    signal?: AbortSignal,
  ): Promise<{
    repository: string;
    matches: {
      path: string;
      line: number;
      column: number;
      text: string;
      context: { line: number; text: string }[];
    }[];
    truncated: boolean;
    skippedFiles: number;
  }>;
  getDiagnostics(
    input: { paths: string[] },
    signal?: AbortSignal,
  ): Promise<{
    repository: string;
    diagnostics: ReviewDiagnostic[];
    truncated: boolean;
  }>;
}
