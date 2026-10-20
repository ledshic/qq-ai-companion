import { abortReason, isAbort } from './abort.js';
import type { GroupMessage } from './message.js';
import { handleGroupMessage } from './message.js';
import type { ChatTurn, ConversationMemory } from './memory.js';
import { isBotGroupReply } from './onebot.js';
import { ObservationWindows, type FollowUpCandidate, type FollowUpDecision } from './observation.js';
import { Semaphore } from './semaphore.js';

export interface ConversationOptions {
  memory: ConversationMemory;
  send: (groupId: string, content: string, guard: () => boolean) => Promise<string | undefined>;
  lookup?: (messageId: string, signal: AbortSignal) => Promise<unknown>;
  judge?: (text: string, history: ChatTurn[], signal: AbortSignal) => Promise<FollowUpDecision>;
  generate?: (text: string, history: ChatTurn[], signal: AbortSignal) => Promise<string>;
  maxInflight?: number;
  autoReply?: boolean;
  now?: () => number;
  log?: (line: string) => void;
}

interface Inbound {
  kind: 'explicit' | 'follow-up';
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

// Conversation windows are single-threaded tasks: dispatch() decides
// synchronously, the loop yields at each await, and a superseded task is
// aborted instead of completing and being discarded afterwards.
export class Conversation {
  private readonly windows: ObservationWindows;
  private readonly sessions = new Map<string, Session>();
  private readonly slots: Semaphore;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: ConversationOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.log;
    this.windows = new ObservationWindows(this.now, 60_000);
    this.slots = new Semaphore(options.maxInflight ?? 2);
  }

  handle(message: GroupMessage): void {
    const key = this.key(message);
    const session = this.session(key, message);
    this.windows.incoming(message.groupId, message.senderId);
    const text = message.content.trim();

    if (message.isMentioned || message.isCalledByName || message.replyMessageId) {
      // A new explicit request supersedes whatever this participant had running.
      this.windows.close(message.groupId, message.senderId);
      session.controller?.abort(new Error('被新的呼叫取代'));
      session.pending = { kind: 'explicit', message, text, receivedAt: this.now() };
      void this.run(session);
      return;
    }

    if (!this.options.judge) return;
    const candidate = this.windows.candidate(message.groupId, message.senderId);
    if (!candidate) {
      this.log(`[跳过] ${this.windows.skipReason(message.groupId, message.senderId)}。`);
      return;
    }
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
  }

  disconnect(): void {
    for (const session of this.sessions.values()) {
      session.controller?.abort(new Error('连接已断开'));
      session.pending = undefined;
    }
    this.sessions.clear();
    this.windows.clear();
  }

  private key(message: GroupMessage): string {
    return JSON.stringify([message.groupId, message.senderId]);
  }

  private session(key: string, message: GroupMessage): Session {
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        pending: undefined,
        controller: undefined,
        running: false,
      };
      this.sessions.set(key, session);
    }
    return session;
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
