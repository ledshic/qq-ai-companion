import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, chmodSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerCredential } from './credentials.js';
test('local owner credential persists, remains private and rejects symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-credential-'));
  try {
    const path = join(root, 'owner.json'),
      first = ownerCredential(path);
    assert.deepEqual(ownerCredential(path), first);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o644);
    assert.throws(() => ownerCredential(path), /0600/);
    chmodSync(path, 0o600);
    const link = join(root, 'link.json');
    symlinkSync(path, link);
    assert.throws(() => ownerCredential(link));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
