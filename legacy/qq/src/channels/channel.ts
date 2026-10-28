import type { ContextMessage, DeliveryTarget } from '../runtime/conversation/context.js';
import type { DeliveryChannel } from '../runtime/delivery/delivery-types.js';
import type { ChatMessage } from '../runtime/message.js';
import type { ImageAttachments, ImageResolver } from '../tools/vision/vision-types.js';

// References carry normalized identity and content, never a platform response.
export interface ReferencedMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  text?: string;
  attachments?: ImageAttachments;
}

// Metadata only: attachment URLs and bytes must not enter history snapshots.
export interface ReferenceHistory {
  chatId: string;
  messages: readonly ContextMessage[];
}
export type MessageLookup = (messageId: string, signal: AbortSignal,
  current: ChatMessage) => Promise<ReferencedMessage | undefined>;
export type HistoryLookup = (current: ChatMessage, signal: AbortSignal) => Promise<ReferenceHistory | undefined>;

// Factories must wait until start() before emitting events. Incoming chat and
// sender keys must be stable across reconnects.
export interface AgentChannelEvents {
  connected(): void;
  disconnected(): void;
  message(message: ChatMessage): void;
  acknowledged(chatId: string, content: string, messageId?: string, target?: DeliveryTarget): void;
}

export interface AgentChannel {
  start(): void;
  stop(): void;
  capture(chatId: string): DeliveryChannel | undefined;
  lookupMessage?: MessageLookup;
  resolveImage?: ImageResolver;
  history?: HistoryLookup;
}

export type AgentChannelFactory = (events: AgentChannelEvents) => AgentChannel;
