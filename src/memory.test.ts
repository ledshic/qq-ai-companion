import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationMemory } from './memory.js';

test('memory isolates users and groups, and returns independent copies', () => {
  const memory = new ConversationMemory();
  memory.add('a', 'u', 'name', '小林');
  assert.equal(memory.get('a', 'u').length, 2);
  assert.deepEqual(memory.get('b', 'u'), []);
  assert.deepEqual(memory.get('a', 'v'), []);
  memory.get('a', 'u')[0].content = 'changed';
  assert.equal(memory.get('a', 'u')[0].content, 'name');
  memory.clear('a', 'u');
  assert.deepEqual(memory.get('a', 'u'), []);
});

test('memory keeps complete recent turns and expires inactive sessions', () => {
  let now = 0;
  const memory = new ConversationMemory(() => now, 100, 2);
  for (let i = 0; i < 3; i++) memory.add('g', 'u', `q${i}`, `a${i}`);
  assert.deepEqual(memory.get('g', 'u').map(turn => turn.content), ['q1', 'a1', 'q2', 'a2']);
  now = 100;
  assert.deepEqual(memory.get('g', 'u'), []);
});

test('memory capacity evicts the least recently updated session', () => {
  const memory = new ConversationMemory(Date.now, 10000, 6, 2);
  memory.add('g', 'a', 'a', 'a');
  memory.add('g', 'b', 'b', 'b');
  memory.add('g', 'a', 'again', 'again');
  memory.add('g', 'c', 'c', 'c');
  assert.deepEqual(memory.get('g', 'b'), []);
  assert.equal(memory.get('g', 'a').length, 4);
});
