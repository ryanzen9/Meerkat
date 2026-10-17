import { expect, mock, test } from 'bun:test';
import type * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../src/shared/protocol';
import { rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewFixture } from './reviewFixture';
import { BridgeError } from '../src/extension/bridge/errors';
import { ReviewJournal } from '../src/extension/bridge/sessions/reviews';

const nativeCalls: { action: string; value: unknown }[] = [];
let gitExtension: unknown;
let activeEditor: vscode.TextEditor | undefined;
const editorDocuments: vscode.TextDocument[] = [];
let foundFiles: vscode.Uri[] = [];
let editorDiagnostics: vscode.Diagnostic[] = [];
let navigationRoot: string | undefined;
const fileDocuments = new Map<string, vscode.TextDocument>();
const contentProviders = new Map<string, vscode.TextDocumentContentProvider>();

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
      return {
        scheme: url.protocol.slice(0, -1),
        path: decodeURIComponent(url.pathname),
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
    get activeTextEditor() {
      return activeEditor;
    },
    showTextDocument: async (value: unknown, options: unknown) => {
      nativeCalls.push({ action: 'editor', value });
      nativeCalls.push({ action: 'editor-options', value: options });
      return {
        viewColumn:
          (options as vscode.TextDocumentShowOptions).viewColumn === -2
            ? 2
            : ((options as vscode.TextDocumentShowOptions).viewColumn ?? 1),
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

test('saved review references open beside the chat and show deduplicated native comments on the exact code', async () => {
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
  const bridge = {
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
      viewColumn: -2,
      preserveFocus: false,
      selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 9 } },
    });
    const thread = createdThreads()[0]!;
    expect(thread.uri.toString()).toBe(fileUri.toString());
    expect(thread.range).toMatchObject({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 9 },
    });
    expect(thread.label).toBe('[P1] Missing validation');
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
      viewColumn: 2,
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
    navigation.dispose();
    expect(createdThreads().every(({ disposed }) => disposed)).toBe(true);

    // A new editor service restores annotations from receipts, never from UI text.
    navigation = new ReferenceEditorService(bridge);
    await navigation.open(run.state.sessionId, references[0]!.referenceId);
    expect(createdThreads().at(-1)!.disposed).toBe(false);
    expect(createdThreads().at(-1)!.label).toBe('[P1] Missing validation');
    const before = createdThreads().length;
    await expect(
      navigation.open(run.state.sessionId, `ref_${'f'.repeat(64)}`),
    ).rejects.toMatchObject({ code: 'reference_not_found' });
    expect(createdThreads()).toHaveLength(before);
  } finally {
    navigation.dispose();
    fileDocuments.clear();
    navigationRoot = undefined;
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
