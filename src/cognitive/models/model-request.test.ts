import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestChatCompletion, completionMessage, completionText } from './model-request.js';

const payload = { model: 'test-model', stream: false, max_tokens: 123,
  messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function' }], tool_choice: 'auto' };

const abortingRequest: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
  const signal = init!.signal!;
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('model transport preserves payload, credentials and raw tool-call envelope', async () => {
  const message = { content: null, tool_calls: [{ id: 'call-1', function: { name: 'roll_dice', arguments: '{}' } }] };
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    assert.ok(init?.signal);
    return Response.json({ choices: [{ message }] });
  };
  const raw = await requestChatCompletion('test-key', payload, { request, timeoutMs: 1000, httpError: 'http' });
  assert.deepEqual(completionMessage(raw, 'format'), message);
  assert.throws(() => completionText(raw, 'text required'), /^Error: text required$/);
  assert.equal(calls, 1);
});

for (const cancelErrorBody of [true, false]) {
  test(`HTTP failures retain body cleanup policy (${cancelErrorBody}) and do not retry`, async () => {
    let calls = 0, cancelled = 0;
    const request: typeof fetch = async () => {
      calls++;
      return new Response(new ReadableStream({ cancel: () => { cancelled++; } }), { status: 429 });
    };
    await assert.rejects(requestChatCompletion('key', payload, {
      request, timeoutMs: 1000, httpError: status => `provider HTTP ${status}`, cancelErrorBody,
    }), /^Error: provider HTTP 429$/);
    assert.equal(calls, 1);
    assert.equal(cancelled, cancelErrorBody ? 1 : 0);
  });
}

test('network and invalid JSON errors propagate without retries', async () => {
  for (const mode of ['network', 'json']) {
    let calls = 0;
    const failure = new Error('network unavailable');
    const request: typeof fetch = async () => {
      calls++;
      if (mode === 'network') throw failure;
      return new Response('invalid JSON');
    };
    await assert.rejects(requestChatCompletion('key', payload, { request, timeoutMs: 1000, httpError: 'http' }),
      error => mode === 'network' ? error === failure : error instanceof SyntaxError);
    assert.equal(calls, 1);
  }
});

test('parent cancellation propagates the original reason', async () => {
  const controller = new AbortController();
  const reason = new Error('superseded');
  const pending = requestChatCompletion('key', payload, {
    request: abortingRequest, signal: controller.signal, timeoutMs: 1000, httpError: 'http',
  });
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
});

test('each request uses its supplied timeout budget', async () => {
  // AbortSignal.timeout uses an unref timer, so keep this test alive explicitly.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(requestChatCompletion('key', payload, {
      request: abortingRequest, timeoutMs: 5, httpError: 'http',
    }), { name: 'TimeoutError' });
  } finally { clearInterval(keepAlive); }
});

test('envelope parsing preserves error distinctions and leaves text validation to callers', () => {
  for (const raw of [null, [], {}, { choices: null }]) {
    assert.throws(() => completionText(raw, 'missing message', 'bad envelope'), /^Error: bad envelope$/);
  }
  for (const raw of [{ choices: [] }, { choices: [null] }, { choices: [{ message: [] }] },
    { choices: [{ message: { content: 1 } }] }]) {
    assert.throws(() => completionText(raw, 'missing message', 'bad envelope'), /^Error: missing message$/);
  }
  for (const content of ['', '  ', '{invalid JSON']) {
    assert.equal(completionText({ choices: [{ message: { content } }] }, 'format'), content);
  }
});
