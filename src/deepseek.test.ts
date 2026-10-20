import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeepSeekReply } from './deepseek.js';

test('DeepSeek request sends only the supplied text and reads assistant content', async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(options?.body as string);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.messages.length, 2);
    assert.deepEqual(body.messages[1], { role: 'user', content: '你好' });
    assert.equal(body.max_tokens, 512);
    assert.ok(options?.signal);
    return Response.json({ choices: [{ message: { content: '  你好呀！  ' } }] });
  };
  assert.equal(await createDeepSeekReply('test-key', undefined, request)('你好'), '你好呀！');
});

test('missing key, service failure and empty answers are rejected', async () => {
  assert.throws(() => createDeepSeekReply(' '));
  await assert.rejects(createDeepSeekReply('key', undefined, async () => new Response('private details', { status: 401 }))('hi'), /^Error: DeepSeek HTTP 401$/);
  await assert.rejects(createDeepSeekReply('key', undefined, async () => Response.json({ choices: [] }))('hi'));
});
