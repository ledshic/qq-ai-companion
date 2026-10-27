import { createEventMemory } from './events/application.js';
import { createContextAnalyzer } from './context-analysis.js';
import { PersonalityRuntime } from './personality-runtime.js';
import { parsePersonalityMode } from './personality-policy.js';
import { MemeManager, JsonMemeState, loadMemeCatalog } from './memes.js';
import { createVisionReply, createImageRequestJudge } from './vision.js';
import { join } from 'node:path';
import { createFollowUpJudge } from './follow-up.js';
import { createChatJudge } from './chat-judge.js';
import { connectNapCat } from './napcat-client.js';
import { createDeepSeekReply } from './deepseek.js';
import { acquireInstanceLock, instanceDataDir, instanceLockPath } from './lock.js';
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

const personalityMode = parsePersonalityMode(process.env.PERSONALITY_MODE);
const modular = personalityMode === 'modular';
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
const dataDir = instanceDataDir(memoryPath);
let releaseLock: () => void;
try {
  releaseLock = acquireInstanceLock(instanceLockPath(memoryPath));
} catch (error) {
  fail(error instanceof Error ? error.message : '无法获取实例锁。');
}

const personality = llmEnabled && modular ? new PersonalityRuntime(createContextAnalyzer(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash')) : undefined;
console.log(`[人格] mode=${personalityMode}; ${personality ? '语境观察与规则计划已启用，必要时增加一次分析请求。' : '使用原角色卡。'}`);
const visionEnabled = llmEnabled && process.env.VISION_ENABLED === 'true';
let memes: MemeManager | undefined;
if (llmEnabled && process.env.MEMES_ENABLED === 'true') {
  try {
    const catalog = loadMemeCatalog('config/memes/tieba');
    memes = new MemeManager(catalog, process.env.DEEPSEEK_API_KEY!, new JsonMemeState(join(dataDir, 'memes-state.json')),
      readNumber('MEME_REPLY_GAP', 7, 1, 100));
    console.log(`[表情] 已启用，图库 ${catalog.length} 张，${catalog.filter(entry => entry.confidence >= 0.8).length} 张可自动选用；具体选图，按已送达回复控制频率。`);
  } catch { console.error('[表情] 图库或频率状态异常，停用配图，保留文字。'); }
}
const vision = visionEnabled ? createVisionReply(process.env.DEEPSEEK_API_KEY!, process.env.VISION_MODEL || 'deepseek-flash', undefined, undefined, { memesEnabled: !!memes }) : undefined;
const memoryTurns = readNumber('MEMORY_TURNS', 9, 1, 50);
const memory = new ConversationMemory(new SqliteSessionStore(memoryPath), Date.now, 30 * 60_000, memoryTurns);
const generateReply = llmEnabled
  ? createDeepSeekReply(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash', undefined, { turns: memoryTurns, memesEnabled: !!memes, visionEnabled, searchEnabled: process.env.WEB_SEARCH_ENABLED === 'true' })
  : undefined;
console.log(llmEnabled
  ? `[LLM] DeepSeek 已启用，按聊天和用户隔离短期记忆（${memoryPath}），最多 ${memoryTurns} 轮，30 分钟过期。`
  : '[LLM] 未启用，使用固定回复。');
if (llmEnabled) console.log(`[工具] 时间、骰子已启用；联网搜索${process.env.WEB_SEARCH_ENABLED === 'true' ? '已启用' : '未启用'}，仅呼叫与连续对话可用。`);
console.log(`[识图] ${visionEnabled ? '已启用，明确呼叫时关联同条、引用或楼上本人单图；本地不足时按需查历史。' : '未启用。'}`);
const followUpMode = (process.env.FOLLOW_UP_MODE || 'window').trim().toLowerCase();
if (!['window', 'always', 'unified'].includes(followUpMode)) fail('FOLLOW_UP_MODE 只能是 window、always 或 unified。');
const observationEnabled = llmEnabled && followUpMode !== 'always' && process.env.FOLLOW_UP_OBSERVE === 'true';
const autoReplyEnabled = llmEnabled && followUpMode !== 'always' && !observationEnabled && process.env.FOLLOW_UP_AUTO === 'true';
const judgeEvery = (llmEnabled && (followUpMode === 'always' || followUpMode === 'unified'))
  ? {
    judge: createChatJudge(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash', undefined, modular),
    cooldownMs: readNumber('AUTO_REPLY_COOLDOWN_SECONDS', 45, 0, 3600) * 1000,
    hourlyCap: readNumber('AUTO_REPLY_HOURLY_CAP', 12, 1, 200),
  }
  : undefined;
const judge = (observationEnabled || autoReplyEnabled)
  ? createFollowUpJudge(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash', undefined, modular)
  : undefined;
const groupContextMessages = readNumber('GROUP_CONTEXT_MESSAGES', 60, 1, 120);
const groupContextSeconds = readNumber('GROUP_CONTEXT_SECONDS', 300, 10, 3600);
const maxInflight = readNumber('MAX_INFLIGHT', 3, 1, 16);
const maxWindows = readNumber('MAX_WINDOWS', 12, 1, 1000);
const windowSeconds = readNumber('WINDOW_SECONDS', 90, 10, 600);
console.log(followUpMode === 'unified' && judgeEvery
  ? `[接话] 统一调度：呼叫优先，接续窗口 ${windowSeconds} 秒且成功后续期；主动插话冷却 ${judgeEvery.cooldownMs / 1000} 秒，上限 ${judgeEvery.hourlyCap} 次/小时。`
  : judgeEvery
  ? `[接话] 每句判断模式：每个普通群消息都过判断器，冷却 ${judgeEvery.cooldownMs / 1000} 秒，上限 ${judgeEvery.hourlyCap} 次/小时。`
  : observationEnabled ? '[观察] 仅判断不回复。' : autoReplyEnabled ? `[自动接话] 每个用户独立 ${windowSeconds} 秒窗口，最多2次。` : '[接续] 已关闭。');
console.log(judgeEvery
  ? `[并发] 同时最多 ${maxInflight} 个生成任务。`
  : `[并发] 同时最多 ${maxInflight} 个生成任务，最多 ${maxWindows} 个活跃窗口，窗口 ${windowSeconds} 秒。`);

const interjectProbability = readNumber('INTERJECT_PROBABILITY', 0, 0, 1);
const interject = (llmEnabled && !judgeEvery && interjectProbability > 0)
  ? {
    probability: interjectProbability,
    cooldownMs: readNumber('INTERJECT_COOLDOWN_SECONDS', 180, 0, 86_400) * 1000,
  }
  : undefined;
console.log(judgeEvery
  ? '[插话] 已并入每句判断，不再单独掷骰。'
  : interject
    ? `[插话] 已在 ${(interject.probability * 100).toFixed(0)}% 的普通消息上随机参与，同群冷却 ${interject.cooldownMs / 1000} 秒。`
    : '[插话] 已关闭。');

const warmupEnabled = llmEnabled && process.env.WARMUP_ENABLED === 'true';
const warmupHours = readHours(process.env.WARMUP_HOURS || '20-23');
const warmupIdleMinutes = readNumber('WARMUP_IDLE_MINUTES', 45, 1, 1440);
const warmupQuietMinutes = readNumber('WARMUP_QUIET_MINUTES', 20, 0, 1440);
if (warmupEnabled && warmupQuietMinutes > warmupIdleMinutes) fail('WARMUP_QUIET_MINUTES 不能大于 WARMUP_IDLE_MINUTES。');
const warmup = warmupEnabled
  ? {
    probability: readNumber('WARMUP_PROBABILITY', 0.3, 0, 1),
    hours: warmupHours,
    cooldownMs: readNumber('WARMUP_COOLDOWN_MINUTES', 60, 0, 1440) * 60_000,
    idleMs: warmupIdleMinutes * 60_000,
    quietMs: warmupQuietMinutes * 60_000,
  }
  : undefined;
console.log(warmup
  ? `[暖场] 已启用：${warmupHours[0]} 点到 ${warmupHours[1]} 点之间，安静 ${warmupQuietMinutes} 分钟后，且 ${warmupIdleMinutes} 分钟内有具体话题，每轮 ${(warmup.probability * 100).toFixed(0)}% 概率，同群冷却 ${warmup.cooldownMs / 60_000} 分钟。`
  : '[暖场] 已关闭。');

const eventMemory = createEventMemory(process.env);
const stop = connectNapCat(address, process.env.NAPCAT_TOKEN ?? '', generateReply, judge, {
  memes,
  personality,
  eventMemory,
  vision,
  imageRequest: visionEnabled ? createImageRequestJudge(process.env.DEEPSEEK_API_KEY!, process.env.DEEPSEEK_MODEL || 'deepseek-flash') : undefined,
  autoReply: autoReplyEnabled,
  unified: followUpMode === 'unified',
  memory,
  maxInflight,
  maxWindows,
  windowMs: windowSeconds * 1000,
  interject,
  warmup,
  judgeEvery,
  context: { maxMessages: groupContextMessages, ttlMs: groupContextSeconds * 1000 },
});

const tickMs = readNumber('WARMUP_INTERVAL_MINUTES', 30, 1, 1440) * 60_000;
const eventTimer = eventMemory ? setInterval(() => { void eventMemory.tick(); }, 1000) : undefined;
const timer = warmup ? setInterval(() => stop.tick(), tickMs) : undefined;

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  if (eventTimer) clearInterval(eventTimer);
  eventMemory?.close();
  stop();
  memory.close();
  releaseLock();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
