export interface GroupMessage {
  groupId: string;
  senderId: string;
  content: string;
  isMentioned: boolean;
  selfId?: string;
  replyMessageId?: string;
  isReplyToBot?: boolean;
}

export interface GroupReply {
  groupId: string;
  content: string;
}

export const handleGroupMessage = (message: GroupMessage): GroupReply | null => {
  if (!message.isMentioned && !message.isReplyToBot) {
    return null;
  }

  return {
    groupId: message.groupId,
    content: '你好，我是 AI 群友。',
  };
};
