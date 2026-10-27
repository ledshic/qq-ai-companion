import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from './store.js';
import { projectAttentions, selectAttentionTone } from './attention-policy.js';
import { extractionBudget, allowsInitiative } from './budget-policy.js';
import type { Attention, AttentionDraft, Batch, EventDomain, EventRecord, Mutation } from './types.js';
import type { InitiativeAttempt } from './initiative-types.js';

const now = Date.parse('2026-10-26T10:00:00+08:00');
const hour = 3_600_000;
const scope = { chatId: 'group', ownerId: 'owner' };
const record: EventRecord = { ...scope, id: 'event', domain: 'test', businessKey: 'key', version: 2, epoch: 0,
  payload: {}, evidenceIds: [], status: 'active', createdAt: now, updatedAt: now, expiresAt: now + 24 * hour };
const draft = (kind = 'followup'): AttentionDraft => ({ kind, occurrenceAt: now, notBefore: now,
  expiresAt: now + hour, payload: {}, requiresPresence: true });
const domain = (project: EventDomain['project']): EventDomain => ({ name: 'test', prompt: '', interpret: () => [], project });
const previous: Attention = { ...draft(), ...scope, id: 'attention', eventId: 'event', eventVersion: 1,
  epoch: 0, tone: 'wry', status: 'cancelled', observation: 'old observation' };
const attempt = (ownerId: string, startedAt: number, chatId = scope.chatId): InitiativeAttempt => ({
  chatId, ownerId, attentionId: `attention-${ownerId}`, eventVersion: 1, epoch: 0, startedAt,
  opportunity: { occurrenceAt: now, notBefore: now, expiresAt: now + hour, tone: 'wry' },
});
function batch(store: EventStore, messageId = 'source'): Batch {
  store.ingest({ ...scope, messageId, text: 'source text', sourceAt: now, receivedAt: now });
  return store.claim(now + 4000)!;
}
const mutation = (input: Batch, businessKey = 'key'): Mutation => ({ domain: 'test', businessKey,
  operation: 'upsert', payload: {}, evidenceIds: [input.sources[0].id], expiresAt: now + 24 * hour });

function database(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'event-policy-'));
  const path = join(directory, 'memory.db');
  const store = new EventStore(path);
  const inspector = new DatabaseSync(path);
  t.after(() => { inspector.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, inspector, path };
}

test('projection preserves identity and tone, replaces obsolete plans and does not mutate prior state', () => {
  let ids = 0, rolls = 0;
  const removed = { ...previous, id: 'removed', kind: 'removed' };
  const result = projectAttentions(record, [previous, removed], [domain(() => [draft(), draft('new')])], now,
    () => { rolls++; return 0.9; }, () => `new-${++ids}`);
  assert.deepEqual(result.upserts.map(item => [item.id, item.tone, item.eventVersion, item.status]),
    [['attention', 'wry', 2, 'pending'], ['new-1', 'gentle', 2, 'pending']]);
  assert.equal(result.upserts[0].observation, undefined);
  assert.deepEqual(result.cancellations, [removed]);
  assert.equal(ids, 1); assert.equal(rolls, 1);
  assert.equal(previous.status, 'cancelled'); assert.equal(previous.eventVersion, 1);
});

test('expired drafts consume no randomness or IDs and unknown domains remove prior plans', () => {
  const unavailable = () => { throw Error('must not be called'); };
  const result = projectAttentions(record, [previous], [domain(() => [{ ...draft(), expiresAt: now }])], now,
    unavailable, unavailable);
  assert.deepEqual(result, { upserts: [], cancellations: [] });
  assert.deepEqual(projectAttentions(record, [previous], [], now, unavailable, unavailable),
    { upserts: [], cancellations: [previous] });
  assert.deepEqual([-1, 0, 1 / 3, 2 / 3, 1, 2].map(value => selectAttentionTone(undefined, () => value)),
    ['upbeat', 'upbeat', 'wry', 'gentle', 'gentle', 'gentle']);
  assert.equal(selectAttentionTone('wry', unavailable), 'wry');
});

test('budgets retain fixed extraction hours, rolling observation hours and exact UTC+8 day boundaries', () => {
  assert.deepEqual(extractionBudget(now + hour - 1), { since: now, limit: 12 });
  assert.deepEqual(extractionBudget(now + hour), { since: now + hour, limit: 12 });
  const six = Array.from({ length: 6 }, (_, index) => attempt(`other-${index}`, now - hour + 1));
  assert.equal(allowsInitiative(scope, six, now), false);
  assert.equal(allowsInitiative(scope, six.map(item => ({ ...item, startedAt: now - hour })), now), true);
  assert.equal(allowsInitiative(scope, [attempt('owner', now, 'other-group')], now), true);
  const midnight = Date.parse('2026-10-26T00:00:00+08:00');
  assert.equal(allowsInitiative(scope, [attempt('owner', midnight - 1)], now), true);
  assert.equal(allowsInitiative(scope, [attempt('owner', midnight)], now), false);
});

test('projection failure rolls back earlier events, attention writes and evidence in the same batch', t => {
  const { store } = database(t);
  const input = batch(store);
  let projections = 0;
  const failing = domain(() => { if (++projections === 2) throw Error('projection failed'); return [draft()]; });
  const mutations = [mutation(input, 'first'), mutation(input, 'second')];
  assert.throws(() => store.commit(input, mutations, [failing], now + 4000, () => 0), /projection failed/);
  assert.deepEqual(store.records(scope, now), []);
  assert.deepEqual(store.attentions(), []);
  assert.deepEqual(store.evidence(scope), []);
  // The batch remains processing after rollback, so the same batch can commit atomically.
  assert.equal(store.commit(input, mutations, [domain(() => [draft()])], now + 4000, () => 0), true);
  assert.equal(store.records(scope, now).length, 2);
  assert.equal(store.attentions().length, 2);
});

test('a separate connection cannot see an event before its attention and evidence commit', t => {
  const { store, inspector } = database(t);
  const input = batch(store);
  const projecting = domain(() => {
    assert.equal(inspector.prepare('SELECT COUNT(*) n FROM event_memories').get()!.n, 0);
    assert.equal(inspector.prepare('SELECT COUNT(*) n FROM attention_items').get()!.n, 0);
    return [draft()];
  });
  store.commit(input, [mutation(input)], [projecting], now + 4000, () => 0);
  for (const table of ['event_memories', 'attention_items', 'event_evidence']) {
    assert.equal(inspector.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 1);
  }
});

test('failed observation reservation does not spend budget and successful reservation is visible across connections', t => {
  const { store, inspector, path } = database(t);
  const input = batch(store);
  store.commit(input, [mutation(input)], [domain(() => [draft()])], now + 4000, () => 0);
  const item = store.attentions()[0];
  inspector.exec(`CREATE TRIGGER reject_attempt BEFORE INSERT ON attention_observations
    BEGIN SELECT RAISE(ABORT, 'reservation failed'); END;`);
  assert.throws(() => store.claimInitiative(item, now + 5000), /reservation failed/);
  assert.deepEqual(store.initiatives(), []);
  inspector.exec('DROP TRIGGER reject_attempt');
  assert.ok(store.claimInitiative(item, now + 5000));
  const reader = new EventStore(path);
  try { assert.equal(reader.claimInitiative(item, now + 5000), undefined); }
  finally { reader.close(); }
});

test('an evidence write failure restores replaced attention, cancelled plans and event version together', t => {
  const { store, inspector } = database(t);
  const initial = batch(store);
  store.commit(initial, [mutation(initial)], [domain(() => [draft()])], now + 4000, () => 0.4);
  const before = { records: store.records(scope, now), attentions: store.attentions(), evidence: store.evidence(scope) };
  const correction = batch(store, 'correction');
  inspector.exec(`CREATE TRIGGER reject_evidence BEFORE INSERT ON event_evidence
    BEGIN SELECT RAISE(ABORT, 'evidence failed'); END;`);
  assert.throws(() => store.commit(correction, [mutation(correction)], [domain(() => [draft('changed')])],
    now + 4000, () => 0), /evidence failed/);
  assert.deepEqual({ records: store.records(scope, now), attentions: store.attentions(), evidence: store.evidence(scope) }, before);
  inspector.exec('DROP TRIGGER reject_evidence');
  assert.equal(store.commit(correction, [mutation(correction)], [domain(() => [draft('changed')])], now + 4000, () => 0), true);
  assert.equal(store.records(scope, now)[0].version, 2);
  assert.equal(store.attentions().find(item => item.kind === 'followup')?.status, 'cancelled');
  assert.equal(store.attentions().find(item => item.kind === 'changed')?.status, 'pending');
});
