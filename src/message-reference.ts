import type { ChatContext, ReplyContext } from './context.js';
import type { ChatMessage } from './message.js';
import type { ImageRequestJudge } from './vision-types.js';
import type { ReferencedMessage, ReferenceHistory, MessageLookup, HistoryLookup } from './channel.js';

export const matchesReference = (data: ReferencedMessage | undefined, message: ChatMessage,
  messageId: string | undefined): data is ReferencedMessage =>
  !!data && !!messageId && data.chatId === message.chatId && data.messageId === messageId && !!data.senderId;

export const isBotReference = (data: ReferencedMessage | undefined, message: ChatMessage): boolean =>
  matchesReference(data, message, message.replyMessageId) && !!message.selfId && data.senderId === message.selfId;

export const applyMessageReference = (message: ChatMessage, data: ReferencedMessage | undefined,
  discussion: Pick<ChatContext, 'resolveReference'>): void => {
  if (!matchesReference(data, message, message.replyMessageId)) return;
  message.replyToSenderId = data.senderId;
  message.quotedAttachments = data.attachments;
  discussion.resolveReference(message.chatId, message.messageId!, data.senderId, data.text);
};

// Keep the same twenty-floor bound even for a channel with a larger history.
// Project fields explicitly so attachment payloads cannot leak into model context.
export const referenceHistorySnapshot = (data: ReferenceHistory | undefined, current: ChatMessage) => {
  if (!data || data.chatId !== current.chatId || data.messages.length > 100 ||
      new Set(data.messages.map(row => row.id)).size !== data.messages.length) return;
  const anchor = data.messages.findIndex(row => row.id === current.messageId && row.senderId === current.senderId);
  if (anchor < 0) return;
  const selected = data.messages.slice(Math.max(0, anchor - 20), anchor + 1);
  return selected.map(row => ({ id: row.id, senderId: row.senderId, role: row.role,
    text: row.text.slice(0, 1000), at: row.at, revision: row.revision, mentions: [...row.mentions],
    media: row.media, ...(row.imageCount ? { imageCount: Math.min(row.imageCount, 2) } : {}) }));
};

export interface ImageReferenceOptions {
  enabled: boolean;
  discussion: Pick<ChatContext, 'referenceSnapshot'>;
  imageRequest?: ImageRequestJudge;
  referenceHistory?: HistoryLookup;
  lookup?: MessageLookup;
  isCurrent: () => boolean;
  log: (line: string) => void;
}

export const prepareImageReference = async (message: ChatMessage, context: ReplyContext,
  signal: AbortSignal, options: ImageReferenceOptions): Promise<void> => {
  const content = message.content.trim();
  // The user may send a picture first and explicitly ask about it in a later message.
  // Keep only its ID/count in discussion context; resolve bytes only after intent is confirmed.
  if (options.enabled && options.imageRequest && content && content.length <= 4000 && content !== '/清空记忆' &&
      !message.replyMessageId && !message.attachments?.imageCount) {
    let referenceContext = { ...context, snapshot: options.discussion.referenceSnapshot(message.chatId) };
    const currentIndex = referenceContext.snapshot.messages.findIndex(entry => entry.id === message.messageId);
    const above = currentIndex < 0 ? [] : referenceContext.snapshot.messages.slice(Math.max(0, currentIndex - 20), currentIndex);
    let recent = [...above].reverse().find(entry => entry.role === 'user' && entry.imageCount && entry.senderId === message.senderId);
    if (!recent && above.length < 20 && options.referenceHistory) {
      options.log('[识图] 本地附近记录不足，按楼层查询群历史。');
      try {
        const data = await options.referenceHistory(message, signal);
        signal.throwIfAborted();
        if (!options.isCurrent()) return;
        const history = referenceHistorySnapshot(data, message);
        if (history) {
          referenceContext = { ...context, snapshot: { ...context.snapshot, messages: history } };
          recent = [...history].reverse().find(entry => entry.id !== message.messageId && entry.role === 'user' &&
            entry.imageCount && entry.senderId === message.senderId);
        }
      } catch { signal.throwIfAborted(); options.log('[识图] 群历史查询失败，未读取历史图片。'); }
    }
    options.log(`[识图] 附近本人图片候选${recent ? '已找到' : '不存在'}。`);
    if (recent) {
      let inspect = false;
      try { inspect = await options.imageRequest(content, referenceContext, recent.id, signal); }
      catch { signal.throwIfAborted(); options.log('[识图] 图片指向判断失败，不自动读取先前图片。'); }
      options.log(`[识图] 图片指向${inspect ? '已确认' : '未确认'}。`);
      if (inspect && !signal.aborted && options.isCurrent()) {
        options.log('[识图] 明确请求指向附近同用户图片，查询原消息。');
        let data: ReferencedMessage | undefined;
        try { data = await options.lookup?.(recent.id, signal, message); }
        catch { signal.throwIfAborted(); }
        signal.throwIfAborted();
        if (!options.isCurrent()) return;
        // Verify chat, author and event again before exposing the selected image.
        message.quotedAttachments = matchesReference(data, message, recent.id) && data.senderId === message.senderId
          ? data.attachments ?? { imageCount: 0, images: [] } : { imageCount: 1, images: [{}] };
        if (!message.quotedAttachments.imageCount) message.quotedAttachments = { imageCount: 1, images: [{}] };
      }
    }
  }
};
