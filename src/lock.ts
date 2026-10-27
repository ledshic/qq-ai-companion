import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

interface LockRecord { pid: number; started: string; processIdentity?: string }

export type InstanceLockState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'stale'; pid: number; started: string }
  | { kind: 'running'; pid: number; started: string };

export type StartDecision =
  | { action: 'start' }
  | { action: 'refuse'; message: string };

export interface StopOutcome {
  stopped: boolean;
  message: string;
}

export interface LockInspectOptions {
  isAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | undefined;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Process lock only. WebSocket, QQ online, and the model are separate checks. */
export const INSTANCE_STATUS_SCOPE = '状态只报告本机进程锁，不检查 WebSocket、QQ 是否在线或模型是否可用。';

export const instanceDataDir = (memoryPath: string): string =>
  memoryPath === ':memory:' ? 'data' : dirname(memoryPath);

export const instanceLockPath = (memoryPath = 'data/memory.db'): string =>
  join(instanceDataDir(memoryPath), 'bot.lock');

const runningMessage = (pid: number, started: string): string =>
  `另一个实例正在运行（pid ${pid}，启动于 ${started}）。先停止它，避免重复回复。`;

const readLockFile = (path: string): { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'record'; record: LockRecord } => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return { kind: 'unreadable' };
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== 'number' || typeof record.started !== 'string') return { kind: 'unreadable' };
    return { kind: 'record', record: { pid: record.pid, started: record.started,
      ...(typeof record.processIdentity === 'string' && record.processIdentity
        ? { processIdentity: record.processIdentity } : {}) } };
  } catch {
    return { kind: 'unreadable' };
  }
};

// pid 1 is init, not this bot. Treating it as alive would block restart and a
// stop command must never signal it. The current process is not "another" instance.
const defaultAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
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

export const readInstanceLock = (path: string, options?: LockInspectOptions): InstanceLockState => {
  const loaded = readLockFile(path);
  if (loaded.kind !== 'record') return loaded;
  const alive = options?.isAlive ?? defaultAlive;
  const { pid, started } = loaded.record;
  return alive(pid) ? { kind: 'running', pid, started } : { kind: 'stale', pid, started };
};

export const describeInstanceLock = (state: InstanceLockState): string => {
  switch (state.kind) {
    case 'missing':
      return '未运行：没有实例锁。可以启动。';
    case 'unreadable':
      return '实例锁无法读取。不要把它当成正在运行；下次启动会尝试回收。';
    case 'stale':
      return `未运行：实例锁已过期（pid ${state.pid}，记录的启动时间 ${state.started}）。可以启动，启动时会回收这把锁。`;
    case 'running':
      return `正在运行（pid ${state.pid}，启动于 ${state.started}）。不要再启动第二个实例。`;
  }
};

export const decideInstanceStart = (state: InstanceLockState): StartDecision =>
  state.kind === 'running'
    ? { action: 'refuse', message: runningMessage(state.pid, state.started) }
    : { action: 'start' };

const stopRefusal = (state: Exclude<InstanceLockState, { kind: 'running' }>): string => {
  switch (state.kind) {
    case 'missing':
      return '没有实例锁，没有可停止的进程。';
    case 'unreadable':
      return '实例锁无法读取，未发送停止信号。';
    case 'stale':
      return `实例锁已过期（pid ${state.pid}，记录的启动时间 ${state.started}），进程不在运行，未发送停止信号。`;
  }
};

// The NapCat process releases the lock while handling SIGTERM. Deleting the
// file here would let a second start overlap that shutdown.
export const requestInstanceStop = (path: string, options?: LockInspectOptions): StopOutcome => {
  const state = readInstanceLock(path, options);
  if (state.kind !== 'running') return { stopped: false, message: stopRefusal(state) };
  if (!canSignal(state.pid)) return { stopped: false, message: '不会向这个 pid 发送停止信号。' };
  const loaded = readLockFile(path);
  if (loaded.kind !== 'record' || loaded.record.pid !== state.pid || loaded.record.started !== state.started ||
      !loaded.record.processIdentity) {
    return { stopped: false, message: '实例锁缺少可验证的进程身份或已变化，未发送停止信号。请先人工确认进程。' };
  }
  try {
    const identity = (options?.processIdentity ?? processIdentity)(state.pid);
    const latest = readLockFile(path);
    if (!identity || identity !== loaded.record.processIdentity || latest.kind !== 'record' ||
        latest.record.pid !== state.pid || latest.record.started !== state.started || latest.record.processIdentity !== identity) {
      return { stopped: false, message: '进程身份不符、无法验证或实例锁已变化，未发送停止信号。' };
    }
  } catch {
    return { stopped: false, message: '无法验证进程身份，未发送停止信号。' };
  }
  const signal = options?.signal ?? ((pid, sig) => { process.kill(pid, sig); });
  try {
    signal(state.pid, 'SIGTERM');
  } catch {
    return { stopped: false, message: `无法向 pid ${state.pid} 发送停止信号，实例锁仍保留。` };
  }
  return {
    stopped: true,
    message: `已向 pid ${state.pid} 发送停止信号。进程退出时会释放实例锁；这里不会删除锁文件。`,
  };
};

// Two bot processes answering the same QQ account produce duplicate replies, so
// the NapCat entry point takes an exclusive lock. A lock left by a crashed
// process is reclaimed on the next start.
export const acquireInstanceLock = (path: string, options?: LockInspectOptions): (() => void) => {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString(),
          processIdentity: (options?.processIdentity ?? processIdentity)(process.pid) }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const state = readInstanceLock(path, options);
    if (state.kind === 'running') throw new Error(runningMessage(state.pid, state.started));
    try { unlinkSync(path); } catch { /* raced with another start */ }
  }
  throw new Error(`无法获取实例锁 ${path}，请检查文件权限。`);
};
