import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import sharp from 'sharp';
import { WebSocketServer, type RawData } from 'ws';
import { connectNapCat } from './napcat-client.js';
import { createVisionReply } from './vision.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';

test('WS routes only explicit single images, resolves file IDs and same-group quotes, and records delivered text only', { timeout: 8000 }, async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection'); const sent: string[] = []; const actions: string[] = [];
  const bytes = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#f00' } }).png().toBuffer();
  let models = 0; let downloads = 0; let textReplies = 0; let quoteGroup = 3; let quoteMessage = 99;
  const vision = createVisionReply('k', undefined, async value => {
    if (String(value).includes('qpic.cn')) { downloads++; return new Response(bytes); }
    models++; return Response.json({ choices: [{ message: { content: '看见红色方块' } }] });
  }, () => {});
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async () => { textReplies++; return '文字回复'; }, undefined,
    { unified: true, memory, vision, log: () => {}, judgeEvery: { cooldownMs: 0, hourlyCap: 10,
      judge: async () => ({ respond: false, reason: 'ordinary images stay unexamined' }) } });
  try {
    const [peer] = await connected;
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString()); actions.push(action.action);
      let data: unknown;
      if (action.action === 'get_image') { assert.equal(action.params.file, 'abc.png'); data = { url: 'https://gchat.qpic.cn/refreshed' }; }
      else if (action.action === 'get_msg') data = { message_type: 'group', group_id: quoteGroup, message_id: quoteMessage,
        sender: { user_id: 77 }, message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/quoted' } }] };
      else { assert.equal(action.action, 'send_group_msg'); sent.push(action.params.message[0].data.text); data = { message_id: 1000 + sent.length }; }
      peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data }));
    });
    const input = (id: number, parts: unknown[]) => peer.send(JSON.stringify({ post_type: 'message', message_type: 'group',
      self_id: 1, user_id: 2, group_id: 3, message_id: id, message: parts }));
    const at = { type: 'at', data: { qq: 1 } };
    const img = { type: 'image', data: { url: 'https://gchat.qpic.cn/current?rkey=SECRET' } };
    const text = { type: 'text', data: { text: '看看这张图' } };
    const quote = { type: 'reply', data: { id: 99 } };
    const wait = async (predicate: () => boolean) => {
      for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail('vision transport did not settle');
    };
    input(1, [img]); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(downloads, 0); assert.equal(models, 0); assert.equal(sent.length, 0);
    input(2, [at, text, img]); await wait(() => memory.get('3', '2').length === 2);
    assert.equal(sent.at(-1), '看见红色方块'); assert.equal(models, 1);
    assert.doesNotMatch(JSON.stringify(memory.get('3', '2')), /SECRET|qpic.cn|base64/);
    input(2, [at, text, img]); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(models, 1);
    input(3, [at, { type: 'image', data: { file: 'abc.png' } }]); await wait(() => sent.length === 2);
    assert.ok(actions.includes('get_image')); assert.equal(models, 2);
    input(4, [quote, at, text]); await wait(() => sent.length === 3); assert.equal(models, 3);
    input(5, [at, text, img, img]); await wait(() => sent.length === 4);
    assert.match(sent.at(-1)!, /只能看一张/); assert.equal(models, 3);
    input(6, [quote, at, text, img]); await wait(() => sent.length === 5);
    assert.match(sent.at(-1)!, /只能看一张/); assert.equal(models, 3);
    quoteGroup = 999;
    input(7, [quote, at, text]); await wait(() => sent.length === 6);
    assert.match(sent.at(-1)!, /可验证的图片/); assert.equal(models, 3);
    quoteGroup = 3; quoteMessage = 100;
    input(8, [quote, at, text]); await wait(() => sent.length === 7);
    assert.match(sent.at(-1)!, /可验证的图片/); assert.equal(models, 3);
    assert.equal(textReplies, 0);
  } finally {
    stop(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); memory.close();
  }
});

test('disabled image understanding returns an honest response without invoking text generation', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection'); let generated = 0;
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async () => { generated++; return 'wrong'; }, undefined, { unified: true, log: () => {} });
  try {
    const [peer] = await connected;
    const response = once(peer, 'message');
    peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 1, group_id: 3, user_id: 2, message_id: 1,
      message: [{ type: 'at', data: { qq: 1 } }, { type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }] }));
    const [raw] = await response; const action = JSON.parse(String(raw));
    assert.match(action.params.message[0].data.text, /没有启用图片理解/); assert.equal(generated, 0);
    peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 2 } }));
  } finally { stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('WS preserves an ordinary image ID for a later explicit visual request without a quote', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection'); let views = 0; let textCalls = 0;
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async () => { textCalls++; return 'wrong text-only path'; }, undefined,
    { unified: true, log: () => {}, imageRequest: async (question, context, id) => {
      assert.equal(question, '看看这是什么'); assert.equal(id, '10');
      assert.equal(context.snapshot.messages.find(m => m.id === id)?.imageCount, 1); return true;
    }, vision: async (_text, image) => { views++; assert.equal(image.url, 'https://gchat.qpic.cn/a'); return 'recognized picture'; } });
  try {
    const [peer] = await connected;
    const delivered = new Promise<void>(resolve => peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString());
      if (action.action === 'get_msg') {
        assert.equal(action.params.message_id, '10');
        peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_type: 'group',
          group_id: 3, message_id: 10, sender: { user_id: 2 }, message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }] } }));
      } else {
        assert.equal(action.action, 'send_group_msg'); assert.equal(action.params.message[0].data.text, 'recognized picture');
        peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data: { message_id: 12 } })); resolve();
      }
    }));
    const input = (id: number, message: unknown[]) => peer.send(JSON.stringify({ post_type: 'message', message_type: 'group',
      self_id: 1, group_id: 3, user_id: 2, message_id: id, message }));
    input(10, [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }]);
    input(11, [{ type: 'at', data: { qq: 1 } }, { type: 'text', data: { text: '看看这是什么' } }]);
    await delivered; assert.equal(views, 1); assert.equal(textCalls, 0);
  } finally { stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('WS cold start queries history anchored to the new request and reads the earlier image without replaying it', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const connected = once(server, 'connection'); let views = 0; let textCalls = 0; const actions: string[] = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async () => { textCalls++; return 'wrong'; }, undefined,
    { unified: true, log: () => {}, imageRequest: async (_question, _context, id) => { assert.equal(id, '10'); return true; },
      vision: async (_question, image) => { views++; assert.equal(image.url, 'https://gchat.qpic.cn/a'); return 'image reply'; } });
  try {
    const [peer] = await connected;
    const pic = { message_type: 'group', group_id: 3, message_id: 10, user_id: 2, sender: { user_id: 2 },
      message: [{ type: 'image', data: { url: 'https://gchat.qpic.cn/a' } }] };
    const ask = { post_type: 'message', message_type: 'group', self_id: 1, group_id: 3, user_id: 2, message_id: 11,
      message: [{ type: 'at', data: { qq: 1 } }, { type: 'text', data: { text: '看看前面的图' } }] };
    const finished = new Promise<void>(resolve => peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString()); actions.push(action.action); let data: unknown;
      if (action.action === 'get_group_msg_history') { assert.equal(action.params.count, 21); data = { messages: [pic, ask] }; }
      else if (action.action === 'get_msg') { assert.equal(action.params.message_id, '10'); data = pic; }
      else { assert.equal(action.action, 'send_group_msg'); assert.equal(action.params.message[0].data.text, 'image reply'); data = { message_id: 12 }; }
      peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0, data }));
      if (action.action === 'send_group_msg') resolve();
    }));
    peer.send(JSON.stringify(ask)); await finished;
    assert.deepEqual(actions, ['get_group_msg_history', 'get_msg', 'send_group_msg']); assert.equal(views, 1); assert.equal(textCalls, 0);
    await new Promise(setImmediate);
  } finally { stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
