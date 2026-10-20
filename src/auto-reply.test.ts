import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import { connectNapCat } from './napcat-client.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 25));
async function harness() {
  let now = 0;
  let failSend = false;
  let generate: (text: string) => Promise<string> = async text => `answer:${text}`;
  const histories: Array<{ text: string; history: string[] }> = [];
  const judged: string[] = [];
  const sent: string[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const connection = once(server, 'connection');
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}/`, '', async (text, history) => {
    histories.push({ text, history: history.map(turn => turn.content) });
    return generate(text);
  }, async text => {
    judged.push(text);
    if (text === 'judge-error') throw new Error('test');
    return { shouldRespond: text !== 'no', reason: 'test reason' };
  }, { autoReply: true, now: () => now });
  const [peer] = await connection;
  peer.on('message', (raw: RawData) => {
    const action = JSON.parse(raw.toString());
    assert.equal(action.action, 'send_group_msg');
    sent.push(action.params.message[0].data.text);
    peer.send(JSON.stringify({ echo: action.echo, status: failSend ? 'failed' : 'ok', retcode: failSend ? 1 : 0 }));
  });
  return {
    sent, histories, judged,
    time: (value: number) => { now = value; },
    failure: (value: boolean) => { failSend = value; },
    generator: (value: typeof generate) => { generate = value; },
    send: async (text: string, explicit = false, user = 456, image = false) => {
      peer.send(JSON.stringify({ post_type: 'message', message_type: 'group', self_id: 123, user_id: user, group_id: 789,
        message: [...(explicit ? [{ type: 'at', data: { qq: '123' } }] : []),
          image ? { type: 'image', data: {} } : { type: 'text', data: { text } }] }));
      await pause();
    },
    close: async () => {
      stop();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test('auto replies stop at two, retain successful memory, and reset only on explicit calls', { timeout: 5000 }, async () => {
  const h = await harness();
  try {
    await h.send('before');
    assert.equal(h.judged.length, 0);
    await h.send('start', true);
    await h.send('one');
    await h.send('two');
    await h.send('three');
    assert.deepEqual(h.judged, ['one', 'two']);
    assert.equal(h.sent.length, 3);
    assert.deepEqual(h.histories[2].history, ['start', 'answer:start', 'one', 'answer:one']);
    await h.send('reset', true);
    await h.send('four');
    assert.equal(h.sent.length, 5);
    assert.equal(h.histories.at(-1)?.history.length, 8);
  } finally { await h.close(); }
});

test('negative judgments and failed sends/generation are silent and do not consume quota or memory', { timeout: 5000 }, async () => {
  const h = await harness();
  try {
    await h.send('start', true);
    await h.send('no');
    await h.send('judge-error');
    h.generator(async () => { throw new Error('model'); });
    await h.send('generate-error');
    h.generator(async text => `answer:${text}`);
    h.failure(true);
    await h.send('send-error');
    h.failure(false);
    await h.send('one');
    await h.send('two');
    await h.send('three');
    assert.deepEqual(h.sent, ['answer:start', 'answer:send-error', 'answer:one', 'answer:two']);
    assert.deepEqual(h.histories.find(row => row.text === 'one')?.history, ['start', 'answer:start']);
    assert.equal(h.judged.includes('three'), false);
  } finally { await h.close(); }
});

for (const interruption of ['speaker', 'expiry', 'explicit'] as const) {
  test(`cancel generated auto reply before sending on ${interruption}`, { timeout: 5000 }, async () => {
    const h = await harness();
    let complete!: (text: string) => void;
    try {
      await h.send('start', true);
      h.generator(() => new Promise(resolve => { complete = resolve; }));
      await h.send('pending');
      if (interruption === 'speaker') await h.send('', false, 999, true);
      if (interruption === 'expiry') h.time(60_000);
      if (interruption === 'explicit') await h.send('new explicit', true);
      complete('late answer');
      await pause();
      assert.deepEqual(h.sent, ['answer:start']);
      await h.send('after');
      assert.deepEqual(h.judged, ['pending']);
    } finally { await h.close(); }
  });
}
