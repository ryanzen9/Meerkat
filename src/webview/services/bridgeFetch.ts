import { isExtensionMessage } from '../../shared/protocol';
import { vscodeBridge } from './vscode';

// AI SDK receives a standard Fetch Response; only the Host can reach the
// loopback service. OAuth credentials and the local capability never cross IPC.
export const bridgeFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const path =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.pathname
        : new URL(input.url).pathname;
  const method = init?.method ?? 'GET';
  if (!/^\/v1\/[\w/-]{1,256}$/.test(path) || !['GET', 'POST', 'DELETE'].includes(method))
    throw new Error('Invalid Bridge request');
  if (init?.body !== undefined && typeof init.body !== 'string')
    throw new Error('Bridge requires a JSON body');
  const requestId = crypto.randomUUID();
  const signal = init?.signal;
  signal?.throwIfAborted();
  return new Promise<Response>((resolve, reject) => {
    let output: ReadableStreamDefaultController<Uint8Array>;
    let buffered: string | undefined;
    let headed = false;
    let ended = false;
    const encoder = new TextEncoder();
    const timer = setTimeout(() => fail(new Error('Bridge request timed out')), 150000);
    const clean = () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      signal?.removeEventListener('abort', abort);
    };
    const ack = () => vscodeBridge.postMessage({ type: 'bridge/ack', requestId });
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      clean();
      vscodeBridge.postMessage({ type: 'bridge/cancel', requestId });
      if (headed) output.error(error);
      else reject(error);
    };
    const abort = () => fail(new DOMException('Bridge request cancelled', 'AbortError'));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      pull() {
        if (buffered !== undefined) {
          output.enqueue(encoder.encode(buffered));
          buffered = undefined;
          ack();
        }
      },
      cancel() {
        ended = true;
        clean();
        vscodeBridge.postMessage({ type: 'bridge/cancel', requestId });
      },
    });
    const receive = (event: MessageEvent<unknown>) => {
      if (
        !isExtensionMessage(event.data) ||
        !('requestId' in event.data) ||
        event.data.requestId !== requestId ||
        ended
      )
        return;
      const message = event.data;
      switch (message.type) {
        case 'host/bridge-head':
          if (headed) return;
          headed = true;
          resolve(
            new Response(message.status === 204 ? null : stream, {
              status: message.status,
              headers: message.headers,
            }),
          );
          break;
        case 'host/bridge-chunk':
          if (!headed) return;
          if ((output.desiredSize ?? 0) > 0) {
            output.enqueue(encoder.encode(message.text));
            ack();
          } else buffered = message.text;
          break;
        case 'host/bridge-end':
          ended = true;
          clean();
          output.close();
          break;
        case 'host/bridge-error':
          fail(new Error(message.message));
          break;
      }
    };
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    vscodeBridge.postMessage({
      type: 'bridge/request',
      requestId,
      path,
      method: method as 'GET' | 'POST' | 'DELETE',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
  });
};
