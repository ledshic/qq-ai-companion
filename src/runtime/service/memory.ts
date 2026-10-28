import { APIError } from '@companion/contracts/service';
import type { ExecutionScope } from '../../agent/scope.js';
import type { MemoryReader, MemoryRecord } from '../../capabilities/memory/contracts.js';
import { ServiceStore } from './store.js';

// Reuses committed service messages as evidence; never opens legacy QQ tables
// and never creates a second copy of short-term history or inferred user facts.
export class ServiceMemory implements MemoryReader {
  constructor(private store: ServiceStore) {}
  private conversation(ownerId: string, id: string) {
    const row = this.store.one('SELECT * FROM service_conversations WHERE owner_id=? AND id=?', ownerId, id);
    if (!row) throw new APIError(404, 'not_found');
    if (row.kind !== 'direct' || row.channel_id !== 'console') throw new APIError(409, 'unsupported_memory_scope');
    return row;
  }
  policy(ownerId: string, conversationId: string) {
    this.conversation(ownerId, conversationId);
    const row = this.store.one('SELECT * FROM service_memory_policies WHERE conversation_id=?', conversationId);
    const ids: unknown = row ? JSON.parse(String(row.sources)) : [];
    if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string' || !id)) throw Error('Invalid stored memory policy');
    return { sourceConversationIds: ids as string[], revision: Number(row?.revision ?? 0) };
  }
  setSources(ownerId: string, conversationId: string, ids: string[]) {
    if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 80 || id === conversationId) || new Set(ids).size !== ids.length)
      throw new APIError(400, 'invalid_memory_sources');
    return this.store.transaction(() => {
      const previous = this.policy(ownerId, conversationId);
      for (const id of ids) this.conversation(ownerId, id);
      this.store.exec('INSERT INTO service_memory_policies(conversation_id,sources,revision) VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET sources=excluded.sources,revision=excluded.revision', conversationId, JSON.stringify(ids), previous.revision + 1);
      return this.policy(ownerId, conversationId);
    });
  }
  scope(ownerId: string, conversationId: string): ExecutionScope {
    const policy = this.policy(ownerId, conversationId);
    return { ownerId, conversationId, participantId: ownerId, participantIds: [ownerId],
      channelId: 'console', kind: 'direct', memorySourceConversationIds: policy.sourceConversationIds };
  }
  async recall(query: Parameters<MemoryReader['recall']>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    const { scope } = query;
    const policy = this.policy(scope.ownerId, scope.conversationId);
    // The service supports owner direct conversations only. Caller-supplied scope
    // cannot authorize participants, channels or additional conversations.
    if (scope.kind !== 'direct' || scope.channelId !== 'console' || scope.participantId !== scope.ownerId ||
      scope.participantIds.length !== 1 || scope.participantIds[0] !== scope.ownerId ||
      JSON.stringify(scope.memorySourceConversationIds) !== JSON.stringify(policy.sourceConversationIds)) throw Error('Invalid service scope');
    const ids = [scope.conversationId, ...policy.sourceConversationIds];
    for (const id of ids) this.conversation(scope.ownerId, id);
    const rows = this.store.all(`SELECT m.*,c.owner_id,c.channel_id,c.kind FROM service_messages m
      JOIN service_runs r ON r.id=m.run_id JOIN service_conversations c ON c.id=m.conversation_id
      WHERE c.owner_id=? AND r.owner_id=c.owner_id AND r.conversation_id=c.id AND r.state='completed'
      AND c.kind='direct' AND c.channel_id='console' AND m.role='user'
      AND c.id IN (${ids.map(() => '?').join(',')}) ORDER BY m.seq DESC LIMIT 200`, scope.ownerId, ...ids);
    const words = [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(query.text.toLocaleLowerCase())]
      .filter(word => word.isWordLike && word.segment.length > 1).map(word => word.segment).slice(0, 32);
    const records: MemoryRecord[] = rows.map(row => {
      const text = String(row.content);
      const lower = text.toLocaleLowerCase();
      const score = words.reduce((n, word) => n + Number(lower.includes(word)), 0);
      const firstMatch = words.map(word => lower.indexOf(word)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
      return { row, text, score, start: Math.max(0, firstMatch - 200) };
    }).filter(item => item.score > 0 && !query.history.some(message => message.role === 'user' && message.content === item.text))
      .sort((a, b) => b.score - a.score).slice(0, 4).map(({ row, text, start }) => ({
        quote: text.slice(start, start + 800), source: { ownerId: scope.ownerId, participantId: scope.ownerId,
          conversationId: String(row.conversation_id), channelId: 'console', kind: 'direct', role: 'user',
          messageId: String(row.id), text, createdAt: String(row.created_at) },
      }));
    return { records, isCurrent: () => {
      const current = this.policy(scope.ownerId, scope.conversationId);
      if (current.revision !== policy.revision) return false;
      return records.every(record => {
        const row = this.store.one(`SELECT m.content,c.owner_id,c.channel_id,c.kind FROM service_messages m
          JOIN service_runs r ON r.id=m.run_id JOIN service_conversations c ON c.id=m.conversation_id
          WHERE m.id=? AND m.conversation_id=? AND m.role='user' AND r.state='completed'
          AND r.owner_id=c.owner_id AND r.conversation_id=c.id`, record.source.messageId, record.source.conversationId);
        return row?.owner_id === scope.ownerId && row.kind === 'direct' && row.channel_id === 'console' && row.content === record.source.text;
      });
    } };
  }
}
