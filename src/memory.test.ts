import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';

const memory = (now = Date.now, ttl = 30 * 60_000, maxTurns = 6, maxSessions = 100) =>
  new ConversationMemory(new SqliteSessionStore(':memory:'), now, ttl, maxTurns, maxSessions);

test('memory isolates users and groups, and returns independent copies', () => {
  const store = memory();
  store.add('a', 'u', 'name', '小林');
  assert.equal(store.get('a', 'u').length, 2);
  assert.deepEqual(store.get('b', 'u'), []);
  assert.deepEqual(store.get('a', 'v'), []);
  store.get('a', 'u')[0].content = 'changed';
  assert.equal(store.get('a', 'u')[0].content, 'name');
  store.clear('a', 'u');
  assert.deepEqual(store.get('a', 'u'), []);
  store.close();
});

test('memory keeps complete recent turns and expires inactive sessions', () => {
  let now = 0;
  const store = memory(() => now, 100, 2);
  for (let i = 0; i < 3; i++) store.add('g', 'u', `q${i}`, `a${i}`);
  assert.deepEqual(store.get('g', 'u').map(turn => turn.content), ['q1', 'a1', 'q2', 'a2']);
  now = 100;
  assert.deepEqual(store.get('g', 'u'), []);
  store.close();
});

test('memory capacity evicts the least recently updated session', () => {
  const store = memory(Date.now, 10000, 6, 2);
  store.add('g', 'a', 'a', 'a');
  store.add('g', 'b', 'b', 'b');
  store.add('g', 'a', 'again', 'again');
  store.add('g', 'c', 'c', 'c');
  assert.deepEqual(store.get('g', 'b'), []);
  assert.equal(store.get('g', 'a').length, 4);
  store.close();
});

test('memory survives a restart when backed by a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-ai-memory-'));
  const path = join(dir, 'memory.db');
  try {
    const first = new ConversationMemory(new SqliteSessionStore(path));
    first.add('g', 'u', 'q1', 'a1');
    first.add('g', 'u', 'q2', 'a2');
    first.close();

    const second = new ConversationMemory(new SqliteSessionStore(path));
    assert.deepEqual(second.get('g', 'u').map(turn => turn.content), ['q1', 'a1', 'q2', 'a2']);
    second.clear('g', 'u');
    second.close();

    const third = new ConversationMemory(new SqliteSessionStore(path));
    assert.deepEqual(third.get('g', 'u'), []);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
