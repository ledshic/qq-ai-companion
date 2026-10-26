import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageReferenceHistory } from './onebot.js';
const current = { chatId: '3', senderId: '2', selfId: '1', messageId: '30', content: '看图', isMentioned: true };
const row = (id: number, user = 2, image = false) => ({ message_type: 'group', group_id: 3, user_id: user, message_id: id,
  sender: { user_id: user }, message: image ? [{ type: 'image', data: { file: 'PRIVATE', url: 'https://gchat.qpic.cn/?SECRET' } }] : [{ type: 'text', data: { text: 'chat' } }] });
test('history is anchored to the actual request and cannot select a later image', () => {
  const result = imageReferenceHistory({ messages: [row(28, 2, true), row(29, 1), row(30), row(31, 2, true)] }, current)!;
  assert.deepEqual(result.map(m => m.id), ['28', '29', '30']); assert.equal(result[1].role, 'assistant');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|qpic.cn/);
});
test('history without a verified current anchor fails closed', () => {
  for (const data of [{}, { messages: [row(29)] }, { messages: [{ ...row(30), group_id: 4 }] }, { messages: [row(30, 4)] }])
    assert.equal(imageReferenceHistory(data, current), undefined);
});
test('mismatched group, author, repeated IDs and malformed historical records fail closed', () => {
  for (const prior of [{ ...row(29), group_id: 4 }, { ...row(29), user_id: 9 }, { ...row(29), message: 'CQ text' }, { ...row(29), message_id: 'invalid' }])
    assert.equal(imageReferenceHistory({ messages: [prior, row(30)] }, current), undefined);
  assert.equal(imageReferenceHistory({ messages: [row(29), row(29), row(30)] }, current), undefined);
});
test('the twenty-floor limit counts all history rows rather than only the authors messages', () => {
  const rows = Array.from({ length: 31 }, (_, i) => row(i));
  const result = imageReferenceHistory({ messages: rows }, current)!;
  assert.equal(result.length, 21); assert.equal(result[0].id, '10');
});
