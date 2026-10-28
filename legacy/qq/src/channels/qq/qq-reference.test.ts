import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMessageReference } from './onebot.js';

const current = { chatId: '3', senderId: '2', selfId: '1', messageId: '10', content: 'quote', isMentioned: true };
const original = { message_type: 'group', group_id: 3, message_id: -9, sender: { user_id: 77 },
  message: [{ type: 'text', data: { text: 'quoted text' } },
    { type: 'image', data: { url: 'https://gchat.qpic.cn/image', file: 'image.png' } }] };

test('QQ reference decoding emits only normalized text, identity and attachments', () => {
  assert.deepEqual(normalizeMessageReference(original, current), {
    chatId: '3', messageId: '-9', senderId: '77', text: 'quoted text',
    attachments: { imageCount: 1, images: [{ url: 'https://gchat.qpic.cn/image', file: 'image.png' }] },
  });
  for (const data of [null, {}, { ...original, group_id: 4 }, { ...original, sender: { user_id: 'bad' } },
    { ...original, message_id: undefined }, { ...original, message_type: 'private' }]) {
    assert.equal(normalizeMessageReference(data, current), undefined);
  }
});

test('QQ private references require the owner or an outgoing message targeting that owner', () => {
  const message = { ...current, chatId: 'private:2' };
  const incoming = { ...original, message_type: 'private', sender: { user_id: 2 } };
  assert.equal(normalizeMessageReference(incoming, message)?.chatId, 'private:2');
  const outgoing = { ...incoming, sender: { user_id: 1 }, target_id: 2 };
  assert.equal(normalizeMessageReference(outgoing, message)?.senderId, '1');
  assert.equal(normalizeMessageReference({ ...outgoing, target_id: 99 }, message), undefined);
  assert.equal(normalizeMessageReference({ ...incoming, sender: { user_id: 99 } }, message), undefined);
  assert.equal(normalizeMessageReference(original, message), undefined);
});
