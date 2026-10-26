import type { ImageAttachments } from './vision-types.js';
export interface GroupMessage {
  groupId: string;
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

export interface GroupReply {
  groupId: string;
  content: string;
}

export const handleGroupMessage = (message: GroupMessage): GroupReply | null => {
  if (!message.isMentioned && !message.isReplyToBot && !message.isCalledByName) {
    return null;
  }

  return {
    groupId: message.groupId,
    content: '你好，我是 AI 群友。',
  };
};
