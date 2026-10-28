import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from './conversation.js';
import { FIXED_REPLY } from './fixed-reply.js';
import { ConversationMemory } from '../../memory/memory.js';
import type { ChatMessage } from '../message.js';
import { SqliteSessionStore } from '../../memory/store.js';

const flush = async (): Promise<void> => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

const message = (id: string, addressed: boolean): ChatMessage => ({
  chatId: 'room', senderId: 'user', messageId: id,
  content: addressed ? 'hi' : 'talking to someone else', isMentioned: addressed,
});

test('without a generator only an explicit call sends the fixed reply, and a failed send stores nothing', async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const sent: string[] = [];
  let confirm = true;
  const conversation = new Conversation({
    memory, log: () => {},
    send: async (_chatId, content) => { sent.push(content); return confirm ? content : undefined; },
  });
  try {
    conversation.handle(message('1', false));
    await flush();
    assert.deepEqual(sent, []);
    conversation.handle(message('2', true));
    await flush();
    assert.deepEqual(sent, [FIXED_REPLY]);
    assert.deepEqual(memory.get('room', 'user'), []);
    confirm = false;
    conversation.handle(message('3', true));
    await flush();
    assert.deepEqual(sent, [FIXED_REPLY, FIXED_REPLY]);
    assert.deepEqual(memory.get('room', 'user'), []);
  } finally {
    conversation.disconnect();
    memory.close();
  }
});

test('a configured generator replaces the fixed reply and stores only an acknowledged send', async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  const sent: string[] = [];
  let confirm = true;
  const conversation = new Conversation({
    memory, log: () => {},
    generate: async () => 'model line',
    send: async (_chatId, content) => { sent.push(content); return confirm ? content : undefined; },
  });
  try {
    conversation.handle(message('1', false));
    await flush();
    conversation.handle(message('2', true));
    await flush();
    assert.deepEqual(sent, ['model line']);
    assert.deepEqual(memory.get('room', 'user').map(turn => turn.content), ['hi', 'model line']);
    confirm = false;
    conversation.handle(message('3', true));
    await flush();
    assert.deepEqual(sent, ['model line', 'model line']);
    assert.deepEqual(memory.get('room', 'user').map(turn => turn.content), ['hi', 'model line']);
  } finally {
    conversation.disconnect();
    memory.close();
  }
});
