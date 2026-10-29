import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { TerminalEditor } from './terminal-editor.js';
import { TerminalScreen } from '../testing/terminal-screen.js';
function fixture(accept = true) {
  const raw: boolean[] = [], input = Object.assign(new PassThrough(), { isRaw: false, setRawMode(value: boolean) { this.isRaw = value; raw.push(value); } });
  const screen = new TerminalScreen(), submitted: string[] = [], warnings: string[] = []; let stopped = false, ended = false;
  const editor = new TerminalEditor(input, screen, text => { submitted.push(text); return accept; }, () => { stopped = true; editor.close(); }, () => { ended = true; editor.close(); }, text => warnings.push(text));
  const send = async (text: string | Buffer) => { input.write(text); await new Promise(resolve => setImmediate(resolve)); };
  return { input, screen, editor, submitted, warnings, raw, send, stopped: () => stopped, ended: () => ended };
}
test('multiline arrows, home/end and deletion submit edited text with indentation intact', async () => {
  const f = fixture();
  try {
    await f.send('第一行\n  abc\x1b[H\x1b[A\x1b[F\x7f段\r');
    assert.deepEqual(f.submitted, ['第一段\n  abc']);
    await f.send('前👨‍👩‍👧‍👦e\u0301后\x1b[D\x7f\x1b[D\x1b[3~\r');
    assert.equal(f.submitted[1], '前后');
    await f.send('keep\x1b\rnext\x01\x0b\tend\r'); assert.equal(f.submitted[2], 'keep\n  end');
    await f.send('a\n\u0301\x1b[H\x7f\x1b[A\r'); assert.equal(f.submitted[3], 'a\u0301');
  } finally { f.editor.close(); }
});
test('split bracketed paste and UTF-8 never submit embedded commands or newlines', async () => {
  const f = fixture();
  try {
    const pasted = Buffer.from('\x1b[200~/exit\r\n/cancel\r\n中文🐳\x1b[201~');
    for (const byte of pasted) await f.send(Buffer.of(byte));
    assert.equal(f.submitted.length, 0); assert.equal(f.stopped(), false);
    await f.send('\r'); assert.deepEqual(f.submitted, ['/exit\n/cancel\n中文🐳']);
  } finally { f.editor.close(); }
});
test('draft replacement stays bounded, removes stale text and preserves cursor editing across resize', async () => {
  const f = fixture();
  try {
    await f.send('first\nsecond\x1b[D');
    for (let i = 0; i < 100; i++) f.editor.setDraft('stale ' + '正文'.repeat(500) + i);
    assert(f.screen.visible().split('\n').length <= f.screen.rows - 2);
    f.editor.setDraft('replacement'); assert(!f.screen.visible().includes('stale')); assert(f.screen.visible().includes('replacement'));
    f.editor.message(() => f.screen.write('服务通知\r\n'));
    assert(f.screen.visible().includes('服务通知')); assert(f.screen.visible().includes('first'));
    f.screen.columns = 12; f.screen.rows = 6; f.screen.emit('resize');
    await f.send('X\r'); assert.deepEqual(f.submitted, ['first\nseconXd']);
    f.editor.setDraft(''); assert(!f.screen.visible().includes('replacement'));
    assert(f.screen.visible().includes('服务通知'));
  } finally { f.editor.close(); }
});
test('busy submission retains the editable buffer; cancellation shortcut does not consume it', async () => {
  const f = fixture(false);
  try {
    await f.send('keep\nthis\r'); assert(f.screen.visible().includes('keep'));
    await f.send('\x18'); assert.equal(f.submitted.at(-1), '/cancel');
    await f.send('\x7fX\r'); assert.equal(f.submitted.at(-1), 'keep\nthiX');
  } finally { f.editor.close(); }
});
test('oversized paste is rejected atomically and EOF never submits an unsent edit', async () => {
  const f = fixture();
  try {
    await f.send('keep\x1b[200~' + 'x'.repeat(8001) + '\x1b[201~');
    assert.equal(f.warnings.length, 1); await f.send('\r'); assert.deepEqual(f.submitted, ['keep']);
    await f.send('unsent\nbody'); f.input.end(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.ended(), true); assert.equal(f.submitted.length, 1); assert(f.warnings.some(text => text.includes('丢弃')));
    assert.deepEqual(f.raw, [true, false]); assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.screen.listenerCount('resize'), 0);
  } finally { f.editor.close(); }
});
test('interrupt inside an unfinished paste restores terminal mode and removes drafts', async () => {
  const f = fixture(); f.editor.setDraft('provisional'); await f.send('\x1b[200~incomplete'); await f.send('\x03');
  assert.equal(f.stopped(), true); assert.deepEqual(f.raw, [true, false]); assert(!f.screen.visible().includes('provisional')); assert.equal(f.submitted.length, 0);
});
test('untrusted draft controls cannot erase committed output or alter the input buffer', async () => {
  const f = fixture();
  try {
    f.editor.message(() => f.screen.write('committed answer\r\n')); await f.send('unsent');
    f.editor.setDraft('draft\x1b[2J\x1b]0;injected\x07 safe');
    assert(f.screen.visible().includes('committed answer')); assert(f.screen.visible().includes('draft safe')); assert(!f.screen.visible().includes('injected'));
    f.editor.setDraft(''); await f.send('\r'); assert.deepEqual(f.submitted, ['unsent']);
  } finally { f.editor.close(); }
});
test('screen write failure during close still restores raw input and removes listeners', async () => {
  const f = fixture(); const write = f.screen.write;
  try {
    f.screen.write = (() => { throw Error('closed output'); }) as typeof write;
    assert.throws(() => f.editor.close(), /closed output/);
    assert.deepEqual(f.raw, [true, false]); assert.equal(f.input.listenerCount('data'), 0); assert.equal(f.screen.listenerCount('resize'), 0);
  } finally { f.screen.write = write; f.editor.close(); }
});
