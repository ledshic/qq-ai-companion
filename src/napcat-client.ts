import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { handleGroupMessage } from './message.js';
import { isRecord, parseGroupMessage } from './onebot.js';

export const connectNapCat = (url: string, token: string) => {
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  const connect = (): void => {
    socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    });
    socket.on('open', () => console.log('[NapCat] 已连接，等待群消息。'));
    socket.on('error', () => console.error('[NapCat] 连接错误，请检查地址、Token 和服务状态。'));
    socket.on('close', () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      if (!stopped) {
        console.log('[NapCat] 连接断开，3 秒后重连；不重发未确认的回复。');
        reconnect = setTimeout(connect, 3000);
      }
    });
    socket.on('message', raw => {
      let event: unknown;
      try { event = JSON.parse(raw.toString()); }
      catch { console.error('[NapCat] 忽略无效 JSON。'); return; }

      if (isRecord(event) && typeof event.echo === 'string' && pending.has(event.echo)) {
        clearTimeout(pending.get(event.echo));
        pending.delete(event.echo);
        console.log(event.status === 'ok' && event.retcode === 0
          ? '[NapCat] 回复发送成功。' : '[NapCat] 回复发送失败，请查看 NapCat 日志。');
        return;
      }

      const message = parseGroupMessage(event);
      if (message === null) return;
      const reply = handleGroupMessage(message);
      if (reply === null) return;
      const echo = randomUUID();
      pending.set(echo, setTimeout(() => {
        pending.delete(echo);
        console.error('[NapCat] 回复确认超时，不自动重发。');
      }, 10_000));
      socket.send(JSON.stringify({
        action: 'send_group_msg',
        params: { group_id: reply.groupId, message: [{ type: 'text', data: { text: reply.content } }] },
        echo,
      }), error => {
        if (error) console.error('[NapCat] 回复写入连接失败。');
      });
    });
  };
  connect();

  return (): void => {
    stopped = true;
    clearTimeout(reconnect);
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    socket.terminate();
  };
};
