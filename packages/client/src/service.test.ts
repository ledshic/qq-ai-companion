import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceClient, serviceURL } from './service.js';
test('formal SDK rejects mock responses and insecure nonlocal service endpoints', async () => {
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com?token=x',
  ])
    assert.throws(() => serviceURL(url));
  assert.equal(
    serviceURL('https://agent.example.com'),
    'https://agent.example.com',
  );
  const client = createServiceClient('http://localhost', {
    request: async () =>
      Response.json({ apiVersion: 'v1', environment: 'phase-a' }),
  });
  await assert.rejects(client.status(), /compatible/);
});
test('safe GET retries once; message submission never silently retries', async () => {
  let requests = 0;
  const client = createServiceClient('http://localhost', {
    request: async () => {
      requests++;
      if (requests === 1) throw Error('connection reset');
      return Response.json({
        apiVersion: 'v1',
        environment: 'service',
        accepting: true,
        model: 'not-configured',
        qq: 'disabled',
      });
    },
  });
  assert.equal((await client.status()).qq, 'disabled');
  assert.equal(requests, 2);
  requests = 0;
  const unavailable = createServiceClient('http://localhost', {
    request: async () => {
      requests++;
      throw Error('connection reset');
    },
  });
  await assert.rejects(
    unavailable.submit('conversation', 'stable-message-id', 'question'),
  );
  assert.equal(requests, 1);
});
test('run and event payloads are checked before entering client state', async () => {
  const client = createServiceClient('http://localhost', {
    request: async () =>
      Response.json({
        state: 'invented',
        events: [{ eventId: 1, type: 'invented' }],
        nextCursor: 1,
      }),
  });
  await assert.rejects(client.run('run-id'), /Invalid run/);
  await assert.rejects(client.events(), /Invalid service event/);
});
test('source updates carry an optional revision and never silently retry writes', async () => {
  const bodies: unknown[] = [];
  const client = createServiceClient('http://localhost', { request: async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return Response.json({ sourceConversationIds: [], revision: 3 });
  } });
  await client.setMemorySources('target', ['source'], 2);
  await client.setMemorySources('target', []);
  assert.deepEqual(bodies, [{ sourceConversationIds: ['source'], expectedRevision: 2 }, { sourceConversationIds: [] }]);
  let calls = 0;
  const unavailable = createServiceClient('http://localhost', { request: async () => { calls++; throw Error('connection reset'); } });
  await assert.rejects(unavailable.setMemorySources('target', [], 2));
  assert.equal(calls, 1);
});
test('run output parser rejects malformed snapshots and premature EOF, cancellation cleans up readers', async () => {
  const now = '2026-10-29T00:00:00Z';
  const run = { id: 'run', conversationId: 'conversation', clientMessageId: 'message', state: 'running', input: 'question', result: null, error: null, createdAt: now, updatedAt: now };
  for (const data of [{ run, text: 5, sequence: 1 }, { run, text: 'partial', sequence: -1 }, { run: { ...run, state: 'completed' }, text: 'partial', sequence: 1 }]) {
    const client = createServiceClient('http://localhost', { request: async () => Response.json(data) });
    await assert.rejects(client.output('run'), /Invalid|Draft/);
  }
  const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`);
  const client = createServiceClient('http://localhost', { request: async () => new Response(new ReadableStream({ start(controller) {
    const bytes = frame({ run, text: '中文😀', sequence: 1 }); for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  const stream = client.watchRun('run'); assert.equal((await stream.next()).value?.text, '中文😀');
  await assert.rejects(stream.next(), /before terminal/);
  let cancelled = false;
  const stalled = createServiceClient('http://localhost', { request: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  const abort = new AbortController(), pending = stalled.watchRun('run', abort.signal).next();
  await new Promise(resolve => setImmediate(resolve)); abort.abort(); await assert.rejects(pending); assert.equal(cancelled, true);
});
test('task SDK encodes bounded queries and validates metadata-only pages and cursors', async () => {
  const run = { id: 'run', conversationId: 'conversation', conversationTitle: 'Title', state: 'running', error: null, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z' };
  let url = '';
  const client = createServiceClient('http://localhost', { request: async input => { url = String(input); return Response.json({ runs: [run], nextCursor: 'run' }); } });
  const page = await client.runs({ status: 'active', limit: 20, before: 'before&ownerId=other' });
  assert.equal(page.runs[0]?.id, 'run'); const parsed = new URL(url); assert.equal(parsed.pathname, '/api/v1/runs');
  assert.deepEqual([...parsed.searchParams], [['status', 'active'], ['before', 'before&ownerId=other'], ['limit', '20']]);
  for (const body of [{ runs: [{ ...run, state: 'invented' }], nextCursor: null }, { runs: [{ ...run, input: 'secret' }], nextCursor: null },
    { runs: [run, run], nextCursor: null }, { runs: [run], nextCursor: 'different' }, { runs: [], nextCursor: 'run' }, { runs: [{ ...run, updatedAt: 'bad-time' }], nextCursor: null }]) {
    const invalid = createServiceClient('http://localhost', { request: async () => Response.json(body) }); await assert.rejects(invalid.runs(), /Invalid run/);
  }
});
test('task SDK carries conversation filters and rejects a response outside the selected scope', async () => {
  const run = { id: 'run', conversationId: 'selected', conversationTitle: 'Title', state: 'running', error: null, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z' };
  let url = '';
  const client = createServiceClient('http://localhost', { request: async input => { url = String(input); return Response.json({ runs: [run], nextCursor: null }); } });
  assert.equal((await client.runs({ conversationId: 'selected', status: 'active', before: 'cursor', limit: 1 })).runs[0]?.id, 'run');
  const query = new URL(url).searchParams; assert.equal(query.get('conversationId'), 'selected'); assert.equal(query.get('before'), 'cursor');
  await assert.rejects(client.runs({ conversationId: 'other&ownerId=foreign' }), /conversation mismatch/);
  assert.equal(new URL(url).searchParams.get('conversationId'), 'other&ownerId=foreign'); assert.equal(new URL(url).searchParams.has('ownerId'), false);
  let reply!: (response: Response) => void;
  const deferred = createServiceClient('http://localhost', { request: () => new Promise(resolve => { reply = resolve; }) });
  const options = { conversationId: 'selected' }, pending = deferred.runs(options);
  options.conversationId = 'changed-after-request'; reply(Response.json({ runs: [run], nextCursor: null }));
  assert.equal((await pending).runs[0]?.conversationId, 'selected');
});
test('task SDK validates each exact status, active membership and the request-time status snapshot', async () => {
  const base = { id: 'run', conversationId: 'conversation', conversationTitle: 'Title', error: null, createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z' };
  const states = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
  for (const state of states) {
    let url = ''; const client = createServiceClient('http://localhost', { request: async input => { url = String(input); return Response.json({ runs: [{ ...base, state }], nextCursor: null }); } });
    assert.equal((await client.runs({ status: state })).runs[0]?.state, state); assert.equal(new URL(url).searchParams.get('status'), state);
    const wrong = state === 'failed' ? 'running' : 'failed'; await assert.rejects(client.runs({ status: wrong }), /status mismatch/);
    if (!['running', 'queued'].includes(state)) await assert.rejects(client.runs({ status: 'active' }), /status mismatch/);
    assert.equal((await client.runs({ status: 'all' })).runs.length, 1);
  }
  let reply!: (response: Response) => void;
  const deferred = createServiceClient('http://localhost', { request: () => new Promise(resolve => { reply = resolve; }) });
  const options: { status: 'running' | 'failed' } = { status: 'running' }, pending = deferred.runs(options);
  options.status = 'failed'; reply(Response.json({ runs: [{ ...base, state: 'running' }], nextCursor: null }));
  assert.equal((await pending).runs[0]?.state, 'running');
});
