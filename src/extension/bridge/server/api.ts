import { createUIMessageStreamResponse } from 'ai';
import { z } from 'zod';
import { BridgeError, publicError } from '../errors';
import type { BridgeRuntime } from '../runtime/bridgeRuntime';
import { sessionInfo } from '../sessions/store';
import { reasoningEfforts } from '../../../shared/agentModels';

const idSchema = z.string().min(1).max(128);
const createSchema = z.object({ providerId: idSchema, model: idSchema }).strict();
const loginSchema = z.object({ accountId: idSchema.optional() }).strict();
const textSchema = z
  .object({
    text: z.string().trim().min(1).max(100000),
    reasoningEffort: z.enum(reasoningEfforts).optional(),
    mode: z.enum(['chat', 'review']).optional(),
  })
  .strict();
const chatSchema = z
  .object({
    sessionId: idSchema,
    mode: z.enum(['chat', 'review']).optional(),
    reasoningEffort: z.enum(reasoningEfforts).optional(),
    messages: z
      .array(
        z
          .object({
            id: idSchema,
            role: z.enum(['user', 'assistant', 'system']),
            parts: z.array(z.unknown()).max(200),
          })
          .passthrough(),
      )
      .min(1)
      .max(200),
  })
  .passthrough();

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new BridgeError('content_type_invalid', 'Expected application/json.', 415);
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new BridgeError('json_invalid', 'Invalid JSON request.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new BridgeError('request_invalid', 'Invalid Bridge request.');
  return result.data;
}
export interface BridgeApiOptions {
  runtime: BridgeRuntime;
  callbackUri: () => string;
  openBrowser: (url: string) => Promise<void>;
  log?: (code: string, status: number) => void;
}
export function createBridgeApi(options: BridgeApiOptions) {
  const { runtime } = options;
  let callbackProvider: string | undefined;
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (method === 'GET' && path === '/auth/callback') {
        if (!callbackProvider) throw new BridgeError('oauth_not_pending', 'No sign-in is pending.');
        const providerId = callbackProvider;
        await runtime.registry.get(providerId).callback(url.searchParams);
        callbackProvider = undefined;
        await runtime.cancelProvider(providerId);
        return new Response('ChatGPT sign-in completed. You may close this tab.', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'referrer-policy': 'no-referrer',
          },
        });
      }
      if (method === 'GET' && path === '/v1/providers')
        return Response.json(runtime.registry.list());
      const providerMatch = path.match(/^\/v1\/providers\/([\w-]+)\/(auth|models|login|logout)$/);
      if (providerMatch) {
        const providerId = providerMatch[1]!;
        const provider = runtime.registry.get(providerId);
        const action = providerMatch[2];
        if (method === 'GET' && action === 'auth')
          return Response.json(await provider.authStatus());
        if (method === 'GET' && action === 'models')
          return Response.json(await provider.listModels(request.signal));
        if (method === 'POST' && action === 'login') {
          const { accountId } = await body(request, loginSchema);
          const authUrl = await provider.login(options.callbackUri(), accountId);
          callbackProvider = providerId;
          await options.openBrowser(authUrl); // URL may contain an id_token_hint; never send it to the webview.
          return Response.json({ started: true });
        }
        if (method === 'POST' && action === 'logout') {
          await runtime.cancelProvider(providerId);
          return Response.json(await provider.logout());
        }
      }
      if (path === '/v1/sessions') {
        if (method === 'GET') return Response.json(runtime.sessions.list().map(sessionInfo));
        if (method === 'POST') {
          const { providerId, model } = await body(request, createSchema);
          const session = await runtime.registry
            .get(providerId)
            .createSession(model, request.signal);
          return Response.json(sessionInfo(runtime.sessions.create(providerId, session)), {
            status: 201,
          });
        }
      }
      const sessionMatch = path.match(/^\/v1\/sessions\/([\w-]+)(\/messages|\/reviews)?$/);
      if (sessionMatch) {
        const id = sessionMatch[1]!;
        if (sessionMatch[2] === '/reviews' && method === 'GET')
          return Response.json(runtime.sessions.get(id).reviews.snapshot());
        if (!sessionMatch[2] && method === 'GET')
          return Response.json(sessionInfo(runtime.sessions.get(id)));
        if (!sessionMatch[2] && method === 'DELETE') {
          await runtime.deleteSession(id);
          return new Response(null, { status: 204 });
        }
        if (sessionMatch[2] === '/messages' && method === 'POST') {
          const { text, reasoningEffort, mode } = await body(request, textSchema);
          const run = runtime.start(id, text, request.signal, reasoningEffort, mode);
          return createUIMessageStreamResponse({
            stream: run.stream,
            headers: { 'x-bridge-run-id': run.runId },
          });
        }
      }
      if (path === '/v1/chat' && method === 'POST') {
        const data = await body(request, chatSchema);
        const last = data.messages.at(-1)!;
        if (last.role !== 'user')
          throw new BridgeError('turn_invalid', 'Only a new user turn is accepted.');
        const parts = z
          .array(z.object({ type: z.literal('text'), text: z.string() }).passthrough())
          .min(1)
          .safeParse(last.parts);
        if (!parts.success)
          throw new BridgeError(
            'input_unsupported',
            'This version accepts text user turns only.',
            422,
          );
        const turn = textSchema.safeParse({ text: parts.data.map((p) => p.text).join('\n') });
        if (!turn.success)
          throw new BridgeError('turn_invalid', 'User turn is empty or exceeds the text limit.');
        const text = turn.data.text;
        // Existing history and tool calls belong to the provider session. Do not
        // resend the client transcript or execute client-supplied tools/instructions.
        const run = runtime.start(
          data.sessionId,
          text,
          request.signal,
          data.reasoningEffort,
          data.mode,
        );
        return createUIMessageStreamResponse({
          stream: run.stream,
          headers: { 'x-bridge-run-id': run.runId },
        });
      }
      const runMatch = path.match(/^\/v1\/runs\/([\w-]+)(\/cancel)?$/);
      if (runMatch) {
        const id = runMatch[1]!;
        if (!runMatch[2] && method === 'GET') return Response.json(runtime.status(id));
        if (runMatch[2] && method === 'POST') {
          runtime.cancel(id);
          return Response.json({ cancelled: true });
        }
      }
      throw new BridgeError('route_not_found', 'Bridge route not found.', 404);
    } catch (error) {
      const failure = publicError(error);
      options.log?.(failure.code, failure.status);
      return Response.json(
        { error: { code: failure.code, message: failure.message } },
        { status: failure.status },
      );
    }
  };
}
