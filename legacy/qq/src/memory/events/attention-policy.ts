import type { Attention, EventDomain, EventRecord } from './types.js';

export const selectAttentionTone = (previous: Attention['tone'] | undefined,
  random: () => number): Attention['tone'] =>
  previous ?? (['upbeat', 'wry', 'gentle'] as const)[Math.min(2, Math.max(0, Math.floor(random() * 3)))];

export interface AttentionProjection {
  upserts: Attention[];
  cancellations: Attention[];
}

// Build the next attention state without reading or writing storage. The store
// invokes this inside its transaction and atomically applies the returned plan.
export const projectAttentions = (record: EventRecord, previous: Attention[], domains: EventDomain[],
  now: number, random: () => number, createId: () => string): AttentionProjection => {
  const drafts = domains.find(domain => domain.name === record.domain)?.project(record) ?? [];
  const upserts: Attention[] = [];
  for (const draft of drafts) {
    if (draft.expiresAt <= now) continue;
    const old = previous.find(item => item.kind === draft.kind && item.occurrenceAt === draft.occurrenceAt);
    upserts.push({ ...draft, chatId: record.chatId, ownerId: record.ownerId, id: old?.id ?? createId(),
      eventId: record.id, eventVersion: record.version, epoch: record.epoch,
      tone: selectAttentionTone(old?.tone, random), status: 'pending' });
  }
  // Match against all drafts, including expired ones, just as the existing
  // reconciliation does. Expiry transitions remain the store's prune operation.
  const cancellations = previous.filter(old => !drafts.some(draft =>
    draft.kind === old.kind && draft.occurrenceAt === old.occurrenceAt));
  return { upserts, cancellations };
};
