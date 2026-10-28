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
test('optional memory and personality prepare scoped context before model execution', async () => {
  const { ServiceStore } = await import('../../runtime/service/store.js');
  const { ServiceMemory } = await import('../../runtime/service/memory.js');
  const store = new ServiceStore(':memory:'); const memory = new ServiceMemory(store);
  try {
    const source = store.createConversation('letters-owner', 'Source'), target = store.createConversation('letters-owner', 'Target');
    const run = store.accept('letters-owner', source.id, 'source', '考试安排在周五');
    store.start('letters-owner', run.runId); store.finish('letters-owner', run.runId, 'assistant speculation', null, 'never recall reasoning');
    memory.setSources('letters-owner', target.id, [source.id]);
    let guard = () => true;
    const reply = createConsoleReply('test', 'test', 9, false, async (_url, options) => {
      const body = JSON.parse(String(options?.body)); const context = JSON.parse(body.messages[1].content);
      assert.equal(context.memory.status, 'available');
      assert.equal(context.memory.records[0].quote, '考试安排在周五');
      assert.equal(context.memory.records[0].source.messageId, run.messageId);
      assert.doesNotMatch(JSON.stringify(body.messages), /assistant speculation|never recall reasoning|DeepSeek 小鲸鱼/);
      assert.equal(context.personality.status, 'disabled');
      return Response.json({ choices: [{ message: { content: '根据你之前的说法，考试在周五。' } }] });
    }, undefined, { memory });
    assert.match(await reply('考试安排', [], new AbortController().signal, undefined, {
      scope: memory.scope('letters-owner', target.id), onMemoryGuard: value => { guard = value; },
    }), /周五/);
    assert.equal(guard(), true); memory.setSources('letters-owner', target.id, []); assert.equal(guard(), false);
  } finally { store.close(); }
});
test('revoking memory during a model wait blocks the answer and subsequent tool calls', async () => {
  let current = true, resolve!: (value: Response) => void; let started!: () => void; let calls = 0;
  const ready = new Promise<void>(r => { started = r; });
  const reply = createConsoleReply('test', 'test', 9, false, async () => { calls++; started(); return new Promise(r => { resolve = r; }); }, undefined,
    { memory: { recall: async () => ({ records: [], isCurrent: () => current }) } });
  const pending = reply('question', [], new AbortController().signal, undefined, {
    scope: { ownerId: 'owner', participantId: 'owner', participantIds: ['owner'], conversationId: 'c', channelId: 'console', kind: 'direct', memorySourceConversationIds: [] }, onMemoryGuard: () => {},
  });
  await ready; current = false;
  resolve(Response.json({ choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'roll_dice', arguments: '{}' } }] } }] }));
  await assert.rejects(pending, /Memory context changed/); assert.equal(calls, 1);
});
