import type { ChatTurn } from './memory.js';

export interface FollowUpDecision { shouldRespond: boolean; reason: string }
export type FollowUpJudge = (content: string, history: ChatTurn[]) => Promise<FollowUpDecision>;
interface WindowState { sender: string; until: number }

// A window is anchored to an acknowledged bot reply, never extended by observations.
export class ObservationWindows {
  private groups = new Map<string, WindowState>();
  constructor(private now = Date.now, private duration = 60_000) {}

  incoming(group: string, sender: string): WindowState {
    for (const [key, state] of this.groups) {
      if (state.until <= this.now() && key !== group) this.groups.delete(key);
    }
    let state = this.groups.get(group);
    if (!state || state.sender !== sender) {
      state = { sender, until: 0 };
      this.groups.set(group, state);
    }
    while (this.groups.size > 100) this.groups.delete(this.groups.keys().next().value!);
    return state;
  }

  open(group: string, ticket: WindowState): void {
    if (this.groups.get(group) === ticket) ticket.until = this.now() + this.duration;
  }

  close(group: string): void { const state = this.groups.get(group); if (state) state.until = 0; }
  clear(): void { this.groups.clear(); }

  candidate(group: string, sender: string): (() => boolean) | undefined {
    const state = this.groups.get(group);
    if (!state || state.sender !== sender || state.until <= this.now()) return undefined;
    const deadline = state.until;
    return () => this.groups.get(group) === state && state.until === deadline && deadline > this.now();
  }
}
