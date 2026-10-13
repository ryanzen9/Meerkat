import { expect, test } from 'bun:test';
import type { Memento } from 'vscode';
import { StateService } from '../src/extension/services/StateService';

function storage(initial: unknown = 0, failFirstWrite = false): Memento {
  let value = initial;
  let shouldFail = failFirstWrite;
  return {
    keys: () => ['reviewBot.messageCount'],
    get: (_key: string, fallback?: unknown) => value ?? fallback,
    update: async (_key: string, next: unknown) => {
      await Bun.sleep(1);
      if (shouldFail) {
        shouldFail = false;
        throw new Error('Storage unavailable');
      }
      value = next;
    },
  } as Memento;
}

test('concurrent requests do not lose persisted increments', async () => {
  const memento = storage();
  const service = new StateService(memento);
  const replies = await Promise.all(
    Array.from({ length: 10 }, () => service.incrementMessageCount()),
  );
  expect(replies.map((state) => state.messageCount)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new StateService(memento).read().messageCount).toBe(10);
});

test('a failed storage write does not poison subsequent requests', async () => {
  const service = new StateService(storage(0, true));
  await expect(service.incrementMessageCount()).rejects.toThrow('Storage unavailable');
  expect((await service.incrementMessageCount()).messageCount).toBe(1);
});

test('invalid persisted data is recovered safely', () => {
  for (const invalid of [-1, NaN, Infinity, '5', {}])
    expect(new StateService(storage(invalid)).read().messageCount).toBe(0);
});
