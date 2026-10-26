import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import { createQQChannel } from './qq-channel.js';

test('QQ channel normalizes message/history lookups before returning them to the Agent', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const ready = once(server, 'connection');
  let markConnected!: () => void;
  const connected = new Promise<void>(resolve => { markConnected = resolve; });
  const channel = createQQChannel(`ws://127.0.0.1:${address.port}`, '', () => {})({
    connected: () => markConnected(), disconnected: () => {}, message: () => {}, acknowledged: () => {},
  });
  channel.start();
  try {
    const [peer] = await ready;
    let wrongGroup = false;
    let actions = 0;
    const row = (id: number) => ({ message_type: 'group', group_id: wrongGroup ? 4 : 3,
      message_id: id, user_id: 2, sender: { user_id: 2 },
      message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/SECRET', file: 'PRIVATE' } }] });
    peer.on('message', (raw: RawData) => {
      actions++;
      const request = JSON.parse(raw.toString());
      let data: unknown;
      if (request.action === 'get_msg') {
        assert.equal(request.params.message_id, '9'); data = row(9);
      } else {
        assert.equal(request.action, 'get_group_msg_history');
        assert.deepEqual(request.params, { group_id: '3', count: 21, reverseOrder: false });
        data = { messages: [row(9), row(10), row(11)] };
      }
      peer.send(JSON.stringify({ echo: request.echo, status: 'ok', retcode: 0, data }));
    });
    await connected;
    const signal = new AbortController().signal;
    const current = { chatId: '3', senderId: '2', selfId: '1', messageId: '10', content: '看看', isMentioned: true };
    const reference = await channel.lookupMessage!('9', signal, current);
    assert.equal(reference?.messageId, '9'); assert.equal(reference?.chatId, '3');
    assert.equal(reference?.attachments?.imageCount, 1);
    assert.doesNotMatch(JSON.stringify(reference), /message_type|group_id|user_id/);
    const history = await channel.history!(current, signal);
    assert.deepEqual(history?.messages.map(row => row.id), ['9', '10']);
    assert.doesNotMatch(JSON.stringify(history), /SECRET|PRIVATE|qpic.cn/);
    wrongGroup = true;
    assert.equal(await channel.lookupMessage!('9', signal, current), undefined);
    assert.equal(await channel.history!(current, signal), undefined);
    const count = actions;
    assert.equal(await channel.history!({ ...current, chatId: 'private:2' }, signal), undefined);
    assert.equal(actions, count, 'private windows never query group history');
  } finally {
    channel.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
