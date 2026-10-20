import { deliverPersonaReply } from './delivery.js';
import { Conversation } from './conversation.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ConversationMemory, type ChatTurn } from './memory.js';
import { SqliteSessionStore } from './store.js';
import type { FollowUpJudge } from './observation.js';
import { isRecord, parseGroupMessage } from './onebot.js';

export interface NapCatOptions {
  autoReply?: boolean;
  memory?: ConversationMemory;
  maxInflight?: number;
  now?: () => number;
  log?: (line: string) => void;
}

// Transport only: authenticate, route action echoes and hand parsed group
// messages to the conversation scheduler.
export const connectNapCat = (url: string, token: string,
  generateReply?: (content: string, history: ChatTurn[], signal: AbortSignal) => Promise<string>,
  judgeFollowUp?: FollowUpJudge,
  options: NapCatOptions = {}) => {
  const log = options.log ?? console.log;
  const memory = options.memory ?? new ConversationMemory(new SqliteSessionStore(':memory:'));
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const sendQueues = new Map<string, Promise<void>>();
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: (success: boolean) => void }>();
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

  const sendPart = (target: WebSocket, groupId: string, content: string, finish: (success: boolean) => void): void => {
    const echo = randomUUID();
    pending.set(echo, { finish, timer: setTimeout(() => {
      pending.delete(echo); finish(false);
      console.error('[NapCat] 回复确认超时，不自动重发。');
    }, 10_000) });
    target.send(JSON.stringify({ action: 'send_group_msg',
      params: { group_id: groupId, message: [{ type: 'text', data: { text: content } }] }, echo,
    }), error => {
      if (!error) return;
      const entry = pending.get(echo);
      if (entry) { clearTimeout(entry.timer); pending.delete(echo); entry.finish(false); }
      console.error('[NapCat] 回复写入连接失败。');
    });
  };

  const deliver = (groupId: string, content: string, guard: () => boolean): Promise<string | undefined> => {
    const target = activeSocket();
    if (!target) return Promise.resolve(undefined);
    return new Promise(resolve => {
      void enqueueSend(groupId, () => deliverPersonaReply(content,
        part => new Promise<boolean>(partDone => sendPart(target, groupId, part, partDone)),
        () => !stopped && socket === target && target.readyState === WebSocket.OPEN && guard()))
        .then(delivered => resolve(delivered || undefined))
        .catch(() => resolve(undefined));
    });
  };

  const lookup = (messageId: string, signal: AbortSignal): Promise<unknown> => {
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
      target.send(JSON.stringify({ action: 'get_msg', params: { message_id: messageId }, echo }), error => {
        if (error) settle(null);
      });
    });
  };

  const conversation = new Conversation({
    memory,
    send: deliver,
    lookup,
    judge: judgeFollowUp,
    generate: generateReply,
    maxInflight: options.maxInflight,
    autoReply: options.autoReply,
    now: options.now,
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

  return (): void => {
    stopped = true;
    clearTimeout(reconnect);
    conversation.disconnect();
    clearPending();
    socket.terminate();
  };
};
