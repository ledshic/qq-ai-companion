import type { GroupMessage } from '../message.js';
export interface Scope { groupId: string; ownerId: string }
export interface Source extends Scope {
  id: string; messageId: string; text: string; sourceAt: number | null;
  receivedAt: number; epoch: number; status: string;
}
export interface EventRecord extends Scope {
  id: string; domain: string; businessKey: string; version: number; epoch: number;
  payload: unknown; evidenceIds: string[]; status: 'active' | 'superseded' | 'retracted' | 'expired';
  createdAt: number; updatedAt: number; expiresAt: number;
}
export interface Mutation {
  domain: string; businessKey: string; payload: unknown; evidenceIds: string[];
  operation: 'upsert' | 'replace' | 'retract'; targetId?: string; expectedVersion?: number; expiresAt: number;
  excerpts?: Record<string,string>;
}
export interface AttentionDraft {
  kind: string; occurrenceAt: number; notBefore: number; expiresAt: number;
  payload: unknown; requiresPresence: boolean;
}
export interface Attention extends AttentionDraft, Scope {
  id: string; eventId: string; eventVersion: number; epoch: number;
  tone: 'upbeat' | 'wry' | 'gentle'; status: 'pending' | 'cancelled' | 'expired';
  observation?: string;
}
export interface DomainContext { sources: Source[]; existing: EventRecord[]; now: number }
export interface EventDomain {
  readonly name: string;
  readonly prompt: string;
  interpret(raw: unknown, context: DomainContext): Mutation[];
  project(event: EventRecord): AttentionDraft[];
}
export interface ExtractionInput extends DomainContext { prompts: { name: string; prompt: string }[] }
export type Extractor = (input: ExtractionInput, signal: AbortSignal) => Promise<Record<string, unknown>>;
export interface Batch extends Scope { id: string; epoch: number; sources: Source[] }
export interface EventMemoryPort {
  recall(query: import('./recall-types.js').RecallQuery, signal: AbortSignal): Promise<import('./recall-types.js').RecallResult>;
  ingest(message: GroupMessage): void;
  control(message: GroupMessage): string | undefined;
  attach(acquire: (controller: AbortController) => (() => void) | undefined, context?: import('./initiative-types.js').InitiativeContext): void;
  pause(): void;
  resume(): void;
  close(): void;
}
export interface EventConfig { groups: Set<string>; scope: 'addressed' | 'group'; mode: 'off' | 'observe' }
