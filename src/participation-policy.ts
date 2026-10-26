import type { GroupMessage } from './message.js';
import type { Participation } from './context.js';
import type { Inbound } from './participation-types.js';

export const isExplicitCall = (message: GroupMessage, unified: boolean): boolean =>
  !!(message.isMentioned || message.isCalledByName || message.isReplyToBot || (!unified && message.replyMessageId));

export const directedElsewhere = (message: GroupMessage): boolean =>
  !!(message.hasAnyMention || message.replyToSenderId && message.replyToSenderId !== message.selfId);

export const awaitingFollowUp = (active: Inbound | undefined, pending: Inbound | undefined,
  awaitingUntil: number, now: number): boolean =>
  !!(active?.kind === 'explicit' || active?.awaitingReply || pending?.awaitingReply || awaitingUntil > now);

export const admitsWindowFollowUp = (message: GroupMessage, text: string): boolean =>
  !directedElsewhere(message) && !!text && text.length <= 4000;

// The legacy every-message judge intentionally has a narrower routing filter.
export const admitsEveryMessage = (message: GroupMessage, text: string): boolean =>
  !message.hasAnyMention && !!text && text.length <= 4000;

export const canMergeFragment = (pending: Inbound | undefined, text: string, now: number,
  mode: 'awaiting' | 'follow-up' | 'judge'): pending is Inbound =>
  !!pending && (mode === 'awaiting' ? !!pending.awaitingReply : pending.kind === mode) &&
  now - pending.receivedAt < 3000 && pending.text.length + text.length < 4000;

// Return a patch so the scheduler can retain the identity of its pending task.
export const mergedFragment = (pending: Inbound, text: string, now: number, senderVersion: number,
  messageId: string): Pick<Inbound, 'text' | 'receivedAt' | 'senderVersion' | 'triggerIds'> => ({
  text: `${pending.text}\n${text}`, receivedAt: now, senderVersion,
  triggerIds: [...(pending.triggerIds ?? []), messageId],
});

export const repeatsUnansweredTopic = (unified: boolean, previous: Participation | undefined,
  topicKey: string | undefined): boolean =>
  !!(unified && previous && !previous.responded && topicKey && previous.topicKey === topicKey);
