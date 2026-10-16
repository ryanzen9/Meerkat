import type { ExtensionToWebviewMessage } from '../../../shared/protocol';
import { BridgeError, publicError } from '../errors';
import { BRIDGE_TRANSPORT_IDLE_TIMEOUT_MS, createIdleTimer } from '../../../shared/bridgeTiming';

interface ProxyRequest {
  requestId: string;
  path: string;
  method: string;
  body?: string;
}
interface Operation {
  controller: AbortController;
  acknowledge?: () => void;
}
export class WebviewBridgeProxy {
  private readonly operations = new Map<string, Operation>();
  constructor(
    private readonly request: (
      path: string,
      method: string,
      body: string | undefined,
      signal: AbortSignal,
    ) => Promise<Response>,
    private readonly post: (message: ExtensionToWebviewMessage) => Promise<void>,
    private readonly idleTimeoutMs = BRIDGE_TRANSPORT_IDLE_TIMEOUT_MS,
  ) {}
  ack(id: string): void {
    this.operations.get(id)?.acknowledge?.();
  }
  cancel(id: string): void {
    this.operations.get(id)?.controller.abort();
  }
  async send(input: ProxyRequest): Promise<void> {
    if (this.operations.has(input.requestId) || this.operations.size >= 8) return;
    const operation: Operation = { controller: new AbortController() };
    this.operations.set(input.requestId, operation);
    const signal = operation.controller.signal;
    const idle = createIdleTimer(
      () =>
        operation.controller.abort(
          new BridgeError(
            'bridge_idle_timeout',
            'Bridge transport received no response within the inactivity timeout.',
            408,
          ),
        ),
      this.idleTimeoutMs,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      operation.acknowledge?.();
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await this.request(input.path, input.method, input.body, signal);
      signal.throwIfAborted();
      idle.reset();
      await this.post({
        type: 'host/bridge-head',
        requestId: input.requestId,
        status: response.status,
        headers: {
          'content-type': response.headers.get('content-type') ?? 'application/json',
          'x-vercel-ai-ui-message-stream':
            response.headers.get('x-vercel-ai-ui-message-stream') ?? '',
        },
      });
      if (response.body) {
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          idle.reset();
          // Preserve UTF-8 boundaries, and apply backpressure through per-chunk ACKs.
          const decoded = decoder.decode(next.value, { stream: true });
          for (let offset = 0; offset < decoded.length;) {
            let end = Math.min(decoded.length, offset + 32768);
            if (end < decoded.length && /[\uD800-\uDBFF]/.test(decoded[end - 1]!)) end--;
            const acknowledged = new Promise<void>((resolve) => {
              operation.acknowledge = resolve;
            });
            await this.post({
              type: 'host/bridge-chunk',
              requestId: input.requestId,
              text: decoded.slice(offset, end),
            });
            await acknowledged;
            signal.throwIfAborted();
            idle.reset();
            offset = end;
          }
        }
        const tail = decoder.decode();
        if (tail)
          await this.post({ type: 'host/bridge-chunk', requestId: input.requestId, text: tail });
      }
      signal.throwIfAborted();
      await this.post({ type: 'host/bridge-end', requestId: input.requestId });
    } catch (error) {
      const failure = publicError(signal.aborted ? signal.reason : error);
      await this.post({
        type: 'host/bridge-error',
        requestId: input.requestId,
        message: `${failure.code}: ${failure.message}`,
      });
    } finally {
      idle.dispose();
      signal.removeEventListener('abort', cancel);
      await reader?.cancel().catch(() => undefined);
      this.operations.delete(input.requestId);
    }
  }
  dispose(): void {
    this.operations.forEach((operation) => operation.controller.abort());
  }
}
