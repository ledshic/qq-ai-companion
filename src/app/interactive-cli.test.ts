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
    return { input, output, controller, lines, errors, result, line: (text: string) => input.write(text + '\n'), text: () => lines.join('\n'), error: () => errors.join('\n') };
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
    const refused = f.connect([], async () => Response.json({ error: { code: 'unauthorized' } }, { status: 401 }));
    assert.equal(await refused.result, 1); assert(refused.error().includes('unauthorized')); assert(!refused.text().includes('已连接'));
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
    assert.equal((s.text() + output).split('first segment').length - 1, 1); assert(!s.text().includes('助手（'));
    s.line('/cancel'); await settle(() => s.text().includes('cancelled'));
    emit('late segment'); finish('late complete'); await new Promise(resolve => setImmediate(resolve));
    assert(!(s.text() + output).includes('late segment')); assert(!s.text().includes('late complete'));
    assert.equal(f.store.all("SELECT * FROM service_messages WHERE role = 'assistant'").length, 0);
    s.line('/exit'); assert.equal(await s.result, 0);
  } finally { await f.close(); }
});
