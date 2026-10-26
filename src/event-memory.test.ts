import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from './events/store.js';
import { EventMemoryRuntime } from './events/runtime.js';
import { createEventDomain } from './events/domains/event.js';
const eventDomain = createEventDomain();
import { contactDomain } from './events/domains/contact.js';
import { eventControls } from './events/controls.js';
import { eventConfig } from './events/config.js';
import { resolveDate,midnight } from './events/time.js';
import { observeAttention } from './events/observe-policy.js';
import { createEventExtractor } from './events/extractor.js';
import { Semaphore } from './semaphore.js';
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import type { EventDomain,ExtractionInput,Source } from './events/types.js';
const fri=Date.parse('2026-10-23T10:00:00+08:00'),mon=Date.parse('2026-10-26T10:00:00+08:00');
const scope={groupId:'g',ownerId:'a'};
const q=(text:string,source='source-1')=>({source,text});
// Topic-specific examples live in fixtures; the runtime schema is universal.
const proposal=(patch:Record<string,unknown>={})=>{
 const {resume=q('周一'),...rest}=patch;
 return {operation:'record',target:null,assertion:'stated',topic:'休假计划',summary:'休假及后续安排',statement:q('明天休两天，周一上班'),
  start:q('明天'),duration:q('两天'),anchors:resume?[{label:'复工',date:resume,notBeforeEnd:true}]:[],
  followup:{anchor:resume?0:'end',intent:resume?'询问复工近况':'询问休息近况',basis:resume?'stated':'inferred'},...rest};
};
const source=(text='明天休两天，周一上班',id='m1',ownerId='a',groupId='g')=>({groupId,ownerId,messageId:id,text,sourceAt:fri,receivedAt:fri});
function insert(store:EventStore,text='明天休两天，周一上班',id='m1',raw=proposal(),now=fri+4000){
  store.ingest({...source(text,id),receivedAt:now-4000});const batch=store.claim(now)!;
  const ctx={sources:batch.sources,existing:store.records(scope,now),now};
  store.commit(batch,eventDomain.interpret([raw],ctx),[eventDomain],now,()=>.5);return batch;
}

test('vacation date facts and one attention persist; repeated statements keep identity and tone',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());insert(s);
 const event=s.records(scope,fri+4000)[0],item=s.attentions(scope)[0];
 assert.equal((event.payload as any).period.value.startDate,'2026-10-24');
 assert.equal((event.payload as any).anchors[0].date.value.date,'2026-10-26');
 assert.equal(item.notBefore,Date.parse('2026-10-26T09:00:00+08:00'));
 assert.equal((item.payload as any).basis,'stated');
 insert(s,'明天休两天，周一上班','m2',proposal(),fri+8000);
 assert.equal(s.records(scope,fri+8000).length,1);assert.equal(s.attentions(scope).length,1);
 assert.equal(s.attentions(scope)[0].id,item.id);assert.equal(s.attentions(scope)[0].tone,item.tone);
 assert.equal(s.evidence(scope).length,2);
});

test('missing dates, wishes, third-party reports and quoted speech cannot invent a return-to-work date',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());
 insert(s,'明天休两天','1',proposal({statement:q('明天休两天'),resume:null}));
 assert.equal((s.attentions(scope)[0].payload as any).basis,'inferred');
 insert(s,'放两天假','2',proposal({statement:q('放两天假'),start:null,resume:null,duration:q('两天')}),fri+8000);
 assert.equal(s.attentions(scope).length,1);
 for(const text of ['要是能明天休两天就好了','他说他明天休两天','“明天休两天”']){
  const ctx={sources:[{...source(text),id:'source-real',epoch:0,status:'processing'}],existing:[],now:fri};
  assert.deepEqual(eventDomain.interpret([proposal({assertion:'reported',statement:q('明天休两天'),resume:null})],ctx),[]);
 }
});

test('relative dates use original timestamp; unsupported, ambiguous and impossible dates stay unknown',()=>{
 assert.equal(resolveDate('明天',Date.parse('2026-10-23T23:59:59+08:00')),'2026-10-24');
 assert.equal(resolveDate('周一',fri),null);assert.equal(resolveDate('周一',fri,'2026-10-26'),'2026-10-26');
 assert.equal(resolveDate('2026-02-30',fri),null);assert.equal(resolveDate('明天',null),null);
 assert.equal(resolveDate('下周一',fri),'2026-10-26');
});

test('unique correction cancels old attention; ambiguous correction is only a proposal',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());insert(s);const old=s.attentions(scope)[0];
 const text='改了，下周才休';
 insert(s,text,'m2',proposal({operation:'correct',target:'event-1',statement:q(text),start:null,duration:null,resume:null}),fri+8000);
 assert.equal(s.attentions(scope).find(a=>a.id===old.id)!.status,'cancelled');
 assert.equal(s.records(scope,fri+8000).length,1);
 insert(s,text,'m3',proposal({operation:'correct',target:null,statement:q(text),start:null,duration:null,resume:null}),fri+12000);
 assert.equal(s.records(scope,fri+12000).length,2);
 assert.equal(s.attentions(scope).filter(a=>a.status==='pending').length,0);
});

test('fabricated evidence and foreign-scope replacement are rejected atomically',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());s.ingest(source());const batch=s.claim(fri+4000)!;
 const ctx={sources:batch.sources,existing:[],now:fri+4000};
 assert.throws(()=>eventDomain.interpret([proposal({start:q('后天')})],ctx));
 const mutations=eventDomain.interpret([proposal()],ctx);mutations[0].targetId='foreign';mutations[0].operation='replace';
 assert.throws(()=>s.commit(batch,mutations,[eventDomain],fri+4000,()=>0));
 assert.deepEqual(s.records(scope,fri+4000),[]);assert.deepEqual(s.attentions(scope),[]);
});

test('clear removes content and rejects late extraction while retaining source tombstones',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());s.ingest(source());const b=s.claim(fri+4000)!;
 const mutations=eventDomain.interpret([proposal()],{sources:b.sources,existing:[],now:fri+4000});
 s.clear(scope);assert.equal(s.commit(b,mutations,[eventDomain],fri+4000,()=>0),false);
 assert.equal(s.ingest(source()),false);assert.equal(s.epoch(scope),1);assert.deepEqual(s.evidence(scope),[]);
});

test('restart restores pending inputs and stable plans, but never retries an interrupted network batch',t=>{
 const dir=mkdtempSync(join(tmpdir(),'event-memory-')),path=join(dir,'memory.db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 let s=new EventStore(path);s.ingest(source());s.close();s=new EventStore(path);s.recover();
 const batch=s.claim(fri+4000)!;s.close();s=new EventStore(path);s.recover();
 assert.equal(s.claim(fri+5000),undefined);
 assert.equal(s.commit(batch,[],[],fri+5000,()=>0),false);
 insert(s,'明天休两天，周一上班','m2',proposal(),fri+8000);const before=s.attentions()[0];s.close();
 s=new EventStore(path);assert.equal(s.attentions()[0].id,before.id);assert.equal(s.attentions()[0].tone,before.tone);s.close();
});

test('persistent extraction budget caps calls at twelve per group hour',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());
 for(let i=0;i<13;i++){
  s.ingest({...source('普通发言',String(i)),receivedAt:fri});const batch=s.claim(fri+4000);
  if(i<12){assert.ok(batch);s.finish(batch,'failed');}else assert.equal(batch,undefined);
 }
});

test('observe checks time, same-owner presence and event version, with no send capability',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());insert(s);const item=s.attentions()[0],records=s.records(scope,mon);
 const context={now:mon,epoch:0,records};
 assert.equal(observeAttention(item,context),'no_presence');
 assert.equal(observeAttention(item,{...context,lastPresence:mon}),'ready_for_review');
 assert.equal(observeAttention(item,{...context,lastPresence:mon-16*60000}),'no_presence');
 assert.equal(observeAttention(item,{...context,now:item.expiresAt}),'expired');
 assert.equal(observeAttention(item,{...context,records:[]}),'evidence_changed');
 assert.equal(s.observe(item.id,'no_presence'),true);assert.equal(s.observe(item.id,'no_presence'),false);
});

test('runtime collects addressed inputs only; clear and model cancellation do not leak late writes',async t=>{
 let now=fri;const s=new EventStore(':memory:');const logs:string[]=[];let calls=0;
 const runtime=new EventMemoryRuntime(s,[eventDomain],async()=>{calls++;return {event:[proposal()]};},
  {groups:new Set(['g']),scope:'addressed',mode:'observe'},eventControls,()=>undefined,()=>now,()=>0,line=>logs.push(line));
 runtime.attach(()=>()=>{});runtime.resume();t.after(()=>runtime.close());
 runtime.ingest({groupId:'g',senderId:'a',messageId:'1',content:'普通发言',isMentioned:false,timestamp:fri});
 runtime.ingest({groupId:'other',senderId:'a',messageId:'2',content:'明天休两天',isMentioned:true,timestamp:fri});
 now+=4000;await runtime.tick();assert.equal(calls,0);
 runtime.ingest({groupId:'g',senderId:'a',messageId:'3',content:'明天休两天，周一上班',isMentioned:true,timestamp:fri});
 now+=4000;await runtime.tick();assert.equal(calls,1);assert.equal(s.attentions().length,1);
 assert.ok(logs.some(l=>l.includes('send=false')));assert.ok(!logs.join('').includes('明天'));
 runtime.control({groupId:'g',senderId:'a',content:'/清空长期记忆',isMentioned:true});assert.equal(s.records(scope,now).length,0);
});

test('domain extension requires no engine changes',async t=>{
 let now=fri;const s=new EventStore(':memory:');
 const domain:EventDomain={name:'synthetic-domain',prompt:'test',interpret(_raw,ctx){return [{domain:this.name,businessKey:'x',payload:{anything:true},evidenceIds:[ctx.sources[0].id],operation:'upsert',expiresAt:now+86400000}];},
  project(){return [{kind:'synthetic-attention',occurrenceAt:now,notBefore:now,expiresAt:now+10000,payload:{},requiresPresence:false}];}};
 const runtime=new EventMemoryRuntime(s,[domain],async()=>({}),{groups:new Set(['g']),scope:'group',mode:'observe'},eventControls,()=>undefined,()=>now);
 runtime.attach(()=>()=>{});runtime.resume();t.after(()=>runtime.close());
 runtime.ingest({groupId:'g',senderId:'a',messageId:'1',content:'任意业务',isMentioned:false,timestamp:fri});now+=4000;await runtime.tick();
 assert.equal(s.records(scope,now)[0].domain,'synthetic-domain');assert.equal(s.attentions()[0].kind,'synthetic-attention');
});

test('model payloads contain aliases instead of source, account, event or evidence identifiers',async()=>{
 const s:Source={...source(),id:'PRIVATE-SOURCE',epoch:0,status:'processing'};
 const extract=createEventExtractor('key','model',async(_url,init)=>{
  const body=JSON.parse(init!.body as string);assert.match(body.messages[0].content,/JSON/);
  const data=JSON.parse(body.messages[1].content);assert.equal(data.sources[0].id,'source-1');
  assert.ok(!JSON.stringify(data).includes('PRIVATE'));
  return Response.json({choices:[{message:{content:'{"event":[]}'}}]});
 });
 await extract({sources:[s],existing:[{...scope,id:'PRIVATE-EVENT',domain:'event',businessKey:'PRIVATE-KEY',version:1,epoch:0,status:'active',
  createdAt:fri,updatedAt:fri,expiresAt:mon,payload:{evidenceIds:['PRIVATE-SOURCE']},evidenceIds:['PRIVATE-SOURCE']}],now:fri,prompts:[]},new AbortController().signal);
});

test('contact preferences are explicit and source-bound; commands work without model requests',t=>{
 const s=new EventStore(':memory:');t.after(()=>s.close());
 const src={...source('别再主动找我'),id:'evidence',epoch:0,status:'processing'};
 const result=contactDomain.interpret([{source:'source-1',quote:src.text,proactive:'off',banter:null,nickname:null}],{sources:[src],existing:[],now:fri});
 assert.equal((result[0].payload as any).proactive,'off');
 assert.throws(()=>contactDomain.interpret([{source:'source-2',quote:src.text}],{sources:[src],existing:[],now:fri}));
 eventControls.handle('/主动关心 关',scope,s,fri);assert.equal(s.settings(scope).proactive,'off');
});

test('configuration rejects active sending and missing allowlists; background acquisition leaves a foreground slot',()=>{
 assert.throws(()=>eventConfig({EVENT_FOLLOWUP_MODE:'on_presence'}));
 assert.throws(()=>eventConfig({EVENT_MEMORY_ENABLED:'true',EVENT_FOLLOWUP_MODE:'observe'}));
 assert.equal(eventConfig({}),undefined);
 const sem=new Semaphore(2),release=sem.tryAcquire(1)!;assert.ok(release);assert.equal(sem.tryAcquire(1),undefined);
 assert.ok(sem.tryAcquire());release();release();
});

test('conversation collection survives a failed reply; explicit clear is acknowledged without reopening a window',async t=>{
 let now=fri;const events=new EventStore(':memory:');const memory=new ConversationMemory(new SqliteSessionStore(':memory:'));
 let sends=0,fail=true;
 const runtime=new EventMemoryRuntime(events,[eventDomain],async()=>({event:[proposal()]}),
  {groups:new Set(['g']),scope:'addressed',mode:'observe'},eventControls,()=>undefined,()=>now,()=>0,()=>{});
 const conversation=new Conversation({memory,eventMemory:runtime,unified:true,log:()=>{},generate:async()=>'回答',
  send:async(_group,text,guard)=>{if(!await guard())return;sends++;if(!fail)return text;}});
 t.after(()=>{conversation.disconnect();runtime.close();memory.close();});conversation.connected();
 conversation.handle({groupId:'g',senderId:'a',messageId:'1',timestamp:fri,content:'明天休两天，周一上班',isMentioned:true});
 for(let i=0;i<4;i++)await new Promise(setImmediate);
 now+=4000;await runtime.tick();assert.equal(events.records(scope,now).length,1);assert.deepEqual(memory.get('g','a'),[]);
 fail=false;
 conversation.handle({groupId:'g',senderId:'a',messageId:'2',timestamp:now,content:'/清空记忆',isMentioned:true});
 for(let i=0;i<4;i++)await new Promise(setImmediate);
 assert.equal(sends,2);assert.deepEqual(events.records(scope,now),[]);assert.deepEqual(memory.get('g','a'),[]);
});

test('clear during in-flight extraction fences the late result even if the extractor ignores abort',async t=>{
 let now=fri,resolve!:(raw:Record<string,unknown>)=>void;
 const store=new EventStore(':memory:');
 const runtime=new EventMemoryRuntime(store,[eventDomain],async()=>new Promise(done=>{resolve=done;}),
 {groups:new Set(['g']),scope:'addressed',mode:'observe'},eventControls,()=>undefined,()=>now,()=>0,()=>{});
 runtime.attach(()=>()=>{});runtime.resume();t.after(()=>runtime.close());
 runtime.ingest({groupId:'g',senderId:'a',messageId:'1',timestamp:fri,content:'明天休两天，周一上班',isMentioned:true});
 now+=4000;const pending=runtime.tick();
 runtime.control({groupId:'g',senderId:'a',content:'/清空长期记忆',isMentioned:true});
 resolve({event:[proposal()]});await pending;
 assert.deepEqual(store.records(scope,now),[]);assert.deepEqual(store.attentions(),[]);
});

test('disconnect cancels extraction and reconnect does not replay the same input',async t=>{
 let now=fri,calls=0;const store=new EventStore(':memory:');
 const runtime=new EventMemoryRuntime(store,[eventDomain],async(_input,signal)=>{
  calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
 {groups:new Set(['g']),scope:'addressed',mode:'observe'},eventControls,()=>undefined,()=>now,()=>0,()=>{});
 runtime.attach(()=>()=>{});runtime.resume();t.after(()=>runtime.close());
 const message={groupId:'g',senderId:'a',messageId:'1',timestamp:fri,content:'明天休两天，周一上班',isMentioned:true};
 runtime.ingest(message);now+=4000;const pending=runtime.tick();runtime.pause();await pending;
 runtime.resume();runtime.ingest(message);now+=4000;await runtime.tick();assert.equal(calls,1);assert.deepEqual(store.records(scope,now),[]);
});

test('turning proactive preference off cancels pending items; turning on does not resurrect them',t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());insert(store);
 eventControls.handle('/主动关心 关',scope,store,fri+5000);
 assert.equal(store.attentions(scope)[0].status,'cancelled');
 eventControls.handle('/主动关心 开',scope,store,fri+6000);
 assert.equal(store.attentions(scope)[0].status,'cancelled');
 assert.equal(store.settings(scope).proactive,'on_presence');
});

test('a stale correction version cannot overwrite a newer event',t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());insert(store);
 const text='改了，下周才休';store.ingest({...source(text,'correct'),receivedAt:fri+5000});const batch=store.claim(fri+9000)!;
 const ctx={sources:batch.sources,existing:store.records(scope,fri+9000),now:fri+9000};
 const mutation=eventDomain.interpret([proposal({operation:'correct',target:'event-1',statement:q(text),start:null,duration:null,resume:null})],ctx)[0];
 mutation.expectedVersion=0;
 assert.throws(()=>store.commit(batch,[mutation],[eventDomain],fri+9000,()=>0));
 assert.equal(store.records(scope,fri+9000)[0].version,1);assert.equal(store.attentions(scope)[0].status,'pending');
});

test('replayed clear commands do not delete newer memories after reconnect',t=>{
 const store=new EventStore(':memory:');
 const runtime=new EventMemoryRuntime(store,[eventDomain],async()=>({}),{groups:new Set(['g']),scope:'addressed',mode:'observe'},
 eventControls,()=>undefined,()=>fri+10000,()=>0,()=>{});t.after(()=>runtime.close());runtime.resume();
 const command={groupId:'g',senderId:'a',messageId:'clear-command',content:'/清空长期记忆',isMentioned:true};
 runtime.control(command);insert(store,'明天休两天，周一上班','new-event',proposal(),fri+8000);
 runtime.pause();runtime.resume();runtime.control(command);
 assert.equal(store.records(scope,fri+10000).length,1);assert.equal(store.epoch(scope),1);
});

test('arbitrary topics use the same event schema; followup is proposed rather than inferred from topic',t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());
 const cases=[
  {text:'明天观测两天',raw:proposal({resume:null,topic:'天文观测',summary:'观测计划',statement:q('明天观测两天'),followup:{anchor:'end',intent:'询问观测进展',basis:'inferred'}})},
  {text:'下周三考试',raw:proposal({resume:null,topic:'考试',summary:'本人考试计划',statement:q('下周三考试'),start:null,duration:null,
    anchors:[{label:'考试',date:q('下周三'),notBeforeEnd:false}],followup:{anchor:0,intent:'询问准备情况',basis:'inferred'}})},
  {text:'明天开始练两天',raw:proposal({resume:null,topic:'练习',summary:'练习计划',statement:q('明天开始练两天'),followup:null})},
 ];
 cases.forEach((c,i)=>insert(store,c.text,'topic-'+i,c.raw,fri+(i+1)*4000));
 assert.equal(store.records(scope,fri+12000).length,3);
 assert.equal(store.attentions(scope).length,2);
 assert.ok(store.attentions(scope).every(a=>a.kind==='event_followup'));
 const exam=store.records(scope,fri+12000).find(e=>(e.payload as any).topic==='考试')!;
 assert.equal((exam.payload as any).anchors[0].date.value.date,'2026-10-28');
});

test('missing evidence and unknown followup anchors are rejected across arbitrary topics',()=>{
 const ctx={sources:[{...source('明天看展'),id:'proof',epoch:0,status:'processing'}],existing:[],now:fri};
 const raw=proposal({topic:'看展',summary:'看展计划',statement:q('明天看展'),start:q('明天'),duration:null,resume:null});
 assert.throws(()=>eventDomain.interpret([{...raw,followup:{anchor:7,intent:'随便',basis:'inferred'}}],ctx));
 for(const assertion of ['wish','hypothetical','reported','unknown'])assert.deepEqual(eventDomain.interpret([{...raw,assertion}],ctx),[]);
});

test('reference text can change without registering a new topic in code',()=>{
 const domain=createEventDomain('自定义主题参考：新兴趣活动也按原文提取，时间不足不补猜。');
 assert.match(domain.prompt,/新兴趣活动/);
 assert.equal(domain.name,'event');
 const ctx={sources:[{...source('明天拼积木'),id:'proof',epoch:0,status:'processing'}],existing:[],now:fri};
 const result=domain.interpret([proposal({resume:null,topic:'任意新兴趣',summary:'拼积木计划',statement:q('明天拼积木'),duration:null,followup:null})],ctx);
 assert.equal(result.length,1);assert.equal(result[0].domain,'event');
});

test('an explicit start without a duration remains a valid time anchor',t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());
 insert(store,'明天看展','point',proposal({topic:'看展',summary:'本人计划看展',statement:q('明天看展'),resume:null,duration:null,
  followup:{anchor:'start',intent:'询问期待',basis:'inferred'}}));
 const event=store.records(scope,fri+4000)[0];
 assert.equal((event.payload as any).startOn.value.date,'2026-10-24');
 assert.equal((event.payload as any).period,null);assert.equal(store.attentions().length,1);
});

test('v1 records migrate once without losing event, attention, evidence identity or tone',t=>{
 const dir=mkdtempSync(join(tmpdir(),'event-migrate-')),path=join(dir,'memory.db');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 new EventStore(path).close();
 const db=new DatabaseSync(path);
 const old={...scope,id:'old-event',domain:'vacation',businessKey:'old-key',version:3,epoch:0,status:'active',createdAt:fri,updatedAt:fri,expiresAt:fri+30*86400000,
  evidenceIds:['proof'],payload:{type:'vacation',period:{value:{startDate:'2026-10-24',endDateExclusive:'2026-10-26',timezone:'Asia/Shanghai'},basis:'derived',evidenceIds:['proof']},
   durationDays:null,resumeOn:{value:{date:'2026-10-26',timezone:'Asia/Shanghai'},basis:'derived',evidenceIds:['proof']}}};
 const attention={...scope,id:'old-attention',eventId:old.id,eventVersion:3,epoch:0,kind:'vacation_followup',occurrenceAt:midnight('2026-10-26'),
  notBefore:mon-3600000,expiresAt:mon+8*3600000,status:'pending',tone:'wry',payload:{claimMode:'resume_stated'},requiresPresence:true};
 db.prepare('INSERT INTO event_memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(old.id,'g','a',old.domain,old.businessKey,3,0,'active',fri,fri,old.expiresAt,JSON.stringify(old));
 db.prepare('INSERT INTO attention_items VALUES(?,?,?,?,?,?,?)').run(attention.id,old.id,attention.kind,attention.occurrenceAt,'pending',attention.expiresAt,JSON.stringify(attention));
 db.exec('UPDATE event_schema_version SET version=1');db.close();
 let store=new EventStore(path);
 assert.equal(store.records(scope,fri)[0].domain,'event');assert.equal(store.records(scope,fri)[0].id,old.id);
 assert.equal(store.records(scope,fri)[0].version,3);assert.equal(store.attentions()[0].id,attention.id);
 assert.equal(store.attentions()[0].tone,'wry');assert.equal(store.attentions()[0].kind,'event_followup');store.close();
 store=new EventStore(path);assert.equal(store.attentions().length,1);assert.equal(store.records(scope,fri).length,1);store.close();
});

test('numeric anchor JSON variation is normalized without accepting nonexistent indices',()=>{
 const ctx={sources:[{...source(),id:'proof',epoch:0,status:'processing'}],existing:[],now:fri};
 const input=proposal({followup:{anchor:'0',intent:'询问近况',basis:'inferred'}});
 const result=eventDomain.interpret([input],ctx);
 assert.equal((result[0].payload as any).followup.anchor,0);
 assert.throws(()=>eventDomain.interpret([{...input,followup:{anchor:'7',intent:'询问近况',basis:'inferred'}}],ctx));
});

test('missing registered output arrays fail instead of silently discarding extracted data',async()=>{
 const extract=createEventExtractor('test','model',async()=>Response.json({choices:[{message:{content:'{"wrong-key":[]}'}}]}));
 await assert.rejects(extract({sources:[{...source(),id:'proof',epoch:0,status:'processing'}],existing:[],now:fri,
  prompts:[{name:'event',prompt:'test'}]},new AbortController().signal),/event_extract_format/);
});
