import { wrapLanguageModel } from 'ai';
import { publicError } from '../errors';
import type { ModelConfiguration } from '../providers/types';

// Sanitize errors before AI SDK lifecycle callbacks or its default logger see
// them. Provider errors can include authorization headers and request bodies.
export function safeModel(model: ModelConfiguration['model']) {
  return wrapLanguageModel({
    model,
    middleware: {
      async wrapGenerate({ doGenerate }) {
        try {
          return await doGenerate();
        } catch (error) {
          throw publicError(error);
        }
      },
      async wrapStream({ doStream }) {
        try {
          const result = await doStream();
          const reader = result.stream.getReader();
          return {
            ...result,
            stream: new ReadableStream({
              async pull(output) {
                try {
                  const next = await reader.read();
                  if (next.done) output.close();
                  else
                    output.enqueue(
                      next.value.type === 'error'
                        ? { ...next.value, error: publicError(next.value.error) }
                        : next.value,
                    );
                } catch (error) {
                  output.error(publicError(error));
                }
              },
              cancel: () => reader.cancel(),
            }),
          };
        } catch (error) {
          throw publicError(error);
        }
      },
    },
  });
}
