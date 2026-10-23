import type { GroupMessage } from './message.js';

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
  readonly addressedToBot?: boolean;
}
export interface Participation {
  readonly topicKey: string;
  readonly basisIds: readonly string[];
  readonly at: number;
  readonly responded: boolean;
}
export interface GroupSnapshot {
  readonly groupId: string;
  readonly version: number;
  readonly incomingVersion: number;
  readonly capturedAt: number;
  readonly messages: readonly ContextMessage[];
  readonly participation?: Participation;
}
export interface ReplyContext {
  readonly kind: ParticipationKind;
  readonly targetSenderId?: string;
  readonly triggerIds: readonly string[];
  readonly snapshot: GroupSnapshot;
  readonly phase?: 'decision' | 'before_send';
  readonly draft?: string;
  readonly awaitingReply?: boolean;
  readonly decision?: { readonly reason: string; readonly topicKey?: string; readonly basisIds?: readonly string[] };
}
interface GroupState {
  version: number;
  incomingVersion: number;
  lastResponseVersion: number;
  messages: ContextMessage[];
  seen: Map<string, number>;
  selfId: string;
  participation?: Participation;
}

// Short-lived group discussion is separate from persisted per-person memory.
// Snapshots are immutable so a judge and generator see the same conversation.
export class GroupContext {
  private groups = new Map<string, GroupState>();
  private sequence = 0;
  constructor(private now = Date.now, private maxMessages = 60, private ttlMs = 5 * 60_000,
    private maxGroups = 100, private maxChars = 16_000) {}

  private state(group: string): GroupState {
    let state = this.groups.get(group);
    if (!state) state = { version: 0, incomingVersion: 0, lastResponseVersion: 0, messages: [], seen: new Map(), selfId: 'bot' };
    this.groups.delete(group);
    this.groups.set(group, state);
    while (this.groups.size > this.maxGroups) this.groups.delete(this.groups.keys().next().value!);
    this.prune(state);
    return state;
  }
  private prune(state: GroupState): void {
    const cutoff = this.now() - this.ttlMs;
    state.messages = state.messages.filter(m => m.at >= cutoff).slice(-this.maxMessages);
    let chars = state.messages.reduce((sum, m) => sum + m.text.length + (m.replyToText?.length ?? 0), 0);
    while (chars > this.maxChars && state.messages.length > 1) { const removed = state.messages.shift()!; chars -= removed.text.length + (removed.replyToText?.length ?? 0); }
    for (const [id, at] of state.seen) if (at < this.now() - 30 * 60_000) state.seen.delete(id);
    while (state.seen.size > 512) state.seen.delete(state.seen.keys().next().value!);
    if (state.participation && state.participation.at < cutoff) state.participation = undefined;
  }
  add(message: GroupMessage): boolean {
    const state = this.state(message.groupId);
    const id = message.messageId ?? `local-user:${++this.sequence}`;
    if (state.seen.has(id)) return false;
    state.seen.set(id, this.now());
    state.selfId = message.selfId ?? state.selfId;
    state.version++;
    state.incomingVersion++;
    message.messageId = id;
    state.messages.push({ id, senderId: message.senderId, senderName: message.senderName,
      role: 'user', text: message.content.slice(0, 4000), at: message.timestamp ?? this.now(),
      revision: state.incomingVersion, replyTo: message.replyMessageId,
      replyToSenderId: message.replyToSenderId, mentions: [...(message.mentionedIds ?? [])].slice(0, 32), media: !!message.hasMedia, addressedToBot: !!(message.isMentioned || message.isCalledByName || message.isReplyToBot) });
    if (message.isMentioned || message.isCalledByName || message.isReplyToBot) this.responded(message.groupId);
    this.prune(state);
    return true;
  }
  resolveReference(group: string, id: string, senderId: string, text?: string): void {
    const state = this.state(group);
    state.messages = state.messages.map(m => m.id === id ? { ...m, replyToSenderId: senderId, replyToText: text?.slice(0, 2000) } : m);
    state.version++;
    if (senderId === state.selfId) this.responded(group);
  }
  delivered(group: string, text: string, id?: string, targetSenderId?: string, replyTo?: string): void {
    const state = this.state(group);
    state.messages.push({ id: id ?? `local-bot:${++this.sequence}`, senderId: state.selfId,
      senderName: '机器人', role: 'assistant', text: text.slice(0, 4000), at: this.now(),
      revision: ++state.version, replyTo, mentions: targetSenderId ? [targetSenderId] : [], media: false });
    this.prune(state);
  }
  senderVersion(group: string, sender: string): number {
    return [...this.state(group).messages].reverse().find(m => m.role === 'user' && m.senderId === sender)?.revision ?? 0;
  }
  participated(group: string, topicKey: string, basisIds: readonly string[], startedAtIncomingVersion: number): void {
    const state = this.state(group);
    state.participation = { topicKey, basisIds: [...basisIds], at: this.now(), responded: state.lastResponseVersion > startedAtIncomingVersion };
  }
  responded(group: string): void {
    const state = this.state(group);
    state.lastResponseVersion = state.incomingVersion;
    if (state.participation) state.participation = { ...state.participation, responded: true };
  }
  snapshot(group: string): GroupSnapshot {
    const state = this.state(group);
    return Object.freeze({ groupId: group, version: state.version, incomingVersion: state.incomingVersion,
      capturedAt: this.now(), messages: Object.freeze(state.messages.map(m => Object.freeze({ ...m,
        mentions: Object.freeze([...m.mentions]) }))), participation: state.participation
        ? Object.freeze({ ...state.participation, basisIds: Object.freeze([...state.participation.basisIds]) }) : undefined });
  }
}
export const renderContext = (snapshot: GroupSnapshot): string => snapshot.messages.map(m =>
  `[${m.id}] ${m.senderName ?? m.senderId}${m.role === 'assistant' ? '(机器人)' : ''}：${m.text || (m.media ? '[图片或其他媒体]' : '[无文本]')}${m.replyTo ? ` [引用:${m.replyTo}]` : ''}`).join('\n');


// Transport/account identifiers stay internal. The model only needs consistent
// relationships within this snapshot, not the actual QQ/group/message numbers.
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
  const snapshot: GroupSnapshot = { ...context.snapshot, groupId: 'current-group',
    messages: context.snapshot.messages.map(message => ({ ...message,
      id: messageId(message.id), senderId: participant(message.senderId),
      replyTo: message.replyTo ? messageId(message.replyTo) : undefined,
      replyToSenderId: message.replyToSenderId ? participant(message.replyToSenderId) : undefined,
      mentions: message.mentions.map(id => id === 'all' ? 'all' : participant(id)),
    })), participation: context.snapshot.participation ? { ...context.snapshot.participation,
      basisIds: basis(context.snapshot.participation.basisIds) } : undefined };
  return { context: { ...context, snapshot,
    targetSenderId: context.targetSenderId ? participant(context.targetSenderId) : undefined,
    triggerIds: basis(context.triggerIds), decision: context.decision ? { ...context.decision,
      basisIds: context.decision.basisIds ? basis(context.decision.basisIds) : undefined } : undefined }, messageIds: visibleIds };
};
