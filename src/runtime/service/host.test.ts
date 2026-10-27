import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceStore } from './store.js';
import { RunHost } from './host.js';
import { SqliteSessionStore } from '../../memory/store.js';
const settle = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('run did not settle');
};
test('idempotency, completed history and legacy storage stay isolated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-service-')),
    path = join(root, 'memory.db');
  const legacy = new SqliteSessionStore(path);
  legacy.save(
    'private-key',
    'private:123',
    '123',
    [{ role: 'user', content: 'private secret' }],
    Date.now(),
  );
  legacy.close();
  const store = new ServiceStore(path);
  let calls = 0;
  const histories: unknown[] = [];
  const host = new RunHost(store, async (content, history) => {
    calls++;
    histories.push(history);
    return 'answer:' + content;
  });
  try {
    const conversation = store.createConversation('owner', 'First');
    const accepted = host.submit('owner', conversation.id, 'first', 'question');
    assert.equal(
      host.submit('owner', conversation.id, 'first', 'question').runId,
      accepted.runId,
    );
    assert.throws(
      () => host.submit('owner', conversation.id, 'first', 'different'),
      /idempotency_conflict/,
    );
    await settle(
      () => store.run('owner', accepted.runId).state === 'completed',
    );
    store.pause(true);
    assert.equal(
      host.submit('owner', conversation.id, 'first', 'question').duplicate,
      true,
    );
    assert.throws(
      () => host.submit('owner', conversation.id, 'second', 'new'),
      /runtime_paused/,
    );
    store.pause(false);
    const second = host.submit('owner', conversation.id, 'second', 'followup');
    await settle(() => store.run('owner', second.runId).state === 'completed');
    assert.equal(calls, 2);
    assert.deepEqual(histories, [
      [],
      [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer:question' },
      ],
    ]);
    assert.equal(
      store.messages('owner', conversation.id, 0, 100).messages.length,
      4,
    );
    const other = store.createConversation('other', 'Other');
    assert.throws(() => store.messages('owner', other.id, 0, 50), /not_found/);
    assert.equal(store.events('other', 0).events.length, 0);
    const reader = new SqliteSessionStore(path);
    assert.equal(
      reader.load('private-key')?.turns[0]?.content,
      'private secret',
    );
    reader.close();
  } finally {
    host.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('cancellation and superseding prevent late results from committing', async () => {
  const store = new ServiceStore(':memory:');
  const pending: { resolve: (s: string) => void; signal: AbortSignal }[] = [];
  const host = new RunHost(
    store,
    (_content, _history, signal) =>
      new Promise((resolve) => pending.push({ resolve, signal })),
    2,
  );
  try {
    const c = store.createConversation('owner', 'Cancel');
    const first = host.submit('owner', c.id, 'first', 'first');
    await settle(() => pending.length === 1);
    host.cancel('owner', first.runId);
    assert.equal(pending[0]!.signal.aborted, true);
    pending[0]!.resolve('must not commit');
    await settle(() => store.run('owner', first.runId).state === 'cancelled');
    const second = host.submit('owner', c.id, 'second', 'second');
    await settle(() => pending.length === 2);
    const third = host.submit('owner', c.id, 'third', 'third');
    assert.equal(store.run('owner', second.runId).state, 'cancelled');
    pending[1]!.resolve('stale');
    await settle(() => pending.length === 3);
    pending[2]!.resolve('current');
    await settle(() => store.run('owner', third.runId).state === 'completed');
    assert.deepEqual(
      store
        .messages('owner', c.id, 0, 100)
        .messages.filter((m) => m.role === 'assistant')
        .map((m) => m.content),
      ['current'],
    );
    const events = store.events('owner', 0).events;
    assert.equal(
      events.filter((e) => e.type === 'message.committed').length,
      1,
    );
  } finally {
    host.stop();
    store.close();
  }
});
test('restart interrupts unfinished runs without replay and retains event cursors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-recovery-')),
    path = join(root, 'memory.db');
  let store = new ServiceStore(path);
  try {
    const c = store.createConversation('owner', 'Recover');
    const first = store.accept('owner', c.id, 'first', 'pending');
    store.start('owner', first.runId);
    const before = store.events('owner', 0).nextCursor;
    store.close();
    store = new ServiceStore(path);
    let calls = 0;
    const host = new RunHost(store, async () => {
      calls++;
      return 'unexpected';
    });
    assert.equal(store.run('owner', first.runId).state, 'interrupted');
    assert.equal(
      host.submit('owner', c.id, 'first', 'pending').duplicate,
      true,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      store.events('owner', before).events.map((e) => e.type),
      ['run.interrupted'],
    );
    assert.throws(() => store.events('owner', 999999), /event_resync_required/);
    store.exec('DELETE FROM service_events WHERE id<=?', before);
    assert.throws(() => store.events('owner', 1), /event_resync_required/);
    host.stop();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('shutdown prevents promises from touching a closed database', async () => {
  const store = new ServiceStore(':memory:');
  let finish!: (value: string) => void;
  const host = new RunHost(
    store,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const c = store.createConversation('owner', 'Shutdown');
  const run = host.submit('owner', c.id, 'first', 'pending');
  await settle(() => !!finish);
  host.stop();
  assert.equal(store.run('owner', run.runId).state, 'interrupted');
  store.close();
  finish('late');
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('completed reasoning is saved with its assistant message and excluded from model history', async () => {
  const store = new ServiceStore(':memory:');
  const host = new RunHost(store, async (_content, _history, _signal, onReasoning) => {
    onReasoning?.('先分析问题');
    return '最终回答';
  });
  try {
    const c = store.createConversation('owner', 'Reasoning');
    const run = host.submit('owner', c.id, 'first', '问题');
    await settle(() => store.run('owner', run.runId).state === 'completed');
    const messages = store.messages('owner', c.id, 0, 50).messages;
    assert.equal(messages[1]?.reasoning, '先分析问题');
    assert.equal(messages[0]?.reasoning, undefined);
    assert.deepEqual(store.history('owner', c.id), [
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '最终回答' },
    ]);
    assert.throws(() => store.messages('other', c.id, 0, 50), /not_found/);
  } finally {
    host.stop();
    store.close();
  }
});
