import { Semaphore } from '../shared/semaphore.js';
import { createConsoleReply } from '../channels/console/generator.js';
import { createEventMemory } from '../memory/events/application.js';
import { createContextAnalyzer } from '../cognitive/context-analysis.js';
import { PersonalityRuntime } from '../cognitive/personality/personality-runtime.js';
import { parsePersonalityMode } from '../cognitive/personality/personality-policy.js';
import {
  MemeManager,
  JsonMemeState,
  loadMemeCatalog,
} from '../tools/memes/memes.js';
import {
  createVisionReply,
  createImageRequestJudge,
} from '../tools/vision/vision.js';
import { join, resolve } from 'node:path';
import { createFollowUpJudge } from '../cognitive/follow-up.js';
import { createChatJudge } from '../cognitive/chat-judge.js';
import { connectNapCat } from '../channels/qq/napcat-client.js';
import { createDeepSeekReply } from '../cognitive/models/deepseek.js';
import {
  acquireInstanceLock,
  instanceDataDir,
  instanceLockPath,
} from '../runtime/lock.js';
import { ConversationMemory } from '../memory/memory.js';
import { SqliteSessionStore } from '../memory/store.js';

const heldLocks = new Set<string>();

export function bootstrapAgent(env: NodeJS.ProcessEnv = process.env) {
  const cleanup: (() => void)[] = [];
  const defer = (action: () => void) => cleanup.push(action);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const action of cleanup.reverse()) {
      try {
        action();
      } catch {
        console.error('[宿主] resource_close_failed');
      }
    }
  };
  try {
    const address = env.NAPCAT_WS_URL;

    if (address)
      try {
        const url = new URL(address);
        if (
          !['ws:', 'wss:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        ) {
          throw new Error('invalid URL');
        }
      } catch {
        throw Error(
          'NAPCAT_WS_URL 必须是 ws:// 或 wss:// 地址；Token 请单独配置。',
        );
      }

    const personalityMode = parsePersonalityMode(env.PERSONALITY_MODE);
    const modular = personalityMode === 'modular';
    const llmEnabled = env.LLM_ENABLED === 'true';
    if (llmEnabled && !env.DEEPSEEK_API_KEY?.trim()) {
      throw Error('LLM_ENABLED=true 时必须配置 DEEPSEEK_API_KEY。');
    }

    const fail = (message: string): never => {
      throw Error(message);
    };

    const readNumber = (
      name: string,
      fallback: number,
      min: number,
      max: number,
    ): number => {
      const raw = env[name];
      if (raw === undefined || raw.trim() === '') return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max)
        fail(`${name} 必须是 ${min} 到 ${max} 之间的数字。`);
      return value;
    };

    const readHours = (raw: string): [number, number] => {
      const match = /^(\d{1,2})(?::\d{2})?\s*-\s*(\d{1,2})(?::\d{2})?$/.exec(
        raw.trim(),
      );
      if (!match)
        fail(
          `WARMUP_HOURS 格式应为 "20-23" 或 "20:00-23:00"，当前为 "${raw}"。`,
        );
      const start = Number(match![1]);
      const end = Number(match![2]);
      if (start > 23 || end > 24)
        fail('WARMUP_HOURS 的小时必须在 0 到 24 之间。');
      return [start, end % 24];
    };

    const memoryPath = env.MEMORY_DB || 'data/memory.db';
    const dataDir = instanceDataDir(memoryPath);
    let releaseLock: () => void;
    try {
      const path = resolve(instanceLockPath(memoryPath));
      if (heldLocks.has(path))
        throw Error('Agent host already active for this data directory');
      releaseLock = acquireInstanceLock(path);
      heldLocks.add(path);
      const releaseFile = releaseLock;
      releaseLock = () => {
        heldLocks.delete(path);
        releaseFile();
      };
    } catch (error) {
      fail(error instanceof Error ? error.message : '无法获取实例锁。');
    }

    defer(releaseLock!);
    const personality =
      llmEnabled && modular
        ? new PersonalityRuntime(
            createContextAnalyzer(
              env.DEEPSEEK_API_KEY!,
              env.DEEPSEEK_MODEL || 'deepseek-flash',
            ),
          )
        : undefined;
    console.log(
      `[人格] mode=${personalityMode}; ${personality ? '语境观察与规则计划已启用，必要时增加一次分析请求。' : '使用原角色卡。'}`,
    );
    const visionEnabled = llmEnabled && env.VISION_ENABLED === 'true';
    let memes: MemeManager | undefined;
    if (llmEnabled && env.MEMES_ENABLED === 'true') {
      try {
        const catalog = loadMemeCatalog('config/memes/tieba');
        memes = new MemeManager(
          catalog,
          env.DEEPSEEK_API_KEY!,
          new JsonMemeState(join(dataDir, 'memes-state.json')),
          readNumber('MEME_REPLY_GAP', 7, 1, 100),
        );
        console.log(
          `[表情] 已启用，图库 ${catalog.length} 张，${catalog.filter((entry) => entry.confidence >= 0.8).length} 张可自动选用；具体选图，按已送达回复控制频率。`,
        );
      } catch {
        console.error('[表情] 图库或频率状态异常，停用配图，保留文字。');
      }
    }
    const vision = visionEnabled
      ? createVisionReply(
          env.DEEPSEEK_API_KEY!,
          env.VISION_MODEL || 'deepseek-flash',
          undefined,
          undefined,
          { memesEnabled: !!memes },
        )
      : undefined;
    const memoryTurns = readNumber('MEMORY_TURNS', 9, 1, 50);
    const memory = new ConversationMemory(
      new SqliteSessionStore(memoryPath),
      Date.now,
      30 * 60_000,
      memoryTurns,
    );
    defer(() => memory.close());
    const generateReply = llmEnabled
      ? createDeepSeekReply(
          env.DEEPSEEK_API_KEY!,
          env.DEEPSEEK_MODEL || 'deepseek-flash',
          undefined,
          {
            turns: memoryTurns,
            memesEnabled: !!memes,
            visionEnabled,
            searchEnabled: env.WEB_SEARCH_ENABLED === 'true',
          },
        )
      : undefined;
    console.log(
      llmEnabled
        ? `[LLM] DeepSeek 已启用，按聊天和用户隔离短期记忆（${memoryPath}），最多 ${memoryTurns} 轮，30 分钟过期。`
        : '[LLM] 未启用，QQ 使用固定回复；工作台标记模型未配置。',
    );
    if (llmEnabled)
      console.log(
        `[工具] 时间、骰子已启用；联网搜索${env.WEB_SEARCH_ENABLED === 'true' ? '已启用' : '未启用'}，仅呼叫与连续对话可用。`,
      );
    console.log(
      `[识图] ${visionEnabled ? '已启用，明确呼叫时关联同条、引用或楼上本人单图；本地不足时按需查历史。' : '未启用。'}`,
    );
    const followUpMode = (env.FOLLOW_UP_MODE || 'window').trim().toLowerCase();
    if (!['window', 'always', 'unified'].includes(followUpMode))
      fail('FOLLOW_UP_MODE 只能是 window、always 或 unified。');
    const observationEnabled =
      llmEnabled &&
      followUpMode !== 'always' &&
      env.FOLLOW_UP_OBSERVE === 'true';
    const autoReplyEnabled =
      llmEnabled &&
      followUpMode !== 'always' &&
      !observationEnabled &&
      env.FOLLOW_UP_AUTO === 'true';
    const judgeEvery =
      llmEnabled && (followUpMode === 'always' || followUpMode === 'unified')
        ? {
            judge: createChatJudge(
              env.DEEPSEEK_API_KEY!,
              env.DEEPSEEK_MODEL || 'deepseek-flash',
              undefined,
              modular,
            ),
            cooldownMs:
              readNumber('AUTO_REPLY_COOLDOWN_SECONDS', 45, 0, 3600) * 1000,
            hourlyCap: readNumber('AUTO_REPLY_HOURLY_CAP', 12, 1, 200),
          }
        : undefined;
    const judge =
      observationEnabled || autoReplyEnabled
        ? createFollowUpJudge(
            env.DEEPSEEK_API_KEY!,
            env.DEEPSEEK_MODEL || 'deepseek-flash',
            undefined,
            modular,
          )
        : undefined;
    const groupContextMessages = readNumber(
      'GROUP_CONTEXT_MESSAGES',
      60,
      1,
      120,
    );
    const groupContextSeconds = readNumber(
      'GROUP_CONTEXT_SECONDS',
      300,
      10,
      3600,
    );
    const maxInflight = readNumber('MAX_INFLIGHT', 3, 1, 16);
    const slots = new Semaphore(maxInflight);
    const maxWindows = readNumber('MAX_WINDOWS', 12, 1, 1000);
    const windowSeconds = readNumber('WINDOW_SECONDS', 90, 10, 600);
    console.log(
      followUpMode === 'unified' && judgeEvery
        ? `[接话] 统一调度：呼叫优先，接续窗口 ${windowSeconds} 秒且成功后续期；主动插话冷却 ${judgeEvery.cooldownMs / 1000} 秒，上限 ${judgeEvery.hourlyCap} 次/小时。`
        : judgeEvery
          ? `[接话] 每句判断模式：每个普通群消息都过判断器，冷却 ${judgeEvery.cooldownMs / 1000} 秒，上限 ${judgeEvery.hourlyCap} 次/小时。`
          : observationEnabled
            ? '[观察] 仅判断不回复。'
            : autoReplyEnabled
              ? `[自动接话] 每个用户独立 ${windowSeconds} 秒窗口，最多2次。`
              : '[接续] 已关闭。',
    );
    console.log(
      judgeEvery
        ? `[并发] 同时最多 ${maxInflight} 个生成任务。`
        : `[并发] 同时最多 ${maxInflight} 个生成任务，最多 ${maxWindows} 个活跃窗口，窗口 ${windowSeconds} 秒。`,
    );

    const interjectProbability = readNumber('INTERJECT_PROBABILITY', 0, 0, 1);
    const interject =
      llmEnabled && !judgeEvery && interjectProbability > 0
        ? {
            probability: interjectProbability,
            cooldownMs:
              readNumber('INTERJECT_COOLDOWN_SECONDS', 180, 0, 86_400) * 1000,
          }
        : undefined;
    console.log(
      judgeEvery
        ? '[插话] 已并入每句判断，不再单独掷骰。'
        : interject
          ? `[插话] 已在 ${(interject.probability * 100).toFixed(0)}% 的普通消息上随机参与，同群冷却 ${interject.cooldownMs / 1000} 秒。`
          : '[插话] 已关闭。',
    );

    const warmupEnabled = llmEnabled && env.WARMUP_ENABLED === 'true';
    const warmupHours = readHours(env.WARMUP_HOURS || '20-23');
    const warmupIdleMinutes = readNumber('WARMUP_IDLE_MINUTES', 45, 1, 1440);
    const warmupQuietMinutes = readNumber('WARMUP_QUIET_MINUTES', 20, 0, 1440);
    if (warmupEnabled && warmupQuietMinutes > warmupIdleMinutes)
      fail('WARMUP_QUIET_MINUTES 不能大于 WARMUP_IDLE_MINUTES。');
    const warmup = warmupEnabled
      ? {
          probability: readNumber('WARMUP_PROBABILITY', 0.3, 0, 1),
          hours: warmupHours,
          cooldownMs:
            readNumber('WARMUP_COOLDOWN_MINUTES', 60, 0, 1440) * 60_000,
          idleMs: warmupIdleMinutes * 60_000,
          quietMs: warmupQuietMinutes * 60_000,
        }
      : undefined;
    console.log(
      warmup
        ? `[暖场] 已启用：${warmupHours[0]} 点到 ${warmupHours[1]} 点之间，安静 ${warmupQuietMinutes} 分钟后，且 ${warmupIdleMinutes} 分钟内有具体话题，每轮 ${(warmup.probability * 100).toFixed(0)}% 概率，同群冷却 ${warmup.cooldownMs / 60_000} 分钟。`
        : '[暖场] 已关闭。',
    );

    const eventMemory = createEventMemory(env);
    if (eventMemory) defer(() => eventMemory.close());
    let stop: ReturnType<typeof connectNapCat> | undefined;
    const start = () => {
      if (stop || !address || closed) return;
      stop = connectNapCat(
        address,
        env.NAPCAT_TOKEN ?? '',
        generateReply,
        judge,
        {
          memes,
          personality,
          eventMemory,
          vision,
          imageRequest: visionEnabled
            ? createImageRequestJudge(
                env.DEEPSEEK_API_KEY!,
                env.DEEPSEEK_MODEL || 'deepseek-flash',
              )
            : undefined,
          autoReply: autoReplyEnabled,
          unified: followUpMode === 'unified',
          memory,
          maxInflight,
          slots,
          maxWindows,
          windowMs: windowSeconds * 1000,
          interject,
          warmup,
          judgeEvery,
          context: {
            maxMessages: groupContextMessages,
            ttlMs: groupContextSeconds * 1000,
          },
        },
      );
      defer(stop);
    };

    const tickMs = readNumber('WARMUP_INTERVAL_MINUTES', 30, 1, 1440) * 60_000;
    const eventTimer = eventMemory
      ? setInterval(() => {
          void eventMemory.tick();
        }, 1000)
      : undefined;
    const timer =
      warmup && address ? setInterval(() => stop?.tick(), tickMs) : undefined;

    if (eventTimer) defer(() => clearInterval(eventTimer));
    if (timer) defer(() => clearInterval(timer));
    const consoleReply = llmEnabled
      ? createConsoleReply(
          env.DEEPSEEK_API_KEY!,
          env.DEEPSEEK_MODEL || 'deepseek-flash',
          memoryTurns,
          env.WEB_SEARCH_ENABLED === 'true',
          undefined,
          slots,
        )
      : undefined;
    return {
      start,
      close,
      memoryPath,
      memoryTurns,
      maxInflight,
      generate: consoleReply,
      status: () => ({
        model: llmEnabled
          ? ('configured' as const)
          : ('not-configured' as const),
        qq: !address
          ? ('disabled' as const)
          : (stop?.status() ?? ('disconnected' as const)),
      }),
    };
  } catch (error) {
    close();
    throw error;
  }
}
