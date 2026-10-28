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
    assert.match(body.messages[0].content, /傲娇嘴硬/);
    assert.match(body.messages[0].content, /QQ 群友版/);
    assert.doesNotMatch(body.messages[0].content, /以大肥鱼作为自己的名字/);
    assert.doesNotMatch(body.messages[0].content, /小爱/);
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

test('DeepSeek receives approved history as separate turns before the current text', async () => {
  const history = [{ role: 'user' as const, content: '叫我小林' }, { role: 'assistant' as const, content: '好的，小林' }];
  const reply = createDeepSeekReply('key', undefined, async (_url, options) => {
    const body = JSON.parse(options?.body as string);
    assert.deepEqual(body.messages.slice(1), [...history, { role: 'user', content: '我叫什么？' }]);
    return Response.json({ choices: [{ message: { content: '小林' } }] });
  });
  assert.equal(await reply('我叫什么？', history), '小林');
});

test('tool calls are executed, fed back to the model and logged', async () => {
  const bodies: any[] = [];
  let round = 0;
  const request: typeof fetch = async (_url, options) => {
    bodies.push(JSON.parse(options?.body as string));
    round++;
    if (round === 1) {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'roll_dice', arguments: '{"count":2,"sides":6}' } },
      ] } }] });
    }
    return Response.json({ choices: [{ message: { content: '是 8 点' } }] });
  };
  const logs: string[] = [];
  const reply = createDeepSeekReply('key', undefined, request, { log: line => logs.push(line) });
  assert.equal(await reply('掷两个骰子', []), '是 8 点');
  assert.equal(bodies.length, 2);
  assert.ok(Array.isArray(bodies[0].tools));
  assert.equal(bodies[0].tool_choice, 'auto');
  const followUp = bodies[1].messages.at(-2);
  assert.equal(followUp.role, 'assistant');
  assert.equal(bodies[1].messages.at(-1).role, 'tool');
  assert.match(bodies[1].messages.at(-1).content, /^2d6 = /);
  assert.ok(logs.some(line => line.includes('[工具] roll_dice')));
});

test('tools are omitted when the caller disables them', async () => {
  const bodies: any[] = [];
  const request: typeof fetch = async (_url, options) => {
    bodies.push(JSON.parse(options?.body as string));
    return Response.json({ choices: [{ message: { content: '好' } }] });
  };
  const reply = createDeepSeekReply('key', undefined, request, { log: () => {} });
  assert.equal(await reply('你好', [], undefined, false), '好');
  assert.equal(bodies[0].tools, undefined);
});

test('a model that keeps calling tools is cut off after three rounds', async () => {
  const bodies: any[] = [];
  const request: typeof fetch = async (_url, options) => {
    bodies.push(JSON.parse(options?.body as string));
    return Response.json({ choices: [{ message: { content: null, tool_calls: [
      { id: `call_${bodies.length}`, type: 'function', function: { name: 'roll_dice', arguments: '{}' } },
    ] } }] });
  };
  const reply = createDeepSeekReply('key', undefined, request, { log: () => {} });
  await assert.rejects(reply('一直掷骰子', []), /轮次超限/);
  assert.equal(bodies.length, 4);
  assert.ok(bodies[3].tools === undefined);
});


test('bare mention asks for a short contextual acknowledgement without tools or invented user content', async () => {
  const reply = createDeepSeekReply('key', undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.tools, undefined);
    assert.match(body.messages.at(-1).content, /只有 @/);
    assert.match(body.messages.at(-1).content, /避免重复/);
    assert.equal(body.messages.at(-2).content, '之前已经应声过');
    return Response.json({ choices: [{ message: { content: '叫我干嘛' } }] });
  }, { searchEnabled: true });
  const context = { kind: 'explicit' as const, targetSenderId: 'a', triggerIds: ['m1'],
    snapshot: { chatId: 'g', version: 1, incomingVersion: 1, capturedAt: 0, messages: [] } };
  assert.equal(await reply('', [{ role: 'assistant', content: '之前已经应声过' }], undefined, false, context), '叫我干嘛');
});


test('a repeated short reply gets one model rephrase, never an unbounded retry', async () => {
  for (const replacement of ['换个自然说法', '嗯，什么事']) {
    let calls = 0;
    const reply = createDeepSeekReply('key', undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls++;
      if (calls === 2) assert.match(body.messages.at(-1).content, /近期回复重复/);
      return Response.json({ choices: [{ message: { content: calls === 1 ? '嗯？什么事' : replacement } }] });
    });
    assert.equal(await reply('你好', [{ role: 'assistant', content: '嗯，什么事' }], undefined, false), replacement);
    assert.equal(calls, 2);
  }
});

test('returns optional provider reasoning separately from the answer', async () => {
  const reasoning: string[] = [];
  const reply = createDeepSeekReply('key', undefined, async () => Response.json({ choices: [{ message: { content: '结果', reasoning_content: '先分析问题' } }] }));
  assert.equal(await reply('问题', [], undefined, true, undefined, text => reasoning.push(text)), '结果');
  assert.deepEqual(reasoning, ['先分析问题']);
  const plain = createDeepSeekReply('key', undefined, async () => Response.json({ choices: [{ message: { content: '普通回答' } }] }));
  assert.equal(await plain('问题', [], undefined, true, undefined, text => reasoning.push(text)), '普通回答');
  assert.deepEqual(reasoning, ['先分析问题']);
});
