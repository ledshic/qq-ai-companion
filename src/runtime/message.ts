import type { ChatScope } from './chat-scope.js';
import type { ImageAttachments } from '../tools/vision/vision-types.js';
export interface ChatMessage extends ChatScope {
  senderId: string;
  content: string;
  isMentioned: boolean;
  hasAnyMention?: boolean;
  isCalledByName?: boolean;
  selfId?: string;
  messageId?: string;
  senderName?: string;
  timestamp?: number;
  mentionedIds?: string[];
  hasMedia?: boolean;
  attachments?: ImageAttachments;
  quotedAttachments?: ImageAttachments;
  replyToSenderId?: string;
  replyMessageId?: string;
  isReplyToBot?: boolean;
}
