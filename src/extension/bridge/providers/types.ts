import type { LanguageModel, Tool, ToolLoopAgentSettings } from 'ai';
import type {
  AgentModel,
  ReasoningEffort,
  SupportedReasoningEffort,
} from '../../../shared/agentModels';
export type { AgentModel } from '../../../shared/agentModels';
export interface AccountStatus {
  authenticated: boolean;
  activeAccountId?: string;
  signInPending?: boolean;
  signInError?: string;
  accounts: { id: string; email?: string; subject: string; signedIn: boolean }[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  capabilities: {
    streaming: boolean;
    functionTools: boolean;
    sessions: boolean;
    cancellation: boolean;
  };
}
export interface ProviderSession {
  accountId: string;
  model: string;
  supportedReasoningEfforts?: SupportedReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}
// Provider adapters supply models and vendor options. Agent execution, tools,
// history and the UI protocol are owned by the shared AI SDK runtime.
export interface ModelConfiguration extends Pick<
  ToolLoopAgentSettings,
  'model' | 'providerOptions'
> {
  model: Exclude<LanguageModel, string>;
  toolProviderOptions?: Tool['providerOptions'];
}
export interface ModelProvider {
  readonly info: ProviderInfo;
  initialize(): Promise<void>;
  authStatus(): Promise<AccountStatus>;
  login(callbackUri: string, accountId?: string): Promise<string>;
  callback(params: URLSearchParams): Promise<void>;
  logout(): Promise<{ remoteRevocationConfirmed: boolean }>;
  listModels(signal: AbortSignal): Promise<AgentModel[]>;
  createSession(model: string, signal: AbortSignal): Promise<ProviderSession>;
  resolveModel(
    session: ProviderSession,
    signal: AbortSignal,
    reasoningEffort?: ReasoningEffort,
  ): Promise<ModelConfiguration>;
  dispose(): Promise<void>;
}
export type ModelProviderFactory = () => ModelProvider;
