import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type RawData } from 'ws';
import { connectNapCat } from './napcat-client.js';
import { MemeManager, loadMemeCatalog, type MemeStateStore } from '../../tools/memes/memes.js';
import { ConversationMemory } from '../../memory/memory.js';
import { SqliteSessionStore } from '../../memory/store.js';
const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('transport did not settle'); };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, mode: 'ok' | 'image-fail' | 'text-fail' | 'cancel' | 'image-recheck' | 'partial-text' = 'ok') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const connected = once(server, 'connection');
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  let state = {}; const saved: MemeStateStore = { load: () => structuredClone(state), save: value => { state = structuredClone(value); } };
  const entries = loadMemeCatalog('config/memes/tieba').filter(e => e.confidence >= .8);
  const h = { actions: [] as any[], selects: 0, checks: [] as string[], generated: 0, lookupOnly: false,
    aborted: false, release: undefined as (() => void) | undefined };
  const manager = new MemeManager(entries, 'key', saved, 7, async (_url, init) => {
    if (JSON.parse(String(init?.body)).messages[0].content.includes('独立复核')) return Response.json({ choices: [{ message: { content: '{"match":true}' } }] });
    h.selects++;
    init?.signal?.addEventListener('abort', () => { h.aborted = true; }, { once: true });
    if (mode === 'cancel') await new Promise<void>(resolve => { h.release = resolve; });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ id: entries[0].id }) } }] });
  }, () => {});
  const stop = connectNapCat(`ws://127.0.0.1:${address.port}`, '', async text => { h.generated++; return mode === 'partial-text' ? 'first\nsecond' : 'text:' + text; }, undefined,
    { unified: true, memory, memes: manager, log: () => {}, judgeEvery: { cooldownMs: 0, hourlyCap: 10, judge: async input => {
      if (input.context?.phase === 'before_send') { h.checks.push(input.context.draft ?? ''); return { respond: false, reason: 'obsolete now' }; }
      return { respond: false, reason: 'not addressed' };
    } } });
  const [peer] = await connected;
  peer.on('message', (raw: RawData) => {
    const action = JSON.parse(raw.toString()); h.actions.push(action);
    assert.equal(action.action, 'send_group_msg');
    const image = action.params.message[0].type === 'image';
    assert.equal(JSON.stringify(action.params).includes('已发送表情'), false, 'internal history record must never leak into QQ');
    const failure = image ? mode === 'image-fail' : mode === 'text-fail' || mode === 'partial-text' && h.actions.length === 2;
    peer.send(JSON.stringify({ echo: action.echo, status: failure ? 'failed' : 'ok', retcode: failure ? 100 : 0, data: { message_id: 100 + h.actions.length } }));
    if (!image && mode === 'image-recheck') input(2, 'someone answered', 99, false);
  });
  const input = (id: number, text = 'hello', sender = 2, explicit = true) => peer.send(JSON.stringify({ post_type: 'message', message_type: 'group',
    self_id: 1, group_id: 3, user_id: sender, message_id: id, message: [ ...(explicit ? [{ type: 'at', data: { qq: 1 } }] : []), { type: 'text', data: { text } } ] }));
  t.after(async () => { stop(); h.release?.(); for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); memory.close(); });
  return { ...h, h, input, memory, manager, entries, state: () => state };
}

test('a concrete meme is sent as an image, ACK records its exact identity, and consecutive replies stay text-only', { timeout: 5000 }, async t => {
  const f = await fixture(t); f.input(1);
  await waitFor(() => f.memory.get('3', '2').some(turn => turn.content.includes('[已发送表情')));
  assert.equal(f.h.actions.length, 2); const image = f.h.actions[1].params.message[0];
  assert.equal(image.type, 'image'); assert.match(image.data.file, /^base64:\/\//); assert.equal(image.data.sub_type, 1);
  const history = f.memory.get('3', '2'); assert.match(history[1].content, new RegExp(f.entries[0].id));
  assert.doesNotMatch(history[1].content, /base64:\/\//);
  f.input(2, 'next'); await waitFor(() => f.memory.get('3', '2').length === 4);
  assert.equal(f.h.actions.length, 3); assert.equal(f.h.selects, 1); assert.equal(f.h.actions[2].params.message[0].type, 'text');
});
test('failed image ACK preserves text history without pretending the image was delivered', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'image-fail'); f.input(1);
  await waitFor(() => f.memory.get('3', '2').length === 2);
  assert.equal(f.h.actions.length, 2); assert.equal(f.memory.get('3', '2')[1].content, 'text:hello');
  assert.equal((f.state() as any)['3'].replies, 0, 'uncertain/failed attempts must not be retried immediately');
});
test('a failed text send never emits the image or writes a fabricated history record', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'text-fail'); f.input(1);
  await waitFor(() => f.h.actions.length === 1); await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.memory.get('3', '2'), []); assert.equal(f.h.actions.length, 1);
});
test('a newer user message while selecting cancels the old text and meme before either is sent', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'cancel'); f.input(1); await waitFor(() => !!f.h.release);
  f.input(2, 'replacement'); await waitFor(() => f.h.aborted); f.h.release!();
  // The replacement may enter its own selection; release it too.
  await new Promise(resolve => setTimeout(resolve, 20)); f.h.release?.();
  await waitFor(() => f.memory.get('3', '2').length === 2);
  assert.equal(f.h.actions.some(a => a.params.message[0].data.text === 'text:hello'), false);
  assert.equal(f.memory.get('3', '2')[0].content, 'replacement');
});
test('discussion changes after text ACK recheck a draft containing the selected image meaning before sending it', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'image-recheck'); f.input(1);
  await waitFor(() => f.memory.get('3', '2').length === 2); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.h.actions.length, 1); assert.equal(f.memory.get('3', '2')[1].content, 'text:hello');
  assert.ok(f.h.checks.some(draft => draft.includes(f.entries[0].meaning)));
});


test('partially delivered text is preserved and the selected image is withheld when a later text part fails', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'partial-text'); f.input(1);
  await waitFor(() => f.h.actions.length === 2); await waitFor(() => f.memory.get('3', '2').length === 2);
  assert.equal(f.memory.get('3', '2')[1].content, 'first');
  assert.ok(f.h.actions.every(action => action.params.message[0].type === 'text'));
});
