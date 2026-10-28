import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareContext } from './prepare.js';
import type { ExecutionScope } from '../agent/scope.js';
import type { MemoryReader, MemoryRecord } from './memory/contracts.js';
const scope: ExecutionScope = { ownerId: 'alice@example', participantId: 'alice@example', participantIds: ['alice@example'],
  conversationId: 'work-not-numeric', channelId: 'web', kind: 'direct', memorySourceConversationIds: [] };
const record = (overrides: Partial<MemoryRecord['source']> = {}, quote = '考试在周五'): MemoryRecord => ({ quote,
  source: { ownerId: scope.ownerId, participantId: scope.participantId, conversationId: scope.conversationId,
    channelId: 'web', kind: 'direct', messageId: 'evidence-1', role: 'user', text: '我的考试在周五', createdAt: '2026-10-20T00:00:00Z', ...overrides } });
const prepare = (memory?: MemoryReader, options: Partial<Parameters<typeof prepareContext>[0]> = {}) => prepareContext({
  scope, text: '考试安排', history: [], signal: new AbortController().signal, memory, ...options,
});
const reader = (...records: MemoryRecord[]): MemoryReader => ({ recall: async () => ({ records, isCurrent: () => true }) });
test('non-numeric identity and provenance survive while unsupported claims are removed', async () => {
  const result = await prepare(reader(record(), record({ messageId: 'missing-quote' }, '考试已通过')));
  assert.equal(result.memory.status, 'available');
  assert.equal(result.memory.records.length, 1);
  assert.equal(result.memory.records[0]?.source.ownerId, scope.ownerId);
  assert.equal('text' in result.memory.records[0]!.source, false);
});
test('owner, participant, channel and conversation boundaries fail closed', async () => {
  for (const source of [
    { ownerId: 'bob' }, { participantId: 'bob' }, { channelId: 'qq' },
    { conversationId: 'other' }, { kind: 'shared' as const },
  ]) assert.deepEqual((await prepare(reader(record(source)))).memory, { status: 'empty', records: [] });
  const granted = { ...scope, memorySourceConversationIds: ['other'] };
  assert.equal((await prepare(reader(record({ conversationId: 'other' })), { scope: granted })).memory.status, 'available');
  assert.equal((await prepare(reader(record({ conversationId: 'other', ownerId: 'bob' })), { scope: granted })).memory.status, 'empty');
});
test('shared conversation metadata blocks private recall regardless of ID spelling or grants', async () => {
  const shared = { ...scope, conversationId: 'private:123', kind: 'shared' as const, participantIds: [scope.participantId, 'bob'], memorySourceConversationIds: ['other'] };
  assert.equal((await prepare(reader(record({ conversationId: 'other' })), { scope: shared })).memory.status, 'empty');
  assert.equal((await prepare(reader(record({ conversationId: 'private:123', kind: 'shared' })), { scope: shared })).memory.status, 'available');
  assert.equal((await prepare(reader(record({ conversationId: 'private:123' })), { scope: shared })).memory.status, 'empty');
});
test('disabled, empty and failed capabilities have explicit states and no invented evidence', async () => {
  assert.equal((await prepare()).memory.status, 'disabled');
  assert.equal((await prepare(reader())).memory.status, 'empty');
  assert.equal((await prepare({ recall: async () => { throw Error('secret'); } })).memory.status, 'unavailable');
  assert.equal((await prepare(reader(record()), { scope: undefined })).memory.status, 'disabled');
  assert.equal((await prepare(reader(record()), { personality: { prompt: () => { throw Error('secret'); } } })).personality.status, 'unavailable');
  assert.equal((await prepare()).personality.status, 'disabled');
});
test('capabilities cannot mutate identity or history to gain access', async () => {
  const history = [{ role: 'user' as const, content: 'source' }];
  const result = await prepare({ recall: async query => {
    query.scope.ownerId = 'bob'; query.scope.memorySourceConversationIds = ['other']; query.history[0]!.content = 'changed';
    return { records: [record({ ownerId: 'bob' }), record({ conversationId: 'other' })], isCurrent: () => true };
  } }, { history, personality: { prompt(input) {
    assert.deepEqual(Object.keys(input).sort(), ['history', 'text']);
    input.history[0]!.content = 'persona mutation'; return '用简洁的语言回答。';
  } } });
  assert.equal(result.memory.status, 'empty'); assert.equal(scope.ownerId, 'alice@example'); assert.equal(history[0]!.content, 'source');
  assert.equal(result.personality.status, 'available');
});
test('source freshness is checked after preparation and failures invalidate the guard', async () => {
  let current = true, fail = false;
  const result = await prepare({ recall: async () => ({ records: [record()], isCurrent() { if (fail) throw Error('deleted'); return current; } }) });
  assert.equal(result.isCurrent(), true); current = false; assert.equal(result.isCurrent(), false);
  current = true; fail = true; assert.equal(result.isCurrent(), false);
});
test('cancellation ends an uncooperative capability wait and cannot enable personality', async () => {
  const controller = new AbortController(); let started!: () => void; let release!: (value: any) => void; let personalityCalls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const pending = prepare({ recall: () => { started(); return new Promise(resolve => { release = resolve; }); } },
    { signal: controller.signal, personality: { prompt() { personalityCalls++; return 'never'; } } });
  await ready; controller.abort(); await assert.rejects(pending);
  release({ records: [record()], isCurrent: () => true });
  assert.equal(personalityCalls, 0);
});
test('unresponsive recall times out with no records while personality remains optional', async () => {
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    const result = await prepare({ recall: () => new Promise(() => {}) });
    assert.deepEqual(result.memory, { status: 'unavailable', records: [] });
  } finally { clearTimeout(keepAlive); }
});
