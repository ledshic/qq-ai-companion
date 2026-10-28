// IDs are opaque. Authorization never depends on their spelling or channel encoding.
export interface ExecutionScope {
  ownerId: string;
  conversationId: string;
  participantId: string;
  participantIds: readonly string[];
  channelId: string;
  kind: 'direct' | 'shared';
  memorySourceConversationIds: readonly string[];
}
export function validScope(scope: ExecutionScope): boolean {
  return [scope.ownerId, scope.conversationId, scope.participantId, scope.channelId].every(value => typeof value === 'string' && !!value.trim()) &&
    ['direct', 'shared'].includes(scope.kind) && Array.isArray(scope.participantIds) &&
    scope.participantIds.every(id => typeof id === 'string' && !!id.trim()) && scope.participantIds.includes(scope.participantId) &&
    (scope.kind !== 'direct' || scope.participantIds.length === 1) &&
    Array.isArray(scope.memorySourceConversationIds) && scope.memorySourceConversationIds.length <= 8 &&
    scope.memorySourceConversationIds.every(id => typeof id === 'string' && !!id.trim());
}
