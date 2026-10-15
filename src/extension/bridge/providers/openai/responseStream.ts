import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { EventSourceMessage } from 'eventsource-parser';
import { isRecord } from '../../../../shared/protocol';
import { BridgeError } from '../../errors';

// ChatGPT plan usage can emit complete output_item.done events but leave the
// terminal response.output empty (observed with gpt-6.1-sol). The Agents SDK
// uses that terminal output to finish its loop and commit session history.
export function restoreCompletedOutput(response: Response): Response {
  // planFetch already requires stream:true. The Extension Host can omit the
  // Content-Type header even for an SSE response, so it cannot gate parsing.
  if (!response.ok || !response.body) return response;
  const completed = new Map<number, Record<string, unknown>>();
  const started = new Set<number>();
  const encoder = new TextEncoder();
  const stream = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize: 4 * 1024 * 1024 }))
    .pipeThrough(
      new TransformStream<EventSourceMessage, Uint8Array>({
        transform(message, output) {
          let data = message.data;
          let event: unknown;
          try {
            event = JSON.parse(data);
          } catch {
            /* Preserve [DONE] and invalid payloads for the SDK. */
          }
          if (isRecord(event)) {
            if (event.type === 'response.created') {
              completed.clear();
              started.clear();
            }
            if (
              event.type === 'response.output_item.added' &&
              Number.isSafeInteger(event.output_index) &&
              (event.output_index as number) >= 0
            )
              started.add(event.output_index as number);
            if (
              event.type === 'response.output_item.done' &&
              Number.isSafeInteger(event.output_index) &&
              (event.output_index as number) >= 0 &&
              isRecord(event.item)
            )
              completed.set(event.output_index as number, event.item);
            if (
              event.type === 'response.completed' &&
              isRecord(event.response) &&
              // The terminal event is authoritative, as in the Agents SDK.
              // Do not depend on a redundant status field to end the turn.
              event.response.status !== 'failed' &&
              event.response.status !== 'incomplete' &&
              !event.response.error &&
              Array.isArray(event.response.output)
            ) {
              if (!event.response.output.length) {
                if (!completed.size || [...started].some((index) => !completed.has(index)))
                  throw new BridgeError(
                    'inference_incomplete',
                    'OpenAI returned an incomplete response. Please retry.',
                    502,
                  );
                event.response = {
                  ...event.response,
                  // oxlint-disable-next-line unicorn/no-array-sort -- A fresh array preserves the Host's ES2022 API compatibility.
                  output: [...completed].sort(([a], [b]) => a - b).map(([, item]) => item),
                };
                data = JSON.stringify(event);
              }
              completed.clear();
              started.clear();
            }
          }
          const lines = [
            ...(message.event !== undefined ? [`event: ${message.event}`] : []),
            ...(message.id !== undefined ? [`id: ${message.id}`] : []),
            ...data.split(/\r\n|[\r\n]/).map((line) => `data: ${line}`),
            '',
            '',
          ];
          output.enqueue(encoder.encode(lines.join('\n')));
        },
      }),
    );
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
