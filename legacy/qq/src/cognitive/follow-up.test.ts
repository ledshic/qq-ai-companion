import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFollowUpJudge } from './follow-up.js';

test('judge sends only approved text/history and validates a structured decision', async () => {
  const history = [{ role: 'user' as const, content: '聊聊咖啡' }, { role: 'assistant' as const, content: '你喜欢什么口味？' }];
  const judge = createFollowUpJudge('test-key', undefined, async (_url, options) => {
    const body = JSON.parse(options?.body as string);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(JSON.parse(body.messages[1].content), { history, followUp: '拿铁' });
    assert.equal(body.messages.length, 2);
    assert.ok(options?.signal);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ intent: 'continue' as const, shouldRespond: true, reason: '回答问题\n可以接续' }) } }] });
  });
  assert.deepEqual(await judge('拿铁', history), { intent: 'continue' as const, shouldRespond: true, reason: '回答问题 可以接续' });
});

test('bad service and malformed decisions fail closed', async () => {
  for (const result of ['not json', '{}', '{"shouldRespond":"true","reason":"bad"}', '{"shouldRespond":true,"reason":""}']) {
    const judge = createFollowUpJudge('key', undefined, async () => Response.json({ choices: [{ message: { content: result } }] }));
    await assert.rejects(judge('text', []));
  }
  await assert.rejects(createFollowUpJudge('key', undefined, async () => new Response('', { status: 500 }))('text', []));
});

test('pause and end remain distinct and inconsistent flags are rejected', async () => {
  for (const intent of ['pause', 'end', 'uncertain'] as const) {
    const judge = createFollowUpJudge('key', undefined, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ intent, shouldRespond: false, reason: '分类依据' }) } }] }));
    assert.equal((await judge('message', [])).intent, intent);
  }
  const inconsistent = createFollowUpJudge('key', undefined, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ intent: 'pause', shouldRespond: true, reason: 'bad' }) } }] }));
  await assert.rejects(inconsistent('message', []));
});
