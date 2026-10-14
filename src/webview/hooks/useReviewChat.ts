import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/ai-sdk';
import type { UIMessage } from 'ai';
import type { ChatMessage, ReviewTab } from '../../shared/models';
import { vscodeBridge } from '../services/vscode';
import { createSession, restoreReviewState, sessionMarkdown } from '../state/reviewState';
import { bridgeFetch } from '../services/bridgeFetch';
import { bridgeJson } from './useAgentConnection';

const convertMessage = (message: ChatMessage): UIMessage => ({
  id: message.id,
  role: message.role,
  parts: [{ type: 'text', text: message.text }],
});

export function useReviewChat(connection: { model: string; authenticated: boolean }) {
  const [state, setState] = useState(() => restoreReviewState(vscodeBridge.getState()));
  const session = state.sessions.find(({ id }) => id === state.activeSessionId)!;

  useEffect(() => {
    vscodeBridge.setState(state);
  }, [state]);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: '/v1/chat',
        fetch: bridgeFetch,
        prepareSendMessagesRequest: async ({ messages }) => {
          if (!connection.authenticated || !connection.model)
            throw new Error('请先 Continue with ChatGPT 并选择模型。');
          let sessionId = session.bridgeSessionId;
          if (sessionId) {
            // Host histories deliberately expire on restart. Never silently turn a
            // displayed old conversation into a context-free new Agent session.
            await bridgeJson(`/v1/sessions/${sessionId}`).catch(() => {
              throw new Error('Host 会话已结束，请新建会话。');
            });
          } else {
            const created = await bridgeJson<{ id: string }>('/v1/sessions', 'POST', {
              providerId: 'openai-agents',
              model: connection.model,
            });
            sessionId = created.id;
            setState((current) => ({
              ...current,
              sessions: current.sessions.map((item) =>
                item.id === session.id
                  ? { ...item, bridgeSessionId: created.id, model: connection.model }
                  : item,
              ),
            }));
          }
          return { body: { sessionId, messages: messages.slice(-1) } };
        },
      }),
    [connection.authenticated, connection.model, session.id, session.bridgeSessionId],
  );
  const chat = useChat({
    id: session.id,
    messages: session.messages.map(convertMessage),
    transport,
  });
  const runtime = useAISDKRuntime(chat);
  const lastMessages = useRef({ sessionId: session.id, messages: chat.messages });
  useEffect(() => {
    const previous = lastMessages.current;
    lastMessages.current = { sessionId: session.id, messages: chat.messages };
    if (previous.sessionId !== session.id || previous.messages === chat.messages) return;
    if (!chat.messages.length) return;
    const now = new Date().toISOString();
    const messages: ChatMessage[] = chat.messages.map((message) => ({
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
        item.id === session.id
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
  }, [chat.messages, session.id]);

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
      void chat.stop();
      setState((current) => ({ ...current, activeSessionId, activeTab: 'chat' }));
    },
    [chat.stop],
  );
  const newSession = useCallback(() => {
    void chat.stop();
    setState((current) => {
      const empty = current.sessions.find(
        ({ messages, draft, bridgeSessionId }) => !messages.length && !draft && !bridgeSessionId,
      );
      const next = empty ?? createSession();
      return {
        ...current,
        activeTab: 'chat',
        activeSessionId: next.id,
        sessions: empty ? current.sessions : [...current.sessions, next].slice(-20),
      };
    });
  }, [chat.stop]);

  return {
    ...state,
    session,
    runtime,
    error: chat.error?.message,
    isRunning: chat.status === 'submitted' || chat.status === 'streaming',
    setDraft,
    setTab,
    selectRepository,
    selectSession,
    newSession,
    exportMarkdown: () => sessionMarkdown(session),
  };
}
