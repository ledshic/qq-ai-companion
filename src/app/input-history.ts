// Local editor history only: no files, server messages or process-global storage.
export class InputHistory {
  private entries: string[] = [];
  private chars = 0;
  get length() { return this.entries.length; }
  get(index: number) { return this.entries[index]; }
  record(text: string) {
    if (!text.trim() || /^\s/u.test(text) || text.length > 8000 || this.entries.at(-1) === text) return;
    this.entries.push(text); this.chars += text.length;
    while (this.entries.length > 50 || this.chars > 64000) this.chars -= this.entries.shift()!.length;
  }
  clear() { this.entries = []; this.chars = 0; }
}
