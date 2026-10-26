import type { DatabaseSync } from 'node:sqlite';
import type { EventPayload } from '../domains/event.js';
// One-time compatibility with the retired v1 payload. Not an extraction/projection rule.
export const migrateEventPayloadsV2 = (db: DatabaseSync): void => {
  const rows = db.prepare("SELECT id,body FROM event_memories WHERE domain NOT IN ('event','contact')").all();
  for (const row of rows) {
    const old = JSON.parse(String(row.body));
    const value = old.payload;
    if (!value || typeof value !== 'object' || !('period' in value || 'statement' in value)) continue;
    const proof = db.prepare('SELECT excerpt FROM event_evidence WHERE id=?').get(old.evidenceIds[0] ?? '');
    const anchors = value.resumeOn ? [{ label: '原记录的后续里程碑', date: value.resumeOn }] : [];
    const payload: EventPayload = {
      type: 'statement' in value ? 'proposal' : 'event', topic: old.domain,
      summary: String(proof?.excerpt ?? value.statement ?? '历史事件，具体事实以原始证据为准').slice(0, 300),
      startOn: value.period ? { value: { date: value.period.value.startDate, timezone: value.period.value.timezone }, basis: 'derived', evidenceIds: value.period.evidenceIds } : null,
      period: value.period ?? null, durationDays: value.durationDays ?? null, anchors,
      followup: 'statement' in value ? null : { anchor: anchors.length ? 0 : 'end', intent: '依据原记录询问近况', basis: anchors.length ? 'stated' : 'inferred' },
    };
    const converted = { ...old, domain: 'event', businessKey: `legacy:${old.domain}:${old.businessKey}`, payload };
    db.prepare('UPDATE event_memories SET domain=?,business_key=?,body=? WHERE id=?').run('event', converted.businessKey, JSON.stringify(converted), old.id);
    for (const item of db.prepare('SELECT id,body FROM attention_items WHERE event_id=?').all(old.id)) {
      const before = JSON.parse(String(item.body));
      const after = { ...before, kind: 'event_followup', payload: { topic: payload.topic,
        intent: payload.followup?.intent, basis: payload.followup?.basis, anchor: payload.followup?.anchor } };
      db.prepare('UPDATE attention_items SET kind=?,body=? WHERE id=?').run(after.kind, JSON.stringify(after), item.id);
    }
  }
  db.exec('UPDATE event_schema_version SET version=2');
};
