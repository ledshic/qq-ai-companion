import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProactiveBudget } from './proactive-budget.js';

const hour = 3_600_000;
test('cooldowns remain independent per group and participation path with an exclusive end boundary', () => {
  let now = 0;
  const budget = new ProactiveBudget(() => now);
  budget.record('judge', 'group');
  assert.equal(budget.cooling('judge', 'group', 1000), true);
  assert.equal(budget.cooling('judge', 'other', 1000), false);
  assert.equal(budget.cooling('interject', 'group', 1000), false);
  assert.equal(budget.cooling('warmup', 'group', 1000), false);
  now = 1000;
  assert.equal(budget.cooling('judge', 'group', 1000), false);
  assert.equal(budget.cooling('judge', 'group', 0), false);
});

test('only recorded judged participation consumes the fixed-hour budget', () => {
  let now = hour - 1;
  const budget = new ProactiveBudget(() => now);
  budget.record('interject', 'group'); budget.record('warmup', 'group');
  assert.equal(budget.overHourlyCap('group', 1), false);
  budget.record('judge', 'group');
  assert.equal(budget.overHourlyCap('group', 2), false);
  budget.record('judge', 'group');
  assert.equal(budget.overHourlyCap('group', 2), true);
  assert.equal(budget.overHourlyCap('other', 2), false);
  now = hour;
  assert.equal(budget.overHourlyCap('group', 2), false);
  budget.record('judge', 'group');
  assert.equal(budget.overHourlyCap('group', 2), false);
  assert.equal(budget.overHourlyCap('group', 1), true);
});

test('disconnect retains unified budgets and clears legacy judged budgets without clearing other cooldowns', () => {
  for (const unified of [true, false]) {
    const budget = new ProactiveBudget(() => 1000);
    for (const kind of ['judge', 'interject', 'warmup'] as const) budget.record(kind, 'group');
    budget.disconnected(unified);
    assert.equal(budget.cooling('judge', 'group', 1000), unified);
    assert.equal(budget.overHourlyCap('group', 1), unified);
    assert.equal(budget.cooling('interject', 'group', 1000), true);
    assert.equal(budget.cooling('warmup', 'group', 1000), true);
  }
});
