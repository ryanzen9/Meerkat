import { expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../src/shared/protocol';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewFixture } from './reviewFixture';
import { BridgeError } from '../src/extension/bridge/errors';
import { ReviewJournal } from '../src/extension/bridge/sessions/reviews';
import { GitCommands } from '../src/extension/services/GitCommands';
import type { ReviewFindingChange } from '../src/shared/review';
import type { ReviewSnapshotState } from '../src/shared/review';
import { FileReferenceArchive } from '../src/extension/bridge/sessions/fileReferenceArchive';
import { ReviewContext } from '../src/extension/bridge/tools/reviewContext';
import { BridgeRuntime } from '../src/extension/bridge/runtime/bridgeRuntime';
import { ProviderRegistry } from '../src/extension/bridge/providers/registry';
import type { ReviewStorage } from '../src/extension/bridge/sessions/reviewArchive';

const nativeCalls: { action: string; value: unknown }[] = [];
const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
let gitExtension: unknown;
let activeEditor: vscode.TextEditor | undefined;
let referenceEditorColumn = 1;
const editorDocuments: vscode.TextDocument[] = [];
let foundFiles: vscode.Uri[] = [];
let editorDiagnostics: vscode.Diagnostic[] = [];
let navigationRoot: string | undefined;
const fileDocuments = new Map<string, vscode.TextDocument>();
const contentProviders = new Map<string, vscode.TextDocumentContentProvider>();
const pushDialogs: { message: string; options: vscode.MessageOptions; label: string }[] = [];
let answerPushDialog: (label: string) => Promise<string | undefined> = async (label) => label;

const localUri = (path: string) => ({
  scheme: 'file',
  path,
  fsPath: path,
  toString: () => `file://${path}`,
});

mock.module('vscode', () => ({
  Uri: {
    file: localUri,
    parse: (value: string) => {
      const url = new URL(value);
      const path = decodeURIComponent(url.pathname);
      return {
        scheme: url.protocol.slice(0, -1),
        authority: url.host,
        path,
        fsPath: path,
        query: url.search.slice(1),
        toString: () => value,
      };
    },
    from: (parts: { scheme: string; path: string; query?: string }) => ({
      ...parts,
      toString: () => `${parts.scheme}:${encodeURI(parts.path)}?${parts.query ?? ''}`,
    }),
    joinPath: (uri: { toString(): string }, ...paths: string[]) => ({
      toString: () => `${uri.toString()}/${paths.join('/')}`,
    }),
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ name: 'repo', uri: localUri('/workspace/repo') }],
    textDocuments: editorDocuments,
    findFiles: async (...args: unknown[]) => {
      nativeCalls.push({ action: 'findFiles', value: args });
      return foundFiles;
    },
    getWorkspaceFolder: (uri: { path: string }) =>
      uri.path.startsWith('/workspace/') ||
      (navigationRoot && uri.path.startsWith(`${navigationRoot}/`))
        ? {}
        : undefined,
    registerTextDocumentContentProvider: (
      scheme: string,
      provider: vscode.TextDocumentContentProvider,
    ) => {
      contentProviders.set(scheme, provider);
      return { dispose: () => contentProviders.delete(scheme) };
    },
    openTextDocument: async (value: unknown) => {
      nativeCalls.push({ action: 'document', value });
      const uri = value as vscode.Uri;
      const document = fileDocuments.get(uri.toString());
      if (document) return document;
      const provider = contentProviders.get(uri.scheme);
      if (provider)
        return textDocument(
          uri,
          (await provider.provideTextDocumentContent(uri, {} as vscode.CancellationToken)) ?? '',
        );
      return value;
    },
  },
  window: {
    showErrorMessage: async (message: string) => {
      nativeCalls.push({ action: 'error-message', value: message });
    },
    get activeTextEditor() {
      return activeEditor;
    },
    showInformationMessage: async (
      message: string,
      options: vscode.MessageOptions,
      label: string,
    ) => {
      pushDialogs.push({ message, options, label });
      return answerPushDialog(label);
    },
    showTextDocument: async (value: unknown, options: unknown) => {
      nativeCalls.push({ action: 'editor', value });
      nativeCalls.push({ action: 'editor-options', value: options });
      return {
        viewColumn:
          (options as vscode.TextDocumentShowOptions).viewColumn === -2
            ? 2
            : (options as vscode.TextDocumentShowOptions).viewColumn === -1
              ? referenceEditorColumn
              : ((options as vscode.TextDocumentShowOptions).viewColumn ?? referenceEditorColumn),
        revealRange: (...args: unknown[]) => nativeCalls.push({ action: 'reveal', value: args }),
      };
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
    registerCommand: (id: string, action: (...args: unknown[]) => unknown) => {
      registeredCommands.set(id, action);
      return {
        dispose: () => {
          if (registeredCommands.get(id) === action) registeredCommands.delete(id);
        },
      };
    },
    executeCommand: async (value: string) => {
      nativeCalls.push({ action: 'command', value });
    },
  },
  extensions: { getExtension: () => gitExtension },
  languages: { getDiagnostics: () => editorDiagnostics },
  comments: {
    createCommentController: (id: string, label: string) => {
      const threads: { disposed: boolean }[] = [];
      const controller = {
        id,
        label,
        disposed: false,
        createCommentThread: (uri: vscode.Uri, range: vscode.Range, comments: vscode.Comment[]) => {
          const thread = {
            uri,
            range,
            comments,
            canReply: true,
            collapsibleState: 0,
            disposed: false,
            dispose() {
              this.disposed = true;
            },
          };
          threads.push(thread);
          nativeCalls.push({ action: 'comment-thread', value: thread });
          return thread;
        },
        dispose() {
          this.disposed = true;
          for (const thread of threads) thread.disposed = true;
        },
      };
      nativeCalls.push({ action: 'comment-controller', value: controller });
      return controller;
    },
  },
  MarkdownString: class {
    value = '';
    appendText(value: string) {
      this.value += value;
      return this;
    }
    appendMarkdown(value: string) {
      this.value += value;
      return this;
    }
  },
  CommentMode: { Preview: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  ViewColumn: { Active: -1, Beside: -2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 3 },
  Range: class {
    readonly start: { line: number; character: number };
    readonly end: { line: number; character: number };
    constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  },
  RelativePattern: class {
    constructor(
      readonly base: string,
      readonly pattern: string,
    ) {}
  },
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
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
const { ReferenceEditorService } = await import('../src/extension/services/ReferenceEditorService');

function textDocument(uri: vscode.Uri, text: string): vscode.TextDocument {
  const lines = text.split(/\r\n|\r|\n/);
  return {
    uri,
    getText: () => text,
    lineCount: lines.length,
    lineAt: (index: number) => ({ text: lines[index]! }),
  } as unknown as vscode.TextDocument;
}

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
const parseUri = (value: string) => {
  const parsed = new URL(value);
  const path = decodeURIComponent(parsed.pathname);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path,
    fsPath: path,
    toString: () => value,
  } as vscode.Uri;
};
const services = () => ({
  workspace: { read: () => ({ name: 'test', folders: [], trusted: true }) },
  settings: { read: () => ({ greeting: 'Hello', showWorkspacePaths: true }) },
  state: {
    read: () => ({ messageCount: 0 }),
    incrementMessageCount: async () => ({ messageCount: 1 }),
  },
  git: {
    read: async () => ({ available: false, repositories: [] }),
    stage: async () => {},
    unstage: async () => {},
    commit: async () => {},
    stageAll: async () => {},
    unstageAll: async () => {},
    push: async () => {},
    undoCommit: async () => {},
  },
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

test('provider routes file staging, unstaging and commit requests through GitService', async () => {
  const calls: unknown[][] = [];
  const dependency = {
    ...services(),
    git: {
      ...services().git,
      stage: async (...args: string[]) => {
        calls.push(['stage', ...args]);
      },
      unstage: async (...args: string[]) => {
        calls.push(['unstage', ...args]);
      },
      commit: async (...args: string[]) => {
        calls.push(['commit', ...args]);
      },
      stageAll: async (...args: string[]) => {
        calls.push(['stageAll', ...args]);
      },
      unstageAll: async (...args: string[]) => {
        calls.push(['unstageAll', ...args]);
      },
      push: async (...args: string[]) => {
        calls.push(['push', ...args]);
      },
      undoCommit: async (...args: string[]) => {
        calls.push(['undoCommit', ...args]);
      },
    },
  };
  const provider = new ReviewPanelProvider(uri, dependency, output);
  const view = fakeView();
  provider.resolveWebviewView(view.view);
  view.receive.emit({
    type: 'git/stage',
    requestId: 'stage',
    repositoryUri: 'file:///workspace/repo',
    uri: 'file:///workspace/repo/new.ts',
  });
  view.receive.emit({
    type: 'git/unstage',
    requestId: 'unstage',
    repositoryUri: 'file:///workspace/repo',
    uri: 'file:///workspace/repo/new.ts',
  });
  view.receive.emit({
    type: 'git/commit',
    requestId: 'commit',
    repositoryUri: 'file:///workspace/repo',
    message: 'Add new file',
  });
  for (const type of ['git/stage-all', 'git/unstage-all', 'git/push', 'git/undo-commit'])
    view.receive.emit({
      type,
      requestId: type,
      repositoryUri: 'file:///workspace/repo',
      branch: 'main',
      head: 'a'.repeat(40),
    });
  await Bun.sleep(2);
  expect(calls).toEqual([
    ['stage', 'file:///workspace/repo', 'file:///workspace/repo/new.ts'],
    ['unstage', 'file:///workspace/repo', 'file:///workspace/repo/new.ts'],
    ['commit', 'file:///workspace/repo', 'Add new file'],
    ['stageAll', 'file:///workspace/repo'],
    ['unstageAll', 'file:///workspace/repo'],
    ['push', 'file:///workspace/repo', 'main', 'a'.repeat(40)],
    ['undoCommit', 'file:///workspace/repo', 'main', 'a'.repeat(40)],
  ]);
  expect(
    view.sent
      .filter(({ type }) => type === 'host/snapshot' || type === 'host/ack')
      .map(({ requestId }) => requestId),
  ).toEqual([
    'stage',
    'unstage',
    'commit',
    'git/stage-all',
    'git/unstage-all',
    'git/push',
    'git/undo-commit',
  ]);
  provider.dispose();
});

test('slow Git snapshots cannot replace newer state and superseded requests still receive an acknowledgement', async () => {
  const dependency = services();
  let release!: () => void;
  let count = 0;
  dependency.git.read = async () => {
    if (++count === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return { available: true, repositories: [] };
  };
  const provider = new ReviewPanelProvider(uri, dependency, output);
  const view = fakeView();
  provider.resolveWebviewView(view.view);
  view.receive.emit({ type: 'workspace/refresh', requestId: 'older' });
  view.receive.emit({ type: 'workspace/refresh', requestId: 'newer' });
  await Bun.sleep(1);
  release();
  await Bun.sleep(1);
  expect(
    view.sent
      .filter((message) => message.type === 'host/snapshot')
      .map((message) => message.requestId),
  ).toEqual(['newer']);
  expect(view.sent.at(-1)).toEqual({ type: 'host/ack', requestId: 'older' });
  provider.dispose();
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

test('reference clicks resolve the session region, open the live file, select inclusive lines and reveal it', async () => {
  const content = 'one\r\n😀two\r\nthree';
  const f = await reviewFixture({ 'file.ts': content });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const reference = (
    await f.context.citeFiles({
      reviewId,
      references: [{ path: 'file.ts', version: 'new', startLine: 1, endLine: 2 }],
    })
  ).references[0]!;
  const fileUri = localUri(join(f.root, 'file.ts')) as vscode.Uri;
  const document = textDocument(fileUri, content);
  fileDocuments.set(fileUri.toString(), document);
  navigationRoot = f.root;
  const navigation = new ReferenceEditorService({
    readFileReference: async (sessionId, referenceId) => {
      expect(sessionId).toBe('host-session');
      return { ...(await f.context.readFileReference(referenceId)), findings: [] };
    },
  });
  const provider = new ReviewPanelProvider(
    uri,
    { ...services(), referenceEditor: navigation },
    output,
  );
  try {
    const view = fakeView();
    provider.resolveWebviewView(view.view);
    const completed = new Promise<void>((resolve) => {
      view.webview.postMessage = async (message) => {
        view.sent.push(message);
        resolve();
        return true;
      };
    });
    nativeCalls.length = 0;
    view.receive.emit({
      type: 'reference/open',
      requestId: 'region',
      sessionId: 'host-session',
      referenceId: reference.referenceId,
    });
    await completed;
    expect(view.sent).toEqual([{ type: 'host/action', requestId: 'region' }]);
    expect(nativeCalls.find(({ action }) => action === 'editor')?.value).toBe(document);
    const options = nativeCalls.find(({ action }) => action === 'editor-options')!
      .value as vscode.TextDocumentShowOptions;
    expect(options).toMatchObject({
      viewColumn: -1,
      preview: true,
      preserveFocus: false,
      selection: { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } },
    });
    expect(nativeCalls).toContainEqual({ action: 'reveal', value: [options.selection, 3] });
    expect(nativeCalls.filter(({ action }) => action === 'document')).toHaveLength(1);
  } finally {
    provider.dispose();
    navigation.dispose();
    fileDocuments.clear();
    navigationRoot = undefined;
  }
});

test('whole-file references open live and snapshot documents, including empty files, without selecting text', async () => {
  const content = Array.from({ length: 600 }, () => 'line').join('\n');
  const f = await reviewFixture({ 'file.ts': content, 'empty.ts': '' });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const references = (
    await f.context.citeFiles({
      reviewId,
      references: [
        { path: 'file.ts', version: 'new', scope: 'file' },
        { path: 'file.ts', version: 'old', scope: 'file' },
        { path: 'empty.ts', version: 'new', scope: 'file' },
      ],
    })
  ).references;
  const fileUri = localUri(join(f.root, 'file.ts')) as vscode.Uri;
  const emptyUri = localUri(join(f.root, 'empty.ts')) as vscode.Uri;
  fileDocuments.set(fileUri.toString(), textDocument(fileUri, content));
  fileDocuments.set(emptyUri.toString(), textDocument(emptyUri, ''));
  navigationRoot = f.root;
  const navigation = new ReferenceEditorService({
    readFileReference: async (_sessionId, referenceId) => ({
      ...(await f.context.readFileReference(referenceId)),
      findings: [],
    }),
  });
  try {
    for (const scenario of ['live', 'old', 'edited', 'empty'] as const) {
      if (scenario === 'edited') {
        await f.write('file.ts', 'changed\n');
        fileDocuments.set(fileUri.toString(), textDocument(fileUri, 'changed\n'));
      }
      nativeCalls.length = 0;
      const reference = references[scenario === 'empty' ? 2 : scenario === 'old' ? 1 : 0]!;
      await navigation.open('host-session', reference.referenceId);
      const document = nativeCalls.find(({ action }) => action === 'editor')!
        .value as vscode.TextDocument;
      expect(document.uri.scheme).toBe(
        scenario === 'old' || scenario === 'edited' ? 'meerkat-review' : 'file',
      );
      expect(document.getText()).toBe(scenario === 'empty' ? '' : content);
      const options = nativeCalls.find(({ action }) => action === 'editor-options')!
        .value as vscode.TextDocumentShowOptions;
      expect(Object.hasOwn(options, 'selection')).toBe(false);
      expect(options).toMatchObject({ viewColumn: -1, preview: true, preserveFocus: false });
      expect(nativeCalls.some(({ action }) => action === 'reveal')).toBe(false);
    }
  } finally {
    navigation.dispose();
    fileDocuments.clear();
    navigationRoot = undefined;
  }
});

test('saved review references follow the active editor group and show deduplicated native comments on the exact code', async () => {
  const content = 'one\nunchecked\nthree\n';
  const f = await reviewFixture();
  await f.write('file.ts', content);
  const journal = new ReviewJournal();
  const run = journal.start(crypto.randomUUID(), crypto.randomUUID(), 'Review', f.context);
  const { reviewId } = await run.track('list_changes', () =>
    f.context.listChanges({ scope: 'all' }),
  );
  await run.track('get_diff', () => f.context.getDiff({ reviewId, paths: ['file.ts'] }));
  const references = (
    await f.context.citeFiles({
      reviewId,
      references: [
        { path: 'file.ts', version: 'new', startLine: 2, endLine: 2 },
        { path: 'file.ts', version: 'old', startLine: 1, endLine: 1 },
      ],
    })
  ).references;
  const input = {
    reviewId,
    title: 'Missing validation',
    priority: 'P1' as const,
    description: `Validate the \`value\` in ${references[0]!.markdown}.`,
    referenceIds: references.map(({ referenceId }) => referenceId),
  };
  const receipt = await run.submit(input, 'original');
  await run.submit(input, 'duplicate');
  run.finish({ status: 'completed', unfinishedItems: [], limitations: [] });
  run.settle('completed');
  const findingChanges = signal<ReviewFindingChange>();
  let statusFailure = false;
  let statusGate: Promise<void> | undefined;
  const statusWrites: unknown[][] = [];
  const bridge = {
    onDidChangeFinding: findingChanges.event,
    setFindingStatus: async (
      sessionId: string,
      findingId: string,
      status: 'resolved' | 'unresolved',
    ) => {
      statusWrites.push([sessionId, findingId, status]);
      if (statusGate) await statusGate;
      if (statusFailure) throw new Error('Persistence failed');
      return journal.setFindingStatus(findingId, status);
    },
    readFileReference: async (sessionId: string, referenceId: string) => {
      expect(sessionId).toBe(run.state.sessionId);
      return {
        ...(await f.context.readFileReference(referenceId)),
        findings: journal.findingsForReference(referenceId),
      };
    },
  };
  const fileUri = localUri(join(f.root, 'file.ts')) as vscode.Uri;
  fileDocuments.set(fileUri.toString(), textDocument(fileUri, content));
  navigationRoot = f.root;
  let navigation = new ReferenceEditorService(bridge);
  nativeCalls.length = 0;
  const createdThreads = () =>
    nativeCalls
      .filter(({ action }) => action === 'comment-thread')
      .map(({ value }) => value as vscode.CommentThread & { disposed: boolean });
  try {
    await navigation.open(run.state.sessionId, references[0]!.referenceId);
    expect(nativeCalls.find(({ action }) => action === 'editor-options')!.value).toMatchObject({
      viewColumn: -1,
      preserveFocus: false,
      selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
    });
    const thread = createdThreads()[0]!;
    expect(thread.uri.toString()).toBe(fileUri.toString());
    expect(thread.range).toMatchObject({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 9 },
    });
    expect(thread.label).toBe('[P1] Missing validation · 未解决');
    expect(thread.state).toBe(0);
    expect(thread.contextValue).toBe('meerkat.review.unresolved');
    expect(thread.canReply).toBe(false);
    expect(thread.collapsibleState).toBe(1);
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]).toMatchObject({
      author: { name: 'Meerkat' },
      mode: 1,
      timestamp: new Date(receipt.finding.savedAt),
    });
    const body = thread.comments[0]!.body as vscode.MarkdownString;
    expect(body.value).toContain('Validate the `value`');
    expect(body.value).toContain(`${fileUri.toString()}#L2-L2`);
    expect(body.value).not.toContain('review-file:');
    expect(body.isTrusted).toBe(false);
    expect(body.supportHtml).toBe(false);
    // Moving to a different editor group must not reuse the first review's group.
    referenceEditorColumn = 3;
    thread.collapsibleState = 0;
    await Promise.all([
      navigation.open(run.state.sessionId, references[0]!.referenceId),
      navigation.open(run.state.sessionId, references[0]!.referenceId),
    ]);
    expect(createdThreads()).toHaveLength(1);
    expect(createdThreads()[0]!.collapsibleState).toBe(1);
    expect(
      nativeCalls.filter(({ action }) => action === 'editor-options').at(-1)!.value,
    ).toMatchObject({
      viewColumn: -1,
    });

    await f.write('file.ts', 'edited after review\n');
    fileDocuments.set(fileUri.toString(), textDocument(fileUri, 'edited after review\n'));
    await navigation.open(run.state.sessionId, references[0]!.referenceId);
    expect(thread.disposed).toBe(true);
    const snapshotThread = createdThreads().at(-1)!;
    expect(snapshotThread.uri.scheme).toBe('meerkat-review');
    expect(snapshotThread.uri.path).toBe('/new/file.ts');
    expect(snapshotThread.range).toMatchObject({ start: { line: 1 }, end: { line: 1 } });
    expect(
      (
        nativeCalls.filter(({ action }) => action === 'editor').at(-1)!.value as vscode.TextDocument
      ).getText(),
    ).toBe(content);
    await navigation.open(run.state.sessionId, references[1]!.referenceId);
    expect(createdThreads().at(-1)!.uri.path).toBe('/old/file.ts');
    expect(createdThreads().at(-1)!.range.start.line).toBe(0);
    const oldThread = createdThreads().at(-1)!;
    const resolveFinding = registeredCommands.get('meerkat.resolveReviewFinding')!;
    const reopenFinding = registeredCommands.get('meerkat.reopenReviewFinding')!;
    let release!: () => void;
    statusGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingResolve = resolveFinding(snapshotThread);
    const duplicateResolve = resolveFinding(oldThread);
    expect(statusWrites).toEqual([[run.state.sessionId, receipt.finding.id, 'resolved']]);
    expect(snapshotThread.contextValue).toBe('meerkat.review.saving');
    expect(oldThread.contextValue).toBe('meerkat.review.saving');
    expect(snapshotThread.state).toBe(0);
    release();
    await Promise.all([pendingResolve, duplicateResolve]);
    statusGate = undefined;
    expect(snapshotThread.state).toBe(1);
    expect(oldThread.state).toBe(1);
    expect(snapshotThread.contextValue).toBe('meerkat.review.resolved');
    expect(oldThread.label).toContain('已解决');
    await reopenFinding(oldThread);
    expect(snapshotThread.state).toBe(0);
    expect(journal.snapshot().findings[0]!.status).toBe('unresolved');
    statusFailure = true;
    await resolveFinding(snapshotThread);
    expect(snapshotThread.state).toBe(0);
    expect(snapshotThread.contextValue).toBe('meerkat.review.unresolved');
    expect(nativeCalls.at(-1)).toEqual({
      action: 'error-message',
      value: '审查状态保存失败，请重试。',
    });
    statusFailure = false;
    await resolveFinding(snapshotThread);
    const resolved = journal.snapshot().findings[0]!;
    const external = await journal.setFindingStatus(receipt.finding.id, 'unresolved');
    findingChanges.emit({ sessionId: run.state.sessionId, finding: external });
    findingChanges.emit({ sessionId: run.state.sessionId, finding: resolved });
    findingChanges.emit({
      sessionId: crypto.randomUUID(),
      finding: { ...external, status: 'resolved', statusRevision: 100 },
    });
    expect(snapshotThread.state).toBe(0);
    expect(oldThread.state).toBe(0);
    const writesBefore = statusWrites.length;
    await resolveFinding({ ...snapshotThread });
    await resolveFinding(thread);
    expect(statusWrites).toHaveLength(writesBefore);
    await resolveFinding(snapshotThread);
    navigation.dispose();
    expect(findingChanges.size()).toBe(0);
    expect(registeredCommands.has('meerkat.resolveReviewFinding')).toBe(false);
    expect(createdThreads().every(({ disposed }) => disposed)).toBe(true);

    // A new editor service restores annotations from receipts, never from UI text.
    navigation = new ReferenceEditorService(bridge);
    await navigation.open(run.state.sessionId, references[0]!.referenceId);
    expect(createdThreads().at(-1)!.disposed).toBe(false);
    expect(createdThreads().at(-1)!.label).toBe('[P1] Missing validation · 已解决');
    expect(createdThreads().at(-1)!.state).toBe(1);
    const before = createdThreads().length;
    await expect(
      navigation.open(run.state.sessionId, `ref_${'f'.repeat(64)}`),
    ).rejects.toMatchObject({ code: 'reference_not_found' });
    expect(createdThreads()).toHaveLength(before);
  } finally {
    navigation.dispose();
    fileDocuments.clear();
    navigationRoot = undefined;
    referenceEditorColumn = 1;
  }
});

test('Host replacement restores annotations; editor archiving persists without deleting findings or changing resolution', async () => {
  const f = await reviewFixture();
  const content = 'one\nunchecked\nthree\n';
  await f.write('file.ts', content);
  const directory = join(f.root, '.git', 'saved-references');
  const saved = new Map<string, ReviewSnapshotState>();
  const storage: ReviewStorage = {
    read: (id) => structuredClone(saved.get(id)),
    write: async (id, state) => {
      if (state) saved.set(id, structuredClone(state));
      else saved.delete(id);
    },
  };
  const archive = new FileReferenceArchive(directory);
  const original = new BridgeRuntime(new ProviderRegistry(), {}, undefined, storage, archive);
  const session = original.sessions.create('fixture', { model: 'fixture', accountId: 'account' });
  const context = new ReviewContext(f.workspace, archive.session(session.id));
  const run = session.reviews.start(crypto.randomUUID(), session.id, 'Review', context);
  const { reviewId } = await run.track('list_changes', () => context.listChanges({ scope: 'all' }));
  await run.track('get_diff', () => context.getDiff({ reviewId, paths: ['file.ts'] }));
  const references = (
    await context.citeFiles({
      reviewId,
      references: [
        { path: 'file.ts', version: 'new', startLine: 2, endLine: 2 },
        { path: 'file.ts', version: 'old', startLine: 1, endLine: 1 },
      ],
    })
  ).references;
  const reference = references[0]!;
  const receipt = await run.submit(
    {
      reviewId,
      title: 'Missing validation',
      priority: 'P1',
      description: 'Validate input.',
      referenceIds: references.map(({ referenceId }) => referenceId),
    },
    'saved',
  );
  await session.reviews.setFindingStatus(receipt.finding.id, 'resolved');
  run.settle('failed');
  await original.dispose();
  context.dispose();
  await f.write('file.ts', 'different code\n');
  const restored = new BridgeRuntime(
    new ProviderRegistry(),
    {},
    (savedReferences) => new ReviewContext(f.workspace, savedReferences),
    storage,
    new FileReferenceArchive(directory),
  );
  const changes = signal<ReviewFindingChange>();
  let archiveFailure = true;
  let archiveGate: Promise<void> | undefined;
  let archiveWrites = 0;
  let staleFinding: ReviewFindingChange['finding'] | undefined;
  const bridge = {
    onDidChangeFinding: changes.event,
    readFileReference: async (sessionId: string, referenceId: string) => {
      const result = await restored.readFileReference(sessionId, referenceId);
      return staleFinding ? { ...result, findings: [staleFinding] } : result;
    },
    setFindingStatus: (sessionId: string, findingId: string, status: 'resolved' | 'unresolved') =>
      restored.sessions.reviews.get(sessionId).setFindingStatus(findingId, status),
    setFindingArchived: async (sessionId: string, findingId: string, editorArchived: boolean) => {
      archiveWrites++;
      if (archiveFailure) throw new Error('Archive storage unavailable');
      await archiveGate;
      return restored.sessions.reviews.get(sessionId).updateFinding(findingId, { editorArchived });
    },
  };
  let navigation = new ReferenceEditorService(bridge);
  navigationRoot = f.root;
  nativeCalls.length = 0;
  try {
    await navigation.open(session.id, reference.referenceId);
    const thread = nativeCalls.find(({ action }) => action === 'comment-thread')!
      .value as vscode.CommentThread;
    expect(thread.uri.scheme).toBe('meerkat-review');
    expect(thread.label).toBe('[P1] Missing validation · 已解决');
    expect(thread.state).toBe(1);
    expect(thread.contextValue).toBe('meerkat.review.resolved');
    const provider = contentProviders.get('meerkat-review')!;
    expect(
      await provider.provideTextDocumentContent(thread.uri, {} as vscode.CancellationToken),
    ).toBe(content);
    await registeredCommands.get('meerkat.reopenReviewFinding')!(thread);
    expect(thread.state).toBe(0);
    expect(saved.get(session.id)!.findings[0]!.status).toBe('unresolved');
    expect(restored.sessions.list()).toHaveLength(0);
    await navigation.open(session.id, references[1]!.referenceId);
    const threads = () =>
      nativeCalls
        .filter(({ action }) => action === 'comment-thread')
        .map(({ value }) => value as vscode.CommentThread & { disposed: boolean });
    expect(threads()).toHaveLength(2);
    const archiveThread = registeredCommands.get('meerkat.archiveReviewFinding')!;
    await archiveThread({ ...thread });
    expect(archiveWrites).toBe(0);
    await archiveThread(thread);
    expect(archiveWrites).toBe(1);
    expect(threads().every(({ disposed }) => !disposed)).toBe(true);
    expect(nativeCalls.at(-1)).toEqual({
      action: 'error-message',
      value: '批注归档失败，请重试。',
    });
    archiveFailure = false;
    let releaseArchive!: () => void;
    archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    staleFinding = saved.get(session.id)!.findings[0]!;
    const archiving = archiveThread(thread);
    await Promise.resolve();
    expect(thread.contextValue).toBe('meerkat.review.saving');
    await archiveThread(thread);
    expect(archiveWrites).toBe(2);
    releaseArchive();
    await archiving;
    expect(threads().every(({ disposed }) => disposed)).toBe(true);
    expect(saved.get(session.id)!.findings[0]).toMatchObject({
      editorArchived: true,
      status: 'unresolved',
      references,
    });
    expect(saved.get(session.id)!.runs[0]!.issueCount).toBe(1);
    // A late reference-open response cannot recreate the disposed annotation.
    await navigation.open(session.id, reference.referenceId);
    expect(threads()).toHaveLength(2);
    await archiveThread(thread);
    expect(archiveWrites).toBe(2);
    staleFinding = undefined;
    navigation.dispose();
    expect(registeredCommands.has('meerkat.archiveReviewFinding')).toBe(false);
    navigation = new ReferenceEditorService(bridge);
    await navigation.open(session.id, reference.referenceId);
    expect(threads()).toHaveLength(2);
    const unarchived = await restored.sessions.reviews
      .get(session.id)
      .updateFinding(receipt.finding.id, { editorArchived: false });
    changes.emit({ sessionId: session.id, finding: unarchived });
    await navigation.open(session.id, reference.referenceId);
    expect(threads()).toHaveLength(3);
    expect(threads().at(-1)!.disposed).toBe(false);
    expect(threads().at(-1)!.state).toBe(0);
  } finally {
    navigation.dispose();
    navigationRoot = undefined;
    fileDocuments.clear();
    await restored.dispose();
  }
});

test('old, edited, deleted and symlink-replaced files open their exact read-only snapshot regions', async () => {
  const content = 'one\ntwo\nthree\n';
  const f = await reviewFixture({ 'file.ts': content });
  const outside = await reviewFixture({ 'file.ts': content });
  const { reviewId } = await f.context.listChanges({ scope: 'all' });
  const references = (
    await f.context.citeFiles({
      reviewId,
      references: [
        { path: 'file.ts', version: 'old', startLine: 2, endLine: 3 },
        { path: 'file.ts', version: 'new', startLine: 2, endLine: 3 },
      ],
    })
  ).references;
  const fileUri = localUri(join(f.root, 'file.ts')) as vscode.Uri;
  navigationRoot = f.root;
  const navigation = new ReferenceEditorService({
    readFileReference: async (_sessionId, referenceId) => ({
      ...(await f.context.readFileReference(referenceId)),
      findings: [],
    }),
  });
  try {
    for (const scenario of ['old', 'edited', 'deleted', 'symlink'] as const) {
      if (scenario === 'edited') {
        await f.write('file.ts', 'different\n');
        fileDocuments.set(fileUri.toString(), textDocument(fileUri, 'different\n'));
      } else if (scenario === 'deleted') await rm(join(f.root, 'file.ts'));
      else if (scenario === 'symlink')
        await symlink(join(outside.root, 'file.ts'), join(f.root, 'file.ts'));
      nativeCalls.length = 0;
      const reference = references[scenario === 'old' ? 0 : 1]!;
      await navigation.open('host-session', reference.referenceId);
      const document = nativeCalls.find(({ action }) => action === 'editor')!
        .value as vscode.TextDocument;
      expect(document.uri.scheme).toBe('meerkat-review');
      expect(document.uri.path).toBe(`/${reference.version}/file.ts`);
      expect(document.getText()).toBe(content);
      const options = nativeCalls.find(({ action }) => action === 'editor-options')!
        .value as vscode.TextDocumentShowOptions;
      expect(options.selection).toMatchObject({
        start: { line: 1, character: 0 },
        end: { line: 2, character: 5 },
      });
      if (scenario !== 'edited')
        expect(nativeCalls.filter(({ action }) => action === 'document')).toHaveLength(1);
    }
    const snapshotProvider = contentProviders.get('meerkat-review')!;
    const invalidUri = {
      scheme: 'meerkat-review',
      path: '/new/other.ts',
      query: new URLSearchParams({
        sessionId: 'host-session',
        referenceId: references[1]!.referenceId,
      }).toString(),
    } as vscode.Uri;
    await expect(
      Promise.resolve(
        snapshotProvider.provideTextDocumentContent(invalidUri, {} as vscode.CancellationToken),
      ),
    ).rejects.toMatchObject({ code: 'reference_not_found' });
  } finally {
    navigation.dispose();
    fileDocuments.clear();
    navigationRoot = undefined;
  }
  expect(contentProviders.has('meerkat-review')).toBe(false);
});

test('expired reference clicks show a specific recoverable error without opening an editor', async () => {
  const provider = new ReviewPanelProvider(
    uri,
    {
      ...services(),
      referenceEditor: {
        open: async () => {
          throw new BridgeError('reference_not_found', 'internal path');
        },
      },
    },
    output,
  );
  const view = fakeView();
  provider.resolveWebviewView(view.view);
  nativeCalls.length = 0;
  view.receive.emit({
    type: 'reference/open',
    requestId: 'expired',
    sessionId: 'host-session',
    referenceId: `ref_${'a'.repeat(64)}`,
  });
  await Bun.sleep(1);
  expect(view.sent).toEqual([
    {
      type: 'host/error',
      requestId: 'expired',
      message: '代码引用已失效（会话或快照已结束），请重新生成引用。',
    },
  ]);
  expect(nativeCalls).toHaveLength(0);
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

test('Git file actions stage, unstage and commit only current files from the selected repository', async () => {
  const { GitService } = await import('../src/extension/services/GitService');
  const changed = signal<void>();
  const rootUri = parseUri('file:///workspace/repo');
  const fileUri = parseUri('file:///workspace/repo/new.ts');
  const file = { uri: fileUri, status: 7 };
  const outsideUri = parseUri('file:///workspace/other/secret.ts');
  const state = {
    HEAD: { name: 'main' },
    remotes: [],
    workingTreeChanges: [file],
    indexChanges: [] as { uri: vscode.Uri; status: number }[],
    mergeChanges: [] as { uri: vscode.Uri; status: number }[],
    untrackedChanges: [] as { uri: vscode.Uri; status: number }[],
    onDidChange: changed.event,
  };
  const stagedPaths: string[] = [];
  const unstagedPaths: string[] = [];
  const messages: string[] = [];
  let statusCalls = 0;
  const repository = {
    rootUri,
    state,
    add: async (paths: string[]) => {
      stagedPaths.push(...paths);
      state.workingTreeChanges = state.workingTreeChanges.filter(
        ({ uri: changeUri }) => changeUri !== fileUri,
      );
      state.indexChanges = [file];
    },
    revert: async (paths: string[]) => {
      unstagedPaths.push(...paths);
      state.indexChanges = [];
      state.workingTreeChanges = [file];
    },
    commit: async (message: string, options: unknown) => {
      expect(options).toEqual({ all: false, postCommitCommand: null });
      messages.push(message);
      state.indexChanges = [];
    },
    status: async () => {
      statusCalls++;
    },
  };
  gitExtension = {
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        repositories: [repository],
        onDidOpenRepository: signal<unknown>().event,
        onDidCloseRepository: signal<unknown>().event,
      }),
    },
  };
  const service = new GitService(output);
  let updates = 0;
  const listener = service.onDidChange(() => updates++);

  await service.stage(rootUri.toString(), fileUri.toString());
  await service.unstage(rootUri.toString(), fileUri.toString());
  await service.stage(rootUri.toString(), fileUri.toString());
  await service.commit(rootUri.toString(), '  Add new file  ');
  expect(stagedPaths).toEqual(['/workspace/repo/new.ts', '/workspace/repo/new.ts']);
  expect(unstagedPaths).toEqual(['/workspace/repo/new.ts']);
  expect(messages).toEqual(['Add new file']);
  expect(statusCalls).toBe(8);
  expect(updates).toBe(4);

  state.workingTreeChanges = [{ uri: outsideUri, status: 7 }];
  await expect(service.stage(rootUri.toString(), outsideUri.toString())).rejects.toThrow(
    '文件不属于当前 Git 仓库',
  );
  service.dispose();
  listener.dispose();
  gitExtension = undefined;
});

async function gitActionsFixture() {
  pushDialogs.length = 0;
  answerPushDialog = async (label) => label;
  const { GitService } = await import('../src/extension/services/GitService');
  type Change = {
    uri: vscode.Uri;
    originalUri?: vscode.Uri;
    renameUri?: vscode.Uri;
    status: number;
  };
  const rootUri = parseUri('file:///workspace/repo');
  const state = {
    HEAD: {
      name: 'main',
      commit: undefined as string | undefined,
      upstream: undefined as { remote: string; name: string } | undefined,
      ahead: undefined as number | undefined,
      behind: undefined as number | undefined,
    },
    remotes: [] as { name: string; isReadOnly?: boolean }[],
    workingTreeChanges: [] as Change[],
    indexChanges: [] as Change[],
    mergeChanges: [] as Change[],
    untrackedChanges: [] as Change[],
    onDidChange: signal<void>().event,
  };
  const calls: unknown[][] = [];
  const repository = {
    rootUri,
    state,
    add: async (paths: string[]) => {
      calls.push(['add', paths]);
    },
    revert: async (paths: string[]) => {
      calls.push(['revert', paths]);
    },
    commit: async (message: string, options: unknown) => {
      calls.push(['commit', message, options]);
      state.indexChanges = [];
    },
    status: async () => {},
    push: async (...args: unknown[]) => {
      calls.push(['push', ...args]);
    },
  };
  gitExtension = {
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        git: { path: 'git' },
        // VS Code returns new wrappers for the same repository on each access.
        repositories: [{ ...repository }],
        onDidOpenRepository: signal<unknown>().event,
        onDidCloseRepository: signal<unknown>().event,
      }),
    },
  };
  const commands = new GitCommands();
  commands.unpublishedCount = async () => 1;
  const service = new GitService(output, commands);
  return { service, repository, state, calls, commands, root: rootUri.toString() };
}

test('bulk Git operations use one API call, preserve rename pairs and leave conflicts unresolved', async () => {
  const { service, state, calls, root } = await gitActionsFixture();
  const file = { uri: parseUri('file:///workspace/repo/new.ts'), status: 7 };
  const rename = {
    uri: parseUri('file:///workspace/repo/renamed.ts'),
    originalUri: parseUri('file:///workspace/repo/old.ts'),
    status: 10,
  };
  try {
    state.workingTreeChanges = [
      rename,
      file,
      { ...file, uri: parseUri('file:///workspace/repo/ignored.ts'), status: 8 },
    ];
    state.untrackedChanges = [file];
    state.mergeChanges = [
      { ...file, uri: parseUri('file:///workspace/repo/conflict.ts'), status: 16 },
    ];
    await service.stageAll(root);
    state.indexChanges = [file, rename];
    await service.unstageAll(root);
    expect(calls).toEqual([
      ['add', ['/workspace/repo/renamed.ts', '/workspace/repo/old.ts', '/workspace/repo/new.ts']],
      ['revert', []],
    ]);
    state.indexChanges = [];
    state.workingTreeChanges = [];
    state.untrackedChanges = [];
    await service.stageAll(root);
    await service.unstageAll(root);
    expect(calls).toHaveLength(2);
  } finally {
    service.dispose();
    gitExtension = undefined;
  }
});

test('push pins the branch and HEAD, targets its upstream ref and rejects stale or diverged state', async () => {
  const { service, state, calls, root } = await gitActionsFixture();
  const head = 'a'.repeat(40);
  Object.assign(state.HEAD, {
    commit: head,
    upstream: { remote: 'origin', name: 'remote-main' },
    ahead: 2,
    behind: 0,
  });
  state.remotes = [{ name: 'origin' }, { name: 'other' }];
  try {
    await service.push(root, 'main', head);
    expect(calls).toEqual([['push', 'origin', 'main:remote-main', false]]);
    expect(pushDialogs).toEqual([
      {
        message: '确认推送到远程仓库？',
        options: {
          modal: true,
          detail:
            '仓库：/workspace/repo\n本地分支：main\n远程目标：origin/remote-main\n未推送提交：2',
        },
        label: '推送',
      },
    ]);
    expect((await service.read()).repositories[0]!.sync).toMatchObject({
      head,
      upstream: 'origin/remote-main',
      ahead: 2,
      behind: 0,
      canUndo: true,
    });
    await expect(service.push(root, 'other', head)).rejects.toThrow('已变化');
    await expect(service.push(root, 'main', 'b'.repeat(40))).rejects.toThrow('已变化');
    state.HEAD.ahead = 0;
    await expect(service.push(root, 'main', head)).rejects.toThrow('没有未推送');
    state.HEAD.ahead = 1;
    state.HEAD.behind = 1;
    await expect(service.push(root, 'main', head)).rejects.toThrow('先拉取');
    expect(calls).toHaveLength(1);
    expect(pushDialogs).toHaveLength(1);
  } finally {
    service.dispose();
    gitExtension = undefined;
  }
});

test('an unpublished branch uses backend counts and can publish to its sole writable remote', async () => {
  const { service, state, calls, root, commands } = await gitActionsFixture();
  const head = 'a'.repeat(40);
  state.HEAD.commit = head;
  state.remotes = [{ name: 'origin' }];
  commands.unpublishedCount = async () => 3;
  try {
    expect((await service.read()).repositories[0]!.sync).toMatchObject({
      ahead: 3,
      upstream: null,
      canUndo: true,
    });
    await service.push(root, 'main', head);
    expect(calls).toEqual([['push', 'origin', 'main:main', true]]);
    expect(pushDialogs[0]).toMatchObject({ label: '发布并推送' });
    expect(pushDialogs[0]!.options.detail).toContain('未推送提交：3');
    state.remotes = [];
    await expect(service.push(root, 'main', head)).rejects.toThrow('配置可写');
  } finally {
    service.dispose();
    gitExtension = undefined;
  }
});

test('push waits for explicit confirmation and dismissing it preserves Git state and permits retry', async () => {
  const { service, state, calls, root } = await gitActionsFixture();
  const head = 'a'.repeat(40);
  Object.assign(state.HEAD, {
    commit: head,
    upstream: { remote: 'origin', name: 'main' },
    ahead: 2,
    behind: 0,
  });
  state.remotes = [{ name: 'origin' }];
  state.indexChanges = [{ uri: parseUri('file:///workspace/repo/staged.ts'), status: 1 }];
  let shown!: () => void;
  const visible = new Promise<void>((resolve) => {
    shown = resolve;
  });
  let dismiss!: (choice: string | undefined) => void;
  const choice = new Promise<string | undefined>((resolve) => {
    dismiss = resolve;
  });
  answerPushDialog = async () => {
    shown();
    return choice;
  };
  try {
    const pending = service.push(root, 'main', head);
    await visible;
    expect(calls).toHaveLength(0);
    dismiss(undefined);
    await pending;
    expect(calls).toHaveLength(0);
    expect(state.HEAD).toMatchObject({ commit: head, ahead: 2 });
    expect(state.indexChanges).toHaveLength(1);
    answerPushDialog = async (label) => label;
    await service.push(root, 'main', head);
    expect(calls).toEqual([['push', 'origin', 'main:main', false]]);
  } finally {
    dismiss(undefined);
    answerPushDialog = async (label) => label;
    service.dispose();
    gitExtension = undefined;
  }
});

test.each(['head', 'branch', 'upstream', 'behind', 'already-pushed', 'remote', 'read-only'])(
  'push revalidates %s changes made while its confirmation is open',
  async (change) => {
    const { service, state, calls, root } = await gitActionsFixture();
    const head = 'a'.repeat(40);
    Object.assign(state.HEAD, {
      commit: head,
      upstream: { remote: 'origin', name: 'main' },
      ahead: 2,
      behind: 0,
    });
    state.remotes = [{ name: 'origin' }];
    answerPushDialog = async (label) => {
      switch (change) {
        case 'head':
          state.HEAD.commit = 'b'.repeat(40);
          break;
        case 'branch':
          state.HEAD.name = 'other';
          break;
        case 'upstream':
          state.HEAD.upstream!.name = 'other';
          break;
        case 'behind':
          state.HEAD.behind = 1;
          break;
        case 'already-pushed':
          state.HEAD.ahead = 0;
          break;
        case 'remote':
          state.remotes = [];
          break;
        case 'read-only':
          state.remotes[0]!.isReadOnly = true;
          break;
      }
      return label;
    };
    try {
      await expect(service.push(root, 'main', head)).rejects.toThrow();
      expect(pushDialogs).toHaveLength(1);
      expect(calls).toHaveLength(0);
    } finally {
      answerPushDialog = async (label) => label;
      service.dispose();
      gitExtension = undefined;
    }
  },
);

test('undo validates the current branch and rejects published or repeated commits', async () => {
  const { service, state, calls, root, commands } = await gitActionsFixture();
  const head = 'a'.repeat(40);
  Object.assign(state.HEAD, {
    commit: head,
    upstream: { remote: 'origin', name: 'main' },
    ahead: 2,
    behind: 0,
  });
  commands.undo = async (...args) => {
    calls.push(['undo', ...args]);
    state.HEAD.commit = 'b'.repeat(40);
  };
  try {
    commands.unpublishedCount = async () => 0;
    await expect(service.undoCommit(root, 'main', head)).rejects.toThrow('已存在于远程');
    commands.unpublishedCount = async () => 1;
    await service.undoCommit(root, 'main', head);
    expect(calls).toEqual([['undo', 'git', '/workspace/repo', 'main', head]]);
    await expect(service.undoCommit(root, 'main', head)).rejects.toThrow('已变化');
    state.HEAD.ahead = 0;
    await expect(service.undoCommit(root, 'main', state.HEAD.commit!)).rejects.toThrow('尚未推送');
    expect(calls).toHaveLength(1);
  } finally {
    service.dispose();
    gitExtension = undefined;
  }
});

test('Git rename operations include both paths and reject paths outside the repository', async () => {
  const fixture = await gitActionsFixture();
  const { service, state, root, calls } = fixture;
  const rename = {
    uri: parseUri('file:///workspace/repo/new.ts'),
    originalUri: parseUri('file:///workspace/repo/old.ts'),
    status: 3,
  };
  try {
    state.indexChanges = [rename];
    await service.unstage(root, rename.uri.toString());
    state.workingTreeChanges = [{ ...rename, status: 10 }];
    await service.stage(root, rename.uri.toString());
    expect(calls).toEqual([
      ['revert', ['/workspace/repo/new.ts', '/workspace/repo/old.ts']],
      ['add', ['/workspace/repo/new.ts', '/workspace/repo/old.ts']],
    ]);
    state.indexChanges = [{ ...rename, originalUri: parseUri('file:///workspace/other/old.ts') }];
    await expect(service.unstage(root, rename.uri.toString())).rejects.toThrow('文件不属于');
    expect(calls).toHaveLength(2);
  } finally {
    service.dispose();
    gitExtension = undefined;
  }
});

test('Git mutations serialize across API wrappers and revalidate duplicate commits', async () => {
  const { service, state, repository, calls, root } = await gitActionsFixture();
  const file = { uri: parseUri('file:///workspace/repo/new.ts'), status: 1 };
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const commit = repository.commit;
  repository.commit = async (message, options) => {
    calls.push(['started']);
    await wait;
    await commit(message, options);
  };
  state.indexChanges = [file];
  try {
    const first = service.commit(root, 'first');
    const duplicate = service.commit(root, 'duplicate').then(
      () => '',
      (error: Error) => error.message,
    );
    await Bun.sleep(1);
    expect(calls).toEqual([['started']]);
    release();
    await first;
    expect(await duplicate).toContain('暂存区为空');
    expect(calls).toHaveLength(2);
    state.mergeChanges = [{ ...file, status: 16 }];
    await expect(service.commit(root, 'conflict')).rejects.toThrow('解决并暂存所有冲突');
    await expect(service.commit(root, '  ')).rejects.toThrow('请输入提交消息');
  } finally {
    release();
    service.dispose();
    gitExtension = undefined;
  }
});

test('a successful commit remains successful if its status refresh fails', async () => {
  const { service, state, repository, root, calls } = await gitActionsFixture();
  let statusCalls = 0;
  repository.status = async () => {
    if (++statusCalls === 2) throw new Error('refresh failed');
  };
  state.indexChanges = [{ uri: parseUri('file:///workspace/repo/new.ts'), status: 1 }];
  try {
    await service.commit(root, 'commit');
    expect(calls).toEqual([['commit', 'commit', { all: false, postCommitCommand: null }]]);
  } finally {
    service.dispose();
    gitExtension = undefined;
  }
});

test.each([
  {
    stdout: 'oxfmt --check\nAGENTS.md (139ms)\nFormat issues found in above 1 files.',
    stderr: 'husky - pre-commit script failed (code 1)',
    expected: '文件格式检查未通过',
  },
  {
    stdout: '',
    stderr: 'Type checking failed\nhusky - pre-commit script failed (code 1)',
    expected: '提交被 pre-commit 校验拦截',
  },
  {
    stdout: '',
    stderr: 'subject may not be empty\nhusky - commit-msg script failed (code 1)',
    expected: '提交消息未通过 commit-msg 校验',
  },
  {
    stdout: '',
    stderr: 'Tests failed\nhusky - pre-push hook exited with code 1 (error)',
    expected: '推送被 pre-push 校验拦截',
  },
])('Git hook errors explain the failed check: $expected', async ({ stdout, stderr, expected }) => {
  const { gitErrorMessage } = await import('../src/extension/services/GitService');
  const error = Object.assign(new Error('Failed to execute git'), {
    gitErrorCode: 'Unknown',
    stdout,
    stderr: `${stderr}\nhttps://user:secret@example.com/private`,
  });
  expect(gitErrorMessage(error)).toContain(expected);
  expect(gitErrorMessage(error)).not.toContain('secret');
  expect(gitErrorMessage({ stderr: 'unknown failure containing private data' })).toBe(
    'Git 操作失败，请查看 VS Code 的 Git 输出，修复后重试。',
  );
  expect(gitErrorMessage({ ...error, gitErrorCode: 'AuthenticationFailed' })).toContain(
    '远程认证失败',
  );
});

test('Git commit errors are actionable and snapshot failures do not reject completed mutations', async () => {
  const { GitOperationError } = await import('../src/extension/services/GitService');
  const dependencies = services();
  dependencies.git.commit = async () => {
    throw new GitOperationError('暂存区为空，没有可提交的更改。');
  };
  const provider = new ReviewPanelProvider(uri, dependencies, output);
  const view = fakeView();
  provider.resolveWebviewView(view.view);
  const message = {
    type: 'git/commit',
    requestId: 'empty',
    repositoryUri: 'file:///repo',
    message: 'test',
  };
  view.receive.emit(message);
  await Bun.sleep(1);
  expect(view.sent).toEqual([
    { type: 'host/error', requestId: 'empty', message: '暂存区为空，没有可提交的更改。' },
  ]);
  dependencies.git.commit = async () => {
    throw Object.assign(new Error('Failed to execute git'), {
      stdout: 'oxfmt --check\nAGENTS.md (139ms)\nFormat issues found in above 1 files.',
      stderr: 'husky - pre-commit script failed (code 1)',
    });
  };
  view.receive.emit({ ...message, requestId: 'format' });
  await Bun.sleep(1);
  expect(view.sent[1]).toMatchObject({
    type: 'host/error',
    requestId: 'format',
    message: expect.stringContaining('文件格式检查未通过'),
  });
  dependencies.git.commit = async () => {};
  dependencies.git.read = async () => {
    throw new Error('refresh failed');
  };
  view.receive.emit({ ...message, requestId: 'success' });
  await Bun.sleep(1);
  expect(view.sent.slice(2)).toEqual([
    { type: 'host/action', requestId: 'success' },
    { type: 'host/error', message: 'Git 操作已成功，但刷新状态失败，请刷新工作区。' },
  ]);
  provider.dispose();
});

test('VS Code review adapter reads editor buffers, converts coordinates and forwards native glob and diagnostics APIs', async () => {
  const { VSCodeReviewWorkspace } =
    await import('../src/extension/bridge/tools/vscodeReviewWorkspace');
  const document = {
    uri: localUri('/workspace/repo/file.ts'),
    isDirty: true,
    languageId: 'typescript',
    getText: () => 'unsaved buffer',
  } as unknown as vscode.TextDocument;
  activeEditor = {
    document,
    selection: { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } },
  } as vscode.TextEditor;
  editorDocuments.push(document, {
    ...document,
    uri: { scheme: 'untitled' },
  } as vscode.TextDocument);
  gitExtension = {
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        git: { path: '/custom/git' },
        repositories: [{ rootUri: localUri('/workspace/repo') }],
      }),
    },
  };
  foundFiles = [localUri('/workspace/repo/file.ts'), localUri('/outside/file.ts')] as vscode.Uri[];
  editorDiagnostics = [0, 1, 2, 3].map((severity) => ({
    severity,
    message: 'diagnostic',
    source: 'typescript',
    code: severity === 0 ? { value: 2322, target: localUri('/docs') } : 'test-code',
    range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
  })) as vscode.Diagnostic[];
  const workspace = new VSCodeReviewWorkspace(output);
  try {
    const state = await workspace.getState();
    expect(workspace.gitPath).toBe('/custom/git');
    expect(state.repositories).toEqual(['/workspace/repo']);
    expect(state.activeFile?.selection).toEqual({
      start: { line: 2, column: 3 },
      end: { line: 4, column: 5 },
    });
    expect(state.dirtyDocuments).toEqual([
      { path: '/workspace/repo/file.ts', text: 'unsaved buffer' },
    ]);
    expect(await workspace.findFiles('/workspace/repo', '**/*.ts', 10)).toEqual(['file.ts']);
    const args = nativeCalls.filter((call) => call.action === 'findFiles').at(-1)!
      .value as unknown[];
    expect(args[0]).toMatchObject({ base: '/workspace/repo', pattern: '**/*.ts' });
    expect(args[2]).toBe(10);
    const diagnostics = workspace.getDiagnostics(['/workspace/repo/file.ts']);
    expect(diagnostics.map((item) => item.severity)).toEqual([
      'error',
      'warning',
      'information',
      'hint',
    ]);
    expect(diagnostics[0]).toMatchObject({
      source: 'typescript',
      code: 2322,
      range: { start: { line: 2, column: 3 }, end: { line: 2, column: 6 } },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      workspace.findFiles('/workspace/repo', '**/*', 10, controller.signal),
    ).rejects.toBeDefined();
  } finally {
    workspace.dispose();
    activeEditor = undefined;
    editorDocuments.length = 0;
    foundFiles = [];
    editorDiagnostics = [];
    gitExtension = undefined;
  }
});
