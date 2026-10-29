import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputHistory } from './input-history.js';
test('input history preserves multiline input, collapses consecutive duplicates and skips private or invalid entries', () => {
  const history = new InputHistory();
  for (const input of ['', '   ', ' secret', '\tsecret', '\nsecret', '\u3000secret', 'x'.repeat(8001)]) history.record(input);
  assert.equal(history.length, 0); history.record('first\n  第二行'); history.record('first\n  第二行'); history.record('/tasks running');
  assert.equal(history.length, 2); assert.equal(history.get(0), 'first\n  第二行'); assert.equal(history.get(1), '/tasks running');
});
test('history bounds both entry count and total text and evicts oldest entries', () => {
  const history = new InputHistory(); for (let i = 0; i < 60; i++) history.record('entry-' + i);
  assert.equal(history.length, 50); assert.equal(history.get(0), 'entry-10'); assert.equal(history.get(49), 'entry-59');
  history.clear(); for (let i = 0; i < 9; i++) history.record(String(i) + 'x'.repeat(7999));
  assert.equal(history.length, 8); assert(history.get(0)?.startsWith('1')); assert(history.get(7)?.startsWith('8'));
});
test('history is instance-local and explicit clearing removes retained records', () => {
  const first = new InputHistory(), second = new InputHistory(); first.record('first'); assert.equal(second.length, 0);
  first.clear(); assert.equal(first.length, 0); assert.equal(first.get(0), undefined); first.record('after clear'); assert.equal(first.get(0), 'after clear');
});
