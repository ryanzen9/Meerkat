export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof reasoningEfforts)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && reasoningEfforts.some((effort) => effort === value);
}

export interface SupportedReasoningEffort {
  reasoningEffort: ReasoningEffort;
  description: string;
}

export interface AgentModel {
  id: string;
  name: string;
  supportedReasoningEfforts: SupportedReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}
