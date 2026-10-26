import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { createNapCatTransport, type NapCatTransportEvents } from './napcat-transport.js';

const waitFor = async (predicate: () => boolean) => {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('transport did not settle');
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const order: string[] = [];
  const messages: unknown[] = [], receipts: unknown[][] = [];
  const handlers: NapCatTransportEvents = {
    connected: () => { order.push('connected'); },
    disconnected: () => { order.push('disconnected'); },
    message: message => { messages.push(message); },
    acknowledged: (...receipt) => { order.push('acknowledged'); receipts.push(receipt); },
  };
  const transport = createNapCatTransport(`ws://127.0.0.1:${address.port}`, 'test-token', handlers, () => {});
  t.after(async () => {
    transport.stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  assert.equal(transport.capture('group'), undefined);
  const connection = once(server, 'connection');
  transport.start();
  const [socket, request] = await connection as [WebSocket, IncomingMessage];
  await waitFor(() => order.includes('connected'));
  return { server, socket, request, transport, order, messages, receipts };
}

test('transport authenticates, emits parsed messages and acknowledges before resolving a captured send', async t => {
  const f = await fixture(t);
  assert.equal(f.request.headers.authorization, 'Bearer test-token');
  f.socket.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 1,
    group_id: 2, user_id: 3, message_id: 4, message: [{ type: 'text', data: { text: 'hello' } }] }));
  await waitFor(() => f.messages.length === 1);
  assert.equal((f.messages[0] as { content: string }).content, 'hello');
  const channel = f.transport.capture('2')!;
  const action = once(f.socket, 'message');
  const target = { senderId: '3', replyTo: '4' };
  const delivered = channel.send('answer', target).then(ok => { f.order.push('resolved'); return ok; });
  const [raw] = await action;
  const body = JSON.parse(raw.toString());
  assert.equal(body.action, 'send_group_msg');
  assert.deepEqual(body.params.message, [{ type: 'text', data: { text: 'answer' } }]);
  f.socket.send(JSON.stringify({ echo: body.echo, status: 'ok', retcode: 0, data: { message_id: 5 } }));
  assert.equal(await delivered, true);
  assert.deepEqual(f.receipts, [['2', 'answer', '5', target]]);
  assert.deepEqual(f.order.slice(-2), ['acknowledged', 'resolved']);
});

test('lookups correlate by echo and cancellation discards late results without emitting messages', async t => {
  const f = await fixture(t);
  const actions: any[] = [];
  f.socket.on('message', raw => actions.push(JSON.parse(raw.toString())));
  const first = f.transport.lookup('get_msg', { message_id: '10' }, new AbortController().signal);
  const controller = new AbortController();
  const cancelled = f.transport.lookup('get_image', { file: 'image' }, controller.signal);
  await waitFor(() => actions.length === 2);
  controller.abort();
  assert.equal(await cancelled, null);
  f.socket.send(JSON.stringify({ echo: actions[1].echo, status: 'ok', retcode: 0, data: { url: 'late' } }));
  f.socket.send(JSON.stringify({ echo: actions[0].echo, status: 'ok', retcode: 0, data: { message_id: '10' } }));
  assert.deepEqual(await first, { message_id: '10' });
  assert.deepEqual(f.messages, []);
});

test('failed sends emit no acknowledgement and disconnect settles outstanding sends and lookups', async t => {
  const f = await fixture(t);
  const channel = f.transport.capture('2')!;
  let action = once(f.socket, 'message');
  const failed = channel.send('failed');
  let [raw] = await action;
  f.socket.send(JSON.stringify({ echo: JSON.parse(raw.toString()).echo, status: 'failed', retcode: 1 }));
  assert.equal(await failed, false); assert.deepEqual(f.receipts, []);
  const actions: unknown[] = [];
  f.socket.on('message', value => actions.push(JSON.parse(value.toString())));
  action = once(f.socket, 'message');
  const sending = channel.send('unconfirmed');
  await action;
  const lookup = f.transport.lookup('get_msg', { message_id: '10' }, new AbortController().signal);
  await waitFor(() => actions.length === 2);
  f.socket.terminate();
  assert.deepEqual(await Promise.all([sending, lookup]), [false, null]);
  await waitFor(() => f.order.includes('disconnected'));
  assert.equal(channel.connected(), false); assert.equal(f.transport.capture('2'), undefined);
  assert.deepEqual(f.receipts, []);
});

test('reconnect keeps old channels invalid and never replays unconfirmed actions', { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const stale = f.transport.capture('2')!;
  const action = once(f.socket, 'message');
  const sending = stale.send('unconfirmed');
  await action;
  const reconnected = once(f.server, 'connection');
  f.socket.terminate();
  assert.equal(await sending, false);
  const [next] = await reconnected as [WebSocket, IncomingMessage];
  const replayed: unknown[] = [];
  next.on('message', raw => replayed.push(raw));
  await waitFor(() => f.order.filter(item => item === 'connected').length === 2);
  assert.equal(stale.connected(), false);
  assert.equal(f.transport.capture('2')!.connected(), true);
  assert.deepEqual(replayed, []);
  assert.deepEqual(f.receipts, []);
});
