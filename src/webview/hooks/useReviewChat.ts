import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/ai-sdk';
import type { UIMessage } from 'ai';
import type { ChatMessage, ReviewTab } from '../../shared/models';
import { vscodeBridge } from '../services/vscode';
import { restoreReviewState, sessionMarkdown, startNewReviewSession } from '../state/reviewState';
import { bridgeFetch } from '../services/bridgeFetch';
import { bridgeJson, BridgeResponseError } from '../services/bridgeApi';

const convertMessage = (message: ChatMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: [{ type: 'text', text: message.text }],
});

export function useReviewChat(connection: {
  model: string;
  authenticated: boolean;
  activeAccountId?: string;
  models: { id: string; name: string }[];
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
  const bindingError =
    connection.authenticated &&
    session.accountId &&
    session.accountId !== connection.activeAccountId
      ? '此会话属于另一个 ChatGPT 账户，请切回原账户或新建会话。'
      : connection.authenticated && session.model && !modelAvailable
        ? '此会话的模型在当前账户中不可用，请选择模型并新建会话。'
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
          return { body: { sessionId, messages: messages.slice(-1) } };
        },
      }),
    [
      connection.authenticated,
      connection.activeAccountId,
      connection.model,
      connection.models,
      session.id,
      session.bridgeSessionId,
      bindingError,
    ],
  );
  const chat = useChat({
    id: session.id,
    messages: session.messages.map(convertMessage),
    transport,
  });
  const runtime = useAISDKRuntime(chat);
  const lastMessages = useRef({ sessionId: session.id, messages: chat.messages });
  const saveMessages = useCallback((sessionId: string, transcript: UIMessage[]) => {
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
    error: bindingError || chat.error?.message || cleanupError,
    isRunning: chat.status === 'submitted' || chat.status === 'streaming',
    setDraft,
    setTab,
    selectRepository,
    selectSession,
    newSession,
    exportMarkdown: () => sessionMarkdown(session),
  };
}
