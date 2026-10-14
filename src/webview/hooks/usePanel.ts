import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { isExtensionMessage } from '../../shared/protocol';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../shared/protocol';
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
  timer: ReturnType<typeof setTimeout>;
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
        const timer = setTimeout(() => {
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
  const openCode = useCallback(
    (code: string, language: string) => request({ type: 'code/open', code, language }),
    [request],
  );
  const copy = useCallback((text: string) => request({ type: 'clipboard/write', text }), [request]);
  const openSettings = useCallback(() => request({ type: 'settings/open' }), [request]);

  return { ...state, refreshing, refresh, openFile, openCode, copy, openSettings };
}
