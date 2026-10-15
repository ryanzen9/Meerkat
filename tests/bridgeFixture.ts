import { ChatGPTAuth, CHATGPT_ISSUER } from '../src/extension/bridge/auth/chatgpt';
import type { Exclusive, SecretStore } from '../src/extension/bridge/auth/storage';

export function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) {
      return values.get(key);
    },
    async store(key, value) {
      values.set(key, value);
    },
  };
}
export function serial(): Exclusive {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
}
export function signedInAuth() {
  const secrets = memorySecrets();
  secrets.values.set(
    'reviewBot.bridge.chatgpt.v1',
    JSON.stringify({
      hostId: 'urn:uuid:fixture',
      activeId: 'account-1',
      registrations: [
        {
          id: 'account-1',
          clientId: 'oaiapp_fixture',
          subject: 'subject-1',
          issuer: CHATGPT_ISSUER,
          tokens: {
            accessToken: 'test-access-secret',
            refreshToken: 'test-refresh-secret',
            expiresAt: Date.now() + 3600000,
            scopes: ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
          },
        },
      ],
    }),
  );
  return new ChatGPTAuth({ secrets, exclusive: serial() });
}
export function responseEvents(text: string, output?: Record<string, unknown>[]) {
  const message = {
    id: 'msg_fixture',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'resp_fixture',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'fixture-model',
    output: output ?? [message],
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      total_tokens: 13,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
  ];
  if (!output)
    events.push(
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      {
        type: 'response.content_part.added',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: text,
      },
      {
        type: 'response.output_text.done',
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        text,
      },
      { type: 'response.output_item.done', output_index: 0, item: message },
    );
  else
    for (const [index, item] of output.entries())
      events.push(
        { type: 'response.output_item.added', output_index: index, item },
        { type: 'response.output_item.done', output_index: index, item },
      );
  events.push({ type: 'response.completed', response });
  return events;
}
export function sse(events: Record<string, unknown>[]) {
  return new Response(
    events
      .map((event, sequence_number) => `data: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
      .join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}
