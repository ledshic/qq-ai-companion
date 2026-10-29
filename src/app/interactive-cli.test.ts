import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { testRunStream } from '../testing/run-stream.js';
import { runCLI } from './cli.js';
import { ServiceStore } from '../runtime/service/store.js';
import { RunHost, type ConsoleGenerator } from '../runtime/service/host.js';
import { createServiceAPI } from './server/api.js';
const settle = async (ready: () => boolean) => {
  for (let i = 0; i < 600; i++) { if (ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('interactive fixture did not settle');
};
function fixture(generate: ConsoleGenerator = async text => 'answer:' + text) {
  const root = mkdtempSync(join(tmpdir(), 'interactive-agent-'));
  const credential = join(root, 'credential.json'); writeFileSync(credential, JSON.stringify({ token: 'interactive-token' }), { mode: 0o600 });
  const store = new ServiceStore(':memory:'); store.ensureOwner('text-owner', 'device', 'interactive-token');
  const host = new RunHost(store, generate);
  const api = createServiceAPI({ store, host, origins: [], status: () => ({ model: 'configured', qq: 'disabled' }) });
  const calls: { path: string; method: string; body?: any }[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    calls.push({ path, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const streaming = path.match(/^\/api\/v1\/runs\/([^/]+)\/output$/);
    if (streaming) return testRunStream(host, 'text-owner', streaming[1]!, init?.signal ?? undefined);
    const response = await api.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: path,
      headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
    return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': String(response.headers['content-type']) } });
  };
  const sessions: { stop: () => void; result: Promise<number> }[] = [];
  const connect = (args: string[] = [], network = request, tty = false) => {
    const input = new PassThrough(), output = new PassThrough();
    Object.assign(input, { isTTY: tty }); Object.assign(output, { isTTY: tty });
    const controller = new AbortController(), lines: string[] = [], errors: string[] = [];
    const result = runCLI(['chat', ...args], { env: { AGENT_CREDENTIAL_FILE: credential }, input, terminalOutput: output,
      signal: controller.signal, request: network, out: line => lines.push(line), error: line => errors.push(line) });
    sessions.push({ stop: () => controller.abort(), result });
    return { input, output, controller, lines, errors, result, line: (text: string) => input.write(text + (tty ? '\r' : '\n')), text: () => lines.join('\n'), error: () => errors.join('\n') };
  };
  return { store, host, api, request, calls, connect, credential, async close() {
    for (const session of sessions) session.stop();
    await Promise.all(sessions.map(session => session.result));
    host.stop(); await api.close(); store.close(); rmSync(root, { recursive: true, force: true });
  } };
}
test('interactive turns share the service conversation and committed history, never local model execution', async () => {
  const histories: unknown[] = [];
  const f = fixture(async (text, history, _signal, reasoning) => { histories.push(history); reasoning?.('hidden reasoning'); return '\x1b[31manswer:' + text + '\x1b[0m'; });
  try {
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('first'); await settle(() => s.text().includes('answer:first'));
    const c = f.store.conversations('text-owner', '', 50)[0]!;
    s.line('second'); await settle(() => s.text().includes('answer:second'));
    assert.deepEqual(histories, [[], [{ role: 'user', content: 'first' }, { role: 'assistant', content: '\x1b[31manswer:first\x1b[0m' }]]);
    assert.equal(f.store.messages('text-owner', c.id, 0, 50).messages.length, 4);
    s.line('/history'); await settle(() => s.text().includes('历史：'));
    s.line('/exit'); assert.equal(await s.result, 0);
    assert(!s.text().includes('hidden reasoning')); assert(!s.text().includes('\x1b'));
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 2);
    assert(!f.calls.some(call => call.path.includes('chat/completions')));
  } finally { await f.close(); }
});
test('conversation selection checks ownership and cannot mix histories; invalid commands do not submit', async () => {
  const seen: unknown[] = []; const f = fixture(async (_text, history) => { seen.push(history); return 'done'; });
  try {
    const a = f.store.createConversation('text-owner', 'A'), b = f.store.createConversation('text-owner', 'B'), foreign = f.store.createConversation('other', 'Hidden');
    const s = f.connect([a.id]); await settle(() => s.text().includes('已连接'));
    s.line('question A'); await settle(() => s.text().includes('助手（A）'));
    s.line('/use ' + foreign.id); await settle(() => s.error().includes('not_found'));
    s.line('/use ' + b.id); await settle(() => s.text().includes('历史：B'));
    s.line('/unknown'); s.line('question B'); await settle(() => s.text().includes('助手（B）'));
    s.line('/new New title'); await settle(() => s.text().includes('当前会话：New title'));
    s.line('//literal'); await settle(() => f.calls.some(call => call.body?.content === '/literal'));
    s.line('/exit'); assert.equal(await s.result, 0); assert.deepEqual(seen.slice(0, 2), [[], []]);
    assert(!s.text().includes('Hidden'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/messages') && call.method === 'POST').length, 3);
  } finally { await f.close(); }
});
test('busy input cannot supersede a task; cancel reuses remote cancellation and rejects late output', async () => {
  let finish!: (text: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('pending'); await settle(() => !!finish && s.text().includes('已接受任务'));
    s.line('must not supersede'); s.line('/new forbidden while busy'); s.line('/cancel');
    await settle(() => s.text().includes('cancelled')); finish('late result');
    await new Promise(resolve => setTimeout(resolve, 550));
    s.line('/exit'); assert.equal(await s.result, 0); assert(!s.text().includes('late result'));
    assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
    assert.equal(f.store.conversations('text-owner', '', 50).length, 1);
  } finally { await f.close(); }
});
test('uncertain submission only retries explicitly with the same message id', async () => {
  let generated = 0, lost = false; const f = fixture(async () => { generated++; return 'one answer'; });
  const network: typeof fetch = async (url, init) => {
    const result = await f.request(url, init);
    if (init?.method === 'POST' && String(url).endsWith('/messages') && !lost) { lost = true; throw Error('interactive-token'); }
    return result;
  };
  try {
    const s = f.connect([], network); await settle(() => s.text().includes('已连接'));
    s.line('question'); await settle(() => s.error().includes('提交结果未确认'));
    s.line('do not send twice'); s.line('/retry'); await settle(() => s.text().includes('one answer'));
    s.line('/exit'); assert.equal(await s.result, 0);
    const posts = f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages'));
    assert.equal(posts.length, 2); assert.deepEqual(posts[0]?.body, posts[1]?.body); assert.equal(generated, 1);
    assert(!s.error().includes('interactive-token'));
  } finally { await f.close(); }
});
for (const exit of ['exit', 'eof', 'tty-interrupt'] as const) test(`${exit} closes observation without remote cancellation`, async () => {
  let finish!: (text: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const s = f.connect([], f.request, exit === 'tty-interrupt'); await settle(() => s.text().includes('已连接'));
    s.line('pending'); await settle(() => !!finish && s.text().includes('已接受任务'));
    const c = f.store.conversations('text-owner', '', 50)[0]!;
    const accepted = f.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST')!;
    const run = f.store.accept('text-owner', c.id, accepted.body.clientMessageId, accepted.body.content);
    if (exit === 'exit') s.line('/exit'); else if (exit === 'eof') s.input.end(); else s.input.write('\x03');
    assert.equal(await s.result, 0); assert.equal(f.store.run('text-owner', run.runId).state, 'running');
    assert(s.text().includes(run.runId)); assert(!f.calls.some(call => call.path.endsWith('/cancel')));
    finish('after exit'); await settle(() => f.store.run('text-owner', run.runId).state === 'completed');
    assert(!s.text().includes('after exit'));
  } finally { await f.close(); }
});
test('service failures are displayed as failures; an existing task can be resumed', async () => {
  const f = fixture(async () => { throw Error('private-provider-error'); });
  try {
    const c = f.store.createConversation('text-owner', 'Existing');
    const accepted = f.host.submit('text-owner', c.id, 'earlier', 'earlier question');
    await settle(() => f.store.run('text-owner', accepted.runId).state === 'failed');
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('/resume ' + accepted.runId); await settle(() => s.error().includes('failed（generation_failed）'));
    s.line('/exit'); assert.equal(await s.result, 0); assert(!s.text().includes('助手（')); assert(!s.error().includes('private-provider-error'));
  } finally { await f.close(); }
});
test('real CLI process leaves an accepted remote run alive on SIGINT', { timeout: 8000 }, async () => {
  let finish!: (text: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.api.listen({ host: '127.0.0.1', port: 0 }); const address = f.api.server.address(); assert(address && typeof address !== 'string');
    child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./cli.ts', import.meta.url)), 'chat'], {
      env: { ...process.env, AGENT_CREDENTIAL_FILE: f.credential, AGENT_URL: `http://127.0.0.1:${address.port}` }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit'); let output = '', errors = '';
    child.stdout!.on('data', chunk => { output += String(chunk); }); child.stderr!.on('data', chunk => { errors += String(chunk); });
    await settle(() => output.includes('已连接')); child.stdin!.write('pending\n');
    await settle(() => !!finish && output.includes('已接受任务'));
    const id = output.match(/已接受任务：([^\s]+)/)![1]!; child.kill('SIGINT'); assert.equal((await exited)[0], 0, errors);
    assert.equal(f.store.run('text-owner', id).state, 'running'); assert(!output.includes('interactive-token'));
    finish('after exit'); await settle(() => f.store.run('text-owner', id).state === 'completed');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await f.close();
  }
});
test('observation failures retain the run id and explicit resume does not resubmit', async () => {
  let finish!: (text: string) => void, disconnected = true;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const network: typeof fetch = (url, init) => {
    if (disconnected && String(url).includes('/runs/')) return Promise.reject(Error('disconnected'));
    return f.request(url, init);
  };
  try {
    const s = f.connect([], network); await settle(() => s.text().includes('已连接'));
    s.line('pending'); await settle(() => s.error().includes('观察失败'));
    const id = s.text().match(/已接受任务：([^\s]+)/)![1]!;
    s.line('must not resubmit'); await settle(() => s.error().includes('尚未结束'));
    disconnected = false; finish('recovered');
    await settle(() => f.store.run('text-owner', id).state === 'completed');
    s.line('/resume ' + id); await settle(() => s.text().includes('recovered'));
    s.line('/exit'); assert.equal(await s.result, 0);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
    assert(!f.calls.some(call => call.path.endsWith('/cancel')));
  } finally { await f.close(); }
});
test('EOF drains buffered commands before closing without cancelling accepted work', async () => {
  let finish!: (text: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const s = f.connect(); s.input.end('buffered question\n');
    assert.equal(await s.result, 0);
    assert(s.text().includes('已接受任务'));
    const id = s.text().match(/已接受任务：([^\s]+)/)![1]!;
    assert.equal(f.store.run('text-owner', id).state, 'running');
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
    finish('later'); await settle(() => f.store.run('text-owner', id).state === 'completed');
  } finally { await f.close(); }
});
test('interrupt during an uncertain in-flight submission keeps retry metadata and suppresses late UI output', async () => {
  let release!: (response: Response) => void, finish!: (text: string) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  let response: Response | undefined;
  const network: typeof fetch = async (url, init) => {
    const result = await f.request(url, init);
    if (init?.method === 'POST' && String(url).endsWith('/messages')) {
      response = result; return new Promise(resolve => { release = resolve; });
    }
    return result;
  };
  try {
    const s = f.connect([], network); await settle(() => s.text().includes('已连接'));
    s.line('pending'); await settle(() => !!release && !!finish);
    s.controller.abort(); assert.equal(await s.result, 0);
    assert(s.text().includes('保留重试标识'));
    const before = s.text(); release(response!); await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.text(), before);
    assert(!f.calls.some(call => call.path.endsWith('/cancel')));
    finish('after exit');
  } finally { await f.close(); }
});
test('authentication and foreign initial conversation failures do not start an input session or submit', async () => {
  const f = fixture();
  try {
    const refused = f.connect([], async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }), true);
    const raw: boolean[] = []; Object.assign(refused.input, { setRawMode: (value: boolean) => raw.push(value) });
    assert.equal(await refused.result, 1); assert(refused.error().includes('unauthorized')); assert(!refused.text().includes('已连接'));
    assert.deepEqual(raw, []); assert.equal(refused.input.listenerCount('data'), 0);
    const foreign = f.store.createConversation('other', 'private title');
    const hidden = f.connect([foreign.id]); assert.equal(await hidden.result, 1); assert(hidden.error().includes('not_found'));
    assert(!hidden.text().includes('private title'));
    assert(!f.calls.some(call => call.method === 'POST'));
  } finally { await f.close(); }
});
test('resuming an already observed task cannot create a second result observer', async () => {
  let finish!: (text: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('pending'); await settle(() => !!finish && s.text().includes('已接受任务'));
    const id = s.text().match(/已接受任务：([^\s]+)/)![1]!;
    s.line('/resume ' + id); await settle(() => s.text().includes('无需重复恢复'));
    finish('one completion'); await settle(() => s.text().includes('one completion'));
    s.line('/exit'); assert.equal(await s.result, 0);
    assert.equal(s.text().split('one completion').length - 1, 1);
  } finally { await f.close(); }
});
test('CLI receives genuine drafts before final completion without duplicating tokens', async () => {
  let emit!: (text: string) => void, finish!: (text: string) => void;
  const f = fixture((_text, _history, _signal, _reasoning, context) => { emit = context!.onOutput!; return new Promise(resolve => { finish = resolve; }); });
  try {
    const s = f.connect(); let output = ''; s.output.on('data', chunk => { output += String(chunk); });
    await settle(() => s.text().includes('已连接')); s.line('streaming'); await settle(() => !!emit);
    emit('first token'); await settle(() => output.includes('first token'));
    assert(!s.text().includes('助手（')); emit('first token second token'); await settle(() => output.includes('second token'));
    finish('complete final answer'); await settle(() => s.text().includes('complete final answer'));
    assert.equal(output.split('first token').length - 1, 1);
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
for (const tty of [false, true]) test(`stream cancellation discards drafts and preserves terminal input with tty=${tty}`, async () => {
  let emit!: (text: string) => void, finish!: (text: string) => void;
  const f = fixture((_text, _history, _signal, _reasoning, context) => { emit = context!.onOutput!; return new Promise(resolve => { finish = resolve; }); });
  try {
    const s = f.connect([], f.request, tty); let output = ''; s.output.on('data', chunk => { output += String(chunk); });
    await settle(() => s.text().includes('已连接')); s.line('cancel stream'); await settle(() => !!emit);
    emit('first segment'); await settle(() => (s.text() + output).includes('first segment'));
    emit('first segment second segment'); await settle(() => (s.text() + output).includes('second segment'));
    if (!tty) assert.equal((s.text() + output).split('first segment').length - 1, 1);
    assert(!s.text().includes('助手（'));
    s.line('/cancel'); await settle(() => s.text().includes('cancelled'));
    emit('late segment'); finish('late complete'); await new Promise(resolve => setImmediate(resolve));
    assert(!(s.text() + output).includes('late segment')); assert(!s.text().includes('late complete'));
    assert.equal(f.store.all("SELECT * FROM service_messages WHERE role = 'assistant'").length, 0);
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('pipe multiline mode preserves indentation and command-looking body, sends only on explicit confirmation', async () => {
  let received = ''; const f = fixture(async text => { received = text; return 'confirmed'; });
  try {
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    for (const line of ['/edit', '  first', '/cancel', '//send', '// comment', '', 'last']) s.line(line);
    await settle(() => s.text().includes('多行输入：')); assert(!f.calls.some(call => call.path.endsWith('/messages')));
    s.line('/send'); await settle(() => s.text().includes('confirmed'));
    assert.equal(received, '  first\n/cancel\n/send\n// comment\n\nlast'); assert(!f.calls.some(call => call.path.endsWith('/cancel')));
    s.line('/edit'); s.line('discard this'); s.line('/discard'); await settle(() => s.text().includes('多行输入已丢弃'));
    s.line('/edit'); s.line('unfinished'); s.input.end(); assert.equal(await s.result, 0);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
  } finally { await f.close(); }
});
test('oversized pipe edit cannot submit a silently truncated message', async () => {
  const f = fixture();
  try {
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    for (const line of ['/edit', 'x'.repeat(8001), '/send']) s.line(line);
    await settle(() => s.error().includes('超限')); assert(!f.calls.some(call => call.path.endsWith('/messages')));
    s.line('/discard'); s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('terminal keeps the next multiline edit through streamed replacements, busy send, cancel and recovery', async () => {
  let emit!: (text: string) => void, finish!: (text: string) => void; const inputs: string[] = [];
  const f = fixture((text, _history, _signal, _reasoning, context) => {
    inputs.push(text); emit = context!.onOutput!; return new Promise(resolve => { finish = resolve; });
  });
  try {
    const s = f.connect([], f.request, true); await settle(() => s.text().includes('已连接'));
    s.input.write('\x1b[200~first\n  body\x1b[201~'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(inputs.length, 0); s.input.write('\r'); await settle(() => !!emit && s.text().includes('已接受任务'));
    s.input.write('next\n  line'); emit('draft one'); await new Promise(resolve => setTimeout(resolve, 20));
    s.input.write('\r'); await settle(() => s.error().includes('尚未结束')); assert.equal(inputs.length, 1);
    emit('replacement'); s.input.write('\x18'); await settle(() => s.text().includes('cancelled'));
    finish('late'); emit('late draft'); s.input.write('\r'); await settle(() => inputs.length === 2);
    assert.deepEqual(inputs, ['first\n  body', 'next\n  line']);
    const id = s.text().match(/已接受任务：([^\s]+)/g)!.at(-1)!.split('：')[1]!;
    s.line('/resume ' + id); await settle(() => s.text().includes('无需重复恢复'));
    finish('second complete'); await settle(() => s.text().includes('second complete')); s.line('/exit'); assert.equal(await s.result, 0);
    assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
    assert.deepEqual(f.store.history('text-owner', f.store.conversations('text-owner', '', 50)[0]!.id).map(message => message.content), ['next\n  line', 'second complete']);
  } finally { await f.close(); }
});
test('task entry discovers unknown IDs, resumes numbered tasks, cancels and reads terminal results without resubmission', async () => {
  let finish!: (text: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const c = f.store.createConversation('text-owner', 'From another device');
    const accepted = f.host.submit('text-owner', c.id, 'earlier', 'do not resubmit'); await settle(() => !!finish);
    const foreign = f.store.createConversation('other', 'foreign secret'); f.store.accept('other', foreign.id, 'hidden', 'foreign input');
    const s = f.connect(); await settle(() => s.text().includes('已连接')); s.line('/resume'); await settle(() => s.text().includes('#1  运行中'));
    assert(!s.text().includes('foreign secret')); assert(!s.text().includes('do not resubmit'));
    s.line('/resume #1'); await settle(() => s.text().includes('正在观察任务 ' + accepted.runId));
    s.line('/resume #1'); await settle(() => s.text().includes('无需重复恢复'));
    s.line('/cancel'); await settle(() => s.text().includes('cancelled')); finish('late completion');
    s.line('/tasks all'); await settle(() => s.text().includes('#1  已取消')); s.line('/resume #1'); await settle(() => s.text().split('cancelled').length >= 3);
    s.line('/exit'); assert.equal(await s.result, 0);
    assert.equal(f.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 0);
    assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  } finally { await f.close(); }
});
test('task pages keep numbers stable, recheck current state and invalidate choices after a failed refresh', async () => {
  const f = fixture(); let offline = false;
  const network: typeof fetch = (url, init) => offline && new URL(String(url)).pathname === '/api/v1/runs' ? Promise.reject(Error('offline')) : f.request(url, init);
  try {
    const c = f.store.createConversation('text-owner', 'History'); const ids: string[] = [];
    for (let i = 0; i < 23; i++) { const run = f.store.accept('text-owner', c.id, 'history-' + i, 'private-body'); f.store.start('text-owner', run.runId); f.store.finish('text-owner', run.runId, 'final-' + i, null); ids.push(run.runId); }
    const s = f.connect([], network); await settle(() => s.text().includes('已连接'));
    s.line('/tasks all'); await settle(() => s.text().includes('#20 ')); s.line('/tasks more'); await settle(() => s.text().includes('#23 '));
    s.line('/resume #21'); await settle(() => s.text().includes('final-2'));
    const read = f.calls.find(call => call.path === '/api/v1/runs/' + ids[2]); assert(read);
    offline = true; s.line('/tasks'); await settle(() => s.error().includes('操作失败')); s.line('/resume #1'); await settle(() => s.error().includes('序号不可用'));
    offline = false; s.line('/tasks'); await settle(() => s.text().includes('没有更多符合条件')); s.line('/exit'); assert.equal(await s.result, 0);
    assert(!f.calls.some(call => call.method === 'POST')); // Browsing/results never create work.
  } finally { await f.close(); }
});
test('numbered recovery revalidates the latest terminal state rather than executing stale list state', async () => {
  let finish!: (text: string) => void, generated = 0; const f = fixture(() => { generated++; return new Promise(resolve => { finish = resolve; }); });
  try {
    const c = f.store.createConversation('text-owner', 'Changed after listing'), accepted = f.host.submit('text-owner', c.id, 'earlier', 'question');
    await settle(() => !!finish); const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('/tasks running'); await settle(() => s.text().includes('#1  运行中')); finish('finished after listing'); await settle(() => f.store.run('text-owner', accepted.runId).state === 'completed');
    s.line('/resume #1'); await settle(() => s.text().includes('finished after listing'));
    assert.equal(generated, 1); assert(!f.calls.some(call => call.path.endsWith('/output') || call.method === 'POST'));
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('task selection cannot replace another observed run, and browsing never cancels it', async () => {
  const finish: ((text: string) => void)[] = []; const f = fixture(() => new Promise(resolve => { finish.push(resolve); }));
  try {
    const a = f.store.createConversation('text-owner', 'A'), b = f.store.createConversation('text-owner', 'B');
    const older = f.host.submit('text-owner', a.id, 'a', 'a'), newer = f.host.submit('text-owner', b.id, 'b', 'b');
    await settle(() => finish.length === 2); const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('/tasks'); await settle(() => s.text().includes('#2  运行中'));
    s.line('/resume #2'); await settle(() => s.text().includes('正在观察任务 ' + older.runId));
    s.line('/resume #1'); await settle(() => s.error().includes('尚未结束'));
    assert(!f.calls.some(call => call.path === '/api/v1/runs/' + newer.runId));
    s.line('/tasks'); await settle(() => s.text().includes('当前观察')); assert(!f.calls.some(call => call.path.endsWith('/cancel')));
    s.line('/cancel'); await settle(() => s.text().includes('cancelled')); s.line('/resume #1'); await settle(() => s.text().includes('正在观察任务 ' + newer.runId));
    s.line('/exit'); assert.equal(await s.result, 0); assert.equal(f.store.run('text-owner', newer.runId).state, 'running');
    for (const resolve of finish) resolve('late');
  } finally { await f.close(); }
});
for (const revoke of ['before', 'during']) test(`numbered recovery checks real source authorization revoked ${revoke} observation`, async () => {
  const { createConsoleReply } = await import('../channels/console/generator.js');
  const { ServiceMemory } = await import('../runtime/service/memory.js');
  let generate!: ConsoleGenerator; const f = fixture((...args) => generate(...args)); let cancelled = false;
  try {
    const source = f.store.createConversation('text-owner', 'Source'), target = f.store.createConversation('text-owner', 'Target');
    const evidence = f.store.accept('text-owner', source.id, 'evidence', '考试安排在周五'); f.store.start('text-owner', evidence.runId); f.store.finish('text-owner', evidence.runId, 'ack', null);
    const memory = new ServiceMemory(f.store); memory.setSources('text-owner', target.id, [source.id]);
    generate = createConsoleReply('fixture', 'test', 9, false, async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '已授权草稿' }, finish_reason: null }] }) + '\n\n'));
    }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }), undefined, { memory });
    const accepted = f.host.submit('text-owner', target.id, 'earlier', '考试安排'); await settle(() => !!f.host.output('text-owner', accepted.runId).text);
    const s = f.connect([], f.request, true); let output = ''; s.output.on('data', chunk => { output += String(chunk); }); await settle(() => s.text().includes('已连接'));
    s.line('/ta\trun\t--conv\t' + target.id); await settle(() => s.text().includes('#1  运行中'));
    if (revoke === 'before') memory.setSources('text-owner', target.id, []);
    s.line('/res\t#1');
    if (revoke === 'during') { await settle(() => output.includes('已授权草稿')); memory.setSources('text-owner', target.id, []); }
    await settle(() => s.error().includes('memory_context_changed'));
    if (revoke === 'before') assert(!output.includes('已授权草稿'));
    assert.equal(f.host.output('text-owner', accepted.runId).text, ''); assert.deepEqual(f.store.history('text-owner', target.id), []);
    await settle(() => cancelled); assert(!f.calls.some(call => call.method === 'POST'));
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('long task browsing continues past the selection cache limit without reassigning expired numbers', async () => {
  const f = fixture();
  try {
    const c = f.store.createConversation('text-owner', 'Long history');
    for (let i = 0; i < 205; i++) { const run = f.store.accept('text-owner', c.id, 'long-' + i, 'question'); f.store.start('text-owner', run.runId); f.store.finish('text-owner', run.runId, 'answer-' + i, null); }
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('/tasks all'); await settle(() => s.text().includes('#20 '));
    for (let page = 2; page <= 11; page++) { s.line('/tasks more'); const last = Math.min(page * 20, 205); await settle(() => s.text().includes('#' + last + ' ')); }
    s.line('/resume #1'); await settle(() => s.error().includes('序号不可用'));
    s.line('/resume #205'); await settle(() => s.text().includes('answer-0')); s.line('/tasks more'); await settle(() => s.text().includes('列表末尾'));
    s.line('/exit'); assert.equal(await s.result, 0); assert(!f.calls.some(call => call.method === 'POST'));
  } finally { await f.close(); }
});
test('conversation task pages retain their scope after switching conversation and reset numbers on a new filter', async () => {
  const f = fixture();
  try {
    const a = f.store.createConversation('text-owner', 'Scope A'), b = f.store.createConversation('text-owner', 'Scope B');
    for (let i = 0; i < 23; i++) { const run = f.store.accept('text-owner', a.id, 'a-' + i, 'question'); f.store.start('text-owner', run.runId); f.store.finish('text-owner', run.runId, 'scope-a-answer-' + i, null); }
    const rb = f.store.accept('text-owner', b.id, 'b', 'question'); f.store.start('text-owner', rb.runId); f.store.finish('text-owner', rb.runId, 'scope-b-answer', null);
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('/tasks --here'); await settle(() => s.error().includes('尚未选择会话')); assert(!f.calls.some(call => call.path.startsWith('/api/v1/runs?')));
    s.line('/tasks all --conversation ' + a.id); await settle(() => s.text().includes('#20 ')); assert(!s.text().includes('Scope B'));
    s.line('/use ' + b.id); await settle(() => s.text().includes('历史：Scope B'));
    s.line('/tasks more'); await settle(() => s.text().includes('#23 '));
    const request = f.calls.filter(call => call.path.startsWith('/api/v1/runs?')).at(-1)!;
    assert.equal(new URL(request.path, 'http://localhost').searchParams.get('conversationId'), a.id);
    s.line('/resume #21'); await settle(() => s.text().includes('scope-a-answer-2'));
    s.line('/tasks all --here'); await settle(() => f.calls.filter(call => call.path.startsWith('/api/v1/runs?')).length === 3);
    s.line('/tasks all --conversation ' + b.id); await settle(() => s.text().includes('会话 ' + b.id));
    s.line('/resume #21'); await settle(() => s.error().includes('序号不可用'));
    s.line('/resume #1'); await settle(() => s.text().split('scope-b-answer').length >= 3);
    s.line('/exit'); assert.equal(await s.result, 0); assert(!f.calls.some(call => call.method === 'POST'));
  } finally { await f.close(); }
});
test('a denied conversation filter clears old numbered choices and invalid options do not send requests', async () => {
  const f = fixture();
  try {
    const own = f.store.createConversation('text-owner', 'Own'), foreign = f.store.createConversation('other', 'Private');
    const run = f.store.accept('text-owner', own.id, 'own', 'question'); f.store.start('text-owner', run.runId); f.store.finish('text-owner', run.runId, 'answer', null);
    const s = f.connect(); await settle(() => s.text().includes('已连接')); s.line('/tasks all'); await settle(() => s.text().includes('#1 '));
    s.line('/tasks all --conversation ' + foreign.id); await settle(() => s.error().includes('not_found'));
    s.line('/resume #1'); await settle(() => s.error().includes('序号不可用'));
    const before = f.calls.length;
    s.line('/tasks more --here'); s.line('/tasks --here --conversation ' + own.id); s.line('/tasks --limit 1');
    await settle(() => s.error().split('命令或参数无效').length >= 4); assert.equal(f.calls.length, before);
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('interactive task listing supports each exact state and viewing a terminal task never reruns it', async () => {
  let generated = 0; const f = fixture(async () => { generated++; return 'must not run'; });
  try {
    const states = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
    const labels = ['排队中', '运行中', '已完成', '失败', '已取消', '已中断'];
    for (const state of states) {
      const c = f.store.createConversation('text-owner', state), run = f.store.accept('text-owner', c.id, state, 'private input');
      f.store.exec('UPDATE service_runs SET state=? WHERE id=?', state, run.runId);
    }
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    for (const [i, state] of states.entries()) {
      s.line('/tasks ' + state); await settle(() => s.text().includes('任务列表（' + labels[i] + '，'));
      const latest = f.calls.filter(call => call.path.startsWith('/api/v1/runs?')).at(-1)!;
      assert.equal(new URL(latest.path, 'http://localhost').searchParams.get('status'), state);
    }
    s.line('/resume #1'); await settle(() => s.error().includes('interrupted')); assert.equal(generated, 0);
    assert(!s.text().includes('private input')); assert(!f.calls.some(call => call.method === 'POST'));
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('specific status pagination retains both filters after conversation changes and resets numbered choices', async () => {
  const f = fixture();
  try {
    const a = f.store.createConversation('text-owner', 'State A'), b = f.store.createConversation('text-owner', 'State B');
    for (let i = 0; i < 23; i++) { const run = f.store.accept('text-owner', a.id, 'done-' + i, 'question'); f.store.start('text-owner', run.runId); f.store.finish('text-owner', run.runId, 'completed-answer-' + i, null); }
    const failed = f.store.accept('text-owner', a.id, 'failed', 'question'); f.store.start('text-owner', failed.runId); f.store.finish('text-owner', failed.runId, null, 'generation_failed');
    const s = f.connect(); await settle(() => s.text().includes('已连接'));
    s.line('/tasks completed --conversation ' + a.id); await settle(() => s.text().includes('#20 ')); assert(!s.text().includes('#1  失败'));
    s.line('/use ' + b.id); await settle(() => s.text().includes('历史：State B'));
    s.line('/tasks more'); await settle(() => s.text().includes('#23 '));
    const query = new URL(f.calls.filter(call => call.path.startsWith('/api/v1/runs?')).at(-1)!.path, 'http://localhost').searchParams;
    assert.equal(query.get('status'), 'completed'); assert.equal(query.get('conversationId'), a.id);
    s.line('/resume #21'); await settle(() => s.text().includes('completed-answer-2'));
    s.line('/tasks failed --here'); await settle(() => s.text().includes('#1  失败'));
    s.line('/resume #21'); await settle(() => s.error().includes('序号不可用'));
    s.line('/resume #1'); await settle(() => s.error().includes('generation_failed'));
    s.line('/exit'); assert.equal(await s.result, 0); assert(!f.calls.some(call => call.method === 'POST'));
  } finally { await f.close(); }
});
test('terminal completion makes no requests before Enter and preserves task recovery and explicit cancellation', async () => {
  let finish!: (text: string) => void, emit!: (text: string) => void;
  const f = fixture((_text, _history, _signal, _reasoning, context) => { emit = context!.onOutput!; return new Promise(resolve => { finish = resolve; }); });
  try {
    const c = f.store.createConversation('text-owner', 'Completion');
    const completed = f.store.accept('text-owner', c.id, 'done', 'question'); f.store.start('text-owner', completed.runId); f.store.finish('text-owner', completed.runId, 'saved result', null);
    const s = f.connect([c.id], f.request, true); let output = ''; s.output.on('data', chunk => { output += String(chunk); });
    await settle(() => s.text().includes('已连接')); const initial = f.calls.length;
    s.input.write('/ta\tc\t'); await settle(() => output.includes('completed') && output.includes('cancelled'));
    assert.equal(f.calls.length, initial); s.input.write('omp\t--h\t'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, initial); s.input.write('\r'); await settle(() => s.text().includes('#1  已完成'));
    const query = new URL(f.calls.filter(call => call.path.startsWith('/api/v1/runs?')).at(-1)!.path, 'http://localhost').searchParams;
    assert.equal(query.get('status'), 'completed'); assert.equal(query.get('conversationId'), c.id);
    s.line('/res\t#1'); await settle(() => s.text().includes('助手（Completion）'));
    const running = f.host.submit('text-owner', c.id, 'pending', 'pending'); await settle(() => !!finish);
    s.line('/ta\trun\t--h\t'); await settle(() => s.text().includes('#1  运行中'));
    s.line('/res\t#1'); await settle(() => s.text().includes('正在观察任务 ' + running.runId));
    emit('草稿仍未提交'); s.input.write('/can\t'); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.store.run('text-owner', running.runId).state, 'running'); assert(!f.calls.some(call => call.path.endsWith('/cancel')));
    s.input.write('\r'); await settle(() => s.text().includes('cancelled')); finish('late result');
    assert.equal(f.calls.filter(call => call.path.endsWith('/cancel')).length, 1); assert(!f.calls.some(call => call.method === 'POST' && call.path.endsWith('/messages')));
    s.line('/ex\t'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
test('nonterminal input never performs completion and preserves literal tabs in multiline messages', async () => {
  let received = ''; const f = fixture(async text => { received = text; return 'literal response'; });
  try {
    const s = f.connect(); await settle(() => s.text().includes('已连接')); s.line('/he\t'); await settle(() => s.error().includes('命令或参数无效'));
    s.line('/edit'); s.line('/ta\tvalue'); s.line('/send'); await settle(() => s.text().includes('literal response'));
    assert.equal(received, '/ta\tvalue'); assert(!f.calls.some(call => call.path.startsWith('/api/v1/runs?')));
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
