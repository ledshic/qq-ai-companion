import type { GroupSnapshot } from '../context.js';
import type { ExpressionPlan } from '../personality-types.js';
import type { StoredRecallEvidence } from './recall-types.js';
import type { Attention, EventRecord, Scope } from './types.js';

export interface InitiativeResult {
  status: 'drafted' | 'rejected' | 'skipped' | 'unavailable' | 'interrupted' | 'invalidated';
  reason: string;
  text?: string;
  expressionPlan?: ExpressionPlan;
  basis?: string[];
}
export interface InitiativeAttempt extends Scope {
  attentionId: string; eventVersion: number; epoch: number; startedAt: number;
  opportunity: { occurrenceAt: number; notBefore: number; expiresAt: number; tone: Attention['tone'] };
  contextVersion?: number;
  finishedAt?: number; result?: InitiativeResult;
}
export interface InitiativeInput {
  attention: Attention; record: EventRecord; evidence: StoredRecallEvidence[];
  records: EventRecord[]; snapshot: GroupSnapshot; now: number;
}
// Deliberately has no transport, tool executor or reply callback.
export type InitiativeObserver = (input: InitiativeInput, signal: AbortSignal) => Promise<InitiativeResult>;
export type InitiativeContext = (scope: Scope) => GroupSnapshot;
