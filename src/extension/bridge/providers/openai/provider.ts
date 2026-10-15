import { createOpenAI, type OpenAILanguageModelResponsesOptions } from '@ai-sdk/openai';
import type { ReasoningEffort } from '../../../../shared/agentModels';
import { CHATGPT_RESOURCE, ChatGPTAuth } from '../../auth/chatgpt';
import { BridgeError } from '../../errors';
import type { HttpFetch } from '../../http';
import type { ModelProvider, ModelConfiguration, ProviderSession } from '../types';
import { planFetch } from './compatibility';
import { parseModelCatalog } from './models';

export class OpenAIChatGPTProvider implements ModelProvider {
  readonly info = {
    id: 'openai-agents',
    name: 'OpenAI · ChatGPT',
    capabilities: {
      streaming: true,
      functionTools: true,
      sessions: true,
      cancellation: true,
    },
  };
  constructor(
    private readonly auth: ChatGPTAuth,
    private readonly http: HttpFetch = fetch,
  ) {}
  async initialize(): Promise<void> {
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
    return parseModelCatalog(await response.json());
  }
  async createSession(model: string, signal: AbortSignal): Promise<ProviderSession> {
    const account = await this.activeAccount();
    const models = await this.listModels(signal);
    const selected = models.find((m) => m.id === model);
    if (!selected)
      throw new BridgeError(
        'model_unavailable',
        'Model is unavailable to this ChatGPT account.',
        422,
      );
    return {
      model,
      accountId: account.id,
      supportedReasoningEfforts: selected.supportedReasoningEfforts,
      ...(selected.defaultReasoningEffort !== undefined
        ? { defaultReasoningEffort: selected.defaultReasoningEffort }
        : {}),
    };
  }

  async resolveModel(
    session: ProviderSession,
    signal: AbortSignal,
    reasoningEffort?: ReasoningEffort,
  ): Promise<ModelConfiguration> {
    const account = await this.auth.credential(session.accountId);
    signal.throwIfAborted();
    const effort = reasoningEffort ?? session.defaultReasoningEffort;
    if (
      effort !== undefined &&
      !session.supportedReasoningEfforts?.some((option) => option.reasoningEffort === effort)
    )
      throw new BridgeError(
        'reasoning_effort_unavailable',
        'The selected reasoning effort is unavailable for this model.',
        422,
      );
    const provider = createOpenAI({
      apiKey: account.tokens.accessToken,
      baseURL: CHATGPT_RESOURCE,
      // Bun test types add a static preconnect member; the SDK uses callable fetch.
      fetch: planFetch(this.http, () => this.auth.invalidate(account.id)) as typeof fetch,
    });
    return {
      model: provider.responses(session.model),
      providerOptions: {
        openai: {
          store: false,
          systemMessageMode: 'developer',
          include: ['reasoning.encrypted_content'],
          // Account catalogs may expose model aliases unknown to this SDK.
          ...(session.supportedReasoningEfforts?.length ? { forceReasoning: true } : {}),
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        } satisfies OpenAILanguageModelResponsesOptions,
      },
      toolProviderOptions: {
        openai: { namespace: { name: 'review', description: 'Local code review utilities.' } },
      },
    };
  }
  async dispose(): Promise<void> {}
}
