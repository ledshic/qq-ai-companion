import { ChatContext } from '../runtime/conversation/context.js';
// Deterministic event and initiative-observe replay: no QQ connection, provider key or send function.
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../memory/events/store.js';
import {EventMemoryRuntime} from '../memory/events/runtime.js';
import {createEventDomain} from '../memory/events/domains/event.js';
const eventDomain=createEventDomain();
import {eventControls} from '../memory/events/controls.js';
const dir=mkdtempSync(join(tmpdir(),'event-replay-')),path=join(dir,'events.db');
let now=Date.parse('2026-10-23T10:00:00+08:00');
const logs:string[]=[];
const make=()=>{
 const store=new EventStore(path),discussion=new ChatContext(()=>now);
 const runtime=new EventMemoryRuntime(store,[eventDomain],async()=>({event:[{operation:'record',target:null,assertion:'stated',topic:'休假计划',summary:'休假与后续安排',
  statement:{source:'source-1',text:'明天休两天，周一上班'},start:{source:'source-1',text:'明天'},
  duration:{source:'source-1',text:'两天'},anchors:[{label:'复工',date:{source:'source-1',text:'周一'},notBeforeEnd:true}],followup:{anchor:0,intent:'询问近况',basis:'stated'}}]}),
  {groups:new Set(['demo']),scope:'addressed',mode:'observe'},eventControls,()=>undefined,()=>now,()=>.5,line=>logs.push(line),undefined,async()=>({status:'drafted',reason:'natural_opening',text:'今天按计划开工啦？我的尾巴还想再歇一会儿。'}));
 runtime.attach(()=>()=>{},()=>discussion.snapshot('demo'));runtime.resume();return {store,runtime,discussion};
};
let current=make();
try{
 current.runtime.ingest({chatId:'demo',senderId:'member',messageId:'demo-1',timestamp:now,content:'明天休两天，周一上班',isMentioned:true});
 now+=4000;await current.runtime.tick();
 const before=current.store.attentions()[0];
 current.runtime.close();now=Date.parse('2026-10-26T10:00:00+08:00');current=make();
 await current.runtime.tick();
 const presence={chatId:'demo',senderId:'member',messageId:'demo-2',timestamp:now,content:'早上好',isMentioned:false};
 current.discussion.add(presence);current.runtime.ingest(presence);
 await current.runtime.tick();await current.runtime.tick();
 const after=current.store.attentions()[0];
 console.log(JSON.stringify({mode:'observe',model:'scripted-fixture',sendCapability:false,
  restartPreservedId:before.id===after.id,restartPreservedTone:before.tone===after.tone,
  finalObservation:after.observation,initiativeEvaluations:current.store.initiatives().length,
  initiative:current.store.initiatives()[0]?.result,logs},null,2));
}finally{current.runtime.close();rmSync(dir,{recursive:true,force:true});}
