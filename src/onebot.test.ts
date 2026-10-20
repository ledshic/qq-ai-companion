import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import { connectNapCat } from './napcat-client.js';
import { parseGroupMessage, isBotGroupReply } from './onebot.js';

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

test('reply parsing supports negative message IDs and validates bot, group and message ID', () => {
  const message = parseGroupMessage({ ...event('999'), message: [{ type: 'reply', data: { id: '-42' } }, { type: 'text', data: { text: '继续' } }] })!;
  assert.equal(message.replyMessageId, '-42');
  assert.equal(message.isMentioned, false);
  const data = { message_type: 'group', group_id: 789, message_id: -42, sender: { user_id: 123 } };
  assert.equal(isBotGroupReply(data, message), true);
  assert.equal(isBotGroupReply({ ...data, group_id: 999 }, message), false);
  assert.equal(isBotGroupReply({ ...data, sender: { user_id: 999 } }, message), false);
  assert.equal(isBotGroupReply({ ...data, message_id: -43 }, message), false);
  assert.equal(isBotGroupReply(null, message), false);
});

test('unmentioned replies verify ownership and retain the same conversation memory', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const seen: Array<{ text: string; history: string[] }> = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}/`, '', async (text, history) => {
    seen.push({ text, history: history.map(turn => turn.content) }); return 'reply';
  });
  try {
    const [peer] = await connection;
    let sent = 0;
    const lookups: string[] = [];
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString());
      if (action.action === 'get_msg') {
        const id = action.params.message_id;
        lookups.push(id);
        peer.send(JSON.stringify({ echo: action.echo, status: id === '404' ? 'failed' : 'ok', retcode: id === '404' ? 1 : 0,
          data: { message_type: 'group', message_id: id, group_id: id === '3' ? 999 : 789,
            sender: { user_id: id === '2' ? 999 : 123 }, message: 'quoted text must not go to the model' } }));
      } else if (action.action === 'send_group_msg') {
        sent++;
        peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0 }));
      }
    });
    const send = async (id: string | undefined, text: string, mention = false) => {
      peer.send(JSON.stringify({ ...event('999'), message: [
        ...(id ? [{ type: 'reply', data: { id } }] : []),
        ...(mention ? [{ type: 'at', data: { qq: '123' } }] : []),
        { type: 'text', data: { text } },
      ] }));
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    await send(undefined, 'ordinary');
    await send('2', 'reply to someone else');
    await send('3', 'wrong group');
    await send('404', 'not found');
    assert.equal(seen.length, 0);
    await send('-42', 'first');
    assert.equal(sent, 1);
    await send(undefined, 'follow up', true);
    assert.deepEqual(seen, [{ text: 'first', history: [] }, { text: 'follow up', history: ['first', 'reply'] }]);
    await send('-42', '/清空记忆');
    await send('-42', 'after clear');
    assert.deepEqual(seen.at(-1), { text: 'after clear', history: [] });
    assert.deepEqual(lookups, ['2', '3', '404', '-42', '-42', '-42']);
  } finally {
    stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('name calls share mention memory, clear locally, and ignore incidental names', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const seen: Array<{ text: string; history: string[] }> = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}/`, '', async (text, history) => {
    seen.push({ text, history: history.map(turn => turn.content) }); return 'reply';
  });
  try {
    const [peer] = await connection;
    let sent = 0;
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString());
      assert.equal(action.action, 'send_group_msg');
      sent++;
      peer.send(JSON.stringify({ echo: action.echo, status: 'ok', retcode: 0 }));
    });
    const send = async (text: string, mention = false) => {
      peer.send(JSON.stringify({ ...event('999'), message: [
        ...(mention ? [{ type: 'at', data: { qq: '123' } }] : []),
        { type: 'text', data: { text } },
      ] }));
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    await send('小爱，你好');
    await send('小爱好者');
    assert.equal(sent, 0);
    await send('大肥鱼，叫我小林');
    await send('大肥鱼，我叫什么');
    assert.deepEqual(seen, [{ text: '叫我小林', history: [] }, { text: '我叫什么', history: ['叫我小林', 'reply'] }]);
    await send('大肥鱼，/清空记忆');
    assert.equal(seen.length, 2);
    await send('大肥鱼你记得吗');
    assert.deepEqual(seen.at(-1), { text: '你记得吗', history: [] });
    await send('大肥鱼');
    assert.equal(seen.length, 3);
    assert.equal(sent, 5);
  } finally {
    stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('observation never replies or changes memory and ends on another speaker', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const observed: Array<{ text: string; history: string[] }> = [];
  const answerHistory: string[][] = [];
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}/`, '', async (_text, history) => {
    answerHistory.push(history.map(turn => turn.content)); return '你喜欢什么咖啡？';
  }, async (text, history) => {
    observed.push({ text, history: history.map(turn => turn.content) });
    return { shouldRespond: true, reason: '回答机器人问题' };
  });
  try {
    const [peer] = await connection;
    let sent = 0;
    peer.on('message', (raw: RawData) => {
      const action = JSON.parse(raw.toString());
      assert.equal(action.action, 'send_group_msg');
      sent++;
      peer.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo }));
    });
    const send = async (text: string, mention = false, user = 456, group = 789, imageOnly = false) => {
      peer.send(JSON.stringify({ ...event('999'), user_id: user, group_id: group, message: [
        ...(mention ? [{ type: 'at', data: { qq: '123' } }] : []),
        imageOnly ? { type: 'image', data: {} } : { type: 'text', data: { text } },
      ] }));
      await new Promise(resolve => setTimeout(resolve, 25));
    };
    await send('before window');
    assert.equal(observed.length, 0);
    await send('聊咖啡', true);
    await send('拿铁');
    await send('other group', false, 999, 888);
    await send('热拿铁');
    assert.equal(sent, 1);
    assert.deepEqual(observed.map(value => value.text), ['拿铁', '热拿铁']);
    assert.deepEqual(observed[0].history, ['聊咖啡', '你喜欢什么咖啡？']);
    await send('', false, 999, 789, true);
    await send('should not observe');
    assert.equal(observed.length, 2);
    await send('再聊聊', true);
    assert.deepEqual(answerHistory[1], ['聊咖啡', '你喜欢什么咖啡？']);
    await send('大肥鱼，/清空记忆');
    await send('after clear');
    assert.equal(observed.length, 2);
    assert.equal(sent, 3);
  } finally {
    stop();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
