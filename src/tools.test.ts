import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTool, type ToolContext } from './tools.js';

const context = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  now: () => Date.parse('2026-10-22T02:30:00Z'),
  random: () => 0.5,
  timeZone: 'Asia/Shanghai',
  ...overrides,
});

test('current time is rendered in the requested timezone', () => {
  assert.match(runTool('get_current_time', '{}', context()), /10:30:00/);
  assert.match(runTool('get_current_time', '{}', context()), /2026/);
  assert.match(runTool('get_current_time', '{"timezone":"UTC"}', context()), /02:30:00/);
  assert.match(runTool('get_current_time', '{"timezone":"Not/AZone"}', context()), /无法识别的时区/);
});

test('dice rolls are deterministic for a fixed random source', () => {
  assert.equal(runTool('roll_dice', '{"count":2,"sides":6}', context()), '2d6 = 4 + 4 = 8');
  assert.equal(runTool('roll_dice', '{}', context()), '1d6 = 4 = 4');
  assert.equal(runTool('roll_dice', '{"count":99,"sides":1}', context()), '10d2 = 2 + 2 + 2 + 2 + 2 + 2 + 2 + 2 + 2 + 2 = 20');
});

test('bad arguments and unknown tools are reported as text, not thrown', () => {
  assert.match(runTool('roll_dice', '{oops', context()), /不是合法 JSON/);
  assert.match(runTool('rm_rf', '{}', context()), /未知工具/);
});
