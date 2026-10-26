import type { ChatTurn } from '../memory.js';
import type { Scope } from './types.js';
export interface RecallEvidence { readonly id: string; readonly at: string | null; readonly excerpt: string }
export interface RecallDocument {
  readonly id: string;
  readonly recordedAt: string;
  readonly updatedAt: string;
  readonly facts: unknown;
  readonly evidence: readonly RecallEvidence[];
}
export interface RecallView {
  readonly status: 'matched' | 'empty' | 'unavailable' | 'disabled';
  readonly capturedAt: string;
  readonly timezone: string;
  readonly records: readonly RecallDocument[];
}
export interface RecallResult {
  readonly view: RecallView;
  // Local freshness predicate; never serialized into model data.
  readonly isCurrent: () => boolean;
}
export interface RecallQuery extends Scope { text: string; history: ChatTurn[] }
export type RecallProvider = (query: RecallQuery, signal: AbortSignal) => Promise<RecallResult>;
