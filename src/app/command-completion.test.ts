import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completeCommand } from './command-completion.js';
import { parseTaskArguments } from './task-arguments.js';
const candidates = (text: string, cursor = text.length) => completeCommand(text, cursor)?.candidates;
test('completion covers interactive commands and shared task statuses without changing execution', () => {
  assert.deepEqual(candidates('/'), ['/help', '/list', '/tasks', '/new', '/use', '/history', '/retry', '/resume', '/cancel', '/exit']);
  assert.deepEqual(candidates('/res'), ['/resume']); assert.deepEqual(candidates('/r'), ['/retry', '/resume']);
  const states = ['active', 'all', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
  for (const state of states) { assert(candidates('/tasks ' + state)?.includes(state)); assert.equal(parseTaskArguments([state], true).query.status, state); }
  assert.deepEqual(candidates('/tasks c'), ['completed', 'cancelled']);
});
test('task flag completion honors grammar, mutual exclusion, required values and right-hand tokens', () => {
  assert.deepEqual(candidates('/tasks --'), ['--here', '--conversation']);
  assert.deepEqual(candidates('/tasks failed --h'), ['--here']);
  assert.deepEqual(candidates('/tasks completed --conversation '), []);
  assert.deepEqual(candidates('/tasks failed --here '), []);
  assert.deepEqual(candidates('/tasks --conversation owned '), []);
  assert.deepEqual(candidates('/tasks more '), []);
  assert.deepEqual(candidates('/tasks --l'), []); assert.deepEqual(candidates('/tasks finished '), []);
  const text = '/tasks --co owned'; const value = completeCommand(text, '/tasks --co'.length)!;
  assert.deepEqual(value, { start: 7, end: 11, candidates: ['--conversation'] });
  assert.deepEqual(candidates('/tasks  --here', 7), ['active', 'all', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);
  assert.deepEqual(candidates('/tasks fa --conversation', '/tasks fa'.length), ['failed']);
});
test('literal, multiline, paste-like and identifier input never receives command or identity suggestions', () => {
  for (const text of ['hello', '//tasks', '/tasks\nfailed', 'text /help']) assert.equal(completeCommand(text, text.length), undefined);
  for (const text of ['/use ', '/resume #', '/new title', '/tasks --conversation secret']) assert.deepEqual(candidates(text), []);
  assert.equal(completeCommand('/help', -1), undefined); assert.equal(completeCommand('/help', 99), undefined);
});
