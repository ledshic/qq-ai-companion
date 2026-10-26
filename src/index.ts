import { createPersonalAgent } from './agent.js';
import type { ChatMessage } from './message.js';

const mockMessages: ChatMessage[] = [
  {
    chatId: 'demo-group',
    senderId: 'demo-user',
    content: '@机器人 你好',
    isMentioned: true,
  },
  {
    chatId: 'demo-group',
    senderId: 'demo-user',
    content: '大家好',
    isMentioned: false,
  },
];

// An in-process channel exercises the same Agent as QQ without a connection.
let finish: () => void;
const delivered = new Promise<void>(resolve => { finish = resolve; });
const agent = createPersonalAgent(events => ({
  start: () => {
    events.connected();
    for (const message of mockMessages) events.message(message);
  },
  stop: () => events.disconnected(),
  capture: chatId => ({
    connected: () => true,
    send: async (content, target) => {
      console.log(`[模拟回复] 聊天 ${chatId}: ${content}`);
      events.acknowledged(chatId, content, 'demo-reply', target);
      finish();
      return true;
    },
  }),
}));
agent.start();
try { await delivered; }
finally { agent.stop(); }
