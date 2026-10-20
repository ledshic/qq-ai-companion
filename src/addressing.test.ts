import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripBotName } from './addressing.js';
import { parseGroupMessage } from './onebot.js';

test('recognize direct name calls and strip the prefix', () => {
  for (const text of ['大肥鱼，你好', '大肥鱼 你好', ' 大肥鱼：你好', '大肥鱼你好', '小鲸鱼，你好', 'DeepSeek，你好', '蓝色大肥鱼，你好', 'D指导，你好']) {
    assert.equal(stripBotName(text), '你好');
  }
  assert.equal(stripBotName('大肥鱼'), '');
  assert.equal(stripBotName('大肥鱼你觉得呢？'), '你觉得呢？');
  assert.equal(stripBotName('大肥鱼，/清空记忆'), '/清空记忆');
});

test('ignore incidental, quoted and longer-name mentions', () => {
  for (const text of ['小爱，你好', '小爱', '我问过小爱', '“小爱，你好”', '> 小爱，你好', '小爱好者来了', '小爱同学来了', '我问过大肥鱼', '大肥鱼爱好者', '大肥鱼同学来了', '“大肥鱼，你好”']) {
    assert.equal(stripBotName(text), undefined);
  }
  const base = { post_type: 'message', message_type: 'group', self_id: 123, user_id: 456, group_id: 789 };
  const message = parseGroupMessage({ ...base, message: [{ type: 'reply', data: { id: '1', text: '大肥鱼，你好' } }, { type: 'text', data: { text: '他这么说的' } }] });
  assert.equal(message?.isCalledByName, false);
  assert.equal(parseGroupMessage({ ...base, message: [{ type: 'image', data: {} }, { type: 'text', data: { text: '大肥鱼，你好' } }] })?.isCalledByName, false);
});
