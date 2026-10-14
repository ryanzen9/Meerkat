import { useCallback, useEffect, useState } from 'react';
import { useExternalStoreRuntime } from '@assistant-ui/react';
import type { AppendMessage, ThreadMessageLike } from '@assistant-ui/react';
import type { ChatMessage, ReviewTab } from '../../shared/models';
import { vscodeBridge } from '../services/vscode';
import {
  appendTurn,
  createSession,
  restoreReviewState,
  sessionMarkdown,
} from '../state/reviewState';

const convertMessage = (message: ChatMessage): ThreadMessageLike => ({
  id: message.id,
  role: message.role,
  content: [{ type: 'text', text: message.text }],
  createdAt: new Date(message.createdAt),
});

export function useReviewChat() {
  const [state, setState] = useState(() => restoreReviewState(vscodeBridge.getState()));
  const session = state.sessions.find(({ id }) => id === state.activeSessionId)!;

  useEffect(() => {
    vscodeBridge.setState(state);
  }, [state]);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
      .slice(0, 4000);
    if (!text) return;
    // Layout-stage adapter: never present a canned response as an AI review.
    setState((current) =>
      appendTurn(
        current,
        text,
        'AI 模型尚未配置，暂时无法回答这个问题。问题已保存在此会话中。你可以先在 **Files** 查看工作区变更，接入模型后再进行代码审查。',
      ),
    );
  }, []);
  const runtime = useExternalStoreRuntime({
    messages: session.messages,
    convertMessage,
    onNew,
    isRunning: false,
  });

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
    (activeSessionId: string) =>
      setState((current) => ({ ...current, activeSessionId, activeTab: 'chat' })),
    [],
  );
  const newSession = useCallback(
    () =>
      setState((current) => {
        const empty = current.sessions.find(({ messages, draft }) => !messages.length && !draft);
        const next = empty ?? createSession();
        return {
          ...current,
          activeTab: 'chat',
          activeSessionId: next.id,
          sessions: empty ? current.sessions : [...current.sessions, next].slice(-20),
        };
      }),
    [],
  );

  return {
    ...state,
    session,
    runtime,
    setDraft,
    setTab,
    selectRepository,
    selectSession,
    newSession,
    exportMarkdown: () => sessionMarkdown(session),
  };
}
