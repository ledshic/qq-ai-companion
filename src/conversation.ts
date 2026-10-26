import { approveSend } from './send-review.js';
import type { Inbound } from './participation-types.js';
import { isExplicitCall, directedElsewhere, awaitingFollowUp, admitsWindowFollowUp, admitsEveryMessage,
  canMergeFragment, mergedFragment, repeatsUnansweredTopic } from './participation-policy.js';
import { ProactiveBudget } from './proactive-budget.js';
import { generateExplicitReply } from './explicit-reply.js';
import { handleConversationCommand } from './conversation-command.js';
import { createReplyContextPreparer } from './reply-context.js';
import type { EventMemoryPort } from './events/types.js';
import type { PersonalityRuntime } from './personality-runtime.js';
import type { MemeSendContext } from './meme-types.js';
import { GroupContext, modelContext, renderContext, type ReplyContext, type DeliveryTarget, type SendGuard } from './context.js';
import { abortReason, isAbort } from './abort.js';
import type { GroupMessage } from './message.js';
import { handleGroupMessage } from './message.js';
import type { ChatTurn, ConversationMemory } from './memory.js';
import type { VisionHandler, ImageResolver, ImageRequestJudge } from './vision-types.js';
import { isBotGroupReply } from './onebot.js';
import { applyMessageReference, prepareImageReference } from './message-reference.js';
import type { GroupJudge, GroupJudgment } from './group-judge.js';
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

export interface JudgeEveryOptions {
  judge: GroupJudge;
  cooldownMs: number;
  hourlyCap: number;
}

export interface ConversationOptions {
  personality?: PersonalityRuntime;
  eventMemory?: EventMemoryPort;
  memory: ConversationMemory;
  unified?: boolean;
  recordsDelivery?: boolean;
  send: (groupId: string, content: string, guard: SendGuard, target?: DeliveryTarget, media?: MemeSendContext) => Promise<string | undefined>;
  vision?: VisionHandler;
  imageRequest?: ImageRequestJudge;
  resolveImage?: ImageResolver;
  referenceHistory?: (groupId: string, signal: AbortSignal) => Promise<unknown>;
  lookup?: (messageId: string, signal: AbortSignal) => Promise<unknown>;
  judge?: (text: string, history: ChatTurn[], signal: AbortSignal, context?: ReplyContext) => Promise<FollowUpDecision>;
  generate?: (text: string, history: ChatTurn[], signal: AbortSignal, allowTools?: boolean, context?: ReplyContext) => Promise<string>;
  maxInflight?: number;
  maxWindows?: number;
  windowMs?: number;
  autoReply?: boolean;
  now?: () => number;
  random?: () => number;
  interject?: InterjectOptions;
  warmup?: WarmupOptions;
  context?: ContextOptions;
  judgeEvery?: JudgeEveryOptions;
  log?: (line: string) => void;
}

// One cooperative task per (group, sender). Every await is a yield point, and
// the controller is the single cancellation path for the task.
interface Session {
  pending: Inbound | undefined;
  controller: AbortController | undefined;
  running: boolean;
  active?: Inbound;
}

const MAX_TEXT = 4000;
const DEFAULT_CONTEXT: ContextOptions = { maxMessages: 60, ttlMs: 5 * 60_000 };

const withinHours = (hour: number, [start, end]: [number, number]): boolean =>
  start === end ? true : start < end ? hour >= start && hour < end : hour >= start || hour < end;

// Conversation windows are single-threaded tasks: dispatch() decides
// synchronously, the loop yields at each await, and a superseded task is
// aborted instead of completing and being discarded afterwards.
export class Conversation {
  private readonly prepareContext: ReturnType<typeof createReplyContextPreparer>;
  private readonly windows: ObservationWindows;
  private readonly sessions = new Map<string, Session>();
  private readonly slots: Semaphore;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly context: ContextOptions;
  private readonly discussion: GroupContext;
  private readonly proactiveBudget: ProactiveBudget;
  private readonly proactiveInFlight = new Set<string>();
  private readonly warmups = new Set<AbortController>();
  private lifecycle = 0;
  private background?: AbortController;
  private readonly awaitingInitial = new Map<string, number>();

  constructor(private readonly options: ConversationOptions) {
    this.prepareContext = createReplyContextPreparer(options);
    this.now = options.now ?? Date.now;
    this.proactiveBudget = new ProactiveBudget(this.now);
    this.random = options.random ?? Math.random;
    this.log = options.log ?? console.log;
    this.context = options.context ?? DEFAULT_CONTEXT;
    this.discussion = new GroupContext(this.now, this.context.maxMessages, this.context.ttlMs);
    this.windows = new ObservationWindows(this.now, options.windowMs ?? 60_000, options.maxWindows ?? 6, options.unified ? Infinity : 2);
    this.slots = new Semaphore(options.maxInflight ?? 2);
    options.eventMemory?.attach(controller => {
      const release = this.slots.tryAcquire((options.maxInflight ?? 2) > 1 ? 1 : 0);
      if (!release) return;
      this.background = controller;
      return () => { if (this.background === controller) this.background = undefined; release(); };
    }, scope => this.discussion.snapshot(scope.groupId));
  }

  handle(message: GroupMessage): void {
    this.options.eventMemory?.ingest(message);
    // Event IDs are retained across reconnects, before any scheduler side effects.
    if (!this.discussion.add(message)) { this.log('[跳过] 重复消息。'); return; }
    if (this.options.unified && message.replyMessageId && !message.isMentioned && !message.isCalledByName) {
      void this.resolveReply(message);
      return;
    }
    this.dispatch(message);
  }

  private async resolveReply(message: GroupMessage): Promise<void> {
    const version = this.discussion.senderVersion(message.groupId, message.senderId);
    const lifecycle = this.lifecycle;
    try {
      const data = this.options.lookup ? await this.options.lookup(message.replyMessageId!, new AbortController().signal) : null;
      if (this.lifecycle !== lifecycle || this.discussion.senderVersion(message.groupId, message.senderId) !== version) return;
      message.isReplyToBot = isBotGroupReply(data, message);
      if (message.isReplyToBot) this.options.eventMemory?.ingest(message);
      // Only a validated same-group lookup may supply the referenced sender.
      applyMessageReference(message, data, this.discussion);
      if (!message.replyToSenderId && !message.isMentioned && !message.isCalledByName) {
        this.log('[跳过] 引用对象无法确认，不自动唤醒。'); return;
      }
      this.dispatch(message);
    } catch {
      if (this.lifecycle === lifecycle && this.discussion.senderVersion(message.groupId, message.senderId) === version && (message.isMentioned || message.isCalledByName)) this.dispatch(message);
      else this.log('[跳过] 引用查询失败，未自动唤醒。');
    }
  }

  private dispatch(message: GroupMessage): void {
    const session = this.session(this.key(message), message);
    this.windows.incoming(message.groupId, message.senderId);
    const text = message.content.trim();
    const senderVersion = this.discussion.senderVersion(message.groupId, message.senderId);
    const base = { message, text, receivedAt: this.now(), senderVersion, triggerIds: [message.messageId!] };
    const explicit = isExplicitCall(message, !!this.options.unified);
    if (explicit) {
      this.background?.abort(new Error('foreground_priority'));
      if (this.options.unified) {
        this.awaitingInitial.set(this.key(message), this.now() + (this.options.windowMs ?? 60_000));
        while (this.awaitingInitial.size > (this.options.maxWindows ?? 100)) this.awaitingInitial.delete(this.awaitingInitial.keys().next().value!);
      }
      this.windows.close(message.groupId, message.senderId);
      session.controller?.abort(new Error('被新的呼叫取代'));
      session.pending = { ...base, kind: 'explicit' };
      void this.run(session);
      return;
    }
    if (this.options.unified) {
      // A later message from this participant invalidates their old draft, but
      // another participant never cancels an explicit or follow-up response.
      session.controller?.abort(new Error('同一用户已补充新消息'));
      if (directedElsewhere(message)) {
        session.pending = undefined;
        this.log('[跳过] 当前消息指向其他群友。'); return;
      }
      // Preserve an unanswered explicit request when its author adds a split
      // sentence. Judge the addition before regenerating; pause/end stays silent.
      if (this.options.judge && (awaitingFollowUp(session.active, session.pending, this.awaitingInitial.get(this.key(message)) ?? 0, this.now()))) {
        const pending = session.pending;
        if (canMergeFragment(pending, text, this.now(), 'awaiting')) {
          Object.assign(pending, mergedFragment(pending, text, this.now(), senderVersion, message.messageId!));
        } else session.pending = { ...base, kind: 'follow-up', awaitingReply: true };
        void this.run(session); return;
      }
    } else if (this.options.judgeEvery) {
      this.handleEvery(session, message, text);
      return;
    }
    const candidate = this.options.judge ? this.windows.candidate(message.groupId, message.senderId) : undefined;
    if (candidate) {
      if (!admitsWindowFollowUp(message, text)) {
        this.log('[跳过] 消息指向他人、无文本或文本超限。'); return;
      }
      const pending = session.pending;
      if (canMergeFragment(pending, text, this.now(), 'follow-up')) {
        Object.assign(pending, mergedFragment(pending, text, this.now(), senderVersion, message.messageId!));
        return;
      }
      session.pending = { ...base, kind: 'follow-up', candidate };
      void this.run(session);
      return;
    }
    if (this.options.unified && this.options.judgeEvery) {
      this.handleEvery(session, message, text); return;
    }
    if (this.options.judge) this.log(`[跳过] ${this.windows.skipReason(message.groupId, message.senderId)}。`);
    this.maybeInterject(session, message, text);
  }

  // Called only after an actual send acknowledgement, once per delivered part.
  acknowledged(group: string, text: string, messageId?: string, target?: DeliveryTarget): void {
    this.discussion.delivered(group, text, messageId, target?.senderId, target?.replyTo);
  }

  private delivered(group: string, text: string, target?: DeliveryTarget): void {
    if (!this.options.recordsDelivery) this.discussion.delivered(group, text, undefined, target?.senderId, target?.replyTo);
  }

  private replyContext(item: Inbound, kind: ReplyContext['kind'], snapshot = this.discussion.snapshot(item.message.groupId),
    decision?: GroupJudgment): ReplyContext {
    return Object.freeze({ kind, targetSenderId: item.message.senderId,
      triggerIds: Object.freeze([...(item.triggerIds ?? [item.message.messageId!])]), snapshot,
      phase: 'decision' as const, awaitingReply: item.awaitingReply, decision: decision ? Object.freeze({ reason: decision.reason,
        topicKey: decision.topicKey, basisIds: decision.basisIds }) : undefined });
  }

  private memeContext(item: Inbound, context: ReplyContext, answer: string, signal: AbortSignal): MemeSendContext {
    return { context, signal, approve: note => this.sendApproval(item, context, answer + '\n' + note.replace('[已发送表情 ', '[拟配表情 '), signal, item.candidate) };
  }

  private senderCurrent(item: Inbound): boolean {
    return !this.options.unified || item.senderVersion === this.discussion.senderVersion(item.message.groupId, item.message.senderId);
  }

  private async sendApproval(item: Inbound, context: ReplyContext, draft: string, signal: AbortSignal,
    candidate?: FollowUpCandidate): Promise<SendGuard | undefined> {
    const { message } = item;
    return approveSend(message, context, draft, signal, {
      unified: this.options.unified,
      senderCurrent: () => this.senderCurrent(item),
      candidate,
      snapshot: () => this.discussion.snapshot(message.groupId),
      reconsider: async review => {
        const decision = context.kind === 'follow-up' && this.options.judge
          ? await this.options.judge(item.text, this.options.memory.get(message.groupId, message.senderId), signal, review)
          : this.options.judgeEvery ? await this.options.judgeEvery.judge({ text: item.text,
              recent: renderContext(review.snapshot), history: this.options.memory.get(message.groupId, message.senderId), context: review }, signal) : undefined;
        return decision && ('shouldRespond' in decision ? decision.shouldRespond : decision.respond);
      },
      log: this.log,
    });
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

  connected(): void { this.options.eventMemory?.resume(); }

  disconnect(): void {
    this.options.eventMemory?.pause();
    this.lifecycle++;
    for (const session of this.sessions.values()) {
      session.controller?.abort(new Error('连接已断开'));
      session.pending = undefined;
    }
    for (const controller of this.warmups) controller.abort(new Error('连接已断开'));
    this.sessions.clear();
    this.windows.clear();
    this.awaitingInitial.clear();
    this.proactiveBudget.disconnected(!!this.options.unified);
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

  private maybeInterject(session: Session, message: GroupMessage, text: string): void {
    const interject = this.options.interject;
    if (!interject || !this.options.generate) return;
    if (session.pending) return;
    if (!text || text.length > MAX_TEXT) return;
    if (this.proactiveBudget.cooling('interject', message.groupId, interject.cooldownMs)) return;
    if (this.random() >= interject.probability) return;
    session.pending = { kind: 'interject', message, text, receivedAt: this.now(),
      senderVersion: this.discussion.senderVersion(message.groupId, message.senderId), triggerIds: [message.messageId!] };
    void this.run(session);
  }

  // Window-free mode: every ordinary group message is judged, then rate limited.
  private handleEvery(session: Session, message: GroupMessage, text: string): void {
    const every = this.options.judgeEvery!;
    if (!admitsEveryMessage(message, text)) {
      this.log('[跳过] 消息含其他@、无文本或文本超限。');
      return;
    }
    const pending = session.pending;
    if (canMergeFragment(pending, text, this.now(), 'judge')) {
      Object.assign(pending, mergedFragment(pending, text, this.now(),
        this.discussion.senderVersion(message.groupId, message.senderId), message.messageId!));
      return;
    }
    if (this.proactiveBudget.cooling('judge', message.groupId, every.cooldownMs)) {
      this.log('[跳过] 刚接过话，冷却中。');
      return;
    }
    if (this.proactiveBudget.overHourlyCap(message.groupId, every.hourlyCap)) {
      this.log('[跳过] 本小时接话已达上限。');
      return;
    }
    if (session.pending) return;
    session.pending = { kind: 'judge', message, text, receivedAt: this.now(),
      senderVersion: this.discussion.senderVersion(message.groupId, message.senderId), triggerIds: [message.messageId!] };
    void this.run(session);
  }

  private async judged(item: Inbound, signal: AbortSignal): Promise<void> {
    const every = this.options.judgeEvery!;
    const { message } = item;
    if (this.options.unified && this.proactiveInFlight.has(message.groupId)) {
      this.log('[跳过] 本群已有主动参与任务，保留上下文。'); return;
    }
    if (this.options.unified) this.proactiveInFlight.add(message.groupId);
    try {
      const context = this.replyContext(item, 'interject');
      const history = this.options.memory.get(message.groupId, message.senderId);
      const decision = await every.judge({ text: item.text, recent: renderContext(context.snapshot), history, context }, signal);
      if (!decision.respond) { this.log(`[判断] 不接：${decision.reason}`); return; }
      const previous = context.snapshot.participation;
      if (repeatsUnansweredTopic(!!this.options.unified, previous, decision.topicKey)) {
        this.log('[跳过] 同一话题已主动参与且无人回应。'); return;
      }
      const budget = () => !this.proactiveBudget.cooling('judge', message.groupId, every.cooldownMs) &&
        !this.proactiveBudget.overHourlyCap(message.groupId, every.hourlyCap);
      if (!this.senderCurrent(item) || signal.aborted || !budget()) return;
      const generationContext = await this.prepareContext(this.replyContext(item, 'interject', context.snapshot, decision), item.text, history, signal, decision.observation);
      const answer = await this.options.generate!(item.text, history, signal, false, generationContext);
      const guard = await this.sendApproval(item, generationContext, answer, signal);
      if (!guard || !budget()) return;
      const delivered = await this.options.send(message.groupId, answer, async () => await guard() && budget(), { senderId: message.senderId, replyTo: message.messageId }, this.memeContext(item, generationContext, answer, signal));
      if (!delivered) return;
      this.delivered(message.groupId, delivered, { senderId: message.senderId, replyTo: message.messageId });
      this.options.memory.add(message.groupId, message.senderId, item.text, delivered);
      this.proactiveBudget.record('judge', message.groupId);
      if (this.options.unified) {
        this.discussion.participated(message.groupId, decision.topicKey ?? item.message.messageId!, decision.basisIds ?? context.triggerIds, context.snapshot.incomingVersion);
        this.windows.open(this.windows.incoming(message.groupId, message.senderId));
      }
      this.log(`[接话] 已回复（${decision.reason}）。`);
    } finally { if (this.options.unified) this.proactiveInFlight.delete(message.groupId); }
  }

  private pickWarmupGroup(warmup: WarmupOptions): string | undefined {
    const cutoff = this.now() - warmup.idleMs;
    let best: { group: string; at: number } | undefined;
    for (const key of this.sessions.keys()) {
      const [group] = JSON.parse(key) as [string, string];
      const last = this.discussion.snapshot(group).messages.at(-1);
      if (!last || last.at < cutoff) continue;
      if (this.proactiveBudget.cooling('warmup', group, warmup.cooldownMs)) continue;
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
        session.active = item;
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
          if (session.controller === controller) { session.controller = undefined; session.active = undefined; }
        }
      }
    } finally {
      session.running = false;
    }
  }

  private async execute(item: Inbound, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !this.senderCurrent(item)) return;
    if (item.kind === 'follow-up') await this.followUp(item, signal);
    else if (item.kind === 'interject') await this.interject(item, signal);
    else if (item.kind === 'judge') await this.judged(item, signal);
    else await this.explicit(item, signal);
  }

  private async followUp(item: Inbound, signal: AbortSignal): Promise<void> {
    const { message } = item;
    const candidate = this.options.unified ? this.windows.candidate(message.groupId, message.senderId) : item.candidate;
    if (!candidate?.() && !item.awaitingReply) return;
    const context = this.replyContext(item, 'follow-up');
    const history = this.options.memory.get(message.groupId, message.senderId);
    if (!history.length && !item.awaitingReply) return;
    const decision = await this.options.judge!(item.text, history, signal, context);
    if (signal.aborted || !this.senderCurrent(item)) return;
    if (candidate && !candidate()) {
      this.log('[接续] 窗口已结束，丢弃迟到的判断；不接话。');
      return;
    }
    const intentLabel = { continue: '继续', pause: '暂停', end: '结束', uncertain: '不确定' }[decision.intent];
    this.log(`[${this.options.autoReply ? '自动接话' : '观察'}] intent=${intentLabel}; wouldRespond=${decision.shouldRespond}; reason=${decision.reason}; 历史${history.length / 2}轮。`);
    if (decision.intent === 'end') {
      this.awaitingInitial.delete(this.key(message));
      this.windows.close(message.groupId, message.senderId, 'ended');
      this.log('[跳过] 用户明确结束对话，关闭窗口。');
    }
    if (!this.options.autoReply || !decision.shouldRespond || !this.options.generate) return;
    const generationContext = await this.prepareContext({ ...context, decision: { reason: decision.reason } }, item.text, history, signal, decision.observation);
    const answer = await this.options.generate(item.text, history, signal, true, generationContext);
    if (candidate && !candidate()) {
      this.log('[自动接话] 发送前窗口失效，取消回复。');
      return;
    }
    const guard = await this.sendApproval(item, generationContext, answer, signal, candidate);
    if (!guard) return;
    const delivered = await this.options.send(message.groupId, answer, guard, { senderId: message.senderId, replyTo: message.messageId }, this.memeContext(item, generationContext, answer, signal));
    if (!delivered) return;
    this.options.memory.add(message.groupId, message.senderId, item.text, delivered);
    this.delivered(message.groupId, delivered, { senderId: message.senderId, replyTo: message.messageId });
    candidate?.consume();
    if (this.options.unified) {
      this.awaitingInitial.delete(this.key(message));
      this.discussion.responded(message.groupId);
      this.windows.open(this.windows.incoming(message.groupId, message.senderId));
    }
    this.log(this.options.unified ? '[自动接话] 已回复并续期对话，不占主动插话预算。' : '[自动接话] 成功回复已写入记忆，计入本窗口2次限额。');
  }

  private async interject(item: Inbound, signal: AbortSignal): Promise<void> {
    let replyContext = this.replyContext(item, 'interject');
    replyContext = await this.prepareContext(replyContext, item.text, [], signal);
    const context = renderContext(modelContext(replyContext).context.snapshot);
    if (!context) return;
    const content = `最近群里的聊天：\n${context}\n\n（你可以自然地插一句，符合你的人设；一两句话，不复述、不解释、不点评谁说了什么。）`;
    const answer = await this.options.generate!(content, [], signal, false, replyContext);
    const delivered = await this.options.send(item.message.groupId, answer, () => !signal.aborted, { senderId: item.message.senderId, replyTo: item.message.messageId }, this.memeContext(item, replyContext, answer, signal));
    if (!delivered) return;
    this.delivered(item.message.groupId, delivered, { senderId: item.message.senderId, replyTo: item.message.messageId });
    // An interjection is a normal reply: it enters memory and opens a window.
    this.options.memory.add(item.message.groupId, item.message.senderId, item.text, delivered);
    this.windows.open(this.windows.incoming(item.message.groupId, item.message.senderId));
    this.proactiveBudget.record('interject', item.message.groupId);
    this.log('[插话] 已主动参与当前话题，按普通回复开窗并写入记忆。');
  }

  private async warmUp(group: string, warmup: WarmupOptions): Promise<void> {
    const controller = new AbortController();
    this.warmups.add(controller);
    let release: (() => void) | undefined;
    try {
      release = await this.slots.acquire(controller.signal);
      const snapshot = this.discussion.snapshot(group);
      const replyContext = await this.prepareContext({ kind: 'warmup', triggerIds: [], snapshot }, '', [], controller.signal);
      const context = renderContext(modelContext(replyContext).context.snapshot);
      if (!context) return;
      const content = `最近群里的聊天：\n${context}\n\n（群里安静了一会儿。主动开一个轻松的话题暖场，一两句话，符合你的人设；不要说自己是AI，也不要解释你在暖场。）`;
      const answer = await this.options.generate!(content, [], controller.signal, false, replyContext);
      const delivered = await this.options.send(group, answer, () => !controller.signal.aborted && (!this.options.unified || this.discussion.snapshot(group).incomingVersion === snapshot.incomingVersion));
      if (!delivered) return;
      this.delivered(group, delivered);
      this.proactiveBudget.record('warmup', group);
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
    if (message.replyMessageId && !message.isReplyToBot &&
        (this.options.unified || !message.isMentioned && !message.isCalledByName)) {
      let data: unknown = null;
      try { data = this.options.lookup ? await this.options.lookup(message.replyMessageId, signal) : null; }
      catch (error) { if (signal.aborted) throw error; }
      if (this.options.unified) applyMessageReference(message, data, this.discussion);
      message.isReplyToBot = isBotGroupReply(data, message);
      if (message.isReplyToBot) this.options.eventMemory?.ingest(message);
      this.log(message.isReplyToBot ? '[触发] 引用机器人消息。' : '[引用] 未确认引用机器人；明确呼叫仍有效。');
      if (!message.isReplyToBot && !message.isMentioned && !message.isCalledByName) return;
    }
    if (signal.aborted || !this.senderCurrent(item)) return;
    if (message.isCalledByName) this.log('[触发] 句首称呼命中（角色称呼）。');
    const reply = handleGroupMessage(message);
    if (!reply) return;
    const content = message.content.trim();
    let context = this.replyContext(item, 'explicit');
    await prepareImageReference(message, context, signal, {
      enabled: !!this.options.vision,
      discussion: this.discussion,
      imageRequest: this.options.imageRequest,
      referenceHistory: this.options.referenceHistory,
      lookup: this.options.lookup,
      isCurrent: () => this.senderCurrent(item),
      log: this.log,
    });
    signal.throwIfAborted();
    if (!this.senderCurrent(item)) return;
    let controlHandled = false;
    let commit: ((delivered: string) => void) | undefined;
    const awaitingContent = this.options.unified && message.isMentioned && !content && !message.hasMedia && !(message.quotedAttachments?.imageCount);
    if (this.options.generate) {
      const command = handleConversationCommand(message, {
        eventMemory: this.options.eventMemory,
        memory: this.options.memory,
        discussion: this.discussion,
        windows: this.windows,
        log: this.log,
      });
      if (command) {
        controlHandled = command.bypassSendReview;
        reply.content = command.content;
      } else {
        const draft = await generateExplicitReply(message, context, !!awaitingContent, signal, {
          memory: this.options.memory,
          prepareContext: this.prepareContext,
          generate: this.options.generate,
          vision: this.options.vision,
          resolveImage: this.options.resolveImage,
          log: this.log,
        });
        context = draft.context;
        reply.content = draft.content;
        if (draft.memoryPrompt !== undefined) {
          const prompt = draft.memoryPrompt;
          commit = delivered => this.options.memory.add(message.groupId, message.senderId, prompt, delivered);
        }
      }
    }
    if (signal.aborted) {
      this.log('[取消] 生成完成前已被取代，不发送。');
      return;
    }
    const guard = awaitingContent || controlHandled
      ? () => !signal.aborted && (controlHandled || this.senderCurrent(item))
      : await this.sendApproval(item, context, reply.content, signal);
    if (!guard) return;
    const delivered = await this.options.send(message.groupId, reply.content, guard, { senderId: message.senderId, replyTo: message.messageId }, this.memeContext(item, context, reply.content, signal));
    if (!delivered) return;
    this.delivered(message.groupId, delivered, { senderId: message.senderId, replyTo: message.messageId });
    if (awaitingContent) this.awaitingInitial.set(this.key(message), this.now() + (this.options.windowMs ?? 60_000));
    else this.awaitingInitial.delete(this.key(message));
    if (commit) commit(delivered);
    if (!awaitingContent && !controlHandled && this.options.judge && !signal.aborted) {
      this.windows.open(this.windows.incoming(message.groupId, message.senderId));
      this.log(this.options.unified ? '[接续] 明确呼叫回复成功，开启可续期对话窗口。' : '[接续] 明确呼叫回复成功，开启固定接续窗口。');
    }
  }
}
