import type { Attention, EventRecord } from './types.js';
export interface ObservationContext {now:number;lastPresence?:number;records:EventRecord[];epoch:number}
// Transport eligibility only. No domain names, business dates or model calls here.
export const observeAttention=(item:Attention,context:ObservationContext):string=>{
  if(item.status!=='pending')return item.status;
  if(item.epoch!==context.epoch)return 'invalidated';
  if(!context.records.some(e=>e.id===item.eventId&&e.version===item.eventVersion))return 'evidence_changed';
  if(context.now>=item.expiresAt)return 'expired';
  if(context.now<item.notBefore)return 'not_due';
  if(item.requiresPresence&&(!context.lastPresence||context.lastPresence<item.occurrenceAt||context.now-context.lastPresence>15*60_000))return 'no_presence';
  return 'ready_for_review'; // Not approval to send; social checks and budgets are a later stage.
};
