import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapService } from './service-bootstrap.js';
import { bootstrapAgent } from './bootstrap.js';
import { readServiceConfig } from './service-config.js';

test('service ignores legacy configuration and allocates only its ownership lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'service-bootstrap-'));
  try {
    const host = bootstrapService({
      MEMORY_DB: join(root, 'memory.db'), LLM_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture',
      NAPCAT_WS_URL: 'invalid', PERSONALITY_MODE: 'invalid', WARMUP_HOURS: 'invalid',
      FOLLOW_UP_MODE: 'invalid', EVENT_MEMORY_MODE: 'invalid', MEMES_ENABLED: 'true', VISION_ENABLED: 'true',
    });
    try {
      assert.deepEqual(host.status(), { model: 'configured', qq: 'disabled' });
      assert.equal(typeof host.generate, 'function');
      assert.deepEqual(readdirSync(root), ['bot.lock']);
      assert.throws(() => bootstrapService({ MEMORY_DB: join(root, 'memory.db') }), /already active/);
    } finally { host.close(); host.close(); }
    assert.equal(existsSync(join(root, 'bot.lock')), false);
    const restarted = bootstrapService({ MEMORY_DB: join(root, 'memory.db') });
    restarted.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy QQ host and service host share in-process data ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'service-ownership-'));
  const env = { MEMORY_DB: join(root, 'memory.db'), LLM_ENABLED: 'false' };
  const legacy = bootstrapAgent(env);
  try {
    assert.throws(() => bootstrapService(env), /already active/);
  } finally { legacy.close(); }
  const service = bootstrapService(env);
  try {
    assert.throws(() => bootstrapAgent(env), /already active/);
  } finally { service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('service validates its own configuration before acquiring resources', () => {
  assert.throws(() => readServiceConfig({ MAX_INFLIGHT: '1.5' }), /MAX_INFLIGHT/);
  assert.throws(() => readServiceConfig({ MEMORY_TURNS: '0' }), /MEMORY_TURNS/);
  assert.throws(() => readServiceConfig({ LLM_ENABLED: 'true' }), /DEEPSEEK_API_KEY/);
  const config = readServiceConfig({ MAX_INFLIGHT: '', MEMORY_TURNS: '50' });
  assert.equal(config.maxInflight, 3);
  assert.equal(config.memoryTurns, 50);
});
