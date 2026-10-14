import { expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../src/shared/protocol';

const nativeCalls: { action: string; value: unknown }[] = [];
let gitExtension: unknown;

mock.module('vscode', () => ({
  Uri: {
    parse: (value: string) => {
      const url = new URL(value);
      return { scheme: url.protocol.slice(0, -1), path: url.pathname, toString: () => value };
    },
    joinPath: (uri: { toString(): string }, ...paths: string[]) => ({
      toString: () => `${uri.toString()}/${paths.join('/')}`,
    }),
  },
  workspace: {
    isTrusted: true,
    getWorkspaceFolder: (uri: { path: string }) =>
      uri.path.startsWith('/workspace/') ? {} : undefined,
    openTextDocument: async (value: unknown) => {
      nativeCalls.push({ action: 'document', value });
      return value;
    },
  },
  window: {
    showTextDocument: async (value: unknown) => {
      nativeCalls.push({ action: 'editor', value });
    },
  },
  env: {
    clipboard: {
      writeText: async (value: string) => {
        nativeCalls.push({ action: 'clipboard', value });
      },
    },
  },
  commands: {
    executeCommand: async (value: string) => {
      nativeCalls.push({ action: 'command', value });
    },
  },
  extensions: { getExtension: () => gitExtension },
  EventEmitter: class {
    private signal = signal<void>();
    event = this.signal.event;
    fire() {
      this.signal.emit(undefined);
    }
    dispose() {
      this.signal.clear();
    }
  },
}));
const { ReviewPanelProvider } = await import('../src/extension/providers/ReviewPanelProvider');

function signal<T>() {
  const listeners = new Set<(value: T) => unknown>();
  return {
    event: (listener: (value: T) => unknown) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (value: T) => {
      for (const listener of listeners) listener(value);
    },
    size: () => listeners.size,
    clear: () => listeners.clear(),
  };
}

function fakeView() {
  const receive = signal<unknown>();
  const dispose = signal<void>();
  const visible = signal<void>();
  const sent: ExtensionToWebviewMessage[] = [];
  const webview = {
    options: {} as vscode.WebviewOptions,
    cspSource: 'https://webview.invalid',
    asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: receive.event,
    postMessage: async (message: ExtensionToWebviewMessage) => {
      sent.push(message);
      return true;
    },
    set html(_value: string) {
      expect(receive.size()).toBe(1);
    },
  };
  return {
    receive,
    dispose,
    visible,
    sent,
    webview,
    view: {
      webview,
      visible: true,
      onDidDispose: dispose.event,
      onDidChangeVisibility: visible.event,
    } as unknown as vscode.WebviewView,
  };
}

const output = { warn() {}, error() {}, debug() {} } as unknown as vscode.LogOutputChannel;
const uri = { toString: () => 'file:///extension' } as vscode.Uri;
const parseUri = (value: string) =>
  ({ path: new URL(value).pathname, toString: () => value }) as vscode.Uri;
const services = () => ({
  workspace: { read: () => ({ name: 'test', folders: [], trusted: true }) },
  settings: { read: () => ({ greeting: 'Hello', showWorkspacePaths: true }) },
  state: {
    read: () => ({ messageCount: 0 }),
    incrementMessageCount: async () => ({ messageCount: 1 }),
  },
  git: { read: async () => ({ available: false, repositories: [] }) },
});

test('provider waits for readiness, validates requests, replies, and disposes listeners', async () => {
  const provider = new ReviewPanelProvider(uri, services(), output);
  const view = fakeView();
  provider.resolveWebviewView(view.view);
  expect(view.webview.options.enableScripts).toBe(true);
  expect(view.webview.options.localResourceRoots?.[0]?.toString()).toBe(
    'file:///extension/dist/webview',
  );
  await provider.refresh();
  expect(view.sent).toHaveLength(0);
  view.receive.emit({ type: 'webview/ready' });
  await Bun.sleep(1);
  expect(view.sent[0]?.type).toBe('host/snapshot');
  view.receive.emit({ type: 'demo/hello', requestId: '1', name: 123 });
  view.receive.emit({ type: 'demo/hello', requestId: '2', name: 'Ruby' });
  await Bun.sleep(1);
  expect(view.sent[1]).toEqual({
    type: 'host/hello',
    requestId: '2',
    message: 'Ruby，Hello',
    messageCount: 1,
  });
  expect(view.sent).toHaveLength(2);
  view.dispose.emit();
  expect(view.receive.size()).toBe(0);
  await provider.refresh();
  expect(view.sent).toHaveLength(2);
});

test('an in-flight response from a disposed view cannot reach its replacement', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dependencies = services();
  dependencies.git.read = async () => {
    await wait;
    return { available: false, repositories: [] };
  };
  const provider = new ReviewPanelProvider(uri, dependencies, output);
  const oldView = fakeView();
  provider.resolveWebviewView(oldView.view);
  oldView.receive.emit({ type: 'webview/ready' });
  const newView = fakeView();
  provider.resolveWebviewView(newView.view);
  release();
  await Bun.sleep(1);
  expect(oldView.sent).toHaveLength(0);
  expect(newView.sent).toHaveLength(0);
  expect(oldView.receive.size()).toBe(0);
  provider.dispose();
});

test('editor actions acknowledge requests and reject files outside the workspace', async () => {
  nativeCalls.length = 0;
  const provider = new ReviewPanelProvider(uri, services(), output);
  const view = fakeView();
  provider.resolveWebviewView(view.view);
  view.receive.emit({
    type: 'file/open',
    requestId: 'outside',
    uri: 'file:///private/secrets.txt',
  });
  view.receive.emit({
    type: 'file/open',
    requestId: 'command',
    uri: 'command:workbench.action.closeWindow',
  });
  await Bun.sleep(1);
  expect(nativeCalls).toHaveLength(0);
  expect(view.sent.every(({ type }) => type === 'host/error')).toBe(true);
  view.receive.emit({
    type: 'code/open',
    requestId: 'code',
    code: 'const value = 1;',
    language: 'ts',
  });
  view.receive.emit({ type: 'clipboard/write', requestId: 'copy', text: 'snippet' });
  view.receive.emit({ type: 'settings/open', requestId: 'settings' });
  view.receive.emit({
    type: 'file/open',
    requestId: 'file',
    uri: 'file:///workspace/repo/file.ts',
  });
  await Bun.sleep(1);
  expect(nativeCalls).toContainEqual({
    action: 'document',
    value: { content: 'const value = 1;', language: 'typescript' },
  });
  expect(nativeCalls).toContainEqual({ action: 'clipboard', value: 'snippet' });
  expect(nativeCalls).toContainEqual({ action: 'command', value: 'workbench.action.openSettings' });
  expect(view.sent.filter(({ type }) => type === 'host/action')).toHaveLength(4);
  provider.dispose();
});

test('Git snapshots group real changes, update listeners and dispose them', async () => {
  const { GitService } = await import('../src/extension/services/GitService');
  const changed = signal<void>();
  const opened = signal<unknown>();
  const closed = signal<unknown>();
  const repository = {
    rootUri: parseUri('file:///workspace/repo'),
    state: {
      HEAD: { name: 'main' },
      remotes: [{ name: 'origin' }],
      workingTreeChanges: [{ uri: parseUri('file:///workspace/repo/changed.ts'), status: 5 }],
      indexChanges: [{ uri: parseUri('file:///workspace/repo/staged.ts'), status: 1 }],
      mergeChanges: [{ uri: parseUri('file:///workspace/repo/conflict.ts'), status: 12 }],
      untrackedChanges: [{ uri: parseUri('file:///workspace/repo/new.ts'), status: 7 }],
      onDidChange: changed.event,
    },
  };
  gitExtension = {
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        repositories: [repository],
        onDidOpenRepository: opened.event,
        onDidCloseRepository: closed.event,
      }),
    },
  };
  const service = new GitService(output);
  let updates = 0;
  const listener = service.onDidChange(() => updates++);
  const snapshot = await service.read();
  expect(snapshot.repositories[0]?.changes.map(({ kind }) => kind)).toEqual([
    'modified',
    'conflict',
    'added',
  ]);
  expect(snapshot.repositories[0]?.stagedChanges[0]?.kind).toBe('added');
  expect(snapshot.repositories[0]?.name).toBe('repo');
  changed.emit();
  expect(updates).toBe(1);
  closed.emit(repository);
  expect(changed.size()).toBe(0);
  opened.emit(repository);
  expect(changed.size()).toBe(1);
  service.dispose();
  listener.dispose();
  expect(changed.size() + opened.size() + closed.size()).toBe(0);
  gitExtension = undefined;
});
