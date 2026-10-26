import { spawnSync } from 'node:child_process';
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from './events/store.js';
import { EventMemoryRuntime } from './events/runtime.js';
import { eventControls } from './events/controls.js';
import { createEventDomain } from './events/domains/event.js';
import { createInitiativeObserver } from './events/initiative.js';
import { ChatContext } from './context.js';
import type { ChatMessage } from './message.js';
import type { InitiativeInput, InitiativeObserver } from './events/initiative-types.js';
const start=Date.parse('2026-10-25T10:00:00+08:00'),now=Date.parse('2026-10-26T10:00:00+08:00');
const scope={chatId:'private-group',ownerId:'private-user'};
const message=(id='current',text='今天终于有空了'):ChatMessage=>({chatId:scope.chatId,senderId:scope.ownerId,content:text,messageId:id,timestamp:now,isMentioned:false});
function seed(store:EventStore,s=scope,id='origin') {
  const domain=createEventDomain();
  store.ingest({...s,messageId:id,text:'我明天开始做模型',sourceAt:start,receivedAt:start});
  const batch=store.claim(start+4000)!;
  const q=(text:string)=>({source:'source-1',text});
  const mutation=domain.interpret([{operation:'record',target:null,assertion:'stated',topic:`个人制作${id}`,summary:'计划明天开始做模型',statement:q('我明天开始做模型'),start:q('明天'),duration:null,anchors:[],followup:{anchor:'start',intent:'询问准备或进展，不代表已经开始',basis:'stated'}}],{sources:batch.sources,existing:[],now:start+4000});
  store.commit(batch,mutation,[domain],start+4000,()=>0.4);
  return store.attentions(s)[0];
}
function setup(observer:InitiativeObserver,db=':memory:') {
 const store=new EventStore(db);const item=seed(store);let clock=now;
 const discussion=new ChatContext(()=>clock);discussion.add(message());
 const runtime=new EventMemoryRuntime(store,[],async()=>({}),{groups:new Set([scope.chatId]),scope:'addressed',mode:'observe'},eventControls,
  (records,settings)=>settings.proactive==='off'?{reason:'preference_off',terminal:true}:undefined,()=>clock,()=>0,()=>{},undefined,observer);
 runtime.attach(()=>()=>{},()=>discussion.snapshot(scope.chatId));runtime.resume();
 return {store,item,runtime,discussion,setNow:(v:number)=>{clock=v;}};
}
const reply=(value:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{status:200});
const decision=(action='draft',reason='natural_opening')=>({action,reason,basis:['memory-1','message-1'],observation:{intent:'casual',seriousness:'inferred',requestedBanter:'unspecified',evidenceRefs:['message-1']}});
function input():InitiativeInput {
 const store=new EventStore(':memory:');const attention=seed(store);const record=store.records(scope,now)[0];
 const discussion=new ChatContext(()=>now);discussion.add(message());
 const value={attention,record,evidence:store.recallEvidence(scope,record.evidenceIds,now),records:store.records(scope,now),snapshot:discussion.snapshot(scope.chatId),now};store.close();return value;
}

test('ready opportunity evaluates once, stores draft and stable tone, with no send capability',async()=>{
 let calls=0;
 const x=setup(async data=>{calls++;assert.equal(data.attention.tone,'wry');assert.equal(data.evidence.length,1);return {status:'drafted',reason:'natural_opening',text:'模型要开工啦？我的鳍先歇会儿。'};});
 x.runtime.ingest(message());await x.runtime.tick();await x.runtime.tick();
 assert.equal(calls,1);assert.equal(x.store.initiatives()[0].result?.status,'drafted');assert.equal(x.store.attentions()[0].status,'pending');
 x.runtime.close();
});

test('not due, absent owner, expired, foreign groups and preference off never reach observer',async()=>{
 for(const state of ['not_due','no_presence','expired','foreign','preference_off']){
  let calls=0;const x=setup(async()=>{calls++;return {status:'skipped',reason:'uncertain'};});
  if(state==='not_due')x.setNow(now-2*3600000);
  if(state==='expired')x.setNow(now+9*3600000);
  if(state==='preference_off')x.store.setSettings(scope,{proactive:'off'});
  if(state==='foreign')x.runtime.ingest({...message(),chatId:'foreign'});else if(state!=='no_presence')x.runtime.ingest(message());
  await x.runtime.tick();assert.equal(calls,0,state);x.runtime.close();
 }
});

test('clear, correction, preference change, new discussion and cancellation discard a late draft',async()=>{
 for(const change of ['clear','correction','preference','discussion','pause']){
  let resolve!:(v:any)=>void,started!:(v?:unknown)=>void;const began=new Promise(r=>{started=r;});
  const x=setup(async()=>{started();return new Promise(r=>{resolve=r;});});
  x.runtime.ingest(message());const pending=x.runtime.tick();await began;
  if(change==='clear')x.store.clear(scope);
  if(change==='preference')x.store.setSettings(scope,{proactive:'off'});
  if(change==='discussion')x.discussion.add({...message('new'),senderId:'another'});
  if(change==='pause')x.runtime.pause();
  if(change==='correction'){
    const record=x.store.records(scope,now)[0];x.store.ingest({...scope,messageId:'correction',text:'已取消',sourceAt:now,receivedAt:now});
    const batch=x.store.claim(now+4000)!;x.store.commit(batch,[{domain:record.domain,businessKey:record.businessKey,payload:record.payload,evidenceIds:[batch.sources[0].id],operation:'retract',targetId:record.id,expectedVersion:record.version,expiresAt:now+86400000}],[],now+4000,()=>0);
  }
  resolve({status:'drafted',reason:'natural_opening',text:'旧草稿'});await pending;
  const result=x.store.initiatives()[0]?.result;
  if(change==='clear')assert.equal(x.store.initiatives().length,0);else {assert.notEqual(result?.status,'drafted',change);assert.equal(result?.text,undefined);}
  x.runtime.close();
 }
});

test('persisted dedup, interruption recovery and observation budgets survive restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'initiative-'));const file=join(dir,'db');
 try{
  let store=new EventStore(file);const item=seed(store);const attempt=store.claimInitiative(item,now)!;assert.ok(attempt);
  assert.equal(store.claimInitiative(item,now),undefined);store.close();store=new EventStore(file);store.recover();
  assert.equal(store.initiatives()[0].result?.status,'interrupted');assert.equal(store.claimInitiative(item,now+1000),undefined);
  const other=seed(store,scope,'origin2');assert.equal(store.claimInitiative(other,now+2000),undefined);
  for(let i=0;i<5;i++){const another=seed(store,{...scope,ownerId:`other${i}`},`origin${i+10}`);assert.ok(store.claimInitiative(another,now+3000));}
  const blocked=seed(store,{...scope,ownerId:'budget7'},'origin20');assert.equal(store.claimInitiative(blocked,now+4000),undefined);
  store.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('model adapter anonymizes IDs, reuses modular persona and validates references for both stages',async()=>{
 const requests:any[]=[];
 const observe=createInitiativeObserver('key','model','modular',async(_url,options)=>{
  const body=JSON.parse(String(options?.body));requests.push(body);
  return reply(requests.length===1?decision():requests.length===3?{verdict:'accept',reason:'grounded',basis:['memory-1','message-1']}:{text:'今天模型要开工啦？我的鳍已经准备好围观了。',basis:['memory-1','message-1']});
 });
 const result=await observe(input(),new AbortController().signal);
 assert.equal(result.status,'drafted');assert.equal(result.expressionPlan?.mode,'casual');assert.equal(requests.length,3);
 const wire=JSON.stringify(requests);for(const id of [scope.chatId,scope.ownerId,input().record.id])assert.ok(!wire.includes(id));
 assert.ok(!requests[0].tools);assert.ok(!requests[1].tools);assert.match(requests[1].messages[0].content,/小鲸鱼|鲸鱼/);
});

test('skip uses only decision request; invalid JSON, forged basis and HTTP failure never become draft',async()=>{
 let calls=0;const skipped=await createInitiativeObserver('k','m','modular',async()=>{calls++;return reply(decision('skip','busy'));})(input(),new AbortController().signal);
 assert.equal(skipped.status,'skipped');assert.equal(calls,1);
 for(const fake of [{...decision(),basis:['invented']},{...decision(),observation:{}},{...decision(),reason:'injected'},null]){
  const result=await createInitiativeObserver('k','m','modular',async()=>reply(fake))(input(),new AbortController().signal);
  assert.equal(result.status,'unavailable');assert.equal(result.text,undefined);
 }
 const http=await createInitiativeObserver('k','m','modular',async()=>new Response('',{status:503}))(input(),new AbortController().signal);
 assert.equal(http.status,'unavailable');
});

test('recent bot participation and missing target context skip before model; banter preference controls persona',async()=>{
 for(const kind of ['bot','absent']){
  const data=input();const context=new ChatContext(()=>now);if(kind==='bot'){context.add(message());context.delivered(scope.chatId,'刚说完');}
  data.snapshot=context.snapshot(scope.chatId);
  const result=await createInitiativeObserver('k','m','modular',async()=>{throw Error('must not call');})(data,new AbortController().signal);
  assert.equal(result.status,'skipped');assert.equal(result.reason,kind==='bot'?'recent_bot_reply':'no_recent_context');
 }
 const data=input();data.records.push({...data.record,domain:'contact',payload:{banter:'off'}});let calls=0;
 const result=await createInitiativeObserver('k','m','modular',async()=>reply(++calls===1?{...decision(),observation:{...decision().observation,intent:'play'}}:calls===3?{verdict:'accept',reason:'grounded',basis:['memory-1']}:{text:'今天开始做模型了吗？',basis:['memory-1','message-1']}))(data,new AbortController().signal);
 assert.equal(result.expressionPlan?.banter,'off');assert.notEqual(result.expressionPlan?.mode,'play');
});


test('independent reviewer rejects unsupported or intrusive draft without retaining its text',async()=>{
 for(const reason of ['unsupported','intrusive','persona_mismatch']){
  let calls=0;
  const result=await createInitiativeObserver('k','m','modular',async()=>reply(++calls===1?decision():calls===2?
    {text:'没有证据的结果',basis:['memory-1','message-1']}:{verdict:'reject',reason,basis:['memory-1']}))(input(),new AbortController().signal);
  assert.equal(calls,3);assert.equal(result.status,'rejected');assert.equal(result.reason,reason);assert.equal(result.text,undefined);
 }
});

test('invalid reviewer and aborted generation cannot yield a usable draft',async()=>{
 let calls=0;
 const result=await createInitiativeObserver('k','m','modular',async()=>reply(++calls===1?decision():calls===2?
  {text:'草稿',basis:['memory-1','message-1']}:{verdict:'accept',reason:'grounded',basis:['invented']}))(input(),new AbortController().signal);
 assert.equal(result.status,'unavailable');assert.equal(result.text,undefined);
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>createInitiativeObserver('k','m')(input(),controller.signal));
});


test('conversation supplies current discussion to event observer without routing its draft to send',async()=>{
 let evaluations=0,sends=0;
 const x=setup(async data=>{evaluations++;assert.equal(data.snapshot.messages.at(-1)?.text,'今天有空了');return {status:'drafted',reason:'natural_opening',text:'仅本地草稿'};});
 const memory=new ConversationMemory(new SqliteSessionStore(':memory:'),()=>now);
 const bot=new Conversation({memory,eventMemory:x.runtime,unified:true,now:()=>now,log:()=>{},generate:async()=>'',send:async()=>{sends++;return undefined;}});
 try{
  bot.connected();bot.handle(message('from-conversation','今天有空了'));await x.runtime.tick();
  assert.equal(evaluations,1);assert.equal(sends,0);assert.equal(x.store.initiatives()[0].result?.text,'仅本地草稿');
 }finally{bot.disconnect();x.runtime.close();memory.close();}
});

test('local report shows anonymized historical decision and clear removes report contents',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'initiative-report-')),path=join(dir,'db');
 const x=setup(async()=>({status:'drafted',reason:'natural_opening',text:'观察候选'}),path);
 const report=()=>{
  const child=spawnSync(process.execPath,['--import','tsx','src/event-observe-report.ts'],{encoding:'utf8',env:{...process.env,MEMORY_DB:path}});
  assert.equal(child.status,0,child.stderr);return child.stdout;
 };
 try{
  x.runtime.ingest(message());await x.runtime.tick();const output=report(),body=JSON.parse(output);
  assert.equal(body.sendCapability,false);assert.equal(body.observations[0].text,'观察候选');
  assert.equal(body.observations[0].tone,'wry');assert.ok(body.observations[0].window.from);
  for(const id of [scope.chatId,scope.ownerId,x.item.id])assert.ok(!output.includes(id));
  x.store.clear(scope);assert.deepEqual(JSON.parse(report()).observations,[]);
 }finally{x.runtime.close();rmSync(dir,{recursive:true,force:true});}
});
