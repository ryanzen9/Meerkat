import { randomUUID } from 'node:crypto';
import {
  Agent,
  OpenAIProvider,
  Runner,
  setSensitiveDataLoggingEnabled,
  type RunStreamEvent,
} from '@openai/agents';
import { createAiSdkUiMessageStream } from '@openai/agents-extensions/ai-sdk-ui';
import OpenAI from 'openai';
import { z } from 'zod';
import { ChatGPTAuth, CHATGPT_RESOURCE } from '../../auth/chatgpt';
import { BridgeError } from '../../errors';
import { LocalAgentSession } from '../../sessions/localAgentSession';
import { reviewTools } from '../../tools/reviewTools';
import type { AgentProvider, ProviderSession } from '../types';
import { planFetch } from './compatibility';
import type { HttpFetch } from '../../http';
import { isRecord } from '../../../../shared/protocol';

const modelsSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string(),
      visibility: z.string(),
    }),
  ),
});

export class OpenAIAgentsProvider implements AgentProvider {
  readonly info = {
    id: 'openai-agents',
    name: 'OpenAI Agents · ChatGPT',
    capabilities: { streaming: true, functionTools: true, sessions: true, cancellation: true },
  };
  constructor(
    private readonly auth: ChatGPTAuth,
    private readonly http: HttpFetch = fetch,
  ) {}
  async initialize(): Promise<void> {
    setSensitiveDataLoggingEnabled(false);
    await this.auth.status();
  }
  authStatus() {
    return this.auth.status();
  }
  login(callbackUri: string, accountId?: string) {
    return this.auth.login(callbackUri, accountId);
  }
  callback(params: URLSearchParams) {
    return this.auth.callback(params);
  }
  logout() {
    return this.auth.logout();
  }

  private async activeAccount() {
    const status = await this.auth.status();
    if (!status.activeAccountId)
      throw new BridgeError('sign_in_required', 'Continue with ChatGPT first.', 401);
    return this.auth.credential(status.activeAccountId);
  }
  async listModels(signal: AbortSignal) {
    const account = await this.activeAccount();
    const response = await this.http(`${CHATGPT_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${account.tokens.accessToken}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      redirect: 'error',
    });
    if (response.status === 401) {
      await this.auth.invalidate(account.id);
      throw new BridgeError(
        'sign_in_required',
        'ChatGPT authorization is invalid. Sign in again.',
        401,
      );
    }
    if (!response.ok)
      throw new BridgeError('models_unavailable', 'ChatGPT model catalog is unavailable.', 502);
    const data = modelsSchema.safeParse(await response.json());
    if (!data.success)
      throw new BridgeError('models_invalid', 'Unexpected ChatGPT model catalog format.', 502);
    return data.data.models
      .filter((m) => m.visibility === 'list')
      .map((m) => ({ id: m.slug, name: m.display_name }));
  }
  async createSession(model: string, signal: AbortSignal): Promise<ProviderSession> {
    const account = await this.activeAccount();
    const models = await this.listModels(signal);
    if (!models.some((m) => m.id === model))
      throw new BridgeError(
        'model_unavailable',
        'Model is unavailable to this ChatGPT account.',
        422,
      );
    return { model, accountId: account.id, state: new LocalAgentSession(randomUUID()) };
  }

  async run(session: ProviderSession, text: string, signal: AbortSignal) {
    if (!(session.state instanceof LocalAgentSession)) throw new Error('Invalid OpenAI session');
    const account = await this.auth.credential(session.accountId);
    signal.throwIfAborted();
    const original = session.state;
    const staged = await original.fork();
    const client = new OpenAI({
      apiKey: account.tokens.accessToken,
      baseURL: CHATGPT_RESOURCE,
      maxRetries: 0,
      timeout: 120000,
      logLevel: 'off',
      fetch: planFetch(this.http, () => this.auth.invalidate(account.id)),
    });
    const provider = new OpenAIProvider({ openAIClient: client, useResponses: true });
    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    });
    const agent = new Agent({
      name: 'Review Bot',
      model: session.model,
      instructions:
        'Help the user review code. Explain concrete findings. You can inspect only source text supplied by the user. Never claim to have read workspace files.',
      tools: reviewTools(),
      modelSettings: { store: false, providerData: { include: ['reasoning.encrypted_content'] } },
    });
    const result = await runner.run(agent, text, {
      stream: true,
      session: staged,
      signal,
      maxTurns: 8,
      context: { signal },
    });
    // Observe rejection immediately, even if the HTTP consumer disconnects.
    void result.completed.catch(() => undefined);
    async function* checkedEvents(): AsyncIterable<RunStreamEvent> {
      let started = 0;
      let completed = 0;
      try {
        for await (const event of result) {
          signal.throwIfAborted();
          if (event.type === 'raw_model_stream_event') {
            if (event.data.type === 'response_started') started++;
            if (event.data.type === 'response_done') completed++;
            if (event.data.type === 'model' && isRecord(event.data.event)) {
              const raw = event.data.event;
              const response = isRecord(raw.response) ? raw.response : undefined;
              const error = response && isRecord(response.error) ? response.error : undefined;
              if (error?.code === 'subscription_sharing_usage_limit_exceeded')
                throw new BridgeError(
                  'chatgpt_usage_limit',
                  'ChatGPT plan usage limit reached. Retry after your allowance resets.',
                  429,
                );
              if (error?.code === 'subscription_sharing_usage_unavailable')
                throw new BridgeError(
                  'chatgpt_usage_unavailable',
                  'ChatGPT plan usage is unavailable for this account or workspace.',
                  403,
                );
            }
          }
          yield event;
        }
        await result.completed;
        signal.throwIfAborted();
        if (!started || completed !== started)
          throw new BridgeError(
            'inference_incomplete',
            'Inference stream ended before response.completed.',
            502,
          );
        await original.commit(staged);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (error instanceof OpenAI.APIError && error.status === 401)
          throw new BridgeError(
            'sign_in_required',
            'ChatGPT authorization is invalid. Sign in again.',
            401,
          );
        if (error instanceof OpenAI.APIError && error.status === 429)
          throw new BridgeError(
            'provider_rate_limited',
            'OpenAI rate limit reached. Please retry later.',
            429,
          );
        throw new BridgeError(
          'inference_failed',
          'OpenAI inference failed or ended incompletely. Please retry.',
          502,
        );
      } finally {
        await provider.close();
      }
    }
    return createAiSdkUiMessageStream(checkedEvents());
  }
  async deleteSession(session: ProviderSession): Promise<void> {
    if (session.state instanceof LocalAgentSession) await session.state.clearSession();
  }
  async dispose(): Promise<void> {}
}
