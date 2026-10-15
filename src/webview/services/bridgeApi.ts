import { isRecord } from '../../shared/protocol';
import { bridgeFetch } from './bridgeFetch';

export class BridgeResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function bridgeJson<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await bridgeFetch(path, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (response.status === 204) return undefined as T;
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
    throw new BridgeResponseError(
      typeof error?.message === 'string' ? error.message : 'Bridge request failed',
      response.status,
      typeof error?.code === 'string' ? error.code : undefined,
    );
  }
  return value as T;
}
