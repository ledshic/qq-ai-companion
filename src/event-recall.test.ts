import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventStore } from './events/store.js';
import { createMemoryRecall, createRecallSelector, recallView } from './events/recall.js';
import { presentEventRecall } from './events/domains/event-recall.js';
import { createEventDomain } from './events/domains/event.js';
import { EventMemoryRuntime } from './events/runtime.js';
import { eventControls } from './events/controls.js';
import { Conversation } from './conversation.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import { createDeepSeekReply } from './deepseek.js';
import { createVisionReply } from './vision.js';
import { ChatContext, modelContext, type ReplyContext } from './context.js';
import { observationReceipt } from './context-analysis.js';
import { PersonalityRuntime } from './personality-runtime.js';
import sharp from 'sharp';
const at = Date.parse('2026-10-23T10:00:00+08:00'), later = at + 86400000;
const scope = {chatId:'private-group',ownerId:'private-owner'};
const q = (text:string)=>({source:'source-1',text});
function seed(store:EventStore, ownerId=scope.ownerId, chatId=scope.chatId, id='message-1') {
  const domain=createEventDomain();
  store.ingest({chatId,ownerId,messageId:`${chatId}-${ownerId}-${id}`,text:'下周三考试',sourceAt:at,receivedAt:at});
  const batch=store.claim(at+4000)!;
  const raw={operation:'record',target:null,assertion:'stated',topic:'考试',summary:'计划下周三参加考试',
    statement:q('下周三考试'),start:q('下周三'),duration:null,anchors:[],followup:null};
  const ctx={sources:batch.sources,existing:store.records({chatId,ownerId},at+4000),now:at+4000};
  store.commit(batch,domain.interpret([raw],ctx),[domain],at+4000,()=>0);
  return batch;
}
const signal=()=>new AbortController().signal;
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};

test('recall uses only scoped, active, evidence-backed facts, not proactive suggestions or database IDs',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());
 const source=seed(store);seed(store,'another-owner');seed(store,scope.ownerId,'another-group');
 let selections=0;
 const recall=createMemoryRecall(store,async query=>{
  selections++;assert.equal(query.records.length,1);
  const text=JSON.stringify(query);
  for(const hidden of [scope.chatId,scope.ownerId,source.id,source.sources[0].id])assert.ok(!text.includes(hidden));
  assert.ok(!text.includes('followup'));return ['memory-1'];
 },presentEventRecall,()=>later);
 const result=await recall({...scope,text:'我之前说什么时候考试？',history:[]},signal());
 assert.equal(result.view.status,'matched');assert.equal(result.view.records.length,1);
 assert.match(result.view.records[0].evidence[0].excerpt,/考试/);
 assert.equal(result.view.records[0].evidence[0].at,new Date(at).toISOString());
 assert.equal(result.isCurrent(),true);assert.equal(selections,1);
 const foreign=await recall({chatId:scope.chatId,ownerId:'nobody',text:'之前的事',history:[]},signal());
 assert.equal(foreign.view.status,'empty');assert.equal(selections,1);
});

test('empty, unrelated, selector failure and forged IDs are distinct and do not fabricate records',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 const query={...scope,text:'你好',history:[]};
 assert.equal((await createMemoryRecall(store,async()=>[],presentEventRecall,()=>later)(query,signal())).view.status,'empty');
 for(const select of [async()=>{throw Error('timeout');},async()=>['invented-id']]){
  const result=await createMemoryRecall(store,select,presentEventRecall,()=>later)(query,signal());
  assert.equal(result.view.status,'unavailable');assert.equal(result.view.records.length,0);
 }
 const expired=await createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>at+31*86400000)(query,signal());
 assert.equal(expired.view.status,'matched');
 assert.equal((expired.view.records[0].facts as {phase:string}).phase,'historical');
});

test('clear while selection is running invalidates late results; clear after selection invalidates send guard',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 let done!:(ids:string[])=>void;
 const recall=createMemoryRecall(store,async()=>new Promise(resolve=>{done=resolve;}),presentEventRecall,()=>later);
 const pending=recall({...scope,text:'之前的事',history:[]},signal());
 store.clear(scope);done(['memory-1']);const result=await pending;
 assert.equal(result.view.status,'unavailable');assert.equal(result.isCurrent(),false);
 seed(store,scope.ownerId,scope.chatId,'message-2');
 const fresh=await createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>later)({...scope,text:'之前的事',history:[]},signal());
 assert.equal(fresh.isCurrent(),true);store.clear(scope);assert.equal(fresh.isCurrent(),false);
});

test('superseding an event after recall invalidates the draft version',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 const recall=createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>later);
 const result=await recall({...scope,text:'之前的事',history:[]},signal());
 const event=store.records(scope,later)[0];
 store.ingest({...scope,messageId:'correction',text:'改成下周四',sourceAt:later,receivedAt:later});
 const batch=store.claim(later+4000)!;
 store.commit(batch,[{domain:'event',businessKey:event.businessKey,payload:event.payload,evidenceIds:[batch.sources[0].id],
  operation:'replace',targetId:event.id,expectedVersion:event.version,expiresAt:later+86400000}],[createEventDomain()],later+4000,()=>0);
 assert.equal(result.isCurrent(),false);
});

test('selector prompt is JSON-compatible and rejects nonexistent IDs, duplicates and malformed output',async()=>{
 for(const raw of ['{"ids":["fake"]}','{"ids":["memory-1","memory-1"]}','not-json']){
  const select=createRecallSelector('key','model',async(_url,init)=>{
   const body=JSON.parse(init!.body as string);assert.match(body.messages[0].content,/JSON/);
   return Response.json({choices:[{message:{content:raw}}]});
  });
  await assert.rejects(select({text:'我之前说过什么',history:[],now:new Date(later).toISOString(),records:[{
   id:'memory-1',recordedAt:new Date(at).toISOString(),updatedAt:new Date(at).toISOString(),facts:{},evidence:[],
  }]},signal()));
 }
});

test('parent cancellation propagates instead of silently generating an unavailable-memory answer',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 const controller=new AbortController();let release!:(ids:string[])=>void;
 const recall=createMemoryRecall(store,async()=>new Promise(done=>{release=done;}),presentEventRecall,()=>later);
 const pending=recall({...scope,text:'之前的事',history:[]},controller.signal);
 controller.abort(new Error('superseded'));release(['memory-1']);await assert.rejects(pending,/superseded/);
});

test('chat generation receives recalled data as user material; tool rounds reuse the same snapshot',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 const recalled=await createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>later)({...scope,text:'之前的事',history:[]},signal());
 const group=new ChatContext(()=>later);
 group.add({chatId:scope.chatId,senderId:scope.ownerId,messageId:'request',content:'还记得吗',isMentioned:true});
 const context:ReplyContext={kind:'explicit',targetSenderId:scope.ownerId,triggerIds:['request'],snapshot:group.snapshot(scope.chatId),
  longTermMemory:recalled.view,memoryGuard:recalled.isCurrent};
 const bodies:any[]=[];
 const reply=createDeepSeekReply('key','model',async(_url,init)=>{
  const body=JSON.parse(init!.body as string);bodies.push(body);
  assert.match(body.messages[0].content,/未召回到记录只表示本次没找到/);
  const data=JSON.parse(body.messages[1].content).discussionContext;
  assert.equal(data.longTermMemory.records[0].id,'memory-1');assert.equal(data.memoryGuard,undefined);
  for(const hidden of [scope.chatId,scope.ownerId])assert.ok(!JSON.stringify(body).includes(hidden));
  return Response.json({choices:[{message:bodies.length===1?{tool_calls:[{id:'time',type:'function',function:{name:'get_current_time',arguments:'{}'}}]}:{content:'你之前说下周三考试。'}}]});
 },{log:()=>{}});
 assert.equal(await reply('还记得吗',[],signal(),true,context),'你之前说下周三考试。');assert.equal(bodies.length,2);
 assert.deepEqual(bodies[0].messages[1],bodies[1].messages[1]);
});

test('scheduler recalls for addressed questions and follow-ups, but not ordinary or warmup messages',async t=>{
 let now=later,calls=0;const store=new EventStore(':memory:');seed(store);
 const memory=new ConversationMemory(new SqliteSessionStore(':memory:'),()=>now);
 const retrieved=createMemoryRecall(store,async()=>{calls++;return ['memory-1'];},presentEventRecall,()=>now);
 const runtime=new EventMemoryRuntime(store,[],async()=>({}),{groups:new Set([scope.chatId]),scope:'addressed',mode:'observe'},
  eventControls,()=>undefined,()=>now,()=>0,()=>{},retrieved);
 const contexts:ReplyContext[]=[];
 const bot=new Conversation({memory,eventMemory:runtime,unified:true,autoReply:true,now:()=>now,random:()=>0,log:()=>{},
  warmup:{probability:1,hours:[0,0],cooldownMs:0,idleMs:5000},
  judge:async()=>({intent:'continue',shouldRespond:true,reason:'followup'}),
  generate:async(_text,_history,_signal,_tools,context)=>{contexts.push(context!);return '你之前提过考试';},
  send:async(_group,text,guard)=>await guard()?text:undefined,
 });
 t.after(()=>{bot.disconnect();runtime.close();memory.close();});bot.connected();
 const message=(id:string,text:string,explicit:boolean)=>bot.handle({chatId:scope.chatId,senderId:scope.ownerId,messageId:id,content:text,isMentioned:explicit,timestamp:now});
 message('ordinary','随便说句话',false);await flush();assert.equal(calls,0);
 message('explicit','我之前说过什么？',true);await flush();assert.equal(calls,1);
 assert.equal(contexts[0].longTermMemory?.status,'matched');
 message('follow','那具体是哪天？',false);await flush();assert.equal(calls,2);
 assert.equal(contexts[1].longTermMemory?.records.length,1);
 bot.tick();await flush();assert.equal(calls,2);assert.equal(contexts.at(-1)?.kind,'warmup');
});

test('memory invalidation during generation prevents the stale answer from being sent',async t=>{
 const store=new EventStore(':memory:');seed(store);
 const memory=new ConversationMemory(new SqliteSessionStore(':memory:'));
 const runtime=new EventMemoryRuntime(store,[],async()=>({}),{groups:new Set([scope.chatId]),scope:'addressed',mode:'observe'},
  eventControls,()=>undefined,()=>later,()=>0,()=>{},createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>later));
 let generated!:(text:string)=>void,sends=0;
 const bot=new Conversation({memory,eventMemory:runtime,unified:true,log:()=>{},
  generate:async()=>new Promise(done=>{generated=done;}),send:async(_group,text,guard)=>{if(await guard()){sends++;return text;}}});
 t.after(()=>{bot.disconnect();runtime.close();memory.close();});bot.connected();
 bot.handle({chatId:scope.chatId,senderId:scope.ownerId,messageId:'request',timestamp:later,content:'我之前说过什么',isMentioned:true});
 await flush();store.clear(scope);generated('旧事实');await flush();
 assert.equal(sends,0);assert.deepEqual(memory.get(scope.chatId,scope.ownerId),[]);
});

test('image generation receives scoped text memories without treating them as previously seen images',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 const recalled=await createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>later)({...scope,text:'之前的事',history:[]},signal());
 const group=new ChatContext(()=>later);group.add({chatId:scope.chatId,senderId:scope.ownerId,messageId:'image',content:'这个跟之前的事有关吗',isMentioned:true});
 const context:ReplyContext={kind:'explicit',targetSenderId:scope.ownerId,triggerIds:['image'],snapshot:group.snapshot(scope.chatId),longTermMemory:recalled.view,memoryGuard:recalled.isCurrent};
 const bytes=await sharp({create:{width:10,height:10,channels:3,background:'#fff'}}).png().toBuffer();
 const vision=createVisionReply('key','model',async(url,init)=>{
  if(!String(url).includes('api.deepseek'))return new Response(bytes);
  const body=JSON.parse(init!.body as string);
  assert.match(body.messages[0].content,/不能当作历史原图/);
  const data=JSON.parse(body.messages[1].content).discussionContext;
  assert.equal(data.longTermMemory.records.length,1);assert.equal(data.memoryGuard,undefined);
  return Response.json({choices:[{message:{content:'只能对照你之前说过的文字计划。'}}]});
 },()=>{});
 assert.match(await vision('这个跟之前的事有关吗',{url:'https://gchat.qpic.cn/test'},signal(),context),/文字计划/);
});

test('adding recalled material does not invalidate the existing expression observation receipt',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 const recalled=await createMemoryRecall(store,async()=>['memory-1'],presentEventRecall,()=>later)({...scope,text:'之前的事',history:[]},signal());
 const group=new ChatContext(()=>later);group.add({chatId:scope.chatId,senderId:scope.ownerId,messageId:'request',content:'之前的事',isMentioned:true});
 const context:ReplyContext={kind:'follow-up',targetSenderId:scope.ownerId,triggerIds:['request'],snapshot:group.snapshot(scope.chatId)};
 const input={text:'之前的事',history:[],context};
 const receipt=observationReceipt({intent:'question',seriousness:'explicit',requestedBanter:'stop',evidenceRefs:['current-request']},input);
 const runtime=new PersonalityRuntime(async()=>{throw Error('must reuse');},()=>{});
 const plan=await runtime.plan({...input,context:{...context,longTermMemory:recalled.view,memoryGuard:recalled.isCurrent}},signal(),receipt);
 assert.equal(plan.mode,'explain');assert.equal(plan.banter,'off');
});

test('a real selector timeout produces unavailable without retries',async t=>{
 const store=new EventStore(':memory:');t.after(()=>store.close());seed(store);
 let calls=0;
 const select=createRecallSelector('key','model',async(_url,init)=>{
  calls++;throw new DOMException('timed out','TimeoutError');
 });
 const result=await createMemoryRecall(store,select,presentEventRecall,()=>later)({...scope,text:'之前的事',history:[]},signal());
 assert.equal(result.view.status,'unavailable');assert.equal(calls,1);
});

test('runtime denies recall outside the configured group allowlist',async t=>{
 const store=new EventStore(':memory:');seed(store);let calls=0;
 const runtime=new EventMemoryRuntime(store,[],async()=>({}),{groups:new Set(['some-other-group']),scope:'addressed',mode:'observe'},
  eventControls,()=>undefined,()=>later,()=>0,()=>{},async()=>{calls++;return {view:recallView('empty',later),isCurrent:()=>true};});
 t.after(()=>runtime.close());runtime.resume();
 assert.equal((await runtime.recall({...scope,text:'之前的事',history:[]},signal())).view.status,'disabled');assert.equal(calls,0);
});
