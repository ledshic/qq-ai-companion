import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  APIError,
  type Conversation,
  type Message,
  type Run,
  type RunPage,
  type RunState,
  type Principal,
  type ServiceEvent,
  type AcceptedMessage,
} from '@companion/contracts/service';

export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export class ServiceStore {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly now = Date.now,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS service_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
      const version = this.one(
        'SELECT value FROM service_meta WHERE key=?',
        'schema',
      );
      if (version && version.value !== '1')
        throw Error('Unsupported service schema');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS service_devices(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,admin INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS service_sessions(hash TEXT PRIMARY KEY,device_id TEXT NOT NULL,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS service_pairings(id TEXT PRIMARY KEY,name TEXT NOT NULL,claim_hash TEXT NOT NULL,expires INTEGER NOT NULL,owner_id TEXT,consumed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS service_conversations(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,title TEXT NOT NULL,channel_id TEXT NOT NULL DEFAULT 'console',kind TEXT NOT NULL DEFAULT 'direct',revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS service_conversations_owner ON service_conversations(owner_id,id);
        CREATE TABLE IF NOT EXISTS service_runs(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,client_message_id TEXT NOT NULL,state TEXT NOT NULL,input TEXT NOT NULL,result TEXT,error TEXT,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,accepted_event INTEGER,UNIQUE(owner_id,conversation_id,client_message_id));
        CREATE INDEX IF NOT EXISTS service_runs_state ON service_runs(state,created_at);
        CREATE TABLE IF NOT EXISTS service_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conversation_id TEXT NOT NULL,run_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS service_memory_policies(conversation_id TEXT PRIMARY KEY,sources TEXT NOT NULL,revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS service_reasoning(message_id TEXT PRIMARY KEY,content TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS service_messages_conversation ON service_messages(conversation_id,seq);
        CREATE TABLE IF NOT EXISTS service_events(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,run_id TEXT NOT NULL,type TEXT NOT NULL,time TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS service_events_owner ON service_events(owner_id,id);
        INSERT OR IGNORE INTO service_meta VALUES('schema','1');`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private time() {
    return new Date(this.now()).toISOString();
  }
  one(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).all(...args);
  }
  exec(sql: string, ...args: SQLInputValue[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  ensureOwner(ownerId: string, deviceId: string, token: string) {
    const stored = this.one(
      'SELECT value FROM service_meta WHERE key=?',
      'owner',
    );
    if (stored && stored.value !== ownerId)
      throw Error('Owner credential does not match service database');
    const existing = this.one(
      'SELECT * FROM service_devices WHERE id=?',
      deviceId,
    );
    if (
      existing &&
      (existing.owner_id !== ownerId ||
        existing.token_hash !== tokenHash(token) ||
        existing.revoked !== 0)
    )
      throw Error('Owner credential mismatch');
    this.transaction(() => {
      this.exec(
        'INSERT OR IGNORE INTO service_meta VALUES(?,?)',
        'owner',
        ownerId,
      );
      this.exec(
        'INSERT OR IGNORE INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,1)',
        deviceId,
        ownerId,
        'Host owner',
        tokenHash(token),
      );
    });
  }
  device(token: string): Principal | undefined {
    const row = this.one(
      'SELECT * FROM service_devices WHERE token_hash=? AND revoked=0',
      tokenHash(token),
    );
    return row
      ? {
          ownerId: String(row.owner_id),
          deviceId: String(row.id),
          admin: row.admin === 1,
        }
      : undefined;
  }
  session(token: string): Principal | undefined {
    const row = this.one(
      'SELECT d.* FROM service_sessions s JOIN service_devices d ON d.id=s.device_id WHERE s.hash=? AND s.expires>? AND d.revoked=0',
      tokenHash(token),
      this.now(),
    );
    return row
      ? {
          ownerId: String(row.owner_id),
          deviceId: String(row.id),
          admin: row.admin === 1,
        }
      : undefined;
  }
  createSession(deviceId: string, token: string) {
    this.exec('DELETE FROM service_sessions WHERE expires<=?', this.now());
    this.exec(
      'INSERT INTO service_sessions VALUES(?,?,?)',
      tokenHash(token),
      deviceId,
      this.now() + 12 * 3600_000,
    );
  }
  removeSession(token: string) {
    this.exec('DELETE FROM service_sessions WHERE hash=?', tokenHash(token));
  }
  devices(ownerId: string) {
    return this.all(
      'SELECT id,name,admin,revoked FROM service_devices WHERE owner_id=?',
      ownerId,
    ).map((row) => ({
      id: String(row.id),
      name: String(row.name),
      admin: row.admin === 1,
      revoked: row.revoked === 1,
    }));
  }
  revoke(ownerId: string, id: string) {
    const row = this.one(
      'SELECT admin FROM service_devices WHERE owner_id=? AND id=?',
      ownerId,
      id,
    );
    if (!row) throw new APIError(404, 'not_found');
    if (row.admin === 1) throw new APIError(409, 'bootstrap_device_protected');
    this.exec(
      'UPDATE service_devices SET revoked=1 WHERE owner_id=? AND id=?',
      ownerId,
      id,
    );
  }
  createPairing(name: string, secret: string) {
    this.exec(
      'DELETE FROM service_pairings WHERE expires<=? OR consumed=1',
      this.now(),
    );
    if (Number(this.one('SELECT COUNT(*) AS n FROM service_pairings')!.n) >= 64)
      throw new APIError(429, 'pairing_limit');
    const id = randomUUID(),
      expires = this.now() + 300_000;
    this.exec(
      'INSERT INTO service_pairings(id,name,claim_hash,expires) VALUES(?,?,?,?)',
      id,
      name,
      tokenHash(secret),
      expires,
    );
    return { id, name, expiresAt: new Date(expires).toISOString() };
  }
  pairings() {
    return this.all(
      'SELECT id,name,expires FROM service_pairings WHERE expires>? AND consumed=0',
      this.now(),
    ).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      expiresAt: new Date(Number(r.expires)).toISOString(),
    }));
  }
  approvePairing(id: string, ownerId: string) {
    const row = this.one(
      'SELECT * FROM service_pairings WHERE id=? AND consumed=0 AND expires>?',
      id,
      this.now(),
    );
    if (!row) throw new APIError(404, 'pairing_not_found');
    if (row.owner_id && row.owner_id !== ownerId)
      throw new APIError(409, 'pairing_already_approved');
    this.exec('UPDATE service_pairings SET owner_id=? WHERE id=?', ownerId, id);
  }
  claimPairing(id: string, secret: string, deviceToken: string) {
    return this.transaction(() => {
      const row = this.one(
        'SELECT * FROM service_pairings WHERE id=? AND consumed=0 AND expires>?',
        id,
        this.now(),
      );
      if (!row || Number(row.attempts) >= 10)
        return { error: 'pairing_not_found' } as const;
      if (row.claim_hash !== tokenHash(secret)) {
        this.exec(
          'UPDATE service_pairings SET attempts=attempts+1 WHERE id=?',
          id,
        );
        return { error: 'pairing_not_found' } as const;
      }
      if (!row.owner_id) return { error: 'pairing_pending' } as const;
      const deviceId = randomUUID();
      this.exec(
        'INSERT INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,0)',
        deviceId,
        String(row.owner_id),
        String(row.name),
        tokenHash(deviceToken),
      );
      this.exec('UPDATE service_pairings SET consumed=1 WHERE id=?', id);
      return { deviceId, token: deviceToken };
    });
  }
  private conversationRow(row: Record<string, unknown>): Conversation {
    return {
      id: String(row.id),
      ownerId: String(row.owner_id),
      channelId: 'console',
      kind: 'direct',
      title: String(row.title),
      createdAt: String(row.created_at),
    };
  }
  conversations(ownerId: string, after: string, limit: number) {
    return this.all(
      'SELECT * FROM service_conversations WHERE owner_id=? AND id>? ORDER BY id LIMIT ?',
      ownerId,
      after,
      limit,
    ).map((row) => this.conversationRow(row));
  }
  conversation(ownerId: string, id: string) {
    const row = this.one(
      'SELECT * FROM service_conversations WHERE owner_id=? AND id=?',
      ownerId,
      id,
    );
    if (!row) throw new APIError(404, 'not_found');
    return this.conversationRow(row);
  }
  createConversation(ownerId: string, title: string) {
    const id = randomUUID();
    this.exec(
      'INSERT INTO service_conversations(id,owner_id,title,created_at) VALUES(?,?,?,?)',
      id,
      ownerId,
      title,
      this.time(),
    );
    return this.conversation(ownerId, id);
  }
  private runRow(row: Record<string, unknown>): Run {
    return {
      id: String(row.id),
      conversationId: String(row.conversation_id),
      clientMessageId: String(row.client_message_id),
      state: row.state as RunState,
      input: String(row.input),
      result: row.result === null ? null : String(row.result),
      error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  run(ownerId: string, id: string): Run {
    const row = this.one(
      'SELECT * FROM service_runs WHERE owner_id=? AND id=?',
      ownerId,
      id,
    );
    if (!row) throw new APIError(404, 'not_found');
    return this.runRow(row);
  }
  runs(ownerId: string, status: 'active' | 'all', before: string | undefined, limit: number, conversationId?: string): RunPage {
    if (conversationId !== undefined) this.conversation(ownerId, conversationId);
    let boundary: number | undefined;
    if (before) {
      const cursor = this.one('SELECT rowid position,conversation_id FROM service_runs WHERE owner_id=? AND id=?', ownerId, before);
      if (!cursor || conversationId !== undefined && cursor.conversation_id !== conversationId) throw new APIError(404, 'not_found');
      boundary = Number(cursor.position);
    }
    const rows = this.all(`SELECT r.id,r.conversation_id,r.state,r.error,r.created_at,r.updated_at,c.title
      FROM service_runs r JOIN service_conversations c ON c.id=r.conversation_id AND c.owner_id=r.owner_id
      WHERE r.owner_id=? ${status === 'active' ? "AND r.state IN ('queued','running')" : ''}
      ${conversationId === undefined ? '' : 'AND r.conversation_id=?'}
      ${boundary === undefined ? '' : 'AND r.rowid < ?'} ORDER BY r.rowid DESC LIMIT ?`,
      ownerId, ...(conversationId === undefined ? [] : [conversationId]), ...(boundary === undefined ? [] : [boundary]), limit + 1);
    const runs = rows.slice(0, limit).map(row => ({ id: String(row.id), conversationId: String(row.conversation_id),
      conversationTitle: String(row.title), state: row.state as RunState, error: row.error === null ? null : String(row.error),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
    return { runs, nextCursor: rows.length > limit ? runs.at(-1)!.id : null };
  }
  private event(
    ownerId: string,
    conversationId: string,
    runId: string,
    type: string,
    data: Record<string, unknown> = {},
  ) {
    const id = Number(
      this.exec(
        'INSERT INTO service_events(owner_id,conversation_id,run_id,type,time,data) VALUES(?,?,?,?,?,?)',
        ownerId,
        conversationId,
        runId,
        type,
        this.time(),
        JSON.stringify(data),
      ).lastInsertRowid,
    );
    this.exec('DELETE FROM service_events WHERE id <= ?', id - 10000);
    return id;
  }
  accepting() {
    return (
      this.one('SELECT value FROM service_meta WHERE key=?', 'accepting')
        ?.value !== 'false'
    );
  }
  pause(paused: boolean) {
    this.exec(
      'INSERT OR REPLACE INTO service_meta VALUES(?,?)',
      'accepting',
      String(!paused),
    );
  }
  accept(
    ownerId: string,
    conversationId: string,
    clientMessageId: string,
    content: string,
  ): AcceptedMessage {
    return this.transaction(() => {
      this.conversation(ownerId, conversationId);
      const existing = this.one(
        'SELECT * FROM service_runs WHERE owner_id=? AND conversation_id=? AND client_message_id=?',
        ownerId,
        conversationId,
        clientMessageId,
      );
      if (existing) {
        if (existing.input !== content)
          throw new APIError(409, 'idempotency_conflict');
        const message = this.one(
          'SELECT id FROM service_messages WHERE run_id=? AND role=?',
          String(existing.id),
          'user',
        )!;
        return {
          messageId: String(message.id),
          runId: String(existing.id),
          eventId: Number(existing.accepted_event),
          duplicate: true,
        };
      }
      if (!this.accepting()) throw new APIError(503, 'runtime_paused');
      if (
        Number(
          this.one(
            "SELECT COUNT(*) n FROM service_runs WHERE state IN ('queued','running') AND conversation_id<>?",
            conversationId,
          )!.n,
        ) >= 256
      )
        throw new APIError(429, 'queue_full');
      for (const previous of this.all(
        "SELECT * FROM service_runs WHERE owner_id=? AND conversation_id=? AND state IN ('queued','running')",
        ownerId,
        conversationId,
      ))
        this.cancel(ownerId, String(previous.id));
      this.exec(
        'UPDATE service_conversations SET revision=revision+1 WHERE owner_id=? AND id=?',
        ownerId,
        conversationId,
      );
      const revision = Number(
        this.one(
          'SELECT revision FROM service_conversations WHERE id=?',
          conversationId,
        )!.revision,
      );
      const runId = randomUUID(),
        messageId = randomUUID(),
        time = this.time();
      this.exec(
        'INSERT INTO service_runs(id,owner_id,conversation_id,client_message_id,state,input,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        runId,
        ownerId,
        conversationId,
        clientMessageId,
        'queued',
        content,
        revision,
        time,
        time,
      );
      this.exec(
        'INSERT INTO service_messages(id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?)',
        messageId,
        conversationId,
        runId,
        'user',
        content,
        time,
      );
      const eventId = this.event(
        ownerId,
        conversationId,
        runId,
        'message.accepted',
        { messageId },
      );
      this.exec(
        'UPDATE service_runs SET accepted_event=? WHERE id=?',
        eventId,
        runId,
      );
      return { messageId, runId, eventId, duplicate: false };
    });
  }
  cancel(ownerId: string, id: string) {
    const run = this.run(ownerId, id);
    if (run.state === 'queued' || run.state === 'running') {
      this.exec(
        'UPDATE service_runs SET state=?,updated_at=? WHERE id=?',
        'cancelled',
        this.time(),
        id,
      );
      this.event(ownerId, run.conversationId, id, 'run.cancelled');
    }
    return this.run(ownerId, id);
  }
  nextQueued() {
    const row = this.one(
      "SELECT * FROM service_runs WHERE state='queued' ORDER BY rowid LIMIT 1",
    );
    return row
      ? { ownerId: String(row.owner_id), run: this.runRow(row) }
      : undefined;
  }
  start(ownerId: string, id: string) {
    const run = this.run(ownerId, id);
    if (run.state !== 'queued') return false;
    this.transaction(() => {
      this.exec(
        'UPDATE service_runs SET state=?,updated_at=? WHERE id=?',
        'running',
        this.time(),
        id,
      );
      this.event(ownerId, run.conversationId, id, 'run.started');
    });
    return true;
  }
  finish(
    ownerId: string,
    id: string,
    result: string | null,
    error: string | null,
    reasoning?: string,
  ) {
    return this.transaction(() => {
      const row = this.one(
        'SELECT r.*,c.revision current_revision FROM service_runs r JOIN service_conversations c ON c.id=r.conversation_id WHERE r.owner_id=? AND r.id=?',
        ownerId,
        id,
      );
      if (
        !row ||
        row.state !== 'running' ||
        row.revision !== row.current_revision
      )
        return false;
      const state = result === null ? 'failed' : 'completed',
        time = this.time();
      this.exec(
        'UPDATE service_runs SET state=?,result=?,error=?,updated_at=? WHERE id=?',
        state,
        result,
        error,
        time,
        id,
      );
      if (result !== null) {
        const messageId = randomUUID();
        this.exec(
          'INSERT INTO service_messages(id,conversation_id,run_id,role,content,created_at) VALUES(?,?,?,?,?,?)',
          messageId,
          String(row.conversation_id),
          id,
          'assistant',
          result,
          time,
        );
        if (reasoning?.trim())
          this.exec('INSERT INTO service_reasoning(message_id,content) VALUES(?,?)', messageId, reasoning.slice(0, 32000));
        this.event(
          ownerId,
          String(row.conversation_id),
          id,
          'message.committed',
          { messageId },
        );
      }
      this.event(
        ownerId,
        String(row.conversation_id),
        id,
        `run.${state}`,
        error ? { error } : {},
      );
      return true;
    });
  }
  interrupt() {
    this.transaction(() => {
      for (const row of this.all(
        "SELECT * FROM service_runs WHERE state IN ('queued','running')",
      )) {
        this.exec(
          'UPDATE service_runs SET state=?,error=?,updated_at=? WHERE id=?',
          'interrupted',
          'host_stopped',
          this.time(),
          String(row.id),
        );
        this.event(
          String(row.owner_id),
          String(row.conversation_id),
          String(row.id),
          'run.interrupted',
        );
      }
    });
  }
  history(ownerId: string, conversationId: string, turns = 9) {
    this.conversation(ownerId, conversationId);
    return this.all(
      "SELECT m.role,m.content FROM service_messages m JOIN service_runs r ON r.id=m.run_id WHERE r.owner_id=? AND r.conversation_id=? AND r.state='completed' ORDER BY m.seq DESC LIMIT ?",
      ownerId,
      conversationId,
      turns * 2,
    )
      .reverse()
      .map((row) => ({
        role: row.role as 'user' | 'assistant',
        content: String(row.content),
      }));
  }
  messages(
    ownerId: string,
    conversationId: string,
    after: number,
    limit: number,
  ) {
    this.conversation(ownerId, conversationId);
    const rows = this.all(
      'SELECT m.*,r.content reasoning FROM service_messages m LEFT JOIN service_reasoning r ON r.message_id=m.id WHERE m.conversation_id=? AND m.seq>? ORDER BY m.seq LIMIT ?',
      conversationId,
      after,
      limit,
    );
    return {
      messages: rows.map((row) => ({
        id: String(row.id),
        conversationId,
        runId: String(row.run_id),
        role: row.role as Message['role'],
        content: String(row.content),
        ...(typeof row.reasoning === 'string' ? { reasoning: row.reasoning } : {}),
        createdAt: String(row.created_at),
      })),
      nextCursor: rows.length ? Number(rows[rows.length - 1]!.seq) : after,
    };
  }
  events(ownerId: string, after: number, limit = 200, conversationId?: string) {
    if (conversationId) this.conversation(ownerId, conversationId);
    const min = Number(
        this.one('SELECT MIN(id) n FROM service_events')?.n ?? 0,
      ),
      max = Number(this.one('SELECT MAX(id) n FROM service_events')?.n ?? 0);
    if (after > max || (after > 0 && min > after + 1))
      throw new APIError(409, 'event_resync_required');
    const rows = conversationId
      ? this.all(
          'SELECT * FROM service_events WHERE owner_id=? AND id>? AND conversation_id=? ORDER BY id LIMIT ?',
          ownerId,
          after,
          conversationId,
          limit,
        )
      : this.all(
          'SELECT * FROM service_events WHERE owner_id=? AND id>? ORDER BY id LIMIT ?',
          ownerId,
          after,
          limit,
        );
    const events: ServiceEvent[] = rows.map((row) => ({
      eventId: Number(row.id),
      conversationId: String(row.conversation_id),
      runId: String(row.run_id),
      type: String(row.type),
      time: String(row.time),
      data: JSON.parse(String(row.data)) as Record<string, unknown>,
    }));
    return {
      events,
      nextCursor:
        rows.length === limit ? events[events.length - 1]!.eventId : max,
    };
  }
  close() {
    this.db.close();
  }
}
