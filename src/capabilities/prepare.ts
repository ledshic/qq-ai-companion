import type { ConversationMessage } from '../agent/contracts.js';
import { validScope, type ExecutionScope } from '../agent/scope.js';
import type { MemoryReader, MemorySource, MemoryView } from './memory/contracts.js';
import type { PersonalityProvider } from './personality/prompt.js';
import { withTimeout } from '../shared/abort.js';

// Capability waits are bounded; an uncooperative implementation cannot keep a
// cancelled run alive. RunHost continues to own the overall run deadline.
async function capability<T>(signal: AbortSignal, run: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
  const deadline = withTimeout(signal, 2000);
  deadline.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(deadline.reason);
    deadline.addEventListener('abort', abort, { once: true });
  });
  try {
    const value = await Promise.race([Promise.resolve().then(() => { deadline.throwIfAborted(); return run(deadline); }), cancelled]);
    deadline.throwIfAborted(); return value;
  } finally { deadline.removeEventListener('abort', abort); }
}
function visible(scope: ExecutionScope, source: MemorySource): boolean {
  if (source.ownerId !== scope.ownerId || source.participantId !== scope.participantId || source.channelId !== scope.channelId || source.role !== 'user') return false;
  if (source.conversationId === scope.conversationId) return source.kind === scope.kind;
  return scope.kind === 'direct' && source.kind === 'direct' && scope.memorySourceConversationIds.includes(source.conversationId);
}
export async function prepareContext(input: {
  scope?: ExecutionScope; text: string; history: ConversationMessage[]; signal: AbortSignal;
  memory?: MemoryReader; personality?: PersonalityProvider;
}) {
  input.signal.throwIfAborted();
  const scope = input.scope ? structuredClone(input.scope) : undefined;
  if (scope && !validScope(scope)) throw Error('Invalid execution scope');
  let memory: MemoryView = { status: 'disabled', records: [] };
  let current = () => true;
  if (input.memory && scope) {
    try {
      // Providers receive copies; they cannot broaden the authoritative scope.
      const result = await capability(input.signal, signal => input.memory!.recall({
        scope: structuredClone(scope), text: input.text, history: structuredClone(input.history),
      }, signal));
      if (!result.isCurrent()) throw Error('Stale memory');
      const records: MemoryView['records'] = [];
      const seen = new Set<string>();
      for (const record of result.records.slice(0, 20)) {
        const source = record.source;
        if (!source || !visible(scope, source) || typeof record.quote !== 'string' || !record.quote.trim() ||
          record.quote.length > 800 || typeof source.text !== 'string' || !source.text.includes(record.quote) ||
          typeof source.messageId !== 'string' || !source.messageId || source.messageId.length > 200 ||
          typeof source.createdAt !== 'string' || !Number.isFinite(Date.parse(source.createdAt))) continue;
        const id = JSON.stringify([source.conversationId, source.messageId]);
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({ quote: record.quote, source: {
          ownerId: source.ownerId, conversationId: source.conversationId, participantId: source.participantId,
          channelId: source.channelId, kind: source.kind, messageId: source.messageId, role: source.role, createdAt: source.createdAt,
        } });
        if (records.length === 4) break;
      }
      memory = { status: records.length ? 'available' : 'empty', records };
      current = () => { try { return !input.signal.aborted && result.isCurrent(); } catch { return false; } };
    } catch {
      input.signal.throwIfAborted(); memory = { status: 'unavailable', records: [] };
    }
  }
  let personality: { status: 'disabled' | 'available' | 'unavailable'; prompt: string } = { status: 'disabled', prompt: '' };
  if (input.personality) {
    try {
      const prompt = await capability(input.signal, signal => input.personality!.prompt({ text: input.text, history: structuredClone(input.history) }, signal));
      if (typeof prompt !== 'string' || prompt.length > 2000) throw Error('Invalid personality prompt');
      personality = { status: 'available', prompt };
    } catch { input.signal.throwIfAborted(); personality = { status: 'unavailable', prompt: '' }; }
  }
  input.signal.throwIfAborted();
  return { memory, personality, isCurrent: current };
}
