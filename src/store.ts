import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChatTurn, SessionStore, StoredSession } from './memory.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    key TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    touched INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    turns TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_seq ON sessions(seq);
`;

// SQLite-backed session store. The API is synchronous so the conversation
// memory keeps the same shape it had when it lived in a Map.
export class SqliteSessionStore implements SessionStore {
  private readonly db: DatabaseSync;
  private readonly selectOne: StatementSync;
  private readonly upsert: StatementSync;
  private readonly remove: StatementSync;
  private readonly expire: StatementSync;
  private readonly trim: StatementSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.selectOne = this.db.prepare('SELECT touched, turns FROM sessions WHERE key = ?');
    // seq makes least-recently-used eviction deterministic even within one millisecond.
    this.upsert = this.db.prepare(`INSERT INTO sessions (key, group_id, sender_id, touched, seq, turns)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sessions), ?)
      ON CONFLICT(key) DO UPDATE SET touched = excluded.touched, seq = excluded.seq, turns = excluded.turns`);
    this.remove = this.db.prepare('DELETE FROM sessions WHERE key = ?');
    this.expire = this.db.prepare('DELETE FROM sessions WHERE touched <= ?');
    this.trim = this.db.prepare('DELETE FROM sessions WHERE key NOT IN (SELECT key FROM sessions ORDER BY seq DESC LIMIT ?)');
  }

  load(key: string): StoredSession | undefined {
    const row = this.selectOne.get(key);
    if (!row) return undefined;
    try {
      const turns = JSON.parse(String(row.turns)) as ChatTurn[];
      if (!Array.isArray(turns)) return undefined;
      return { touched: Number(row.touched), turns };
    } catch {
      return undefined;
    }
  }

  save(key: string, groupId: string, senderId: string, turns: ChatTurn[], touched: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.upsert.run(key, groupId, senderId, touched, JSON.stringify(turns));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  delete(key: string): void {
    this.remove.run(key);
  }

  prune(before: number, keep: number): void {
    this.expire.run(before);
    this.trim.run(keep);
  }

  close(): void {
    this.db.close();
  }
}
