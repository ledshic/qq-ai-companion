import { isRecord } from '../../onebot.js';
import type { RecallPresenter } from '../recall.js';
import type { EventPayload } from './event.js';
// Presentation follows the generic event contract, never topic keywords.
export const presentEventRecall: RecallPresenter = (record, evidence, alias) => {
  if (record.domain !== 'event' || !isRecord(record.payload) || record.payload.type !== 'event') return;
  const payload = record.payload as unknown as EventPayload;
  const sanitize = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === 'evidenceIds' ? undefined : item));
  return Object.freeze({ id: alias, recordedAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(),
    facts: sanitize({ topic: payload.topic, summary: payload.summary, startOn: payload.startOn, period: payload.period,
      durationDays: payload.durationDays, anchors: payload.anchors }),
    // Suggestions, business keys and transport identifiers are deliberately excluded.
    evidence: Object.freeze(evidence.slice(-3).map((proof, i) => Object.freeze({ id: `${alias}-proof-${i + 1}`,
      at: proof.sourceAt === null ? null : new Date(proof.sourceAt).toISOString(), excerpt: proof.excerpt.slice(0, 500) }))),
  });
};
