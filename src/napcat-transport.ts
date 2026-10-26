import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { DeliveryTarget } from './context.js';
import type { DeliveryChannel } from './delivery-types.js';
import type { GroupMessage } from './message.js';
import { isRecord } from './value.js';
import { parseGroupMessage } from './onebot.js';

export interface NapCatTransportEvents {
  connected: () => void;
  disconnected: () => void;
  message: (message: GroupMessage) => void;
  acknowledged: (groupId: string, content: string, messageId?: string, target?: DeliveryTarget) => void;
}

// Owns only the OneBot connection, action correlation and connection-bound sends.
// Start after application handlers have been assembled.
export const createNapCatTransport = (url: string, token: string, events: NapCatTransportEvents,
  log: (line: string) => void = console.log) => {
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: (success: boolean) => void; groupId: string; content: string; target?: DeliveryTarget }>();
  const lookups = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (data: unknown) => void }>();

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

  const capture = (groupId: string): DeliveryChannel | undefined => {
    const target = activeSocket();
    if (!target) return;
    return {
      connected: () => !stopped && socket === target && target.readyState === WebSocket.OPEN,
      send: (content, targetInfo, image) => new Promise<boolean>(done =>
        sendPart(target, groupId, content, done, targetInfo, image)),
    };
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
    socket.on('open', () => { events.connected(); log('[NapCat] 已连接，等待群消息。'); });
    socket.on('error', () => console.error('[NapCat] 连接错误，请检查地址、Token 和服务状态。'));
    socket.on('close', () => {
      clearPending();
      events.disconnected();
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
          if (success) events.acknowledged(pendingEntry.groupId, pendingEntry.content,
            isRecord(event.data) && (typeof event.data.message_id === 'string' || typeof event.data.message_id === 'number')
              ? String(event.data.message_id) : undefined, pendingEntry.target);
          pendingEntry.finish(success);
          log(success ? '[NapCat] 回复发送成功。' : '[NapCat] 回复发送失败，请查看 NapCat 日志。');
          return;
        }
      }

      const message = parseGroupMessage(event);
      if (message === null) return;
      events.message(message);
    });
  };
  const stop = (): void => {
    stopped = true;
    clearTimeout(reconnect);
    events.disconnected();
    clearPending();
    socket.terminate();
  };
  return { start: connect, stop, capture, lookup: actionLookup };
};
