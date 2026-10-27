import { resolve } from 'node:path';
import { acquireInstanceLock, instanceLockPath } from '../runtime/lock.js';

const heldLocks = new Set<string>();

// Keep the existing lock path so legacy and service hosts cannot own the same data.
export function acquireHostLock(memoryPath: string): () => void {
  const path = resolve(instanceLockPath(memoryPath));
  if (heldLocks.has(path)) throw Error('Agent host already active for this data directory');
  const release = acquireInstanceLock(path);
  heldLocks.add(path);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    heldLocks.delete(path);
    release();
  };
}
