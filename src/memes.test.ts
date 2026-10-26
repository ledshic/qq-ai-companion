import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemeManager, JsonMemeState, loadMemeCatalog, memeNote, stripMemeRecords, type MemeStateStore } from './memes.js';
import { describeMeme, parseMemeMeaning, type MemeEntry } from './meme-index.js';
import type { ReplyContext } from './context.js';
const entry: MemeEntry = { id: 'tb_abcdefabcdef', file: '/unused.png', sha256: 'unused', category: 'happy', meaning: '开心庆祝',
  visibleText: '耶', speaker: '自己庆祝', target: '自己', scenes: ['完成一件事'], avoid: ['认真倾诉'], confidence: .9, semanticVersion: 1 };
const context: ReplyContext = { kind: 'explicit', targetSenderId: '12345678', triggerIds: [],
  snapshot: { chatId: '87654321', version: 1, incomingVersion: 1, capturedAt: 0, messages: [] } };
const store = (): MemeStateStore => { let data = {}; return { load: () => structuredClone(data), save: value => { data = structuredClone(value); } }; };
const selected: typeof fetch = async (_url, init) => Response.json({ choices: [{ message: { content: JSON.stringify(JSON.parse(String(init?.body)).messages[0].content.includes('独立复核') ? { match: true } : { id: entry.id }) } }] });
const signal = () => new AbortController().signal;

test('semantic annotations require usable scenarios, uncertainty and speaker attribution', () => {
  assert.equal(parseMemeMeaning(entry).visibleText, '耶');
  for (const value of [{ ...entry, scenes: [] }, { ...entry, avoid: [] }, { ...entry, confidence: 2 }, { ...entry, meaning: '' }, { ...entry, target: undefined }])
    assert.throws(() => parseMemeMeaning(value));
});
test('all 113 imported images have matching hashes and structured semantic annotations', () => {
  const entries = loadMemeCatalog('config/memes/tieba');
  assert.equal(entries.length, 113); assert.equal(new Set(entries.map(e => e.id)).size, 113);
  assert.ok(entries.every(e => e.scenes.length && e.avoid.length && e.meaning && e.speaker && e.target));
  assert.ok(entries.filter(e => e.confidence < .8).length > 0);
});
test('selector sees concrete image meanings, not just categories, and can choose a known ID', async () => {
  const manager = new MemeManager([entry], 'key', store(), 7, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const payload = JSON.parse(body.messages[1].content);
    if (payload.candidates) { assert.deepEqual(payload.candidates[0].scenes, entry.scenes); assert.equal(payload.candidates[0].speaker, entry.speaker); }
    else assert.equal(payload.candidate.speaker, entry.speaker);
    assert.doesNotMatch(String(init?.body), /12345678|87654321|unused.png/);
    return selected(_url, init);
  }, () => {});
  assert.equal((await manager.choose('g', '终于完成了', context, signal()))?.id, entry.id);
});
test('null, unknown ID, low confidence, malformed and failed selection keep text-only behavior', async () => {
  for (const response of [Response.json({ choices: [{ message: { content: '{"id":null}' } }] }),
    Response.json({ choices: [{ message: { content: '{"id":"../../secret"}' } }] }), new Response('bad JSON'), new Response('private error', { status: 429 })]) {
    const manager = new MemeManager([entry], 'key', store(), 7, async () => response, () => {});
    assert.equal(await manager.choose('g', 'draft', context, signal()), undefined);
  }
  let calls = 0;
  const manager = new MemeManager([{ ...entry, confidence: .5 }], 'key', store(), 7, async () => { calls++; throw Error(); });
  assert.equal(await manager.choose('g', 'draft', context, signal()), undefined); assert.equal(calls, 0);
});
test('seven acknowledged text replies, not segments or failed deliveries, are required after a meme attempt', async () => {
  let calls = 0; const manager = new MemeManager([entry, { ...entry, id: 'tb_abcdef012345' }], 'key', store(), 7, async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)); const payload = JSON.parse(body.messages[1].content); return Response.json({ choices: [{ message: { content: JSON.stringify(payload.candidates ? { id: payload.candidates[0].id } : { match: true }) } }] }); }, () => {});
  manager.attempt('g', entry.id);
  for (let i = 0; i < 6; i++) manager.finish('g', true, false);
  manager.finish('g', false, false); manager.finish('g', true, true);
  assert.equal(await manager.choose('g', 'draft', context, signal()), undefined); assert.equal(calls, 0);
  manager.finish('g', true, false); await manager.choose('g', 'draft', context, signal()); assert.equal(calls, 2);
  await manager.choose('other-group', 'draft', context, signal()); assert.equal(calls, 4);
});
test('recent IDs are excluded and cannot be selected even if the model returns them', async () => {
  const manager = new MemeManager([entry, { ...entry, id: 'tb_abcdef012345' }], 'key', store(), 1, selected, () => {});
  manager.attempt('g', entry.id); manager.finish('g', true, false);
  assert.equal(await manager.choose('g', 'draft', context, signal()), undefined);
});
test('frequency and repetition history survive restart; state is private and malformed state fails closed', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-state-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json'); const saved = new JsonMemeState(file);
  const first = new MemeManager([entry], 'key', saved, 7, selected, () => {}); first.attempt('g', entry.id);
  const second = new MemeManager([entry], 'key', new JsonMemeState(file), 7, selected, () => {});
  assert.equal(await second.choose('g', 'draft', context, signal()), undefined);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, '{broken'); assert.throws(() => new JsonMemeState(file).load());
});
test('warmups and cancelled tasks do not request a meme selection', async () => {
  let calls = 0; const manager = new MemeManager([entry], 'key', store(), 7, async () => { calls++; throw Error(); });
  const canceled = new AbortController(); canceled.abort();
  assert.equal(await manager.choose('g', 'draft', context, canceled.signal), undefined);
  assert.equal(await manager.choose('g', 'draft', { ...context, kind: 'warmup' }, signal()), undefined); assert.equal(calls, 0);
});
test('catalog rejects traversal/symlinks, changed bytes and stale semantics before use', t => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-catalog-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = loadMemeCatalog('config/memes/tieba')[0]; const bytes = readFileSync(source.file);
  const file = join(directory, 'one.png'); writeFileSync(file, bytes);
  const json = join(directory, 'catalog.json'); const row = { ...source, file: 'one.png' };
  const save = (value: unknown) => writeFileSync(json, JSON.stringify({ version: 1, images: [value] }));
  save(row); assert.equal(loadMemeCatalog(directory).length, 1);
  save({ ...row, file: '../outside.png' }); assert.throws(() => loadMemeCatalog(directory));
  save({ ...row, semanticVersion: 0 }); assert.throws(() => loadMemeCatalog(directory));
  save(row); writeFileSync(file, 'changed'); assert.throws(() => loadMemeCatalog(directory));
  const link = join(directory, 'link.png'); symlinkSync(source.file, link); save({ ...row, file: 'link.png' }); assert.throws(() => loadMemeCatalog(directory));
});
test('image payload is base64 and revalidated immediately before delivery', t => {
  const directory = mkdtempSync(join(tmpdir(), 'meme-bytes-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'test.png'); writeFileSync(file, 'bytes');
  const chosen = { ...entry, file, sha256: createHash('sha256').update('bytes').digest('hex') };
  const manager = new MemeManager([chosen], 'key', store());
  assert.equal(manager.image(chosen), 'base64://Ynl0ZXM='); writeFileSync(file, 'changed'); assert.throws(() => manager.image(chosen));
  assert.match(memeNote(chosen), /已发送表情 tb_abcdefabcdef.*开心庆祝.*耶/);
});


test('offline annotation submits real image content and validates model metadata before saving', async () => {
  const source = loadMemeCatalog('config/memes/tieba')[0];
  const meaning = await describeMeme(readFileSync(source.file), 'key', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); assert.equal(body.model, 'deepseek-flash');
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.equal(body.tools, undefined); assert.equal((init?.headers as any).Authorization, 'Bearer key');
    return Response.json({ choices: [{ message: { content: JSON.stringify(entry) } }] });
  });
  assert.equal(meaning.meaning, entry.meaning);
  await assert.rejects(describeMeme(readFileSync(source.file), 'key', async () => Response.json({ choices: [{ message: { content: '{"meaning":"guess"}' } }] })));
});


test('a selected image rejected by speaker/target review never becomes a send candidate', async () => {
  const manager = new MemeManager([entry], 'key', store(), 7, async (_url, init) => {
    const review = JSON.parse(String(init?.body)).messages[0].content.includes('独立复核');
    return Response.json({ choices: [{ message: { content: JSON.stringify(review ? { match: false } : { id: entry.id }) } }] });
  }, () => {});
  assert.equal(await manager.choose('g', 'comfort someone', context, signal()), undefined);
});


test('internal image delivery records or opaque IDs cannot be echoed as visible text', () => {
  assert.equal(stripMemeRecords('好耶 [已发送表情 tb_abcdefabcdef：开心]'), '好耶');
  assert.equal(stripMemeRecords('tb_abcdefabcdef'), '');
});
