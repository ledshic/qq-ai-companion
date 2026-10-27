import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createMockAPI } from './server.js';
import {
  createMockClient,
  normalizeMockURL,
} from '../../../packages/client/src/index.js';
test('mock API roundtrip, validation, origins and idempotency', async () => {
  const server = createMockAPI();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const client = createMockClient(base);
    assert.equal((await client.status()).runtime, 'mock');
    const input = {
      clientId: 'test',
      requestId: 'first',
      client: {
        platform: 'browser',
        architecture: 'web',
        version: '0.1',
        environment: 'web' as const,
      },
      message: '中文往返',
    };
    const first = await client.probe(input);
    assert.match(first.reply, /中文往返/);
    assert.equal((await client.probe(input)).probeId, first.probeId);
    const post = (body: unknown) =>
      fetch(base + '/api/v1/probes', {
        method: 'POST',
        headers: {
          'X-Companion-Phase': 'A',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post({
          ...input,
          client: {
            environment: 'web',
            version: '0.1',
            architecture: 'web',
            platform: 'browser',
          },
        })
      ).status,
      200,
    );
    assert.equal((await post({ ...input, message: 'changed' })).status, 409);
    assert.equal((await post({ ...input, message: ' ' })).status, 400);
    assert.equal((await post({ ...input, secret: 'unexpected' })).status, 400);
    assert.equal(
      (await post({ ...input, message: 'x'.repeat(5000) })).status,
      400,
    );
    assert.equal((await fetch(base + '/api/v1/status')).status, 403);
    assert.equal(
      (
        await fetch(base + '/api/v1/status', {
          headers: {
            Origin: 'https://untrusted.example',
            'X-Companion-Phase': 'A',
          },
        })
      ).status,
      403,
    );
    const preflight = await fetch(base + '/api/v1/status', {
      method: 'OPTIONS',
      headers: { Origin: 'tauri://localhost' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      'tauri://localhost',
    );
    assert.equal(
      (
        await fetch(base + '/missing', {
          headers: { 'X-Companion-Phase': 'A' },
        })
      ).status,
      404,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('mock client rejects external endpoints and real service responses', async () => {
  for (const url of [
    'https://localhost',
    'http://example.com',
    'http://user:pass@localhost',
    'http://localhost/api',
    'http://localhost?token=x',
  ])
    assert.throws(() => normalizeMockURL(url));
  await assert.rejects(
    createMockClient(
      'http://localhost',
      async () => new Response(JSON.stringify({ runtime: 'real' })),
    ).status(),
  );
});
