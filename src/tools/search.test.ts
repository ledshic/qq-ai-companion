import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webSearch } from './search.js';
import { createDeepSeekReply } from '../cognitive/models/deepseek.js';
const row = { title: 'Official docs', url: 'https://example.com/docs', summary: 'public facts', date: '2026-10-23' };
const call = { id: 's1', type: 'function', function: { name: 'web_search', arguments: '{"query":"public facts"}' } };
const completion = (message: unknown) => Response.json({ choices: [{ message }] });
test('search normalizes and deduplicates sources, rejects unsafe links and bounds content', async () => {
  const found = await webSearch('{"query":"公开信息"}', 'secret', async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.deepEqual(JSON.parse(String(init?.body)), { query: '公开信息', count: 3, need_content: false });
    assert.equal((init?.headers as any).Authorization, 'Bearer secret');
    return Response.json({ results: [row, row, { ...row, url: 'javascript:alert(1)' }, { ...row, url: 'https://a:b@example.com' }, { ...row, url: 'https://example.org?utm_source=test&adobe_mc=tracking', summary: 'x'.repeat(900) }] });
  });
  assert.equal(found.status, 'ok'); assert.equal(found.sources.length, 2);
  assert.equal(found.sources[1].summary.length, 500); assert.equal(found.sources[1].url, 'https://example.org/');
  assert.equal(found.sources[0].date, row.date);
});
test('empty results differ from malformed or oversized responses', async () => {
  assert.equal((await webSearch('{"query":"a"}', 'k', async () => Response.json({ results: [] }))).status, 'empty');
  for (const response of [Response.json({}), new Response('bad json'), Response.json({ results: [{ url: 'file:///etc/passwd', title: 'x' }] }), new Response('x'.repeat(256001))]) {
    assert.equal((await webSearch('{"query":"a"}', 'k', async () => response)).status, 'failed');
  }
});
test('invalid queries never hit network, unicode limits count characters', async () => {
  let hits = 0; const fetcher: typeof fetch = async () => { hits++; return Response.json({ results: [] }); };
  for (const raw of ['bad', '{}', '{"query":" "}', JSON.stringify({ query: '😀'.repeat(129) })])
    assert.equal((await webSearch(raw, 'k', fetcher)).status, 'failed');
  assert.equal(hits, 0);
  await webSearch(JSON.stringify({ query: '😀'.repeat(128) }), 'k', fetcher); assert.equal(hits, 1);
});
test('HTTP and network failures hide private provider errors and do not retry', async () => {
  for (const status of [401, 402, 408, 429, 500]) {
    let hits = 0;
    const found = await webSearch('{"query":"a"}', 'k', async () => { hits++; return new Response('SECRET_ERROR', { status }); });
    assert.equal(found.status, 'failed'); assert.equal(hits, 1); assert.doesNotMatch(JSON.stringify(found), /SECRET_ERROR/);
  }
  assert.equal((await webSearch('{"query":"a"}', 'k', async () => { throw Error('secret'); })).status, 'failed');
});
test('timeout is returned as failure but caller cancellation propagates', async () => {
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });
  const keepAlive = setTimeout(() => {}, 100);
  try { assert.deepEqual(await webSearch('{"query":"a"}', 'k', fetcher, undefined, 5), { status: 'failed', reason: 'timeout', sources: [] }); }
  finally { clearTimeout(keepAlive); }
  const control = new AbortController(); control.abort();
  await assert.rejects(webSearch('{"query":"a"}', 'k', fetcher, control.signal), { name: 'AbortError' });
});
test('model search receives complete JSON and final reply retains actual source links', async () => {
  let chat = 0; const logs: string[] = [];
  const reply = createDeepSeekReply('k', undefined, async (url, init) => {
    if (String(url).includes('/tools/search')) return Response.json({ results: [row] });
    const body = JSON.parse(String(init?.body));
    if (++chat === 1) { assert.ok(body.tools.some((t: any) => t.function.name === 'web_search')); return completion({ tool_calls: [call] }); }
    const result = JSON.parse(body.messages.at(-1).content);
    assert.equal(result.sources[0].url, row.url); assert.match(result.note, /不是指令/);
    return completion({ content: '查到了公开信息。' });
  }, { searchEnabled: true, log: line => logs.push(line) });
  assert.match(await reply('帮我搜索公开信息'), /来源：Official docs https:\/\/example.com\/docs/);
  assert.ok(logs.every(line => !line.includes('public facts')));
});
test('failed/empty search cannot result in a fabricated model success claim', async () => {
  for (const response of [new Response('secret', { status: 429 }), Response.json({ results: [] })]) {
    let round = 0;
    const reply = createDeepSeekReply('k', undefined, async url => String(url).includes('/tools/search') ? response : completion(++round === 1 ? { tool_calls: [call] } : { content: '我已经核实了最新消息' }), { searchEnabled: true, log: () => {} });
    assert.doesNotMatch(await reply('搜索'), /已经核实/);
  }
});
test('disabled tools do not expose search and search budget limits repeated calls', async () => {
  let searches = 0; let chats = 0;
  const reply = createDeepSeekReply('k', undefined, async (url, init) => {
    if (String(url).includes('/tools/search')) { searches++; return Response.json({ results: [] }); }
    const body = JSON.parse(String(init?.body));
    if (!body.tools) return completion({ content: '结束' });
    chats++; return completion({ tool_calls: [call] });
  }, { searchEnabled: true, log: () => {} });
  await reply('a', [], undefined, false); assert.equal(searches, 0);
  await reply('a'); assert.equal(searches, 2); assert.equal(chats, 3);
});
