import { BridgeError } from '../errors';
import type { AgentProvider, AgentProviderFactory, ProviderInfo } from './types';

export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();
  register(factory: AgentProviderFactory): void {
    const provider = factory();
    if (this.providers.has(provider.info.id)) throw new Error('Duplicate provider ID');
    this.providers.set(provider.info.id, provider);
  }
  get(id: string): AgentProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new BridgeError('provider_not_found', 'Agent provider not found.', 404);
    return provider;
  }
  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => p.info);
  }
  async initialize(): Promise<void> {
    await Promise.all([...this.providers.values()].map((p) => p.initialize()));
  }
  async dispose(): Promise<void> {
    await Promise.all([...this.providers.values()].map((p) => p.dispose()));
  }
}
