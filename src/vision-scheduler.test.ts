import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import type { ChatMessage } from './message.js';
import type { VisionHandler } from './vision.js';
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const deferred = () => { let resolve!: (text: string) => void; return { promise: new Promise<string>(done => { resolve = done; }), resolve: (text: string) => resolve(text) }; };
const inbound = (id: string, sender = 'a', explicit = true, picture = true): ChatMessage => ({ chatId: 'g', senderId: sender,
  selfId: 'bot', messageId: id, content: picture ? '看图' : 'new question', isMentioned: explicit,
  hasMedia: picture, attachments: picture ? { imageCount: 1, images: [{ url: 'https://gchat.qpic.cn/a' }] } : undefined });

test('new text from the same author cancels a pending image result without writing stale history', async t => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const pending = deferred(); const sent: string[] = []; let imageSignal: AbortSignal | undefined;
  const conversation = new Conversation({ unified: true, memory, log: () => {},
    vision: async (_text, _image, signal) => { imageSignal = signal; return pending.promise; },
    generate: async () => 'new answer',
    send: async (_group, content, guard) => { if (await guard()) { sent.push(content); return content; } },
  });
  t.after(() => { conversation.disconnect(); memory.close(); });
  conversation.handle(inbound('1')); await flush();
  conversation.handle(inbound('2', 'a', true, false)); assert.equal(imageSignal?.aborted, true);
  pending.resolve('stale image result'); await flush(); await flush();
  assert.deepEqual(sent, ['new answer']);
  assert.deepEqual(memory.get('g', 'a').map(turn => turn.content), ['new question', 'new answer']);
});

test('changed discussion rechecks image results before sending and drops obsolete analysis', async t => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const pending = deferred(); const sent: string[] = []; let rechecks = 0;
  const conversation = new Conversation({ unified: true, memory, log: () => {}, vision: async () => pending.promise,
    generate: async () => 'text answer', judgeEvery: { cooldownMs: 0, hourlyCap: 10, judge: async input => {
      if (input.context?.phase === 'before_send') { rechecks++; return { respond: false, reason: 'already answered' }; }
      return { respond: false, reason: 'ordinary conversation' };
    } },
    send: async (_group, content, guard) => { if (await guard()) { sent.push(content); return content; } },
  });
  t.after(() => { conversation.disconnect(); memory.close(); });
  conversation.handle(inbound('1')); await flush();
  conversation.handle(inbound('2', 'b', false, false)); await flush();
  pending.resolve('late image result'); await flush(); await flush();
  assert.equal(rechecks, 1); assert.deepEqual(sent, []); assert.deepEqual(memory.get('g', 'a'), []);
});

test('a failed send does not save image analysis, URLs or bytes in personal history', async t => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const conversation = new Conversation({ unified: true, memory, log: () => {}, vision: async () => 'visible facts',
    generate: async () => 'text answer', send: async () => undefined });
  t.after(() => { conversation.disconnect(); memory.close(); });
  conversation.handle(inbound('1')); await flush();
  assert.deepEqual(memory.get('g', 'a'), []);
});

test('follow-up images do not silently enable automatic image recognition', async t => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:')); let images = 0;
  const vision: VisionHandler = async () => { images++; return 'image answer'; };
  const conversation = new Conversation({ unified: true, autoReply: true, memory, vision, log: () => {},
    judge: async () => ({ intent: 'continue', shouldRespond: true, reason: 'follow-up' }),
    generate: async () => 'text answer', send: async (_group, content, guard) => await guard() ? content : undefined });
  t.after(() => { conversation.disconnect(); memory.close(); });
  conversation.handle(inbound('1', 'a', true, false)); await flush();
  conversation.handle(inbound('2', 'a', false, true)); await flush();
  assert.equal(images, 0);
});
