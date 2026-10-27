import { isRecord } from '../../../shared/value.js';
import type { RecallPresenter } from '../recall-types.js';
import type { EventPayload } from './event.js';
// Presentation follows the generic event contract, never topic keywords.
export const presentEventRecall: RecallPresenter = (record, evidence, alias) => {
  if (record.domain !== 'event' || !isRecord(record.payload) || record.payload.type !== 'event') return;
  const payload = record.payload as unknown as EventPayload;
  const sanitize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === 'evidenceIds' ? undefined : item));
  return Object.freeze({ id: alias, recordedAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(),
    facts: sanitize({ phase: record.status==='historical'?'historical':'current', validityUntil: new Date(record.expiresAt).toISOString(), topic: payload.topic, summary: payload.summary, startOn: payload.startOn, period: payload.period,
      durationDays: payload.durationDays, anchors: payload.anchors }),
    // Suggestions, business keys and transport identifiers are deliberately excluded.
    evidence: Object.freeze(evidence.slice(-3).map((proof, i) => Object.freeze({ id: `${alias}-proof-${i + 1}`,
      at: proof.sourceAt === null ? null : new Date(proof.sourceAt).toISOString(), excerpt: proof.excerpt.slice(0, 500) }))),
  });
};

// Interaction preferences are personal facts too; provenance/privacy is filtered before presentation.
export const presentPersonalRecall: RecallPresenter = (record, evidence, alias) => {
  if (record.domain==='profile'||record.domain==='conversation') return Object.freeze({id:alias,
    recordedAt:new Date(record.createdAt).toISOString(),updatedAt:new Date(record.updatedAt).toISOString(),facts:JSON.parse(JSON.stringify(record.payload,(key,value)=>key==='sources'?undefined:value)),
    evidence:Object.freeze(evidence.slice(-3).map((proof,i)=>Object.freeze({id:`${alias}-proof-${i+1}`,
      at:proof.sourceAt===null?null:new Date(proof.sourceAt).toISOString(),excerpt:proof.excerpt.slice(0,500)})))});
  if (record.domain !== 'contact') return presentEventRecall(record,evidence,alias);
  if (!isRecord(record.payload)) return;
  return Object.freeze({ id: alias, recordedAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(), facts: {
      type: 'interaction_preference', nickname: record.payload.nickname,
      banter: record.payload.banter, proactive: record.payload.proactive,
    }, evidence: Object.freeze(evidence.map((proof,i) => Object.freeze({ id: `${alias}-proof-${i+1}`,
      at: proof.sourceAt === null ? null : new Date(proof.sourceAt).toISOString(), excerpt: proof.excerpt.slice(0,500) }))),
  });
};
