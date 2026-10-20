import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

interface LockRecord { pid: number; started: string }

const readRecord = (path: string): LockRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== 'number' || typeof record.started !== 'string') return undefined;
    return { pid: record.pid, started: record.started };
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

// Two bot processes answering the same QQ account produce duplicate replies, so
// the NapCat entry point takes an exclusive lock. A lock left by a crashed
// process is reclaimed on the next start.
export const acquireInstanceLock = (path: string): (() => void) => {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
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
