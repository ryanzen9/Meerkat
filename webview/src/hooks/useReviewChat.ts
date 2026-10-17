import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import type { ThreadSuggestion } from '@assistant-ui/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/ai-sdk';
import type { ReviewChatMessage } from '@shared/chat';
import type { ChatMessage, ReviewTab } from '@shared/models';
import { vscodeBridge } from '../services/vscode';
import { restoreReviewState, sessionMarkdown, startNewReviewSession } from '../state/reviewState';
import { bridgeFetch } from '../services/bridgeFetch';
import { bridgeJson, BridgeResponseError } from '../services/bridgeApi';
import type { AgentModel, ReasoningEffort } from '@shared/agentModels';
import type { InteractionMode, ReviewSnapshotState } from '@shared/review';
import { reviewReceiptSchema, reviewRunStateSchema, reviewSnapshotSchema } from '@shared/review';
import {
  interruptExpiredReviews,
  mergeReviewReceipt,
  restoreReviewMessages,
} from '../state/reviewReceipts';

const convertMessage = (message: ChatMessage): ReviewChatMessage => ({
  id: message.id,
  role: message.role,
  parts: [{ type: 'text', text: message.text }],
});

/**
 * Start-page prompts, rendered by the Thread element's welcome list (title +
 * label per row). The whole `prompt` is sent when a row is chosen. Only fed to
 * the runtime while the conversation is empty, so the follow-up row stays
 * reserved for suggestions generated from a reply.
 */
const START_SUGGESTIONS: readonly ThreadSuggestion[] = [
  {
    title: '审查当前工作区的改动',
    label: '找出潜在问题',
    prompt: '审查当前工作区的改动，找出潜在问题',
  },
  {
    title: '总结这次改动',
    label: '内容、影响面与风险',
    prompt: '总结这次改动的内容、影响面与风险',
  },
  {
    title: '检查边界情况',
    label: '与测试覆盖的遗漏',
    prompt: '检查边界情况与测试覆盖是否有遗漏',
  },
];

const NO_SUGGESTIONS: readonly ThreadSuggestion[] = [];

export function useReviewChat(connection: {
  model: string;
  authenticated: boolean;
  activeAccountId?: string;
  models: AgentModel[];
  modelsReady: boolean;
  modelsLoading: boolean;
}) {
  const [state, setState] = useState(() => restoreReviewState(vscodeBridge.getState()));
  const session = state.sessions.find(({ id }) => id === state.activeSessionId)!;
  const legacySessionIds = useRef(
    new Set(
      state.sessions
        .filter((item) => item.messages.length && !item.bridgeSessionId)
        .map((item) => item.id),
    ),
  );
  const [cleanupError, setCleanupError] = useState('');
  const model = session.model ?? connection.model;
  const modelAvailable = connection.models.some((item) => item.id === model);
  const selectedModel = connection.models.find((item) => item.id === model);
  const reasoningEffort = session.reasoningEffort ?? selectedModel?.defaultReasoningEffort;
  const mode = session.mode ?? 'chat';
  const effortAvailable =
    reasoningEffort === undefined ||
    selectedModel?.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === reasoningEffort,
    );
  const bindingError =
    connection.authenticated &&
    session.accountId &&
    session.accountId !== connection.activeAccountId
      ? '此会话属于另一个 ChatGPT 账户，请切回原账户或新建会话。'
      : connection.authenticated && connection.modelsReady && session.model && !modelAvailable
        ? '此会话的模型在当前账户中不可用，请选择模型并新建会话。'
        : connection.authenticated && connection.modelsReady && modelAvailable && !effortAvailable
          ? '此会话的推理强度已不可用，请选择当前模型支持的 Thinking 档位。'
          : '';

  useEffect(() => {
    vscodeBridge.setState(state);
  }, [state]);

  useEffect(() => {
    const pending = state.pendingBridgeSessionDeletes;
    if (!pending.length) {
      setCleanupError('');
      return;
    }
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const drain = async () => {
      const completed: string[] = [];
      let failed = false;
      for (const id of pending) {
        if (controller.signal.aborted) return;
        try {
          await bridgeJson<void>(`/v1/sessions/${id}`, 'DELETE', undefined, controller.signal);
          completed.push(id);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof BridgeResponseError && error.status === 404) completed.push(id);
          else failed = true;
        }
      }
      if (controller.signal.aborted) return;
      setCleanupError(failed ? '历史会话清理失败，正在重试。' : '');
      if (completed.length)
        setState((current) => ({
          ...current,
          pendingBridgeSessionDeletes: current.pendingBridgeSessionDeletes.filter(
            (id) => !completed.includes(id),
          ),
        }));
      if (failed)
        retry = setTimeout(() => {
          void drain();
        }, 5000);
    };
    void drain();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [state.pendingBridgeSessionDeletes]);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: '/v1/chat',
        // Bun's test types add a static preconnect member to fetch; the browser
        // transport consumes only the standard callable Fetch API.
        fetch: bridgeFetch as typeof fetch,
        prepareSendMessagesRequest: async ({ messages }) => {
          if (!connection.modelsReady)
            throw new Error(
              connection.modelsLoading ? '模型列表正在加载，请稍候。' : '请重试加载模型列表。',
            );
          if (!connection.authenticated || !connection.model)
            throw new Error('请先 Continue with ChatGPT 并选择模型。');
          if (bindingError) throw new Error(bindingError);
          let sessionId = session.bridgeSessionId;
          if (sessionId) {
            // Host histories deliberately expire on restart. Never silently turn a
            // displayed old conversation into a context-free new Agent session.
            const existing = await bridgeJson<{ id: string; model: string; accountId: string }>(
              `/v1/sessions/${sessionId}`,
            ).catch((error: unknown) => {
              if (error instanceof BridgeResponseError && error.status === 404)
                throw new Error('Host 会话已结束，请新建会话。');
              throw error;
            });
            setState((current) => ({
              ...current,
              sessions: current.sessions.map((item) =>
                item.id === session.id
                  ? { ...item, model: existing.model, accountId: existing.accountId }
                  : item,
              ),
            }));
            if (existing.accountId !== connection.activeAccountId)
              throw new Error('此会话属于另一个 ChatGPT 账户，请切回原账户或新建会话。');
            if (!connection.models.some((item) => item.id === existing.model))
              throw new Error('此会话的模型在当前账户中不可用，请选择模型并新建会话。');
          } else {
            if (legacySessionIds.current.has(session.id))
              throw new Error('旧会话未连接 Host，无法恢复完整上下文，请新建会话。');
            const created = await bridgeJson<{ id: string; model: string; accountId: string }>(
              '/v1/sessions',
              'POST',
              {
                providerId: 'openai-agents',
                model: connection.model,
              },
            );
            sessionId = created.id;
            setState((current) => ({
              ...current,
              sessions: current.sessions.map((item) =>
                item.id === session.id
                  ? {
                      ...item,
                      bridgeSessionId: created.id,
                      model: created.model,
                      accountId: created.accountId,
                    }
                  : item,
              ),
            }));
          }
          return {
            body: {
              sessionId,
              mode,
              messages: messages.slice(-1),
              ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            },
          };
        },
      }),
    [
      connection.authenticated,
      connection.activeAccountId,
      connection.model,
      connection.models,
      connection.modelsReady,
      connection.modelsLoading,
      session.id,
      session.bridgeSessionId,
      bindingError,
      reasoningEffort,
      mode,
    ],
  );
  const chat = useChat<ReviewChatMessage>({
    id: session.id,
    messages: restoreReviewMessages(session.messages.map(convertMessage), session.reviews),
    transport,
    onData: (part) => {
      if (part.type !== 'data-review-status' && part.type !== 'data-review-receipt') return;
      const status =
        part.type === 'data-review-status' ? reviewRunStateSchema.safeParse(part.data) : undefined;
      const receipt =
        part.type === 'data-review-receipt' ? reviewReceiptSchema.safeParse(part.data) : undefined;
      const run = status?.success ? status.data : receipt?.success ? receipt.data.run : undefined;
      if (!run) return;
      const result = receipt?.success ? receipt.data.result : undefined;
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.bridgeSessionId !== run.sessionId
            ? item
            : {
                ...item,
                reviews: mergeReviewReceipt(item.reviews, run, result),
              },
        ),
      }));
    },
  });
  const setMessages = chat.setMessages;
  useEffect(() => {
    if (!session.bridgeSessionId || chat.status === 'submitted' || chat.status === 'streaming')
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = async () => {
      try {
        const reviews: ReviewSnapshotState = reviewSnapshotSchema.parse(
          await bridgeJson<unknown>(
            `/v1/sessions/${session.bridgeSessionId}/reviews`,
            'GET',
            undefined,
            controller.signal,
          ),
        );
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          sessions: current.sessions.map((item) =>
            item.id === session.id ? { ...item, reviews } : item,
          ),
        }));
        setMessages((messages) => restoreReviewMessages(messages, reviews));
        if (reviews.runs.some((run) => run.status === 'running'))
          timer = setTimeout(() => {
            void recover();
          }, 1000);
      } catch (error) {
        if (controller.signal.aborted) return;
        // Local receipts remain readable after the Host session expires.
        if (error instanceof BridgeResponseError && error.status === 404) {
          const reviews = interruptExpiredReviews(session.reviews);
          if (reviews) {
            setState((current) => ({
              ...current,
              sessions: current.sessions.map((item) =>
                item.id === session.id ? { ...item, reviews } : item,
              ),
            }));
            setMessages((messages) => restoreReviewMessages(messages, reviews));
          }
        } else
          timer = setTimeout(() => {
            void recover();
          }, 2000);
      }
    };
    void recover();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session.id, session.bridgeSessionId, chat.status, setMessages]);
  // The Bridge accepts text turns; do not offer the SDK's default file uploads.
  const runtime = useAISDKRuntime(chat, {
    isSendDisabled: !connection.modelsReady,
    suggestions: chat.messages.length === 0 ? START_SUGGESTIONS : NO_SUGGESTIONS,
    adapters: { attachments: undefined },
  });
  const lastMessages = useRef({ sessionId: session.id, messages: chat.messages });
  const saveMessages = useCallback((sessionId: string, transcript: ReviewChatMessage[]) => {
    if (!transcript.length) return;
    const previous = lastMessages.current;
    if (previous.sessionId === sessionId && previous.messages === transcript) return;
    lastMessages.current = { sessionId, messages: transcript };
    const now = new Date().toISOString();
    const messages: ChatMessage[] = transcript.map((message) => ({
      id: message.id,
      role: message.role === 'user' ? 'user' : 'assistant',
      text: message.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .slice(0, 4000),
      createdAt: now,
      ...(message.id.startsWith('review-') && message.role === 'assistant'
        ? { reviewRunId: message.id.slice('review-'.length) }
        : {}),
    }));
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              messages: messages.slice(-100),
              draft: '',
              updatedAt: now,
              title: messages[0]?.text.replace(/\s+/g, ' ').slice(0, 60) || item.title,
            }
          : item,
      ),
    }));
  }, []);
  useEffect(() => {
    const previous = lastMessages.current;
    if (previous.sessionId !== session.id) {
      lastMessages.current = { sessionId: session.id, messages: chat.messages };
      return;
    }
    if (previous.messages === chat.messages) return;
    const save = () => saveMessages(session.id, chat.messages);
    // Keep live deltas in the SDK; rebuild and persist the summary after a pause.
    // A terminal status flushes immediately, even when the final message is unchanged.
    if (chat.status === 'submitted' || chat.status === 'streaming') {
      const timer = setTimeout(save, 250);
      return () => clearTimeout(timer);
    }
    save();
  }, [chat.messages, chat.status, session.id, saveMessages]);

  const setDraft = useCallback(
    (draft: string) =>
      setState((current) => ({
        ...current,
        sessions: current.sessions.map((item) =>
          item.id === current.activeSessionId ? { ...item, draft } : item,
        ),
      })),
    [],
  );
  const setReasoningEffort = useCallback((effort: ReasoningEffort) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === current.activeSessionId ? { ...item, reasoningEffort: effort } : item,
      ),
    }));
  }, []);
  const setMode = useCallback((nextMode: InteractionMode) => {
    setState((current) => ({
      ...current,
      sessions: current.sessions.map((item) =>
        item.id === current.activeSessionId ? { ...item, mode: nextMode } : item,
      ),
    }));
  }, []);
  const setTab = useCallback(
    (activeTab: ReviewTab) => setState((current) => ({ ...current, activeTab })),
    [],
  );
  const selectRepository = useCallback(
    (repositoryUri: string) => setState((current) => ({ ...current, repositoryUri })),
    [],
  );
  const selectSession = useCallback(
    (activeSessionId: string) => {
      saveMessages(session.id, chat.messages);
      void chat.stop();
      setState((current) => ({ ...current, activeSessionId, activeTab: 'chat' }));
    },
    [chat.stop, chat.messages, session.id, saveMessages],
  );
  const newSession = useCallback(() => {
    saveMessages(session.id, chat.messages);
    void chat.stop();
    setState(startNewReviewSession);
  }, [chat.stop, chat.messages, session.id, saveMessages]);

  return {
    ...state,
    session,
    runtime,
    model,
    modelAvailable,
    reasoningEffort,
    mode,
    setMode,
    setReasoningEffort,
    // A failed turn renders in the message it belongs to (AgentChat's
    // MessageError); the shared banner keeps only panel-side problems.
    cleanupError,
    isRunning: chat.status === 'submitted' || chat.status === 'streaming',
    setDraft,
    setTab,
    selectRepository,
    selectSession,
    newSession,
    exportMarkdown: () => sessionMarkdown(session),
  };
}
