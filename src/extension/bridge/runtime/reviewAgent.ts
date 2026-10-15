import { ToolLoopAgent, isStepCount, toUIMessageStream, type UIMessageChunk } from 'ai';
import { BridgeError, publicError } from '../errors';
import type { ModelProvider, ModelConfiguration } from '../providers/types';
import type { BridgeSession } from '../sessions/store';
import { reviewTools } from '../tools/reviewTools';
import type { ReasoningEffort } from '../../../shared/agentModels';
import type { ReviewAgent } from '../../../shared/chat';
import { safeModel } from './safeModel';

export function createReviewAgent({
  toolProviderOptions,
  ...configuration
}: ModelConfiguration): ReviewAgent {
  const definitions = reviewTools();
  const tools = Object.fromEntries(
    Object.entries(definitions).map(([name, tool]) => [
      name,
      { ...tool, ...(toolProviderOptions ? { providerOptions: toolProviderOptions } : {}) },
    ]),
  ) as typeof definitions;
  return new ToolLoopAgent({
    id: 'review-bot',
    ...configuration,
    model: safeModel(configuration.model),
    instructions: 'Help the user review code. Explain concrete findings.',
    tools,
    stopWhen: isStepCount(8),
    maxRetries: 0,
  });
}

// Every vendor uses this same agent, tool loop, history and UI stream converter.
// Providers only supply a LanguageModel and their own configuration options.
export async function streamReviewAgent(
  provider: ModelProvider,
  session: BridgeSession,
  text: string,
  signal: AbortSignal,
  reasoningEffort?: ReasoningEffort,
): Promise<ReadableStream<UIMessageChunk>> {
  const configuration = await provider.resolveModel(session.provider, signal, reasoningEffort);
  signal.throwIfAborted();
  const agent = createReviewAgent(configuration);
  const tools = agent.tools;
  const messages = [...session.history.getMessages(), { role: 'user' as const, content: text }];
  const result = await agent.stream({ messages, abortSignal: signal });
  let failure: unknown;
  let finish: UIMessageChunk | undefined;
  const source = toUIMessageStream({
    stream: result.stream,
    tools,
    onError(error) {
      failure = error;
      return publicError(error).message;
    },
  }).getReader();
  return new ReadableStream<UIMessageChunk>({
    async pull(output) {
      try {
        signal.throwIfAborted();
        let next = await source.read();
        while (!next.done && next.value.type === 'finish') {
          finish = next.value;
          next = await source.read();
        }
        if (next.done) {
          signal.throwIfAborted();
          if (failure) throw failure;
          const reason = await result.finishReason;
          if (reason !== 'stop')
            throw new BridgeError(
              'inference_incomplete',
              'Agent stopped before completing its answer.',
              502,
            );
          const responseMessages = await result.responseMessages;
          signal.throwIfAborted();
          session.history.commit([...messages, ...responseMessages]);
          if (finish) output.enqueue(finish);
          output.close();
        } else if (next.value.type === 'error') {
          throw (
            failure ??
            new BridgeError('inference_failed', 'Agent inference failed. Please retry.', 502)
          );
        } else {
          // Full provider metadata stays in Host ModelMessage history.
          const visible = { ...next.value };
          if ('providerMetadata' in visible) delete visible.providerMetadata;
          output.enqueue(visible);
        }
      } catch (error) {
        await source.cancel().catch(() => undefined);
        output.error(publicError(error));
      }
    },
    async cancel() {
      await source.cancel();
    },
  });
}
