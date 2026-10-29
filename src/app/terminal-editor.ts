import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { completeCommand } from './command-completion.js';
import { InputHistory } from './input-history.js';

type Input = Readable & { isRaw?: boolean; setRawMode?: (enabled: boolean) => unknown };
type Output = Writable & { columns?: number; rows?: number };
const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const segments = (text: string) => [...segmenter.segment(text)];
const clean = (text: string) => stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
function width(text: string) {
  if (/^[\p{Mark}\u200d\ufe0f]+$/u.test(text)) return 0;
  const code = text.codePointAt(0) ?? 0;
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(text) || code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xfe6f || code >= 0xff01 && code <= 0xff60 || code >= 0x20000) ? 2 : 1;
}
function layout(text: string, columns: number, prompt = '') {
  const lines = [prompt], points: { offset: number; row: number; col: number }[] = [];
  let row = 0, col = [...prompt].reduce((n, ch) => n + width(ch), 0);
  for (const item of segments(text)) {
    if (item.segment !== '\n' && col + width(item.segment) > columns) { lines.push(prompt ? '  ' : ''); row++; col = prompt ? 2 : 0; }
    points.push({ offset: item.index, row, col });
    if (item.segment === '\n') { lines.push(prompt ? '| ' : ''); row++; col = prompt ? 2 : 0; }
    else { lines[row] += item.segment; col += width(item.segment); }
  }
  points.push({ offset: text.length, row, col });
  return { lines, points };
}
const keys: Record<string, string> = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left',
  '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'delete',
  '\x1b\r': 'newline', '\x1b\n': 'newline', '\x1b[13;2u': 'newline', '\x1b[27;2;13~': 'newline',
};
const pasteStart = '\x1b[200~', pasteEnd = '\x1b[201~';

// Owns only the live input/draft region. Committed messages stay in scrollback.
export class TerminalEditor {
  private text = ''; private cursor = 0; private draft = ''; private pending = ''; private paste: string | undefined;
  private drawn = false; private cursorRow = 0; private closed = false; private readonly wasRaw: boolean;
  private preferredColumn: number | undefined;
  private completionHint = '';
  private readonly inputHistory = new InputHistory();
  private historyIndex: number | undefined;
  private historyDraft: { text: string; cursor: number } | undefined;
  private historyEdits = new Map<number, { text: string; cursor: number }>();
  private readonly decoder = new StringDecoder('utf8');
  constructor(private input: Input, private output: Output, private submit: (text: string) => boolean,
    private stop: (code?: number) => void, private eof: () => void, private warning: (text: string) => void) {
    this.wasRaw = !!input.isRaw;
    try {
      input.setRawMode?.(true); output.write('\x1b[?2004h');
      input.on('data', this.data); input.on('end', this.end); input.on('error', this.error); output.on('resize', this.resize);
      input.resume(); this.render();
    } catch (error) { try { this.close(); } catch {} throw error; }
  }
  private data = (chunk: Buffer | string) => {
    if (String(chunk) === '\x03') { this.stop(); return; }
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    while (this.pending && !this.closed) {
      if (this.paste !== undefined) {
        const end = this.pending.indexOf(pasteEnd);
        if (end < 0) {
          const keep = Math.min(pasteEnd.length - 1, this.pending.length);
          this.paste += this.pending.slice(0, this.pending.length - keep); this.pending = this.pending.slice(-keep);
          if (this.paste.length > 8000) this.paste = this.paste.slice(0, 8001);
          break;
        }
        const pasted = this.paste + this.pending.slice(0, end); this.pending = this.pending.slice(end + pasteEnd.length); this.paste = undefined;
        this.insert(pasted); continue;
      }
      if (this.pending.startsWith(pasteStart)) { this.pending = this.pending.slice(pasteStart.length); this.paste = ''; continue; }
      const sequence = Object.keys(keys).find(key => this.pending.startsWith(key));
      if (sequence) { this.pending = this.pending.slice(sequence.length); this.key(keys[sequence]!); continue; }
      if (this.pending.startsWith('\x1b')) {
        if ([pasteStart, ...Object.keys(keys)].some(key => key.startsWith(this.pending))) break;
        const escape = this.pending.match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)/);
        if (escape) { this.pending = this.pending.slice(escape[0].length); continue; }
        if (/^\x1b\[[0-?]*[ -/]*$/.test(this.pending) && this.pending.length < 64) break;
        this.pending = this.pending.slice(1); continue;
      }
      const ch = String.fromCodePoint(this.pending.codePointAt(0)!); this.pending = this.pending.slice(ch.length);
      const controls: Record<string, string> = { '\r': 'submit', '\n': 'newline', '\t': 'tab', '\x03': 'stop', '\x04': 'eof', '\x7f': 'backspace', '\b': 'backspace', '\x01': 'home', '\x05': 'end', '\x07': 'clear', '\x15': 'killStart', '\x0b': 'killEnd', '\x18': 'cancel', '\x10': 'historyPrevious', '\x0e': 'historyNext', '\x0f': 'historyReturn' };
      if (controls[ch]) this.key(controls[ch]!); else if (ch >= ' ') this.insert(ch);
    }
    this.snap(); this.render();
  };
  private insert(value: string) {
    this.completionHint = '';
    if (value.length > 8000) { this.warning('输入最多 8000 字符，本次插入未接受。'); return; }
    const safe = clean(value);
    if (this.text.length + safe.length > 8000) { this.warning('输入最多 8000 字符，本次插入未接受。'); return; }
    this.text = this.text.slice(0, this.cursor) + safe + this.text.slice(this.cursor); this.cursor += safe.length;
    this.preferredColumn = undefined;
    this.snap();
  }
  private snap() {
    const part = segments(this.text).find(item => item.index < this.cursor && item.index + item.segment.length > this.cursor);
    if (part) this.cursor = part.index + part.segment.length;
  }
  private detachHistory() { this.historyIndex = undefined; this.historyDraft = undefined; this.historyEdits.clear(); }
  private restoreHistoryDraft() {
    if (!this.historyDraft) return;
    this.text = this.historyDraft.text; this.cursor = this.historyDraft.cursor; this.detachHistory();
  }
  private selectHistory(direction: -1 | 1) {
    if (!this.inputHistory.length || this.historyIndex === undefined && direction === 1) return;
    const next = this.historyIndex === undefined ? this.inputHistory.length - 1 : Math.max(0, this.historyIndex + direction);
    if (next === this.historyIndex) return;
    if (this.historyIndex === undefined) this.historyDraft = { text: this.text, cursor: this.cursor };
    else this.historyEdits.set(this.historyIndex, { text: this.text, cursor: this.cursor });
    if (next >= this.inputHistory.length) { this.restoreHistoryDraft(); return; }
    this.historyIndex = next;
    const entry = this.inputHistory.get(next)!;
    const selected = this.historyEdits.get(next) ?? { text: entry, cursor: entry.length };
    this.text = selected.text; this.cursor = selected.cursor;
  }
  clearInputHistory() { this.inputHistory.clear(); this.detachHistory(); this.completionHint = ''; this.render(); }
  private complete() {
    const result = completeCommand(this.text, this.cursor);
    if (!result) { this.insert('  '); return; }
    this.completionHint = '';
    if (!result.candidates.length) return;
    const unique = result.candidates.length === 1;
    let replacement = result.candidates[0]!;
    for (const candidate of result.candidates.slice(1)) while (!candidate.startsWith(replacement)) replacement = replacement.slice(0, -1);
    const prefix = this.text.slice(result.start, this.cursor);
    if (unique || this.cursor === result.end && replacement.length > prefix.length) {
      const suffix = this.text.slice(result.end), space = unique && !suffix ? ' ' : '';
      const next = this.text.slice(0, result.start) + replacement + space + suffix;
      if (next.length > 8000) { this.warning('输入最多 8000 字符，本次补全未接受。'); return; }
      this.text = next;
      this.cursor = result.start + replacement.length + space.length + (unique && suffix.startsWith(' ') ? 1 : 0);
    }
    if (!unique) this.completionHint = '补全候选：' + result.candidates.join('  ');
  }
  private key(key: string) {
    if (key !== 'tab') this.completionHint = '';
    if (key !== 'up' && key !== 'down') this.preferredColumn = undefined;
    const parts = segments(this.text), previous = parts.filter(item => item.index < this.cursor).at(-1)?.index ?? 0;
    const next = parts.find(item => item.index >= this.cursor);
    const end = next ? next.index + next.segment.length : this.text.length;
    const startLine = this.cursor === 0 ? 0 : this.text.lastIndexOf('\n', this.cursor - 1) + 1;
    const lineEnd = this.text.indexOf('\n', this.cursor); const endLine = lineEnd < 0 ? this.text.length : lineEnd;
    switch (key) {
      case 'submit': {
        const text = this.text;
        if (text.trim() && this.submit(text) && !this.closed) {
          const original = this.historyDraft;
          this.inputHistory.record(text); this.detachHistory();
          this.text = original?.text ?? ''; this.cursor = original?.cursor ?? 0;
        }
        break;
      }
      case 'newline': this.insert('\n'); break;
      case 'tab': this.complete(); break;
      case 'cancel': this.submit('/cancel'); break;
      case 'left': this.cursor = previous; break;
      case 'right': this.cursor = end; break;
      case 'home': this.cursor = startLine; break;
      case 'end': this.cursor = endLine; break;
      case 'backspace': this.text = this.text.slice(0, previous) + this.text.slice(this.cursor); this.cursor = previous; break;
      case 'delete': this.text = this.text.slice(0, this.cursor) + this.text.slice(end); break;
      case 'killStart': this.text = this.text.slice(0, startLine) + this.text.slice(this.cursor); this.cursor = startLine; break;
      case 'killEnd': this.text = this.text.slice(0, this.cursor) + this.text.slice(endLine); break;
      case 'clear': this.text = ''; this.cursor = 0; this.detachHistory(); break;
      case 'historyPrevious': this.selectHistory(-1); break;
      case 'historyNext': this.selectHistory(1); break;
      case 'historyReturn': this.restoreHistoryDraft(); break;
      case 'up': case 'down': {
        const view = layout(this.text, Math.max(4, (this.output.columns ?? 80) - 1), '你> ');
        const current = view.points.find(item => item.offset === this.cursor)!;
        this.preferredColumn ??= current.col;
        const column = this.preferredColumn;
        const candidates = view.points.filter(item => item.row === current.row + (key === 'up' ? -1 : 1));
        if (candidates.length) this.cursor = candidates.reduce((best, item) => Math.abs(item.col - column) < Math.abs(best.col - column) ? item : best).offset;
        break;
      }
      case 'eof': if (!this.text) this.eof(); else this.key('delete'); break;
      case 'stop': this.stop(); break;
    }
    this.snap();
  }
  private end = () => { if (this.text || this.paste !== undefined) this.warning('未发送的编辑内容已丢弃。'); this.eof(); };
  private error = () => { this.warning('输入流读取失败。'); this.stop(1); };
  private resize = () => { this.preferredColumn = undefined; this.render(); };
  setDraft(text: string) { this.draft = clean(text); this.render(); }
  message(write: () => void) { this.erase(); write(); this.render(); }
  private erase() {
    if (!this.drawn) return;
    this.output.write('\r' + (this.cursorRow ? `\x1b[${this.cursorRow}A` : '') + '\x1b[J'); this.drawn = false;
  }
  render() {
    if (this.closed) return;
    this.erase();
    const columns = Math.max(4, (this.output.columns ?? 80) - 1), budget = Math.max(1, (this.output.rows ?? 24) - 2);
    const hintLimit = Math.min(3, Math.max(0, budget - 2));
    const historyHint = this.historyIndex === undefined ? '' : `输入历史 ${this.historyIndex + 1}/${this.inputHistory.length} · Ctrl+O 返回草稿`;
    const hintText = [historyHint, this.completionHint].filter(Boolean).join('\n');
    const hint = hintText && hintLimit ? layout(hintText, columns).lines : [];
    const hints = hint.slice(0, hintLimit);
    if (hint.length > hintLimit && hints.length) hints[hints.length - 1] = layout(this.completionHint ? '…继续输入缩小候选' : '…Ctrl+O 返回草稿', columns).lines[0]!;
    const inputBudget = budget - hints.length;
    const input = layout(this.text, columns, '你> '), cursor = input.points.find(item => item.offset === this.cursor)!;
    const inputLimit = Math.min(input.lines.length, this.draft ? Math.max(Math.min(2, inputBudget), inputBudget - 6) : inputBudget);
    const start = Math.max(0, Math.min(cursor.row - Math.floor(inputLimit / 2), input.lines.length - inputLimit));
    const label = '草稿·未提交';
    const draft = this.draft ? layout(label + '\n' + this.draft, columns).lines : [];
    const available = inputBudget - inputLimit;
    const preview = !available ? [] : draft.length > available ? [...layout(label, columns).lines.slice(0, 1), ...(available > 1 ? draft.slice(-(available - 1)) : [])] : draft;
    const lines = [...preview, ...input.lines.slice(start, start + inputLimit), ...hints];
    this.cursorRow = preview.length + cursor.row - start;
    this.output.write(lines.join('\r\n') + (lines.length - 1 > this.cursorRow ? `\x1b[${lines.length - 1 - this.cursorRow}A` : '') + '\r' + (cursor.col ? `\x1b[${cursor.col}C` : ''));
    this.drawn = true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.erase(); } finally {
      this.input.off('data', this.data); this.input.off('end', this.end); this.input.off('error', this.error); this.output.off('resize', this.resize);
      this.text = ''; this.draft = ''; this.paste = undefined; this.pending = ''; this.completionHint = '';
      this.inputHistory.clear(); this.detachHistory();
      try { this.input.setRawMode?.(this.wasRaw); } finally { this.input.pause(); this.output.write('\x1b[?2004l'); }
    }
  }
}
