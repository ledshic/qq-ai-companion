import { ObservationWindows, type FollowUpJudge } from './observation.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { handleGroupMessage } from './message.js';
import { ConversationMemory, type ChatTurn } from './memory.js';
import { isRecord, parseGroupMessage, isBotGroupReply } from './onebot.js';

export const connectNapCat = (url: string, token: string,
  generateReply?: (content: string, history: ChatTurn[]) => Promise<string>,
  judgeFollowUp?: FollowUpJudge,
  options: { autoReply?: boolean; now?: () => number; log?: (line: string) => void } = {}) => {
  const log = options.log ?? console.log;
  const windows = new ObservationWindows(options.now, 60_000, () => log('[跳过] 他人插话，窗口立即结束。'));
  let observing = false;
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
    windows.clear();
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
    socket.on('open', () => log('[NapCat] 已连接，等待群消息。'));
    socket.on('error', () => console.error('[NapCat] 连接错误，请检查地址、Token 和服务状态。'));
    socket.on('close', () => {
      clearPending();
      if (!stopped) {
        log('[NapCat] 连接断开，3 秒后重连；不重发未确认的回复。');
        reconnect = setTimeout(connect, 3000);
      }
    });
    const sendReply = (groupId: string, content: string, finish: (success: boolean) => void): void => {
      const echo = randomUUID();
      pending.set(echo, { finish, timer: setTimeout(() => {
        pending.delete(echo); finish(false);
        console.error('[NapCat] 回复确认超时，不自动重发。');
      }, 10_000) });
      activeSocket.send(JSON.stringify({ action: 'send_group_msg',
        params: { group_id: groupId, message: [{ type: 'text', data: { text: content } }] }, echo,
      }), error => {
        if (error) {
          const entry = pending.get(echo);
          if (entry) { clearTimeout(entry.timer); pending.delete(echo); entry.finish(false); }
          console.error('[NapCat] 回复写入连接失败。');
        }
      });
    };
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
        log(success ? '[NapCat] 回复发送成功。' : '[NapCat] 回复发送失败，请查看 NapCat 日志。');
        return;
      }

      const message = parseGroupMessage(event);
      if (message === null) return;
      const ticket = windows.incoming(message.groupId, message.senderId);
      if (!message.isMentioned && !message.replyMessageId && !message.isCalledByName) {
        const valid = windows.candidate(message.groupId, message.senderId);
        const text = message.content.trim();
        if (judgeFollowUp && !valid) log(`[跳过] ${windows.skipReason(message.groupId, message.senderId)}。`);
        if (judgeFollowUp && valid && (message.hasAnyMention || !text || text.length > 4000)) log('[跳过] 消息含其他@、无文本或文本超限。');
        if (judgeFollowUp && valid && !message.hasAnyMention && text && text.length <= 4000) {
          if (observing || busy) { log(`[跳过] 忙碌（${observing ? '正在判断或生成接话' : '正在生成回复或等待发送确认'}），本次不处理。`); return; }
          const history = memory.get(message.groupId, message.senderId);
          if (!history.length) return;
          observing = true;
          const autoJob = {};
          if (options.autoReply) busy = autoJob;
          let awaitingAck = false;
          const releaseAuto = (): void => { if (busy === autoJob) busy = undefined; };
          const canSend = (): boolean => !stopped && activeSocket === socket && activeSocket.readyState === WebSocket.OPEN && valid();
          try {
            const decision = await judgeFollowUp(text, history);
            if (!canSend()) { log('[接续] 窗口已结束，丢弃迟到的判断；不接话。'); return; }
            const intentLabel = { continue: '继续', pause: '暂停', end: '结束', uncertain: '不确定' }[decision.intent];
            log(`[${options.autoReply ? '自动接话' : '观察'}] intent=${intentLabel}; wouldRespond=${decision.shouldRespond}; reason=${decision.reason}; 历史${history.length / 2}轮。`);
            if (decision.intent === 'end') { windows.close(message.groupId, 'ended'); log('[跳过] 用户明确结束对话，关闭窗口。'); }
            if (!options.autoReply || !decision.shouldRespond || !generateReply) return;
            const answer = await generateReply(text, history);
            if (!canSend()) { log('[自动接话] 发送前窗口失效，取消回复。'); return; }
            awaitingAck = true;
            sendReply(message.groupId, answer, success => {
              if (success) {
                memory.add(message.groupId, message.senderId, text, answer);
                valid.consume();
                log('[自动接话] 成功回复已写入记忆，计入本窗口2次限额。');
              }
              releaseAuto();
            });
          } catch { log('[接续] 判断或生成失败、超时，默认不接话。'); }
          finally { observing = false; if (!awaitingAck) releaseAuto(); }
        }
        return;
      }
      windows.close(message.groupId);
      if (busy) { log('[跳过] 忙碌，明确呼叫暂未处理；旧窗口已关闭。'); return; }
      const job = {};
      busy = job;
      const release = (): void => { if (busy === job) busy = undefined; };
      if (!message.isMentioned && !message.isCalledByName && message.replyMessageId) {
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
        log(message.isReplyToBot ? '[触发] 引用机器人消息。' : '[触发] 引用未确认属于本群机器人，忽略。');
      }
      if (message.isCalledByName) log('[触发] 句首称呼命中（大肥鱼）。');
      const reply = handleGroupMessage(message);
      if (reply === null || stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) { release(); return; }
      let commit: (() => void) | undefined;
      if (generateReply) {
        const content = message.content.trim();
        if (content === '/清空记忆') {
          memory.clear(message.groupId, message.senderId);
          windows.close(message.groupId);
          reply.content = '已清空你在本群与我的聊天记忆。';
          log('[记忆] 已清空当前会话。');
        } else if (!content || content.length > 4000) {
          reply.content = '请在 @、引用或称呼后发送 1 至 4000 个字符的文字。';
        } else {
          try {
            const history = memory.get(message.groupId, message.senderId);
            log(`[记忆] 本次携带历史 ${history.length / 2} 轮。`);
            reply.content = await generateReply(content, history);
            commit = () => memory.add(message.groupId, message.senderId, content, reply.content);
          } catch {
            console.error('[LLM] 请求失败或超时，请检查服务、密钥和余额。');
            reply.content = '我暂时没能生成回复，请稍后再试。';
          }
        }
      }
      if (stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) { release(); return; }
      const finish = (success: boolean): void => {
        if (success && commit) {
          commit();
          if (judgeFollowUp) { windows.open(message.groupId, ticket); log('[接续] 明确呼叫回复成功，开启60秒窗口，最多自动接话2次。'); }
        }
        release();
      };
      sendReply(reply.groupId, reply.content, finish);
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
