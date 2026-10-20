import { deliverPersonaReply } from './delivery.js';
import { ObservationWindows, type FollowUpJudge } from './observation.js';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { handleGroupMessage } from './message.js';
import { ConversationMemory, type ChatTurn } from './memory.js';
import { SqliteSessionStore } from './store.js';
import { isRecord, parseGroupMessage, isBotGroupReply } from './onebot.js';

export interface NapCatOptions {
  autoReply?: boolean;
  memory?: ConversationMemory;
  maxInflight?: number;
  now?: () => number;
  log?: (line: string) => void;
}

const sessionKey = (groupId: string, senderId: string): string => JSON.stringify([groupId, senderId]);

export const connectNapCat = (url: string, token: string,
  generateReply?: (content: string, history: ChatTurn[]) => Promise<string>,
  judgeFollowUp?: FollowUpJudge,
  options: NapCatOptions = {}) => {
  const log = options.log ?? console.log;
  const memory = options.memory ?? new ConversationMemory(new SqliteSessionStore(':memory:'));
  const maxInflight = options.maxInflight ?? 2;
  const windows = new ObservationWindows(options.now, 60_000);
  let stopped = false;
  let socket: WebSocket;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  // Reply jobs are exclusive per session, so one participant never waits for
  // another; maxInflight bounds the total number of concurrent model calls.
  const jobs = new Map<string, object>();
  let inflight = 0;
  // Sends are serialized per group so multi-part replies never interleave.
  const sendQueues = new Map<string, Promise<void>>();
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; finish: (success: boolean) => void }>();
  const lookups = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (data: unknown) => void }>();

  const acquire = (key: string): object | undefined => {
    if (jobs.has(key) || inflight >= maxInflight) return undefined;
    const job = {};
    jobs.set(key, job);
    inflight++;
    return job;
  };
  const release = (key: string, job: object): void => {
    if (jobs.get(key) !== job) return;
    jobs.delete(key);
    inflight--;
  };

  const enqueueSend = <T,>(group: string, task: () => Promise<T>): Promise<T> => {
    const previous = sendQueues.get(group) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(() => undefined, () => undefined);
    sendQueues.set(group, tail);
    void tail.then(() => { if (sendQueues.get(group) === tail) sendQueues.delete(group); });
    return next;
  };

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
    const sendPart = (groupId: string, content: string, finish: (success: boolean) => void): void => {
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
    const sendReply = (groupId: string, content: string,
      finish: (success: boolean, delivered?: string) => void, guard: () => boolean = () => true): void => {
      void enqueueSend(groupId, () => deliverPersonaReply(content,
        part => new Promise<boolean>(resolve => sendPart(groupId, part, resolve)),
        () => !stopped && activeSocket === socket && activeSocket.readyState === WebSocket.OPEN && guard()))
        .then(delivered => finish(!!delivered, delivered))
        .catch(() => finish(false));
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
      const key = sessionKey(message.groupId, message.senderId);
      windows.incoming(message.groupId, message.senderId);

      if (!message.isMentioned && !message.replyMessageId && !message.isCalledByName) {
        const valid = windows.candidate(message.groupId, message.senderId);
        const text = message.content.trim();
        if (judgeFollowUp && !valid) log(`[跳过] ${windows.skipReason(message.groupId, message.senderId)}。`);
        if (judgeFollowUp && valid && (message.hasAnyMention || !text || text.length > 4000)) log('[跳过] 消息含其他@、无文本或文本超限。');
        if (judgeFollowUp && valid && !message.hasAnyMention && text && text.length <= 4000) {
          if (jobs.has(key)) { log('[跳过] 忙碌（该会话正在生成回复或等待发送确认），本次不处理。'); return; }
          if (inflight >= maxInflight) { log('[跳过] 忙碌（并发已满），本次不处理。'); return; }
          const history = memory.get(message.groupId, message.senderId);
          if (!history.length) return;
          const autoJob = acquire(key);
          if (!autoJob) { log('[跳过] 忙碌（并发已满），本次不处理。'); return; }
          const canSend = (): boolean => !stopped && activeSocket === socket && activeSocket.readyState === WebSocket.OPEN && valid();
          let awaitingAck = false;
          try {
            const decision = await judgeFollowUp(text, history);
            if (!canSend()) { log('[接续] 窗口已结束，丢弃迟到的判断；不接话。'); return; }
            const intentLabel = { continue: '继续', pause: '暂停', end: '结束', uncertain: '不确定' }[decision.intent];
            log(`[${options.autoReply ? '自动接话' : '观察'}] intent=${intentLabel}; wouldRespond=${decision.shouldRespond}; reason=${decision.reason}; 历史${history.length / 2}轮。`);
            if (decision.intent === 'end') { windows.close(message.groupId, message.senderId, 'ended'); log('[跳过] 用户明确结束对话，关闭窗口。'); }
            if (!options.autoReply || !decision.shouldRespond || !generateReply) return;
            const answer = await generateReply(text, history);
            if (!canSend()) { log('[自动接话] 发送前窗口失效，取消回复。'); return; }
            awaitingAck = true;
            sendReply(message.groupId, answer, (success, delivered) => {
              if (success) {
                memory.add(message.groupId, message.senderId, text, delivered ?? answer);
                valid.consume();
                log('[自动接话] 成功回复已写入记忆，计入本窗口2次限额。');
              }
              release(key, autoJob);
            }, canSend);
          } catch { log('[接续] 判断或生成失败、超时，默认不接话。'); }
          finally { if (!awaitingAck) release(key, autoJob); }
        }
        return;
      }
      windows.close(message.groupId, message.senderId);
      if (jobs.has(key)) { log('[跳过] 忙碌，明确呼叫暂未处理；旧窗口已关闭。'); return; }
      const job = acquire(key);
      if (!job) { log('[跳过] 忙碌（并发已满），明确呼叫暂未处理；旧窗口已关闭。'); return; }
      const releaseJob = (): void => release(key, job);
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
      if (message.isCalledByName) log('[触发] 句首称呼命中（角色称呼）。');
      const reply = handleGroupMessage(message);
      if (reply === null || stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) { releaseJob(); return; }
      let commit: (() => void) | undefined;
      if (generateReply) {
        const content = message.content.trim();
        if (content === '/清空记忆') {
          memory.clear(message.groupId, message.senderId);
          windows.close(message.groupId, message.senderId);
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
      if (stopped || activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) { releaseJob(); return; }
      const finish = (success: boolean, delivered?: string): void => {
        if (delivered) reply.content = delivered;
        if (success && commit) {
          commit();
          if (judgeFollowUp) { windows.open(windows.incoming(message.groupId, message.senderId)); log('[接续] 明确呼叫回复成功，开启60秒窗口，最多自动接话2次。'); }
        }
        releaseJob();
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
