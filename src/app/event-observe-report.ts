import { DatabaseSync } from 'node:sqlite';
import type { InitiativeAttempt } from '../memory/events/initiative-types.js';
// Read-only local inspection: no model, event runtime or QQ client is constructed.
const db=new DatabaseSync(process.env.MEMORY_DB||'data/memory.db',{readOnly:true});
try {
  const groups=new Map<string,string>(),owners=new Map<string,string>();
  const alias=(map:Map<string,string>,key:string,prefix:string)=>{if(!map.has(key))map.set(key,`${prefix}-${map.size+1}`);return map.get(key);};
  const exists=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attention_observations'").get();
  const rows=exists?db.prepare('SELECT body FROM attention_observations ORDER BY started_at DESC LIMIT 20').all():[];
  console.log(JSON.stringify({mode:'observe',sendCapability:false,note:'历史观察草稿，未经发送验收；不代表当前仍适合发言。',
    observations:rows.map(row=>{
      const attempt=JSON.parse(String(row.body)) as InitiativeAttempt;
      const memory=db.prepare("SELECT version,epoch,status,expires_at,body FROM event_memories WHERE id=(SELECT event_id FROM attention_items WHERE id=?)").get(attempt.attentionId);
      return {group:alias(groups,attempt.chatId,'group'),owner:alias(owners,JSON.stringify([attempt.chatId,attempt.ownerId]),'user'),
        eventSummary:memory&&memory.version===attempt.eventVersion?JSON.parse(String(memory.body)).payload.summary:undefined,
        tone:attempt.opportunity.tone,window:{from:new Date(attempt.opportunity.notBefore).toISOString(),until:new Date(attempt.opportunity.expiresAt).toISOString()},
        contextVersion:attempt.contextVersion,at:new Date(attempt.startedAt).toISOString(),finishedAt:attempt.finishedAt?new Date(attempt.finishedAt).toISOString():null,
        memoryStillCurrent:!!memory&&memory.version===attempt.eventVersion&&memory.epoch===attempt.epoch&&memory.status==='active'&&Number(memory.expires_at)>Date.now(),
        ...(attempt.result??{status:'processing'})};
    })},null,2));
} finally {db.close();}
