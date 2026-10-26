import type { ReferencedMessage } from './channel.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Conversation } from './conversation.js';
import { ChatContext, modelContext, type ReplyContext } from './context.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import type { ChatJudge } from './chat-judge.js';
import type { FollowUpJudge } from './observation.js';
import type { ChatMessage } from './message.js';
import { parseGroupMessage } from './onebot.js';
import { createChatJudge } from './chat-judge.js';
import { createFollowUpJudge } from './follow-up.js';
import { createDeepSeekReply } from './deepseek.js';

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function harness(t: { after: (fn: () => void) => void }, cap = 10, cooldownMs = 0) {
  let now = 1000, sequence = 0;
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'), () => now);
  const h = {
    toolPermissions: [] as (boolean | undefined)[], sent: [] as string[], logs: [] as string[], generated: [] as ReplyContext[], decisions: [] as ReplyContext[], followDecisions: [] as ReplyContext[],
    groupJudge: (async input => ({ respond: input.text !== 'noise', reason: 'test', topicKey: 'topic-a',
      targetSenderId: input.context?.targetSenderId, basisIds: [...(input.context?.triggerIds ?? [])] })) as ChatJudge,
    followJudge: (async text => ({ intent: text === 'pause' ? 'pause' : text === 'end' ? 'end' : text === 'other' ? 'uncertain' : 'continue',
      shouldRespond: !['pause', 'end', 'other'].includes(text), reason: 'test' })) as FollowUpJudge,
    generate: (async (text: string, _context: ReplyContext, _signal: AbortSignal) => `answer:${text}`),
    lookup: (async (_id: string) => undefined) as (id: string) => Promise<ReferencedMessage | undefined>,
    sendGate: undefined as (() => Promise<void>) | undefined,
    failSend: false,
    sendOverride: undefined as ((text: string, guard: () => boolean | Promise<boolean>) => Promise<string | undefined>) | undefined,
    partial: undefined as string | undefined,
    memory,
  };
  const conversation = new Conversation({ unified: true, memory, autoReply: true, windowMs: 90_000, now: () => now,
    judgeEvery: { cooldownMs, hourlyCap: cap, judge: async (input, signal) => {
      h.decisions.push(input.context!); return h.groupJudge(input, signal);
    } },
    judge: async (text, history, signal, context) => {
      h.followDecisions.push(context!); return h.followJudge(text, history, signal, context);
    },
    generate: async (text, _history, signal, _tools, context) => {
      h.toolPermissions.push(_tools); h.generated.push(context!); return h.generate(text, context!, signal);
    },
    send: async (_group, text, guard) => {
      if (h.sendOverride) return h.sendOverride(text, guard);
      await h.sendGate?.();
      if (!await guard() || h.failSend) return;
      const delivered = h.partial ?? text;
      h.sent.push(delivered); return delivered;
    }, lookup: id => h.lookup(id), log: line => h.logs.push(line),
  });
  t.after(() => { conversation.disconnect(); memory.close(); });
  return Object.assign(h, {
    conversation,
    time: (time: number) => { now = time; },
    input: async (text: string, sender = 'a', explicit = false, overrides: Partial<ChatMessage> = {}) => {
      const message: ChatMessage = { chatId: 'g', senderId: sender, senderName: sender.toUpperCase(), selfId: 'bot',
        messageId: `m${++sequence}`, content: text, isMentioned: explicit, ...overrides };
      conversation.handle(message); await flush(); return message;
    },
  });
}

test('one snapshot with speakers and acknowledged bot replies reaches both judge and generator', async t => {
  const h = harness(t);
  await h.input('noise', 'a');
  await h.input('noise', 'b');
  await h.input('question', 'c');
  const judged = h.decisions.at(-1)!;
  const generated = h.generated.at(-1)!;
  assert.equal(judged.snapshot, generated.snapshot);
  assert.deepEqual(generated.snapshot.messages.map(m => m.senderId), ['a', 'b', 'c']);
  assert.equal(generated.targetSenderId, 'c');
  assert.equal(generated.decision?.reason, 'test');
  await h.input('noise', 'd');
  assert.ok(h.decisions.at(-1)!.snapshot.messages.some(m => m.role === 'assistant' && m.text === 'answer:question'));
  assert.equal(generated.snapshot.messages.length, 3, 'a later message cannot mutate the prior snapshot');
  await h.input('noise', 'a', false, { chatId: 'other' });
  assert.equal(h.decisions.at(-1)!.snapshot.messages.length, 1);
});

test('OneBot retains message ID, sender, timestamp, media and quote/mention metadata', () => {
  const m = parseGroupMessage({ post_type: 'message', message_type: 'group', self_id: 1, user_id: 2,
    group_id: 3, message_id: -42, time: 123, sender: { card: 'A', nickname: 'fallback' }, message: [
      { type: 'reply', data: { id: -7 } }, { type: 'at', data: { qq: 9 } }, { type: 'image', data: { url: 'not-stored' } },
      { type: 'text', data: { text: 'question' } },
    ] })!;
  assert.equal(m.messageId, '-42'); assert.equal(m.senderName, 'A'); assert.equal(m.timestamp, 123000);
  assert.equal(m.replyMessageId, '-7'); assert.deepEqual(m.mentionedIds, ['9']); assert.equal(m.hasMedia, true);
  assert.equal(m.attachments?.images[0].url, 'not-stored');
  const discussion = new ChatContext(); discussion.add(m);
  assert.equal(JSON.stringify(discussion.snapshot(m.chatId)).includes('not-stored'), false);
});

test('continuous follow-ups bypass proactive cooldown/cap and renew past two responses', async t => {
  const h = harness(t, 1, 60_000);
  await h.input('start');
  for (const text of ['one', 'two', 'three', 'four']) await h.input(text);
  assert.equal(h.sent.length, 5);
  assert.equal(h.followDecisions.length, 4);
  assert.equal(h.decisions.length, 1);
  await h.input('new question', 'b');
  assert.equal(h.sent.length, 5);
  assert.ok(h.logs.some(l => l.includes('冷却中')));
  // Rolling expiry is measured from the last successful reply.
  h.time(80_000); await h.input('still here');
  h.time(160_000); await h.input('still continuing');
  assert.equal(h.sent.length, 7);
});

test('explicit calls and their follow-ups remain available after proactive hourly budget is spent', async t => {
  const h = harness(t, 1);
  await h.input('proactive', 'b');
  await h.input('direct', 'a', true);
  await h.input('follow', 'a');
  await h.input('outsider', 'c');
  assert.deepEqual(h.sent, ['answer:proactive', 'answer:direct', 'answer:follow']);
});

test('pause keeps a conversation, end closes it, and uncertain never falls through to interjection', async t => {
  const h = harness(t);
  await h.input('start', 'a', true);
  await h.input('pause'); await h.input('other');
  assert.equal(h.sent.length, 1); assert.equal(h.decisions.length, 0);
  await h.input('resume'); assert.equal(h.sent.length, 2);
  await h.input('end');
  h.groupJudge = async () => ({ respond: false, reason: 'no invitation' });
  await h.input('unaddressed');
  assert.equal(h.followDecisions.length, 4); assert.equal(h.sent.length, 2);
});

test('unrelated member does not cancel a pending follow-up; semantic recheck allows it', async t => {
  const h = harness(t); const draft = deferred<string>();
  await h.input('start', 'a', true);
  h.generate = () => draft.promise;
  await h.input('follow');
  await h.input('noise', 'b');
  draft.resolve('still relevant'); await flush();
  assert.deepEqual(h.sent, ['answer:start', 'still relevant']);
  assert.ok(h.followDecisions.some(c => c.phase === 'before_send' && c.snapshot.messages.some(m => m.senderId === 'b')));
});

for (const reason of ['already answered', 'topic changed']) {
  test(`proactive draft is dropped when discussion is ${reason}`, async t => {
    const h = harness(t); const draft = deferred<string>();
    h.generate = () => draft.promise;
    h.groupJudge = async input => ({ respond: input.context?.phase !== 'before_send', reason, topicKey: 'topic' });
    await h.input('question'); await h.input(reason, 'b');
    draft.resolve('stale answer'); await flush();
    assert.deepEqual(h.sent, []); assert.deepEqual(h.memory.get('g', 'a'), []);
    assert.ok(h.logs.some(l => l.includes('[时机]')));
  });
}

test('irrelevant member does not cancel an explicit response', async t => {
  const h = harness(t); const draft = deferred<string>();
  h.generate = () => draft.promise;
  await h.input('direct', 'a', true); await h.input('noise', 'b');
  h.groupJudge = async () => ({ respond: true, reason: 'original question remains open' });
  draft.resolve('answer to A'); await flush();
  assert.deepEqual(h.sent, ['answer to A']);
});

test('new pause from the target cancels an old draft without consuming memory or window quota', async t => {
  const h = harness(t); const draft = deferred<string>(); let oldSignal: AbortSignal | undefined;
  await h.input('start', 'a', true);
  h.generate = (_text, _ctx, signal) => { oldSignal = signal; return draft.promise; };
  await h.input('follow'); await h.input('pause');
  assert.equal(oldSignal?.aborted, true);
  draft.resolve('obsolete'); await flush();
  assert.deepEqual(h.sent, ['answer:start']); assert.equal(h.memory.get('g', 'a').length, 2);
  h.generate = async text => `answer:${text}`;
  await h.input('resume'); assert.equal(h.sent.length, 2);
});

test('send queue rechecks a proactive guard after new messages, without committing a stale draft', async t => {
  const h = harness(t); const gate = deferred<void>();
  h.groupJudge = async input => ({ respond: input.context?.phase !== 'before_send', reason: 'B already answered' });
  h.sendGate = () => gate.promise;
  await h.input('question');
  await h.input('noise', 'b');
  gate.resolve(); await flush();
  assert.deepEqual(h.sent, []); assert.deepEqual(h.memory.get('g', 'a'), []);
});

test('a second discussion change during semantic recheck fails closed', async t => {
  const h = harness(t); const draft = deferred<string>(); const review = deferred<{respond: boolean; reason: string}>();
  h.generate = () => draft.promise;
  h.groupJudge = async input => input.context?.phase === 'before_send' ? review.promise : ({ respond: true, reason: 'initial' });
  await h.input('question'); await h.input('noise', 'b');
  draft.resolve('draft'); await flush(); await h.input('noise', 'c');
  review.resolve({ respond: true, reason: 'too late' }); await flush();
  assert.equal(h.sent.length, 0);
});

test('same unacknowledged topic is not repeated until someone explicitly responds', async t => {
  const h = harness(t);
  await h.input('question', 'a');
  await h.input('same topic', 'b');
  assert.equal(h.sent.length, 1); assert.ok(h.logs.some(l => l.includes('同一话题')));
  await h.input('responding to bot', 'c', true);
  await h.input('topic continues', 'd');
  assert.equal(h.sent.length, 3);
});

test('quoted other member and unresolved quote do not wake an explicit or follow-up reply', async t => {
  const h = harness(t);
  await h.input('start', 'a', true);
  h.lookup = async id => id === 'missing' ? undefined : ({ chatId: 'g', messageId: id, senderId: '99' });
  h.groupJudge = async () => ({ respond: false, reason: 'quoted elsewhere' });
  await h.input('reply to another person', 'a', false, { replyMessageId: 'other' });
  await h.input('unknown reply', 'b', false, { replyMessageId: 'missing' });
  assert.equal(h.sent.length, 1); assert.equal(h.followDecisions.length, 0);
});

test('verified bot quote records the target and wakes the bot', async t => {
  const h = harness(t);
  h.lookup = async id => ({ chatId: 'g', messageId: id, senderId: 'bot' });
  h.groupJudge = async () => ({ respond: false, reason: 'unresolved quote is not an invitation' });
  // Actual OneBot IDs are numeric; retain those identities for reference validation.
  await h.input('quote', 'a', false, { selfId: '123', replyMessageId: '7' });
  assert.equal(h.sent.length, 0, 'unvalidated non-numeric sender does not become explicit');
  h.lookup = async id => ({ chatId: 'g', messageId: id, senderId: '123' });
  await h.input('quote', 'a', false, { selfId: '123', replyMessageId: '8' });
  assert.equal(h.sent.length, 1);
  assert.equal(h.generated.at(-1)!.snapshot.messages.at(-1)!.replyToSenderId, '123');
});

test('late quote lookup after disconnect cannot restart scheduling', async t => {
  const h = harness(t); const lookup = deferred<ReferencedMessage | undefined>(); h.lookup = () => lookup.promise;
  await h.input('quote', 'a', false, { selfId: '123', replyMessageId: '8' });
  h.conversation.disconnect();
  lookup.resolve({ chatId: 'g', messageId: '8', senderId: '123' }); await flush();
  assert.equal(h.sent.length, 0); assert.equal(h.generated.length, 0);
});

test('event IDs deduplicate before memory/window side effects and across reconnects', async t => {
  const h = harness(t);
  const message = await h.input('direct', 'a', true);
  h.conversation.handle({ ...message }); await flush();
  h.conversation.disconnect(); h.conversation.handle({ ...message }); await flush();
  assert.equal(h.sent.length, 1); assert.equal(h.memory.get('g', 'a').length, 2);
  await h.input('other group', 'a', true, { messageId: message.messageId, chatId: 'other' });
  assert.equal(h.sent.length, 2);
});

test('failed delivery does not consume budget; only successful partial text enters discussion/memory', async t => {
  const h = harness(t, 1);
  h.failSend = true; await h.input('first');
  h.failSend = false; h.partial = 'first delivered part'; await h.input('second', 'b');
  assert.deepEqual(h.memory.get('g', 'b').map(m => m.content), ['second', 'first delivered part']);
  await h.input('follow', 'b');
  assert.ok(h.followDecisions.at(-1)!.snapshot.messages.some(m => m.role === 'assistant' && m.text === 'first delivered part'));
  assert.equal(h.followDecisions.at(-1)!.snapshot.messages.some(m => m.role === 'assistant' && m.text === 'answer:first'), false);
});

test('group snapshots prune expired text on reads and enforce length/count bounds', () => {
  let now = 100; const ctx = new ChatContext(() => now, 3, 1000, 2, 8);
  for (let i = 0; i < 5; i++) ctx.add({ chatId: 'g', senderId: 'a', content: '1234', isMentioned: false, messageId: String(i) });
  assert.equal(ctx.snapshot('g').messages.length, 2);
  const frozen = ctx.snapshot('g'); assert.equal(Object.isFrozen(frozen.messages[0]), true);
  now = 1101; assert.equal(ctx.snapshot('g').messages.length, 0);
});

test('actual generation API receives group metadata as data, distinct from personal history', async () => {
  const context: ReplyContext = { kind: 'follow-up', targetSenderId: 'a', triggerIds: ['1'], snapshot: {
    chatId: 'g', version: 1, incomingVersion: 1, capturedAt: 1, messages: [{ id: '1', senderId: 'b', role: 'user', text: 'B said this', at: 1, revision: 1, mentions: [], media: false }],
  } };
  const reply = createDeepSeekReply('test-key', undefined, async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    assert.equal(JSON.parse(body.messages[1].content).discussionContext.targetSenderId, 'person-2');
    assert.deepEqual(body.messages.slice(2), [{ role: 'user', content: 'personal' }, { role: 'user', content: 'follow' }]);
    return Response.json({ choices: [{ message: { content: 'answer' } }] });
  });
  assert.equal(await reply('follow', [{ role: 'user', content: 'personal' }], undefined, false, context), 'answer');
});

test('judge and follow-up request include context; fabricated basis/target fail closed', async () => {
  const context: ReplyContext = { kind: 'interject', targetSenderId: 'a', triggerIds: ['1'], snapshot: {
    chatId: 'g', version: 1, incomingVersion: 1, capturedAt: 1, messages: [{ id: '1', senderId: 'a', role: 'user', text: 'question', at: 1, revision: 1, mentions: [], media: false }],
  } };
  const result = { respond: true, reason: 'test', topicKey: 'topic', targetSenderId: 'a', basisIds: ['1'] };
  const mock = (data: unknown): typeof fetch => async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    assert.equal(body.model, 'deepseek-flash');
    const external = JSON.parse(body.messages[1].content).discussionContext;
    assert.deepEqual(external, JSON.parse(JSON.stringify(modelContext(context).context)));
    const value = data as Record<string, unknown>;
    const mapped = 'respond' in value ? { ...value,
      targetSenderId: value.targetSenderId === 'a' ? external.targetSenderId : value.targetSenderId,
      basisIds: Array.isArray(value.basisIds) ? value.basisIds.map(id => id === '1' ? external.snapshot.messages[0].id : id) : value.basisIds } : value;
    return Response.json({ choices: [{ message: { content: JSON.stringify(mapped) } }] });
  };
  assert.deepEqual(await createChatJudge('key', undefined, mock(result))({ text: 'q', recent: '', history: [], context }), result);
  for (const invalid of [{ ...result, targetSenderId: 'b' }, { ...result, basisIds: ['made-up'] }]) {
    await assert.rejects(createChatJudge('key', undefined, mock(invalid))({ text: 'q', recent: '', history: [], context }));
  }
  const follow = await createFollowUpJudge('key', undefined, mock({ intent: 'pause', shouldRespond: false, reason: 'pause' }))('wait', [], undefined, context);
  assert.equal(follow.intent, 'pause');
});


test('an addition before the first explicit reply retains the original question in shared context', async t => {
  const h = harness(t); const draft = deferred<string>();
  h.generate = () => draft.promise;
  await h.input('original question', 'a', true);
  await h.input('additional constraint');
  h.generate = async (_text, context) => {
    assert.ok(context.snapshot.messages.some(m => m.text === 'original question'));
    assert.equal(context.awaitingReply, true);
    return 'combined answer';
  };
  draft.resolve('obsolete original'); await flush();
  assert.deepEqual(h.sent, ['combined answer']);
});

test('pause before an initial explicit answer cancels the draft without generating a replacement', async t => {
  const h = harness(t); const draft = deferred<string>();
  h.generate = () => draft.promise;
  await h.input('original question', 'a', true); await h.input('pause');
  draft.resolve('obsolete'); await flush();
  assert.deepEqual(h.sent, []); assert.equal(h.generated.length, 1);
  assert.equal(h.followDecisions.at(-1)?.awaitingReply, true);
});


test('pause before an initial answer preserves the pending relationship for a later resume', async t => {
  const h = harness(t); const draft = deferred<string>();
  h.generate = () => draft.promise;
  await h.input('original question', 'a', true); await h.input('pause');
  draft.resolve('obsolete'); await flush();
  h.generate = async (_text, ctx) => {
    assert.ok(ctx.snapshot.messages.some(m => m.text === 'original question'));
    return 'resumed answer';
  };
  await h.input('resume');
  assert.deepEqual(h.sent, ['resumed answer']);
});

test('proactive hourly budget survives a transient disconnect', async t => {
  const h = harness(t, 1);
  await h.input('one'); h.conversation.disconnect(); await h.input('two', 'b');
  assert.equal(h.sent.length, 1);
});


test('a response during segmented delivery survives participation bookkeeping', async t => {
  const h = harness(t); const delivery = deferred<string>(); let first = true;
  h.sendOverride = async (text, guard) => {
    if (!await guard()) return;
    if (first) { first = false; h.sent.push('first part'); return delivery.promise; }
    h.sent.push(text); return text;
  };
  await h.input('question', 'a');
  await h.input('responding to bot', 'b', true);
  delivery.resolve('first part'); await flush();
  await h.input('same topic', 'c');
  assert.equal(h.sent.length, 3);
  assert.equal(h.decisions.at(-1)!.snapshot.participation?.responded, true);
});

test('a message addressed to another member before an initial answer never triggers continuation', async t => {
  const h = harness(t); const draft = deferred<string>();
  h.generate = () => draft.promise;
  await h.input('question', 'a', true);
  await h.input('for B', 'a', false, { hasAnyMention: true, mentionedIds: ['b'] });
  draft.resolve('obsolete'); await flush();
  assert.equal(h.followDecisions.length, 0); assert.equal(h.sent.length, 0);
});

test('an unresolved quote during an active conversation does not automatically continue it', async t => {
  const h = harness(t); await h.input('start', 'a', true);
  await h.input('quote', 'a', false, { replyMessageId: 'missing' });
  assert.equal(h.followDecisions.length, 0); assert.equal(h.sent.length, 1);
});


test('an addressed quote establishes the relationship before a slow lookup and preserves additions', async t => {
  const h = harness(t); const lookup = deferred<ReferencedMessage | undefined>(); h.lookup = () => lookup.promise;
  h.groupJudge = async () => ({ respond: false, reason: 'proactive reply is forbidden' });
  await h.input('original question', 'a', true, { selfId: '123', replyMessageId: '8' });
  await h.input('additional constraint', 'a');
  lookup.resolve({ chatId: 'g', messageId: '8', senderId: '99', text: 'original reference' });
  await flush();
  assert.deepEqual(h.sent, ['answer:additional constraint']);
  const ctx = h.generated.at(-1)!;
  assert.equal(ctx.kind, 'follow-up'); assert.equal(ctx.awaitingReply, true);
  assert.ok(ctx.snapshot.messages.some(m => m.text === 'original question' && m.replyToText === 'original reference'));
  assert.equal(h.decisions.length, 0);
});

test('a quote lookup failure cannot suppress an explicit call', async t => {
  const h = harness(t); h.lookup = async () => { throw new Error('lookup unavailable'); };
  await h.input('direct question', 'a', true, { replyMessageId: 'missing' });
  assert.deepEqual(h.sent, ['answer:direct question']);
});


test('follow-up queued behind delivery is rechecked when another member answers', async t => {
  const h = harness(t); await h.input('start', 'a', true); const gate = deferred<void>();
  h.sendGate = () => gate.promise;
  h.followJudge = async (_text, _history, _signal, context) => context?.phase === 'before_send'
    ? { intent: 'uncertain', shouldRespond: false, reason: 'B has answered' }
    : { intent: 'continue', shouldRespond: true, reason: 'initial follow-up' };
  await h.input('follow'); await h.input('noise', 'b');
  gate.resolve(); await flush();
  assert.deepEqual(h.sent, ['answer:start']); assert.equal(h.memory.get('g', 'a').length, 2);
  assert.ok(h.followDecisions.some(c => c.phase === 'before_send'));
});


test('model payload aliases account/group/message identifiers while preserving reference relationships', () => {
  const context: ReplyContext = { kind: 'explicit', targetSenderId: '22222222', triggerIds: ['33333333'], snapshot: {
    chatId: '11111111', version: 1, incomingVersion: 1, capturedAt: 1,
    messages: [{ id: '33333333', senderId: '22222222', role: 'user', text: 'hello', at: 1, revision: 1,
      replyTo: '44444444', replyToSenderId: '55555555', mentions: ['55555555'], media: false }],
  } };
  const external = modelContext(context);
  const serialized = JSON.stringify(external.context);
  for (const id of ['11111111','22222222','33333333','44444444','55555555']) assert.equal(serialized.includes(id), false);
  assert.equal(external.context.targetSenderId, external.context.snapshot.messages[0].senderId);
  assert.equal(external.context.snapshot.messages[0].replyToSenderId, external.context.snapshot.messages[0].mentions[0]);
  assert.equal(external.messageIds.get(external.context.triggerIds[0]), '33333333');
});


test('negative model decisions remain useful without fabricated topic or target evidence', async () => {
  const ctx = new ChatContext(); ctx.add({ chatId: 'g', senderId: 'a', messageId: '1', content: 'noise', isMentioned: false });
  const context: ReplyContext = { kind: 'interject', targetSenderId: 'a', triggerIds: ['1'], snapshot: ctx.snapshot('g') };
  const judge = createChatJudge('test-key', undefined, async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ respond: false, reason: 'another conversation' }) } }] }));
  assert.deepEqual(await judge({ text: 'noise', recent: '', history: [], context }), { respond: false, reason: 'another conversation' });
});

test('legacy interjection and warmup prompt text also uses identifier aliases', async t => {
  const memory = new ConversationMemory(new SqliteSessionStore(':memory:'), () => 0);
  const prompts: string[] = [];
  const conversation = new Conversation({ memory, now: () => 0, random: () => 0,
    interject: { probability: 1, cooldownMs: 0 },
    warmup: { probability: 1, cooldownMs: 0, idleMs: 60_000, hours: [0, 0] },
    generate: async text => { prompts.push(text); return 'reply'; },
    send: async (_group, text, guard) => await guard() ? text : undefined,
  });
  t.after(() => { conversation.disconnect(); memory.close(); });
  conversation.handle({ chatId: '11111111', senderId: '22222222', selfId: '99999999', messageId: '33333333', content: 'hello', isMentioned: false });
  await flush(); conversation.tick(); await flush();
  assert.equal(prompts.length, 2);
  for (const text of prompts) for (const id of ['11111111','22222222','33333333','99999999']) assert.equal(text.includes(id), false);
});


for (const text of ['', ' \n\t ']) {
  test(`bare mention ${JSON.stringify(text)} acknowledges through model without personal memory writes and accepts the next question`, async t => {
    const h = harness(t);
    await h.input(text, 'a', true);
    assert.deepEqual(h.sent, ['answer:']);
    assert.equal(h.toolPermissions.at(-1), false);
    assert.equal(h.generated.length, 1); assert.equal(h.decisions.length, 0);
    assert.deepEqual(h.memory.get('g', 'a'), []);
    await h.input('actual question');
    assert.deepEqual(h.sent, ['answer:', 'answer:actual question']);
    assert.equal(h.followDecisions.length, 1); assert.equal(h.followDecisions[0].awaitingReply, true);
    assert.deepEqual(h.memory.get('g', 'a').map(turn => turn.content), ['actual question', 'answer:actual question']);
  });
}


test('search tools are allowed for explicit calls and follow-ups including after bare mention, never proactive', async t => {
  const h = harness(t);
  await h.input('question', 'a');
  assert.equal(h.toolPermissions.at(-1), false);
  await h.input('explicit', 'b', true);
  assert.equal(h.toolPermissions.at(-1), true);
  await h.input('followup', 'b');
  assert.equal(h.toolPermissions.at(-1), true);
  await h.input('', 'c', true);
  await h.input('search public facts', 'c');
  assert.equal(h.toolPermissions.at(-1), true);
});


test('bare mention model failure retains acknowledgement and next-question state', async t => {
  const h = harness(t);
  h.generate = async () => { throw new Error('provider failure'); };
  await h.input('', 'a', true);
  assert.deepEqual(h.sent, ['在，咋了？']);
  assert.deepEqual(h.memory.get('g', 'a'), []);
  h.generate = async text => `answer:${text}`;
  await h.input('actual question');
  assert.equal(h.sent.at(-1), 'answer:actual question');
  assert.equal(h.followDecisions.at(-1)?.awaitingReply, true);
});

test('a slow bare mention acknowledgement is discarded when the real question arrives', async t => {
  const h = harness(t); const pending = deferred<string>();
  h.generate = async text => text ? `answer:${text}` : pending.promise;
  await h.input('', 'a', true);
  await h.input('real question', 'a');
  pending.resolve('late acknowledgement'); await flush(); await flush();
  assert.deepEqual(h.sent, ['answer:real question']);
  assert.deepEqual(h.memory.get('g', 'a').map(turn => turn.content), ['real question', 'answer:real question']);
});
