import type { ChatTurn } from './memory.js';

export type FollowUpIntent = 'continue' | 'pause' | 'end' | 'uncertain';
export interface FollowUpDecision { intent: FollowUpIntent; shouldRespond: boolean; reason: string }
export type FollowUpJudge = (content: string, history: ChatTurn[]) => Promise<FollowUpDecision>;
interface WindowState { sender: string; until: number; used: number; version: number; closedReason: 'no_window' | 'interrupted' | 'closed' | 'ended' }
export type FollowUpCandidate = (() => boolean) & { consume: () => boolean };

// A window is anchored to an acknowledged bot reply, never extended by observations.
export class ObservationWindows {
  private groups = new Map<string, WindowState>();
  constructor(private now = Date.now, private duration = 60_000, private onInterrupt: () => void = () => {}) {}

  incoming(group: string, sender: string): WindowState {
    for (const [key, state] of this.groups) {
      if (state.until <= this.now() && key !== group) this.groups.delete(key);
    }
    let state = this.groups.get(group);
    if (!state || state.sender !== sender) {
      const interrupted = !!state && state.until > this.now();
      const closedReason = interrupted ? 'interrupted' : state?.closedReason ?? 'no_window';
      if (interrupted) this.onInterrupt();
      state = { sender, until: 0, used: 0, version: 0, closedReason };
      this.groups.set(group, state);
    }
    while (this.groups.size > 100) this.groups.delete(this.groups.keys().next().value!);
    return state;
  }

  open(group: string, ticket: WindowState): void {
    if (this.groups.get(group) === ticket) { ticket.until = this.now() + this.duration; ticket.used = 0; ticket.version++; ticket.closedReason = 'closed'; }
  }

  close(group: string, reason: 'closed' | 'ended' = 'closed'): void { const state = this.groups.get(group); if (state) { state.until = 0; state.version++; state.closedReason = reason; } }
  clear(): void { this.groups.clear(); }

  skipReason(group: string, sender: string): string | undefined {
    const state = this.groups.get(group);
    if (!state) return '没有开放窗口';
    if (state.until === 0) return ({ no_window: '没有开放窗口', interrupted: '他人已插话，窗口结束', closed: '窗口已关闭，等待明确呼叫', ended: '用户已结束对话，窗口关闭' })[state.closedReason];
    if (state.sender !== sender) return '不是窗口所属用户';
    if (state.until <= this.now()) return '窗口已到期（60秒）';
    if (state.used >= 2) return '自动接话额度已用完（2次）';
    return undefined;
  }

  candidate(group: string, sender: string): FollowUpCandidate | undefined {
    const state = this.groups.get(group);
    if (!state || state.sender !== sender || state.until <= this.now() || state.used >= 2) return undefined;
    const deadline = state.until;
    const version = state.version;
    const valid = () => this.groups.get(group) === state && state.until === deadline && state.version === version && deadline > this.now() && state.used < 2;
    return Object.assign(valid, { consume: () => {
      if (!valid()) return false;
      state.used++;
      return true;
    } });
  }
}
