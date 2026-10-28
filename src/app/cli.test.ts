import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { runCLI } from './cli.js';
import { ServiceStore } from '../runtime/service/store.js';
import { RunHost, type ConsoleGenerator } from '../runtime/service/host.js';
import { createServiceAPI } from './server/api.js';
function fixture(generate: ConsoleGenerator = async text => 'answer:' + text) {
  const root = mkdtempSync(join(tmpdir(), 'agent-cli-'));
  const path = join(root, 'credentials.json'); writeFileSync(path, JSON.stringify({ token: 'fixture-token' }), { mode: 0o600 });
  const store = new ServiceStore(':memory:'); store.ensureOwner('cli-owner', 'device', 'fixture-token');
  const host = new RunHost(store, generate);
  const api = createServiceAPI({ store, host, origins: [], status: () => ({ model: 'configured', qq: 'disabled' }) });
  const request: typeof fetch = async (url, options) => {
    const reply = await api.inject({ method: (options?.method ?? 'GET') as 'GET' | 'POST',
      url: new URL(String(url)).pathname + new URL(String(url)).search,
      headers: options?.headers as Record<string, string>, payload: options?.body as string | undefined });
    return new Response(reply.body, { status: reply.statusCode, headers: { 'Content-Type': String(reply.headers['content-type']) } });
  };
  const env = { AGENT_CREDENTIAL_FILE: path, AGENT_URL: 'http://127.0.0.1:4320' };
  const invoke = async (argv: string[], overrideRequest = request) => {
    const output: string[] = [], errors: string[] = [];
    const code = await runCLI(argv, { env, request: overrideRequest, out: line => output.push(line), error: line => errors.push(line) });
    return { code, output: output.map(line => JSON.parse(line)), errors };
  };
  return { root, path, store, host, api, env, request, invoke, async close() {
    host.stop(); await api.close(); store.close(); rmSync(root, { recursive: true, force: true });
  } };
}
const settle = async (ready: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (ready()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('CLI fixture did not settle');
};
test('help and validation do not read or create credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-help-')); const path = join(root, 'missing.json');
  const output: string[] = [];
  try {
    assert.equal(await runCLI(['--help'], { env: { AGENT_CREDENTIAL_FILE: path }, out: line => output.push(line) }), 0);
    assert.match(output[0]!, /Ctrl\+C stops observation/);
    for (const argv of [['unknown'], ['send'], ['watch', '-1'], ['watch', '1e3'], ['status', 'extra']])
      assert.equal(await runCLI(argv, { env: { AGENT_CREDENTIAL_FILE: path }, error: () => {} }), 2);
    assert.equal(await runCLI(['status'], { env: { AGENT_CREDENTIAL_FILE: path }, error: line => output.push(line) }), 1);
    assert.match(output.at(-1)!, /credential_unavailable/); assert.equal(existsSync(path), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('CLI uses formal SDK for sessions, scoped source management, submission and run queries', async () => {
  const f = fixture();
  try {
    assert.equal((await f.invoke(['status'])).output[0].environment, 'service');
    const a = (await f.invoke(['new', 'Target'])).output[0], b = (await f.invoke(['new', 'Source'])).output[0];
    assert.equal(a.ownerId, 'cli-owner'); assert.equal((await f.invoke(['conversations'])).output.length, 2);
    assert.deepEqual((await f.invoke(['grant-sources', a.id, b.id])).output[0].sourceConversationIds, [b.id]);
    assert.deepEqual((await f.invoke(['sources', a.id])).output[0].sourceConversationIds, [b.id]);
    assert.deepEqual((await f.invoke(['clear-sources', a.id])).output[0].sourceConversationIds, []);
    const submitted = await f.invoke(['send', a.id, 'hello', 'stable-id']);
    assert.equal(submitted.code, 0); assert.equal(submitted.output[0].clientMessageId, 'stable-id');
    const id = submitted.output[1].runId;
    await settle(() => f.store.run('cli-owner', id).state === 'completed');
    assert.equal((await f.invoke(['run', id])).output[0].result, 'answer:hello');
    const foreign = f.store.createConversation('foreign', 'Hidden');
    const rejected = await f.invoke(['grant-sources', a.id, foreign.id]);
    assert.equal(rejected.code, 1); assert.deepEqual(rejected.errors, ['not_found']);
  } finally { await f.close(); }
});
test('uncertain submission exposes a stable retry id without automatic POST retries or duplicate generation', async () => {
  let generations = 0; const f = fixture(async () => { generations++; return 'done'; });
  try {
    const c = f.store.createConversation('cli-owner', 'Retry'); let posts = 0;
    const lostResponse: typeof fetch = async (url, init) => { posts++; await f.request(url, init); throw Error('fixture-token must never be printed'); };
    const first = await f.invoke(['send', c.id, 'question', 'retry-id'], lostResponse);
    assert.equal(first.code, 1); assert.equal(posts, 1); assert.equal(first.output[0].clientMessageId, 'retry-id');
    assert.deepEqual(first.errors, ['request_failed']);
    const retried = await f.invoke(['send', c.id, 'question', 'retry-id']);
    assert.equal(retried.output[1].duplicate, true);
    await settle(() => f.store.run('cli-owner', retried.output[1].runId).state === 'completed'); assert.equal(generations, 1);
  } finally { await f.close(); }
});
test('explicit CLI cancellation cancels the run and suppresses late results', async () => {
  let finish!: (value: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    const c = f.store.createConversation('cli-owner', 'Cancel');
    const run = f.host.submit('cli-owner', c.id, 'first', 'pending'); await settle(() => !!finish);
    assert.equal((await f.invoke(['cancel', run.runId])).output[0].state, 'cancelled');
    finish('late'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.messages('cli-owner', c.id, 0, 50).messages.some(message => message.role === 'assistant'), false);
  } finally { await f.close(); }
});
test('CLI process authenticates and Ctrl+C ends SSE observation without cancelling the remote task', { timeout: 8000 }, async () => {
  let finish!: (value: string) => void; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.api.listen({ host: '127.0.0.1', port: 0 });
    const address = f.api.server.address(); assert(address && typeof address !== 'string');
    const env = { ...process.env, ...f.env, AGENT_URL: `http://127.0.0.1:${address.port}` };
    const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, 'status'], { env, timeout: 4000 });
    assert.equal(JSON.parse(result.stdout).environment, 'service'); assert.doesNotMatch(result.stdout + result.stderr, /fixture-token/);
    const c = f.store.createConversation('cli-owner', 'Watch'); const run = f.host.submit('cli-owner', c.id, 'watch', 'pending');
    await settle(() => !!finish);
    child = spawn(process.execPath, ['--import', 'tsx', cli, 'watch'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); let stdout = '', stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); }); child.stderr!.on('data', chunk => { stderr += String(chunk); });
    await settle(() => stdout.includes('message.accepted')); child.kill('SIGINT');
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(f.store.run('cli-owner', run.runId).state, 'running'); assert.doesNotMatch(stdout + stderr, /fixture-token/);
    finish('completed after observer exit'); await settle(() => f.store.run('cli-owner', run.runId).state === 'completed');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await f.close();
  }
});
