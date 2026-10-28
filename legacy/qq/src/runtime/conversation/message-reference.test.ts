import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatContext, type ContextMessage } from './context.js';
import { applyMessageReference, isBotReference, referenceHistorySnapshot } from './message-reference.js';

const current = { chatId: 'workspace/thread', senderId: 'member:alice', selfId: 'agent:me',
  messageId: 'request:uuid', replyMessageId: 'reply:uuid', content: '看看', isMentioned: true };

test('normalized references support opaque platform IDs and enforce chat/message identity', () => {
  const discussion = new ChatContext(); discussion.add(current);
  const reference = { chatId: current.chatId, senderId: current.selfId,
    messageId: current.replyMessageId, text: 'original text' };
  assert.equal(isBotReference(reference, current), true);
  for (const invalid of [{ ...reference, chatId: 'other' }, { ...reference, messageId: 'other' }]) {
    const message = { ...current };
    applyMessageReference(message, invalid, discussion);
    assert.equal('replyToSenderId' in message, false);
    assert.equal(isBotReference(invalid, message), false);
  }
  const message = { ...current, replyToSenderId: '' };
  applyMessageReference(message, reference, discussion);
  assert.equal(message.replyToSenderId, current.selfId);
  assert.equal(discussion.snapshot(current.chatId).messages[0].replyToText, 'original text');
  assert.equal(isBotReference({ ...reference, senderId: 'member:bob' }, current), false);
});

test('normalized history stays anchored, bounded and free of attachment payloads', () => {
  const rows: ContextMessage[] = Array.from({ length: 32 }, (_, index) => ({
    id: `event:${index}`, senderId: current.senderId, role: 'user', text: 'text',
    at: 0, revision: index, mentions: [], media: true, imageCount: 1,
    attachments: { images: [{ url: 'https://example.org/SECRET' }] },
  }));
  const message = { ...current, messageId: 'event:30' };
  const result = referenceHistorySnapshot({ chatId: current.chatId, messages: rows }, message)!;
  assert.equal(result.length, 21);
  assert.equal(result[0].id, 'event:10'); assert.equal(result.at(-1)?.id, 'event:30');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|attachments/);
  assert.equal(referenceHistorySnapshot({ chatId: 'other', messages: rows }, message), undefined);
  assert.equal(referenceHistorySnapshot({ chatId: current.chatId, messages: rows }, { ...message, senderId: 'other' }), undefined);
  assert.equal(referenceHistorySnapshot({ chatId: current.chatId, messages: [rows[30], rows[30]] }, message), undefined);
});
