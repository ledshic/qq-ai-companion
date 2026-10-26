import { requestChatCompletion, completionText } from '../model-request.js';
import { readFileSync } from 'node:fs';
import { modelContext, type ReplyContext } from '../context.js';
import { parseObservation } from '../context-analysis.js';
import { isRecord } from '../value.js';
import { chatSystemPrompt } from '../persona.js';
import { parsePersonalityMode, resolveExpression } from '../personality-policy.js';
import { presentEventRecall } from './domains/event-recall.js';
import type { ContactPayload } from './domains/contact.js';
import type { InitiativeObserver } from './initiative-types.js';
import { loadEventReferences } from './references.js';

// Application-level model adapter: generic engine knows neither persona nor theme semantics.
export const createInitiativeObserver = (key:string,model:string,mode='modular',request:typeof fetch=fetch):InitiativeObserver => {
  const rules=readFileSync(new URL('../../config/event-memory/initiative.md',import.meta.url),'utf8').trim();
  const references=loadEventReferences()+'\n'+readFileSync(new URL('../../config/event-memory/initiative-references.md',import.meta.url),'utf8').trim(),personality=parsePersonalityMode(mode);
  const complete=async(system:string,data:unknown,signal:AbortSignal,maxTokens:number):Promise<Record<string,unknown>>=>{
    const response = await requestChatCompletion(key, {model,thinking:{type:'disabled'},stream:false,max_tokens:maxTokens,response_format:{type:'json_object'},
        messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(data)}]}, { request, signal, timeoutMs: 5000, httpError: 'initiative_http' });
    signal.throwIfAborted();
    const raw: unknown = JSON.parse(completionText(response, 'initiative_format'));if(!isRecord(raw))throw Error('initiative_format');return raw;
  };
  return async(input,signal)=>{
    signal.throwIfAborted();
    const document=presentEventRecall(input.record,input.evidence,'memory-1');
    if(!document)return {status:'skipped',reason:'unsupported_record'};
    // Existing preferences apply to observation too, without exposing preference evidence or IDs.
    const contact=input.records.find(r=>r.domain==='contact')?.payload as ContactPayload|undefined;
    const latest=input.snapshot.messages.filter(m=>m.role==='user'&&m.senderId===input.attention.ownerId).at(-1);
    if(!latest||input.now-latest.at>15*60_000)return {status:'skipped',reason:'no_recent_context'};
    if(input.snapshot.messages.some(m=>m.role==='assistant'&&input.now-m.at<5*60_000))return {status:'skipped',reason:'recent_bot_reply'};
    const context:ReplyContext={kind:'interject',targetSenderId:input.attention.ownerId,triggerIds:[latest.id],snapshot:input.snapshot};
    const anonymous=modelContext(context).context;
    const targetId=anonymous.triggerIds[0];
    const analysis={text:'评估一次有证据的关注机会；这不是目标用户当前请求。',history:[],context:anonymous};
    const data={now:new Date(input.now).toISOString(),timezone:'Asia/Shanghai',memory:document,
      opportunity:{at:new Date(input.attention.occurrenceAt).toISOString(),suggestion:input.attention.payload,tone:input.attention.tone},
      discussion:anonymous,banter:contact?.banter??'default'};
    const allowed=new Set(['memory-1',...anonymous.snapshot.messages.map(m=>m.id)]);
    const basis=(value:unknown,required:boolean):string[]|undefined=>Array.isArray(value)&&value.length>0&&value.length<=10&&
      value.every(id=>typeof id==='string'&&allowed.has(id))&&new Set(value).size===value.length&&
      (!required||value.includes('memory-1')&&value.includes(targetId))?value:undefined;
    let stage='decision';
    try {
      const decision=await complete('只输出 JSON，根对象仅有 action、reason、basis、observation。action 为 skip 或 draft；observation 仅含 intent(question/casual/play/support/unknown)、seriousness(explicit/inferred/unknown)、requestedBanter(stop/allow/unspecified)、evidenceRefs(仅当前群聊消息别名)。\n'+rules+'\n'+references,data,signal,500);
      const keys=['action','reason','basis','observation'];
      if(Object.keys(decision).some(k=>!keys.includes(k))||!['skip','draft'].includes(String(decision.action))||
        !['natural_opening','busy','sensitive','already_discussed','awkward','uncertain'].includes(String(decision.reason)))throw Error('initiative_decision');
      const refs=basis(decision.basis,decision.action==='draft');
      if(!refs)throw Error('initiative_basis');
      if(decision.action==='skip')return {status:'skipped',reason:String(decision.reason),basis:refs};
      const observation=parseObservation(decision.observation,analysis);
      if(decision.reason!=='natural_opening'||!observation||observation.evidenceRefs.some(id=>!allowed.has(id)))throw Error('initiative_observation');
      const expressionPlan=resolveExpression(contact?.banter==='off'?{...observation,requestedBanter:'stop'}:observation);
      stage='expression';
      const draft=await complete(chatSystemPrompt(0,false,false,false,personality==='modular'?expressionPlan:undefined)+
        '\n'+rules+'\n'+references+'\n仅输出 JSON {"text":"一句或两句候选台词","basis":["memory-1","实际目标消息别名"]}。这是主动关心候选，不是在回答内部评估请求；不要调用工具或声称已发送。',
        {...data,decision:{reason:decision.reason,basis:refs},expressionPlan},signal,500);
      const proof=basis(draft.basis,true);
      if(Object.keys(draft).some(k=>!['text','basis'].includes(k))||typeof draft.text!=='string'||!draft.text.trim()||draft.text.length>300||!proof)throw Error('initiative_draft');
      // A separate review sees original evidence/context, not the decision's justification.
      stage='review';
      const review=await complete(chatSystemPrompt(0,false,false,false,personality==='modular'?expressionPlan:undefined)+
        '\n你是独立草稿审查者，不改写、不发送。仅输出 JSON，例如 {"verdict":"accept","reason":"grounded","basis":["memory-1"]}。verdict 只能 accept/reject；reason 只能 grounded/unsupported/intrusive/persona_mismatch。accept 必须配 grounded，reject 必须配其他理由。basis 使用实际资料别名。不能把计划或推断当成已发生事实；公开追问敏感事件必须拒绝。\n'+rules+'\n'+references,
        {...data,draft:draft.text},signal,400);
      const checked=basis(review.basis,false);
      if(Object.keys(review).some(k=>!['verdict','reason','basis'].includes(k))||!['accept','reject'].includes(String(review.verdict))||
        !['grounded','unsupported','intrusive','persona_mismatch'].includes(String(review.reason))||!checked||
        (review.verdict==='accept')!==(review.reason==='grounded'))throw Error('initiative_review');
      if(review.verdict==='reject')return {status:'rejected',reason:String(review.reason),basis:checked};
      return {status:'drafted',reason:'natural_opening',text:draft.text.trim(),basis:proof,expressionPlan};
    }catch{signal.throwIfAborted();return {status:'unavailable',reason:`${stage}_error`};}
  };
};
