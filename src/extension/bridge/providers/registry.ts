import { BridgeError } from '../errors';
import type { ModelProvider, ModelProviderFactory, ProviderInfo } from './types';

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  register(factory: ModelProviderFactory): void {
    const provider = factory();
    if (this.providers.has(provider.info.id)) throw new Error('Duplicate provider ID');
    this.providers.set(provider.info.id, provider);
  }
  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new BridgeError('provider_not_found', 'Model provider not found.', 404);
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
