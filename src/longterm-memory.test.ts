import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from './events/store.js';
import { createEventDomain } from './events/domains/event.js';
import { profileDomain } from './events/domains/profile.js';
import { presentPersonalRecall } from './events/domains/event-recall.js';
import { createPersonalRecall } from './events/personal-recall.js';
import { createArchiveSummarizer } from './events/summarize.js';
import { EventMemoryRuntime } from './events/runtime.js';
import { eventControls } from './events/controls.js';
import type { Scope } from './events/types.js';
const at=Date.parse('2026-10-26T10:00:00+08:00'),year=365*86400000;
const scope={chatId:'10',ownerId:'2'};
const signal=()=>new AbortController().signal;
let next=0;
function profile(store:EventStore,value:string,place:Scope=scope,operation='record',time=at){
  const text=operation==='retract'?'忘掉我的职业':`我的职业是${value}`;
  store.ingest({...place,messageId:`profile-${++next}`,text,sourceAt:time,receivedAt:time});
  const batch=store.claim(time+4000)!;
  const input={sources:batch.sources,existing:store.retainedRecords(place,time),now:time+4000};
  const mutations=profileDomain.interpret([{operation,field:'职业',value:operation==='retract'?null:value,source:'source-1',quote:text}],input);
  store.commit(batch,mutations,[profileDomain],time+4000,()=>0);
}
function event(store:EventStore){
  store.ingest({...scope,messageId:`event-${++next}`,text:'明天考试',sourceAt:at,receivedAt:at});
  const batch=store.claim(at+4000)!;const domain=createEventDomain();
  const mutations=domain.interpret([{operation:'record',target:null,assertion:'stated',topic:'考试',summary:'计划明天考试',
    statement:{source:'source-1',text:'明天考试'},start:{source:'source-1',text:'明天'},duration:null,anchors:[],followup:null}],
    {sources:batch.sources,existing:[],now:at+4000});
  store.commit(batch,mutations,[domain],at+4000,()=>0);
}

test('expiration retains historical events and evidence across years without claiming completion',t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());event(store);
  const proof=store.records(scope,at+5000)[0].evidenceIds;
  store.prune(at+2*year);
  assert.equal(store.records(scope,at+2*year).length,0);
  const historical=store.retainedRecords(scope,at+2*year)[0];assert.equal(historical.status,'historical');
  const evidence=store.recallEvidence(scope,proof,at+2*year);assert.equal(evidence.length,1);
  const document=presentPersonalRecall(historical,evidence,'memory-1')!;
  assert.equal((document.facts as {phase:string}).phase,'historical');
  assert.match(JSON.stringify(document),/计划明天考试/);
  assert.ok(store.archive.revisions(scope).some(r=>r.status==='historical'));
});

test('profile corrections and retractions retain prior values and exact evidence',t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());profile(store,'设计师');
  profile(store,'程序员',scope,'correct',at+10000);
  assert.equal((store.archive.profiles('2')[0] as {value:string}).value,'程序员');
  const current=store.retainedRecords(scope,at+20000)[0];assert.equal(current.version,2);
  const revisions=store.archive.revisions(scope);
  assert.ok(revisions.some(r=>r.status==='superseded'&&(r.payload as {value:string}).value==='设计师'));
  assert.ok(revisions.some(r=>(r.payload as {value:string}).value==='程序员'));
  assert.equal(store.recallEvidence(scope,current.evidenceIds,at+2*year).length,2);
  profile(store,'',scope,'retract',at+30000);
  assert.equal(store.archive.profiles('2').length,0);assert.equal(store.retainedRecords(scope,at+40000).length,0);
  const retracted=store.archive.revisions(scope).find(r=>r.status==='retracted')!;
  assert.equal(retracted.version,3);assert.equal(store.recallEvidence(scope,retracted.evidenceIds,at+year).length,3);
});

test('archive survives restart, deduplicates inputs and keeps windows/users separate',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-longterm-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'memory.db');let store=new EventStore(path);
  profile(store,'设计师');
  store.archive.append(scope,'user','one','讨论方案',at);
  store.archive.append(scope,'user','one','重复事件',at);
  store.archive.append(scope,'assistant','two','已经回答',at+1000,'one');
  store.archive.append({chatId:'private:2',ownerId:'2'},'user','one','私聊秘密',at);
  store.archive.append({chatId:'10',ownerId:'3'},'user','one','另一个人',at);
  store.close();store=new EventStore(path);t.after(()=>store.close());store.prune(at+2*year);
  assert.equal(store.archive.interactions(scope).length,2);
  assert.equal(store.archive.state(scope)?.kind,'group');
  assert.equal(store.archive.state({chatId:'private:2',ownerId:'2'})?.kind,'private');
  assert.equal(store.archive.profiles('2').length,1);
  assert.equal(store.archive.summaries(scope,0).length,1);
  const record=store.retainedRecords(scope,at+2*year)[0];assert.equal(record.domain,'profile');
  assert.equal(store.recallEvidence(scope,record.evidenceIds,at+2*year).length,1);
});

test('summaries retain sources, update window state and reject stale/cleared jobs',t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());
  store.archive.append(scope,'user','one','周五再看方案',at);
  const first=store.archive.nextSummary(at+31000)!;
  store.archive.append(scope,'assistant','two','好，周五继续',at+1000);
  assert.equal(store.archive.finishSummary(first,[{kind:'topic',text:'旧摘要',sources:[first.interactions[0].id]}]),false);
  const job=store.archive.nextSummary(at+32000)!;
  assert.throws(()=>store.archive.finishSummary(job,[{kind:'topic',text:'伪造引用',sources:['other-window']}]),/summary_evidence/);
  const items=[{kind:'topic' as const,text:'讨论方案',sources:[job.interactions[0].id]},
    {kind:'open_item' as const,text:'约定周五继续讨论',sources:job.interactions.map(r=>r.id)}];
  assert.equal(store.archive.finishSummary(job,items),true);
  assert.deepEqual(store.archive.state(scope)?.openItems,['约定周五继续讨论']);
  const summary=store.archive.summaries(scope,0)[0];assert.equal(summary.evidenceIds.length,2);
  assert.equal(store.recallEvidence(scope,summary.evidenceIds,at+year).length,2);
  store.archive.append(scope,'user','three','新内容',at+5000);
  const late=store.archive.nextSummary(at+36000)!;store.clear(scope);
  assert.equal(store.archive.finishSummary(late,items),false);
  assert.equal(store.archive.interactions(scope).length,0);assert.equal(store.archive.state(scope),undefined);
});

test('semantic summary errors retain extractive history; segments remain bounded',t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());
  for(let i=0;i<25;i++)store.archive.append(scope,i%2?'assistant':'user',`msg-${i}`,`消息${i}`,at+i);
  assert.equal(store.archive.summaries(scope,0).length,3);
  const job=store.archive.nextSummary(at+31000)!;
  store.archive.finishSummary(job,undefined);
  assert.equal(store.archive.interactions(scope).length,25);
  assert.ok(store.archive.summaries(scope,0).every(r=>r.evidenceIds.length<=12));
});

test('private profiles never reach group selector and summaries never cross windows even with disclosure',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());
  profile(store,'设计师');profile(store,'程序员',{chatId:'private:2',ownerId:'2'});
  store.archive.append({chatId:'private:2',ownerId:'2'},'user','p','私聊职业和另一件秘密',at);
  store.archive.append({chatId:'20',ownerId:'2'},'user','g','另一个群的上下文',at);
  const make=(allowed:boolean)=>createPersonalRecall(store,async q=>{
    assert.ok(!q.records.some(r=>(r.facts as {type:string}).type==='conversation_summary'));
    assert.equal(q.records.length,allowed?2:1);return q.records.map(r=>r.id);
  },presentPersonalRecall,new Set(['10','20']),async()=>allowed?'职业':undefined,()=>at+2*year);
  assert.equal((await make(false)({...scope,text:'我是谁',history:[]},signal())).view.records.length,1);
  const shared=await make(true)({...scope,text:'我私聊提过的职业',history:[]},signal());
  assert.equal(shared.view.records.length,2);assert.ok(!JSON.stringify(shared.view).includes('另一件秘密'));
});

test('owner-wide deletion erases profiles, archive, summaries, revisions and queued extraction',t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());profile(store,'设计师');
  const privateScope={chatId:'private:2',ownerId:'2'};profile(store,'程序员',privateScope);
  for(const place of [scope,privateScope])store.archive.append(place,'user','one','长期内容',at);
  eventControls.handle('/清空个人长期记忆',scope,store,at+5000);
  for(const place of [scope,privateScope]){
    assert.equal(store.archive.interactions(place).length,0);assert.equal(store.archive.revisions(place).length,0);
    assert.equal(store.archive.summaries(place,store.epoch(place)).length,0);assert.equal(store.retainedRecords(place,at+year).length,0);
  }
  assert.equal(store.archive.profiles('2').length,0);
});

test('v2 migration preserves current facts/proofs and imports retained inbox sources exactly once',t=>{
  const dir=mkdtempSync(join(tmpdir(),'qq-v2-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'memory.db');let store=new EventStore(path);profile(store,'设计师');store.close();
  const db=new DatabaseSync(path);
  for(const name of ['interaction_log','chat_states','chat_summaries','summary_revisions','person_profiles','memory_revisions'])db.exec(`DROP TABLE ${name}`);
  db.exec('UPDATE event_schema_version SET version=2');db.close();
  store=new EventStore(path);
  assert.equal(store.archive.profiles('2').length,1);assert.equal(store.archive.interactions(scope).length,1);
  const record=store.retainedRecords(scope,at+year)[0];assert.equal(store.recallEvidence(scope,record.evidenceIds,at+year).length,1);
  store.close();store=new EventStore(path);t.after(()=>store.close());
  assert.equal(store.archive.interactions(scope).length,1);assert.equal(store.archive.revisions(scope).length,1);
});

test('oversized input stays archived without entering model extraction',()=>{
  const store=new EventStore(':memory:');
  const runtime=new EventMemoryRuntime(store,[],async()=>({}),{groups:new Set(['10']),scope:'addressed',mode:'observe'},
    eventControls,undefined,()=>at,()=>0,()=>{});runtime.resume();
  runtime.ingest({chatId:'10',senderId:'2',messageId:'long',content:'字'.repeat(6000),isMentioned:true,timestamp:at});
  assert.equal(store.archive.interactions(scope)[0].text.length,6000);assert.equal(store.claim(at+5000),undefined);
  runtime.delivered(scope,'确认送达','reply','long');assert.equal(store.archive.interactions(scope)[1].role,'assistant');
  runtime.close();
});

test('summarizer aliases source IDs, rejects forged citations and never includes other windows',async()=>{
  const job={...scope,id:'internal-summary',version:1,interactions:[{...scope,id:'internal-proof',messageId:'message-1',
    role:'user' as const,text:'周五继续',at,seq:1}]};
  const summarize=createArchiveSummarizer('key','model',async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.ok(!JSON.stringify(body).includes('internal-proof'));
    return Response.json({choices:[{message:{content:JSON.stringify({items:[{kind:'open_item',text:'周五继续',sources:['line-1']}]})}}]});
  });
  assert.deepEqual((await summarize(job,signal()))[0].sources,['internal-proof']);
  const bad=createArchiveSummarizer('key','model',async()=>Response.json({choices:[{message:{content:JSON.stringify({items:[{kind:'topic',text:'编造',sources:['line-2']}]})}}]}));
  await assert.rejects(bad(job,signal()),/archive_summary_evidence/);
});

test('background summary selection honors enabled scopes and summaries invalidate recalled drafts when updated',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());
  store.archive.append({chatId:'99',ownerId:'2'},'user','blocked','已移除群的内容',at);
  store.archive.append(scope,'user','allowed','当前窗口的方案',at+1);
  const job=store.archive.nextSummary(at+32000,place=>place.chatId==='10')!;
  assert.equal(job.chatId,'10');
  const recall=createPersonalRecall(store,async q=>q.records.map(r=>r.id),presentPersonalRecall,new Set(['10']),async()=>undefined,()=>at+32000);
  const result=await recall({...scope,text:'之前的方案',history:[]},signal());
  assert.equal(result.isCurrent(),true);
  const serialized=JSON.stringify(result.view);
  assert.ok(!serialized.includes(job.interactions[0].id));assert.ok(!serialized.includes('已移除群'));
  store.archive.finishSummary(job,[{kind:'topic',text:'当前窗口讨论方案',sources:[job.interactions[0].id]}]);
  assert.equal(result.isCurrent(),false);
});
