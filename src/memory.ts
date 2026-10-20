export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

// Local storage only: this module makes no network requests.
export class ConversationMemory {
  private sessions = new Map<string, { turns: ChatTurn[]; touched: number }>();
  constructor(private now = Date.now, private ttl = 30 * 60_000, private maxTurns = 6, private maxSessions = 100) {}

  private key(groupId: string, senderId: string): string {
    return JSON.stringify([groupId, senderId]);
  }

  private prune(): void {
    for (const [key, entry] of this.sessions) {
      if (this.now() - entry.touched >= this.ttl) this.sessions.delete(key);
    }
  }

  get(groupId: string, senderId: string): ChatTurn[] {
    this.prune();
    return this.sessions.get(this.key(groupId, senderId))?.turns.map(turn => ({ ...turn })) ?? [];
  }

  add(groupId: string, senderId: string, prompt: string, reply: string): void {
    this.prune();
    const key = this.key(groupId, senderId);
    const turns: ChatTurn[] = [...this.get(groupId, senderId),
      { role: 'user', content: prompt }, { role: 'assistant', content: reply }];
    this.sessions.delete(key);
    this.sessions.set(key, { turns: turns.slice(-this.maxTurns * 2), touched: this.now() });
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value!);
  }

  clear(groupId: string, senderId: string): void {
    this.sessions.delete(this.key(groupId, senderId));
  }
}
