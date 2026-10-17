import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Window } from 'happy-dom';
import { MockLanguageModelV4 } from 'ai/test';
import type {
  ModelProvider,
  AccountStatus,
  ProviderSession,
} from '../../src/extension/bridge/providers/types';
import { ProviderRegistry } from '../../src/extension/bridge/providers/registry';
import { BridgeRuntime } from '../../src/extension/bridge/runtime/bridgeRuntime';
import { createBridgeApi } from '../../src/extension/bridge/server/api';
import { WebviewBridgeProxy } from '../../src/extension/bridge/transport/webviewProxy';
import { BridgeError } from '../../src/extension/bridge/errors';
import { ReviewContext } from '../../src/extension/bridge/tools/reviewContext';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../src/shared/protocol';
import type { PanelSnapshot } from '../../src/shared/models';
import { createSession, appendTurn, restoreReviewState } from '../src/state/reviewState';
import type { AgentModel, ReasoningEffort } from '../../src/shared/agentModels';
import type { ThreadMessageLike } from '@assistant-ui/react';

type TestModelChunk =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T>
    ? T
    : never;
const finishChunk = (reason: 'stop' | 'tool-calls'): TestModelChunk => ({
  type: 'finish',
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  },
});

// The production App, React hooks, AI SDK, IPC proxy, routes, Runtime and SessionStore
// run unchanged. Only the remote provider/browser/VS Code shell are test fixtures.
class TestHost {
  status: AccountStatus = {
    authenticated: true,
    activeAccountId: 'account-a',
    signInPending: false,
    accounts: [{ id: 'account-a', subject: 'subject-a', signedIn: true }],
  };
  models: AgentModel[] = [
    {
      id: 'model-a',
      name: 'Model A',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'high', description: 'Thorough' },
      ],
      defaultReasoningEffort: 'low',
    },
    { id: 'model-b', name: 'Model B', supportedReasoningEfforts: [] },
  ];
  modelFailure = false;
  modelGate: Promise<AgentModel[]> | undefined;
  modelRequests = 0;
  git: PanelSnapshot['git'] = { available: false, repositories: [] };
  includeTool = false;
  /** Tool calls the model asks for, one per streamed step before it answers. */
  toolRuns = 1;
  /** Tool-call ids stay unique across the runs of one host. */
  toolCallSeq = 0;
  reviewContext?: ReviewContext;
  reviewPlan?: (step: number, prompt: string) => TestModelChunk[];
  responseText?: string;
  deleteFailures = 0;
  copiedTexts: string[] = [];
  openedCode: { code: string; language: string }[] = [];
  openedFiles: string[] = [];
  openedReferences: { sessionId: string; referenceId: string }[] = [];
  referenceError?: string;
  savedState: unknown;
  savedWrites = 0;
  holdStream = false;
  streamOutput?: ReadableStreamDefaultController<TestModelChunk>;
  streamId = '';
  creations: ProviderSession[] = [];
  runs: { model: string; text: string; reasoningEffort?: ReasoningEffort }[] = [];
  deletes: string[] = [];
  operations = new Set<Promise<void>>();
  runtime: BridgeRuntime;
  proxy: WebviewBridgeProxy;
  constructor() {
    const provider: ModelProvider = {
      info: {
        id: 'openai-agents',
        name: 'Test provider',
        capabilities: {
          streaming: true,
          functionTools: true,
          sessions: true,
          cancellation: true,
        },
      },
      initialize: async () => {},
      authStatus: async () => ({ ...this.status }),
      login: async () => {
        this.status.signInPending = true;
        delete this.status.signInError;
        return 'https://auth.openai.com/fixture';
      },
      callback: async () => {},
      logout: async () => {
        this.status.authenticated = false;
        delete this.status.activeAccountId;
        return { remoteRevocationConfirmed: true };
      },
      listModels: async () => {
        this.modelRequests++;
        if (this.modelFailure)
          throw new BridgeError('models_unavailable', 'Model catalog unavailable', 502);
        if (this.modelGate) return this.modelGate;
        return this.models;
      },
      createSession: async (model) => {
        if (!this.status.authenticated)
          throw new BridgeError('sign_in_required', 'Sign in first', 401);
        const selected = this.models.find((item) => item.id === model)!;
        const session = {
          model,
          accountId: this.status.activeAccountId!,
          supportedReasoningEfforts: selected.supportedReasoningEfforts,
          ...(selected.defaultReasoningEffort !== undefined
            ? { defaultReasoningEffort: selected.defaultReasoningEffort }
            : {}),
        };
        this.creations.push(session);
        return session;
      },
      resolveModel: async (session, signal, reasoningEffort) => {
        signal.throwIfAborted();
        let step = 0;
        const model = new MockLanguageModelV4({
          modelId: session.model,
          doStream: async ({ prompt }) => {
            step++;
            const text = prompt
              .filter((message) => message.role === 'user')
              .at(-1)!
              .content.filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('');
            if (step === 1)
              this.runs.push({
                model: session.model,
                text,
                ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
              });
            const id = randomUUID();
            const chunks: TestModelChunk[] = [];
            if (this.reviewPlan) {
              chunks.push(...this.reviewPlan(step, JSON.stringify(prompt)));
            } else if (this.includeTool && step <= this.toolRuns) {
              this.toolCallSeq += 1;
              chunks.push(
                {
                  type: 'tool-call',
                  // Unique per call, and later steps carry a distinguishable
                  // input, so a timeline of two steps can be told apart from one
                  // rendered twice.
                  toolCallId: `search-call-${this.toolCallSeq}`,
                  toolName: 'search_code',
                  input: JSON.stringify({ query: step === 1 ? text : `${text} (${step})` }),
                },
                finishChunk('tool-calls'),
              );
            } else {
              chunks.push(
                { type: 'text-start', id },
                {
                  type: 'text-delta',
                  id,
                  delta: this.responseText ?? `answer:${session.model}:${this.runs.length}`,
                },
                { type: 'text-end', id },
              );
              if (this.includeTool)
                chunks.push(
                  { type: 'text-start', id: `${id}-second` },
                  { type: 'text-delta', id: `${id}-second`, delta: 'Additional explanation.' },
                  { type: 'text-end', id: `${id}-second` },
                );
              chunks.push(finishChunk('stop'));
            }
            return {
              stream: new ReadableStream<TestModelChunk>({
                start: (output) => {
                  if (this.holdStream) {
                    this.streamOutput = output;
                    this.streamId = id;
                    chunks.slice(0, 2).forEach((chunk) => output.enqueue(chunk));
                    return;
                  }
                  chunks.forEach((chunk) => output.enqueue(chunk));
                  output.close();
                },
              }),
            };
          },
        });
        return { model };
      },
      dispose: async () => {},
    };
    const registry = new ProviderRegistry();
    registry.register(() => provider);
    this.runtime = new BridgeRuntime(registry, {}, () => {
      if (this.reviewContext) return this.reviewContext;
      const context = new ReviewContext({
        getState: async () => ({
          trusted: true,
          workspaceFolders: [],
          repositories: [],
          activeFile: null,
          dirtyDocuments: [],
        }),
        findFiles: async () => [],
        getDiagnostics: () => [],
      });
      context.searchCode = async ({ query }) => ({
        repository: '/fixture',
        matches: [{ path: 'file.ts', line: 1, column: 1, text: query, context: [] }],
        truncated: false,
        skippedFiles: 0,
      });
      return context;
    });
    const api = createBridgeApi({
      runtime: this.runtime,
      callbackUri: () => 'http://127.0.0.1:1234/auth/callback',
      openBrowser: async () => {},
    });
    this.proxy = new WebviewBridgeProxy(
      async (path, method, body, signal) => {
        if (method === 'DELETE') {
          this.deletes.push(path.split('/').at(-1)!);
          if (this.deleteFailures > 0) {
            this.deleteFailures--;
            return Response.json(
              { error: { code: 'temporary_failure', message: 'Retry deletion' } },
              { status: 503 },
            );
          }
        }
        return api(
          new Request(`http://127.0.0.1${path}`, {
            method,
            headers: { 'content-type': 'application/json' },
            signal,
            ...(body !== undefined ? { body } : {}),
          }),
        );
      },
      async (message) => this.post(message),
    );
  }
  post(message: ExtensionToWebviewMessage): void {
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: message })));
  }
  receive(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case 'bridge/request': {
        const operation = this.proxy.send(message);
        this.operations.add(operation);
        void operation.finally(() => this.operations.delete(operation));
        break;
      }
      case 'bridge/ack':
        this.proxy.ack(message.requestId);
        break;
      case 'bridge/cancel':
        this.proxy.cancel(message.requestId);
        break;
      case 'clipboard/write':
        this.copiedTexts.push(message.text);
        this.post({ type: 'host/action', requestId: message.requestId });
        break;
      case 'code/open':
        this.openedCode.push({ code: message.code, language: message.language });
        this.post({ type: 'host/action', requestId: message.requestId });
        break;
      case 'file/open':
        this.openedFiles.push(message.uri);
        this.post({ type: 'host/action', requestId: message.requestId });
        break;
      case 'reference/open':
        this.openedReferences.push({
          sessionId: message.sessionId,
          referenceId: message.referenceId,
        });
        this.post(
          this.referenceError
            ? { type: 'host/error', requestId: message.requestId, message: this.referenceError }
            : { type: 'host/action', requestId: message.requestId },
        );
        break;
      case 'webview/ready':
        this.post({
          type: 'host/snapshot',
          snapshot: {
            workspace: { name: 'Fixture', folders: [], trusted: true },
            settings: { greeting: '', showWorkspacePaths: true },
            state: { messageCount: 0 },
            git: this.git,
          },
        });
        break;
      default:
        break;
    }
  }
  async settle(): Promise<void> {
    do {
      await Promise.all(this.operations);
      // Allow the client to process the completed response and issue the next
      // request (session creation -> chat), before flushing React's updates.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } while (this.operations.size);
  }
  async close(): Promise<void> {
    this.proxy.dispose();
    await this.runtime.dispose();
  }
}

let host: TestHost;
let dom: Window;
let render: (typeof import('@testing-library/react'))['render'];
let fireEvent: (typeof import('@testing-library/react'))['fireEvent'];
let cleanup: (typeof import('@testing-library/react'))['cleanup'];
let waitFor: (typeof import('@testing-library/react'))['waitFor'];
let within: (typeof import('@testing-library/react'))['within'];
let act: (typeof import('react'))['act'];
let createElement: (typeof import('react'))['createElement'];
let StrictMode: (typeof import('react'))['StrictMode'];
let App: (typeof import('../src/App'))['App'];
const globals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, value: unknown) {
  globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeAll(async () => {
  dom = new Window({ url: 'https://webview.test' });
  install('window', dom);
  install('document', dom.document);
  for (const name of [
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLButtonElement',
    'HTMLFormElement',
    'HTMLSelectElement',
    'SVGElement',
    'Element',
    'Node',
    'NodeFilter',
    'Text',
    'Document',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'IntersectionObserver',
    'Event',
    'CustomEvent',
    'MouseEvent',
    'KeyboardEvent',
    'MessageEvent',
  ]) {
    install(name, Reflect.get(dom, name));
  }
  install('getComputedStyle', dom.getComputedStyle.bind(dom));
  install('requestAnimationFrame', dom.requestAnimationFrame.bind(dom));
  install('cancelAnimationFrame', dom.cancelAnimationFrame.bind(dom));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('acquireVsCodeApi', () => ({
    postMessage: (message: WebviewToExtensionMessage) => host.receive(message),
    getState: () => host.savedState,
    setState: (state: unknown) => {
      host.savedWrites++;
      host.savedState = state;
    },
  }));
  ({ render, fireEvent, cleanup, waitFor, within } = await import('@testing-library/react/pure'));
  ({ act, createElement, StrictMode } = await import('react'));
  ({ App } = await import('../src/App'));
});
beforeEach(() => {
  host = new TestHost();
});
afterEach(async () => {
  cleanup();
  await host.close();
  await dom.happyDOM.abort();
});
afterAll(async () => {
  await dom.happyDOM.close();
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const mount = () => render(createElement(StrictMode, null, createElement(App)));
type View = ReturnType<typeof mount>;
function openSettingsMenu(view: View) {
  fireEvent.click(view.getByRole('button', { name: '设置菜单' }));
}

test('Webview transport resets inactivity on each response chunk', async () => {
  const { createBridgeFetch } = await import('../src/services/bridgeFetch');
  const sent: WebviewToExtensionMessage[] = [];
  let requestId = '';
  host.receive = (message) => {
    sent.push(message);
    if (message.type === 'bridge/request') {
      requestId = message.requestId;
      host.post({
        type: 'host/bridge-head',
        requestId,
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
  };
  const response = await createBridgeFetch(120)('/v1/providers');
  const consume = response.text();
  for (let chunk = 0; chunk < 5; chunk++) {
    await Bun.sleep(40);
    host.post({ type: 'host/bridge-chunk', requestId, text: 'progress' });
  }
  host.post({ type: 'host/bridge-end', requestId });
  expect(await consume).toBe('progress'.repeat(5));
  expect(sent.filter((message) => message.type === 'bridge/ack')).toHaveLength(5);
  expect(sent.some((message) => message.type === 'bridge/cancel')).toBe(false);
});

test('Webview transport cancels an unanswered request despite unrelated IPC activity', async () => {
  const { createBridgeFetch } = await import('../src/services/bridgeFetch');
  const sent: WebviewToExtensionMessage[] = [];
  host.receive = (message) => {
    sent.push(message);
  };
  const pending = expect(createBridgeFetch(90)('/v1/providers')).rejects.toThrow(
    'inactivity timeout',
  );
  for (let chunk = 0; chunk < 4; chunk++) {
    await Bun.sleep(30);
    host.post({ type: 'host/bridge-chunk', requestId: 'unrelated-request', text: 'activity' });
  }
  await pending;
  expect(sent.filter((message) => message.type === 'bridge/cancel')).toHaveLength(1);
});

async function connected(view: View) {
  await waitFor(() =>
    expect(
      (view.getByRole('combobox', { name: '选择 AI 模型' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}

test('actions sit beside the tabs, with the mark leading the greeting and accounts in settings', async () => {
  const view = mount();
  await connected(view);

  expect(view.queryByRole('heading', { name: 'Meerkat' })).toBeNull();
  expect(view.getByRole('button', { name: '刷新工作区' })).toBeDefined();
  const tablist = view.getByRole('tablist');
  expect(tablist.contains(view.getByRole('button', { name: '设置菜单' }))).toBe(false);
  const greeting = view.container.querySelector('[data-slot="thread-welcome-greeting"]')!;
  expect(greeting.firstElementChild?.tagName.toLowerCase()).toBe('svg');
  expect(greeting.lastElementChild?.textContent).toContain('How can I help you today?');
  expect(view.queryByRole('button', { name: '登出' })).toBeNull();

  openSettingsMenu(view);
  expect(view.getByRole('button', { name: '登出' })).toBeDefined();
  expect(view.getByRole('button', { name: '添加账户' })).toBeDefined();
  expect(view.getByRole('button', { name: '扩展设置…' })).toBeDefined();
});

test('settings menu keeps the account picker available while logged out', async () => {
  host.status = {
    authenticated: false,
    accounts: [
      { id: 'account-a', email: 'a@example.com', subject: 'subject-a', signedIn: false },
      { id: 'account-b', email: 'b@example.com', subject: 'subject-b', signedIn: false },
    ],
  };
  const view = mount();
  openSettingsMenu(view);
  const picker = (await view.findByRole('combobox', {
    name: '切换 ChatGPT 账户',
  })) as HTMLSelectElement;
  expect(picker.options).toHaveLength(3);

  fireEvent.change(picker, { target: { value: 'account-b' } });
  await waitFor(() => expect(host.status.signInPending).toBe(true));
  expect(
    (view.getByRole('button', { name: '等待浏览器授权…' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

async function chooseModel(view: View, name: string) {
  fireEvent.click(view.getByRole('combobox', { name: '选择 AI 模型' }));
  fireEvent.click(await view.findByRole('option', { name }));
}
async function chooseMode(view: View, name: '普通聊天' | '代码审查') {
  fireEvent.click(view.getByRole('combobox', { name: '交互模式' }));
  fireEvent.click(await view.findByRole('option', { name: new RegExp(name) }));
}

test('Thread composer uses the selector Element for modes with keyboard navigation and independent model selection', async () => {
  const view = mount();
  await connected(view);
  await chooseModel(view, 'Model B');
  await act(async () => host.settle());
  const trigger = view.getByRole('combobox', { name: '交互模式' });
  expect(trigger.tagName).toBe('BUTTON');
  expect(trigger.getAttribute('data-slot')).toBe('model-selector-trigger');
  expect(trigger.closest('[data-slot="aui_composer-shell"]')).not.toBeNull();
  expect(trigger.textContent).toContain('普通聊天');
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
    target: { value: 'Keep this draft while switching modes' },
  });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const list = await view.findByRole('listbox', { name: '交互模式' });
  expect(within(list).getAllByRole('option')).toHaveLength(2);
  const input = list.closest('[cmdk-root]')!.querySelector('input')!;
  expect(input.getAttribute('aria-label')).toBe('交互模式');
  fireEvent.keyDown(input, { key: 'End' });
  await waitFor(() =>
    expect(list.querySelector('[data-selected="true"]')?.textContent).toContain('代码审查'),
  );
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() =>
    expect(view.getByRole('combobox', { name: '交互模式' }).textContent).toContain('代码审查'),
  );
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    'Keep this draft while switching modes',
  );
  expect(view.getByRole('combobox', { name: '选择 AI 模型' }).textContent).toContain('Model B');
  expect(host.runs).toHaveLength(0);
  await chooseMode(view, '普通聊天');
  await send(view, 'chat with the selected model');
  await answered(view, 1);
  expect(host.runs[0]!.model).toBe('model-b');
});

for (const outcome of ['available', 'empty', 'failure'] as const) {
  test(`initial model catalog ${outcome} waits before validating a restored session`, async () => {
    const bound = host.runtime.sessions.create('openai-agents', {
      model: 'model-b',
      accountId: 'account-a',
    });
    const local = {
      ...createSession(),
      bridgeSessionId: bound.id,
      model: 'model-b',
      accountId: 'account-a',
    };
    host.savedState = restoreReviewState({ sessions: [local], activeSessionId: local.id });
    let resolve!: (catalog: AgentModel[]) => void;
    let reject!: (error: Error) => void;
    host.modelGate = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const view = mount();
    await waitFor(() => expect(host.modelRequests).toBeGreaterThan(0));
    const selector = view.getByRole('combobox', { name: '选择 AI 模型' }) as HTMLButtonElement;
    expect(view.getByText('正在加载模型…')).toBeDefined();
    expect(view.queryByRole('alert')).toBeNull();
    expect(selector.textContent).not.toContain('不可用');
    expect(selector.disabled).toBe(true);
    const input = view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'draft while loading' } });
    expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(input.value).toBe('draft while loading');
    expect(host.runs).toHaveLength(0);
    expect(host.creations).toHaveLength(0);

    await act(async () => {
      if (outcome === 'failure')
        reject(new BridgeError('models_unavailable', 'Model catalog unavailable', 502));
      else resolve(outcome === 'empty' ? [] : host.models);
      await host.settle();
    });
    expect(view.queryByText('正在加载模型…')).toBeNull();
    if (outcome === 'available') {
      expect(view.queryByRole('alert')).toBeNull();
      expect(selector.textContent).toContain('Model B');
      await send(view, 'follow-up after loading');
      await answered(view, 1);
      expect(host.runs[0]!.model).toBe('model-b');
    } else if (outcome === 'empty') {
      // The selector carries the binding warning proactively; the failed send
      // reports itself in the message it belongs to.
      expect(selector.textContent).toContain('当前账户不可用');
      expect(view.queryByRole('alert')).toBeNull();
      await send(view, 'blocked by the empty catalog');
      await waitFor(() =>
        expect(view.getByRole('alert').textContent).toContain('请先 Continue with ChatGPT'),
      );
      expect(host.runs).toHaveLength(0);
    } else {
      expect(view.getByRole('alert').textContent).toContain('Model catalog unavailable');
      expect(selector.textContent).not.toContain('不可用');
      expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      host.modelGate = undefined;
      fireEvent.click(view.getByRole('button', { name: '重新加载模型' }));
      await connected(view);
      expect(view.queryByRole('alert')).toBeNull();
      expect(input.value).toBe('draft while loading');
      await send(view, 'retry after catalog failure');
      await answered(view, 1);
    }
  });
}

test('a late model catalog cannot restore readiness after logout', async () => {
  let resolve!: (catalog: AgentModel[]) => void;
  host.modelGate = new Promise((done) => {
    resolve = done;
  });
  const view = mount();
  await waitFor(() => expect(host.modelRequests).toBeGreaterThan(0));
  openSettingsMenu(view);
  fireEvent.click(view.getByRole('button', { name: '登出' }));
  await waitFor(() =>
    expect(view.getByRole('button', { name: 'Continue with ChatGPT' })).toBeDefined(),
  );
  await act(async () => {
    resolve(host.models);
    await host.settle();
  });
  expect((view.getByRole('combobox', { name: '选择 AI 模型' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
    target: { value: 'keep draft' },
  });
  expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.queryByRole('alert')).toBeNull();
});

test('Thinking uses returned efforts and defaults, persists per session, and reaches each turn', async () => {
  const view = mount();
  await connected(view);
  await send(view, 'first effort');
  await answered(view, 1);
  expect(host.runs[0]!.reasoningEffort).toBe('low');
  const original = restoreReviewState(host.savedState).activeSessionId;
  fireEvent.click(view.getByRole('combobox', { name: '选择 AI 模型' }));
  expect(view.getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Low', 'High']);
  expect(view.getByRole('radiogroup', { name: 'Thinking' })).toBeDefined();
  fireEvent.click(view.getByRole('radio', { name: 'High' }));
  fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
  expect(restoreReviewState(host.savedState).activeSessionId).toBe(original);
  await send(view, 'deeper follow-up');
  await answered(view, 2);
  expect(host.runs[1]!.reasoningEffort).toBe('high');
  expect(host.creations).toHaveLength(1);
  await act(async () => cleanup());
  const restored = mount();
  await connected(restored);
  expect(restored.getByRole('combobox', { name: '选择 AI 模型' }).textContent).toContain('High');
  await chooseModel(restored, 'Model B');
  fireEvent.click(restored.getByRole('combobox', { name: '选择 AI 模型' }));
  expect(restored.queryByRole('radiogroup', { name: 'Thinking' })).toBeNull();
  fireEvent.keyDown(restored.getByRole('dialog'), { key: 'Escape' });
  await send(restored, 'without effort');
  await answered(restored, 3);
  expect(host.runs[2]!.reasoningEffort).toBeUndefined();
  expect(host.creations).toHaveLength(2);
  expect(
    restoreReviewState(host.savedState).sessions.find(({ id }) => id === original)!.reasoningEffort,
  ).toBe('high');
});
async function send(view: View, text: string) {
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), { target: { value: text } });
  await waitFor(() =>
    expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: '发送消息' }));
    await host.settle();
  });
}
async function answered(view: View, count: number) {
  await waitFor(() => expect(host.runs.length).toBe(count));
  await waitFor(() =>
    expect(view.getByText(`answer:${host.runs[count - 1]!.model}:${count}`)).toBeDefined(),
  );
  await waitFor(() =>
    expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  );
  await waitFor(() => expect(host.runtime.sessions.list().length).toBeLessThanOrEqual(20));
}

const reviewToolCall = (step: number, toolName: string, input: unknown): TestModelChunk[] => [
  { type: 'tool-call', toolCallId: `review-call-${step}`, toolName, input: JSON.stringify(input) },
  finishChunk('tool-calls'),
];

function incrementalReviewContext(path = 'file.ts'): ReviewContext {
  const reviewId = randomUUID();
  const reference = {
    referenceId: `ref_${'b'.repeat(64)}`,
    reviewId,
    repository: '/fixture',
    path,
    version: 'new' as const,
    scope: 'range' as const,
    startLine: 2,
    endLine: 2,
    label: `${path}:2`,
    markdown: `[${path.replace(/[[\]]/g, '\\$&')}:2](review-file:ref_${'b'.repeat(64)})`,
  };
  const context = new ReviewContext({
    getState: async () => ({
      trusted: true,
      workspaceFolders: [],
      repositories: [],
      activeFile: null,
      dirtyDocuments: [],
    }),
    findFiles: async () => [],
    getDiagnostics: () => [],
  });
  const change = {
    path,
    oldPath: path,
    newPath: path,
    status: 'modified' as const,
  };
  context.listChanges = async ({ scope }) => ({
    reviewId,
    scope,
    repository: '/fixture',
    head: 'head',
    base: 'base',
    changes: [change],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 900000).toISOString(),
  });
  context.getDiff = async () => ({
    reviewId,
    files: [
      {
        ...change,
        binary: false,
        patch: '@@ -2 +2 @@\n-old\n+unchecked\n',
        patchOffset: 0,
        patchComplete: true,
        patchEnd: true,
        hunks: [],
      },
    ],
    truncated: false,
    nextCursor: null,
  });
  context.citeFiles = async () => ({ references: [reference] });
  context.getFileReference = async (id) => {
    if (id !== reference.referenceId)
      throw new BridgeError('reference_not_found', 'Unknown reference');
    return reference;
  };
  return context;
}
for (const outcome of ['completed', 'incomplete', 'cancelled', 'failed'] as const) {
  test(`incremental Tool UI saves one card while running, then restores ${outcome} receipts`, async () => {
    const path = 'app/[locale]/projects/[slug]/page.tsx';
    host.reviewContext = incrementalReviewContext(path);
    let calls = 0;
    host.reviewPlan = (step, prompt) => {
      calls++;
      const reviewId = /"reviewId":"([\w-]+)"/.exec(prompt)?.[1] ?? '';
      const referenceId = /ref_[a-f0-9]{64}/.exec(prompt)?.[0] ?? '';
      if (step === 1) return reviewToolCall(step, 'list_changes', { scope: 'all' });
      if (step === 2) return reviewToolCall(step, 'get_diff', { reviewId, paths: [path] });
      if (step === 3)
        return reviewToolCall(step, 'cite_files', {
          reviewId,
          references: [{ path, version: 'new', startLine: 2, endLine: 2 }],
        });
      if (step === 4 || step === 5)
        return reviewToolCall(step, 'submit_review', {
          reviewId,
          title: 'Unchecked value',
          priority: 'P1',
          description: `In [${path.replace(/[[\]]/g, '\\$&')}:2](review-file:${referenceId}), the inserted \`value\` reaches the caller without validation.`,
          referenceIds: [referenceId],
        });
      if (step === 6) {
        host.holdStream = true;
        return [
          { type: 'reasoning-start', id: 'waiting' },
          { type: 'reasoning-delta', id: 'waiting', delta: 'Continuing review' },
        ];
      }
      throw new Error('No model summary request is allowed');
    };
    const view = mount();
    await connected(view);
    await chooseMode(view, '代码审查');
    fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
      target: { value: 'Review changes incrementally' },
    });
    await waitFor(() =>
      expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(view.getByRole('button', { name: '发送消息' }));
    await waitFor(() => expect(calls).toBe(6));
    await waitFor(() =>
      expect((view.getByRole('combobox', { name: '交互模式' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(view.getByRole('article', { name: 'P1 Unchecked value' })).toBeDefined(),
    );
    expect(view.container.querySelectorAll('[data-review-finding]')).toHaveLength(1);
    expect(view.getByRole('article').closest('[data-slot="tool-timeline"]')).toBeNull();
    await waitFor(() =>
      expect(restoreReviewState(host.savedState).sessions[0]!.reviews?.findings).toHaveLength(1),
    );
    expect(view.queryByText('审查已完成，已收录 1 条问题。')).toBeNull();
    const article = view.getByRole('article');
    const link = within(article).getByRole('link', { name: `${path}:2` });
    expect(link.getAttribute('href')).toBe(`review-file:ref_${'b'.repeat(64)}`);
    expect(article.querySelector('p > code')?.textContent).toBe('value');
    expect(article.textContent).not.toContain('(review-file:');
    fireEvent.click(link);
    fireEvent.click(view.getByRole('button', { name: `${path}:2` }));
    await waitFor(() => expect(host.openedReferences).toHaveLength(2));
    expect(host.openedReferences.map(({ referenceId }) => referenceId)).toEqual([
      `ref_${'b'.repeat(64)}`,
      `ref_${'b'.repeat(64)}`,
    ]);
    if (outcome === 'completed' || outcome === 'incomplete') {
      await act(async () => {
        host.holdStream = false;
        host.streamOutput!.enqueue({ type: 'reasoning-end', id: 'waiting' });
        for (const chunk of reviewToolCall(6, 'finish_review', {
          status: outcome,
          unfinishedItems: outcome === 'incomplete' ? ['Remaining review work'] : [],
          limitations: ['Static review only; tests were not run.'],
        }))
          host.streamOutput!.enqueue(chunk);
        host.streamOutput!.close();
        await host.settle();
      });
    } else if (outcome === 'failed') {
      await act(async () => {
        host.holdStream = false;
        host.streamOutput!.error(new Error('Provider failed after saving the finding'));
        await host.settle();
      });
    } else {
      fireEvent.click(view.getByRole('button', { name: '取消运行' }));
    }
    const summary = `审查${{ completed: '已完成', incomplete: '未完成', cancelled: '已取消', failed: '失败' }[outcome]}，已收录 1 条问题。`;
    await waitFor(() => expect(view.getByText(summary)).toBeDefined());
    await waitFor(() =>
      expect((view.getByRole('combobox', { name: '交互模式' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(view.container.querySelector('[data-review-status]')?.textContent).toBe(summary);
    expect(view.queryByText('审查限制')).toBeNull();
    expect(view.queryByText('Static review only; tests were not run.')).toBeNull();
    expect(view.queryByText('Remaining review work')).toBeNull();
    expect(calls).toBe(6);
    view.unmount();
    // Simulate a refresh between the Host commit and local receipt persistence.
    const saved = restoreReviewState(host.savedState);
    delete saved.sessions[0]!.reviews;
    host.savedState = saved;
    const restored = mount();
    await connected(restored);
    await waitFor(() => expect(restored.getByText(summary)).toBeDefined());
    expect(restored.container.querySelectorAll('[data-review-finding]')).toHaveLength(1);
    expect(restored.getByRole('article', { name: 'P1 Unchecked value' })).toBeDefined();
    expect(restored.container.querySelector('[data-review-status]')?.textContent).toBe(summary);
    fireEvent.click(restored.getByRole('link', { name: `${path}:2` }));
    await waitFor(() => expect(host.openedReferences).toHaveLength(3));
    expect(calls).toBe(6);
  });
}

test('finding Markdown keeps unverified references, HTML and unsafe URLs inert', async () => {
  const { ReviewFindingCard } = await import('../src/components/AgentChat');
  const context = incrementalReviewContext();
  const { references } = await context.citeFiles({ reviewId: randomUUID(), references: [] });
  const opened: string[] = [];
  const view = render(
    createElement(ReviewFindingCard, {
      finding: {
        id: 'a'.repeat(64),
        runId: randomUUID(),
        toolCallId: 'saved-finding',
        title: 'Verified issue',
        priority: 'P2',
        description: [
          references[0]!.markdown,
          `[unverified](review-file:ref_${'c'.repeat(64)})`,
          '[unregistered file](review-file:file%3A%2F%2F%2Ffixture%2Ffile.ts)',
          '[unsafe](javascript:alert%281%29)',
          '[external](https://example.com/docs)',
          '![image](https://example.com/image.png)',
          '',
          '<img src="https://example.com/raw.png" />',
          '<script>alert(1)</script>',
        ].join('\n'),
        references,
        savedAt: new Date().toISOString(),
      },
      openReference: async (id) => {
        opened.push(id);
      },
    }),
  );
  expect(view.queryByRole('link', { name: 'unverified' })).toBeNull();
  expect(view.queryByRole('link', { name: 'unregistered file' })).toBeNull();
  expect(view.getByText('unsafe').getAttribute('href')).toBe('');
  expect(view.getByRole('link', { name: 'external' }).getAttribute('href')).toBe(
    'https://example.com/docs',
  );
  expect(view.getByText('image')).toBeDefined();
  expect(view.container.querySelector('img, script')).toBeNull();
  fireEvent.click(view.getByRole('link', { name: 'file.ts:2' }));
  expect(opened).toEqual([references[0]!.referenceId]);
});

test('assistant-ui Thread keeps Bridge tool output and copies the full assistant response through Host', async () => {
  host.includeTool = true;
  const view = mount();
  await connected(view);
  await send(view, 'TODO: inspect this change');
  await answered(view, 1);
  const user = view.container.querySelector('[data-slot="aui_user-message-root"]');
  const assistant = view.container.querySelector('[data-slot="aui_assistant-message-root"]');
  expect(user?.textContent).toContain('TODO: inspect this change');
  expect(assistant?.textContent).toContain('Additional explanation.');
  // The tool timeline replaced the tool group and tool fallback: the run is one
  // step, and the step's chip carries what the Bridge's tool answered.
  const timeline = assistant?.querySelector('[data-slot="tool-timeline"]');
  expect(timeline?.textContent).toContain('Ran 1 step');
  fireEvent.click(view.getByRole('button', { name: 'Ran 1 step' }));
  expect(timeline?.textContent).toContain('Searched');
  expect(timeline?.textContent).toContain('1 match');
  expect(assistant?.querySelector('[data-slot="tool-fallback-root"]')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: '查看 search_code 调用详情' }));
  expect(assistant?.querySelector('[data-slot="tool-fallback-result"]')?.textContent).toContain(
    'matches',
  );
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: '复制回复' }));
    await host.settle();
  });
  expect(host.copiedTexts).toEqual(['answer:model-a:1\nAdditional explanation.']);
  expect(view.getByRole('button', { name: '已复制回复' })).toBeDefined();
  expect(view.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Refresh' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Add Attachment' })).toBeNull();
});

test('consecutive tool calls read as one timeline with a step each', async () => {
  host.includeTool = true;
  host.toolRuns = 2;
  const view = mount();
  await connected(view);
  await send(view, 'TODO: inspect this change');
  await answered(view, 1);
  const assistant = view.container.querySelector('[data-slot="aui_assistant-message-root"]');
  const timeline = assistant?.querySelector('[data-slot="tool-timeline"]');
  expect(timeline?.textContent).toContain('Ran 2 steps');
  fireEvent.click(view.getByRole('button', { name: 'Ran 2 steps' }));
  // Both calls are steps of the one run, each carrying its own result.
  expect(timeline?.textContent).toContain('“TODO: inspect this change” · 1 match');
  expect(timeline?.textContent).toContain('“TODO: inspect this change (2)” · 1 match');
});

test('each assistant message summarizes only its own tool calls', async () => {
  host.includeTool = true;
  const view = mount();
  await connected(view);
  await send(view, 'first inspection');
  await answered(view, 1);
  await send(view, 'second inspection');
  await answered(view, 2);
  const assistants = view.container.querySelectorAll('[data-slot="aui_assistant-message-root"]');
  expect(assistants).toHaveLength(2);
  for (const trigger of view.getAllByRole('button', { name: 'Ran 1 step' })) {
    fireEvent.click(trigger);
  }
  const timelines = [...assistants].map((assistant) =>
    assistant.querySelector('[data-slot="tool-timeline"]'),
  );
  expect(timelines).toHaveLength(2);
  // A timeline reads the parts of the message it sits in, not the latest ones.
  expect(timelines[0]?.textContent).toContain('first inspection');
  expect(timelines[0]?.textContent).not.toContain('second inspection');
  expect(timelines[1]?.textContent).toContain('second inspection');
});

// Exercise runtime grouping with statuses that the synchronous Bridge fixture
// cannot hold open, including tools that render their own interactive surface.
async function mountTimeline(message: ThreadMessageLike, customTool = false) {
  const { AssistantRuntimeProvider, useExternalStoreRuntime, useAssistantToolUI } =
    await import('@assistant-ui/react');
  const { Thread } = await import('../src/components/assistant-ui/elements/thread.aui');
  const { TooltipProvider } = await import('../src/components/ui/tooltip');
  const approvals: unknown[] = [];
  const CustomTool = () => createElement('div', { 'data-testid': 'custom-tool' }, 'Custom tool UI');
  function ToolRegistration() {
    useAssistantToolUI(customTool ? { toolName: 'custom', render: CustomTool } : null);
    return null;
  }
  function Fixture({ message: current }: { message: ThreadMessageLike }) {
    const runtime = useExternalStoreRuntime({
      messages: [current],
      convertMessage: (value) => value,
      isRunning: current.status?.type === 'running',
      onNew: async () => {},
      onRespondToToolApproval: async (response) => {
        approvals.push(response);
      },
    });
    return createElement(
      AssistantRuntimeProvider,
      { runtime },
      createElement(
        TooltipProvider,
        null,
        createElement(ToolRegistration),
        createElement(Thread, { autoFocus: false }),
      ),
    );
  }
  const view = render(createElement(Fixture, { message }));
  return {
    ...view,
    approvals,
    update: (next: ThreadMessageLike) => view.rerender(createElement(Fixture, { message: next })),
  };
}

const completedSearch = (id: string) => ({
  type: 'tool-call' as const,
  toolCallId: id,
  toolName: 'search_code',
  args: { query: id },
  result: { matches: [], truncated: false },
});

test('timeline keeps its expanded state as a running call completes or fails', async () => {
  const message: ThreadMessageLike = {
    id: 'timeline',
    role: 'assistant',
    status: { type: 'running' },
    content: [
      completedSearch('first'),
      {
        type: 'tool-call',
        toolCallId: 'search',
        toolName: 'search_code',
        args: { query: 'timeline' },
      },
    ],
  };
  const view = await mountTimeline(message);
  fireEvent.click(view.getByRole('button', { name: 'Working…' }));
  expect(
    view.container.querySelector('[data-slot="tool-timeline"]')?.getAttribute('aria-busy'),
  ).toBe('true');
  const rows = view.container.querySelectorAll('[data-slot="tool-timeline-step"]');
  expect([...rows].map((row) => row.getAttribute('data-status'))).toEqual(['complete', 'running']);
  expect(rows[1]?.textContent).toContain('Searching');
  expect(rows[1]?.textContent).not.toContain('0 matches');
  await act(async () =>
    view.update({
      ...message,
      status: { type: 'complete', reason: 'stop' },
      content: [
        completedSearch('first'),
        {
          type: 'tool-call',
          toolCallId: 'search',
          toolName: 'search_code',
          args: { query: 'timeline' },
          result: { error: { message: 'Search unavailable' } },
        },
      ],
    }),
  );
  expect(
    view.getByRole('button', { name: 'Ran 2 steps · 1 failed' }).getAttribute('aria-expanded'),
  ).toBe('true');
  expect(view.container.querySelector('[data-status="failed"]')?.textContent).toContain(
    'Search unavailable',
  );
  expect(
    view.container.querySelector('[data-slot="tool-timeline"]')?.getAttribute('aria-busy'),
  ).toBe('false');
});

test('approval controls and registered tool UIs split adjacent timeline groups', async () => {
  const view = await mountTimeline(
    {
      id: 'timeline',
      role: 'assistant',
      status: { type: 'requires-action', reason: 'tool-calls' },
      content: [
        completedSearch('first'),
        {
          type: 'tool-call',
          toolCallId: 'approval',
          toolName: 'ask',
          args: {},
          approval: { id: 'approval', prompt: 'Allow inspection?' },
        },
        { type: 'tool-call', toolCallId: 'custom', toolName: 'custom', args: {}, result: 'done' },
        completedSearch('last'),
      ],
    },
    true,
  );
  await waitFor(() => expect(view.getByTestId('custom-tool').textContent).toBe('Custom tool UI'));
  expect(view.container.querySelectorAll('[data-slot="tool-timeline"]')).toHaveLength(2);
  expect(view.getByRole('button', { name: 'Allow' })).toBeDefined();
  expect(view.getByRole('button', { name: 'Deny' })).toBeDefined();
  expect(view.getByTestId('custom-tool').closest('[data-slot="tool-timeline"]')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Allow' }));
  await waitFor(() =>
    expect(view.approvals).toEqual([expect.objectContaining({ approved: true })]),
  );
});

test('cancelled tool calls remain visible with a cancelled summary', async () => {
  const view = await mountTimeline({
    id: 'timeline',
    role: 'assistant',
    status: { type: 'incomplete', reason: 'cancelled' },
    content: [
      {
        type: 'tool-call',
        toolCallId: 'search',
        toolName: 'search_code',
        args: { query: 'timeline' },
      },
    ],
  });
  fireEvent.click(view.getByRole('button', { name: 'Ran 1 step · 1 cancelled' }));
  expect(
    view.container.querySelector('[data-slot="tool-timeline-step"]')?.getAttribute('data-status'),
  ).toBe('cancelled');
});

test('failed timeline steps expose full errors and expandable raw tool input and output', async () => {
  const path = 'app/[locale]/projects/page.tsx';
  const message = 'File does not exist in the requested snapshot version.';
  const view = await mountTimeline({
    id: 'timeline',
    role: 'assistant',
    status: { type: 'complete', reason: 'stop' },
    content: [
      {
        type: 'tool-call',
        toolCallId: 'read',
        toolName: 'read_file',
        args: { reviewId: 'review', path, version: 'new', startLine: 1, endLine: 100 },
        result: { error: { code: 'file_not_found', message } },
      },
    ],
  });
  fireEvent.click(view.getByRole('button', { name: 'Ran 1 step · 1 failed' }));
  expect(view.container.querySelector('[data-slot="tool-timeline-error"]')?.textContent).toBe(
    `file_not_found: ${message}`,
  );
  expect(view.container.querySelector('[data-slot="tool-timeline-details"]')).toBeNull();
  const details = view.getByRole('button', { name: '查看 read_file 调用详情' });
  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('true');
  expect(view.container.querySelector('[data-slot="tool-fallback-args"]')?.textContent).toContain(
    path,
  );
  expect(view.container.querySelector('[data-slot="tool-fallback-result"]')?.textContent).toContain(
    message,
  );
  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('false');
});

test('Thread composer preserves drafts and modes across tabs, sessions and remounts', async () => {
  const view = mount();
  await connected(view);
  await send(view, 'draft-session');
  await answered(view, 1);
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
    target: { value: '检查这个变更的边界情况' },
  });
  await chooseMode(view, '代码审查');
  const first = restoreReviewState(host.savedState).activeSessionId;
  fireEvent.click(view.getByRole('tab', { name: 'File Change Status' }));
  expect(view.queryByRole('textbox', { name: '询问 Agent' })).toBeNull();
  fireEvent.click(view.getByRole('tab', { name: 'Agent Chat Windows' }));
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    '检查这个变更的边界情况',
  );
  expect(view.getByRole('combobox', { name: '交互模式' }).textContent).toContain('代码审查');
  fireEvent.click(view.getByRole('button', { name: '新建会话' }));
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe('');
  expect(view.getByRole('combobox', { name: '交互模式' }).textContent).toContain('普通聊天');
  fireEvent.click(view.getByRole('tab', { name: 'History' }));
  fireEvent.click(view.getByRole('button', { name: /draft-session/ }));
  expect(restoreReviewState(host.savedState).activeSessionId).toBe(first);
  expect(view.getByRole('combobox', { name: '交互模式' }).textContent).toContain('代码审查');
  await act(async () => cleanup());
  const restored = mount();
  await connected(restored);
  expect((restored.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    '检查这个变更的边界情况',
  );
  expect(restored.getByRole('combobox', { name: '交互模式' }).textContent).toContain('代码审查');
  expect(host.runs).toHaveLength(1);
});

test('Thread composer sends with Enter while Shift+Enter and IME keep the draft', async () => {
  const view = mount();
  await connected(view);
  const input = view.getByRole('textbox', { name: '询问 Agent' });
  fireEvent.change(input, { target: { value: '审查输入边界' } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(host.runs).toHaveLength(0);
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' });
    await host.settle();
  });
  await answered(view, 1);
  expect(host.runs[0]!.text).toBe('审查输入边界');
});

test('Chinese composition keeps each provisional value without React restoring stale text', async () => {
  const view = mount();
  await connected(view);
  const input = view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement;
  // A real IME loses its composition range when React restores an old value.
  // happy-dom has no IME engine, so observe those DOM writes directly.
  const descriptor = Object.getOwnPropertyDescriptor(input, 'value')!;
  const writes: string[] = [];
  Object.defineProperty(input, 'value', {
    ...descriptor,
    set(value: string) {
      writes.push(value);
      descriptor.set!.call(this, value);
    },
  });
  fireEvent.compositionStart(input);
  for (const value of ['n', 'ni', '你', '你h', '你hao', '你好']) {
    writes.length = 0;
    fireEvent.input(input, {
      target: { value },
      inputType: 'insertCompositionText',
      isComposing: true,
      data: value,
    });
    expect(writes).toEqual([]);
    expect(input.value).toBe(value);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(input.value).toBe(value);
  }
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  fireEvent.compositionEnd(input, { data: '你好' });
  expect(host.runs).toHaveLength(0);
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter' });
    await host.settle();
  });
  await answered(view, 1);
  expect(host.runs[0]!.text).toBe('你好');
});

test('compositionend persists the committed Chinese draft even without a final input event', async () => {
  const view = mount();
  await connected(view);
  const input = view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement;
  fireEvent.compositionStart(input);
  fireEvent.input(input, { target: { value: 'nihao' }, isComposing: true });
  fireEvent.compositionEnd(input, { target: { value: '你好' }, data: '你好' });
  await waitFor(() => {
    const state = restoreReviewState(host.savedState);
    expect(state.sessions.find(({ id }) => id === state.activeSessionId)!.draft).toBe('你好');
  });
  fireEvent.click(view.getByRole('tab', { name: 'File Change Status' }));
  fireEvent.click(view.getByRole('tab', { name: 'Agent Chat Windows' }));
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    '你好',
  );
  expect(host.runs).toHaveLength(0);
});

async function streaming(view: View) {
  host.holdStream = true;
  await connected(view);
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
    target: { value: 'streamed question' },
  });
  fireEvent.click(view.getByRole('button', { name: '发送消息' }));
  await waitFor(() => expect(view.getByText('answer:model-a:1')).toBeDefined());
  expect((view.getByRole('combobox', { name: '选择 AI 模型' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
}

test('model selector searches the account catalog and keeps the draft when reselecting the current model', async () => {
  const view = mount();
  await connected(view);
  const original = restoreReviewState(host.savedState).activeSessionId;
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
    target: { value: 'draft to keep' },
  });
  fireEvent.click(view.getByRole('combobox', { name: '选择 AI 模型' }));
  fireEvent.change(await view.findByRole('combobox', { name: '搜索模型' }), {
    target: { value: 'Model A' },
  });
  await waitFor(() => expect(view.queryByRole('option', { name: 'Model B' })).toBeNull());
  fireEvent.click(view.getByRole('option', { name: 'Model A' }));
  expect(restoreReviewState(host.savedState).activeSessionId).toBe(original);
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    'draft to keep',
  );
  expect(host.creations).toHaveLength(0);
});

test('file-region links dispatch reference IDs with their conversation session, including restored history', async () => {
  const referenceId = `ref_${'a'.repeat(64)}`;
  host.responseText = `See [file.ts:2–3](review-file:${referenceId}).`;
  const view = mount();
  await connected(view);
  await send(view, 'first-reference-question');
  const link = await view.findByRole('link', { name: 'file.ts:2–3' });
  const state = restoreReviewState(host.savedState);
  const first = state.sessions.find(({ id }) => id === state.activeSessionId)!;
  expect(link.className).toContain('font-mono');
  await act(async () => {
    fireEvent.click(link);
    await host.settle();
  });
  expect(host.openedReferences).toEqual([{ sessionId: first.bridgeSessionId!, referenceId }]);
  expect(host.openedFiles).toEqual([]);
  fireEvent.click(view.getByRole('button', { name: '新建会话' }));
  host.responseText = 'Another conversation.';
  await send(view, 'second-reference-question');
  await view.findByText('Another conversation.');
  fireEvent.click(view.getByRole('tab', { name: 'History' }));
  fireEvent.click(view.getByRole('button', { name: /first-reference-question/ }));
  await act(async () => {
    fireEvent.click(view.getByRole('link', { name: 'file.ts:2–3' }));
    await host.settle();
  });
  expect(host.openedReferences.at(-1)).toEqual({ sessionId: first.bridgeSessionId!, referenceId });
});

test('whole-file and range Markdown links both highlight and dispatch opaque IDs in the same session', async () => {
  const fileId = `ref_${'c'.repeat(64)}`;
  const rangeId = `ref_${'d'.repeat(64)}`;
  host.responseText = `[file.ts](review-file:${fileId}) and [file.ts:2–3](review-file:${rangeId})`;
  const view = mount();
  await connected(view);
  await send(view, 'mixed-file-references');
  const fileLink = await view.findByRole('link', { name: 'file.ts' });
  const rangeLink = await view.findByRole('link', { name: 'file.ts:2–3' });
  expect(fileLink.className).toContain('font-mono');
  expect(rangeLink.className).toBe(fileLink.className);
  const state = restoreReviewState(host.savedState);
  const sessionId = state.sessions.find(({ id }) => id === state.activeSessionId)!.bridgeSessionId!;
  await act(async () => {
    fireEvent.click(fileLink);
    fireEvent.click(rangeLink);
    await host.settle();
  });
  expect(host.openedReferences).toEqual([
    { sessionId, referenceId: fileId },
    { sessionId, referenceId: rangeId },
  ]);
  expect(host.openedFiles).toEqual([]);
});

test('reference links preserve legacy URI navigation and leave malformed references inert', async () => {
  const file = 'file:///workspace/repo/file.ts';
  host.responseText = `[legacy file](review-file:${encodeURIComponent(file)}) [invalid](review-file:ref_fake) [malformed](review-file:%ZZ)`;
  const view = mount();
  await connected(view);
  await send(view, 'legacy-reference');
  await view.findByRole('link', { name: 'legacy file' });
  expect(view.queryByRole('link', { name: 'invalid' })).toBeNull();
  expect(view.queryByRole('link', { name: 'malformed' })).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole('link', { name: 'legacy file' }));
    await host.settle();
  });
  expect(host.openedFiles).toEqual([file]);
  expect(host.openedReferences).toEqual([]);
});

test('reference navigation errors are displayed without resending a chat turn', async () => {
  const referenceId = `ref_${'b'.repeat(64)}`;
  host.responseText = `[file.ts:1](review-file:${referenceId})`;
  host.referenceError = '代码引用已失效（会话或快照已结束），请重新生成引用。';
  const view = mount();
  await connected(view);
  await send(view, 'expired-reference');
  await view.findByRole('link', { name: 'file.ts:1' });
  await act(async () => {
    fireEvent.click(view.getByRole('link', { name: 'file.ts:1' }));
    await host.settle();
  });
  expect(view.getByRole('alert').textContent).toBe(host.referenceError);
  expect(host.runs).toHaveLength(1);
  expect(host.openedFiles).toEqual([]);
});

test('chat renders GFM tables, alignment, task lists and strikethrough through the shared renderer', async () => {
  host.responseText = [
    '| 工具 | 用途 | 次数 |',
    '| :--- | :---: | ---: |',
    '| `review.get_review_context` | 获取当前仓库 | 1 |',
    '| `review.list_changes` | 创建审查快照 | 2 |',
    '',
    '~~旧工具~~',
    '',
    '- [x] 已完成',
    '- [ ] 待处理',
  ].join('\n');
  const view = mount();
  await connected(view);
  await send(view, 'list available tools');
  const table = await view.findByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent),
  ).toEqual(['工具', '用途', '次数']);
  expect(table.querySelector('tbody td code')?.textContent).toBe('review.get_review_context');
  expect(table.querySelectorAll('th')[1]?.style.textAlign).toBe('center');
  expect(table.querySelectorAll('th')[2]?.style.textAlign).toBe('right');
  expect(view.container.querySelector('del')?.textContent).toBe('旧工具');
  expect(view.getAllByRole('checkbox').map((input) => (input as HTMLInputElement).checked)).toEqual(
    [true, false],
  );
});

test('shared chat Markdown preserves inert HTML and images and filters unsafe link protocols', async () => {
  host.responseText = [
    '[安全链接](https://example.com/docs)',
    '[危险链接](javascript:alert%281%29)',
    '![图片说明](https://example.com/image.png)',
    '',
    '<img src="https://example.com/raw.png" />',
    '<iframe src="https://example.com/embed"></iframe>',
  ].join('\n');
  const view = mount();
  await connected(view);
  await send(view, 'render Markdown safely');
  const link = await view.findByRole('link', { name: '安全链接' });
  expect(link.getAttribute('href')).toBe('https://example.com/docs');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(view.getByText('危险链接').getAttribute('href')).toBe('');
  expect(view.getByText('图片说明')).toBeDefined();
  const assistant = view.container.querySelector('[data-slot="aui_assistant-message-root"]')!;
  expect(assistant.querySelector('img, iframe, script')).toBeNull();
});

test('syntax highlighting preserves code, inline text, unknown languages and Host code actions', async () => {
  const code = 'const total: number = 1;\n';
  host.responseText =
    'Inline `const total = 1`.\n\n```typescript\n' +
    code +
    '```\n\n```unknown-language\nraw <sample>\n```';
  const view = mount();
  await connected(view);
  await send(view, 'review this code');
  const assistant = await waitFor(() => {
    const message = view.container.querySelector('[data-slot="aui_assistant-message-root"]')!;
    expect(message?.querySelector('pre code .token')).not.toBeNull();
    return message;
  });
  const frames = Array.from(assistant.querySelectorAll('pre'));
  expect(frames.filter((frame) => frame.textContent === code)).toHaveLength(2);
  expect(frames.filter((frame) => frame.textContent?.trim() === 'raw <sample>')).toHaveLength(2);
  expect(frames.some((frame) => frame.classList.contains('dark:hidden'))).toBe(true);
  expect(frames.some((frame) => frame.classList.contains('dark:block'))).toBe(true);
  expect(assistant.querySelector('p > code')?.textContent).toBe('const total = 1');
  expect(assistant.querySelector('p > code span')).toBeNull();
  await act(async () => {
    fireEvent.click(view.getAllByRole('button', { name: '复制代码' })[0]!);
    fireEvent.click(view.getAllByRole('button', { name: '在编辑器中打开代码' })[0]!);
    await host.settle();
  });
  expect(host.copiedTexts).toEqual([code]);
  expect(host.openedCode).toEqual([{ code, language: 'typescript' }]);
});
async function delta(view: View, suffix: string) {
  await act(async () => {
    host.streamOutput!.enqueue({ type: 'text-delta', id: host.streamId, delta: suffix });
  });
  await waitFor(() =>
    expect(
      view.container.querySelector('[data-slot="aui_assistant-message-root"]')?.textContent,
    ).toContain(suffix),
  );
}

test('streamed deltas render live with bounded persistence and flush the completed transcript', async () => {
  const view = mount();
  await streaming(view);
  const writes = host.savedWrites;
  let expected = 'answer:model-a:1';
  for (let index = 0; index < 12; index++) {
    const suffix = ` chunk-${index}`;
    expected += suffix;
    await delta(view, suffix);
  }
  expect(host.savedWrites - writes).toBeLessThanOrEqual(1);
  await waitFor(() =>
    expect(restoreReviewState(host.savedState).sessions[0]!.messages.at(-1)?.text).toBe(expected),
  );
  await delta(view, ' final');
  await act(async () => {
    host.streamOutput!.enqueue({ type: 'text-end', id: host.streamId });
    host.streamOutput!.enqueue(finishChunk('stop'));
    host.streamOutput!.close();
    await host.settle();
  });
  expect(restoreReviewState(host.savedState).sessions[0]!.messages.at(-1)?.text).toBe(
    `${expected} final`,
  );
  await act(async () => cleanup());
  const restored = mount();
  await connected(restored);
  expect(restored.getByText(`${expected} final`)).toBeDefined();
});

test('GFM tables render while their header, code spans and rows arrive in separate deltas', async () => {
  const view = mount();
  await streaming(view);
  await act(async () => {
    host.streamOutput!.enqueue({
      type: 'text-delta',
      id: host.streamId,
      delta: '\n\n| 工具 | 用途 |\n| --- | --- |\n| `review.get_',
    });
  });
  const table = await view.findByRole('table');
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent),
  ).toEqual(['工具', '用途']);
  await act(async () => {
    host.streamOutput!.enqueue({
      type: 'text-delta',
      id: host.streamId,
      delta: 'review_context` | 获取当前仓库 |',
    });
  });
  await waitFor(() =>
    expect(table.querySelector('tbody td code')?.textContent).toBe('review.get_review_context'),
  );
  await act(async () => {
    host.streamOutput!.enqueue({
      type: 'text-delta',
      id: host.streamId,
      delta: '\n| `review.list_changes` | 创建审查快照 |',
    });
    host.streamOutput!.enqueue({ type: 'text-end', id: host.streamId });
    host.streamOutput!.enqueue(finishChunk('stop'));
    host.streamOutput!.close();
    await host.settle();
  });
  await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3));
  expect(table.querySelectorAll('tbody td code')[1]?.textContent).toBe('review.list_changes');
  expect(view.queryByRole('alert')).toBeNull();
});

for (const terminal of ['error', 'cancel', 'new-session'] as const) {
  test(`${terminal} flushes pending streamed text into its original session`, async () => {
    const view = mount();
    await streaming(view);
    const original = restoreReviewState(host.savedState).activeSessionId;
    await delta(view, ' latest');
    await act(async () => {
      if (terminal === 'error') {
        host.streamOutput!.error(new BridgeError('temporary_failure', 'Retry later', 503));
      } else {
        fireEvent.click(
          view.getByRole('button', { name: terminal === 'cancel' ? '取消运行' : '新建会话' }),
        );
      }
      await host.settle();
    });
    const saved = restoreReviewState(host.savedState);
    expect(saved.sessions.find((item) => item.id === original)!.messages.at(-1)?.text).toBe(
      'answer:model-a:1 latest',
    );
    if (terminal === 'new-session') {
      expect(saved.activeSessionId).not.toBe(original);
      expect(saved.sessions.find((item) => item.id === saved.activeSessionId)!.messages).toEqual(
        [],
      );
    }
  });
}

test('a failed turn renders the error state in its message and retries that turn', async () => {
  const view = mount();
  await streaming(view);
  await act(async () => {
    host.holdStream = false;
    host.streamOutput!.error(new BridgeError('temporary_failure', 'Retry later', 503));
    await host.settle();
  });
  const banner = await waitFor(() => {
    const element = view.container.querySelector('[data-slot="error-state"]')!;
    expect(element.textContent).toContain('Retry later');
    return element;
  });
  // The failure sits in the message it belongs to, with the top banner free of
  // it, and keeps its retry available.
  expect(banner.getAttribute('role')).toBe('alert');
  expect(banner.textContent).toContain('回复失败');
  expect(banner.closest('[data-slot="aui_assistant-message-root"]')).not.toBeNull();
  expect(view.container.querySelectorAll('[role="alert"]')).toHaveLength(1);

  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: '重试' }));
    await host.settle();
  });
  // The retried turn resends the same user message and replaces the failure.
  await answered(view, 2);
  expect(host.runs[1]!.text).toBe('streamed question');
  expect(view.queryByRole('alert')).toBeNull();
});

for (const message of [
  'ChatGPT authorization was declined.',
  'OpenAI identity verification failed.',
]) {
  test(`ended sign-in re-enables retry and displays ${message}`, async () => {
    host.status = { authenticated: false, signInPending: false, accounts: [] };
    const view = mount();
    openSettingsMenu(view);
    fireEvent.click(view.getByRole('button', { name: 'Continue with ChatGPT' }));
    await waitFor(() =>
      expect(
        (view.getByRole('button', { name: '等待浏览器授权…' }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    host.status.signInPending = false;
    host.status.signInError = message;
    await waitFor(
      () =>
        expect(
          (view.getByRole('button', { name: 'Continue with ChatGPT' }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      { timeout: 4000 },
    );
    expect(view.getByRole('alert').textContent).toContain(message);
    fireEvent.click(view.getByRole('button', { name: 'Continue with ChatGPT' }));
    await waitFor(() => expect(host.status.signInPending).toBe(true));
  }, 10000);
}

test('failed account switch keeps the active account and releases the Add account button', async () => {
  const view = mount();
  await connected(view);
  openSettingsMenu(view);
  fireEvent.click(view.getByRole('button', { name: '添加账户' }));
  await waitFor(() =>
    expect((view.getByRole('button', { name: '添加账户' }) as HTMLButtonElement).disabled).toBe(
      true,
    ),
  );
  host.status.signInPending = false;
  host.status.signInError = 'ChatGPT authorization was declined.';
  await waitFor(
    () =>
      expect((view.getByRole('button', { name: '添加账户' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    { timeout: 4000 },
  );
  expect(host.status.activeAccountId).toBe('account-a');
  expect(view.getByRole('alert').textContent).toContain('declined');
}, 10000);

test('completed authorization releases waiting even when the model catalog fails', async () => {
  host.status = { authenticated: false, signInPending: false, accounts: [] };
  const view = mount();
  openSettingsMenu(view);
  fireEvent.click(view.getByRole('button', { name: 'Continue with ChatGPT' }));
  await waitFor(() => expect(host.status.signInPending).toBe(true));
  host.status.authenticated = true;
  host.status.activeAccountId = 'account-a';
  host.status.signInPending = false;
  host.modelFailure = true;
  await waitFor(
    () =>
      expect((view.getByRole('button', { name: '添加账户' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    { timeout: 4000 },
  );
  await waitFor(() =>
    expect(view.getByRole('alert').textContent).toContain('Model catalog unavailable'),
  );
}, 10000);

test('restored legacy history is preserved and cannot silently start an empty Host conversation', async () => {
  const original = createSession();
  host.savedState = appendTurn(
    restoreReviewState({ sessions: [original], activeSessionId: original.id }),
    'earlier question',
    'earlier answer',
  );
  const view = mount();
  await connected(view);
  await send(view, 'continue the earlier question');
  await waitFor(() =>
    expect(view.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      '旧会话未连接 Host',
    ),
  );
  expect(view.getAllByText('earlier question')).toHaveLength(2);
  expect(view.getByText('earlier answer')).toBeDefined();
  expect(host.creations).toHaveLength(0);
  expect(host.runs).toHaveLength(0);
});

test('fresh conversation still sends its first turn and a selected historical conversation restores its model', async () => {
  const view = mount();
  await connected(view);
  await send(view, 'conversation-a');
  await answered(view, 1);
  const firstId = restoreReviewState(host.savedState).activeSessionId;
  await chooseModel(view, 'Model B');
  await waitFor(() =>
    expect(restoreReviewState(host.savedState).activeSessionId).not.toBe(firstId),
  );
  await send(view, 'conversation-b');
  await answered(view, 2);
  fireEvent.click(view.getByRole('tab', { name: 'History' }));
  fireEvent.click(view.getByRole('button', { name: /conversation-a/ }));
  expect(view.getByRole('combobox', { name: '选择 AI 模型' }).textContent).toContain('Model A');
  await send(view, 'follow-up-a');
  await answered(view, 3);
  expect(host.runs.map((run) => run.model)).toEqual(['model-a', 'model-b', 'model-a']);
  expect(host.creations).toHaveLength(2);
});

for (const unavailable of ['model', 'account'] as const) {
  test(`historical session with unavailable ${unavailable} displays its binding and blocks dispatch`, async () => {
    const providerSession = {
      model: 'model-b',
      accountId: unavailable === 'account' ? 'account-other' : 'account-a',
    };
    const bound = host.runtime.sessions.create('openai-agents', providerSession);
    const local = {
      ...createSession(),
      bridgeSessionId: bound.id,
      model: bound.provider.model,
      accountId: bound.provider.accountId,
    };
    host.savedState = appendTurn(
      restoreReviewState({ sessions: [local], activeSessionId: local.id }),
      'saved question',
      'saved answer',
    );
    if (unavailable === 'model') host.models = host.models.filter(({ id }) => id === 'model-a');
    const view = mount();
    await connected(view);
    expect(view.getByRole('combobox', { name: '选择 AI 模型' }).textContent).toContain(
      unavailable === 'model' ? 'model-b（当前账户不可用）' : 'Model B',
    );
    await send(view, 'follow-up');
    await waitFor(() =>
      expect(view.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
        unavailable === 'model' ? '模型在当前账户中不可用' : '属于另一个 ChatGPT 账户',
      ),
    );
    expect(host.runs).toHaveLength(0);
    expect(host.creations).toHaveLength(0);
  });
}

test('more than 100 UI conversations reclaim evicted Host sessions under StrictMode', async () => {
  const view = mount();
  await connected(view);
  for (let index = 0; index < 105; index++) {
    if (index) fireEvent.click(view.getByRole('button', { name: '新建会话' }));
    await send(view, `turn-${index}`);
    await answered(view, index + 1);
  }
  expect(host.creations).toHaveLength(105);
  expect(host.runtime.sessions.list()).toHaveLength(20);
  expect(restoreReviewState(host.savedState).sessions).toHaveLength(20);
  expect(restoreReviewState(host.savedState).pendingBridgeSessionDeletes).toEqual([]);
}, 30000);

test('failed eviction deletion survives reload and retries; already missing Host IDs are acknowledged', async () => {
  const sessions = Array.from({ length: 20 }, (_value, index) => {
    const bound = host.runtime.sessions.create('openai-agents', {
      model: 'model-a',
      accountId: 'account-a',
    });
    const local = {
      ...createSession(),
      bridgeSessionId: bound.id,
      model: 'model-a',
      accountId: 'account-a',
    };
    return appendTurn(
      restoreReviewState({ sessions: [local], activeSessionId: local.id }),
      `old-${index}`,
      'old answer',
    ).sessions[0]!;
  });
  host.savedState = restoreReviewState({ sessions, activeSessionId: sessions[19]!.id });
  const evictedId = sessions[0]!.bridgeSessionId!;
  host.deleteFailures = 2;
  let view = mount();
  await connected(view);
  fireEvent.click(view.getByRole('button', { name: '新建会话' }));
  await waitFor(() => expect(host.deletes).toContain(evictedId));
  await waitFor(() =>
    expect(restoreReviewState(host.savedState).pendingBridgeSessionDeletes).toContain(evictedId),
  );
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('历史会话清理失败'));
  await act(async () => cleanup());
  host.deleteFailures = 0;
  view = mount();
  await connected(view);
  await waitFor(() =>
    expect(restoreReviewState(host.savedState).pendingBridgeSessionDeletes).toEqual([]),
  );
  expect(() => host.runtime.sessions.get(evictedId)).toThrow('not found');
  await act(async () => cleanup());
  host.savedState = {
    ...restoreReviewState(host.savedState),
    pendingBridgeSessionDeletes: ['missing-host-session'],
  };
  view = mount();
  await connected(view);
  await waitFor(() =>
    expect(restoreReviewState(host.savedState).pendingBridgeSessionDeletes).toEqual([]),
  );
  expect(view.queryByRole('alert')).toBeNull();
});

const gitRepository: PanelSnapshot['git']['repositories'][number] = {
  rootUri: 'file:///repo',
  name: 'review-bot',
  branch: 'feat/webview-layout',
  remotes: ['origin'],
  changes: [
    { uri: 'file:///repo/src/a.ts', path: 'src/a.ts', kind: 'modified' },
    { uri: 'file:///repo/src/b.ts', path: 'src/b.ts', kind: 'added' },
  ],
  stagedChanges: [{ uri: 'file:///repo/src/c.ts', path: 'src/c.ts', kind: 'deleted' }],
};

test('workspace context moves into Files while the Thread keeps one Git summary line', async () => {
  host.git = { available: true, repositories: [gitRepository] };
  const view = mount();
  await connected(view);
  const chat = view.container.querySelector<HTMLElement>('#panel-chat')!;
  const files = view.container.querySelector<HTMLElement>('#panel-files')!;
  expect(chat.querySelectorAll('[aria-label="工作区上下文"]')).toHaveLength(0);
  expect(files.querySelectorAll('[aria-label="工作区上下文"]')).toHaveLength(1);

  // One single-line summary below the composer: branch, status and counts.
  const gitLines = chat.querySelectorAll('[data-slot="review-git-status"]');
  expect(gitLines).toHaveLength(1);
  const line = gitLines[0]!.textContent!;
  expect(line).toContain('feat/webview-layout');
  expect(line).toContain('3 changed');
  expect(line).toContain('+1');
  expect(line).toContain('~1');
  expect(line).toContain('−1');
  expect(gitLines[0]!.querySelectorAll('p, div, li, section')).toHaveLength(0);

  fireEvent.click(view.getByRole('tab', { name: 'File Change Status' }));
  const filesTab = within(files);
  expect(filesTab.getByText('review-bot')).toBeDefined();
  expect(filesTab.getByText('Idle')).toBeDefined();

  // Both groups start expanded, one row per file.
  const changes = filesTab.getByRole('button', { name: /^Changes/ });
  const staged = filesTab.getByRole('button', { name: /^Staged Changes/ });
  expect(changes.getAttribute('aria-expanded')).toBe('true');
  expect(staged.getAttribute('aria-expanded')).toBe('true');
  expect(filesTab.getByRole('button', { name: '修改 src/a.ts' })).toBeDefined();
  expect(filesTab.getByRole('button', { name: '新增 src/b.ts' })).toBeDefined();
  expect(filesTab.getByRole('button', { name: '删除 src/c.ts' })).toBeDefined();

  // Collapsing one group hides only its own rows and can be reopened.
  fireEvent.click(changes);
  expect(changes.getAttribute('aria-expanded')).toBe('false');
  expect(files.querySelector<HTMLElement>('#change-group-changes')!.hidden).toBe(true);
  expect(filesTab.queryByRole('button', { name: '修改 src/a.ts' })).toBeNull();
  expect(filesTab.getByRole('button', { name: '删除 src/c.ts' })).toBeDefined();
  fireEvent.click(changes);
  expect(filesTab.getByRole('button', { name: '修改 src/a.ts' })).toBeDefined();
  fireEvent.click(staged);
  expect(files.querySelector<HTMLElement>('#change-group-staged-changes')!.hidden).toBe(true);

  // The context header collapses to its summary row.
  fireEvent.click(filesTab.getByRole('button', { name: '收起工作区上下文' }));
  const toggle = filesTab.getByRole('button', { name: '展开工作区上下文' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(files.querySelector<HTMLElement>('#review-context-details')!.hidden).toBe(true);

  await act(async () => {
    fireEvent.click(filesTab.getByRole('button', { name: '修改 src/a.ts' }));
    await host.settle();
  });
  expect(host.openedFiles).toEqual(['file:///repo/src/a.ts']);
});
