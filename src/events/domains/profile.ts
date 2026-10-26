import { isRecord } from '../../value.js';
import { FOREVER } from '../archive.js';
import type { EventDomain, Mutation } from '../types.js';

export const profileDomain: EventDomain = {
  name:'profile',
  prompt:`返回数组，默认[]。只记录本人明确陈述、值得长期记住的稳定背景或互动偏好，不从语气、玩笑、单次行为、第三方或情绪推测性格、关系、身份。临时计划放event，不放画像。
每项 {"operation":"record","field":"简短稳定字段名","value":"原文中的值","source":"source-1","quote":"逐字原文"}。
operation为record/correct/retract。field例如称呼、职业、常住地区、兴趣、沟通偏好；同一字段沿用existing中的名称。value必须是quote里的逐字片段，不能概括推断。更正覆盖本来源字段的当前值，撤回时value=null且必须有明确撤回原句。多窗口矛盾不擅自统一；不能把“他是老师”记成本人职业。`,
  interpret(raw,ctx) {
    if(!Array.isArray(raw)||raw.length>10)throw Error('profile_schema');
    const mutations:Mutation[]=[];
    for(const item of raw) {
      if(!isRecord(item)||Object.keys(item).some(k=>!['operation','field','value','source','quote'].includes(k))||
        !['record','correct','retract'].includes(String(item.operation))||typeof item.field!=='string'||
        !item.field.trim()||item.field.length>40||typeof item.source!=='string'||typeof item.quote!=='string'||
        !item.quote.trim()||item.quote.length>500)throw Error('profile_schema');
      const match=/^source-([1-9]\d*)$/.exec(item.source),source=match?ctx.sources[Number(match[1])-1]:undefined;
      if(!source||!source.text.includes(item.quote))throw Error('profile_evidence');
      const previous=ctx.existing.find(r=>r.domain==='profile'&&r.businessKey===item.field);
      const retract=item.operation==='retract';
      if(retract&&!previous)continue;
      if(!retract&&(typeof item.value!=='string'||!item.value.trim()||item.value.length>200||!item.quote.includes(item.value)))throw Error('profile_evidence');
      mutations.push({domain:this.name,businessKey:item.field,payload:{type:'profile_fact',field:item.field,value:item.value},
        operation:retract?'retract':previous?'replace':'upsert',...(previous?{targetId:previous.id,expectedVersion:previous.version}:{}),
        evidenceIds:[source.id],excerpts:{[source.id]:item.quote},expiresAt:FOREVER});
    }
    return mutations;
  },
  project(){return [];},
};
