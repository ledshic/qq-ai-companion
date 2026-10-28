import type { DeliveryChannel } from './delivery-types.js';
import type { MemeSendContext } from '../../tools/memes/meme-types.js';
import type { DeliveryTarget, SendGuard } from '../conversation/context.js';
import { deliverPersonaReply, splitPersonaReply } from './delivery.js';
import { memeNote, stripMemeRecords, type MemeManager } from '../../tools/memes/memes.js';

export type { DeliveryChannel } from './delivery-types.js';

// Capture the connection before queueing so a reconnect cannot send an old draft.
export const createReplyDelivery = (capture: (chatId: string) => DeliveryChannel | undefined,
  memes?: MemeManager, log: (line: string) => void = console.log) => {
  const sendQueues = new Map<string, Promise<void>>();
  const enqueueSend = <T,>(chatId: string, task: () => Promise<T>): Promise<T> => {
    const previous = sendQueues.get(chatId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(() => undefined, () => undefined);
    sendQueues.set(chatId, tail);
    void tail.then(() => { if (sendQueues.get(chatId) === tail) sendQueues.delete(chatId); });
    return next;
  };

  return (chatId: string, content: string, guard: SendGuard, targetInfo?: DeliveryTarget,
    media?: MemeSendContext): Promise<string | undefined> => {
    content = stripMemeRecords(content);
    if (!content) return Promise.resolve(undefined);
    const channel = capture(chatId);
    if (!channel) return Promise.resolve(undefined);
    return enqueueSend(chatId, async () => {
      const allowed = async (check = guard) => channel.connected() && await check() && channel.connected();
      if (!await allowed()) return '';
      let entry = media && memes ? await memes.choose(chatId, content, media.context, media.signal) : undefined;
      let effectiveGuard = guard;
      if (entry && media) {
        try { const approved = await media.approve(memeNote(entry)); if (approved) effectiveGuard = async () => await approved() && await guard(); else entry = undefined; }
        catch { entry = undefined; }
      }
      let delivered = await deliverPersonaReply(content,
        part => channel.send(part, targetInfo), () => allowed(effectiveGuard));
      let attempted = false;
      if (entry && memes && delivered === splitPersonaReply(content).join('\n')) {
        try {
          const image = memes.image(entry);
          if (await allowed(effectiveGuard)) {
            memes.attempt(chatId, entry.id); attempted = true;
            const note = memeNote(entry);
            const ok = await channel.send(note, targetInfo, image);
            if (ok) delivered += '\n' + note;
            log(`[表情] ${ok ? '已确认发送' : '发送未确认，不重发'} ${entry.id}`);
          }
        } catch { log('[表情] 图片未发送，保留已确认文字。'); }
      }
      memes?.finish(chatId, !!delivered, attempted);
      return delivered;
    }).then(delivered => delivered || undefined).catch(() => undefined);
  };
};
