import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  INSTANCE_STATUS_SCOPE,
  decideInstanceStart,
  describeInstanceLock,
  instanceLockPath,
  readInstanceLock,
  requestInstanceStop,
} from '../runtime/lock.js';

// Operator entry for the NapCat process lock. This file does not connect to QQ
// or a model. Start does not hold the lock; src/app/napcat.ts acquires it.
const lockPath = instanceLockPath(process.env.MEMORY_DB || 'data/memory.db');
const command = process.argv[2];

if (command === 'status') {
  console.log(describeInstanceLock(readInstanceLock(lockPath)));
  console.log(INSTANCE_STATUS_SCOPE);
} else if (command === 'stop') {
  const outcome = requestInstanceStop(lockPath);
  if (!outcome.stopped) {
    console.error(outcome.message);
    process.exit(1);
  }
  console.log(outcome.message);
} else if (command === 'start') {
  const state = readInstanceLock(lockPath);
  const decision = decideInstanceStart(state);
  if (decision.action === 'refuse') {
    console.error(decision.message);
    process.exit(1);
  }
  if (state.kind !== 'missing') console.log(describeInstanceLock(state));
  // A direct Node child receives shutdown signals itself; signaling a pnpm/tsx
  // launcher can leave its bot descendant alive after the launcher has exited.
  const child = spawn(process.execPath, ['--import', 'tsx', '--env-file-if-exists=.env',
    fileURLToPath(new URL('./napcat.ts', import.meta.url))], { stdio: 'inherit' });
  let stopping: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = signal;
    try { child.kill(signal); }
    catch (error) { console.error(`无法转发停止信号：${error instanceof Error ? error.message : 'unknown'}`); }
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  child.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`无法启动：${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) process.exit(code ?? (stopping === 'SIGINT' ? 130 : 143));
    if (signal) {
      console.error(`启动进程因 ${signal} 结束。`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
} else {
  console.error('用法：pnpm bot:status、pnpm bot:stop 或 pnpm bot:start。');
  process.exit(1);
}
