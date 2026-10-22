import { abortReason, isAbort } from './abort.js';
import type { GroupMessage } from './message.js';
import { handleGroupMessage } from './message.js';
import type { ChatTurn, ConversationMemory } from './memory.js';
import { isBotGroupReply } from './onebot.js';
import { ObservationWindows, type FollowUpCandidate, type FollowUpDecision } from './observation.js';
import { Semaphore } from './semaphore.js';

export interface InterjectOptions {
  probability: number;
  cooldownMs: number;
}

export interface WarmupOptions {
  probability: number;
  hours: [number, number];
  cooldownMs: number;
  idleMs: number;
}

export interface ContextOptions {
  maxMessages: number;
  ttlMs: number;
}

export interface ConversationOptions {
  memory: ConversationMemory;
  send: (groupId: string, content: string, guard: () => boolean) => Promise<string | undefined>;
  lookup?: (messageId: string, signal: AbortSignal) => Promise<unknown>;
  judge?: (text: string, history: ChatTurn[], signal: AbortSignal) => Promise<FollowUpDecision>;
  generate?: (text: string, history: ChatTurn[], signal: AbortSignal) => Promise<string>;
  maxInflight?: number;
  maxWindows?: number;
  windowMs?: number;
  autoReply?: boolean;
  now?: () => number;
  random?: () => number;
  interject?: InterjectOptions;
  warmup?: WarmupOptions;
  context?: ContextOptions;
  log?: (line: string) => void;
}

type Kind = 'explicit' | 'follow-up' | 'interject';

interface Inbound {
  kind: Kind;
  message: GroupMessage;
  text: string;
  receivedAt: number;
  candidate?: FollowUpCandidate;
}

// One cooperative task per (group, sender). Every await is a yield point, and
// the controller is the single cancellation path for the task.
interface Session {
  pending: Inbound | undefined;
  controller: AbortController | undefined;
  running: boolean;
}

const MERGE_MS = 3000;
const MAX_TEXT = 4000;
const DEFAULT_CONTEXT: ContextOptions = { maxMessages: 12, ttlMs: 5 * 60_000 };

const withinHours = (hour: number, [start, end]: [number, number]): boolean =>
  start === end ? true : start < end ? hour >= start && hour < end : hour >= start || hour < end;

// Conversation windows are single-threaded tasks: dispatch() decides
// synchronously, the loop yields at each await, and a superseded task is
// aborted instead of completing and being discarded afterwards.
export class Conversation {
  private readonly windows: ObservationWindows;
  private readonly sessions = new Map<string, Session>();
  private readonly slots: Semaphore;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly context: ContextOptions;
  private readonly recent = new Map<string, Array<{ text: string; at: number }>>();
  private readonly lastInterject = new Map<string, number>();
  private readonly lastWarmup = new Map<string, number>();
  private readonly warmups = new Set<AbortController>();

  constructor(private readonly options: ConversationOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? console.log;
    this.context = options.context ?? DEFAULT_CONTEXT;
    this.windows = new ObservationWindows(this.now, options.windowMs ?? 60_000, options.maxWindows ?? 6);
    this.slots = new Semaphore(options.maxInflight ?? 2);
  }

  handle(message: GroupMessage): void {
    const key = this.key(message);
    const session = this.session(key, message);
    this.windows.incoming(message.groupId, message.senderId);
    this.remember(message);
    const text = message.content.trim();

    if (message.isMentioned || message.isCalledByName || message.replyMessageId) {
      // A new explicit request supersedes whatever this participant had running.
      this.windows.close(message.groupId, message.senderId);
      session.controller?.abort(new Error('被新的呼叫取代'));
      session.pending = { kind: 'explicit', message, text, receivedAt: this.now() };
      void this.run(session);
      return;
    }

    const candidate = this.options.judge ? this.windows.candidate(message.groupId, message.senderId) : undefined;
    if (candidate) {
      if (message.hasAnyMention || !text || text.length > MAX_TEXT) {
        this.log('[跳过] 消息含其他@、无文本或文本超限。');
        return;
      }
      const pending = session.pending;
      if (pending && pending.kind === 'follow-up' && this.now() - pending.receivedAt < MERGE_MS
          && pending.text.length + text.length < MAX_TEXT) {
        // Split sentences arrive as separate messages; answer them together.
        pending.text = `${pending.text}\n${text}`;
        pending.receivedAt = this.now();
        return;
      }
      session.pending = { kind: 'follow-up', message, text, receivedAt: this.now(), candidate };
      void this.run(session);
      return;
    }

    if (this.options.judge) this.log(`[跳过] ${this.windows.skipReason(message.groupId, message.senderId)}。`);
    this.maybeInterject(session, message, text);
  }

  // Called on a timer: occasionally open a topic in a group that has been quiet.
  tick(): void {
    const warmup = this.options.warmup;
    if (!warmup || !this.options.generate) return;
    if (!withinHours(new Date(this.now()).getHours(), warmup.hours)) return;
    if (this.random() >= warmup.probability) return;
    const group = this.pickWarmupGroup(warmup);
    if (!group) return;
    void this.warmUp(group, warmup);
  }

  disconnect(): void {
    for (const session of this.sessions.values()) {
      session.controller?.abort(new Error('连接已断开'));
      session.pending = undefined;
    }
    for (const controller of this.warmups) controller.abort(new Error('连接已断开'));
    this.sessions.clear();
    this.windows.clear();
  }

  private key(message: GroupMessage): string {
    return JSON.stringify([message.groupId, message.senderId]);
  }

  private session(key: string, message: GroupMessage): Session {
    let session = this.sessions.get(key);
    if (!session) {
      session = { pending: undefined, controller: undefined, running: false };
      this.sessions.set(key, session);
    }
    return session;
  }

  // Only stored while a proactive feature is enabled, and never with IDs.
  private remember(message: GroupMessage): void {
    if (!this.options.interject && !this.options.warmup) return;
    const text = message.content.trim();
    if (!text) return;
    const list = this.recent.get(message.groupId) ?? [];
    list.push({ text, at: this.now() });
    const cutoff = this.now() - this.context.ttlMs;
    while (list.length && (list[0].at < cutoff || list.length > this.context.maxMessages)) list.shift();
    this.recent.set(message.groupId, list);
  }

  private recentText(groupId: string): string {
    return (this.recent.get(groupId) ?? []).map(entry => entry.text).join('\n');
  }

  private cooling(map: Map<string, number>, groupId: string, cooldownMs: number): boolean {
    const last = map.get(groupId);
    return last !== undefined && this.now() - last < cooldownMs;
  }

  private maybeInterject(session: Session, message: GroupMessage, text: string): void {
    const interject = this.options.interject;
    if (!interject || !this.options.generate) return;
    if (session.pending) return;
    if (!text || text.length > MAX_TEXT) return;
    if (this.cooling(this.lastInterject, message.groupId, interject.cooldownMs)) return;
    if (this.random() >= interject.probability) return;
    session.pending = { kind: 'interject', message, text, receivedAt: this.now() };
    void this.run(session);
  }

  private pickWarmupGroup(warmup: WarmupOptions): string | undefined {
    const cutoff = this.now() - warmup.idleMs;
    let best: { group: string; at: number } | undefined;
    for (const [group, list] of this.recent) {
      const last = list.at(-1);
      if (!last || last.at < cutoff) continue;
      if (this.cooling(this.lastWarmup, group, warmup.cooldownMs)) continue;
      if (!best || last.at > best.at) best = { group, at: last.at };
    }
    return best?.group;
  }

  private async run(session: Session): Promise<void> {
    if (session.running) return;
    session.running = true;
    try {
      for (;;) {
        const item = session.pending;
        session.pending = undefined;
        if (!item) return;
        const controller = new AbortController();
        session.controller = controller;
        try {
          const release = await this.slots.acquire(controller.signal);
          try {
            await this.execute(item, controller.signal);
          } finally {
            release();
          }
        } catch (error) {
          if (isAbort(error)) this.log(`[取消] ${abortReason(error)}，不回复。`);
          else this.log('[接续] 判断或生成失败、超时，默认不接话。');
        } finally {
          if (session.controller === controller) session.controller = undefined;
        }
      }
    } finally {
      session.running = false;
    }
  }

  private async execute(item: Inbound, signal: AbortSignal): Promise<void> {
    if (item.kind === 'follow-up') await this.followUp(item, signal);
    else if (item.kind === 'interject') await this.interject(item, signal);
    else await this.explicit(item, signal);
  }

  private async followUp(item: Inbound, signal: AbortSignal): Promise<void> {
    const { message, candidate } = item;
    const history = this.options.memory.get(message.groupId, message.senderId);
    if (!history.length) return;
    const decision = await this.options.judge!(item.text, history, signal);
    if (!candidate?.()) {
      this.log('[接续] 窗口已结束，丢弃迟到的判断；不接话。');
      return;
    }
    const intentLabel = { continue: '继续', pause: '暂停', end: '结束', uncertain: '不确定' }[decision.intent];
    this.log(`[${this.options.autoReply ? '自动接话' : '观察'}] intent=${intentLabel}; wouldRespond=${decision.shouldRespond}; reason=${decision.reason}; 历史${history.length / 2}轮。`);
    if (decision.intent === 'end') {
      this.windows.close(message.groupId, message.senderId, 'ended');
      this.log('[跳过] 用户明确结束对话，关闭窗口。');
    }
    if (!this.options.autoReply || !decision.shouldRespond || !this.options.generate) return;
    const answer = await this.options.generate(item.text, history, signal);
    if (!candidate()) {
      this.log('[自动接话] 发送前窗口失效，取消回复。');
      return;
    }
    const delivered = await this.options.send(message.groupId, answer, () => candidate() && !signal.aborted);
    if (!delivered) return;
    this.options.memory.add(message.groupId, message.senderId, item.text, delivered);
    candidate.consume();
    this.log('[自动接话] 成功回复已写入记忆，计入本窗口2次限额。');
  }

  private async interject(item: Inbound, signal: AbortSignal): Promise<void> {
    const context = this.recentText(item.message.groupId);
    if (!context) return;
    const content = `最近群里的聊天：\n${context}\n\n（你可以自然地插一句，符合你的人设；一两句话，不复述、不解释、不点评谁说了什么。）`;
    const answer = await this.options.generate!(content, [], signal);
    const delivered = await this.options.send(item.message.groupId, answer, () => !signal.aborted);
    if (!delivered) return;
    // An interjection is a normal reply: it enters memory and opens a window.
    this.options.memory.add(item.message.groupId, item.message.senderId, item.text, delivered);
    this.windows.open(this.windows.incoming(item.message.groupId, item.message.senderId));
    this.lastInterject.set(item.message.groupId, this.now());
    this.log('[插话] 已主动参与当前话题，按普通回复开窗并写入记忆。');
  }

  private async warmUp(group: string, warmup: WarmupOptions): Promise<void> {
    const controller = new AbortController();
    this.warmups.add(controller);
    let release: (() => void) | undefined;
    try {
      release = await this.slots.acquire(controller.signal);
      const context = this.recentText(group);
      if (!context) return;
      const content = `最近群里的聊天：\n${context}\n\n（群里安静了一会儿。主动开一个轻松的话题暖场，一两句话，符合你的人设；不要说自己是AI，也不要解释你在暖场。）`;
      const answer = await this.options.generate!(content, [], controller.signal);
      const delivered = await this.options.send(group, answer, () => !controller.signal.aborted);
      if (!delivered) return;
      this.lastWarmup.set(group, this.now());
      this.log('[暖场] 已主动开启话题。');
    } catch (error) {
      if (isAbort(error)) this.log(`[取消] ${abortReason(error)}，暖场放弃。`);
      else this.log('[暖场] 生成或发送失败，本次跳过。');
    } finally {
      release?.();
      this.warmups.delete(controller);
    }
  }

  private async explicit(item: Inbound, signal: AbortSignal): Promise<void> {
    const { message } = item;
    if (!message.isMentioned && !message.isCalledByName && message.replyMessageId) {
      const data = this.options.lookup ? await this.options.lookup(message.replyMessageId, signal) : null;
      message.isReplyToBot = isBotGroupReply(data, message);
      this.log(message.isReplyToBot ? '[触发] 引用机器人消息。' : '[触发] 引用未确认属于本群机器人，忽略。');
      if (!message.isReplyToBot) return;
    }
    if (message.isCalledByName) this.log('[触发] 句首称呼命中（角色称呼）。');
    const reply = handleGroupMessage(message);
    if (!reply) return;
    const content = message.content.trim();
    let commit: ((delivered: string) => void) | undefined;
    if (this.options.generate) {
      if (content === '/清空记忆') {
        this.options.memory.clear(message.groupId, message.senderId);
        this.windows.close(message.groupId, message.senderId);
        reply.content = '已清空你在本群与我的聊天记忆。';
        this.log('[记忆] 已清空当前会话。');
      } else if (!content || content.length > MAX_TEXT) {
        reply.content = '请在 @、引用或称呼后发送 1 至 4000 个字符的文字。';
      } else {
        const history = this.options.memory.get(message.groupId, message.senderId);
        this.log(`[记忆] 本次携带历史 ${history.length / 2} 轮。`);
        try {
          reply.content = await this.options.generate(content, history, signal);
          commit = delivered => this.options.memory.add(message.groupId, message.senderId, content, delivered);
        } catch (error) {
          if (isAbort(error)) throw error;
          console.error('[LLM] 请求失败或超时，请检查服务、密钥和余额。');
          reply.content = '我暂时没能生成回复，请稍后再试。';
        }
      }
    }
    if (signal.aborted) {
      this.log('[取消] 生成完成前已被取代，不发送。');
      return;
    }
    const delivered = await this.options.send(message.groupId, reply.content, () => !signal.aborted);
    if (!delivered) return;
    if (commit) commit(delivered);
    if (this.options.judge && !signal.aborted) {
      this.windows.open(this.windows.incoming(message.groupId, message.senderId));
      this.log('[接续] 明确呼叫回复成功，开启60秒窗口，最多自动接话2次。');
    }
  }
}
