import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import type { ChatMessage } from './message.js';
import { SqliteSessionStore } from './store.js';
import { deliverPersonaReply } from './delivery.js';
import { createReplyDelivery } from './reply-delivery.js';

const flush = async (): Promise<void> => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};

const minute = 60_000;

test('warmup waits for a quiet gap and a retained concrete topic, then leaves follow-ups alone', async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  let now = 1_000_000;
  const prompts: string[] = [];
  const sent: string[] = [];
  const conversation = new Conversation({
    memory, unified: true, autoReply: true, now: () => now, random: () => 0, log: () => {},
    context: { maxMessages: 60, ttlMs: 5 * minute },
    warmup: { probability: 1, hours: [0, 0], cooldownMs: 60 * minute, idleMs: 45 * minute, quietMs: 20 * minute },
    judge: async () => ({ intent: 'continue', shouldRespond: true, reason: 'follow' }),
    generate: async text => { prompts.push(text); return 'reply'; },
    send: async (_chatId, content, guard) => await guard() ? (sent.push(content), content) : undefined,
  });
  const say = (id: string, content: string, addressed = false): void => {
    const message: ChatMessage = { chatId: 'room', senderId: 'user', messageId: id, content, isMentioned: addressed, timestamp: now };
    conversation.handle(message);
  };
  try {
    say('1', '明天考试怎么复习');
    conversation.tick();
    await flush();
    assert.deepEqual(sent, []);
    now += 6 * minute;
    conversation.tick();
    await flush();
    assert.deepEqual(sent, [], 'six minutes is still inside the quiet gap, and the short snapshot has not expired the topic');
    now += 15 * minute;
    conversation.tick();
    await flush();
    assert.equal(sent.length, 1);
    assert.match(prompts[0], /明天考试怎么复习/);
    assert.match(prompts[0], /暖场/);
    say('2', '在吗', true);
    await flush();
    say('3', '那我带什么');
    await flush();
    assert.equal(sent.length, 3);
    conversation.tick();
    await flush();
    assert.equal(sent.length, 3);
  } finally {
    conversation.disconnect();
    memory.close();
  }
});

test('warmup stays quiet for an empty chat, a private chat, and a line with no concrete topic', async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  let now = 1_000_000;
  const sent: string[] = [];
  const conversation = new Conversation({
    memory, now: () => now, random: () => 0, log: () => {},
    warmup: { probability: 1, hours: [0, 0], cooldownMs: 0, idleMs: 45 * minute, quietMs: 20 * minute },
    generate: async () => 'reply',
    send: async (_chatId, content, guard) => await guard() ? (sent.push(content), content) : undefined,
  });
  try {
    conversation.tick();
    conversation.handle({ chatId: 'private:7', senderId: '7', messageId: 'p', content: '私聊里说明天考试', isMentioned: false, timestamp: now });
    conversation.handle({ chatId: 'room', senderId: 'user', messageId: 'b', content: '。', isMentioned: false, timestamp: now });
    now += 21 * minute;
    conversation.tick();
    await flush();
    assert.deepEqual(sent, []);
  } finally {
    conversation.disconnect();
    memory.close();
  }
});

for (const activity of ['own-ack', 'user-message', 'other-reply', 'disconnect'] as const) {
  test(`multi-part warmup handles ${activity} between acknowledged parts`, async () => {
    const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
    let now = 1_000_000;
    const sent: string[] = [];
    let delivered: string | undefined;
    const conversation = new Conversation({ memory, recordsDelivery: true, unified: true,
      now: () => now, random: () => 0, log: () => {},
      warmup: { probability: 1, hours: [0, 0], cooldownMs: 60 * minute, idleMs: 45 * minute, quietMs: 20 * minute },
      generate: async () => '第一句\n第二句\n第三句',
      send: async (chatId, content, guard) => {
        delivered = await deliverPersonaReply(content, async part => {
          sent.push(part);
          conversation.acknowledged(chatId, part, `part-${sent.length}`);
          return true;
        }, guard, async () => {
          now++;
          if (activity === 'user-message') conversation.handle({ chatId, senderId: 'other', messageId: 'new',
            content: '已经换话题了', isMentioned: false, timestamp: now });
          if (activity === 'other-reply') conversation.acknowledged(chatId, '另一条回复', 'other', { senderId: 'other' });
          if (activity === 'disconnect') conversation.disconnect();
        });
        return delivered;
      },
    });
    try {
      conversation.handle({ chatId: 'room', senderId: 'user', messageId: 'topic', content: '明天考试怎么复习', isMentioned: false, timestamp: now });
      now += 21 * minute;
      conversation.tick(); await flush(); await flush();
      const expected = activity === 'own-ack' ? ['第一句', '第二句', '第三句'] : ['第一句'];
      assert.deepEqual(sent, expected);
      assert.equal(delivered, expected.join('\n'), 'partial delivery must retain exactly the confirmed text');
    } finally { conversation.disconnect(); memory.close(); }
  });
}

test('production delivery queue continues a warmup after its own confirmation', { timeout: 5000 }, async () => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
  let now = 1_000_000;
  const sent: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const delivery = createReplyDelivery(chatId => ({ connected: () => true,
    send: async (text, target) => { sent.push(text); conversation.acknowledged(chatId, text, `part-${sent.length}`, target); return true; },
  }));
  const conversation = new Conversation({ memory, recordsDelivery: true, unified: true,
    now: () => now, random: () => 0, log: () => {},
    warmup: { probability: 1, hours: [0, 0], cooldownMs: 60 * minute, idleMs: 45 * minute, quietMs: 20 * minute },
    generate: async () => '第一句\n第二句',
    send: async (...args) => { try { return await delivery(...args); } finally { finish(); } },
  });
  try {
    conversation.handle({ chatId: 'room', senderId: 'user', messageId: 'topic', content: '明天考试怎么复习', isMentioned: false, timestamp: now });
    now += 21 * minute; conversation.tick(); await done;
    assert.deepEqual(sent, ['第一句', '第二句']);
  } finally { conversation.disconnect(); memory.close(); }
});
