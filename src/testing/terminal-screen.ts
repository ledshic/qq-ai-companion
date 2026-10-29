import { Writable } from 'node:stream';
// Small ANSI screen used to assert visible terminal behavior, not raw redraw bytes.
export class TerminalScreen extends Writable {
  columns = 40; rows = 12; isTTY = true;
  private lines: string[][] = [[]]; private row = 0; private col = 0;
  _write(chunk: Buffer, _encoding: string, done: (error?: Error | null) => void) {
    const text = chunk.toString();
    for (let i = 0; i < text.length;) {
      const escape = text.slice(i).match(/^\x1b\[([?\d;]*)([A-Za-z])/);
      if (escape) {
        const n = Number(escape[1]) || 1;
        if (escape[2] === 'A') this.row = Math.max(0, this.row - n);
        if (escape[2] === 'C') this.col += n;
        if (escape[2] === 'J') { this.lines.length = this.row + 1; this.lines[this.row] = (this.lines[this.row] ?? []).slice(0, this.col); }
        i += escape[0].length; continue;
      }
      const ch = String.fromCodePoint(text.codePointAt(i)!); i += ch.length;
      if (ch === '\r') { this.col = 0; continue; }
      if (ch === '\n') { this.row++; this.lines[this.row] ??= []; continue; }
      if (ch < ' ') continue;
      this.lines[this.row] ??= [];
      if (/\p{Mark}/u.test(ch) || ch === '\u200d') { const column = Math.max(0, this.col - 1); this.lines[this.row]![column] = (this.lines[this.row]![column] ?? '') + ch; continue; }
      this.lines[this.row]![this.col] = ch;
      const wide = ch.codePointAt(0)! >= 0x1100 && (/\p{Script=Han}|\p{Extended_Pictographic}/u.test(ch));
      if (wide) this.lines[this.row]![this.col + 1] = '';
      this.col += wide ? 2 : 1;
    }
    done();
  }
  visible() { return this.lines.map(line => line.join('')).join('\n'); }
}
