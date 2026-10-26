import { parseStoredScope, stringifyStoredScope } from './storage-scope.js';
import { PersonalArchive, FOREVER } from './archive.js';
import { projectAttentions } from './attention-policy.js';
import { extractionBudget, allowsInitiative } from './budget-policy.js';
import { migrateEventPayloadsV2 } from './migrations/v2.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attention, Batch, EventDomain, EventRecord, Mutation, Scope, Source } from './types.js';
const DAY=86_400_000;
const key=(s:Scope)=>[s.chatId,s.ownerId];
export class EventStore {
  private db:DatabaseSync;
  readonly archive:PersonalArchive;
  constructor(path:string) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;');
    try { this.transaction(()=>{
      this.db.exec(`CREATE TABLE IF NOT EXISTS event_schema_version(version INTEGER NOT NULL);
        INSERT INTO event_schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM event_schema_version);`);
      const version=this.db.prepare('SELECT version FROM event_schema_version').get() as {version:number};
      if(![1,2,3].includes(version.version))throw Error('unsupported_event_schema');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS event_seen(group_id TEXT,message_id TEXT,received_at INTEGER,PRIMARY KEY(group_id,message_id));
        CREATE TABLE IF NOT EXISTS event_scope_settings(group_id TEXT,owner_id TEXT,body TEXT,PRIMARY KEY(group_id,owner_id));
        CREATE TABLE IF NOT EXISTS event_scope_epochs(group_id TEXT,owner_id TEXT,epoch INTEGER NOT NULL,PRIMARY KEY(group_id,owner_id));
        CREATE TABLE IF NOT EXISTS event_inbox(id TEXT PRIMARY KEY,group_id TEXT,owner_id TEXT,message_id TEXT,
          text TEXT NOT NULL,source_at INTEGER,received_at INTEGER NOT NULL,epoch INTEGER NOT NULL,status TEXT NOT NULL,batch_id TEXT,
          UNIQUE(group_id,message_id));
        CREATE INDEX IF NOT EXISTS event_inbox_pending ON event_inbox(status,received_at);
        CREATE TABLE IF NOT EXISTS event_batches(id TEXT PRIMARY KEY,group_id TEXT,owner_id TEXT,epoch INTEGER,created_at INTEGER,status TEXT);
        CREATE INDEX IF NOT EXISTS event_batches_budget ON event_batches(group_id,created_at);
        CREATE TABLE IF NOT EXISTS event_memories(id TEXT PRIMARY KEY,group_id TEXT,owner_id TEXT,domain TEXT,business_key TEXT,
          version INTEGER,epoch INTEGER,status TEXT,created_at INTEGER,updated_at INTEGER,expires_at INTEGER,body TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS event_active_key ON event_memories(group_id,owner_id,domain,business_key) WHERE status='active';
        CREATE INDEX IF NOT EXISTS event_owner ON event_memories(group_id,owner_id,status,expires_at);
        CREATE TABLE IF NOT EXISTS event_evidence(id TEXT PRIMARY KEY,group_id TEXT,owner_id TEXT,message_id TEXT,source_at INTEGER,excerpt TEXT,expires_at INTEGER);
        CREATE TABLE IF NOT EXISTS attention_items(id TEXT PRIMARY KEY,event_id TEXT,kind TEXT,occurrence_at INTEGER,status TEXT,expires_at INTEGER,body TEXT,
          UNIQUE(event_id,kind,occurrence_at));
        CREATE TABLE IF NOT EXISTS attention_observations(attention_id TEXT,event_version INTEGER,group_id TEXT,owner_id TEXT,
          started_at INTEGER,body TEXT,PRIMARY KEY(attention_id,event_version));
        CREATE INDEX IF NOT EXISTS attention_observation_budget ON attention_observations(group_id,started_at);
        CREATE INDEX IF NOT EXISTS attention_due ON attention_items(status,expires_at);
      `);
      if(version.version===1)migrateEventPayloadsV2(this.db);
      const archive=new PersonalArchive(this.db);
      if(version.version<3){
        this.db.prepare('UPDATE event_evidence SET expires_at=?').run(FOREVER);
        for(const row of this.db.prepare("SELECT * FROM event_inbox WHERE text<>'' AND status<>'cleared'").all()){
          archive.append({chatId:String(row.group_id),ownerId:String(row.owner_id)},'user',String(row.message_id),
            String(row.text),Number(row.source_at??row.received_at));
        }
        for(const row of this.db.prepare('SELECT body FROM event_memories').all()){
          const record=parseStoredScope(String(row.body)) as EventRecord;
          archive.revision(record,record.updatedAt);archive.projectProfile(record);
        }
        this.db.exec('UPDATE event_schema_version SET version=3');
      }
    }); } catch(error) { this.db.close(); throw error; }
    this.archive=new PersonalArchive(this.db);
  }
  private transaction<T>(run:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');try{const value=run();this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  epoch(scope:Scope):number {
    return Number(this.db.prepare('SELECT epoch FROM event_scope_epochs WHERE group_id=? AND owner_id=?').get(...key(scope))?.epoch??0);
  }
  markSeen(chatId:string,messageId:string,now:number):boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO event_seen VALUES(?,?,?)').run(chatId,messageId,now).changes)>0;
  }
  ingest(source:Omit<Source,'id'|'status'|'epoch'>):boolean {
    return this.transaction(()=>{
      const count=this.db.prepare("SELECT COUNT(*) n FROM event_inbox WHERE group_id=? AND status IN ('pending','processing')").get(source.chatId)!;
      if(Number(count.n)>=100)return false;
      const r=this.db.prepare(`INSERT OR IGNORE INTO event_inbox VALUES(?,?,?,?,?,?,?,?,'pending',NULL)`)
        .run(randomUUID(),source.chatId,source.ownerId,source.messageId,source.text,source.sourceAt,source.receivedAt,this.epoch(source));
      return Number(r.changes)>0;
    });
  }
  // Called once by the single-instance host. Interrupted network requests are not silently retried.
  recover():void {
    this.transaction(()=>{
      for(const attempt of this.initiatives())if(!attempt.result)this.finishInitiative(attempt,{status:'interrupted',reason:'process_restarted'},Date.now());
      this.db.exec("UPDATE event_batches SET status='interrupted' WHERE status='processing'; UPDATE event_inbox SET status='failed' WHERE status='processing'");
    });
  }
  claim(now:number):Batch|undefined {
    return this.transaction(()=>{
      const rows=this.db.prepare("SELECT * FROM event_inbox WHERE status='pending' AND received_at>? ORDER BY received_at,id LIMIT 100").all(now-DAY);
      for(const first of rows) {
        const scope={chatId:String(first.group_id),ownerId:String(first.owner_id)};
        const siblings=rows.filter(r=>r.group_id===first.group_id&&r.owner_id===first.owner_id&&r.epoch===first.epoch);
        const last=siblings.at(-1)!;
        if(now-Number(last.received_at)<3000 && now-Number(first.received_at)<10000 && siblings.length<10)continue;
        const budget=extractionBudget(now);
        const calls=Number(this.db.prepare('SELECT COUNT(*) n FROM event_batches WHERE group_id=? AND created_at>=?').get(scope.chatId,budget.since)!.n);
        if(calls>=budget.limit)continue;
        const sources:Source[]=[];let length=0;
        for(const r of siblings.slice(0,10)) {
          const text=String(r.text);if(length+text.length>4000)break;length+=text.length;
          sources.push({id:String(r.id),...scope,messageId:String(r.message_id),text,sourceAt:r.source_at===null?null:Number(r.source_at),
            receivedAt:Number(r.received_at),epoch:Number(r.epoch),status:'processing'});
        }
        if(!sources.length)continue;
        const batch:Batch={id:randomUUID(),...scope,epoch:Number(first.epoch),sources};
        this.db.prepare("INSERT INTO event_batches VALUES(?,?,?,?,?,'processing')").run(batch.id,...key(scope),batch.epoch,now);
        for(const s of sources)this.db.prepare("UPDATE event_inbox SET status='processing',batch_id=? WHERE id=? AND status='pending'").run(batch.id,s.id);
        return batch;
      }
    });
  }
  // Includes cleared scopes so an in-flight cross-chat recall can detect deletion.
  ownerScopes(ownerId:string):Scope[] {
    return this.db.prepare(`SELECT group_id FROM event_memories WHERE owner_id=?
      UNION SELECT group_id FROM event_scope_epochs WHERE owner_id=?
      UNION SELECT group_id FROM event_inbox WHERE owner_id=?
      UNION SELECT group_id FROM chat_states WHERE owner_id=?`).all(ownerId,ownerId,ownerId,ownerId)
      .map(row=>({chatId:String(row.group_id),ownerId}));
  }
  records(scope:Scope,now:number):EventRecord[] {
    return this.db.prepare("SELECT body FROM event_memories WHERE group_id=? AND owner_id=? AND status='active' AND expires_at>? ORDER BY created_at,id")
      .all(...key(scope),now).map(r=>parseStoredScope(String(r.body)) as EventRecord);
  }
  retainedRecords(scope:Scope,now:number):EventRecord[] {
    return this.db.prepare("SELECT body FROM event_memories WHERE group_id=? AND owner_id=? AND status IN ('active','historical') ORDER BY updated_at DESC,id")
      .all(...key(scope)).map(row=>{
        const record=parseStoredScope(String(row.body)) as EventRecord;
        return record.status==='active'&&record.expiresAt<=now?{...record,status:'historical' as const}:record;
      });
  }
  recallRecords(scope:Scope,now:number):EventRecord[] {
    return [...this.retainedRecords(scope,now),...this.archive.summaries(scope,this.epoch(scope))];
  }
  recallEvidence(scope:Scope,ids:string[],now:number):import('./recall-types.js').StoredRecallEvidence[] {
    if(!ids.length)return [];
    return this.db.prepare(`SELECT id,source_at,excerpt FROM event_evidence WHERE group_id=? AND owner_id=? AND id IN (${ids.map(()=>'?').join(',')}) ORDER BY source_at,id`)
      .all(...key(scope),...ids).map(r=>({id:String(r.id),sourceAt:r.source_at===null?null:Number(r.source_at),excerpt:String(r.excerpt)})).concat(this.archive.evidence(scope,ids));
  }
  evidence(scope:Scope):unknown[] {
    return this.db.prepare('SELECT message_id,source_at,excerpt FROM event_evidence WHERE group_id=? AND owner_id=?').all(...key(scope));
  }
  finish(batch:Batch,status:'failed'|'cancelled'):void {
    this.transaction(()=>{
      this.db.prepare("UPDATE event_batches SET status=? WHERE id=? AND status='processing'").run(status,batch.id);
      this.db.prepare("UPDATE event_inbox SET status=? WHERE batch_id=? AND status='processing'").run(status,batch.id);
    });
  }
  commit(batch:Batch,mutations:Mutation[],domains:EventDomain[],now:number,random:()=>number):boolean {
    return this.transaction(()=>{
      if(this.epoch(batch)!==batch.epoch)return false;
      if(this.db.prepare('SELECT status FROM event_batches WHERE id=?').get(batch.id)?.status!=='processing')return false;
      const allowed=new Set(batch.sources.map(s=>s.id));
      for(const m of mutations) {
        if(!m.evidenceIds.length||m.evidenceIds.some(id=>!allowed.has(id)))throw Error('event_evidence_scope');
        if(m.excerpts&&Object.entries(m.excerpts).some(([id,text])=>!allowed.has(id)||text.length>500||!batch.sources.find(s=>s.id===id)?.text.includes(text)))throw Error('event_evidence_scope');
        if(!Number.isFinite(m.expiresAt)||m.expiresAt<=now)throw Error('event_expiry');
        let target:EventRecord|undefined;
        if(m.targetId)target=this.retainedRecords(batch,now).find(e=>e.id===m.targetId&&e.domain===m.domain);
        if(m.operation!=='upsert'&&!target)throw Error('event_target_scope');
        if(target&&m.expectedVersion!==target.version)throw Error('event_target_scope');
        let previous=this.retainedRecords(batch,now).find(e=>e.domain===m.domain&&e.businessKey===m.businessKey);
        if(target && m.operation==='replace' && previous && previous.id!==target.id)throw Error('event_conflicting_target');
        for(const id of m.evidenceIds){const s=batch.sources.find(s=>s.id===id)!;
          this.db.prepare('INSERT OR IGNORE INTO event_evidence VALUES(?,?,?,?,?,?,?)').run(s.id,...key(batch),s.messageId,s.sourceAt,m.excerpts?.[id]??s.text.slice(0,500),FOREVER);}
        if(previous)this.archive.revision(previous,now);
        if(m.operation==='retract') {
          this.deactivate({...target!,version:target!.version+1,updatedAt:now,
            evidenceIds:[...new Set([...target!.evidenceIds,...m.evidenceIds])]},'retracted',now);continue;
        }
        if(target) {this.deactivate(target,'superseded',now);previous=target;}
        // Capacity is independent of domain semantics.
        const scopeCount=this.records(batch,now).length;
        const groupCount=Number(this.db.prepare("SELECT COUNT(*) n FROM event_memories WHERE group_id=? AND status='active'").get(batch.chatId)!.n);
        if(!previous&&(scopeCount>=20||groupCount>=200))throw Error('event_capacity');
        const record:EventRecord={chatId:batch.chatId,ownerId:batch.ownerId,epoch:batch.epoch,id:previous?.id??randomUUID(),domain:m.domain,businessKey:m.businessKey,
          version:(previous?.version??0)+1,payload:m.payload,evidenceIds:[...new Set([...(previous?.evidenceIds??[]),...m.evidenceIds])],
          status:'active',createdAt:previous?.createdAt??now,updatedAt:now,expiresAt:m.expiresAt};
        const previousPlans=this.attentions(batch).filter(a=>a.eventId===record.id);
        this.db.prepare(`INSERT INTO event_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          business_key=excluded.business_key,version=excluded.version,status=excluded.status,updated_at=excluded.updated_at,expires_at=excluded.expires_at,body=excluded.body`)
          .run(record.id,...key(batch),record.domain,record.businessKey,record.version,record.epoch,record.status,record.createdAt,now,record.expiresAt,stringifyStoredScope(record));
        const projection=projectAttentions(record,previousPlans,domains,now,random,randomUUID);
        for(const attention of projection.upserts) {
          this.db.prepare(`INSERT INTO attention_items VALUES(?,?,?,?,?,?,?) ON CONFLICT(event_id,kind,occurrence_at)
            DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,body=excluded.body`)
            .run(attention.id,record.id,attention.kind,attention.occurrenceAt,attention.status,attention.expiresAt,stringifyStoredScope(attention));
        }
        for(const old of projection.cancellations)this.cancelAttention(old);
        this.archive.revision(record,now);
        this.archive.projectProfile(record);
      }
      this.db.prepare("UPDATE event_batches SET status='done' WHERE id=?").run(batch.id);
      this.db.prepare("UPDATE event_inbox SET status='done' WHERE batch_id=?").run(batch.id);return true;
    });
  }
  private deactivate(event:EventRecord,status:'superseded'|'retracted',changedAt:number):void {
    const changed={...event,status};
    this.db.prepare('UPDATE event_memories SET status=?,version=?,updated_at=?,body=? WHERE id=?').run(status,event.version,event.updatedAt,stringifyStoredScope(changed),event.id);
    this.archive.revision(changed,changedAt);
    this.archive.projectProfile(changed);
    for(const item of this.attentions(event).filter(a=>a.eventId===event.id))this.cancelAttention(item);
  }
  cancelScope(scope:Scope):void {
    for(const item of this.attentions(scope))if(item.status==='pending')this.cancelAttention(item);
  }
  private cancelAttention(item:Attention):void {
    this.db.prepare("UPDATE attention_items SET status='cancelled',body=? WHERE id=?").run(stringifyStoredScope({...item,status:'cancelled'}),item.id);
  }
  attentions(scope?:Scope):Attention[] {
    const items=this.db.prepare('SELECT body FROM attention_items ORDER BY occurrence_at,id').all().map(r=>parseStoredScope(String(r.body)) as Attention);
    return scope?items.filter(a=>a.chatId===scope.chatId&&a.ownerId===scope.ownerId):items;
  }
  observe(id:string,reason:string):boolean {
    const row=this.db.prepare('SELECT body FROM attention_items WHERE id=?').get(id);if(!row)return false;
    const item=parseStoredScope(String(row.body)) as Attention;if(item.observation===reason)return false;
    this.db.prepare('UPDATE attention_items SET body=? WHERE id=?').run(stringifyStoredScope({...item,observation:reason}),id);return true;
  }
  initiatives(scope?:Scope):import('./initiative-types.js').InitiativeAttempt[] {
    const rows=scope?this.db.prepare('SELECT body FROM attention_observations WHERE group_id=? AND owner_id=? ORDER BY started_at').all(...key(scope)):
      this.db.prepare('SELECT body FROM attention_observations ORDER BY started_at').all();
    return rows.map(row=>parseStoredScope(String(row.body)));
  }
  claimInitiative(item:Attention,now:number,contextVersion?:number):import('./initiative-types.js').InitiativeAttempt|undefined {
    return this.transaction(()=>{
      const current=this.attentions(item).find(a=>a.id===item.id);
      if(!current||current.status!=='pending'||current.eventVersion!==item.eventVersion||this.epoch(item)!==item.epoch)return;
      const attempts=this.initiatives();
      if(attempts.some(a=>a.attentionId===item.id&&a.eventVersion===item.eventVersion))return;
      if(!allowsInitiative(item,attempts,now))return;
      const attempt={chatId:item.chatId,ownerId:item.ownerId,attentionId:item.id,eventVersion:item.eventVersion,epoch:item.epoch,startedAt:now,contextVersion,opportunity:{occurrenceAt:item.occurrenceAt,notBefore:item.notBefore,expiresAt:item.expiresAt,tone:item.tone}};
      this.db.prepare('INSERT INTO attention_observations VALUES(?,?,?,?,?,?)').run(item.id,item.eventVersion,...key(item),now,stringifyStoredScope(attempt));
      return attempt;
    });
  }
  finishInitiative(attempt:import('./initiative-types.js').InitiativeAttempt,result:import('./initiative-types.js').InitiativeResult,now:number):void {
    // A clear deletes the row; a late result cannot recreate it.
    this.db.prepare('UPDATE attention_observations SET body=? WHERE attention_id=? AND event_version=? AND group_id=? AND owner_id=?')
      .run(stringifyStoredScope({...attempt,finishedAt:now,result}),attempt.attentionId,attempt.eventVersion,...key(attempt));
  }
  settings(scope:Scope):Record<string,unknown> {
    const row=this.db.prepare('SELECT body FROM event_scope_settings WHERE group_id=? AND owner_id=?').get(...key(scope));
    return row?JSON.parse(String(row.body)):{};
  }
  setSettings(scope:Scope,body:Record<string,unknown>):void {
    this.db.prepare('INSERT INTO event_scope_settings VALUES(?,?,?) ON CONFLICT(group_id,owner_id) DO UPDATE SET body=excluded.body')
      .run(...key(scope),JSON.stringify(body));
  }
  clear(scope:Scope):void {
    this.transaction(()=>{
      this.db.prepare(`INSERT INTO event_scope_epochs VALUES(?,?,1) ON CONFLICT(group_id,owner_id) DO UPDATE SET epoch=epoch+1`).run(...key(scope));
      this.archive.clear(scope);
      for(const a of this.attentions(scope))this.db.prepare('DELETE FROM attention_items WHERE id=?').run(a.id);
      this.db.prepare('DELETE FROM attention_observations WHERE group_id=? AND owner_id=?').run(...key(scope));
      this.db.prepare('DELETE FROM event_scope_settings WHERE group_id=? AND owner_id=?').run(...key(scope));
      this.db.prepare('DELETE FROM event_memories WHERE group_id=? AND owner_id=?').run(...key(scope));
      this.db.prepare('DELETE FROM event_evidence WHERE group_id=? AND owner_id=?').run(...key(scope));
      this.db.prepare("UPDATE event_inbox SET text='',status='cleared' WHERE group_id=? AND owner_id=?").run(...key(scope));
      this.db.prepare("UPDATE event_batches SET status='cancelled' WHERE group_id=? AND owner_id=? AND status='processing'").run(...key(scope));
    });
  }
  prune(now:number):void {
    this.transaction(()=>{
      this.db.prepare("UPDATE event_inbox SET text='',status=CASE WHEN status='pending' THEN 'expired' ELSE status END WHERE received_at<=?").run(now-DAY);
      this.db.prepare('DELETE FROM event_inbox WHERE received_at<=?').run(now-30*DAY);
      this.db.prepare('DELETE FROM event_batches WHERE created_at<=?').run(now-30*DAY);
      this.db.prepare(`DELETE FROM attention_observations WHERE started_at<=? OR attention_id IN (
        SELECT a.id FROM attention_items a LEFT JOIN event_memories e ON a.event_id=e.id WHERE e.id IS NULL OR e.expires_at<=?)`)
        .run(now-30*DAY,now);
      this.db.prepare('DELETE FROM event_seen WHERE received_at<=?').run(now-30*DAY);

      this.db.prepare('DELETE FROM attention_items WHERE expires_at<=?').run(now-30*DAY);
      for(const row of this.db.prepare("SELECT body FROM event_memories WHERE status='active' AND expires_at<=?").all(now)){
        const record={...parseStoredScope(String(row.body)),status:'historical'} as EventRecord;
        this.db.prepare("UPDATE event_memories SET status='historical',body=? WHERE id=?").run(stringifyStoredScope(record),record.id);
        this.archive.revision(record,now);
      }
      // Expiry is terminal and must update both indexed state and serialized state.
      for(const a of this.attentions())if(a.status==='pending'&&a.expiresAt<=now)
        this.db.prepare("UPDATE attention_items SET status='expired',body=? WHERE id=?").run(stringifyStoredScope({...a,status:'expired'}),a.id);
    });
  }
  close():void{this.db.close();}
}
