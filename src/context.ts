import { isPrivateChat } from './chat-scope.js';
import type { RecallView } from './events/recall-types.js';
import type { ExpressionPlan } from './personality-types.js';
import type { ChatMessage } from './message.js';

export type SendGuard = () => boolean | Promise<boolean>;

export interface DeliveryTarget { senderId: string; replyTo?: string }

export type ParticipationKind = 'explicit' | 'follow-up' | 'interject' | 'warmup';
export interface ContextMessage {
  readonly id: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: number;
  readonly revision: number;
  readonly replyTo?: string;
  readonly replyToSenderId?: string;
  readonly replyToText?: string;
  readonly mentions: readonly string[];
  readonly media: boolean;
  readonly imageCount?: number;
  readonly addressedToBot?: boolean;
}
export interface Participation {
  readonly topicKey: string;
  readonly basisIds: readonly string[];
  readonly at: number;
  readonly responded: boolean;
}
export interface ChatSnapshot {
  readonly chatId: string;
  readonly version: number;
  readonly incomingVersion: number;
  readonly capturedAt: number;
  readonly messages: readonly ContextMessage[];
  readonly participation?: Participation;
}
export interface ReplyContext {
  readonly longTermMemory?: RecallView;
  readonly memoryGuard?: () => boolean;
  readonly expressionPlan?: ExpressionPlan;
  readonly kind: ParticipationKind;
  readonly targetSenderId?: string;
  readonly triggerIds: readonly string[];
  readonly snapshot: ChatSnapshot;
  readonly phase?: 'decision' | 'before_send';
  readonly draft?: string;
  readonly awaitingReply?: boolean;
  readonly decision?: { readonly reason: string; readonly topicKey?: string; readonly basisIds?: readonly string[] };
}
interface ChatState {
  version: number;
  incomingVersion: number;
  lastResponseVersion: number;
  messages: ContextMessage[];
  nearby: ContextMessage[];
  seen: Map<string, number>;
  selfId: string;
  participation?: Participation;
}

// Short-lived conversation context is separate from persisted per-person memory.
// Snapshots are immutable so a judge and generator see the same conversation.
export class ChatContext {
  private chats = new Map<string, ChatState>();
  private sequence = 0;
  constructor(private now = Date.now, private maxMessages = 60, private ttlMs = 5 * 60_000,
    private maxChats = 100, private maxChars = 16_000) {}

  private state(chatId: string): ChatState {
    let state = this.chats.get(chatId);
    if (!state) state = { version: 0, incomingVersion: 0, lastResponseVersion: 0, messages: [], nearby: [], seen: new Map(), selfId: 'bot' };
    this.chats.delete(chatId);
    this.chats.set(chatId, state);
    while (this.chats.size > this.maxChats) this.chats.delete(this.chats.keys().next().value!);
    this.prune(state);
    return state;
  }
  private prune(state: ChatState): void {
    const cutoff = this.now() - this.ttlMs;
    state.messages = state.messages.filter(m => m.at >= cutoff).slice(-this.maxMessages);
    let chars = state.messages.reduce((sum, m) => sum + m.text.length + (m.replyToText?.length ?? 0), 0);
    while (chars > this.maxChars && state.messages.length > 1) { const removed = state.messages.shift()!; chars -= removed.text.length + (removed.replyToText?.length ?? 0); }
    // A separate count-bounded neighborhood supports cross-message references even in slow chats.
    state.nearby = state.nearby.slice(-21);
    let nearbyChars = state.nearby.reduce((sum, m) => sum + m.text.length + (m.replyToText?.length ?? 0), 0);
    while (nearbyChars > this.maxChars && state.nearby.length > 1) {
      const removed = state.nearby.shift()!; nearbyChars -= removed.text.length + (removed.replyToText?.length ?? 0);
    }
    for (const [id, at] of state.seen) if (at < this.now() - 30 * 60_000) state.seen.delete(id);
    while (state.seen.size > 512) state.seen.delete(state.seen.keys().next().value!);
    if (state.participation && state.participation.at < cutoff) state.participation = undefined;
  }
  add(message: ChatMessage): boolean {
    const state = this.state(message.chatId);
    const id = message.messageId ?? `local-user:${++this.sequence}`;
    if (state.seen.has(id)) return false;
    state.seen.set(id, this.now());
    state.selfId = message.selfId ?? state.selfId;
    state.version++;
    state.incomingVersion++;
    message.messageId = id;
    const entry: ContextMessage = { id, senderId: message.senderId, senderName: message.senderName,
      role: 'user', text: message.content.slice(0, 4000), at: message.timestamp ?? this.now(),
      revision: state.incomingVersion, replyTo: message.replyMessageId,
      ...(message.attachments?.imageCount ? { imageCount: Math.min(message.attachments.imageCount, 2) } : {}),
      replyToSenderId: message.replyToSenderId, mentions: [...(message.mentionedIds ?? [])].slice(0, 32), media: !!message.hasMedia, addressedToBot: !!(message.isMentioned || message.isCalledByName || message.isReplyToBot) };
    state.messages.push(entry); state.nearby.push(entry);
    if (message.isMentioned || message.isCalledByName || message.isReplyToBot) this.responded(message.chatId);
    this.prune(state);
    return true;
  }
  resolveReference(chatId: string, id: string, senderId: string, text?: string): void {
    const state = this.state(chatId);
    state.messages = state.messages.map(m => m.id === id ? { ...m, replyToSenderId: senderId, replyToText: text?.slice(0, 2000) } : m);
    state.nearby = state.nearby.map(m => m.id === id ? { ...m, replyToSenderId: senderId, replyToText: text?.slice(0, 2000) } : m);
    this.prune(state);
    state.version++;
    if (senderId === state.selfId) this.responded(chatId);
  }
  delivered(chatId: string, text: string, id?: string, targetSenderId?: string, replyTo?: string): void {
    const state = this.state(chatId);
    const entry: ContextMessage = { id: id ?? `local-bot:${++this.sequence}`, senderId: state.selfId,
      senderName: '机器人', role: 'assistant', text: text.slice(0, 4000), at: this.now(),
      revision: ++state.version, replyTo, mentions: targetSenderId ? [targetSenderId] : [], media: false };
    state.messages.push(entry); state.nearby.push(entry);
    this.prune(state);
  }
  senderVersion(chatId: string, sender: string): number {
    return [...this.state(chatId).messages].reverse().find(m => m.role === 'user' && m.senderId === sender)?.revision ?? 0;
  }
  participated(chatId: string, topicKey: string, basisIds: readonly string[], startedAtIncomingVersion: number): void {
    const state = this.state(chatId);
    state.participation = { topicKey, basisIds: [...basisIds], at: this.now(), responded: state.lastResponseVersion > startedAtIncomingVersion };
  }
  responded(chatId: string): void {
    const state = this.state(chatId);
    state.lastResponseVersion = state.incomingVersion;
    if (state.participation) state.participation = { ...state.participation, responded: true };
  }
  forget(chatId: string, sender: string): void {
    const state = this.state(chatId);
    const keep = (m: ContextMessage) => m.senderId !== sender && !(m.role === 'assistant' && m.mentions.includes(sender));
    state.messages = state.messages.filter(keep); state.nearby = state.nearby.filter(keep);
    state.version++; state.incomingVersion++;
  }
  referenceSnapshot(chatId: string): ChatSnapshot {
    const base = this.snapshot(chatId);
    return Object.freeze({ ...base, messages: Object.freeze(this.state(chatId).nearby.map(m => Object.freeze({ ...m,
      mentions: Object.freeze([...m.mentions]) }))) });
  }
  snapshot(chatId: string): ChatSnapshot {
    const state = this.state(chatId);
    return Object.freeze({ chatId: chatId, version: state.version, incomingVersion: state.incomingVersion,
      capturedAt: this.now(), messages: Object.freeze(state.messages.map(m => Object.freeze({ ...m,
        mentions: Object.freeze([...m.mentions]) }))), participation: state.participation
        ? Object.freeze({ ...state.participation, basisIds: Object.freeze([...state.participation.basisIds]) }) : undefined });
  }
}
export const renderContext = (snapshot: ChatSnapshot): string => snapshot.messages.map(m =>
  `[${m.id}] ${m.senderName ?? m.senderId}${m.role === 'assistant' ? '(机器人)' : ''}：${m.text || (m.media ? '[图片或其他媒体]' : '[无文本]')}${m.replyTo ? ` [引用:${m.replyTo}]` : ''}`).join('\n');


// Transport/account identifiers stay internal. The model only needs consistent
// relationships within this snapshot, not the actual channel/chat/message identifiers.
export const modelContext = (context: ReplyContext): { context: ReplyContext; messageIds: Map<string, string> } => {
  const participants = new Map<string, string>();
  const messages = new Map<string, string>();
  const visibleIds = new Map<string, string>();
  const participant = (id: string): string => {
    if (!participants.has(id)) participants.set(id, `person-${participants.size + 1}`);
    return participants.get(id)!;
  };
  for (const message of context.snapshot.messages) {
    participant(message.senderId);
    messages.set(message.id, `message-${messages.size + 1}`);
  }
  for (const [id, alias] of messages) visibleIds.set(alias, id);
  let references = 0;
  const messageId = (id: string): string => {
    if (!messages.has(id)) messages.set(id, `reference-${++references}`);
    return messages.get(id)!;
  };
  const basis = (ids: readonly string[]) => ids.map(messageId);
  const snapshot: ChatSnapshot = { ...context.snapshot, chatId: isPrivateChat(context.snapshot.chatId) ? 'current-private-chat' : 'current-chat',
    messages: context.snapshot.messages.map(message => ({ ...message,
      id: messageId(message.id), senderId: participant(message.senderId),
      replyTo: message.replyTo ? messageId(message.replyTo) : undefined,
      replyToSenderId: message.replyToSenderId ? participant(message.replyToSenderId) : undefined,
      mentions: message.mentions.map(id => id === 'all' ? 'all' : participant(id)),
    })), participation: context.snapshot.participation ? { ...context.snapshot.participation,
      basisIds: basis(context.snapshot.participation.basisIds) } : undefined };
  return { context: { ...context, memoryGuard: undefined, snapshot,
    targetSenderId: context.targetSenderId ? participant(context.targetSenderId) : undefined,
    triggerIds: basis(context.triggerIds), decision: context.decision ? { ...context.decision,
      basisIds: context.decision.basisIds ? basis(context.decision.basisIds) : undefined } : undefined }, messageIds: visibleIds };
};
