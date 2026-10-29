// Opt-in POSIX smoke: node --import tsx src/testing/cli-pty-smoke.ts
// Uses Python's standard-library PTY, a temporary database and the formal API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceStore } from '../runtime/service/store.js';
import { RunHost } from '../runtime/service/host.js';
import { createServiceAPI } from '../app/server/api.js';
const python = `import os, sys, pty, termios, fcntl, struct, subprocess, select, signal
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 12, 40, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
def stop(*args):
    raise KeyboardInterrupt()
signal.signal(signal.SIGTERM, stop)
def resize(*args):
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 6, 20, 0, 0))
    os.kill(child.pid, signal.SIGWINCH)
signal.signal(signal.SIGUSR1, resize)
try:
    reading = True
    while child.poll() is None:
        ready, _, _ = select.select([master] + ([0] if reading else []), [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if data:
                os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                os.write(master, data)
            else:
                reading = False
except KeyboardInterrupt:
    pass
finally:
    if child.poll() is None:
        child.terminate()
    code = child.wait(timeout=5)
    os.set_blocking(master, False)
    try:
        while True:
            data = os.read(master, 65536)
            if not data:
                break
            os.write(1, data)
    except OSError:
        pass
    after = termios.tcgetattr(slave)
    mask = termios.ICANON | termios.ECHO | termios.ISIG
    print('PTY_RESTORED=' + str((before[3] & mask) == (after[3] & mask)), file=sys.stderr)
    os.close(master)
    os.close(slave)
sys.exit(code)
`;
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('PTY smoke timed out');
}
const root = mkdtempSync(join(tmpdir(), 'agent-editor-pty-')), artifacts = process.argv[2] ?? 'artifacts/cli-editor';
mkdirSync(artifacts, { recursive: true });
const credential = join(root, 'credential.json'); writeFileSync(credential, JSON.stringify({ token: 'pty-fixture-token' }), { mode: 0o600 });
const store = new ServiceStore(':memory:'); store.ensureOwner('pty-owner', 'pty-device', 'pty-fixture-token');
const generations: { text: string; emit: (text: string) => void; finish: (text: string) => void; signal: AbortSignal }[] = [];
const host = new RunHost(store, (text, _history, signal, _reasoning, context) => new Promise(resolve => generations.push({ text, emit: context!.onOutput!, finish: resolve, signal })));
const api = createServiceAPI({ store, host, origins: [], status: () => ({ model: 'configured', qq: 'disabled' }) });
const children: { child: ReturnType<typeof spawn>; done: Promise<unknown[]>; text: () => string; error: () => string; send: (text: string) => boolean }[] = [];
let base = '';
function start() {
  const child = spawn('python3', ['-u', '-c', python, process.execPath, '--import', 'tsx', fileURLToPath(new URL('../app/cli.ts', import.meta.url)), 'chat'], {
    env: { ...process.env, AGENT_CREDENTIAL_FILE: credential, AGENT_URL: base }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', error = ''; child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { error += chunk; });
  const done = once(child, 'close');
  const session = { child, done, text: () => output, error: () => error, send: (text: string) => child.stdin!.write(text) }; children.push(session); return session;
}
try {
  await api.listen({ host: '127.0.0.1', port: 0 }); const address = api.server.address(); assert(address && typeof address !== 'string'); base = `http://127.0.0.1:${address.port}`;
  const first = start(); await wait(() => first.text().includes('\x1b[?2004h'));
  first.send('\x1b[200~/exit\n  multiline\x1b[201~'); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(generations.length, 0);
  first.send('\r'); await wait(() => generations.length === 1 && first.text().includes('已接受任务'));
  assert.equal(generations[0]!.text, '/exit\n  multiline');
  const cancelled = first.text().match(/已接受任务：([^\s]+)/)![1]!;
  generations[0]!.emit('首段真实草稿'); await wait(() => first.text().includes('首段真实草稿'));
  first.send('next\n  input');
  const beforeResize = first.text().length; first.child.kill('SIGUSR1'); await wait(() => first.text().length > beforeResize);
  first.send('\x10'); await wait(() => first.text().includes('输入历史'));
  first.send('\x0f\r'); await wait(() => first.text().includes('尚未结束'));
  first.send('\x18'); await wait(() => store.run('pty-owner', cancelled).state === 'cancelled');
  assert(generations[0]!.signal.aborted); generations[0]!.emit('迟到草稿'); generations[0]!.finish('迟到回答');
  await wait(() => first.text().includes('cancelled')); first.send('\r'); await wait(() => generations.length === 2);
  assert.equal(generations[1]!.text, 'next\n  input');
  const conversation = store.conversations('pty-owner', '', 50)[0]!;
  await wait(() => (first.text().match(/已接受任务：/g)?.length ?? 0) === 2);
  const resumed = first.text().match(/已接受任务：([^\s]+)/g)!.at(-1)!.split('：')[1]!;
  first.send('\x03'); assert.equal((await first.done)[0], 0, first.error()); assert(first.error().includes('PTY_RESTORED=True'));
  assert.equal(store.run('pty-owner', resumed).state, 'running');
  const second = start(); await wait(() => second.text().includes('\x1b[?2004h')); second.send('\x10/ta\trun\t--conv\t' + conversation.id + '\r');
  await wait(() => second.text().includes('#1') && second.text().includes(resumed)); second.send('/res\t#1\r');
  await wait(() => second.text().includes('正在观察任务')); generations[1]!.emit('恢复后的草稿'); await wait(() => second.text().includes('恢复后的草稿'));
  generations[1]!.finish('恢复后的完整回答'); await wait(() => second.text().includes('恢复后的完整回答'));
  second.send('/ta\tcomp\t--h\t\r'); await wait(() => second.text().includes('#1  已完成'));
  second.send('/cl\t\r'); await wait(() => second.text().includes('本次输入历史已清空'));
  second.send('\x04'); assert.equal((await second.done)[0], 0, second.error()); assert(second.error().includes('PTY_RESTORED=True'));
  assert.deepEqual(store.history('pty-owner', conversation.id).map(message => message.content), ['next\n  input', '恢复后的完整回答']);
  assert.deepEqual(readdirSync(root), ['credential.json']);
  assert(!first.text().includes('迟到草稿')); assert(!first.text().includes('pty-fixture-token'));
  writeFileSync(join(artifacts, 'pty-first.txt'), first.text()); writeFileSync(join(artifacts, 'pty-resume.txt'), second.text());
  console.log('PTY smoke passed: multiline paste, resize, busy edit, Ctrl+X, Ctrl+C, process-local input history and draft restoration, local command/state/flag completion, authenticated filtered listing and numbered resume, final history, Ctrl+D and raw mode restoration.');
} finally {
  for (const session of children) if (session.child.exitCode === null && session.child.signalCode === null) { session.child.kill('SIGTERM'); await session.done; }
  host.stop(); await api.close(); store.close(); rmSync(root, { recursive: true, force: true });
}
