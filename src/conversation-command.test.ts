import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleConversationCommand, type ConversationCommandServices } from './conversation-command.js';
import type { ChatMessage } from './message.js';

const message = (content: string): ChatMessage => ({ chatId: 'group', senderId: 'owner', content, isMentioned: true });
function services(controlReply?: string) {
  const calls: string[] = [];
  const check = (action: string, group: string, owner: string) => {
    assert.equal(group, 'group'); assert.equal(owner, 'owner'); calls.push(action);
  };
  const ports: ConversationCommandServices = {
    eventMemory: { control: () => { calls.push('control'); return controlReply; } },
    memory: { clear: (group, owner) => check('clear', group, owner) },
    windows: { close: (group, owner) => check('close', group, owner) },
    discussion: { forget: (group, owner) => check('forget', group, owner) },
    log: line => { assert.equal(line, '[记忆] 已清空当前会话。'); calls.push('log'); },
  };
  return { ports, calls };
}

test('combined clearing preserves event control, session clear, close and forget order', () => {
  const { ports, calls } = services('combined acknowledgement');
  assert.deepEqual(handleConversationCommand(message(' /清空记忆 '), ports),
    { content: 'combined acknowledgement', bypassSendReview: true });
  assert.deepEqual(calls, ['control', 'clear', 'close', 'forget']);
});

test('session-only clearing retains ordinary send review and does not forget discussion', () => {
  for (const enabled of [true, false]) {
    const { ports, calls } = services();
    if (!enabled) ports.eventMemory = undefined;
    assert.deepEqual(handleConversationCommand(message('/清空记忆'), ports),
      { content: '已清空你在本群与我的聊天记忆。', bypassSendReview: false });
    assert.deepEqual(calls, [...(enabled ? ['control'] : []), 'clear', 'close', 'log']);
  }
});

test('long-term and preference commands close windows without clearing session history', () => {
  for (const content of ['/清空长期记忆', '/主动关心 开', '/主动关心 关']) {
    const { ports, calls } = services('acknowledgement');
    assert.deepEqual(handleConversationCommand(message(content), ports),
      { content: 'acknowledgement', bypassSendReview: true });
    assert.deepEqual(calls, ['control', 'close']);
  }
});

test('unhandled input falls through and failed event control does not apply later effects', () => {
  const { ports, calls } = services();
  assert.equal(handleConversationCommand(message('hello'), ports), undefined);
  assert.deepEqual(calls, ['control']);
  const failure = new Error('control failed');
  ports.eventMemory = { control: () => { throw failure; } };
  assert.throws(() => handleConversationCommand(message('/清空记忆'), ports), error => error === failure);
  assert.deepEqual(calls, ['control']);
});
