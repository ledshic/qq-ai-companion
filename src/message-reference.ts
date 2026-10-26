import type { GroupContext, ReplyContext } from './context.js';
import type { GroupMessage } from './message.js';
import type { ImageRequestJudge } from './vision.js';
import { isRecord, imageAttachments, imageReferenceHistory } from './onebot.js';

// Protocol validation stays here; the conversation owns when a result is current.
export const applyMessageReference = (message: GroupMessage, data: unknown, discussion: Pick<GroupContext, 'resolveReference'>): void => {
  if (isRecord(data) && data.message_type === 'group' && String(data.group_id) === message.groupId &&
      String(data.message_id) === message.replyMessageId && isRecord(data.sender) && /^\d+$/.test(String(data.sender.user_id))) {
    message.replyToSenderId = String(data.sender.user_id);
    message.quotedAttachments = imageAttachments(data.message);
    const quotedText = typeof data.message === 'string' ? data.message : Array.isArray(data.message)
      ? data.message.filter(isRecord).filter(s => s.type === 'text' && isRecord(s.data))
        .map(s => (s.data as Record<string, unknown>).text).filter(s => typeof s === 'string').join('') : undefined;
    discussion.resolveReference(message.groupId, message.messageId!, message.replyToSenderId, quotedText);
  }
};

export interface ImageReferenceOptions {
  enabled: boolean;
  discussion: Pick<GroupContext, 'referenceSnapshot'>;
  imageRequest?: ImageRequestJudge;
  referenceHistory?: (groupId: string, signal: AbortSignal) => Promise<unknown>;
  lookup?: (messageId: string, signal: AbortSignal) => Promise<unknown>;
  isCurrent: () => boolean;
  log: (line: string) => void;
}

export const prepareImageReference = async (message: GroupMessage, context: ReplyContext,
  signal: AbortSignal, options: ImageReferenceOptions): Promise<void> => {
  const content = message.content.trim();
  // The user may send a picture first and explicitly ask about it in a later message.
  // Keep only its ID/count in discussion context; resolve bytes only after intent is confirmed.
  if (options.enabled && options.imageRequest && content && content.length <= 4000 && content !== '/清空记忆' &&
      !message.replyMessageId && !message.attachments?.imageCount) {
    let referenceContext = { ...context, snapshot: options.discussion.referenceSnapshot(message.groupId) };
    const currentIndex = referenceContext.snapshot.messages.findIndex(entry => entry.id === message.messageId);
    const above = currentIndex < 0 ? [] : referenceContext.snapshot.messages.slice(Math.max(0, currentIndex - 20), currentIndex);
    let recent = [...above].reverse().find(entry => entry.role === 'user' && entry.imageCount && entry.senderId === message.senderId);
    if (!recent && above.length < 20 && options.referenceHistory) {
      options.log('[识图] 本地附近记录不足，按楼层查询群历史。');
      try {
        const data = await options.referenceHistory(message.groupId, signal);
        signal.throwIfAborted();
        if (!options.isCurrent()) return;
        const history = imageReferenceHistory(data, message);
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
        let data: unknown;
        try { data = await options.lookup?.(recent.id, signal); }
        catch { signal.throwIfAborted(); }
        signal.throwIfAborted();
        if (!options.isCurrent()) return;
        // Do not accept a different group, author or event even if get_msg returned an image.
        message.quotedAttachments = isRecord(data) && data.message_type === 'group' &&
          String(data.group_id) === message.groupId && String(data.message_id) === recent.id &&
          isRecord(data.sender) && String(data.sender.user_id) === message.senderId
          ? imageAttachments(data.message) : { imageCount: 1, images: [{}] };
        if (!message.quotedAttachments.imageCount) message.quotedAttachments = { imageCount: 1, images: [{}] };
      }
    }
  }
};
