import type { ChatTurn } from '../memory.js';
import type { EventRecord, Scope } from './types.js';
export interface RecallEvidence { readonly id: string; readonly at: string | null; readonly excerpt: string }
export interface RecallDocument {
  readonly id: string;
  readonly source?: 'current_chat' | 'other_group' | 'private_chat';
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

export interface StoredRecallEvidence { id: string; sourceAt: number | null; excerpt: string }
export type RecallPresenter = (record: EventRecord, evidence: StoredRecallEvidence[], alias: string) => RecallDocument | undefined;
export type RecallSelector = (query: { text: string; history: ChatTurn[]; now: string; privateTopic?: string; records: RecallDocument[] }, signal: AbortSignal) => Promise<string[]>;
