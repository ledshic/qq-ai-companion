import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from './index.js';
test('client preserves cancellation and refuses failed HTTP responses', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | null | undefined;
  const client = createMockClient(
    'http://127.0.0.1:4317',
    async (_url, options) => {
      receivedSignal = options?.signal;
      assert.equal(options?.credentials, 'omit');
      assert.equal(options?.redirect, 'error');
      return new Response('{}', { status: 503 });
    },
  );
  await assert.rejects(client.status(controller.signal), /HTTP 503/);
  assert.equal(receivedSignal, controller.signal);
});
