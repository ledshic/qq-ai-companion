import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { handleGroupMessage } from './message.js';
import { ConversationMemory, type ChatTurn } from './memory.js';
import { isRecord, parseGroupMessage, isBotGroupReply } from './onebot.js';

export const connectNapCat = (url: string, token: string,
  generateReply?: (content: string, history: ChatTurn[]) => Promise<string>) => {
  const memory = new ConversationMemory();
  let busy: object | undefined;
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: (success: boolean) => void }>();

  const lookups = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (data: unknown) => void }>();
  const clearPending = (): void => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.finish(false); }
    pending.clear();
    for (const lookup of lookups.values()) { clearTimeout(lookup.timer); lookup.resolve(null); }
    lookups.clear();
  };

  const connect = (): void => {
    socket = new WebSocket(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
    });
    const activeSocket = socket;
    socket.on('open', () => console.log('[NapCat] 已连接，等待群消息。'));
    socket.on('error', () => console.error('[NapCat] 连接错误，请检查地址、Token 和服务状态。'));
    socket.on('close', () => {
      clearPending();
      if (!stopped) {
        console.log('[NapCat] 连接断开，3 秒后重连；不重发未确认的回复。');
        reconnect = setTimeout(connect, 3000);
      }
    });
    socket.on('message', async raw => {
      let event: unknown;
      try { event = JSON.parse(raw.toString()); }
      catch { console.error('[NapCat] 忽略无效 JSON。'); return; }

      if (isRecord(event) && typeof event.echo === 'string' && lookups.has(event.echo)) {
        const lookup = lookups.get(event.echo)!;
        lookups.delete(event.echo);
        clearTimeout(lookup.timer);
        lookup.resolve(event.status === 'ok' && event.retcode === 0 ? event.data : null);
        return;
      }
      if (isRecord(event) && typeof event.echo === 'string' && pending.has(event.echo)) {
        const entry = pending.get(event.echo)!;
        clearTimeout(entry.timer);
        pending.delete(event.echo);
        const success = event.status === 'ok' && event.retcode === 0;
        entry.finish(success);
        console.log(success ? '[NapCat] 回复发送成功。' : '[NapCat] 回复发送失败，请查看 NapCat 日志。');
        return;
      }

      const message = parseGroupMessage(event);
      if (message === null) return;
      if (!message.isMentioned && !message.replyMessageId) return;
      if (busy) { console.log('[LLM] 正在处理上一条消息，忽略本次请求。'); return; }
      const job = {};
      busy = job;
      const release = (): void => { if (busy === job) busy = undefined; };
      if (!message.isMentioned && message.replyMessageId) {
        const data = await new Promise<unknown>(resolve => {
          const echo = randomUUID();
          lookups.set(echo, { resolve, timer: setTimeout(() => {
            lookups.delete(echo); resolve(null);
          }, 5000) });
          activeSocket.send(JSON.stringify({ action: 'get_msg', params: { message_id: message.replyMessageId }, echo }), error => {
            if (error) {
              const lookup = lookups.get(echo);
              if (lookup) { clearTimeout(lookup.timer); lookups.delete(echo); resolve(null); }
            }
          });
        });
        message.isReplyToBot = isBotGroupReply(data, message);
        console.log(message.isReplyToBot ? '[触发] 引用机器人消息。' : '[触发] 引用未确认属于本群机器人，忽略。');
      }
      const reply = handleGroupMessage(message);
      if (reply === null || stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) { release(); return; }
      let commit: (() => void) | undefined;
      if (generateReply) {
        const content = message.content.trim();
        if (content === '/清空记忆') {
          memory.clear(message.groupId, message.senderId);
          reply.content = '已清空你在本群与我的聊天记忆。';
          console.log('[记忆] 已清空当前会话。');
        } else if (!content || content.length > 4000) {
          reply.content = '请在 @ 后发送 1 至 4000 个字符的文字。';
        } else {
          try {
            const history = memory.get(message.groupId, message.senderId);
            console.log(`[记忆] 本次携带历史 ${history.length / 2} 轮。`);
            reply.content = await generateReply(content, history);
            commit = () => memory.add(message.groupId, message.senderId, content, reply.content);
          } catch {
            console.error('[LLM] 请求失败或超时，请检查服务、密钥和余额。');
            reply.content = '我暂时没能生成回复，请稍后再试。';
          }
        }
      }
      if (stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) { release(); return; }
      const echo = randomUUID();
      const finish = (success: boolean): void => { if (success) commit?.(); release(); };
      pending.set(echo, { finish, timer: setTimeout(() => {
        pending.delete(echo);
        finish(false);
        console.error('[NapCat] 回复确认超时，不自动重发。');
      }, 10_000) });
      activeSocket.send(JSON.stringify({
        action: 'send_group_msg',
        params: { group_id: reply.groupId, message: [{ type: 'text', data: { text: reply.content } }] },
        echo,
      }), error => {
        if (error) {
          const entry = pending.get(echo);
          if (entry) { clearTimeout(entry.timer); pending.delete(echo); entry.finish(false); }
          console.error('[NapCat] 回复写入连接失败。');
        }
      });
    });
  };
  connect();

  return (): void => {
    stopped = true;
    clearTimeout(reconnect);
    clearPending();
    socket.terminate();
  };
};
