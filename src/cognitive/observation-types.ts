import type { ReplyContext } from '../runtime/conversation/context.js';
import type { ChatTurn } from '../memory/memory.js';

export interface ContextObservation {
  readonly intent: 'question' | 'casual' | 'play' | 'support' | 'unknown';
  readonly seriousness: 'explicit' | 'inferred' | 'unknown';
  readonly requestedBanter: 'stop' | 'allow' | 'unspecified';
  readonly evidenceRefs: readonly string[];
}
export interface ObservationReceipt {
  readonly inputRevision: string;
  readonly analyzerVersion: string;
  readonly status: 'valid' | 'unknown' | 'unavailable';
  readonly observation?: ContextObservation;
}
export interface AnalysisInput { text: string; history: ChatTurn[]; context?: ReplyContext }

export type ContextAnalyzer = (input: AnalysisInput, signal?: AbortSignal) => Promise<ObservationReceipt>;
