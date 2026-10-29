import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sseData } from '@companion/contracts/sse';
const headers = { 'Content-Type': 'text/event-stream' };
async function collect(stream: AsyncIterable<string>) { const values: string[] = []; for await (const value of stream) values.push(value); return values; }
test('SSE framing handles split UTF-8, CRLF, comments, multiline data and empty data events', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: output\r\ndata: 中文🐳\r\ndata: second\r\n\r\ndata\n\n');
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers });
  assert.deepEqual(await collect(sseData(response)), ['中文🐳\nsecond', '']);
});
test('SSE framing rejects oversized, truncated and invalid UTF-8 events and releases invalid responses', async () => {
  for (const body of ['data: oversize\n\n', 'data: x\n', 'data: x', ': unfinished']) {
    await assert.rejects(collect(sseData(new Response(body, { headers }), undefined, body.includes('oversize') ? 5 : 100)));
  }
  await assert.rejects(collect(sseData(new Response(Uint8Array.of(255), { headers }))));
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(collect(sseData(response)), /Invalid event stream/); assert.equal(cancelled, true);
});
test('stopping an SSE consumer cancels the underlying stalled response', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); }, cancel() { cancelled = true; } }), { headers });
  const iterator = sseData(response); assert.equal((await iterator.next()).value, 'first');
  await iterator.return(undefined); assert.equal(cancelled, true); assert.equal(response.body?.locked, false);
});
