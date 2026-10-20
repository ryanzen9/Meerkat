import { stepCountIs, streamText, tool, type ModelMessage } from 'ai';
import { z } from 'zod';
import { publicError } from '../errors';
import type { ModelProvider } from '../providers/types';
import type { BridgeSession } from '../sessions/store';
import type { ReasoningEffort } from '../../../shared/agentModels';
import type { InteractionMode } from '../../../shared/review';
import { safeModel } from './safeModel';

export type ModeConfidence = 'high' | 'medium' | 'low';
export interface ModeDecision {
  mode: InteractionMode;
  confidence?: ModeConfidence;
  reason?: string;
  latencyMs: number;
  /** Stable code when routing failed and the turn falls back to chat. */
  fallback?: string;
}

const decisionSchema = z
  .object({
    mode: z.enum(['chat', 'review']),
    confidence: z.enum(['high', 'medium', 'low']).optional(),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

// One tool and toolChoice: 'required' force the decision without naming the
// namespaced tool. The OpenAI Responses adapter cannot address tools that live
// inside a namespace by name, and ChatGPT plan requests require namespaced tools.
const routerTool = tool({
  description: 'Select how the latest user turn must be handled. Call exactly once.',
  inputSchema: decisionSchema,
  execute: async (input) => input,
});

const ROUTER_INSTRUCTIONS = [
  'You are the interaction router for a VS Code code-review agent. Decide how the Host should run the LATEST user turn. Never answer the user.',
  'Choose "review" only when the latest turn asks the agent to inspect, review, verify or find concrete problems in code changes (working tree, staged changes, a branch, commit, diff or pull request), or asks to continue an unfinished review.',
  'Choose "chat" for explanations, questions, summaries of changes, general discussion, account or model questions, and turns that merely mention code without asking for a change review.',
  'Rules: summarizing or explaining changes (content, impact, risks) is chat unless the user explicitly asks to verify or find issues. A follow-up about an already-saved finding (for example "why is this a P1?") is chat. If the turn is ambiguous or you are not confident, choose chat; the next turn can still start a review. Never infer review from workspace state alone.',
  'Examples: "审查当前工作区的改动，找出潜在问题" -> review, high. "帮我看看这次提交有没有问题" -> review, high. "继续审查剩下的文件" -> review, high. "检查边界情况与测试覆盖是否有遗漏" -> review, medium. "总结这次改动的内容、影响面与风险" -> chat, high. "这个函数是做什么的" -> chat, high. "为什么这条算 P1？" -> chat, high.',
  'Return exactly one select_interaction_mode tool call with mode, confidence and a reason of at most one sentence.',
].join('\n\n');

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

// Earlier user turns give the router the context needed for follow-ups such as
// "继续审查剩下的文件"; the current turn is not committed to history yet.
function routingPrompt(session: BridgeSession, text: string): string {
  const earlier = session.history
    .getMessages()
    .filter((message) => message.role === 'user')
    .map(messageText)
    .map((value) => value.replace(/\s+/g, ' ').trim().slice(0, 600))
    .filter((value) => value.length > 0)
    .slice(-6);
  return [
    ...(earlier.length
      ? [
          'Earlier user turns (oldest first, context only):',
          ...earlier.map((v, i) => `${i + 1}. ${v}`),
          '',
        ]
      : []),
    'Latest user turn:',
    '"""',
    text,
    '"""',
  ].join('\n');
}

/**
 * Lets the model decide whether this turn is ordinary chat or a code review.
 *
 * The caller's model and reasoning effort are used unchanged so routing cannot
 * deviate from the user's selection. Routing failures fall back to chat; an
 * aborted request rethrows so cancellation is never converted into extra work.
 */
export async function resolveInteractionMode(
  provider: ModelProvider,
  session: BridgeSession,
  text: string,
  reasoningEffort: ReasoningEffort | undefined,
  signal: AbortSignal,
): Promise<ModeDecision> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  try {
    const configuration = await provider.resolveModel(session.provider, signal, reasoningEffort);
    signal.throwIfAborted();
    // Namespace tools are the only form the ChatGPT plan endpoint accepts; the
    // provider adapter owns the exact provider options for that namespace.
    const definitions = { select_interaction_mode: routerTool };
    const tools = Object.fromEntries(
      Object.entries(definitions).map(([name, definition]) => [
        name,
        {
          ...definition,
          ...(configuration.toolProviderOptions
            ? { providerOptions: configuration.toolProviderOptions }
            : {}),
        },
      ]),
    ) as typeof definitions;
    const result = streamText({
      model: safeModel(configuration.model),
      ...(configuration.providerOptions ? { providerOptions: configuration.providerOptions } : {}),
      instructions: ROUTER_INSTRUCTIONS,
      prompt: routingPrompt(session, text),
      tools,
      toolChoice: 'required',
      stopWhen: stepCountIs(1),
      maxRetries: 0,
      abortSignal: signal,
      // A provider that ignores the forced tool choice must degrade quietly;
      // the SDK's default handler would print the whole violation to the Host log.
      onError: () => {},
    });
    // Reading toolCalls consumes the stream. The ChatGPT plan endpoint only
    // accepts streamed Responses requests, so generateText cannot be used here.
    const calls = await result.toolCalls;
    const decision = decisionSchema.safeParse(calls[0]?.input);
    if (!decision.success)
      return { mode: 'chat', latencyMs: elapsed(), fallback: 'invalid_decision' };
    const confidence = decision.data.confidence ?? 'medium';
    return {
      mode: decision.data.mode === 'review' && confidence !== 'low' ? 'review' : 'chat',
      confidence,
      ...(decision.data.reason ? { reason: decision.data.reason } : {}),
      latencyMs: elapsed(),
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return { mode: 'chat', latencyMs: elapsed(), fallback: publicError(error).code };
  }
}
