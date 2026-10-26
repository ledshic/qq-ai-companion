import { isRecord } from '../../value.js';
import type { EventDomain } from '../types.js';
export interface ContactPayload { proactive:'on_presence'|'off';banter:'default'|'off';nickname?:string }
export const contactDomain:EventDomain={
  name:'contact',
  prompt:'返回数组，默认 []。只提取本人明确要求的互动偏好，每项 {"source":"source-1","quote":"逐字原句","proactive":null,"banter":null,"nickname":null}。proactive只能为off（明确不要主动联系）或on_presence（明确重新允许），banter只能off或default，nickname只有明确要求称呼时填写，最多20字。未要求的字段为null，不根据情绪推断。',
  interpret(raw,ctx){
    if(!Array.isArray(raw)||raw.length>10)throw Error('contact_schema');
    const result=[];
    for(const item of raw){
      if(!isRecord(item)||Object.keys(item).some(k=>!['source','quote','proactive','banter','nickname'].includes(k))||
        typeof item.source!=='string'||typeof item.quote!=='string'||!item.quote||item.quote.length>500)throw Error('contact_schema');
      const m=/^source-([1-9]\d*)$/.exec(item.source),source=m?ctx.sources[Number(m[1])-1]:undefined;
      if(!source||!source.text.includes(item.quote))throw Error('contact_evidence');
      if(item.proactive!=null&&(typeof item.proactive!=='string'||!['off','on_presence'].includes(item.proactive)))throw Error('contact_schema');
      if(item.banter!=null&&(typeof item.banter!=='string'||!['off','default'].includes(item.banter)))throw Error('contact_schema');
      if(item.nickname!=null&&(typeof item.nickname!=='string'||!item.nickname.trim()||item.nickname.length>20||!item.quote.includes(item.nickname)))throw Error('contact_schema');
      const previous=ctx.existing.find(e=>e.domain===this.name)?.payload as ContactPayload|undefined;
      const payload:ContactPayload={proactive:(item.proactive??previous?.proactive??'on_presence') as ContactPayload['proactive'],
        banter:(item.banter??previous?.banter??'default') as ContactPayload['banter'],...(previous?.nickname?{nickname:previous.nickname}:{}),
        ...(typeof item.nickname==='string'?{nickname:item.nickname}:{})};
      result.push({domain:this.name,businessKey:'current',payload,evidenceIds:[source.id],excerpts:{[source.id]:item.quote},operation:'upsert' as const,expiresAt:8_000_000_000_000});
    }
    return result;
  },
  project(){return [];},
};
