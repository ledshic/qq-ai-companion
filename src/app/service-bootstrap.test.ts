import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapService } from './service-bootstrap.js';
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
      assert.equal(typeof host.createGenerator(), 'function');
      assert.deepEqual(readdirSync(root), ['bot.lock']);
      assert.throws(() => bootstrapService({ MEMORY_DB: join(root, 'memory.db') }), /already active/);
    } finally { host.close(); host.close(); }
    assert.equal(existsSync(join(root, 'bot.lock')), false);
    const restarted = bootstrapService({ MEMORY_DB: join(root, 'memory.db') });
    restarted.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('service validates its own configuration before acquiring resources', () => {
  assert.throws(() => readServiceConfig({ MAX_INFLIGHT: '1.5' }), /MAX_INFLIGHT/);
  assert.throws(() => readServiceConfig({ MEMORY_TURNS: '0' }), /MEMORY_TURNS/);
  assert.throws(() => readServiceConfig({ LLM_ENABLED: 'true' }), /DEEPSEEK_API_KEY/);
  const config = readServiceConfig({ MAX_INFLIGHT: '', MEMORY_TURNS: '50' });
  assert.equal(config.maxInflight, 3);
  assert.equal(config.memoryTurns, 50);
});
test('service capability config is independent of legacy settings and validates explicit modes', () => {
  assert.equal(readServiceConfig({}).memoryEnabled, false);
  assert.equal(readServiceConfig({}).persona, 'whale');
  assert.equal(readServiceConfig({ AGENT_MEMORY_ENABLED: 'true', AGENT_PERSONA: 'none', EVENT_MEMORY_MODE: 'invalid', PERSONALITY_MODE: 'invalid' }).memoryEnabled, true);
  assert.equal(readServiceConfig({ AGENT_PERSONA: 'none' }).persona, 'none');
  assert.throws(() => readServiceConfig({ AGENT_PERSONA: 'invalid' }), /AGENT_PERSONA/);
  assert.throws(() => readServiceConfig({ AGENT_MEMORY_ENABLED: 'yes' }), /AGENT_MEMORY_ENABLED/);
});
test('service composition gates recall with its own config and can disable expression without changing tools', async t => {
  let enabled = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    assert.doesNotMatch(body.messages[0].content, /DeepSeek 小鲸鱼/);
    const prepared = JSON.parse(body.messages[1].content);
    assert.equal(prepared.memory.status, enabled ? 'empty' : 'disabled');
    assert.equal(prepared.personality.status, 'disabled');
    assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ['get_current_time', 'roll_dice']);
    return Response.json({ choices: [{ message: { content: 'answer' } }] });
  });
  const root = mkdtempSync(join(tmpdir(), 'capability-bootstrap-'));
  let recalls = 0;
  try {
    for (enabled of [false, true]) {
      const host = bootstrapService({ MEMORY_DB: join(root, 'memory.db'), LLM_ENABLED: 'true', DEEPSEEK_API_KEY: 'fixture',
        AGENT_MEMORY_ENABLED: String(enabled), AGENT_PERSONA: 'none' });
      try {
        const generate = host.createGenerator({ recall: async () => { recalls++; return { records: [], isCurrent: () => true }; } });
        assert(generate);
        assert.equal(await generate('question', [], new AbortController().signal, undefined, {
          scope: { ownerId: 'letters', conversationId: 'opaque', participantId: 'letters', participantIds: ['letters'], channelId: 'console', kind: 'direct', memorySourceConversationIds: [] },
          onMemoryGuard: () => {},
        }), 'answer');
      } finally { host.close(); }
    }
    assert.equal(recalls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
