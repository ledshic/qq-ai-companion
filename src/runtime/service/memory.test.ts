import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServiceStore } from './store.js';
import { ServiceMemory } from './memory.js';
import { SqliteSessionStore } from '../../memory/store.js';
function completed(store: ServiceStore, owner: string, conversation: string, id: string, text: string) {
  const accepted = store.accept(owner, conversation, id, text);
  store.start(owner, accepted.runId); store.finish(owner, accepted.runId, 'assistant invented secret', null, 'private reasoning');
  return accepted;
}
const signal = () => new AbortController().signal;
async function recall(memory: ServiceMemory, ownerId: string, conversationId: string, text = '考试') {
  return memory.recall({ scope: memory.scope(ownerId, conversationId), text, history: [] }, signal());
}
test('default recall isolates conversations, owners, cancelled runs and assistant claims', async () => {
  const store = new ServiceStore(':memory:'); const memory = new ServiceMemory(store);
  try {
    const a = store.createConversation('alice', 'A'), b = store.createConversation('alice', 'B'), c = store.createConversation('bob', 'C');
    completed(store, 'alice', a.id, 'a', '考试安排在周五');
    completed(store, 'alice', b.id, 'b', '考试地点在北京');
    completed(store, 'bob', c.id, 'c', '考试私密资料');
    const cancelled = store.accept('alice', a.id, 'cancel', '考试不能召回的草稿'); store.cancel('alice', cancelled.runId);
    assert.deepEqual((await recall(memory, 'alice', a.id)).records.map(r => r.quote), ['考试安排在周五']);
    assert.equal((await recall(memory, 'alice', a.id, 'invented secret')).records.length, 0);
    assert.throws(() => memory.setSources('alice', a.id, [c.id]), /not_found/);
    assert.throws(() => memory.scope('bob', a.id), /not_found/);
    assert.equal(memory.policy('alice', a.id).revision, 0);
    const context = memory.scope('alice', a.id); context.memorySourceConversationIds = [b.id];
    await assert.rejects(memory.recall({ scope: context, text: '考试', history: [] }, signal()), /Invalid service scope/);
    const recent = await memory.recall({ scope: memory.scope('alice', a.id), text: '考试', history: [{ role: 'user', content: '考试安排在周五' }] }, signal());
    assert.deepEqual(recent.records, []);
  } finally { store.close(); }
});
test('explicit grants are directional, revocable and invalidated by source changes', async () => {
  const store = new ServiceStore(':memory:'); const memory = new ServiceMemory(store);
  try {
    const a = store.createConversation('alice', 'A'), b = store.createConversation('alice', 'B');
    const source = completed(store, 'alice', b.id, 'b', '考试地点在北京');
    assert.equal((await recall(memory, 'alice', a.id)).records.length, 0);
    memory.setSources('alice', a.id, [b.id]);
    const result = await recall(memory, 'alice', a.id);
    assert.equal(result.records[0]?.source.messageId, source.messageId); assert.equal(result.isCurrent(), true);
    assert.deepEqual(memory.policy('alice', b.id).sourceConversationIds, []);
    memory.setSources('alice', a.id, []); assert.equal(result.isCurrent(), false);
    memory.setSources('alice', a.id, [b.id]); assert.equal(result.isCurrent(), false);
    const changed = await recall(memory, 'alice', a.id);
    store.exec('UPDATE service_messages SET content=? WHERE id=?', '考试新地点', source.messageId);
    assert.equal(changed.isCurrent(), false);
    const deleted = await recall(memory, 'alice', a.id);
    store.exec('DELETE FROM service_messages WHERE id=?', source.messageId); assert.equal(deleted.isCurrent(), false);
    assert.throws(() => memory.setSources('alice', a.id, [b.id, b.id]), /invalid_memory_sources/);
  } finally { store.close(); }
});
test('additive policy storage survives restart without importing or changing legacy QQ data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-phase3-')); const path = join(root, 'memory.db');
  const legacy = new SqliteSessionStore(path); legacy.save('legacy', 'private:123', '123', [{ role: 'user', content: '考试 QQ 私密资料' }], Date.now()); legacy.close();
  let store = new ServiceStore(path);
  try {
    let memory = new ServiceMemory(store);
    const a = store.createConversation('owner-with-letters', 'A'), b = store.createConversation('owner-with-letters', 'B');
    completed(store, 'owner-with-letters', b.id, 'b', '考试 service source');
    memory.setSources('owner-with-letters', a.id, [b.id]); store.close();
    store = new ServiceStore(path); memory = new ServiceMemory(store);
    assert.deepEqual(memory.policy('owner-with-letters', a.id).sourceConversationIds, [b.id]);
    const result = await recall(memory, 'owner-with-letters', a.id);
    assert.deepEqual(result.records.map(r => r.quote), ['考试 service source']);
    // Recall's short deadline must not expire the returned source guard.
    const deadlineResult = await memory.recall({ scope: memory.scope('owner-with-letters', a.id), text: '考试', history: [] }, AbortSignal.timeout(5));
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(deadlineResult.isCurrent(), true);
    const reader = new SqliteSessionStore(path); assert.equal(reader.load('legacy')?.turns[0]?.content, '考试 QQ 私密资料'); reader.close();
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
