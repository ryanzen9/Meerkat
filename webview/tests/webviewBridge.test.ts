import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Window } from 'happy-dom';
import type { UIMessageChunk } from 'ai';
import type {
  AgentProvider,
  AccountStatus,
  ProviderSession,
} from '../../src/extension/bridge/providers/types';
import { ProviderRegistry } from '../../src/extension/bridge/providers/registry';
import { BridgeRuntime } from '../../src/extension/bridge/runtime/bridgeRuntime';
import { createBridgeApi } from '../../src/extension/bridge/server/api';
import { WebviewBridgeProxy } from '../../src/extension/bridge/transport/webviewProxy';
import { BridgeError } from '../../src/extension/bridge/errors';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../src/shared/protocol';
import { createSession, appendTurn, restoreReviewState } from '../src/state/reviewState';
import type { AgentModel, ReasoningEffort } from '../../src/shared/agentModels';

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
  includeTool = false;
  responseText?: string;
  deleteFailures = 0;
  copiedTexts: string[] = [];
  openedCode: { code: string; language: string }[] = [];
  savedState: unknown;
  savedWrites = 0;
  holdStream = false;
  streamOutput?: ReadableStreamDefaultController<UIMessageChunk>;
  streamId = '';
  creations: ProviderSession[] = [];
  runs: { model: string; text: string; reasoningEffort?: ReasoningEffort }[] = [];
  deletes: string[] = [];
  operations = new Set<Promise<void>>();
  runtime: BridgeRuntime;
  proxy: WebviewBridgeProxy;
  constructor() {
    const provider: AgentProvider = {
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
        if (this.modelFailure)
          throw new BridgeError('models_unavailable', 'Model catalog unavailable', 502);
        return this.models;
      },
      createSession: async (model) => {
        if (!this.status.authenticated)
          throw new BridgeError('sign_in_required', 'Sign in first', 401);
        const session = { model, accountId: this.status.activeAccountId!, state: {} };
        this.creations.push(session);
        return session;
      },
      run: async (session, text, signal, reasoningEffort) => {
        signal.throwIfAborted();
        this.runs.push({
          model: session.model,
          text,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
        });
        const id = randomUUID();
        const chunks: UIMessageChunk[] = [
          { type: 'start', messageId: id },
          { type: 'text-start', id },
          {
            type: 'text-delta',
            id,
            delta: this.responseText ?? `answer:${session.model}:${this.runs.length}`,
          },
          { type: 'text-end', id },
          { type: 'finish', finishReason: 'stop' },
        ];
        if (this.includeTool) {
          chunks.splice(
            1,
            0,
            {
              type: 'tool-input-available',
              toolCallId: 'inspect-call',
              toolName: 'inspect_text',
              input: { text },
            },
            { type: 'tool-output-available', toolCallId: 'inspect-call', output: { todos: 1 } },
          );
          chunks.splice(
            chunks.length - 1,
            0,
            { type: 'text-start', id: `${id}-second` },
            { type: 'text-delta', id: `${id}-second`, delta: 'Additional explanation.' },
            { type: 'text-end', id: `${id}-second` },
          );
        }
        return new ReadableStream<UIMessageChunk>({
          start: (output) => {
            if (this.holdStream) {
              this.streamOutput = output;
              this.streamId = id;
              chunks.slice(0, 3).forEach((chunk) => output.enqueue(chunk));
              return;
            }
            chunks.forEach((chunk) => output.enqueue(chunk));
            output.close();
          },
        });
      },
      deleteSession: async () => {},
      dispose: async () => {},
    };
    const registry = new ProviderRegistry();
    registry.register(() => provider);
    this.runtime = new BridgeRuntime(registry);
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
      case 'webview/ready':
        this.post({
          type: 'host/snapshot',
          snapshot: {
            workspace: { name: 'Fixture', folders: [], trusted: true },
            settings: { greeting: '', showWorkspacePaths: true },
            state: { messageCount: 0 },
            git: { available: false, repositories: [] },
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
  ({ render, fireEvent, cleanup, waitFor } = await import('@testing-library/react/pure'));
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
async function connected(view: View) {
  await waitFor(() =>
    expect(
      (view.getByRole('combobox', { name: '选择 AI 模型' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
async function chooseModel(view: View, name: string) {
  fireEvent.click(view.getByRole('combobox', { name: '选择 AI 模型' }));
  fireEvent.click(await view.findByRole('option', { name }));
}

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
  fireEvent.click(view.getByRole('button', { name: '1 tool call' }));
  fireEvent.click(view.getByRole('button', { name: 'Used tool: inspect_text' }));
  expect(assistant?.querySelector('[data-slot="tool-fallback-result"]')?.textContent).toContain(
    '"todos": 1',
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

test('Thread composer preserves drafts across tabs, sessions and remounts', async () => {
  const view = mount();
  await connected(view);
  await send(view, 'draft-session');
  await answered(view, 1);
  fireEvent.change(view.getByRole('textbox', { name: '询问 Agent' }), {
    target: { value: '检查这个变更的边界情况' },
  });
  const first = restoreReviewState(host.savedState).activeSessionId;
  fireEvent.click(view.getByRole('tab', { name: 'File Change Status' }));
  expect(view.queryByRole('textbox', { name: '询问 Agent' })).toBeNull();
  fireEvent.click(view.getByRole('tab', { name: 'Agent Chat Windows' }));
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    '检查这个变更的边界情况',
  );
  fireEvent.click(view.getByRole('button', { name: '新建会话' }));
  expect((view.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe('');
  fireEvent.click(view.getByRole('tab', { name: 'History' }));
  fireEvent.click(view.getByRole('button', { name: /draft-session/ }));
  expect(restoreReviewState(host.savedState).activeSessionId).toBe(first);
  await act(async () => cleanup());
  const restored = mount();
  await connected(restored);
  expect((restored.getByRole('textbox', { name: '询问 Agent' }) as HTMLTextAreaElement).value).toBe(
    '检查这个变更的边界情况',
  );
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
    host.streamOutput!.enqueue({ type: 'finish', finishReason: 'stop' });
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

for (const message of [
  'ChatGPT authorization was declined.',
  'OpenAI identity verification failed.',
]) {
  test(`ended sign-in re-enables retry and displays ${message}`, async () => {
    host.status = { authenticated: false, signInPending: false, accounts: [] };
    const view = mount();
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
  await waitFor(() => expect(view.getByRole('alert').textContent).toContain('旧会话未连接 Host'));
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
      state: {},
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
      expect(view.getByRole('alert').textContent).toContain(
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
      state: {},
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
