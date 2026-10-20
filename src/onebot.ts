import type { GroupMessage } from './message.js';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string | number =>
  (typeof value === 'string' && /^\d+$/.test(value)) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);

export const parseGroupMessage = (event: unknown): GroupMessage | null => {
  if (!isRecord(event) || event.post_type !== 'message' || event.message_type !== 'group' ||
      !isId(event.self_id) || !isId(event.group_id) || !isId(event.user_id) ||
      String(event.user_id) === String(event.self_id) || !Array.isArray(event.message)) {
    return null;
  }

  const segments = event.message.filter(isRecord);
  const reply = segments.find(segment => segment.type === 'reply' && isRecord(segment.data));
  const replyId = reply && isRecord(reply.data) ? reply.data.id : undefined;
  return {
    selfId: String(event.self_id),
    replyMessageId: (typeof replyId === 'number' && Number.isSafeInteger(replyId)) ||
      (typeof replyId === 'string' && /^-?\d+$/.test(replyId)) ? String(replyId) : undefined,
    groupId: String(event.group_id),
    senderId: String(event.user_id),
    content: segments.filter(segment => segment.type === 'text' && isRecord(segment.data))
      .map(segment => (segment.data as Record<string, unknown>).text)
      .filter(text => typeof text === 'string').join(''),
    isMentioned: segments.some(segment => segment.type === 'at' && isRecord(segment.data) &&
      String(segment.data.qq) === String(event.self_id)),
  };
};

export const isBotGroupReply = (data: unknown, message: GroupMessage): boolean =>
  isRecord(data) && data.message_type === 'group' &&
  String(data.group_id) === message.groupId &&
  String(data.message_id) === message.replyMessageId &&
  isRecord(data.sender) && String(data.sender.user_id) === message.selfId;
