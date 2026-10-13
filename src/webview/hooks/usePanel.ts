import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { isExtensionMessage, isRecord } from '../../shared/protocol';
import type { WebviewToExtensionMessage } from '../../shared/protocol';
import { vscodeBridge } from '../services/vscode';
import { initialPanelState, panelReducer } from '../state/panelReducer';

export function usePanel() {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const [draftName, setDraftName] = useState(() => {
    const saved = vscodeBridge.getState();
    return isRecord(saved) && typeof saved.draftName === 'string'
      ? saved.draftName.slice(0, 80)
      : '';
  });
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    const handshakeTimeout = setTimeout(() => {
      dispatch({ type: 'host/error', message: '尚未连接到扩展，请点击刷新或重新加载面板。' });
    }, 15000);
    const onMessage = (event: MessageEvent<unknown>) => {
      // VS Code forwards messages from its wrapper iframe, not from this window.
      if (!isExtensionMessage(event.data)) return;
      const message = event.data;
      clearTimeout(handshakeTimeout);
      if ('requestId' in message && message.requestId) {
        if (message.requestId !== pending.current?.id) return;
        clearTimeout(pending.current.timer);
        pending.current = null;
        setBusy(false);
      }
      dispatch(message);
    };
    window.addEventListener('message', onMessage);
    vscodeBridge.postMessage({ type: 'webview/ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(handshakeTimeout);
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
    };
  }, []);

  useEffect(() => {
    vscodeBridge.setState({ draftName });
  }, [draftName]);

  const send = useCallback((message: WebviewToExtensionMessage & { requestId: string }) => {
    if (pending.current) return;
    setBusy(true);
    pending.current = {
      id: message.requestId,
      timer: setTimeout(() => {
        pending.current = null;
        setBusy(false);
        dispatch({ type: 'host/error', message: '请求超时，请刷新后重试。' });
      }, 15000),
    };
    vscodeBridge.postMessage(message);
  }, []);

  return {
    ...state,
    draftName,
    setDraftName,
    busy,
    refresh: () => send({ type: 'workspace/refresh', requestId: crypto.randomUUID() }),
    sayHello: () => send({ type: 'demo/hello', requestId: crypto.randomUUID(), name: draftName }),
  };
}
