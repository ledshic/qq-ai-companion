import { handleGroupMessage, type GroupMessage } from './message.js';

const mockMessages: GroupMessage[] = [
  {
    groupId: 'demo-group',
    senderId: 'demo-user',
    content: '@机器人 你好',
    isMentioned: true,
  },
  {
    groupId: 'demo-group',
    senderId: 'demo-user',
    content: '大家好',
    isMentioned: false,
  },
];

for (const message of mockMessages) {
  console.log(`[收到消息] 群 ${message.groupId} / 用户 ${message.senderId}: ${message.content}`);

  const reply = handleGroupMessage(message);
  if (reply === null) {
    console.log('[处理结果] 未被 @，不回复。');
    continue;
  }

  console.log(`[模拟回复] 群 ${reply.groupId}: ${reply.content}`);
}
