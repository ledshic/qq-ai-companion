import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceClient, serviceURL } from './service.js';
test('formal SDK rejects mock responses and insecure nonlocal service endpoints', async () => {
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
  ])
    assert.throws(() => serviceURL(url));
  assert.equal(
    serviceURL('https://agent.example.com'),
    'https://agent.example.com',
  );
  const client = createServiceClient('http://localhost', {
    request: async () =>
      Response.json({ apiVersion: 'v1', environment: 'phase-a' }),
  });
  await assert.rejects(client.status(), /compatible/);
});
test('safe GET retries once; message submission never silently retries', async () => {
  let requests = 0;
  const client = createServiceClient('http://localhost', {
    request: async () => {
      requests++;
      if (requests === 1) throw Error('connection reset');
      return Response.json({
        apiVersion: 'v1',
        environment: 'service',
        accepting: true,
        model: 'not-configured',
        qq: 'disabled',
      });
    },
  });
  assert.equal((await client.status()).qq, 'disabled');
  assert.equal(requests, 2);
  requests = 0;
  const unavailable = createServiceClient('http://localhost', {
    request: async () => {
      requests++;
      throw Error('connection reset');
    },
  });
  await assert.rejects(
    unavailable.submit('conversation', 'stable-message-id', 'question'),
  );
  assert.equal(requests, 1);
});
test('run and event payloads are checked before entering client state', async () => {
  const client = createServiceClient('http://localhost', {
    request: async () =>
      Response.json({
        state: 'invented',
        events: [{ eventId: 1, type: 'invented' }],
        nextCursor: 1,
      }),
  });
  await assert.rejects(client.run('run-id'), /Invalid run/);
  await assert.rejects(client.events(), /Invalid service event/);
});
