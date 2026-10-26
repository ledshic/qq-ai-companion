import type { ChatMessage } from './message.js';
import type { ChatSnapshot, ReplyContext, SendGuard } from './context.js';

export interface SendReviewServices {
  unified?: boolean;
  senderCurrent: () => boolean;
  candidate?: () => boolean;
  snapshot: () => ChatSnapshot;
  reconsider: (context: ReplyContext) => Promise<boolean | undefined>;
  log: (line: string) => void;
}

// Owns one draft's approval key. The caller provides live conversation state and
// judge routing; the returned guard is reused before every queued delivery part.
export const approveSend = async (message: Pick<ChatMessage, 'messageId' | 'senderId'>,
  context: ReplyContext, draft: string, signal: AbortSignal, services: SendReviewServices): Promise<SendGuard | undefined> => {
  const current = () => !signal.aborted && services.senderCurrent() && (!services.candidate || services.candidate()) &&
    (!context.memoryGuard || context.memoryGuard());
  if (!current()) return;
  if (!services.unified) return current;
  // Ignore only acknowledged parts replying to this request for this sender.
  // Other bot replies and every new human message still change the key.
  const changeKey = (snapshot: ChatSnapshot) => `${snapshot.incomingVersion}:` + snapshot.messages
    .filter(m => m.role === 'assistant' && !(m.replyTo === message.messageId && m.mentions.includes(message.senderId)))
    .map(m => m.id).join(',');
  let approvedKey = changeKey(context.snapshot);
  const guard: SendGuard = async () => {
    if (!current()) return false;
    const snapshot = services.snapshot();
    const latestKey = changeKey(snapshot);
    if (latestKey !== approvedKey) {
      const review = { ...context, snapshot, phase: 'before_send' as const, draft };
      const respond = await services.reconsider(review);
      if (!respond) { services.log('[时机] 新讨论使回复不再适合发送，跳过。'); return false; }
      if (changeKey(services.snapshot()) !== latestKey) {
        services.log('[时机] 复查期间讨论再次变化，跳过本次发送。'); return false;
      }
      approvedKey = latestKey;
    }
    return current();
  };
  // Review before enqueueing and again immediately before writing each part.
  return await guard() ? guard : undefined;
};
