import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeAgent } from './executor.js';
import type { Model, ModelMessage, Tool } from './contracts.js';
const signal = () => new AbortController().signal;
const call = (id = '1', name = 'async_tool', args = '{}') => ({ id, name, arguments: args });
const tool: Tool = { name: 'async_tool', description: 'test', parameters: {}, execute: async () => 'result' };
function sequence(replies: Awaited<ReturnType<Model['complete']>>[], inspect?: (messages: ModelMessage[]) => void): Model {
  return { async complete(messages) { inspect?.(messages); const next = replies.shift(); assert(next); return next; } };
}
test('text and reasoning remain separate and history is not mutated', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  let reasoning = '';
  assert.equal(await executeAgent({ model: sequence([{ text: 'answer', calls: [], reasoning: 'private thought' }]), tools: [], messages, signal: signal(), onReasoning: text => { reasoning = text; } }), 'answer');
  assert.equal(reasoning, 'private thought'); assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
});
test('registered async tools support multiple calls and rounds with bounded results', async () => {
  let count = 0;
  const model = sequence([{ text: '', calls: [call('1'), call('2')] }, { text: '', calls: [call('3')] }, { text: 'done', calls: [] }], messages => {
    for (const message of messages) if (message.role === 'tool') assert.equal(message.content, 'res');
  });
  assert.equal(await executeAgent({ model, tools: [{ ...tool, async execute() { count++; return 'result'; } }], messages: [], signal: signal(), limits: { resultChars: 3 } }), 'done');
  assert.equal(count, 3);
});
test('unknown, failing and malformed tools produce recoverable data', async () => {
  const model = sequence([{ text: '', calls: [call('1', 'unknown'), call('2'), call('3', 'async_tool', '{')] }, { text: 'recovered', calls: [] }], messages => {
    if (messages.length) assert.deepEqual(messages.filter(m => m.role === 'tool').map(m => m.content), ['未知工具：unknown', '工具执行失败或参数无效', '工具执行失败或参数无效']);
  });
  assert.equal(await executeAgent({ model, tools: [{ ...tool, execute() { throw Error('secret'); } }], messages: [], signal: signal() }), 'recovered');
});
test('round and total call budgets prevent additional execution', async () => {
  let invoked = 0;
  const tools = [{ ...tool, execute() { invoked++; return 'ok'; } }];
  await assert.rejects(executeAgent({ model: sequence([{ text: '', calls: [call(), call('2')] }]), tools, messages: [], signal: signal(), limits: { calls: 1 } }), /budget/);
  assert.equal(invoked, 0);
  await assert.rejects(executeAgent({ model: sequence([{ text: '', calls: [call()] }, { text: '', calls: [call('2')] }]), tools, messages: [], signal: signal(), limits: { rounds: 1 } }), /budget/);
  assert.equal(invoked, 1);
});
test('cancellation during model and tool waits stops late reasoning and subsequent tools', async () => {
  for (const duringTool of [false, true]) {
    const controller = new AbortController(); let release!: (value: any) => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const delayed = () => { started(); return new Promise<any>(resolve => { release = resolve; }); };
    let invoked = 0, reasoning = 0;
    const model: Model = duringTool ? sequence([{ text: '', calls: [call(), call('2')] }]) : { complete: delayed };
    const running = executeAgent({ model, tools: [{ ...tool, execute() { invoked++; return delayed(); } }], messages: [], signal: controller.signal, onReasoning() { reasoning++; } });
    await ready; controller.abort(); await assert.rejects(running);
    release(duringTool ? 'late' : { text: 'late', calls: [call()], reasoning: 'late' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(invoked, duringTool ? 1 : 0); assert.equal(reasoning, 0);
  }
});
test('tool timeout settles an uncooperative tool and permits model explanation', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const model = sequence([{ text: '', calls: [call()] }, { text: 'timeout explained', calls: [] }], messages => {
      const result = messages.find(m => m.role === 'tool'); if (result) assert.equal(result.content, '工具执行超时');
    });
    assert.equal(await executeAgent({ model, tools: [{ ...tool, execute: () => new Promise(() => {}) }], messages: [], signal: signal(), limits: { toolTimeoutMs: 5 } }), 'timeout explained');
  } finally { clearTimeout(keepAlive); }
});
test('incremental output is provisional, resets across tool rounds and ignores late callbacks', async () => {
  const output: string[] = []; let late!: (text: string) => void; let rounds = 0;
  const model: Model = { async complete(_messages, _tools, _signal, onDelta) {
    late = onDelta!; rounds++; onDelta?.(rounds === 1 ? 'planning' : 'final');
    return rounds === 1 ? { text: 'planning', calls: [call()] } : { text: 'final', calls: [] };
  } };
  assert.equal(await executeAgent({ model, tools: [tool], messages: [], signal: signal(), onOutput: text => output.push(text) }), 'final');
  assert.deepEqual(output, ['', 'planning', '', '', 'final']);
  late('must not arrive'); assert.equal(output.at(-1), 'final');
});
