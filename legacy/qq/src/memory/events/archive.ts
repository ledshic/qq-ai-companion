import { parseStoredScope, stringifyStoredScope } from './storage-scope.js';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { isPrivateChat } from '../../runtime/chat-scope.js';
import type { EventRecord, Scope } from './types.js';

export const FOREVER = 8_000_000_000_000;
export interface Interaction extends Scope {
  id: string; messageId: string; role: 'user' | 'assistant'; text: string;
  at: number; replyTo?: string; seq: number;
}
export interface WindowState extends Scope {
  kind: 'private' | 'group'; lastAt: number; lastSeq: number;
  topic: string; openItems: string[];
}
export interface SummaryItem { kind: 'topic' | 'decision' | 'open_item'; text: string; sources: string[] }
export interface SummaryJob extends Scope { id: string; version: number; interactions: Interaction[] }

// Shares its connection with EventStore, so evidence, projections and deletion are atomic.
export class PersonalArchive {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS interaction_log(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,group_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,message_id TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,
      at INTEGER NOT NULL,reply_to TEXT,visibility TEXT NOT NULL,
      UNIQUE(group_id,owner_id,role,message_id));
      CREATE INDEX IF NOT EXISTS interactions_scope ON interaction_log(group_id,owner_id,seq);
      CREATE TABLE IF NOT EXISTS chat_states(group_id TEXT,owner_id TEXT,kind TEXT,last_at INTEGER,
        last_seq INTEGER,topic TEXT,open_items TEXT,PRIMARY KEY(group_id,owner_id));
      CREATE TABLE IF NOT EXISTS chat_summaries(id TEXT PRIMARY KEY,group_id TEXT,owner_id TEXT,
        start_seq INTEGER,end_seq INTEGER,version INTEGER,created_at INTEGER,updated_at INTEGER,
        body TEXT,source_ids TEXT,status TEXT);
      CREATE INDEX IF NOT EXISTS summaries_scope ON chat_summaries(group_id,owner_id,end_seq);
      CREATE TABLE IF NOT EXISTS summary_revisions(id TEXT PRIMARY KEY,summary_id TEXT,group_id TEXT,owner_id TEXT,version INTEGER,body TEXT,source_ids TEXT,changed_at INTEGER);
      CREATE TABLE IF NOT EXISTS person_profiles(owner_id TEXT,group_id TEXT,field TEXT,value TEXT,
        record_id TEXT,version INTEGER,updated_at INTEGER,visibility TEXT,
        PRIMARY KEY(owner_id,group_id,field));
      CREATE TABLE IF NOT EXISTS memory_revisions(id TEXT PRIMARY KEY,record_id TEXT,group_id TEXT,
        owner_id TEXT,version INTEGER,status TEXT,changed_at INTEGER,body TEXT);
      CREATE INDEX IF NOT EXISTS revisions_scope ON memory_revisions(group_id,owner_id,record_id,changed_at);`);
  }
  private atomic<T>(run:()=>T):T {
    this.db.exec('SAVEPOINT personal_archive_write');
    try{const result=run();this.db.exec('RELEASE personal_archive_write');return result;}
    catch(error){this.db.exec('ROLLBACK TO personal_archive_write; RELEASE personal_archive_write');throw error;}
  }
  append(scope: Scope, role: Interaction['role'], messageId: string, text: string, at: number, replyTo?: string): void {
    this.atomic(()=>this.appendInside(scope,role,messageId,text,at,replyTo));
  }
  private appendInside(scope: Scope, role: Interaction['role'], messageId: string, text: string, at: number, replyTo?: string): void {
    if (!text.trim()) return;
    const result=this.db.prepare(`INSERT OR IGNORE INTO interaction_log
      (id,group_id,owner_id,message_id,role,text,at,reply_to,visibility) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(),scope.chatId,scope.ownerId,messageId,role,text,at,replyTo??null,isPrivateChat(scope.chatId)?'private':'group');
    if (!result.changes) return;
    const seq=Number(result.lastInsertRowid),previous=this.state(scope);
    this.db.prepare(`INSERT INTO chat_states VALUES(?,?,?,?,?,?,?) ON CONFLICT(group_id,owner_id) DO UPDATE SET
      last_at=excluded.last_at,last_seq=excluded.last_seq,topic=excluded.topic`)
      .run(scope.chatId,scope.ownerId,isPrivateChat(scope.chatId)?'private':'group',at,seq,
        role==='user'?text.slice(0,160):previous?.topic??'',JSON.stringify(previous?.openItems??[]));
    const last=this.db.prepare('SELECT * FROM chat_summaries WHERE group_id=? AND owner_id=? ORDER BY end_seq DESC LIMIT 1')
      .get(scope.chatId,scope.ownerId);
    const continuation=last&&
      this.interactions(scope,Number(last.start_seq),Number(last.end_seq)).length<12&&at-Number(last.updated_at)<30*60_000;
    if(continuation)this.keepSummaryRevision(last,at);
    const start=continuation?Number(last.start_seq):seq;
    const rows=this.interactions(scope,start,seq);
    const items=rows.map(row=>({kind:'topic' as const,text:`${row.role==='user'?'用户':'机器人'}：${row.text.slice(0,160)}`,sources:[row.id]}));
    this.db.prepare(`INSERT INTO chat_summaries VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      end_seq=excluded.end_seq,version=excluded.version,updated_at=excluded.updated_at,body=excluded.body,
      source_ids=excluded.source_ids,status=excluded.status`)
      .run(continuation?String(last.id):randomUUID(),scope.chatId,scope.ownerId,start,seq,
        continuation?Number(last.version)+1:1,continuation?Number(last.created_at):at,at,
        JSON.stringify(items),JSON.stringify(rows.map(row=>row.id)),'pending');
  }
  interactions(scope: Scope,start=0,end=Number.MAX_SAFE_INTEGER): Interaction[] {
    return this.db.prepare(`SELECT * FROM interaction_log WHERE group_id=? AND owner_id=? AND seq>=? AND seq<=? ORDER BY seq`)
      .all(scope.chatId,scope.ownerId,start,end).map(row=>({ ...scope,id:String(row.id),messageId:String(row.message_id),
        role:row.role as Interaction['role'],text:String(row.text),at:Number(row.at),seq:Number(row.seq),
        ...(row.reply_to?{replyTo:String(row.reply_to)}:{}) }));
  }
  state(scope: Scope): WindowState | undefined {
    const row=this.db.prepare('SELECT * FROM chat_states WHERE group_id=? AND owner_id=?').get(scope.chatId,scope.ownerId);
    return row?{...scope,kind:row.kind as WindowState['kind'],lastAt:Number(row.last_at),lastSeq:Number(row.last_seq),
      topic:String(row.topic),openItems:JSON.parse(String(row.open_items))}:undefined;
  }
  nextSummary(now=Date.now(),accept:(scope:Scope)=>boolean=()=>true): SummaryJob | undefined {
    const row=this.db.prepare(`SELECT * FROM chat_summaries s WHERE status='pending' AND (updated_at<=? OR
      (SELECT count(*) FROM interaction_log i WHERE i.group_id=s.group_id AND i.owner_id=s.owner_id AND i.seq BETWEEN s.start_seq AND s.end_seq)>=12)
      ORDER BY updated_at`).all(now-30_000).find(row=>accept({chatId:String(row.group_id),ownerId:String(row.owner_id)}));
    if (!row) return;
    const scope={chatId:String(row.group_id),ownerId:String(row.owner_id)};
    return {...scope,id:String(row.id),version:Number(row.version),interactions:this.interactions(scope,Number(row.start_seq),Number(row.end_seq))};
  }
  private keepSummaryRevision(row:Record<string,unknown>,at:number):void {
    this.db.prepare('INSERT INTO summary_revisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),String(row.id),String(row.group_id),
      String(row.owner_id),Number(row.version),String(row.body),String(row.source_ids),at);
  }
  finishSummary(job: SummaryJob,items: SummaryItem[] | undefined): boolean {
    return this.atomic(()=>this.finishSummaryInside(job,items));
  }
  private finishSummaryInside(job: SummaryJob,items: SummaryItem[] | undefined): boolean {
    const row=this.db.prepare('SELECT * FROM chat_summaries WHERE id=? AND version=?').get(job.id,job.version);
    if (!row) return false; // A clear or newly appended message wins over a late model result.
    if (!items) {this.db.prepare("UPDATE chat_summaries SET status='extractive' WHERE id=?").run(job.id);return true;}
    const known=new Set(job.interactions.map(row=>row.id));
    if(!items.length||items.some(item=>!item.sources.length||item.sources.some(id=>!known.has(id))))throw Error('summary_evidence');
    this.keepSummaryRevision(row,Date.now());
    this.db.prepare("UPDATE chat_summaries SET body=?,version=version+1,status='summarized' WHERE id=?").run(JSON.stringify(items),job.id);
    const state=this.state(job);
    if (state?.lastSeq===Number(row.end_seq)) this.db.prepare('UPDATE chat_states SET topic=?,open_items=? WHERE group_id=? AND owner_id=?')
      .run(items.find(i=>i.kind==='topic')?.text??state.topic,JSON.stringify(items.filter(i=>i.kind==='open_item').map(i=>i.text)),job.chatId,job.ownerId);
    return true;
  }
  summaries(scope: Scope,epoch: number): EventRecord[] {
    return this.db.prepare('SELECT * FROM chat_summaries WHERE group_id=? AND owner_id=? ORDER BY end_seq DESC')
      .all(scope.chatId,scope.ownerId).map(row=>({...scope,id:String(row.id),domain:'conversation',businessKey:String(row.id),
        version:Number(row.version),epoch,status:'active',createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),expiresAt:FOREVER,
        evidenceIds:JSON.parse(String(row.source_ids)),payload:{type:'conversation_summary',items:JSON.parse(String(row.body)),
          method:row.status==='summarized'?'semantic':'extractive'}}));
  }
  evidence(scope:Scope,ids:string[]):{id:string;sourceAt:number;excerpt:string}[] {
    if (!ids.length) return [];
    return this.db.prepare(`SELECT id,at,text,role FROM interaction_log WHERE group_id=? AND owner_id=? AND id IN (${ids.map(()=>'?').join(',')})`)
      .all(scope.chatId,scope.ownerId,...ids).map(row=>({id:String(row.id),sourceAt:Number(row.at),excerpt:`${row.role==='user'?'用户':'机器人'}：${String(row.text).slice(0,480)}`}));
  }
  revision(record: EventRecord,at:number):void {
    this.db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),record.id,record.chatId,record.ownerId,
      record.version,record.status,at,stringifyStoredScope(record));
  }
  projectProfile(record:EventRecord):void {
    if (record.domain!=='profile') return;
    const payload=record.payload as {field:string;value:string};
    if (record.status!=='active') {
      this.db.prepare('DELETE FROM person_profiles WHERE record_id=?').run(record.id);return;
    }
    this.db.prepare(`INSERT INTO person_profiles VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,group_id,field) DO UPDATE SET
      value=excluded.value,record_id=excluded.record_id,version=excluded.version,updated_at=excluded.updated_at`)
      .run(record.ownerId,record.chatId,payload.field,payload.value,record.id,record.version,record.updatedAt,isPrivateChat(record.chatId)?'private':'group');
  }
  profiles(ownerId:string):unknown[] {
    return this.db.prepare('SELECT * FROM person_profiles WHERE owner_id=? ORDER BY updated_at DESC').all(ownerId);
  }
  revisions(scope:Scope):EventRecord[] {
    return this.db.prepare('SELECT body FROM memory_revisions WHERE group_id=? AND owner_id=? ORDER BY changed_at,id')
      .all(scope.chatId,scope.ownerId).map(row=>parseStoredScope(String(row.body)) as EventRecord);
  }
  clear(scope:Scope):void {
    for(const table of ['interaction_log','chat_states','chat_summaries','summary_revisions','person_profiles','memory_revisions'])
      this.db.prepare(`DELETE FROM ${table} WHERE group_id=? AND owner_id=?`).run(scope.chatId,scope.ownerId);
  }
}
