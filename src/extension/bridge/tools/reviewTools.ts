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
      tool({
        name: 'difference_comparison',
        description: 'Compare differences between two versions of user-provided source text.',
        parameters: z.object({
          oldText: z.string().max(100000),
          newText: z.string().max(100000),
        }),
        execute: async ({ oldText, newText }, context) => {
          (context?.context as ReviewToolContext | undefined)?.signal.throwIfAborted();
          const oldLines = oldText.split('\n');
          const newLines = newText.split('\n');
          const maxLength = Math.max(oldLines.length, newLines.length);
          const differences = [];
          for (let i = 0; i < maxLength; i++) {
            if (oldLines[i] !== newLines[i]) {
              differences.push({
                line: i + 1,
                oldText: oldLines[i] ?? '',
                newText: newLines[i] ?? '',
              });
            }
          }
          return JSON.stringify({ differences });
        },
      }),
    ],
  });
}
