import type { ExecutionScope } from '../../agent/scope.js';
import type { ConversationMessage } from '../../agent/contracts.js';
export interface MemorySource {
  ownerId: string; conversationId: string; participantId: string; channelId: string;
  kind: 'direct' | 'shared'; messageId: string; role: 'user'; text: string; createdAt: string;
}
export interface MemoryRecord { quote: string; source: MemorySource }
export interface MemoryReader {
  recall(query: { scope: ExecutionScope; text: string; history: ConversationMessage[] }, signal: AbortSignal): Promise<{
    records: MemoryRecord[];
    // Checks policy changes, source deletion or changes before use and commit.
    isCurrent(): boolean;
  }>;
}
export interface MemoryView {
  status: 'disabled' | 'empty' | 'available' | 'unavailable';
  records: { quote: string; source: Omit<MemorySource, 'text'> }[];
}
