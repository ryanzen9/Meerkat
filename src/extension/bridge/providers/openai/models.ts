import { z } from 'zod';
import { isRecord } from '../../../../shared/protocol';
import {
  isReasoningEffort,
  type AgentModel,
  type SupportedReasoningEffort,
} from '../../../../shared/agentModels';
import { BridgeError } from '../../errors';

const capabilities = {
  supportedReasoningEfforts: z.unknown().optional(),
  defaultReasoningEffort: z.unknown().optional(),
  supported_reasoning_levels: z.unknown().optional(),
  default_reasoning_level: z.unknown().optional(),
};

// ChatGPT plan OAuth and API-key requests use different /v1/models contracts.
const catalogSchema = z.union([
  z.object({
    models: z.array(
      z.object({
        slug: z.string().min(1).max(128),
        display_name: z.string(),
        visibility: z.string(),
        ...capabilities,
      }),
    ),
  }),
  z.object({
    data: z.array(
      z.object({
        id: z.string().min(1).max(128),
        displayName: z.string().optional(),
        display_name: z.string().optional(),
        hidden: z.boolean().optional(),
        ...capabilities,
      }),
    ),
  }),
]);

function normalizeEfforts(value: unknown): SupportedReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, SupportedReasoningEffort>();
  for (const option of value) {
    if (!isRecord(option)) continue;
    const effort = option.reasoningEffort ?? option.effort;
    // Future server values remain usable as plain models until this SDK can send them.
    if (!isReasoningEffort(effort)) continue;
    result.set(effort, {
      reasoningEffort: effort,
      // Also written to durable session metadata; keep it bounded.
      description: (typeof option.description === 'string' ? option.description : effort).slice(
        0,
        500,
      ),
    });
  }
  return [...result.values()];
}

export function parseModelCatalog(value: unknown): AgentModel[] {
  const parsed = catalogSchema.safeParse(value);
  if (!parsed.success)
    throw new BridgeError('models_invalid', 'Unexpected model catalog format.', 502);
  const models =
    'models' in parsed.data
      ? parsed.data.models.filter((model) => model.visibility === 'list')
      : parsed.data.data.filter((model) => !model.hidden);
  return models.map((model) => {
    const id = 'slug' in model ? model.slug : model.id;
    const name =
      'slug' in model ? model.display_name : (model.displayName ?? model.display_name ?? id);
    const supportedReasoningEfforts = normalizeEfforts(
      model.supportedReasoningEfforts ?? model.supported_reasoning_levels,
    );
    const defaultEffort = model.defaultReasoningEffort ?? model.default_reasoning_level;
    return {
      id,
      name,
      supportedReasoningEfforts,
      ...(isReasoningEffort(defaultEffort) &&
      supportedReasoningEfforts.some((option) => option.reasoningEffort === defaultEffort)
        ? { defaultReasoningEffort: defaultEffort }
        : {}),
    };
  });
}
