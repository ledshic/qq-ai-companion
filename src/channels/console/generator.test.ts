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
test('workbench adapter translates async search, citations and reasoning without leaking reasoning into history', async () => {
  let completions = 0;
  const reply = createConsoleReply('test', 'test-model', 9, true, async (url, options) => {
    if (String(url).endsWith('/tools/search')) return Response.json({ results: [{ title: 'Evidence', url: 'https://example.com/source', summary: 'verified snippet' }] });
    const body = JSON.parse(String(options?.body));
    completions++;
    if (completions === 1) return Response.json({ choices: [{ message: { content: null, reasoning_content: 'tool planning', tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"test"}' } }] } }] });
    assert.equal(body.messages.at(-1).tool_call_id, 'search-1');
    assert.equal(body.messages.at(-2).reasoning_content, 'tool planning');
    assert.match(body.messages.at(-1).content, /verified snippet/);
    return Response.json({ choices: [{ message: { content: 'answer', reasoning_content: 'final thought' } }] });
  });
  let reasoning = '';
  assert.equal(await reply('question', [], new AbortController().signal, text => { reasoning = text; }), 'answer\n来源：Evidence https://example.com/source');
  assert.equal(reasoning, 'final thought');
});
for (const mode of ['empty', 'failed']) test(`search ${mode} stays explainable`, async () => {
  let completions = 0;
  const reply = createConsoleReply('test', 'test-model', 9, true, async (url) => {
    if (String(url).endsWith('/tools/search')) return mode === 'empty' ? Response.json({ results: [] }) : new Response('', { status: 503 });
    return Response.json({ choices: [{ message: ++completions === 1
      ? { tool_calls: [{ id: '1', function: { name: 'web_search', arguments: '{"query":"test"}' } }] }
      : { content: 'unsupported assertion' } }] });
  });
  assert.match(await reply('search', [], new AbortController().signal), mode === 'empty' ? /没有找到结果/ : /联网搜索失败/);
});
