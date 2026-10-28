import { DatabaseSync } from 'node:sqlite';
// Historical schema fixture only. Active service code never reads this table.
export function writeLegacySession(path: string, key: string, text: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE sessions(key TEXT PRIMARY KEY, group_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, touched INTEGER NOT NULL, seq INTEGER NOT NULL, turns TEXT NOT NULL);
      CREATE INDEX sessions_seq ON sessions(seq);`);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(key, 'private:123', '123', Date.now(), 1,
      JSON.stringify([{ role: 'user', content: text }]));
  } finally { db.close(); }
}
export function readLegacySession(path: string, key: string) {
  const db = new DatabaseSync(path);
  try { return db.prepare('SELECT * FROM sessions WHERE key=?').get(key); }
  finally { db.close(); }
}
