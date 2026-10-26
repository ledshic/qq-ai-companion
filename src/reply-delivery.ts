import type { DeliveryTarget, SendGuard } from './context.js';
import { deliverPersonaReply, splitPersonaReply } from './delivery.js';
import { memeNote, stripMemeRecords, type MemeManager, type MemeSendContext } from './memes.js';

export interface DeliveryChannel {
  connected: () => boolean;
  send: (content: string, target?: DeliveryTarget, image?: string) => Promise<boolean>;
}

// Capture the connection before queueing so a reconnect cannot send an old draft.
export const createReplyDelivery = (capture: (groupId: string) => DeliveryChannel | undefined,
  memes?: MemeManager, log: (line: string) => void = console.log) => {
  const sendQueues = new Map<string, Promise<void>>();
  const enqueueSend = <T,>(group: string, task: () => Promise<T>): Promise<T> => {
    const previous = sendQueues.get(group) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(() => undefined, () => undefined);
    sendQueues.set(group, tail);
    void tail.then(() => { if (sendQueues.get(group) === tail) sendQueues.delete(group); });
    return next;
  };

  return (groupId: string, content: string, guard: SendGuard, targetInfo?: DeliveryTarget,
    media?: MemeSendContext): Promise<string | undefined> => {
    content = stripMemeRecords(content);
    if (!content) return Promise.resolve(undefined);
    const channel = capture(groupId);
    if (!channel) return Promise.resolve(undefined);
    return enqueueSend(groupId, async () => {
      const allowed = async (check = guard) => channel.connected() && await check() && channel.connected();
      if (!await allowed()) return '';
      let entry = media && memes ? await memes.choose(groupId, content, media.context, media.signal) : undefined;
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
            memes.attempt(groupId, entry.id); attempted = true;
            const note = memeNote(entry);
            const ok = await channel.send(note, targetInfo, image);
            if (ok) delivered += '\n' + note;
            log(`[表情] ${ok ? '已确认发送' : '发送未确认，不重发'} ${entry.id}`);
          }
        } catch { log('[表情] 图片未发送，保留已确认文字。'); }
      }
      memes?.finish(groupId, !!delivered, attempted);
      return delivered;
    }).then(delivered => delivered || undefined).catch(() => undefined);
  };
};
