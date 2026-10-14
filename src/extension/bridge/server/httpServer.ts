import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { BridgeError, publicError } from '../errors';

export interface BridgeConnection {
  baseUrl: string;
  authorization: string;
}
export interface HttpServerOptions {
  handle: (request: Request) => Promise<Response>;
  allowedOrigins?: string[];
}

function readBody(input: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const clean = () => {
      input.removeListener('data', data);
      input.removeListener('end', end);
      input.removeListener('error', failure);
      signal.removeEventListener('abort', abort);
    };
    const failure = (error: unknown) => {
      clean();
      input.resume();
      reject(error);
    };
    const abort = () =>
      failure(
        new BridgeError('request_timeout', 'Bridge request was interrupted or timed out.', 408),
      );
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024)
        failure(new BridgeError('body_too_large', 'Bridge request exceeds 1 MiB.', 413));
      else chunks.push(chunk);
    };
    const end = () => {
      clean();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    input.on('data', data);
    input.once('end', end);
    input.once('error', failure);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export class BridgeHttpServer {
  private readonly server: Server;
  private readonly capability = randomBytes(32).toString('base64url');
  private connection: BridgeConnection | undefined;
  private readonly origins: Set<string>;
  constructor(private readonly options: HttpServerOptions) {
    this.origins = new Set(options.allowedOrigins ?? []);
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 15000;
    this.server.maxConnections = 32;
  }
  async start(): Promise<BridgeConnection> {
    if (this.connection) return this.connection;
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid loopback listener');
    this.connection = {
      baseUrl: `http://127.0.0.1:${address.port}`,
      authorization: `Bearer ${this.capability}`,
    };
    return this.connection;
  }
  private async handle(input: IncomingMessage, output: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const closed = () => {
      if (!output.writableFinished) controller.abort();
    };
    input.once('aborted', closed);
    output.once('close', closed);
    output.setHeader('cache-control', 'no-store');
    output.setHeader('x-content-type-options', 'nosniff');
    output.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    output.setHeader('referrer-policy', 'no-referrer');
    try {
      const baseUrl = this.connection?.baseUrl;
      if (!baseUrl || input.headers.host !== new URL(baseUrl).host)
        throw new BridgeError('host_forbidden', 'Invalid Bridge host.', 403);
      if (
        !input.url ||
        input.url.length > 8192 ||
        !input.url.startsWith('/') ||
        input.url.startsWith('//')
      )
        throw new BridgeError('url_invalid', 'Invalid Bridge URL.');
      const origin = input.headers.origin;
      if (origin && !this.origins.has(origin))
        throw new BridgeError('origin_forbidden', 'Origin is not allowed.', 403);
      if (origin) {
        output.setHeader('access-control-allow-origin', origin);
        output.setHeader('vary', 'Origin');
        output.setHeader(
          'access-control-expose-headers',
          'x-bridge-run-id,x-vercel-ai-ui-message-stream',
        );
      }
      if (input.method === 'OPTIONS') {
        output.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
        output.setHeader('access-control-allow-headers', 'Authorization,Content-Type');
        output.writeHead(204).end();
        return;
      }
      const url = new URL(input.url, baseUrl);
      if (!(input.method === 'GET' && url.pathname === '/auth/callback')) {
        const provided = Buffer.from(input.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${this.capability}`);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
          throw new BridgeError('bridge_unauthorized', 'Bridge authorization is required.', 401);
      }
      if (Number(input.headers['content-length'] ?? 0) > 1024 * 1024) {
        input.resume();
        throw new BridgeError('body_too_large', 'Bridge request exceeds 1 MiB.', 413);
      }
      const timer = setTimeout(() => controller.abort(), 15000);
      let body: string;
      try {
        body = await readBody(input, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      const request = new Request(url, {
        method: input.method ?? 'GET',
        signal: controller.signal,
        headers: { 'content-type': input.headers['content-type'] ?? '' },
        ...(body.length > 0 ? { body } : {}),
      });
      const response = await this.options.handle(request);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      output.writeHead(response.status, headers);
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        controller.signal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            const next = await reader.read();
            if (next.done || controller.signal.aborted) break;
            if (!output.write(next.value))
              await once(output, 'drain', { signal: controller.signal });
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel);
          await reader.cancel().catch(() => undefined);
        }
      }
      output.end();
    } catch (error) {
      if (!output.headersSent && !output.destroyed) {
        const failure = publicError(error);
        output.writeHead(failure.status, { 'content-type': 'application/json' });
        output.end(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
      } else output.destroy();
    } finally {
      input.removeListener('aborted', closed);
      output.removeListener('close', closed);
    }
  }
  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) =>
        error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')
          ? reject(error)
          : resolve(),
      );
      this.server.closeAllConnections();
    });
    this.connection = undefined;
  }
}
