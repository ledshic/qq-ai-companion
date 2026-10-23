import { memeNote, stripMemeRecords, type MemeManager, type MemeSendContext } from './memes.js';
import type { VisionHandler, ImageRequestJudge } from './vision.js';
import type { ReplyContext, DeliveryTarget, SendGuard } from './context.js';
import { deliverPersonaReply, splitPersonaReply } from './delivery.js';
import { Conversation, type ContextOptions, type InterjectOptions, type JudgeEveryOptions, type WarmupOptions } from './conversation.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ConversationMemory, type ChatTurn } from './memory.js';
import { SqliteSessionStore } from './store.js';
import type { FollowUpJudge } from './observation.js';
import { isRecord, parseGroupMessage } from './onebot.js';

export interface NapCatOptions {
  memes?: MemeManager;
  vision?: VisionHandler;
  imageRequest?: ImageRequestJudge;
  autoReply?: boolean;
  unified?: boolean;
  memory?: ConversationMemory;
  maxInflight?: number;
  maxWindows?: number;
  windowMs?: number;
  now?: () => number;
  random?: () => number;
  interject?: InterjectOptions;
  warmup?: WarmupOptions;
  judgeEvery?: JudgeEveryOptions;
  context?: ContextOptions;
  log?: (line: string) => void;
}

// Transport only: authenticate, route action echoes and hand parsed group
// messages to the conversation scheduler.
export const connectNapCat = (url: string, token: string,
  generateReply?: (content: string, history: ChatTurn[], signal: AbortSignal, allowTools?: boolean, context?: ReplyContext) => Promise<string>,
  judgeFollowUp?: FollowUpJudge,
  options: NapCatOptions = {}) => {
  const log = options.log ?? console.log;
  const memory = options.memory ?? new ConversationMemory(new SqliteSessionStore(':memory:'));
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const sendQueues = new Map<string, Promise<void>>();
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: (success: boolean) => void; groupId: string; content: string; target?: DeliveryTarget }>();
  const lookups = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (data: unknown) => void }>();

  const enqueueSend = <T,>(group: string, task: () => Promise<T>): Promise<T> => {
    const previous = sendQueues.get(group) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(() => undefined, () => undefined);
    sendQueues.set(group, tail);
    void tail.then(() => { if (sendQueues.get(group) === tail) sendQueues.delete(group); });
    return next;
  };

  const activeSocket = (): WebSocket | undefined =>
    !stopped && socket?.readyState === WebSocket.OPEN ? socket : undefined;

  const sendPart = (target: WebSocket, groupId: string, content: string, finish: (success: boolean) => void, targetInfo?: DeliveryTarget, image?: string): void => {
    const echo = randomUUID();
    pending.set(echo, { finish, groupId, content, target: targetInfo, timer: setTimeout(() => {
      pending.delete(echo); finish(false);
      console.error('[NapCat] 回复确认超时，不自动重发。');
    }, 10_000) });
    target.send(JSON.stringify({ action: 'send_group_msg',
      params: { group_id: groupId, message: image ? [{ type: 'image', data: { file: image, sub_type: 1 } }] : [{ type: 'text', data: { text: content } }] }, echo,
    }), error => {
      if (!error) return;
      const entry = pending.get(echo);
      if (entry) { clearTimeout(entry.timer); pending.delete(echo); entry.finish(false); }
      console.error('[NapCat] 回复写入连接失败。');
    });
  };

  const deliver = (groupId: string, content: string, guard: SendGuard, targetInfo?: DeliveryTarget, media?: MemeSendContext): Promise<string | undefined> => {
    content = stripMemeRecords(content);
    if (!content) return Promise.resolve(undefined);
    const target = activeSocket();
    if (!target) return Promise.resolve(undefined);
    return new Promise(resolve => {
      void enqueueSend(groupId, async () => {
        const connected = () => !stopped && socket === target && target.readyState === WebSocket.OPEN;
        const allowed = async (check = guard) => connected() && await check() && connected();
        if (!await allowed()) return '';
        let entry = media && options.memes ? await options.memes.choose(groupId, content, media.context, media.signal) : undefined;
        let effectiveGuard = guard;
        if (entry && media) {
          try { const approved = await media.approve(memeNote(entry)); if (approved) effectiveGuard = async () => await approved() && await guard(); else entry = undefined; }
          catch { entry = undefined; }
        }
        let delivered = await deliverPersonaReply(content,
          part => new Promise<boolean>(done => sendPart(target, groupId, part, done, targetInfo)), () => allowed(effectiveGuard));
        let attempted = false;
        if (entry && options.memes && delivered === splitPersonaReply(content).join('\n')) {
          try {
            const image = options.memes.image(entry);
            if (await allowed(effectiveGuard)) {
              options.memes.attempt(groupId, entry.id); attempted = true;
              const note = memeNote(entry);
              const ok = await new Promise<boolean>(done => sendPart(target, groupId, note, done, targetInfo, image));
              if (ok) delivered += '\n' + note;
              log(`[表情] ${ok ? '已确认发送' : '发送未确认，不重发'} ${entry.id}`);
            }
          } catch { log('[表情] 图片未发送，保留已确认文字。'); }
        }
        options.memes?.finish(groupId, !!delivered, attempted);
        return delivered;
      })
        .then(delivered => resolve(delivered || undefined))
        .catch(() => resolve(undefined));
    });
  };

  const actionLookup = (action: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    const target = activeSocket();
    if (!target || signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
      const echo = randomUUID();
      const settle = (value: unknown): void => {
        const entry = lookups.get(echo);
        if (!entry) return;
        clearTimeout(entry.timer);
        lookups.delete(echo);
        entry.resolve(value);
      };
      lookups.set(echo, { resolve, timer: setTimeout(() => settle(null), 5000) });
      signal.addEventListener('abort', () => settle(null), { once: true });
      target.send(JSON.stringify({ action, params, echo }), error => {
        if (error) settle(null);
      });
    });
  };

  const conversation = new Conversation({
    memory,
    unified: options.unified,
    recordsDelivery: true,
    send: deliver,
    lookup: (messageId, signal) => actionLookup('get_msg', { message_id: messageId }, signal),
    resolveImage: (file, signal) => actionLookup('get_image', { file }, signal),
    referenceHistory: (groupId, signal) => actionLookup('get_group_msg_history', { group_id: groupId, count: 21, reverseOrder: false }, signal),
    vision: options.vision,
    imageRequest: options.imageRequest,
    judge: judgeFollowUp,
    generate: generateReply,
    maxInflight: options.maxInflight,
    maxWindows: options.maxWindows,
    windowMs: options.windowMs,
    autoReply: options.autoReply,
    now: options.now,
    random: options.random,
    interject: options.interject,
    warmup: options.warmup,
    judgeEvery: options.judgeEvery,
    context: options.context,
    log,
  });

  const clearPending = (): void => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.finish(false); }
    pending.clear();
    for (const entry of lookups.values()) { clearTimeout(entry.timer); entry.resolve(null); }
    lookups.clear();
  };

  const connect = (): void => {
    socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    });
    socket.on('open', () => log('[NapCat] 已连接，等待群消息。'));
    socket.on('error', () => console.error('[NapCat] 连接错误，请检查地址、Token 和服务状态。'));
    socket.on('close', () => {
      clearPending();
      conversation.disconnect();
      if (!stopped) {
        log('[NapCat] 连接断开，3 秒后重连；不重发未确认的回复。');
        reconnect = setTimeout(connect, 3000);
      }
    });
    socket.on('message', raw => {
      let event: unknown;
      try { event = JSON.parse(raw.toString()); }
      catch { console.error('[NapCat] 忽略无效 JSON。'); return; }

      if (isRecord(event) && typeof event.echo === 'string') {
        const lookupEntry = lookups.get(event.echo);
        if (lookupEntry) {
          clearTimeout(lookupEntry.timer);
          lookups.delete(event.echo);
          lookupEntry.resolve(event.status === 'ok' && event.retcode === 0 ? event.data : null);
          return;
        }
        const pendingEntry = pending.get(event.echo);
        if (pendingEntry) {
          clearTimeout(pendingEntry.timer);
          pending.delete(event.echo);
          const success = event.status === 'ok' && event.retcode === 0;
          if (success) conversation.acknowledged(pendingEntry.groupId, pendingEntry.content,
            isRecord(event.data) && (typeof event.data.message_id === 'string' || typeof event.data.message_id === 'number')
              ? String(event.data.message_id) : undefined, pendingEntry.target);
          pendingEntry.finish(success);
          log(success ? '[NapCat] 回复发送成功。' : '[NapCat] 回复发送失败，请查看 NapCat 日志。');
          return;
        }
      }

      const message = parseGroupMessage(event);
      if (message === null) return;
      conversation.handle(message);
    });
  };
  connect();

  const stop = (): void => {
    stopped = true;
    clearTimeout(reconnect);
    conversation.disconnect();
    clearPending();
    socket.terminate();
  };
  return Object.assign(stop, { tick: (): void => conversation.tick() });
};
