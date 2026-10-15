import type { UIMessageChunk } from 'ai';
export interface AccountStatus {
  authenticated: boolean;
  activeAccountId?: string;
  signInPending?: boolean;
  signInError?: string;
  accounts: { id: string; email?: string; subject: string; signedIn: boolean }[];
}

export interface AgentModel {
  id: string;
  name: string;
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
  state: unknown;
}
export interface AgentProvider {
  readonly info: ProviderInfo;
  initialize(): Promise<void>;
  authStatus(): Promise<AccountStatus>;
  login(callbackUri: string, accountId?: string): Promise<string>;
  callback(params: URLSearchParams): Promise<void>;
  logout(): Promise<{ remoteRevocationConfirmed: boolean }>;
  listModels(signal: AbortSignal): Promise<AgentModel[]>;
  createSession(model: string, signal: AbortSignal): Promise<ProviderSession>;
  run(
    session: ProviderSession,
    text: string,
    signal: AbortSignal,
  ): Promise<ReadableStream<UIMessageChunk>>;
  deleteSession(session: ProviderSession): Promise<void>;
  dispose(): Promise<void>;
}
export type AgentProviderFactory = () => AgentProvider;
