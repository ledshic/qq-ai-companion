import type { ReplyContext, SendGuard } from '../../runtime/conversation/context.js';

export const MEME_SEMANTIC_VERSION = 1;
export interface MemeEntry {
  id: string; file: string; sha256: string; category: string;
  meaning: string; visibleText: string; scenes: string[]; avoid: string[]; speaker: string; target: string;
  confidence: number; semanticVersion: number;
}

export interface MemeSendContext {
  context: ReplyContext; signal: AbortSignal;
  approve: (note: string) => Promise<SendGuard | undefined>;
}
