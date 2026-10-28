import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from './agent-tools.js';
const context = () => ({ signal: new AbortController().signal });
test('search budget and source state belong to one execution, and disabled search is absent', async () => {
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return Response.json({ results: [{ title: 'Evidence', url: 'https://example.com/evidence', summary: 'facts' }] });
  };
  assert(!createAgentTools('fixture', false, request).tools.some(tool => tool.name === 'web_search'));
  const first = createAgentTools('fixture', true, request);
  const search = first.tools.find(tool => tool.name === 'web_search')!;
  for (let i = 0; i < 3; i++) await search.execute({ query: 'facts' }, context());
  assert.equal(requests, 2); assert.match(first.decorate('answer'), /来源：Evidence/);
  assert.match(first.decorate('answer'), /部分搜索失败/);
  const second = createAgentTools('fixture', true, request);
  assert.equal(second.decorate('answer'), 'answer');
  await second.tools.find(tool => tool.name === 'web_search')!.execute({ query: 'facts' }, context());
  assert.equal(requests, 3);
});
test('large source sets stay valid JSON within the executor result budget', async () => {
  const capability = createAgentTools('fixture', true, async () => Response.json({ results: Array.from({ length: 3 }, (_, n) => ({
    title: 't'.repeat(100), url: 'https://example.com/' + n + 'x'.repeat(450), summary: 's'.repeat(500),
  })) }));
  const text = await capability.tools.find(tool => tool.name === 'web_search')!.execute({ query: 'facts' }, context());
  assert(text.length <= 1900);
  const result = JSON.parse(text); assert(result.sources.length > 0); assert(result.sources.length < 3);
  for (const source of result.sources) assert(capability.decorate('answer').includes(source.url));
});
