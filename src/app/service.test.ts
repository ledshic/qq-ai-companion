import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from './service.js';
import { createServiceClient } from '../../packages/client/src/service.js';
import { WebSocketServer } from 'ws';
const port = async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
};
test('real host survives QQ disconnect, client absence and restart; only one host owns data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-host-'));
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(ws, 'listening');
  const qqPort = ws.address();
  assert(qqPort && typeof qqPort !== 'string');
  ws.on('connection', (socket) => {
    socket.on('error', () => {});
    socket.close();
  });
  const env = {
    MEMORY_DB: join(root, 'memory.db'),
    LLM_ENABLED: 'false',
    AGENT_PORT: String(await port()),
    NAPCAT_WS_URL: `ws://127.0.0.1:${qqPort.port}`,
  };
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    service = await startService(env, {
      generate: async (text) => 'real host fixture:' + text,
    });
    const credential = JSON.parse(
      readFileSync(service.credentialPath, 'utf8'),
    ) as { token: string };
    const client = createServiceClient(`http://127.0.0.1:${env.AGENT_PORT}`, {
      token: credential.token,
    });
    const c = await client.createConversation('Independent');
    const accepted = await client.submit(c.id, 'first', 'host lives');
    for (
      let i = 0;
      i < 100 && (await client.run(accepted.runId)).state !== 'completed';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      (await client.run(accepted.runId)).result,
      'real host fixture:host lives',
    );
    assert.equal((await client.status()).qq, 'disconnected');
    await assert.rejects(
      startService({ ...env, AGENT_PORT: String(await port()) }),
      /already active/,
    );
    await service.close();
    service = undefined;
    assert.equal(existsSync(join(root, 'bot.lock')), false);
    service = await startService(
      { ...env, NAPCAT_WS_URL: undefined },
      {
        generate: async () => {
          throw Error('duplicate must not run');
        },
      },
    );
    assert.equal((await client.status()).qq, 'disabled');
    assert.equal(
      (await client.submit(c.id, 'first', 'host lives')).runId,
      accepted.runId,
    );
    assert.equal((await client.run(accepted.runId)).state, 'completed');
  } finally {
    await service?.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
test('failed startup releases resources and credentials never appear in API errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-host-failure-'));
  const occupied = createServer().listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const address = occupied.address();
  assert(address && typeof address !== 'string');
  const env = {
    MEMORY_DB: join(root, 'memory.db'),
    LLM_ENABLED: 'false',
    AGENT_PORT: String(address.port),
  };
  try {
    await assert.rejects(startService(env));
    assert.equal(existsSync(join(root, 'bot.lock')), false);
    const service = await startService({
      ...env,
      AGENT_PORT: String(await port()),
    });
    try {
      const c = service.api;
      const credential = JSON.parse(
        readFileSync(service.credentialPath, 'utf8'),
      ) as { token: string };
      const headers = { authorization: `Bearer ${credential.token}` };
      const conversation = (
        await c.inject({
          method: 'POST',
          url: '/api/v1/conversations',
          headers,
          payload: { title: 'No model' },
        })
      ).json();
      const run = (
        await c.inject({
          method: 'POST',
          url: `/api/v1/conversations/${conversation.id}/messages`,
          headers,
          payload: { clientMessageId: 'disabled', content: 'hello' },
        })
      ).json();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await c.inject({
        url: `/api/v1/runs/${run.runId}`,
        headers,
      });
      assert.equal(response.json().error, 'model_not_configured');
      assert(!response.body.includes(credential.token));
    } finally {
      await service.close();
    }
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
