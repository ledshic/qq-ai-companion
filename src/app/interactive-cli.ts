import { createInterface, clearLine, cursorTo, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { createServiceClient } from '../../packages/client/src/service.js';
import { APIError, type Conversation, type Run } from '@companion/contracts/service';

type Client = ReturnType<typeof createServiceClient>;
interface Attempt { conversationId: string; content: string; clientMessageId: string }
interface ObservedRun { id: string; conversation: Conversation; controller: AbortController; preview: string }
const instructions = `普通输入发送消息；每次等待一个任务。// 开头可发送以 / 开头的正文。
/help                 查看帮助
/list                 列出会话
/new [标题]           创建并切换到新会话
/use <会话标识>       切换会话并读取最近消息
/history              查看当前会话最近 20 条消息（不含推理）
/retry                用原标识重试结果未确认的提交
/resume <任务标识>    继续观察已有任务或查看其结果
/cancel               显式取消当前任务
/exit                 退出本地聊天，已接受任务继续运行
Ctrl+C / Ctrl+D 退出本地聊天，不取消远程任务。`;
const terminalText = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const failureCode = (error: unknown) => error instanceof APIError ? error.code : 'request_failed';
const terminal = (run: Run) => !['queued', 'running'].includes(run.state);

export async function runInteractiveChat(options: {
  client: Client; input: Readable; output: Writable; signal: AbortSignal;
  out: (text: string) => void; error: (text: string) => void; conversationId?: string;
}): Promise<number> {
  const { client, signal } = options;
  let current: Conversation | undefined;
  let active: ObservedRun | undefined;
  let uncertain: Attempt | undefined;
  let submitting: Attempt | undefined;
  let closed = false;
  let reader: Interface | undefined;
  let commands = Promise.resolve();
  const tty = !!(options.input as Readable & { isTTY?: boolean }).isTTY && !!(options.output as Writable & { isTTY?: boolean }).isTTY;
  function print(text: string, error = false) {
    if (closed) return;
    if (reader && tty) { clearLine(options.output, 0); cursorTo(options.output, 0); }
    (error ? options.error : options.out)(terminalText(text));
    if (reader && tty) reader.prompt(true);
  }
  function requireIdle() {
    if (active) { print(`任务 ${active.id} 尚未结束，请等待、/resume ${active.id} 或 /cancel。`, true); return false; }
    if (uncertain) { print(`提交 ${uncertain.clientMessageId} 的结果尚未确认，请 /retry 或 /exit；不会自动重发。`, true); return false; }
    return true;
  }
  async function conversations() {
    const result: Conversation[] = [];
    let after = '';
    for (;;) {
      signal.throwIfAborted();
      if (closed) return result;
      const page = await client.conversations(after);
      result.push(...page.conversations);
      if (!page.conversations.length) return result;
      if (!page.nextCursor || page.nextCursor <= after) throw Error('invalid_cursor');
      after = page.nextCursor;
    }
  }
  async function ownedConversation(id: string) {
    const found = (await conversations()).find(item => item.id === id);
    if (!found) throw new APIError(404, 'not_found');
    return found;
  }
  async function history(conversation: Conversation) {
    let after = 0;
    let recent: Awaited<ReturnType<Client['messages']>>['messages'] = [];
    for (;;) {
      signal.throwIfAborted();
      if (closed) return;
      const page = await client.messages(conversation.id, after);
      recent = [...recent, ...page.messages].slice(-20);
      if (!page.messages.length) break;
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after) throw Error('invalid_cursor');
      after = page.nextCursor;
    }
    print(`历史：${conversation.title}（${conversation.id}）`);
    for (const message of recent) print(`${message.role === 'assistant' ? '助手' : '你'}：${message.content}`);
    if (!recent.length) print('暂无消息。');
  }
  function finish(task: ObservedRun, run: Run) {
    if (closed || active !== task) return;
    active = undefined; task.controller.abort();
    if (task.preview && run.state !== 'completed') print('\n草稿已清除，未作为回答保存。');
    task.preview = '';
    if (run.state === 'completed' && run.result?.trim()) print(`助手（${task.conversation.title}）：\n${run.result}`);
    else print(`任务 ${run.id}：${run.state}${run.error ? `（${run.error}）` : ''}`, run.state === 'failed' || run.state === 'interrupted');
  }
  function observe(id: string, conversation: Conversation, known?: Run) {
    active?.controller.abort();
    const task: ObservedRun = { id, conversation, controller: new AbortController(), preview: '' };
    active = task;
    if (known && terminal(known)) { finish(task, known); return; }
    print(`正在观察任务 ${id}；/cancel 取消，/exit 仅退出观察。`);
    void (async () => {
      try {
        const streamSignal = AbortSignal.any([signal, task.controller.signal]);
        for await (const snapshot of client.watchRun(task.id, streamSignal)) {
          if (closed || active !== task || streamSignal.aborted) return;
          const latest = snapshot.run;
          if (latest.id !== task.id || latest.conversationId !== task.conversation.id) throw Error('run_scope_changed');
          const safe = terminalText(snapshot.text);
          if (safe !== task.preview) {
            const change = safe.startsWith(task.preview) ? safe.slice(task.preview.length) : '\n[草稿已替换或清除]\n' + safe;
            if (reader && tty) {
              // Keep readline's input and prompt intact without erasing prior tokens.
              if (!task.preview) print('草稿（未提交）：');
              print(change);
            } else {
              if (!task.preview) options.output.write('草稿（未提交）：\n');
              options.output.write(change);
            }
            task.preview = safe;
          }
          if (terminal(latest)) { if (task.preview) options.output.write('\n'); finish(task, latest); return; }
        }
      } catch (error) {
        if (closed || active !== task || task.controller.signal.aborted || signal.aborted) return;
        task.preview = ''; task.controller.abort();
        options.output.write('\n[输出连接中断，草稿不作为已提交回答]\n');
        print(`观察失败：${failureCode(error)}。任务可能仍在运行，可 /resume ${task.id} 或 /cancel。`, true);
      }
    })();
  }
  async function submit(attempt: Attempt) {
    if (!current || current.id !== attempt.conversationId) throw Error('conversation_changed');
    submitting = attempt;
    print(`提交标识：${attempt.clientMessageId}；会话：${attempt.conversationId}`);
    let accepted: Awaited<ReturnType<Client['submit']>>;
    try {
      accepted = await client.submit(attempt.conversationId, attempt.clientMessageId, attempt.content);
    } catch (error) {
      if (!(error instanceof APIError) || error.status >= 500) {
        uncertain = attempt;
        print(`提交结果未确认：${failureCode(error)}。请 /retry，原标识不变。`, true);
      } else { uncertain = undefined; print(`提交失败：${failureCode(error)}`, true); }
      return;
    } finally { submitting = undefined; }
    uncertain = undefined;
    if (closed) return;
    print(`已接受任务：${accepted.runId}`);
    // Acceptance provides an id, not a guessed run state. Query the service.
    observe(accepted.runId, current);
  }
  async function handle(line: string) {
    const lineText = line.trim();
    const literal = lineText.startsWith('//');
    const text = literal ? lineText.slice(1) : lineText;
    if (!text || closed || signal.aborted) return;
    if (!text.startsWith('/') || literal) {
      if (!requireIdle()) return;
      if (text.length > 8000) { print('消息最多 8000 字符。', true); return; }
      if (!current) {
        const created = await client.createConversation(text.slice(0, 40));
        if (closed) return;
        current = created; print(`当前会话：${created.title}（${created.id}）`);
      }
      await submit({ conversationId: current.id, content: text, clientMessageId: randomUUID() });
      return;
    }
    const [command, ...parts] = text.split(/\s+/);
    const arg = parts.join(' ');
    switch (command) {
      case '/help': if (parts.length) break; print(instructions); return;
      case '/exit': if (parts.length) break; close(); return;
      case '/list':
        if (parts.length) break;
        for (const item of await conversations()) print(`${item.id}  ${item.title}`);
        return;
      case '/new': {
        if (!requireIdle()) return;
        const created = await client.createConversation(arg || 'CLI 对话');
        if (!closed) { current = created; print(`当前会话：${created.title}（${created.id}）`); }
        return;
      }
      case '/use': {
        if (parts.length !== 1) break;
        if (!requireIdle()) return;
        const selected = await ownedConversation(arg);
        if (!closed) { current = selected; print(`当前会话：${selected.title}（${selected.id}）`); await history(selected); }
        return;
      }
      case '/history':
        if (parts.length) break;
        if (current) await history(current); else print('尚未选择会话，请 /use 或发送首条消息。');
        return;
      case '/retry':
        if (parts.length) break;
        if (uncertain && !active) await submit(uncertain); else print('没有待确认的提交。');
        return;
      case '/resume': {
        if (parts.length !== 1) break;
        if (uncertain) { requireIdle(); return; }
        if (active && active.id !== arg) { requireIdle(); return; }
        if (active && !active.controller.signal.aborted) { print(`任务 ${arg} 正在观察，无需重复恢复。`); return; }
        const run = await client.run(arg);
        if (run.id !== arg) throw Error('run_scope_changed');
        const selected = await ownedConversation(run.conversationId);
        if (!closed) { current = selected; print(`当前会话：${selected.title}（${selected.id}）`); observe(run.id, selected, run); }
        return;
      }
      case '/cancel': {
        if (parts.length) break;
        const task = active;
        if (!task) { print(uncertain ? '尚未取得任务标识，请 /retry 确认提交结果。' : '没有当前任务。'); return; }
        const result = await client.cancel(task.id);
        if (result.id !== task.id || result.conversationId !== task.conversation.id) throw Error('run_scope_changed');
        if (terminal(result)) finish(task, result);
        else print(`任务 ${task.id} 仍为 ${result.state}，取消尚未确认。`, true);
        return;
      }
    }
    print('命令或参数无效，请 /help。', true);
  }
  let resolveClosed!: (code: number) => void;
  const ended = new Promise<number>(resolve => { resolveClosed = resolve; });
  function close(code = 0) {
    if (closed) return;
    if (active) print(`退出本地观察；远程任务未取消：${active.id}`);
    const pending = uncertain ?? submitting;
    if (pending) print(`保留重试标识：${pending.clientMessageId}；会话：${pending.conversationId}。重新连接后可用 send 的相同标识和正文确认结果。`);
    closed = true; active?.controller.abort(); reader?.close(); resolveClosed(code);
  }
  const stop = () => close();
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    await client.me(); // Uses the existing bearer credential; never creates an identity.
    if (options.conversationId) { current = await ownedConversation(options.conversationId); await history(current); }
    if (closed || signal.aborted) return 0;
    print(current ? '已连接个人 Agent，当前会话已选定。/help 查看命令。' : '已连接个人 Agent。/help 查看命令；首次发送会创建会话。');
    reader = createInterface({ input: options.input, output: options.output, terminal: tty, historySize: 0 });
    reader.setPrompt('你> ');
    reader.on('line', line => {
      commands = commands.then(() => handle(line)).catch(error => { if (!closed && !signal.aborted) print(`操作失败：${failureCode(error)}`, true); });
    });
    reader.on('SIGINT', stop);
    reader.on('error', () => { print('输入流读取失败。', true); close(1); });
    // Drain buffered commands on EOF, then leave accepted remote work running.
    reader.on('close', () => { void commands.finally(() => close()); });
    if (tty) reader.prompt();
    return await ended;
  } finally { signal.removeEventListener('abort', stop); active?.controller.abort(); reader?.close(); }
}
