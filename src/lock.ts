import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

interface LockRecord { pid: number; started: string; processIdentity?: string }

const readRecord = (path: string): LockRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== 'number' || typeof record.started !== 'string') return undefined;
    return { pid: record.pid, started: record.started,
      ...(typeof record.processIdentity === 'string' && record.processIdentity
        ? { processIdentity: record.processIdentity } : {}) };
  } catch {
    return undefined;
  }
};

const isRunning = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const canSignal = (pid: number): boolean =>
  Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;

// Bind the lock to the OS process start and command, not merely a reusable PID.
// Never persist command arguments; they can contain credentials. Unsupported or
// inaccessible process inspection disables automatic stop rather than guessing.
export const processIdentity = (pid: number): string | undefined => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    const description = execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    if (!description) return;
    return createHash('sha256').update(description).digest('hex');
  } catch { return; }
};

export interface StopOutcome { stopped: boolean; message: string }
export interface LockInspectOptions {
  isAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | undefined;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

// A stale lock must never authorize signaling a recycled PID. Leave the lock
// intact; its owner removes it only after completing shutdown.
export const requestInstanceStop = (path: string, options?: LockInspectOptions): StopOutcome => {
  const record = readRecord(path);
  if (!record || !canSignal(record.pid) || !(options?.isAlive ?? isRunning)(record.pid)) {
    return { stopped: false, message: '没有可安全停止的存活实例，未发送停止信号。' };
  }
  if (!record.processIdentity) {
    return { stopped: false, message: '实例锁缺少可验证的进程身份，未发送停止信号。请先人工确认进程。' };
  }
  try {
    const identity = (options?.processIdentity ?? processIdentity)(record.pid);
    const latest = readRecord(path);
    if (!identity || identity !== record.processIdentity || !latest || latest.pid !== record.pid ||
        latest.started !== record.started || latest.processIdentity !== identity) {
      return { stopped: false, message: '进程身份不符、无法验证或实例锁已变化，未发送停止信号。' };
    }
  } catch {
    return { stopped: false, message: '无法验证进程身份，未发送停止信号。' };
  }
  try { (options?.signal ?? process.kill)(record.pid, 'SIGTERM'); }
  catch { return { stopped: false, message: '无法发送停止信号，实例锁仍保留。' }; }
  return { stopped: true, message: '已发送停止信号；这里不会删除锁文件。' };
};

// Two bot processes answering the same QQ account produce duplicate replies, so
// the NapCat entry point takes an exclusive lock. A lock left by a crashed
// process is reclaimed on the next start.
export const acquireInstanceLock = (path: string): (() => void) => {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), processIdentity: processIdentity(process.pid) }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = readRecord(path);
    if (existing && isRunning(existing.pid)) {
      throw new Error(`另一个实例正在运行（pid ${existing.pid}，启动于 ${existing.started}）。先停止它，避免重复回复。`);
    }
    try { unlinkSync(path); } catch { /* raced with another start */ }
  }
  throw new Error(`无法获取实例锁 ${path}，请检查文件权限。`);
};
