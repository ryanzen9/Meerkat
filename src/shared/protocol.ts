import type { PanelSnapshot } from './models';

export type WebviewToExtensionMessage =
  | { type: 'webview/ready' }
  | { type: 'workspace/refresh'; requestId: string }
  | { type: 'demo/hello'; requestId: string; name: string };

export type ExtensionToWebviewMessage =
  | { type: 'host/snapshot'; snapshot: PanelSnapshot; requestId?: string }
  | { type: 'host/hello'; requestId: string; message: string; messageCount: number }
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

export function isWebviewMessage(value: unknown): value is WebviewToExtensionMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'webview/ready':
      return true;
    case 'workspace/refresh':
      return isRequestId(value.requestId);
    case 'demo/hello':
      return (
        isRequestId(value.requestId) && typeof value.name === 'string' && value.name.length <= 80
      );
    default:
      return false;
  }
}

function isSnapshot(value: unknown): value is PanelSnapshot {
  if (!isRecord(value)) return false;
  const { workspace, settings, state, git } = value;
  return (
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
        (repository.branch === null || typeof repository.branch === 'string'),
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
    case 'host/error':
      return (
        typeof value.message === 'string' &&
        (value.requestId === undefined || isRequestId(value.requestId))
      );
    default:
      return false;
  }
}
