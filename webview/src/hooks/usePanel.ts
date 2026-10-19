import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { isExtensionMessage } from '@shared/protocol';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/protocol';
import { vscodeBridge } from '../services/vscode';
import { initialPanelState, panelReducer } from '../state/panelReducer';

type Request = Exclude<WebviewToExtensionMessage, { type: 'webview/ready' }>;
type RequestInput = Request extends infer T
  ? T extends Request
    ? Omit<T, 'requestId'>
    : never
  : never;
interface PendingRequest {
  resolve(message: ExtensionToWebviewMessage): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function usePanel() {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const [refreshing, setRefreshing] = useState(false);
  const pending = useRef(new Map<string, PendingRequest>());
  const refreshingRef = useRef(false);

  useEffect(() => {
    const handshakeTimeout = setTimeout(() => {
      dispatch({ type: 'host/error', message: '尚未连接到扩展，请点击刷新或重新加载面板。' });
    }, 15000);
    const onMessage = (event: MessageEvent<unknown>) => {
      // VS Code forwards messages from its wrapper iframe, not from this window.
      if (!isExtensionMessage(event.data)) return;
      const message = event.data;
      if ('requestId' in message && message.requestId) {
        const request = pending.current.get(message.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        pending.current.delete(message.requestId);
        if (message.type === 'host/error') request.reject(new Error(message.message));
        else request.resolve(message);
      }
      if (message.type === 'host/snapshot') clearTimeout(handshakeTimeout);
      dispatch(message);
    };
    window.addEventListener('message', onMessage);
    vscodeBridge.postMessage({ type: 'webview/ready' });
    const requests = pending.current;
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(handshakeTimeout);
      requests.forEach(({ timer, reject }) => {
        clearTimeout(timer);
        reject(new Error('面板已关闭。'));
      });
      requests.clear();
    };
  }, []);

  const request = useCallback(
    (message: RequestInput) =>
      new Promise<ExtensionToWebviewMessage>((resolve, reject) => {
        const requestId = crypto.randomUUID();
        // Git hooks can take minutes. Wait for the host result instead of enabling a retry
        // while a commit is still running; unmounting rejects all pending requests.
        const timer = message.type.startsWith('git/')
          ? undefined
          : setTimeout(() => {
              pending.current.delete(requestId);
              const error = new Error('请求超时，请重试。');
              dispatch({ type: 'host/error', message: error.message });
              reject(error);
            }, 15000);
        pending.current.set(requestId, { resolve, reject, timer });
        vscodeBridge.postMessage({ ...message, requestId });
      }),
    [],
  );

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await request({ type: 'workspace/refresh' });
    } catch {
      /* The host/timeout error is already displayed by the reducer. */
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [request]);

  const openFile = useCallback((uri: string) => request({ type: 'file/open', uri }), [request]);
  const openReference = useCallback(
    (sessionId: string | undefined, referenceId: string) => {
      if (!sessionId) {
        const message = '此会话的代码引用已失效，请重新生成引用。';
        dispatch({ type: 'host/error', message });
        return Promise.reject(new Error(message));
      }
      return request({ type: 'reference/open', sessionId, referenceId });
    },
    [request],
  );
  const openCode = useCallback(
    (code: string, language: string) => request({ type: 'code/open', code, language }),
    [request],
  );
  const copy = useCallback((text: string) => request({ type: 'clipboard/write', text }), [request]);
  const openSettings = useCallback(() => request({ type: 'settings/open' }), [request]);
  const stageFile = useCallback(
    async (repositoryUri: string, uri: string) => {
      await request({ type: 'git/stage', repositoryUri, uri });
    },
    [request],
  );
  const unstageFile = useCallback(
    async (repositoryUri: string, uri: string) => {
      await request({ type: 'git/unstage', repositoryUri, uri });
    },
    [request],
  );
  const commit = useCallback(
    async (repositoryUri: string, message: string) => {
      await request({ type: 'git/commit', repositoryUri, message });
    },
    [request],
  );
  const stageAll = useCallback(
    async (repositoryUri: string) => {
      await request({ type: 'git/stage-all', repositoryUri });
    },
    [request],
  );
  const unstageAll = useCallback(
    async (repositoryUri: string) => {
      await request({ type: 'git/unstage-all', repositoryUri });
    },
    [request],
  );
  const push = useCallback(
    async (repositoryUri: string, branch: string, head: string) => {
      await request({ type: 'git/push', repositoryUri, branch, head });
    },
    [request],
  );
  const undoCommit = useCallback(
    async (repositoryUri: string, branch: string, head: string) => {
      await request({ type: 'git/undo-commit', repositoryUri, branch, head });
    },
    [request],
  );

  return {
    ...state,
    refreshing,
    refresh,
    openFile,
    openReference,
    openCode,
    copy,
    openSettings,
    stageFile,
    unstageFile,
    commit,
    stageAll,
    unstageAll,
    push,
    undoCommit,
  };
}
