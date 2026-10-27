import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleReply } from './generator.js';
test('console generator preserves identity without QQ environment or inferred private memory', async () => {
  const reply = createConsoleReply(
    'test-key',
    'test-model',
    9,
    false,
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      const prompt = body.messages[0].content;
      assert.match(prompt, /DeepSeek 小鲸鱼/);
      assert.match(prompt, /在线工作台/);
      assert.doesNotMatch(prompt, /QQ 群友版|你在群聊与私聊|longTermMemory/);
      assert.deepEqual(body.messages.slice(1), [
        { role: 'user', content: 'current history' },
        { role: 'assistant', content: 'committed reply' },
        { role: 'user', content: 'new question' },
      ]);
      assert(
        !body.tools.some(
          (tool: { function: { name: string } }) =>
            tool.function.name === 'web_search',
        ),
      );
      return Response.json({
        choices: [{ message: { content: 'direct answer' } }],
      });
    },
  );
  assert.equal(
    await reply(
      'new question',
      [
        { role: 'user', content: 'current history' },
        { role: 'assistant', content: 'committed reply' },
      ],
      new AbortController().signal,
    ),
    'direct answer',
  );
});
