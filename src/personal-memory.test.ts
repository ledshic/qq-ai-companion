import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventStore } from './events/store.js';
import { createPersonalRecall, createPrivateDisclosure } from './events/personal-recall.js';
import { createEventDomain } from './events/domains/event.js';
import { presentPersonalRecall } from './events/domains/event-recall.js';
import { contactDomain } from './events/domains/contact.js';
import { eventControls } from './events/controls.js';
import { EventMemoryRuntime } from './events/runtime.js';
import { parseChatMessage, matchesChat } from './onebot.js';
import { ConversationMemory } from './memory.js';
import { SqliteSessionStore } from './store.js';
import { ChatContext, modelContext } from './context.js';

const at=Date.parse('2026-10-26T10:00:00+08:00');
const signal=()=>new AbortController().signal;
const groups=new Set(['10','20']);
const query=(chatId='10',ownerId='2',text='我之前的考试')=>({chatId,ownerId,text,history:[]});
function seed(store:EventStore,chatId:string,ownerId='2',contact=false) {
  const text=contact?'叫我小鱼':'下周三考试';
  store.ingest({chatId,ownerId,messageId:`${chatId}-${ownerId}`,text,sourceAt:at,receivedAt:at});
  const batch=store.claim(at+4000)!;
  const domain=contact?contactDomain:createEventDomain();
  const raw=contact?[{source:'source-1',quote:text,nickname:'小鱼',proactive:null,banter:null}]:[
    {operation:'record',target:null,assertion:'stated',topic:'考试',summary:'计划下周三考试',
      statement:{source:'source-1',text},start:null,duration:null,anchors:[],followup:null}];
  const context={sources:batch.sources,existing:[],now:at+4000};
  store.commit(batch,domain.interpret(raw,context),[domain],at+4000,()=>0);
}

test('private parsing directly addresses the bot and rejects self/malformed messages',()=>{
  const raw={post_type:'message',message_type:'private',self_id:1,user_id:2,message_id:3,
    message:[{type:'text',data:{text:'你好'}}]};
  const message=parseChatMessage(raw)!;
  assert.equal(message.chatId,'private:2');assert.equal(message.isMentioned,true);
  assert.equal(parseChatMessage({...raw,user_id:1}),null);
  assert.equal(parseChatMessage({...raw,message:'string'}),null);
  assert.equal(matchesChat({message_type:'private',sender:{user_id:3}},message),false);
  assert.equal(matchesChat({message_type:'private',sender:{user_id:1},target_id:3},message),false);
  assert.equal(matchesChat({message_type:'private',sender:{user_id:1},target_id:2},message),true);
});

test('short-term conversations remain isolated while model context identifies private chat without IDs',()=>{
  const memory=new ConversationMemory(new SqliteSessionStore(':memory:'),()=>at);
  try {
    memory.add('private:2','2','秘密','知道了');memory.add('10','2','群话题','回复');
    assert.equal(memory.get('10','2')[0].content,'群话题');
    assert.equal(memory.get('20','2').length,0);
    const group=new ChatContext(()=>at);
    group.add({chatId:'private:2',senderId:'2',content:'你好',isMentioned:true,messageId:'3'});
    const view=modelContext({kind:'explicit',targetSenderId:'2',triggerIds:['3'],snapshot:group.snapshot('private:2')}).context;
    assert.equal(view.snapshot.chatId,'current-private-chat');
    assert.ok(!JSON.stringify(view).includes('private:2'));
  } finally {memory.close();}
});

test('public personal memories cross groups, private facts never reach the selector without permission',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());
  seed(store,'10');seed(store,'20');seed(store,'private:2');seed(store,'10','3');seed(store,'30');
  const recall=createPersonalRecall(store,async q=>{
    assert.equal(q.records.length,2);
    assert.deepEqual(q.records.map(r=>r.source).sort(),['current_chat','other_group']);
    return q.records.map(r=>r.id);
  },presentPersonalRecall,groups,async()=>undefined,()=>at+5000);
  const result=await recall(query(),signal());
  assert.equal(result.view.records.length,2);assert.equal(result.isCurrent(),true);
});

test('private chat recalls own public/private memories and never another user',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());
  seed(store,'20');seed(store,'private:2');seed(store,'private:3','3');
  const recall=createPersonalRecall(store,async q=>{
    assert.equal(q.records.length,2);return q.records.map(r=>r.id);
  },presentPersonalRecall,groups,async()=>{throw Error('private chat needs no disclosure gate');},()=>at+5000);
  assert.equal((await recall(query('private:2'),signal())).view.records.length,2);
  assert.equal((await recall(query('private:3'),signal())).view.records.length,0);
});

test('explicit disclosure is limited to this turn/topic and source clearing invalidates its draft',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());seed(store,'private:2');
  let allowed=true,calls=0;
  const recall=createPersonalRecall(store,async q=>{
    calls++;assert.equal(q.privateTopic,'考试');assert.equal(q.records[0].source,'private_chat');
    return [q.records[0].id];
  },presentPersonalRecall,groups,async()=>allowed?'考试':undefined,()=>at+5000);
  const result=await recall(query(),signal());assert.equal(result.view.records.length,1);
  allowed=false;assert.equal((await recall(query(),signal())).view.records.length,0);assert.equal(calls,1);
  store.clear({chatId:'private:2',ownerId:'2'});assert.equal(result.isCurrent(),false);
});

test('disclosure failures fail closed without disabling public recall',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());seed(store,'10');seed(store,'private:2');
  const recall=createPersonalRecall(store,async q=>{
    assert.equal(q.records.length,1);assert.equal(q.records[0].source,'current_chat');return [q.records[0].id];
  },presentPersonalRecall,groups,async()=>{throw Error('timeout');},()=>at+5000);
  assert.equal((await recall(query(),signal())).view.status,'matched');
});

test('personal preferences are presented with evidence; global clear also removes queued private extraction',async t=>{
  const store=new EventStore(':memory:');t.after(()=>store.close());seed(store,'20','2',true);
  const recall=createPersonalRecall(store,async q=>[q.records[0].id],presentPersonalRecall,groups,async()=>undefined,()=>at+5000);
  const result=await recall(query(),signal());
  assert.equal((result.view.records[0].facts as {nickname:string}).nickname,'小鱼');
  store.ingest({chatId:'private:2',ownerId:'2',messageId:'queued',text:'私事',sourceAt:at,receivedAt:at});
  eventControls.handle('/清空个人长期记忆',query(),store,at+5000);
  assert.equal(result.isCurrent(),false);assert.equal(store.claim(at+10000),undefined);
  assert.equal((await recall(query(),signal())).view.records.length,0);
});

test('disclosure validates a literal authorization quote and sends no private memory to the gate',async()=>{
  let content:unknown;
  const make=(answer:unknown)=>createPrivateDisclosure('key','model',async(_url,init)=>{
    content=JSON.parse(String(init?.body)).messages[1].content;
    return Response.json({choices:[{message:{content:JSON.stringify(answer)}}]});
  });
  assert.equal(await make({quote:'不存在的授权',topic:'考试'})('你好',signal()),undefined);
  assert.equal(await make({quote:null,topic:null})('记得我吗',signal()),undefined);
  const text='接着说我私聊提到的考试';
  assert.equal(await make({quote:text,topic:'考试'})(text,signal()),'考试');
  assert.deepEqual(JSON.parse(String(content)),{text});
});

test('runtime accepts private addressed facts even though the group allowlist is numeric',async()=>{
  const store=new EventStore(':memory:');
  const runtime=new EventMemoryRuntime(store,[],async()=>({}),{groups,scope:'addressed',mode:'observe'},
    eventControls,undefined,()=>at,()=>0,()=>{});
  runtime.resume();
  runtime.ingest({chatId:'private:2',senderId:'2',content:'我明天考试',messageId:'p1',isMentioned:true,timestamp:at});
  assert.equal(store.claim(at+5000)?.chatId,'private:2');
  runtime.close();
});
