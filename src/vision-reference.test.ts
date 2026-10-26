import type { ReferencedMessage } from './channel.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import { createImageRequestJudge } from './vision.js';
import type { ChatMessage } from './message.js';
import type { ReplyContext } from './context.js';
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; };
function setup(t: { after: (fn: () => void) => void }) {
  let now = 1000;
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'), () => now);
  const h = { sent: [] as string[], judged: 0, lookups: 0, viewed: 0, generated: 0,
    judge: async () => true, lookup: async (id: string): Promise<ReferencedMessage | undefined> => ({ chatId: 'g',
      messageId: id, senderId: 'a', attachments: { imageCount: 1, images: [{ url: 'https://gchat.qpic.cn/signed?rkey=SECRET' }] } }),
    vision: async (_text: string, image: { url?: string }) => { assert.match(image.url!, /qpic.cn/); return '看到了图片内容'; },
  };
  const conversation = new Conversation({ unified: true, memory, now: () => now, log: () => {},
    imageRequest: async (_text, context, id) => { h.judged++; assert.doesNotMatch(JSON.stringify(context), /SECRET|rkey/); return h.judge(); },
    lookup: async id => { h.lookups++; return h.lookup(id); },
    vision: async (text, image) => { h.viewed++; return h.vision(text, image); },
    generate: async () => { h.generated++; return '文字回答'; },
    send: async (_group, content, guard) => { if (await guard()) { h.sent.push(content); return content; } },
  });
  t.after(() => { conversation.disconnect(); memory.close(); });
  const input = async (overrides: Partial<ChatMessage>) => {
    conversation.handle({ chatId: 'g', senderId: 'a', selfId: 'bot', messageId: 'ask', content: '看看这是什么', isMentioned: true, ...overrides }); await flush();
  };
  const picture = async (overrides: Partial<ChatMessage> = {}) => input({ messageId: 'pic', isMentioned: false, content: '', hasMedia: true,
    attachments: { imageCount: 1, images: [{ url: 'https://gchat.qpic.cn/signed?rkey=SECRET' }] }, ...overrides });
  return Object.assign(h, { memory, conversation, input, picture, advance: (ms: number) => { now += ms; } });
}

test('picture then explicit deictic request twelve seconds later resolves the original instead of text-only generation', async t => {
  const h = setup(t); await h.picture(); assert.equal(h.viewed, 0);
  h.advance(12_000); await h.input({});
  assert.equal(h.judged, 1); assert.equal(h.lookups, 1); assert.equal(h.viewed, 1); assert.equal(h.generated, 0);
  assert.deepEqual(h.sent, ['看到了图片内容']);
  assert.doesNotMatch(JSON.stringify(h.memory.get('g', 'a')), /SECRET|qpic.cn|base64/);
});

test('a normal question after an image remains text-only when semantic intent rejects reading', async t => {
  const h = setup(t); await h.picture(); h.judge = async () => false;
  await h.input({ content: '1加1等于多少' });
  assert.equal(h.judged, 1); assert.equal(h.lookups, 0); assert.equal(h.viewed, 0); assert.deepEqual(h.sent, ['文字回答']);
});

for (const scope of ['other-author', 'other-group', 'unmentioned'] as const) {
  test(`recent image lookup does not widen scope: ${scope}`, async t => {
    const h = setup(t);
    await h.picture(scope === 'other-author' ? { senderId: 'b' } : scope === 'other-group' ? { chatId: 'other' } : {});
    await h.input(scope === 'unmentioned' ? { isMentioned: false } : {});
    assert.equal(h.judged, 0); assert.equal(h.lookups, 0); assert.equal(h.viewed, 0);
  });
}

for (const failure of ['wrong-group', 'wrong-author', 'wrong-message', 'no-image', 'unavailable'] as const) {
  test(`reference response must match selected event before reading: ${failure}`, async t => {
    const h = setup(t); await h.picture();
    h.lookup = async id => failure === 'unavailable' ? undefined : {
      chatId: failure === 'wrong-group' ? 'wrong' : 'g', messageId: failure === 'wrong-message' ? 'wrong' : id,
      senderId: failure === 'wrong-author' ? 'wrong' : 'a',
      attachments: failure === 'no-image' ? { imageCount: 0, images: [] } : { imageCount: 1, images: [{ url: 'https://gchat.qpic.cn/wrong' }] } };
    h.vision = async (_text, image) => { assert.deepEqual(image, {}); return '图片获取失败'; };
    await h.input({}); assert.deepEqual(h.sent, ['图片获取失败']); assert.equal(h.generated, 0);
  });
}

test('a recently posted multi-image message is rejected rather than picking one', async t => {
  const h = setup(t); await h.picture({ attachments: { imageCount: 2, images: [{}, {}] } });
  h.lookup = async id => ({ chatId: 'g', messageId: id, senderId: 'a', attachments: { imageCount: 2, images: [{}, {}] } });
  await h.input({}); assert.match(h.sent[0], /只能看一张/); assert.equal(h.viewed, 0);
});

test('canceling while intent is pending prevents fetching or viewing the selected image', async t => {
  const h = setup(t); await h.picture();
  const pending = deferred<boolean>(); h.judge = async () => pending.promise;
  await h.input({});
  h.judge = async () => false;
  await h.input({ messageId: 'new', content: '不用看了，讲别的' });
  pending.resolve(true); await flush(); await flush();
  assert.equal(h.lookups, 0); assert.equal(h.viewed, 0); assert.deepEqual(h.sent, ['文字回答']);
});

test('invalid or failed intent decisions never read an image', async t => {
  const h = setup(t); await h.picture(); h.judge = async () => { throw Error('timeout'); };
  await h.input({}); assert.equal(h.lookups, 0); assert.equal(h.viewed, 0);
});

test('image intent request uses aliased metadata and validates the response instead of trusting arbitrary output', async () => {
  const context: ReplyContext = { kind: 'explicit', targetSenderId: '12345678', triggerIds: ['99999999'], snapshot: { chatId: '87654321',
    version: 1, incomingVersion: 1, capturedAt: 0, messages: [{ id: '99999999', senderId: '12345678', text: '',
      role: 'user', at: 0, revision: 1, mentions: [], media: true, imageCount: 1 }] } };
  const judge = createImageRequestJudge('key', undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.tools, undefined);
    assert.doesNotMatch(String(init?.body), /12345678|99999999|87654321/);
    const payload = JSON.parse(body.messages[1].content);
    assert.equal(payload.candidate.imageCount, 1);
    assert.equal(payload.candidate.at, undefined); assert.equal(payload.discussionContext.snapshot.capturedAt, undefined);
    assert.ok(payload.discussionContext.snapshot.messages.every((m: any) => m.at === undefined));
    return Response.json({ choices: [{ message: { content: '{"inspect":true}' } }] });
  });
  assert.equal(await judge('看看这是什么', context, '99999999', new AbortController().signal), true);
  for (const response of [new Response('', { status: 429 }), Response.json({}), Response.json({ choices: [{ message: { content: '{"inspect":"true"}' } }] })]) {
    const bad = createImageRequestJudge('key', undefined, async () => response);
    await assert.rejects(bad('看看', context, '99999999', new AbortController().signal));
  }
});


for (const gap of [90_001, 24 * 60 * 60_000]) {
  test(`a nearby same-author image survives an idle gap of ${gap}ms without a time cutoff`, async t => {
    const h = setup(t); await h.picture(); h.advance(gap); await h.input({});
    assert.equal(h.lookups, 1); assert.equal(h.viewed, 1); assert.equal(h.generated, 0);
  });
}

test('another person posting a newer picture does not hide the current authors picture', async t => {
  const h = setup(t); await h.picture(); await h.picture({ messageId: 'other-pic', senderId: 'b' });
  await h.input({}); assert.equal(h.lookups, 1); assert.equal(h.viewed, 1);
});

test('the latest nearby picture from this author takes precedence over their earlier picture', async t => {
  const h = setup(t); await h.picture(); await h.picture({ messageId: 'pic2' });
  const original = h.lookup; h.lookup = async id => { assert.equal(id, 'pic2'); return original(id); };
  await h.input({}); assert.equal(h.lookups, 1); assert.equal(h.viewed, 1);
});

for (const intervening of [19, 20]) {
  test(`picture resolution is bounded by the twenty preceding messages: ${intervening} intervening`, async t => {
    const h = setup(t); await h.picture();
    for (let i = 0; i < intervening; i++) await h.input({ messageId: `noise-${i}`, senderId: 'b', content: 'ordinary chat', isMentioned: false });
    await h.input({}); assert.equal(h.viewed, intervening === 19 ? 1 : 0);
  });
}

test('a fresh process resolves an explicitly requested picture from bounded history without replaying old messages', async t => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:')); const sent: string[] = []; let historyCalls = 0; let viewed = 0; let generated = 0;
  const row = (id: number, image = false) => ({ id: String(id), senderId: '2', role: 'user' as const,
    text: image ? '' : '我前面发的图片现在能看到了吗', at: 0, revision: id, mentions: [], media: image,
    ...(image ? { imageCount: 1 } : {}) });
  const conversation = new Conversation({ unified: true, memory, log: () => {},
    referenceHistory: async current => { historyCalls++; assert.equal(current.chatId, '3'); return { chatId: '3', messages: [row(10, true), row(11)] }; },
    imageRequest: async (_text, context, id) => { assert.equal(id, '10'); assert.doesNotMatch(JSON.stringify(context), /PRIVATE|qpic.cn/); return true; },
    lookup: async id => { assert.equal(id, '10'); return { chatId: '3', messageId: '10', senderId: '2', attachments: { imageCount: 1, images: [{ url: 'https://gchat.qpic.cn/signed?PRIVATE' }] } }; },
    vision: async () => { viewed++; return '看见图片了'; }, generate: async () => { generated++; return 'text'; },
    send: async (_group, content, guard) => { if (await guard()) { sent.push(content); return content; } },
  });
  t.after(() => { conversation.disconnect(); memory.close(); });
  conversation.handle({ chatId: '3', senderId: '2', selfId: '1', messageId: '11', content: '我前面发的图片现在能看到了吗', isMentioned: true });
  await flush(); await flush();
  assert.equal(historyCalls, 1); assert.equal(viewed, 1); assert.equal(generated, 0); assert.deepEqual(sent, ['看见图片了']);
  assert.equal(memory.get('3', '2').length, 2, 'history inspection must not dispatch historical questions');
});
