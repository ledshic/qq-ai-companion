import type { ReferencedMessage } from './channel.js';
import { privateChatId, isPrivateChat } from './chat-scope.js';
import { isRecord } from './value.js';
import type { ContextMessage } from './context.js';
import type { ImageAttachments } from './vision-types.js';
import { stripBotName } from './addressing.js';
import type { ChatMessage } from './message.js';

export { isRecord } from './value.js';

export const imageAttachments = (segments: unknown): ImageAttachments => {
  const images = Array.isArray(segments) ? segments.filter(isRecord).filter(s => s.type === 'image') : [];
  return { imageCount: images.length, images: images.slice(0, 2).map(s => {
    const data = isRecord(s.data) ? s.data : {};
    return { ...(typeof data.url === 'string' && data.url.length <= 8192 ? { url: data.url } : {}),
      ...(typeof data.file === 'string' && data.file.length <= 512 ? { file: data.file } : {}) };
  }) };
};

const isId = (value: unknown): value is string | number =>
  (typeof value === 'string' && /^\d+$/.test(value)) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);

export const parseGroupMessage = (event: unknown): ChatMessage | null => {
  if (!isRecord(event) || event.post_type !== 'message' || event.message_type !== 'group' ||
      !isId(event.self_id) || !isId(event.group_id) || !isId(event.user_id) ||
      String(event.user_id) === String(event.self_id) || !Array.isArray(event.message)) {
    return null;
  }

  const segments = event.message.filter(isRecord);
  const reply = segments.find(segment => segment.type === 'reply' && isRecord(segment.data));
  const replyId = reply && isRecord(reply.data) ? reply.data.id : undefined;
  const content = segments.filter(segment => segment.type === 'text' && isRecord(segment.data))
      .map(segment => (segment.data as Record<string, unknown>).text)
      .filter(text => typeof text === 'string').join('');
  const first = segments.find(segment => segment.type !== 'reply');
  const addressedContent = first?.type === 'text' ? stripBotName(content) : undefined;
  return {
    selfId: String(event.self_id),
    messageId: (typeof event.message_id === 'number' && Number.isSafeInteger(event.message_id)) ||
      (typeof event.message_id === 'string' && /^-?\d+$/.test(event.message_id)) ? String(event.message_id) : undefined,
    senderName: isRecord(event.sender) && typeof (event.sender.card || event.sender.nickname) === 'string'
      ? String(event.sender.card || event.sender.nickname).slice(0, 80) : undefined,
    timestamp: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time * 1000 : undefined,
    mentionedIds: segments.filter(s => s.type === 'at' && isRecord(s.data)).map(s => String((s.data as Record<string, unknown>).qq)),
    attachments: imageAttachments(segments),
    hasMedia: segments.some(s => ['image', 'record', 'video', 'file'].includes(String(s.type))),
    replyMessageId: (typeof replyId === 'number' && Number.isSafeInteger(replyId)) ||
      (typeof replyId === 'string' && /^-?\d+$/.test(replyId)) ? String(replyId) : undefined,
    chatId: String(event.group_id),
    senderId: String(event.user_id),
    content: addressedContent === '' ? content.trim() : addressedContent ?? content,
    isCalledByName: addressedContent !== undefined,
    hasAnyMention: segments.some(segment => segment.type === 'at'),
    isMentioned: segments.some(segment => segment.type === 'at' && isRecord(segment.data) &&
      String(segment.data.qq) === String(event.self_id)),
  };
};

// Direct chats reuse the same conversation/persona pipeline, with their own scope.
export const parseChatMessage = (event: unknown): ChatMessage | null => {
  if (!isRecord(event) || event.message_type !== 'private') return parseGroupMessage(event);
  if (event.post_type !== 'message' || !isId(event.self_id) || !isId(event.user_id) ||
      String(event.self_id) === String(event.user_id) || !Array.isArray(event.message)) return null;
  const parsed = parseGroupMessage({ ...event, message_type: 'group', group_id: 1 });
  return parsed ? { ...parsed, chatId: privateChatId(String(event.user_id)),
    isMentioned: true, hasAnyMention: false, mentionedIds: [] } : null;
};

export const matchesChat = (data: unknown, message: ChatMessage): boolean => {
  if (!isRecord(data) || !isRecord(data.sender)) return false;
  if (!isPrivateChat(message.chatId)) return data.message_type === 'group' && String(data.group_id) === message.chatId;
  if (data.message_type !== 'private') return false;
  const sender = String(data.sender.user_id);
  return sender === message.senderId || sender === message.selfId && String(data.target_id) === message.senderId;
};

export const isBotGroupReply = (data: unknown, message: ChatMessage): boolean =>
  isRecord(data) && matchesChat(data,message) &&
  String(data.message_id) === message.replyMessageId &&
  isRecord(data.sender) && String(data.sender.user_id) === message.selfId;


// Metadata only: never dispatch history as events or retain attachment URLs.
export const imageReferenceHistory = (data: unknown, current: ChatMessage): readonly ContextMessage[] | undefined => {
  if (!isRecord(data) || !Array.isArray(data.messages) || data.messages.length > 100) return;
  const rows = data.messages;
  const anchor = rows.findIndex(row => isRecord(row) && String(row.message_id) === current.messageId &&
    String(row.group_id) === current.chatId && String(row.user_id ?? (isRecord(row.sender) ? row.sender.user_id : '')) === current.senderId);
  if (anchor < 0) return;
  // Slice before validating entries, so malformed entries cannot expand the twenty-floor scope.
  const selected = rows.slice(Math.max(0, anchor - 20), anchor + 1);
  const messages: ContextMessage[] = [];
  for (const row of selected) {
    if (!isRecord(row) || row.message_type !== 'group' || String(row.group_id) !== current.chatId ||
      !Array.isArray(row.message) || !/^-?\d+$/.test(String(row.message_id))) return;
    const sender = String(row.user_id ?? (isRecord(row.sender) ? row.sender.user_id : ''));
    if (!/^\d+$/.test(sender) || isRecord(row.sender) && row.sender.user_id !== undefined && String(row.sender.user_id) !== sender) return;
    const segments = row.message.filter(isRecord);
    const count = segments.filter(segment => segment.type === 'image').length;
    const text = segments.filter(segment => segment.type === 'text' && isRecord(segment.data))
      .map(segment => (segment.data as Record<string, unknown>).text).filter(value => typeof value === 'string').join('').slice(0, 1000);
    messages.push({ id: String(row.message_id), senderId: sender, role: sender === current.selfId ? 'assistant' : 'user',
      text, at: 0, revision: messages.length + 1, mentions: [], media: count > 0,
      ...(count ? { imageCount: Math.min(count, 2) } : {}) });
  }
  if (new Set(messages.map(message => message.id)).size !== messages.length) return;
  return messages;
};

// Adapt get_msg into the channel-neutral reference contract. Scope validation
// happens before exposing any text or attachment to the application.
export const normalizeMessageReference = (data: unknown, current: ChatMessage): ReferencedMessage | undefined => {
  if (!isRecord(data) || !matchesChat(data, current) || !isRecord(data.sender) ||
      !isId(data.sender.user_id) || !/^-?\d+$/.test(String(data.message_id))) return;
  const text = typeof data.message === 'string' ? data.message : Array.isArray(data.message)
    ? data.message.filter(isRecord).filter(s => s.type === 'text' && isRecord(s.data))
      .map(s => (s.data as Record<string, unknown>).text).filter(s => typeof s === 'string').join('') : undefined;
  return { chatId: current.chatId, messageId: String(data.message_id), senderId: String(data.sender.user_id),
    text, attachments: imageAttachments(data.message) };
};
