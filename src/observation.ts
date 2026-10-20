import type { ChatTurn } from './memory.js';

export type FollowUpIntent = 'continue' | 'pause' | 'end' | 'uncertain';
export interface FollowUpDecision { intent: FollowUpIntent; shouldRespond: boolean; reason: string }
export type FollowUpJudge = (content: string, history: ChatTurn[], signal?: AbortSignal) => Promise<FollowUpDecision>;
export interface WindowState {
  group: string;
  sender: string;
  until: number;
  used: number;
  version: number;
  closedReason: 'no_window' | 'closed' | 'ended';
}
export type FollowUpCandidate = (() => boolean) & { consume: () => boolean };

// A window is anchored to an acknowledged bot reply and belongs to one
// participant in one group. Another member speaking is not an interruption.
export class ObservationWindows {
  private windows = new Map<string, WindowState>();
  constructor(private now = Date.now, private duration = 60_000, private maxWindows = 100) {}

  private key(group: string, sender: string): string {
    return JSON.stringify([group, sender]);
  }

  // Re-insert so the least recently used window stays at the front.
  private touch(key: string, state: WindowState): void {
    this.windows.delete(key);
    this.windows.set(key, state);
  }

  private evict(): void {
    while (this.windows.size > this.maxWindows) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) return;
      this.windows.delete(oldest);
    }
  }

  incoming(group: string, sender: string): WindowState {
    const key = this.key(group, sender);
    const existing = this.windows.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const state: WindowState = { group, sender, until: 0, used: 0, version: 0, closedReason: 'no_window' };
    this.touch(key, state);
    this.evict();
    return state;
  }

  open(ticket: WindowState): void {
    const key = this.key(ticket.group, ticket.sender);
    if (this.windows.get(key) !== ticket) return;
    ticket.until = this.now() + this.duration;
    ticket.used = 0;
    ticket.version++;
    ticket.closedReason = 'closed';
    this.touch(key, ticket);
  }

  close(group: string, sender: string, reason: 'closed' | 'ended' = 'closed'): void {
    const state = this.windows.get(this.key(group, sender));
    if (!state) return;
    state.until = 0;
    state.version++;
    state.closedReason = reason;
  }

  clear(): void { this.windows.clear(); }

  skipReason(group: string, sender: string): string | undefined {
    const state = this.windows.get(this.key(group, sender));
    if (!state) return '没有开放窗口';
    if (state.until === 0) {
      if (state.closedReason === 'ended') return '用户已结束对话，窗口关闭';
      if (state.closedReason === 'no_window') return '没有开放窗口';
      return '窗口已关闭，等待明确呼叫';
    }
    if (state.until <= this.now()) return '窗口已到期（60秒）';
    if (state.used >= 2) return '自动接话额度已用完（2次）';
    return undefined;
  }

  candidate(group: string, sender: string): FollowUpCandidate | undefined {
    const key = this.key(group, sender);
    const state = this.windows.get(key);
    if (!state || state.until <= this.now() || state.used >= 2) return undefined;
    const deadline = state.until;
    const version = state.version;
    const valid = () => this.windows.get(key) === state && state.until === deadline &&
      state.version === version && deadline > this.now() && state.used < 2;
    return Object.assign(valid, { consume: () => {
      if (!valid()) return false;
      state.used++;
      return true;
    } });
  }
}
