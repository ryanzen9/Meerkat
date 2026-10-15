import { tool } from "ai";
import { z } from "zod";

// A real, side-effect-free function tool. Providers can translate this tool set
// independently; no shell execution or arbitrary filesystem access is enabled.
export function reviewTools() {
  return {
    inspect_text: tool({
      description:
        "Count lines and locate TODO/FIXME markers in user-provided source text.",
      inputSchema: z.object({ text: z.string().max(100000) }),
      execute: async ({ text }, { abortSignal }) => {
        abortSignal?.throwIfAborted();
        const lines = text.split("\n");
        return JSON.stringify({
          lineCount: lines.length,
          markers: lines.flatMap((line, index) =>
            /\b(TODO|FIXME)\b/.test(line)
              ? [{ line: index + 1, text: line.trim() }]
              : [],
          ),
        });
      },
    }),
  };
}
