import { BridgeError } from '../../errors';
import { isRecord } from '../../../../shared/protocol';
import type { HttpFetch } from '../../http';
import { restoreCompletedOutput } from './responseStream';

export const unsupportedFields = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
  'previous_response_id',
];

export function validatePlanRequest(body: unknown): void {
  if (!isRecord(body) || body.store !== false || body.stream !== true || !Array.isArray(body.input))
    throw new BridgeError(
      'plan_request_invalid',
      'ChatGPT requires streamed, stateless Responses requests.',
      422,
    );
  if (unsupportedFields.some((key) => body[key] !== undefined && body[key] !== null))
    throw new BridgeError(
      'plan_parameter_unsupported',
      'Request contains a parameter unsupported by ChatGPT plan usage.',
      422,
    );
  if (body.input.some((item: unknown) => isRecord(item) && item.role === 'system'))
    throw new BridgeError(
      'plan_input_unsupported',
      'ChatGPT requires developer messages or instructions.',
      422,
    );
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some((item: unknown) => {
        if (!isRecord(item) || item.type !== 'namespace' || !Array.isArray(item.tools)) return true;
        return item.tools.some(
          (tool: unknown) =>
            !isRecord(tool) ||
            !['function', 'custom'].includes(String(tool.type)) ||
            tool.defer_loading === true,
        );
      }))
  )
    throw new BridgeError(
      'plan_tool_unsupported',
      'Only namespaced local function/custom tools are enabled.',
      422,
    );
}

// Verify the *serialized SDK request*, so SDK upgrades cannot silently violate
// the preview contract. Do not silently drop user-requested unsupported options.
export function planFetch(http: HttpFetch, unauthorized: () => Promise<void>): HttpFetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== 'https://api.openai.com' || url.pathname !== '/v1/responses')
      throw new BridgeError(
        'provider_endpoint_invalid',
        'Only the public Responses API is allowed.',
        422,
      );
    if (typeof init?.body !== 'string')
      throw new BridgeError('plan_request_invalid', 'Missing Responses request.', 422);
    validatePlanRequest(JSON.parse(init.body));
    const response = await http(input, { ...init, redirect: 'error' });
    if (response.status === 401) await unauthorized();
    return restoreCompletedOutput(response);
  };
}
