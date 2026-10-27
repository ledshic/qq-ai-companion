import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import { connectNapCat } from './napcat-client.js';
import type { ReplyContext } from '../../runtime/conversation/context.js';
import { ConversationMemory } from '../../memory/memory.js';
import { SqliteSessionStore } from '../../memory/store.js';

test('real WS acknowledgements retain the target and trigger; an addressed quote fetches missing context', { timeout: 5000 }, async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection'); const seen: ReplyContext[] = []; let count = 0;
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async (_text, _history, _signal, _tools, context) => {
    seen.push(context!); return 'synthetic reply';
  }, undefined, { unified: true, memory, log: () => {}, judgeEvery: { cooldownMs: 0, hourlyCap: 10,
    judge: async () => ({ respond: false, reason: 'ordinary conversation' }) } });
  try {
    const [peer] = await connected;
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString());
      if (action.action === 'get_msg') peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0,
        data: { message_type: 'group', group_id: 3, message_id: 9, sender: { user_id: 77 },
          message: [{ type: 'text', data: { text: 'older quoted assertion' } }] } }));
      else { count++; peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 100 + count } })); }
    });
    const input = (id: number, sender: number, reply = false) => peer.send(JSON.stringify({ post_type: 'message', message_type: 'group',
      self_id: 1, group_id: 3, user_id: sender, message_id: id, sender: { nickname: sender === 2 ? 'A' : 'B' }, message: [
        ...(reply ? [{ type: 'reply', data: { id: 9 } }] : []), { type: 'at', data: { qq: 1 } },
        { type: 'text', data: { text: reply ? 'is this assertion correct?' : 'next question' } },
      ] }));
    const wait = async (predicate: () => boolean) => {
      for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail('transport did not settle');
    };
    input(10, 2, true); await wait(() => memory.get('3', '2').length === 2);
    const quoted = seen[0].snapshot.messages.find(m => m.id === '10')!;
    assert.equal(quoted.replyToSenderId, '77'); assert.equal(quoted.replyToText, 'older quoted assertion');
    input(11, 99); await wait(() => seen.length === 2);
    const delivered = seen[1].snapshot.messages.find(m => m.id === '101')!;
    assert.equal(delivered.role, 'assistant'); assert.deepEqual(delivered.mentions, ['2']); assert.equal(delivered.replyTo, '10');
  } finally {
    stop(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); memory.close();
  }
});


test('bare OneBot mentions, whitespace and a following unmentioned question work end to end', { timeout: 5000 }, async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection'); let generated = 0; let judged = 0; const sent: string[] = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async text => { generated++; return text ? 'actual answer' : `ack ${generated}`; },
    async () => ({ intent: 'continue', shouldRespond: true, reason: 'question after calling the bot' }),
    { unified: true, autoReply: true, memory, log: () => {}, judgeEvery: { cooldownMs: 0, hourlyCap: 10,
      judge: async () => { judged++; return { respond: false, reason: 'not addressed' }; } } });
  try {
    const [peer] = await connected;
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString()); assert.equal(action.action, 'send_group_msg');
      sent.push(action.params.message[0].data.text);
      peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 100 + sent.length } }));
    });
    const input = (id: number, mention?: number, text?: string) => peer.send(JSON.stringify({ post_type: 'message', message_type: 'group',
      self_id: 1, group_id: 3, user_id: 2, message_id: id, message: [
        ...(mention ? [{ type: 'at', data: { qq: mention } }] : []), ...(text !== undefined ? [{ type: 'text', data: { text } }] : []),
      ] }));
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    input(1, 1); await settle();
    assert.deepEqual(sent, ['ack 1']); assert.equal(generated, 1); assert.deepEqual(memory.get('3', '2'), []);
    input(1, 1); await settle(); assert.equal(sent.length, 1, 'duplicate mention must not acknowledge twice');
    input(2, 1, ' \n\t '); await settle(); assert.equal(sent.length, 2); assert.equal(generated, 2);
    input(3, undefined, 'actual question'); await settle();
    assert.deepEqual(sent, ['ack 1', 'ack 2', 'actual answer']);
    assert.equal(generated, 3); assert.equal(judged, 0);
    assert.deepEqual(memory.get('3', '2').map(t => t.content), ['actual question', 'actual answer']);
    input(4, 99); await settle(); assert.equal(sent.length, 3, 'mentioning someone else stays silent');
  } finally {
    stop(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); memory.close();
  }
});
