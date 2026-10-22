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

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const readNumber = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} 必须是 ${min} 到 ${max} 之间的数字。`);
  return value;
};

const readHours = (raw: string): [number, number] => {
  const match = /^(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?$/.exec(raw.trim());
  if (!match) fail(`WARMUP_HOURS 格式应为 "20-23" 或 "20:00-23:00"，当前为 "${raw}"。`);
  const start = Number(match![1]);
  const end = Number(match![2]);
  if (start > 23 || end > 24) fail('WARMUP_HOURS 的小时必须在 0 到 24 之间。');
  return [start, end % 24];
};

const memoryPath = process.env.MEMORY_DB || 'data/memory.db';
const dataDir = memoryPath === ':memory:' ? 'data' : dirname(memoryPath);
let releaseLock: () => void;
try {
  releaseLock = acquireInstanceLock(join(dataDir, 'bot.lock'));
} catch (error) {
  fail(error instanceof Error ? error.message : '无法获取实例锁。');
}

const memoryTurns = readNumber('MEMORY_TURNS', 9, 1, 50);
const memory = new ConversationMemory(new SqliteSessionStore(memoryPath), Date.now, 30 * 60_000, memoryTurns);
const generateReply = llmEnabled
  ? createDeepSeekReply(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash', undefined, { turns: memoryTurns })
  : undefined;
console.log(llmEnabled
  ? `[LLM] DeepSeek 已启用，按群和用户隔离记忆（${memoryPath}），最多 ${memoryTurns} 轮，30 分钟过期。`
  : '[LLM] 未启用，使用固定回复。');
if (llmEnabled) console.log('[工具] 已启用 get_current_time、roll_dice，仅明确呼叫时可用。');
const observationEnabled = llmEnabled && process.env.FOLLOW_UP_OBSERVE === 'true';
const autoReplyEnabled = llmEnabled && !observationEnabled && process.env.FOLLOW_UP_AUTO === 'true';
const judge = (observationEnabled || autoReplyEnabled)
  ? createFollowUpJudge(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash')
  : undefined;
const maxInflight = readNumber('MAX_INFLIGHT', 3, 1, 16);
const maxWindows = readNumber('MAX_WINDOWS', 12, 1, 1000);
const windowSeconds = readNumber('WINDOW_SECONDS', 90, 10, 600);
console.log(observationEnabled ? '[观察] 仅判断不回复。' : autoReplyEnabled ? `[自动接话] 每个用户独立 ${windowSeconds} 秒窗口，最多2次。` : '[接续] 已关闭。');
console.log(`[并发] 同时最多 ${maxInflight} 个生成任务，最多 ${maxWindows} 个活跃窗口，窗口 ${windowSeconds} 秒。`);

const interjectProbability = readNumber('INTERJECT_PROBABILITY', 0, 0, 1);
const interject = (llmEnabled && interjectProbability > 0)
  ? {
    probability: interjectProbability,
    cooldownMs: readNumber('INTERJECT_COOLDOWN_SECONDS', 180, 0, 86_400) * 1000,
  }
  : undefined;
console.log(interject
  ? `[插话] 已在 ${(interject.probability * 100).toFixed(0)}% 的普通消息上随机参与，同群冷却 ${interject.cooldownMs / 1000} 秒。`
  : '[插话] 已关闭。');

const warmupEnabled = llmEnabled && process.env.WARMUP_ENABLED === 'true';
const warmupHours = readHours(process.env.WARMUP_HOURS || '20-23');
const warmup = warmupEnabled
  ? {
    probability: readNumber('WARMUP_PROBABILITY', 0.3, 0, 1),
    hours: warmupHours,
    cooldownMs: readNumber('WARMUP_COOLDOWN_MINUTES', 60, 0, 1440) * 60_000,
    idleMs: readNumber('WARMUP_IDLE_MINUTES', 45, 1, 1440) * 60_000,
  }
  : undefined;
console.log(warmup
  ? `[暖场] 已启用：${warmupHours[0]} 点到 ${warmupHours[1]} 点之间，每轮 ${(warmup.probability * 100).toFixed(0)}% 概率，同群冷却 ${warmup.cooldownMs / 60_000} 分钟。`
  : '[暖场] 已关闭。');

const stop = connectNapCat(address, process.env.NAPCAT_TOKEN ?? '', generateReply, judge, {
  autoReply: autoReplyEnabled,
  memory,
  maxInflight,
  maxWindows,
  windowMs: windowSeconds * 1000,
  interject,
  warmup,
});

const tickMs = readNumber('WARMUP_INTERVAL_MINUTES', 30, 1, 1440) * 60_000;
const timer = warmup ? setInterval(() => stop.tick(), tickMs) : undefined;

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  stop();
  memory.close();
  releaseLock();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
