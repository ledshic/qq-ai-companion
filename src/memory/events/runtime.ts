import { randomUUID } from 'node:crypto';
import type { ArchiveSummarizer } from './summarize.js';
import { isPrivateChat, privateChatId } from '../../runtime/chat-scope.js';
import type { InitiativeContext, InitiativeObserver } from './initiative-types.js';
import { recallView, rankMemoryCandidates } from './recall.js';
import type { RecallProvider, RecallQuery, RecallResult } from './recall-types.js';
import type { ChatMessage } from '../../runtime/message.js';
import { EventStore } from './store.js';
import { observeAttention } from './observe-policy.js';
import type { EventConfig, EventDomain, EventMemoryPort, Extractor, Scope } from './types.js';
export interface EventControls {
  matches(text:string):boolean;
  handle(text:string,scope:Scope,store:EventStore,now:number):string|undefined;
}
export class EventMemoryRuntime implements EventMemoryPort {
  private acquire?: (controller:AbortController)=>(()=>void)|undefined;
  private active?:AbortController;
  private paused=true;
  private disabled=false;
  private closed=false;
  private context?:InitiativeContext;
  private presence=new Map<string,number>();
  constructor(private store:EventStore,private domains:EventDomain[],private extract:Extractor,
    private config:EventConfig,private controls:EventControls,
    private scopeRestriction:(records:import('./types.js').EventRecord[],settings:Record<string,unknown>)=>{reason:string;terminal:boolean}|undefined=()=>undefined,
    private now=Date.now,private random=Math.random,private log:(line:string)=>void=console.log,
    private retrieval?:RecallProvider,private initiative?:InitiativeObserver,private summarize?:ArchiveSummarizer) {
    store.recover();store.prune(now());
  }
  attach(acquire:(controller:AbortController)=>(()=>void)|undefined,context?:InitiativeContext):void{this.acquire=acquire;this.context=context;}
  resume():void{if(!this.closed)this.paused=false;}
  pause():void{this.paused=true;this.active?.abort(new Error('event_paused'));}
  close():void{if(this.closed)return;this.closed=true;this.pause();if(!this.active)this.store.close();}
  private fail():void {this.disabled=true;this.active?.abort(new Error('event_disabled'));this.log('[事件记忆] disabled=storage_error');}
  private enabledScope(chatId:string,ownerId:string):boolean {
    return this.config.groups.has(chatId)||chatId===privateChatId(ownerId);
  }
  ingest(message:ChatMessage):void {
    if(this.paused||this.disabled||this.closed||this.config.mode!=='observe'||!this.enabledScope(message.chatId,message.senderId))return;
    const text=message.content.trim();
    if(!message.messageId||message.messageId.startsWith('local-')||text.startsWith('/'))return;
    const addressed=message.isMentioned||message.isCalledByName||message.isReplyToBot;
    const at=message.timestamp??null,now=this.now();
    if(at!==null&&(at<now-86_400_000||at>now+5*60_000))return;
    try {
      // Metadata-only dedup also covers unaddressed activity; message bodies are not collected there.
      if(this.store.markSeen(message.chatId,message.messageId,now)) {
        this.presence.set(JSON.stringify([message.chatId,message.senderId]),now);
        while(this.presence.size>2000)this.presence.delete(this.presence.keys().next().value!);
      }
      if(this.config.scope==='addressed'&&!addressed)return;
      this.store.archive.append({chatId:message.chatId,ownerId:message.senderId},'user',message.messageId,text||(message.hasMedia?'[媒体消息；未保留原始媒体]':''),at??now,message.replyMessageId);
      if(!text||text.length>4000)return;
      const stored=this.store.ingest({chatId:message.chatId,ownerId:message.senderId,messageId:message.messageId,
        text,sourceAt:at,receivedAt:now});
      if(stored)this.log('[事件记忆] source=queued; mode=observe');
    } catch{this.fail();}
  }
  delivered(scope:Scope,text:string,messageId?:string,replyTo?:string):void {
    if(this.disabled||this.closed||!this.enabledScope(scope.chatId,scope.ownerId))return;
    try {this.store.archive.append(scope,'assistant',messageId??randomUUID(),text,this.now(),replyTo);}
    catch{this.fail();}
  }
  control(message:ChatMessage):string|undefined {
    if(this.disabled||this.closed||!this.enabledScope(message.chatId,message.senderId))return;
    const text=message.content.trim();
    if(!this.controls.matches(text))return;
    try {
      if(message.messageId&&!this.store.markSeen(message.chatId,message.messageId,this.now()))return '该记忆操作已处理。';
      return this.controls.handle(text,{chatId:message.chatId,ownerId:message.senderId},this.store,this.now());
    }
    catch{this.fail();return '长期记忆当前不可用，未完成此操作。';}
  }
  async recall(query:RecallQuery,signal:AbortSignal):Promise<RecallResult> {
    signal.throwIfAborted();
    if(this.paused||this.disabled||this.closed||!this.enabledScope(query.chatId,query.ownerId)||!this.retrieval)
      return {view:recallView('disabled',this.now()),isCurrent:()=>!this.closed};
    const start=this.now();
    try {
      const result=await this.retrieval(query,signal);
      signal.throwIfAborted();
      this.log(`[长期召回] status=${result.view.status}; count=${result.view.records.length}; ms=${this.now()-start}`);
      return {view:result.view,isCurrent:()=>!this.paused&&!this.disabled&&!this.closed&&result.isCurrent()};
    } catch {
      signal.throwIfAborted();
      this.log('[长期召回] status=unavailable; count=0');
      return {view:recallView('unavailable',this.now()),isCurrent:()=>!this.closed};
    }
  }
  async tick():Promise<void> {
    if(this.paused||this.disabled||this.closed||this.active||this.config.mode!=='observe')return;
    // Acquire before claiming: queued inputs do not consume a model budget while foreground is busy.
    const controller=new AbortController(),release=this.acquire?.(controller);
    if(!release)return;
    this.active=controller;
    let batch;
    try {
      this.store.prune(this.now());batch=this.store.claim(this.now());
      if(batch){
        const input={sources:batch.sources,existing:rankMemoryCandidates(this.store.retainedRecords(batch,this.now()),batch.sources.map(s=>s.text).join("\n")),now:this.now(),
          prompts:this.domains.map(d=>({name:d.name,prompt:d.prompt}))};
        let raw:Record<string,unknown>;
        try{raw=await this.extract(input,controller.signal);controller.signal.throwIfAborted();}
        catch{this.store.finish(batch,controller.signal.aborted?'cancelled':'failed');this.log('[事件记忆] extraction=unavailable; retry=false');return;}
        let mutations;
        try{mutations=this.domains.flatMap(d=>d.interpret(raw[d.name]??[],input));}
        catch{this.store.finish(batch,'failed');this.log('[事件记忆] extraction=rejected; retry=false');return;}
        if(controller.signal.aborted){this.store.finish(batch,'cancelled');return;}
        let committed;
        try { committed=this.store.commit(batch,mutations,this.domains,this.now(),this.random); }
        catch(error) {
          if(error instanceof Error && ['event_capacity','event_evidence_scope','event_expiry','event_target_scope','event_conflicting_target'].includes(error.message)) {
            this.store.finish(batch,'failed');this.log('[事件记忆] extraction=rejected; reason=validation_or_capacity');return;
          }
          throw error;
        }
        this.log(`[事件记忆] extraction=${committed?'committed':'invalidated'}; mutations=${mutations.length}; mode=observe`);
      }
      if(this.summarize){
        const job=this.store.archive.nextSummary(this.now(),scope=>this.enabledScope(scope.chatId,scope.ownerId));
        if(job){
          try {
            const items=await this.summarize(job,controller.signal);
            controller.signal.throwIfAborted();
            if(!this.paused&&!this.closed)this.store.archive.finishSummary(job,items);
          }catch{
            if(!controller.signal.aborted)this.store.archive.finishSummary(job,undefined);
          }
        }
      }
      await this.observe(controller.signal);
    }catch{if(!controller.signal.aborted)this.fail();}
    finally{release();this.active=undefined;if(this.closed)this.store.close();}
  }
  private async observe(signal:AbortSignal):Promise<void> {
    let evaluated=false;
    for(const item of this.store.attentions()) {
      if(isPrivateChat(item.chatId)||!this.config.groups.has(item.chatId))continue;
      const scope={chatId:item.chatId,ownerId:item.ownerId};
      const records=this.store.records(scope,this.now());
      const block=item.status==='pending'?this.scopeRestriction(records,this.store.settings(scope)):undefined;
      if(block?.terminal)this.store.cancelScope(scope);
      const reason=block?.reason??observeAttention(item,{now:this.now(),epoch:this.store.epoch(scope),records,
        lastPresence:this.presence.get(JSON.stringify([item.chatId,item.ownerId]))});
      if(this.store.observe(item.id,reason))this.log(`[关注观察] state=${reason}; mode=observe; send=false`);
      if(reason!=='ready_for_review'||evaluated||!this.initiative||!this.context)continue;
      signal.throwIfAborted();
      const record=records.find(r=>r.id===item.eventId&&r.version===item.eventVersion)!;
      const evidence=this.store.recallEvidence(scope,record.evidenceIds,this.now());
      if(!evidence.length||record.evidenceIds.some(id=>!evidence.some(e=>e.id===id)))continue;
      const snapshot=this.context(scope),attempt=this.store.claimInitiative(item,this.now(),snapshot.version);
      if(!attempt)continue;
      evaluated=true;
      let result:import('./initiative-types.js').InitiativeResult;
      try{result=await this.initiative({attention:item,record,evidence,records,snapshot,now:this.now()},signal);}
      catch{result={status:signal.aborted?'interrupted':'unavailable',reason:signal.aborted?'cancelled':'model_error'};}
      const updated=this.store.attentions(scope).find(a=>a.id===item.id);
      const liveRecords=this.store.records(scope,this.now());
      const blocked=this.scopeRestriction(liveRecords,this.store.settings(scope));
      const stillCurrent=!signal.aborted&&!this.paused&&!this.disabled&&!this.closed&&!blocked&&updated&&
        updated.eventVersion===item.eventVersion&&observeAttention(updated,{now:this.now(),epoch:this.store.epoch(scope),records:liveRecords,
          lastPresence:this.presence.get(JSON.stringify([item.chatId,item.ownerId]))})==='ready_for_review'&&
        this.store.recallEvidence(scope,record.evidenceIds,this.now()).length===new Set(record.evidenceIds).size&&
        this.context(scope).version===snapshot.version;
      if(!stillCurrent)result={status:signal.aborted?'interrupted':'invalidated',reason:signal.aborted?'cancelled':'context_or_memory_changed'};
      this.store.finishInitiative(attempt,result,this.now());
      this.log(`[主动观察] status=${result.status}; mode=observe; send=false`);
      if(signal.aborted)return;
    }
  }
}
