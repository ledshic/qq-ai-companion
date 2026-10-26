import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateExplicitReply, type ExplicitReplyServices } from './explicit-reply.js';
import type { GroupMessage } from './message.js';
import type { ReplyContext } from './context.js';
import type { ChatTurn } from './memory.js';

const message = (overrides: Partial<GroupMessage> = {}): GroupMessage => ({ groupId: 'group', senderId: 'owner',
  content: ' question ', isMentioned: true, ...overrides });
const context = (): ReplyContext => ({ kind: 'explicit', targetSenderId: 'owner', triggerIds: ['message'],
  snapshot: { groupId: 'group', version: 1, incomingVersion: 1, capturedAt: 1000, messages: [] } });
const history: ChatTurn[] = [{ role: 'user', content: 'previous question' }, { role: 'assistant', content: 'previous answer' }];
const signal = () => new AbortController().signal;
function fixture() {
  const calls: string[] = [];
  const prepared = { ...context(), memoryGuard: () => true };
  const services: ExplicitReplyServices = {
    memory: { get: (group, owner) => {
      assert.equal(group, 'group'); assert.equal(owner, 'owner'); calls.push('history'); return history;
    } },
    prepareContext: async () => { calls.push('prepare'); return prepared; },
    generate: async () => { calls.push('generate'); return 'draft'; },
    vision: async () => { calls.push('vision'); return 'image draft'; },
    log: () => {},
  };
  return { services, calls, prepared };
}

test('text generation enables tools and returns the original prompt for later delivered-text memory', async () => {
  const { services, calls, prepared } = fixture();
  services.prepareContext = async (_context, text, turns, _signal, receipt, image) => {
    calls.push('prepare'); assert.equal(text, 'question'); assert.equal(turns, history);
    assert.equal(receipt, undefined); assert.equal(image, undefined); return prepared;
  };
  services.generate = async (text, turns, _signal, tools, view) => {
    calls.push('generate'); assert.equal(text, 'question'); assert.equal(turns, history);
    assert.equal(tools, true); assert.equal(view, prepared); return 'draft';
  };
  assert.deepEqual(await generateExplicitReply(message(), context(), false, signal(), services),
    { content: 'draft', context: prepared, memoryPrompt: 'question' });
  assert.deepEqual(calls, ['history', 'prepare', 'generate']);
});

test('direct and quoted images use empty preparation history and never invoke text generation', async () => {
  for (const quoted of [true, false]) {
    const { services, calls, prepared } = fixture();
    const image = { file: 'private-image' };
    const attachments = { imageCount: 1, images: [image] };
    services.prepareContext = async (_context, text, turns, _signal, receipt, picture) => {
      calls.push('prepare'); assert.equal(text, 'question'); assert.deepEqual(turns, []);
      assert.equal(receipt, undefined); assert.equal(picture, true); return prepared;
    };
    services.resolveImage = async () => null;
    services.vision = async (text, selected, _signal, view, resolve) => {
      calls.push('vision'); assert.equal(text, 'question'); assert.equal(selected, image);
      assert.equal(view, prepared); assert.equal(resolve, services.resolveImage); return 'image draft';
    };
    const result = await generateExplicitReply(message(quoted ? { quotedAttachments: attachments } : { attachments }),
      context(), false, signal(), services);
    assert.deepEqual(calls, ['prepare', 'vision']);
    assert.equal(result.memoryPrompt, 'question\n[本次附带、引用或明确指向了一张图片；历史只保留文字回答，未保留原图。]');
    assert.doesNotMatch(result.memoryPrompt!, /private-image/);
  }
});

test('bare mentions prepare empty history, disable tools and never return a memory prompt', async () => {
  const { services, calls, prepared } = fixture();
  services.prepareContext = async (_context, text, turns) => {
    calls.push('prepare'); assert.equal(text, ''); assert.deepEqual(turns, []); return prepared;
  };
  services.generate = async (text, turns, _signal, tools, view) => {
    calls.push('generate'); assert.equal(text, ''); assert.equal(turns, history);
    assert.equal(tools, false); assert.equal(view, prepared); return '在呢';
  };
  const result = await generateExplicitReply(message({ content: '  ' }), context(), true, signal(), services);
  assert.deepEqual(result, { content: '在呢', context: prepared });
  assert.deepEqual(calls, ['prepare', 'history', 'generate']);
});

test('local validation retains routing precedence and never reads history or calls a model', async () => {
  for (const input of [
    { msg: message({ content: 'x'.repeat(4001), attachments: { imageCount: 2, images: [] } }), bare: false, reply: /文字太长/ },
    { msg: message({ attachments: { imageCount: 2, images: [] } }), bare: false, reply: /只能看一张/ },
    { msg: message({ replyMessageId: 'quote', content: '这张图片' }), bare: true, reply: /可验证的图片/ },
    { msg: message({ content: '' }), bare: false, reply: /1 至 4000/ },
  ]) {
    const { services, calls } = fixture();
    const result = await generateExplicitReply(input.msg, context(), input.bare, signal(), services);
    assert.match(result.content, input.reply); assert.equal(result.memoryPrompt, undefined); assert.deepEqual(calls, []);
  }
  const { services, calls } = fixture(); services.vision = undefined;
  const result = await generateExplicitReply(message({ attachments: { imageCount: 1, images: [{}] } }), context(), false, signal(), services);
  assert.match(result.content, /没有启用图片理解/); assert.deepEqual(calls, []);
});

test('text and bare failures preserve prepared context but cannot create memory records', async t => {
  t.mock.method(console, 'error', () => {});
  for (const bare of [true, false]) {
    const { services, prepared } = fixture();
    services.generate = async () => { throw Error('provider unavailable'); };
    const result = await generateExplicitReply(message({ content: bare ? '' : 'question' }), context(), bare, signal(), services);
    assert.equal(result.context, prepared); assert.equal(result.memoryPrompt, undefined);
    assert.equal(result.content, bare ? '在，咋了？' : '我暂时没能生成回复，请稍后再试。');
  }
});

test('image failures propagate; cancellations in every generation path never produce fallback replies', async () => {
  const failure = new Error('image failed');
  const image = message({ attachments: { imageCount: 1, images: [{}] } });
  const fixtureImage = fixture(); fixtureImage.services.vision = async () => { throw failure; };
  await assert.rejects(generateExplicitReply(image, context(), false, signal(), fixtureImage.services), error => error === failure);
  for (const route of ['text', 'bare', 'image']) {
    const { services } = fixture(); const controller = new AbortController(), reason = new Error('superseded');
    services.prepareContext = async () => { controller.abort(reason); throw reason; };
    await assert.rejects(generateExplicitReply(route === 'image' ? image : message({ content: route === 'bare' ? '' : 'question' }),
      context(), route === 'bare', controller.signal, services), error => error === reason);
  }
});

test('scheduler records only delivered text and preserves text/image windows versus bare waiting state', async t => {
  const { Conversation } = await import('./conversation.js');
  const { ConversationMemory } = await import('./memory.js');
  const { SqliteSessionStore } = await import('./store.js');
  const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  for (const route of ['text', 'image', 'bare']) {
    const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
    const followups: ReplyContext[] = [];
    const bot = new Conversation({ unified: true, autoReply: true, memory, log: () => {},
      generate: async (_text, _history, _signal, tools) => {
        assert.equal(tools, route !== 'bare'); return 'generated draft';
      },
      vision: async () => 'generated image draft',
      judge: async (_text, _history, _signal, view) => {
        followups.push(view!); return { intent: 'pause', shouldRespond: false, reason: 'wait' };
      },
      send: async (_group, _content, guard) => await guard() ? 'actual delivered prefix' : undefined,
    });
    try {
      bot.handle(message({ messageId: 'initial', selfId: 'bot', content: route === 'bare' ? '' : 'question',
        ...(route === 'image' ? { attachments: { imageCount: 1, images: [{}] } } : {}) }));
      await flush();
      const stored = memory.get('group', 'owner');
      if (route === 'bare') assert.deepEqual(stored, []);
      else {
        assert.equal(stored[1].content, 'actual delivered prefix');
        assert.equal(stored[0].content, route === 'text' ? 'question' :
          'question\n[本次附带、引用或明确指向了一张图片；历史只保留文字回答，未保留原图。]');
      }
      bot.handle(message({ messageId: 'next', selfId: 'bot', isMentioned: false, content: 'follow-up' }));
      await flush();
      assert.equal(followups.length, 1, route);
      assert.equal(followups[0].kind, 'follow-up');
      assert.equal(!!followups[0].awaitingReply, route === 'bare');
    } finally { bot.disconnect(); memory.close(); }
  }
});
