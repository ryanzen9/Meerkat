import { expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../src/shared/protocol';

mock.module('vscode', () => ({
  Uri: {
    joinPath: (uri: { toString(): string }, ...paths: string[]) => ({
      toString: () => `${uri.toString()}/${paths.join('/')}`,
    }),
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
