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

test('conversation history follows sent acknowledgements, isolation and clear commands', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const seen: Array<{ text: string; history: string[] }> = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}/`, '', async (text, history) => {
    seen.push({ text, history: history.map(turn => turn.content) });
    if (text === 'model-failure') throw new Error('test');
    return `reply:${text}`;
  });
  try {
    const [peer] = await connection;
    const exchange = async (text: string, user = 456, group = 789, success = true) => {
      const result = once(peer, 'message');
      peer.send(JSON.stringify({ ...event('123'), user_id: user, group_id: group,
        message: [{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text } }] }));
      const [raw] = await result;
      const action = JSON.parse(raw.toString());
      peer.send(JSON.stringify({ status: success ? 'ok' : 'failed', retcode: success ? 0 : 1, echo: action.echo }));
      await new Promise(resolve => setTimeout(resolve, 10));
      return action.params.message[0].data.text;
    };
    await exchange('first');
    await exchange('second');
    assert.deepEqual(seen[1].history, ['first', 'reply:first']);
    await exchange('other-user', 999);
    await exchange('other-group', 456, 888);
    assert.deepEqual(seen[2].history, []);
    assert.deepEqual(seen[3].history, []);
    await exchange('send-failure', 456, 789, false);
    await exchange('model-failure');
    await exchange('after-failure');
    assert.deepEqual(seen.at(-1)?.history, ['first', 'reply:first', 'second', 'reply:second']);
    const beforeClear = seen.length;
    assert.match(await exchange('/清空记忆'), /已清空/);
    assert.equal(seen.length, beforeClear);
    await exchange('after-clear');
    assert.deepEqual(seen.at(-1)?.history, []);
    await exchange('other-user-again', 999);
    assert.deepEqual(seen.at(-1)?.history, ['other-user', 'reply:other-user']);
  } finally {
    stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
