import type { ObservationReceipt } from '../../cognitive/observation-types.js';
import type { ReplyContext } from '../conversation/context.js';
import type { ChatTurn } from '../../memory/memory.js';

export type FollowUpIntent = 'continue' | 'pause' | 'end' | 'uncertain';
export interface FollowUpDecision { observation?: ObservationReceipt; intent: FollowUpIntent; shouldRespond: boolean; reason: string }
export type FollowUpJudge = (content: string, history: ChatTurn[], signal?: AbortSignal, context?: ReplyContext) => Promise<FollowUpDecision>;
export interface WindowState {
  chatId: string;
  sender: string;
  until: number;
  used: number;
  version: number;
  closedReason: 'no_window' | 'closed' | 'ended';
}
export type FollowUpCandidate = (() => boolean) & { consume: () => boolean };

// A window is anchored to an acknowledged bot reply and belongs to one
// participant in one chat. Another member speaking is not an interruption.
export class ObservationWindows {
  private windows = new Map<string, WindowState>();
  constructor(private now = Date.now, private duration = 60_000, private maxWindows = 100, private maxReplies = 2) {}

  private key(chatId: string, sender: string): string {
    return JSON.stringify([chatId, sender]);
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

  incoming(chatId: string, sender: string): WindowState {
    const key = this.key(chatId, sender);
    const existing = this.windows.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const state: WindowState = { chatId, sender, until: 0, used: 0, version: 0, closedReason: 'no_window' };
    this.touch(key, state);
    this.evict();
    return state;
  }

  open(ticket: WindowState): void {
    const key = this.key(ticket.chatId, ticket.sender);
    if (this.windows.get(key) !== ticket) return;
    ticket.until = this.now() + this.duration;
    ticket.used = 0;
    ticket.version++;
    ticket.closedReason = 'closed';
    this.touch(key, ticket);
  }

  close(chatId: string, sender: string, reason: 'closed' | 'ended' = 'closed'): void {
    const state = this.windows.get(this.key(chatId, sender));
    if (!state) return;
    state.until = 0;
    state.version++;
    state.closedReason = reason;
  }

  clear(): void { this.windows.clear(); }

  skipReason(chatId: string, sender: string): string | undefined {
    const state = this.windows.get(this.key(chatId, sender));
    if (!state) return '没有开放窗口';
    if (state.until === 0) {
      if (state.closedReason === 'ended') return '用户已结束对话，窗口关闭';
      if (state.closedReason === 'no_window') return '没有开放窗口';
      return '窗口已关闭，等待明确呼叫';
    }
    if (state.until <= this.now()) return '窗口已到期（60秒）';
    if (state.used >= this.maxReplies) return '自动接话额度已用完（2次）';
    return undefined;
  }

  candidate(chatId: string, sender: string): FollowUpCandidate | undefined {
    const key = this.key(chatId, sender);
    const state = this.windows.get(key);
    if (!state || state.until <= this.now() || state.used >= this.maxReplies) return undefined;
    const deadline = state.until;
    const version = state.version;
    const valid = () => this.windows.get(key) === state && state.until === deadline &&
      state.version === version && deadline > this.now() && state.used < this.maxReplies;
    return Object.assign(valid, { consume: () => {
      if (!valid()) return false;
      state.used++;
      return true;
    } });
  }
}
