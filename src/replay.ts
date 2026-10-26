// Built-in anonymous fixtures exercise the scheduler without QQ or model calls.
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';

const memory = new ConversationMemory(new SqliteSessionStore(':memory:'));
const output: Array<{ event: string; detail: string }> = [];
const conversation = new Conversation({ unified: true, memory, autoReply: true,
  judgeEvery: { cooldownMs: 45_000, hourlyCap: 1, judge: async ({ text }) => ({ respond: text === '公开求助', reason: text === '公开求助' ? '可以补充' : '群友之间交流', topicKey: '示例话题' }) },
  judge: async text => ({ intent: text === '稍等' ? 'pause' : text === '再见' ? 'end' : 'continue', shouldRespond: !['稍等', '再见'].includes(text), reason: '预设匿名场景' }),
  generate: async (_text, _history, _signal, _tools, context) => `模拟${context!.kind}回复`,
  send: async (_group, text, guard) => { if (!await guard()) return; output.push({ event: 'send', detail: text }); return text; },
  log: detail => output.push({ event: 'decision', detail }),
});
try {
  const events = [
    { sender: 'A', text: '公开求助' }, { sender: 'A', text: '继续追问' },
    { sender: 'B', text: '和C闲聊' }, { sender: 'A', text: '稍等' },
    { sender: 'A', text: '继续追问' }, { sender: 'A', text: '再见' },
  ];
  let id = 0;
  for (const event of events) {
    output.push({ event: 'input', detail: `${event.sender}: ${event.text}` });
    conversation.handle({ chatId: 'demo', senderId: event.sender, senderName: event.sender,
      messageId: String(++id), content: event.text, isMentioned: false });
    await new Promise(setImmediate); await new Promise(setImmediate);
  }
  console.log(JSON.stringify({ mode: 'offline-scripted-decisions', note: '固定判断结果验证调度，不衡量真实模型效果', output }, null, 2));
} finally { conversation.disconnect(); memory.close(); }
