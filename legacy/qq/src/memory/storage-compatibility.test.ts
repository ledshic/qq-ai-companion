import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from './events/store.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';

test('legacy SQLite sessions keep their exact keys through reads, updates and restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-compat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory.db');
  new SqliteSessionStore(path).close();
  const db = new DatabaseSync(path);
  for (const chatId of ['123', 'private:2']) {
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(JSON.stringify([chatId, '2']), chatId, '2', 1000, 1,
      JSON.stringify([{ role: 'user', content: chatId }, { role: 'assistant', content: 'old answer' }]));
  }
  db.close();
  const memory = new ConversationMemory(new SqliteSessionStore(path), () => 2000);
  assert.equal(memory.get('123', '2')[0].content, '123');
  assert.equal(memory.get('private:2', '2')[0].content, 'private:2');
  memory.add('private:2', '2', 'new question', 'new answer');
  memory.close();
  const reopened = new ConversationMemory(new SqliteSessionStore(path), () => 3000);
  try {
    assert.equal(reopened.get('private:2', '2').length, 4);
    assert.equal(reopened.get('123', '2').length, 2);
    reopened.clear('private:2', '2');
    assert.equal(reopened.get('123', '2').length, 2);
  } finally { reopened.close(); }
});

test('legacy scoped JSON remains readable and writable without changing business payloads', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-events-compat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'events.db');
  new EventStore(path).close();
  const record = { groupId: '123', ownerId: '2', id: 'old-event', domain: 'event', businessKey: 'old',
    version: 1, epoch: 0, status: 'active', createdAt: 100, updatedAt: 100, expiresAt: 10000,
    evidenceIds: [], payload: { groupId: 'business-field', text: 'original fact' } };
  const attention = { groupId: '123', ownerId: '2', id: 'old-attention', eventId: record.id,
    eventVersion: 1, epoch: 0, status: 'pending', kind: 'event_followup', occurrenceAt: 100,
    notBefore: 100, expiresAt: 10000, tone: 'gentle', requiresPresence: true, payload: {} };
  const attempt = { groupId: '123', ownerId: '2', attentionId: attention.id, eventVersion: 1,
    epoch: 0, startedAt: 100, opportunity: { occurrenceAt: 100, notBefore: 100, expiresAt: 10000, tone: 'gentle' } };
  const db = new DatabaseSync(path);
  db.prepare('INSERT INTO event_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(record.id, '123', '2', 'event', 'old',
    1, 0, 'active', 100, 100, 10000, JSON.stringify(record));
  db.prepare('INSERT INTO attention_items VALUES(?,?,?,?,?,?,?)').run(attention.id, record.id, attention.kind, 100,
    'pending', 10000, JSON.stringify(attention));
  db.prepare('INSERT INTO attention_observations VALUES(?,?,?,?,?,?)').run(attention.id, 1, '123', '2', 100, JSON.stringify(attempt));
  db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?,?)').run('revision', record.id, '123', '2', 1, 'active', 100, JSON.stringify(record));
  db.close();
  const scope = { chatId: '123', ownerId: '2' };
  const store = new EventStore(path);
  try {
    assert.equal(store.records(scope, 200)[0].chatId, '123');
    assert.deepEqual(store.records(scope, 200)[0].payload, record.payload);
    assert.equal('groupId' in store.records(scope, 200)[0], false);
    assert.equal(store.archive.revisions(scope)[0].chatId, '123');
    assert.equal(store.attentions(scope)[0].chatId, '123');
    store.finishInitiative(store.initiatives(scope)[0], { status: 'skipped', reason: 'test' }, 200);
    store.cancelScope(scope);
    store.prune(11000);
  } finally { store.close(); }
  const raw = new DatabaseSync(path);
  try {
    for (const table of ['event_memories', 'attention_items', 'attention_observations', 'memory_revisions']) {
      for (const row of raw.prepare(`SELECT body FROM ${table}`).all()) {
        const body = JSON.parse(String(row.body));
        assert.equal(body.groupId, '123');
        assert.equal(body.chatId, undefined);
      }
    }
  } finally { raw.close(); }
  const reopened = new EventStore(path);
  try {
    assert.equal(reopened.retainedRecords(scope, 12000)[0].status, 'historical');
    assert.deepEqual(reopened.retainedRecords(scope, 12000)[0].payload, record.payload);
    assert.equal(reopened.attentions(scope)[0].status, 'cancelled');
  } finally { reopened.close(); }
});
