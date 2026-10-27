import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireInstanceLock, processIdentity, requestInstanceStop } from './lock.js';

const started = '2026-10-26T09:00:00.000Z';
const writeLock = (path: string, pid: number, processIdentity?: string): void => {
  writeFileSync(path, JSON.stringify({ pid, started, processIdentity }));
};

test('verified stop sends exactly one signal and retains the lock until shutdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-stop-confirmed-'));
  const path = join(dir, 'bot.lock');
  const signals: Array<[number, NodeJS.Signals]> = [];
  try {
    writeLock(path, 4242, 'expected-identity');
    const original = readFileSync(path, 'utf8');
    const outcome = requestInstanceStop(path, { isAlive: () => true,
      processIdentity: () => 'expected-identity', signal: (pid, name) => { signals.push([pid, name]); } });
    assert.equal(outcome.stopped, true);
    assert.deepEqual(signals, [[4242, 'SIGTERM']]);
    assert.equal(readFileSync(path, 'utf8'), original);
    const failed = requestInstanceStop(path, { isAlive: () => true,
      processIdentity: () => 'expected-identity', signal: () => { throw Error('denied'); } });
    assert.equal(failed.stopped, false);
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop refuses legacy locks, reused PIDs, unavailable identity and changed locks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-identity-'));
  const path = join(dir, 'bot.lock');
  const signals: number[] = [];
  const options = { isAlive: () => true, signal: (pid: number) => { signals.push(pid); } };
  try {
    writeLock(path, 4242);
    assert.equal(requestInstanceStop(path, { ...options, processIdentity: () => 'current-process' }).stopped, false);
    for (const identity of [() => 'another-process', () => undefined, () => { throw Error('inspection failed'); }]) {
      writeLock(path, 4242, 'original-process');
      const original = readFileSync(path, 'utf8');
      assert.equal(requestInstanceStop(path, { ...options, processIdentity: identity }).stopped, false);
      assert.equal(readFileSync(path, 'utf8'), original);
    }
    for (const replace of [
      () => writeLock(path, 4243, 'original-process'),
      () => writeLock(path, 4242, 'replacement-process'),
    ]) {
      writeLock(path, 4242, 'original-process');
      assert.equal(requestInstanceStop(path, { ...options, processIdentity: () => {
        replace(); return 'original-process';
      } }).stopped, false);
    }
    assert.deepEqual(signals, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale identity cannot authorize stopping an unrelated live process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-unrelated-'));
  const path = join(dir, 'bot.lock');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const signals: number[] = [];
  try {
    assert.ok(child.pid);
    writeLock(path, child.pid, 'identity-of-the-original-bot');
    const result = requestInstanceStop(path, { signal: pid => { signals.push(pid); } });
    assert.equal(result.stopped, false);
    assert.match(result.message, /身份不符|无法验证/);
    assert.deepEqual(signals, []);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGKILL'); await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newly acquired lock stores the real identity and can authorize a verified stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-lock-real-'));
  const path = join(dir, 'bot.lock');
  // The child acquires a genuine lock through the same helper as the bot. Only
  // this disposable child receives the real stop signal.
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireInstanceLock } from ${JSON.stringify(new URL('./lock.js', import.meta.url).href)};
     const release = acquireInstanceLock(process.argv[1]);
     process.once('SIGTERM', () => { release(); process.exit(0); });
     setInterval(() => {}, 1000);
     process.send('ready');`, path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve()); child.once('error', reject);
      child.once('exit', () => reject(Error('test child exited before acquiring its lock')));
    });
    const held = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(held.pid, child.pid);
    assert.equal(typeof held.processIdentity, 'string');
    assert.equal(held.processIdentity, processIdentity(held.pid));
    assert.match(held.processIdentity, /^[a-f0-9]{64}$/);
    assert.equal(requestInstanceStop(path).stopped, true);
    await exited;
    assert.equal(child.exitCode, 0); assert.equal(existsSync(path), false);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL'); await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
