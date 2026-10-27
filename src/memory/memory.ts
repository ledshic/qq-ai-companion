export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface StoredSession {
  turns: ChatTurn[];
  touched: number;
}

// Persistence is delegated: the memory policy stays independent of the backend.
export interface SessionStore {
  load(key: string): StoredSession | undefined;
  save(key: string, chatId: string, senderId: string, turns: ChatTurn[], touched: number): void;
  delete(key: string): void;
  prune(before: number, keep: number): void;
  close(): void;
}

// Sessions are isolated by group and sender; this class owns expiry, turn
// limits and capacity, and makes no network requests.
export class ConversationMemory {
  constructor(private store: SessionStore, private now = Date.now,
    private ttl = 30 * 60_000, private maxTurns = 9, private maxSessions = 100) {}

  private key(chatId: string, senderId: string): string {
    return JSON.stringify([chatId, senderId]);
  }

  get(chatId: string, senderId: string): ChatTurn[] {
    const key = this.key(chatId, senderId);
    const session = this.store.load(key);
    if (!session) return [];
    if (this.now() - session.touched >= this.ttl) {
      this.store.delete(key);
      return [];
    }
    return session.turns.map(turn => ({ ...turn }));
  }

  add(chatId: string, senderId: string, prompt: string, reply: string): void {
    const turns: ChatTurn[] = [...this.get(chatId, senderId),
      { role: 'user', content: prompt }, { role: 'assistant', content: reply }];
    const now = this.now();
    this.store.save(this.key(chatId, senderId), chatId, senderId, turns.slice(-this.maxTurns * 2), now);
    this.store.prune(now - this.ttl, this.maxSessions);
  }

  clear(chatId: string, senderId: string): void {
    this.store.delete(this.key(chatId, senderId));
  }

  close(): void {
    this.store.close();
  }
}
