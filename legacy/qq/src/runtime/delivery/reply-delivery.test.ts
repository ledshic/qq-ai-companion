import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyDelivery } from './reply-delivery.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

test('delivery serializes each group while other groups can send independently', async () => {
  const started = deferred<void>();
  const acknowledgement = deferred<boolean>();
  const sent: string[] = [];
  const deliver = createReplyDelivery(group => ({
    connected: () => true,
    send: async content => {
      sent.push(`${group}:${content}`);
      if (content === 'first') { started.resolve(); return acknowledgement.promise; }
      return true;
    },
  }));
  const first = deliver('a', 'first', () => true);
  await started.promise;
  const second = deliver('a', 'second', () => true);
  assert.equal(await deliver('b', 'independent', () => true), 'independent');
  assert.deepEqual(sent, ['a:first', 'b:independent']);
  acknowledgement.resolve(true);
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.deepEqual(sent, ['a:first', 'b:independent', 'a:second']);
});

test('queued drafts stay bound to the captured connection after reconnect', async () => {
  let connection = 1;
  const started = deferred<void>();
  const acknowledgement = deferred<boolean>();
  const sent: string[] = [];
  const deliver = createReplyDelivery(() => {
    const captured = connection;
    return {
      connected: () => connection === captured,
      send: async content => {
        sent.push(content);
        if (content === 'in flight') { started.resolve(); return acknowledgement.promise; }
        return true;
      },
    };
  });
  const active = deliver('a', 'in flight', () => true);
  await started.promise;
  const stale = deliver('a', 'old draft', () => true);
  connection++;
  acknowledgement.resolve(true);
  assert.equal(await active, 'in flight');
  assert.equal(await stale, undefined);
  assert.equal(await deliver('a', 'new draft', () => true), 'new draft');
  assert.deepEqual(sent, ['in flight', 'new draft']);
});
