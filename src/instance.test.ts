import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const waitForFile = async (path: string, child: ChildProcess): Promise<void> => {
  for (let count = 0; count < 300; count++) {
    if (existsSync(path)) return;
    assert.equal(child.exitCode, null, 'entry exited before the fixture was ready');
    assert.equal(child.signalCode, null, 'entry was terminated before the fixture was ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`fixture did not create ${path}`);
};

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`start forwards ${signal} to the bot and waits for cleanup`, { timeout: 8000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qq-start-signals-'));
    const source = join(root, 'src'); mkdirSync(source);
    const lockPath = join(root, 'bot.lock');
    // Copy the exact CLI under test beside a harmless bot fixture. This tests
    // real process signaling without loading .env secrets, QQ or model code.
    copyFileSync(new URL('./instance.ts', import.meta.url), join(source, 'instance.ts'));
    symlinkSync(fileURLToPath(new URL('./lock.ts', import.meta.url)), join(source, 'lock.ts'));
    symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module',
      scripts: { napcat: 'node --import tsx src/napcat.ts' },
    }));
    writeFileSync(join(source, 'napcat.ts'), `
      import { writeFileSync, unlinkSync } from 'node:fs';
      for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        writeFileSync('stopping', signal);
        setTimeout(() => { unlinkSync('bot.lock'); writeFileSync('stopped', signal); process.exit(0); }, 250);
      });
      setInterval(() => {}, 1000);
      writeFileSync('bot.lock', String(process.pid));
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', join(source, 'instance.ts'), 'start'], {
      cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MEMORY_DB: join(root, 'memory.db') },
    });
    let errors = ''; child.stderr?.on('data', chunk => { errors += String(chunk); });
    const exited = once(child, 'exit');
    let botPid: number | undefined;
    try {
      await waitForFile(lockPath, child); botPid = Number(readFileSync(lockPath, 'utf8'));
      child.kill(signal);
      await waitForFile(join(root, 'stopping'), child);
      assert.equal(child.exitCode, null, 'wrapper must wait for bot shutdown');
      assert.equal(child.signalCode, null);
      assert.equal(readFileSync(join(root, 'stopping'), 'utf8'), signal);
      const [code, endedBy] = await exited;
      assert.equal(code, 0, errors); assert.equal(endedBy, null);
      assert.equal(existsSync(lockPath), false);
      assert.equal(readFileSync(join(root, 'stopped'), 'utf8'), signal);
      assert.throws(() => process.kill(botPid!, 0), /ESRCH/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      if (botPid) { try { process.kill(botPid, 'SIGKILL'); } catch { /* already exited */ } }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
