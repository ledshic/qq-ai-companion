import { dirname, join } from 'node:path';
import { createFollowUpJudge } from './follow-up.js';
import { connectNapCat } from './napcat-client.js';
import { createDeepSeekReply } from './deepseek.js';
import { acquireInstanceLock } from './lock.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';

const address = process.env.NAPCAT_WS_URL;
if (!address) {
  console.error('请先在 .env 中设置 NAPCAT_WS_URL（参考 .env.example）。');
  process.exit(1);
}

try {
  const url = new URL(address);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid URL');
  }
} catch {
  console.error('NAPCAT_WS_URL 必须是 ws:// 或 wss:// 地址；Token 请单独配置。');
  process.exit(1);
}

const llmEnabled = process.env.LLM_ENABLED === 'true';
if (llmEnabled && !process.env.DEEPSEEK_API_KEY?.trim()) {
  console.error('LLM_ENABLED=true 时必须配置 DEEPSEEK_API_KEY。');
  process.exit(1);
}

const memoryPath = process.env.MEMORY_DB || 'data/memory.db';
const dataDir = memoryPath === ':memory:' ? 'data' : dirname(memoryPath);
let releaseLock: () => void;
try {
  releaseLock = acquireInstanceLock(join(dataDir, 'bot.lock'));
} catch (error) {
  console.error(error instanceof Error ? error.message : '无法获取实例锁。');
  process.exit(1);
}

const memory = new ConversationMemory(new SqliteSessionStore(memoryPath));
const generateReply = llmEnabled
  ? createDeepSeekReply(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash')
  : undefined;
console.log(llmEnabled
  ? `[LLM] DeepSeek 已启用，按群和用户隔离记忆（${memoryPath}），最多 6 轮，30 分钟过期。`
  : '[LLM] 未启用，使用固定回复。');
const observationEnabled = llmEnabled && process.env.FOLLOW_UP_OBSERVE === 'true';
const autoReplyEnabled = llmEnabled && !observationEnabled && process.env.FOLLOW_UP_AUTO === 'true';
const judge = (observationEnabled || autoReplyEnabled)
  ? createFollowUpJudge(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash')
  : undefined;
console.log(observationEnabled ? '[观察] 仅判断不回复。' : autoReplyEnabled ? '[自动接话] 每个用户独立60秒窗口，最多2次。' : '[接续] 已关闭。');
const stop = connectNapCat(address, process.env.NAPCAT_TOKEN ?? '', generateReply, judge, { autoReply: autoReplyEnabled, memory });

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  stop();
  memory.close();
  releaseLock();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
