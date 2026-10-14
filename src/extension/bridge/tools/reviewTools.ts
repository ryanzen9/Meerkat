import { tool, toolNamespace } from '@openai/agents';
import { z } from 'zod';

export interface ReviewToolContext {
  signal: AbortSignal;
}

// A real, side-effect-free function tool. Providers can translate this tool set
// independently; no shell execution or arbitrary filesystem access is enabled.
export function reviewTools() {
  return toolNamespace({
    name: 'review',
    description: 'Local code review utilities.',
    tools: [
      tool({
        name: 'inspect_text',
        description: 'Count lines and locate TODO/FIXME markers in user-provided source text.',
        parameters: z.object({ text: z.string().max(100000) }),
        execute: async ({ text }, context) => {
          (context?.context as ReviewToolContext | undefined)?.signal.throwIfAborted();
          const lines = text.split('\n');
          return JSON.stringify({
            lineCount: lines.length,
            markers: lines.flatMap((line, index) =>
              /\b(TODO|FIXME)\b/.test(line) ? [{ line: index + 1, text: line.trim() }] : [],
            ),
          });
        },
      }),
    ],
  });
}
