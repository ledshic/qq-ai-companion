import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationWindows } from './observation.js';

test('fixed 60-second window expires without extending on follow-ups', () => {
  let now = 0;
  const windows = new ObservationWindows(() => now);
  const ticket = windows.incoming('g', 'u');
  assert.equal(windows.candidate('g', 'u'), undefined);
  windows.open(ticket);
  const valid = windows.candidate('g', 'u')!;
  now = 59_999;
  windows.incoming('g', 'u');
  assert.equal(valid(), true);
  assert.equal(windows.candidate('g', 'other'), undefined);
  now = 60_000;
  assert.equal(valid(), false);
  assert.equal(windows.candidate('g', 'u'), undefined);
});

test('each participant holds an independent window in the same group', () => {
  const windows = new ObservationWindows();
  const alice = windows.incoming('g', 'alice');
  windows.open(alice);
  const bob = windows.incoming('g', 'bob');
  windows.open(bob);
  windows.incoming('g', 'carol');
  const aliceTicket = windows.candidate('g', 'alice')!;
  const bobTicket = windows.candidate('g', 'bob')!;
  assert.equal(aliceTicket(), true);
  assert.equal(bobTicket(), true);
  windows.close('g', 'bob');
  assert.equal(bobTicket(), false);
  assert.equal(aliceTicket(), true);
  assert.equal(windows.candidate('g', 'carol'), undefined);
});

test('a window closed by another event reports the matching skip reason', () => {
  let now = 0;
  const windows = new ObservationWindows(() => now);
  const ticket = windows.incoming('g', 'u');
  windows.open(ticket);
  now = 60_000;
  assert.equal(windows.skipReason('g', 'u'), '窗口已到期（60秒）');
  assert.equal(windows.candidate('g', 'u'), undefined);
  windows.close('g', 'u', 'ended');
  assert.equal(windows.skipReason('g', 'u'), '用户已结束对话，窗口关闭');
  assert.equal(windows.skipReason('g', 'stranger'), '没有开放窗口');
});

test('close and disconnect clear invalidate in-flight observations', () => {
  const windows = new ObservationWindows();
  const ticket = windows.incoming('g', 'u');
  windows.open(ticket);
  const first = windows.candidate('g', 'u')!;
  windows.close('g', 'u');
  assert.equal(first(), false);
  windows.open(ticket);
  const second = windows.candidate('g', 'u')!;
  windows.clear();
  assert.equal(second(), false);
});

test('two successful automatic replies exhaust quota without extending the window', () => {
  let now = 0;
  const windows = new ObservationWindows(() => now);
  const ticket = windows.incoming('g', 'u');
  windows.open(ticket);
  const first = windows.candidate('g', 'u')!;
  now = 1000;
  assert.equal(first.consume(), true);
  assert.equal(windows.candidate('g', 'u')!.consume(), true);
  assert.equal(windows.candidate('g', 'u'), undefined);
  assert.equal(first.consume(), false);
  windows.close('g', 'u');
  windows.open(ticket);
  assert.equal(first(), false);
  assert.ok(windows.candidate('g', 'u'));
  now = 61_000;
  assert.equal(windows.candidate('g', 'u'), undefined);
});

test('capacity eviction keeps the most recently used windows', () => {
  const windows = new ObservationWindows(undefined, 60_000, 2);
  windows.open(windows.incoming('g', 'a'));
  windows.open(windows.incoming('g', 'b'));
  windows.open(windows.incoming('g', 'c'));
  assert.equal(windows.candidate('g', 'a'), undefined);
  assert.ok(windows.candidate('g', 'b'));
  assert.ok(windows.candidate('g', 'c'));
});

test('six windows is the configured ceiling and evicts the oldest', () => {
  const windows = new ObservationWindows(undefined, 60_000, 6);
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) windows.open(windows.incoming('g', name));
  assert.ok(windows.candidate('g', 'a'));
  windows.open(windows.incoming('g', 'seven'));
  assert.equal(windows.candidate('g', 'a'), undefined);
  assert.ok(windows.candidate('g', 'seven'));
  assert.ok(windows.candidate('g', 'f'));
});
