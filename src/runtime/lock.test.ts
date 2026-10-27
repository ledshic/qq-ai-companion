import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  INSTANCE_STATUS_SCOPE,
  acquireInstanceLock,
  decideInstanceStart,
  describeInstanceLock,
  instanceLockPath,
  readInstanceLock,
  requestInstanceStop,
} from './lock.js';

const started = '2026-10-26T09:00:00.000Z';

const writeLock = (path: string, pid: number, processIdentity?: string): void => {
  writeFileSync(path, JSON.stringify({ pid, started, processIdentity }));
};

test('lock path follows the memory database and keeps the in-memory default in data/', () => {
  assert.equal(instanceLockPath('data/memory.db'), join('data', 'bot.lock'));
  assert.equal(instanceLockPath(':memory:'), join('data', 'bot.lock'));
  assert.equal(instanceLockPath('/var/bot/memory.db'), join('/var/bot', 'bot.lock'));
  assert.equal(instanceLockPath(), join('data', 'bot.lock'));
});

test('status distinguishes a missing lock, a stale pid, a live pid, and an unreadable file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-'));
  const path = join(dir, 'bot.lock');
  try {
    assert.equal(readInstanceLock(path).kind, 'missing');
    assert.match(describeInstanceLock(readInstanceLock(path)), /没有实例锁/);
    assert.equal(decideInstanceStart(readInstanceLock(path)).action, 'start');

    writeLock(path, 2_147_483_646);
    const stale = readInstanceLock(path);
    assert.deepEqual(stale, { kind: 'stale', pid: 2_147_483_646, started });
    assert.match(describeInstanceLock(stale), /已过期（pid 2147483646，记录的启动时间 2026-10-26T09:00:00.000Z）/);
    assert.equal(decideInstanceStart(stale).action, 'start');

    const running = readInstanceLock(path, { isAlive: () => true });
    assert.equal(running.kind, 'running');
    const decision = decideInstanceStart(running);
    assert.equal(decision.action, 'refuse');
    if (decision.action === 'refuse') {
      assert.equal(decision.message, `另一个实例正在运行（pid 2147483646，启动于 ${started}）。先停止它，避免重复回复。`);
    }
    assert.match(describeInstanceLock(running), /正在运行（pid 2147483646，启动于 2026-10-26T09:00:00.000Z）/);
    assert.match(INSTANCE_STATUS_SCOPE, /不检查 WebSocket、QQ 是否在线或模型是否可用/);

    writeFileSync(path, '{');
    const unreadable = readInstanceLock(path);
    assert.equal(unreadable.kind, 'unreadable');
    assert.equal(decideInstanceStart(unreadable).action, 'start');
    assert.match(describeInstanceLock(unreadable), /无法读取/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stop signals only a live identity-verified pid and leaves the lock file in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-'));
  const path = join(dir, 'bot.lock');
  const signals: Array<[number, NodeJS.Signals]> = [];
  const signal = (pid: number, name: NodeJS.Signals): void => { signals.push([pid, name]); };
  try {
    const missing = requestInstanceStop(path, { signal });
    assert.equal(missing.stopped, false);
    assert.match(missing.message, /没有实例锁/);

    writeLock(path, 4242, 'expected-identity');
    const original = readFileSync(path, 'utf8');
    const stale = requestInstanceStop(path, { isAlive: () => false, signal });
    assert.equal(stale.stopped, false);
    assert.match(stale.message, /未发送停止信号/);
    assert.equal(readFileSync(path, 'utf8'), original);

    const stopped = requestInstanceStop(path, { isAlive: () => true, processIdentity: () => 'expected-identity', signal });
    assert.equal(stopped.stopped, true);
    assert.deepEqual(signals, [[4242, 'SIGTERM']]);
    assert.match(stopped.message, /不会删除锁文件/);
    assert.equal(readFileSync(path, 'utf8'), original);

    signals.length = 0;
    writeLock(path, process.pid);
    const self = requestInstanceStop(path, { isAlive: () => true, signal });
    assert.equal(self.stopped, false);
    assert.deepEqual(signals, []);
    assert.equal(existsSync(path), true);

    writeLock(path, 1);
    const init = requestInstanceStop(path, { isAlive: () => true, signal });
    assert.equal(init.stopped, false);
    assert.deepEqual(signals, []);

    writeLock(path, 4242, 'expected-identity');
    const failed = requestInstanceStop(path, {
      isAlive: () => true,
      processIdentity: () => 'expected-identity',
      signal: () => { throw new Error('denied'); },
    });
    assert.equal(failed.stopped, false);
    assert.match(failed.message, /实例锁仍保留/);
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ pid: 4242, started, processIdentity: 'expected-identity' }));

    writeFileSync(path, 'not-json');
    const broken = requestInstanceStop(path, { signal });
    assert.equal(broken.stopped, false);
    assert.match(broken.message, /无法读取/);
    assert.equal(readFileSync(path, 'utf8'), 'not-json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live lock refuses a second start, and a dead lock is reclaimed without signaling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-'));
  const path = join(dir, 'bot.lock');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    assert.ok(child.pid);
    writeLock(path, child.pid);
    const running = readInstanceLock(path);
    assert.equal(running.kind, 'running');
    const decision = decideInstanceStart(running);
    assert.equal(decision.action, 'refuse');
    if (decision.action !== 'refuse') return;
    assert.throws(() => acquireInstanceLock(path), { message: decision.message });
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify({ pid: child.pid, started }));

    child.kill('SIGKILL');
    await exited;
    const release = acquireInstanceLock(path);
    const held = JSON.parse(readFileSync(path, 'utf8')) as { pid: number };
    assert.equal(held.pid, process.pid);
    release();
    assert.equal(existsSync(path), false);

    writeLock(path, 1);
    const reclaimed = acquireInstanceLock(path);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    reclaimed();
    assert.equal(existsSync(path), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
