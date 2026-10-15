import type { GitFileChange, PanelSnapshot } from './models';

export type WebviewToExtensionMessage =
  | { type: 'webview/ready' }
  | { type: 'workspace/refresh'; requestId: string }
  | { type: 'file/open'; requestId: string; uri: string }
  | { type: 'reference/open'; requestId: string; sessionId: string; referenceId: string }
  | { type: 'code/open'; requestId: string; code: string; language: string }
  | { type: 'clipboard/write'; requestId: string; text: string }
  | { type: 'settings/open'; requestId: string }
  | {
      type: 'bridge/request';
      requestId: string;
      path: string;
      method: 'GET' | 'POST' | 'DELETE';
      body?: string;
    }
  | { type: 'bridge/cancel' | 'bridge/ack'; requestId: string }
  | { type: 'demo/hello'; requestId: string; name: string };

export type ExtensionToWebviewMessage =
  | { type: 'host/snapshot'; snapshot: PanelSnapshot; requestId?: string }
  | { type: 'host/hello'; requestId: string; message: string; messageCount: number }
  | { type: 'host/action'; requestId: string }
  | { type: 'host/bridge-head'; requestId: string; status: number; headers: Record<string, string> }
  | { type: 'host/bridge-chunk'; requestId: string; text: string }
  | { type: 'host/bridge-end'; requestId: string }
  | { type: 'host/bridge-error'; requestId: string; message: string }
  | { type: 'host/error'; message: string; requestId?: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFileReferenceId(value: unknown): value is string {
  return typeof value === 'string' && /^ref_[a-f0-9]{64}$/.test(value);
}

export function isWebviewMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'webview/ready':
      return true;
    case 'workspace/refresh':
    case 'settings/open':
    case 'bridge/cancel':
    case 'bridge/ack':
      return isRequestId(value.requestId);
    case 'bridge/request':
      return (
        isRequestId(value.requestId) &&
        typeof value.path === 'string' &&
        /^\/v1\/[\w/-]{1,256}$/.test(value.path) &&
        ['GET', 'POST', 'DELETE'].includes(String(value.method)) &&
        (value.body === undefined ||
          (typeof value.body === 'string' &&
            value.body.length <= 500000 &&
            value.method === 'POST'))
      );
    case 'file/open':
      return (
        isRequestId(value.requestId) &&
        typeof value.uri === 'string' &&
        value.uri.length > 0 &&
        value.uri.length <= 8192
      );
    case 'reference/open':
      return (
        isRequestId(value.requestId) &&
        typeof value.sessionId === 'string' &&
        /^[\w-]{1,128}$/.test(value.sessionId) &&
        isFileReferenceId(value.referenceId)
      );
    case 'code/open':
      return (
        isRequestId(value.requestId) &&
        typeof value.code === 'string' &&
        value.code.length <= 500000 &&
        typeof value.language === 'string' &&
        /^[\w+-]{0,40}$/.test(value.language)
      );
    case 'clipboard/write':
      return (
        isRequestId(value.requestId) &&
        typeof value.text === 'string' &&
        value.text.length <= 100000
      );
    case 'demo/hello':
      return (
        isRequestId(value.requestId) && typeof value.name === 'string' && value.name.length <= 80
      );
    default:
      return false;
  }
}

function isFileChange(value: unknown): value is GitFileChange {
  return (
    isRecord(value) &&
    typeof value.uri === 'string' &&
    typeof value.path === 'string' &&
    typeof value.kind === 'string' &&
    ['added', 'modified', 'deleted', 'renamed', 'conflict'].includes(value.kind)
  );
}

function isSnapshot(value: unknown): value is PanelSnapshot {
  if (!isRecord(value)) return false;
  const { workspace, settings, state, git } = value;
  return (
    (value.review === undefined ||
      (isRecord(value.review) &&
        typeof value.review.repositoryUri === 'string' &&
        (value.review.pullRequestNumber === undefined ||
          (isCount(value.review.pullRequestNumber) && value.review.pullRequestNumber > 0)) &&
        typeof value.review.status === 'string' &&
        ['idle', 'analyzing', 'ready'].includes(value.review.status) &&
        isCount(value.review.issueCount))) &&
    isRecord(workspace) &&
    (workspace.name === null || typeof workspace.name === 'string') &&
    typeof workspace.trusted === 'boolean' &&
    Array.isArray(workspace.folders) &&
    workspace.folders.every(
      (folder: unknown) =>
        isRecord(folder) &&
        typeof folder.name === 'string' &&
        typeof folder.uri === 'string' &&
        typeof folder.path === 'string',
    ) &&
    isRecord(settings) &&
    typeof settings.greeting === 'string' &&
    typeof settings.showWorkspacePaths === 'boolean' &&
    isRecord(state) &&
    isCount(state.messageCount) &&
    isRecord(git) &&
    typeof git.available === 'boolean' &&
    Array.isArray(git.repositories) &&
    git.repositories.every(
      (repository: unknown) =>
        isRecord(repository) &&
        typeof repository.rootUri === 'string' &&
        typeof repository.name === 'string' &&
        (repository.branch === null || typeof repository.branch === 'string') &&
        Array.isArray(repository.remotes) &&
        repository.remotes.every((remote: unknown) => typeof remote === 'string') &&
        Array.isArray(repository.changes) &&
        repository.changes.every(isFileChange) &&
        Array.isArray(repository.stagedChanges) &&
        repository.stagedChanges.every(isFileChange),
    )
  );
}

export function isExtensionMessage(value: unknown): value is ExtensionToWebviewMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'host/snapshot':
      return (
        isSnapshot(value.snapshot) &&
        (value.requestId === undefined || isRequestId(value.requestId))
      );
    case 'host/hello':
      return (
        isRequestId(value.requestId) &&
        typeof value.message === 'string' &&
        isCount(value.messageCount)
      );
    case 'host/action':
    case 'host/bridge-end':
      return isRequestId(value.requestId);
    case 'host/bridge-head':
      return (
        isRequestId(value.requestId) &&
        Number.isInteger(value.status) &&
        Number(value.status) >= 200 &&
        Number(value.status) <= 599 &&
        isRecord(value.headers) &&
        Object.keys(value.headers).length <= 4 &&
        Object.entries(value.headers).every(
          ([key, header]) =>
            ['content-type', 'x-vercel-ai-ui-message-stream'].includes(key) &&
            typeof header === 'string' &&
            header.length <= 200,
        )
      );
    case 'host/bridge-chunk':
      return (
        isRequestId(value.requestId) && typeof value.text === 'string' && value.text.length <= 32768
      );
    case 'host/bridge-error':
      return (
        isRequestId(value.requestId) &&
        typeof value.message === 'string' &&
        value.message.length <= 1000
      );
    case 'host/error':
      return (
        typeof value.message === 'string' &&
        (value.requestId === undefined || isRequestId(value.requestId))
      );
    default:
      return false;
  }
}
