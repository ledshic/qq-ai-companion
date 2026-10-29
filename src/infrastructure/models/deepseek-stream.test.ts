import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekModel } from './deepseek-adapter.js';
const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function response(text: string, bytewise = false) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
test('provider emits real UTF-8 deltas before completion across arbitrary byte and CRLF boundaries', async () => {
  let finish!: () => void; const seen: string[] = [];
  const model = createDeepSeekModel('fixture', 'test', async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream({ start(controller) {
      const first = new TextEncoder().encode(chunk({ content: '你好😀' }));
      for (const byte of first) controller.enqueue(Uint8Array.of(byte));
      finish = () => { controller.enqueue(new TextEncoder().encode(chunk({ content: '世界', reasoning_content: 'separate' }, 'stop') + 'data: [DONE]\n\n')); controller.close(); };
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  let settled = false;
  const pending = model.complete([], [], new AbortController().signal, text => seen.push(text)).then(reply => { settled = true; return reply; });
  for (let i = 0; i < 20 && !seen.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ['你好😀']); assert.equal(settled, false);
  finish(); const result = await pending; assert.equal(result.text, '你好😀世界'); assert.equal(result.reasoning, 'separate');
});
test('tool indexes, ids, names and arguments are assembled without executing partial calls', async () => {
  const model = createDeepSeekModel('fixture', 'test', async () => response(
    chunk({ tool_calls: [{ index: 1, id: 'second', function: { name: 'async_', arguments: '{"x":' } }, { index: 0, id: 'first', function: { name: 'roll_dice', arguments: '{}' } }] }) +
    chunk({ tool_calls: [{ index: 1, function: { name: 'tool', arguments: '2}' } }] }, 'tool_calls') + 'data: [DONE]\n\n', true));
  const reply = await model.complete([], [], new AbortController().signal, () => {});
  assert.deepEqual(reply.calls, [{ id: 'first', name: 'roll_dice', arguments: '{}' }, { id: 'second', name: 'async_tool', arguments: '{"x":2}' }]);
});
test('truncated, incomplete, invalid and over-budget streams never become completed answers', async () => {
  for (const body of [chunk({ content: 'partial' }), chunk({ content: 'partial' }, 'length') + 'data: [DONE]\n\n',
    'data: {bad}\n\n', chunk({ content: 'x'.repeat(64001) }, 'stop') + 'data: [DONE]\n\n',
    chunk({ tool_calls: [{ index: 9, id: 'bad', function: { name: 'tool', arguments: '{}' } }] }, 'tool_calls') + 'data: [DONE]\n\n']) {
    const model = createDeepSeekModel('fixture', 'test', async () => response(body));
    await assert.rejects(model.complete([], [], new AbortController().signal, () => {}));
  }
});
test('caller cancellation interrupts a stalled stream and cancels its reader', async () => {
  let cancelled = false; const controller = new AbortController();
  const model = createDeepSeekModel('fixture', 'test', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const pending = model.complete([], [], controller.signal, () => {});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending); assert.equal(cancelled, true);
});
