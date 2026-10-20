import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObservationWindows } from './observation.js';

test('fixed 60-second window expires without extending on follow-ups', () => {
  let now = 0;
  const windows = new ObservationWindows(() => now);
  const ticket = windows.incoming('g', 'u');
  assert.equal(windows.candidate('g', 'u'), undefined);
  windows.open('g', ticket);
  const valid = windows.candidate('g', 'u')!;
  now = 59_999;
  windows.incoming('g', 'u');
  assert.equal(valid(), true);
  assert.equal(windows.candidate('g', 'other'), undefined);
  now = 60_000;
  assert.equal(valid(), false);
  assert.equal(windows.candidate('g', 'u'), undefined);
});

test('other speakers invalidate windows and cannot reopen a pending old reply', () => {
  const windows = new ObservationWindows();
  const old = windows.incoming('g', 'u');
  windows.open('g', old);
  const valid = windows.candidate('g', 'u')!;
  windows.incoming('other-group', 'other');
  assert.equal(valid(), true);
  windows.incoming('g', 'other');
  windows.open('g', old);
  assert.equal(valid(), false);
  windows.incoming('g', 'u');
  assert.equal(windows.candidate('g', 'u'), undefined);
});

test('close and disconnect clear invalidate in-flight observations', () => {
  const windows = new ObservationWindows();
  const ticket = windows.incoming('g', 'u');
  windows.open('g', ticket);
  const first = windows.candidate('g', 'u')!;
  windows.close('g');
  assert.equal(first(), false);
  windows.open('g', ticket);
  const second = windows.candidate('g', 'u')!;
  windows.clear();
  assert.equal(second(), false);
});
