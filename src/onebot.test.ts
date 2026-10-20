import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import { connectNapCat } from './napcat-client.js';
import { parseGroupMessage } from './onebot.js';

const event = (qq: string) => ({
  post_type: 'message', message_type: 'group', self_id: 123, user_id: 456, group_id: 789,
  message: [{ type: 'at', data: { qq } }, { type: 'text', data: { text: '你好' } }],
});

test('only an actual mention of this account triggers the mention flag', () => {
  assert.equal(parseGroupMessage(event('123'))?.isMentioned, true);
  assert.equal(parseGroupMessage(event('999'))?.isMentioned, false);
  assert.equal(parseGroupMessage(event('all'))?.isMentioned, false);
  assert.equal(parseGroupMessage({ ...event('123'), message: [{ type: 'text', data: { text: '@123' } }] })?.isMentioned, false);
});

test('ignore private, self, malformed and string-format events', () => {
  for (const value of [null, {}, { ...event('123'), message_type: 'private' },
    { ...event('123'), user_id: 123 }, { ...event('123'), message: '[CQ:at,qq=123]' }]) {
    assert.equal(parseGroupMessage(value), null);
  }
});

test('WebSocket authenticates and sends exactly one reply for a bot mention', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const prompts: string[] = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}/`, 'test-token', async content => { prompts.push(content); return '模拟模型回复'; });
  try {
    const [peer, request] = await connection;
    assert.equal(request.headers.authorization, 'Bearer test-token');
    const actions: unknown[] = [];
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString());
      actions.push(action);
      peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo }));
    });
    peer.send('invalid JSON');
    peer.send(JSON.stringify(event('999')));
    peer.send(JSON.stringify(event('all')));
    peer.send(JSON.stringify({ ...event('123'), user_id: 123 }));
    const received = once(peer, 'message');
    peer.send(JSON.stringify(event('123')));
    await received;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(actions.length, 1);
    assert.deepEqual(prompts, ['你好']);
    assert.deepEqual((actions[0] as { params: unknown }).params, {
      group_id: '789', message: [{ type: 'text', data: { text: '模拟模型回复' } }],
    });
  } finally {
    stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
