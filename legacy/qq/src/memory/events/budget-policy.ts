import type { InitiativeAttempt } from './initiative-types.js';
import type { Scope } from './types.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const UTC8_OFFSET = 8 * HOUR;

export const extractionBudget = (now: number): { since: number; limit: number } =>
  ({ since: Math.floor(now / HOUR) * HOUR, limit: 12 });

// Read attempts and reserve the allowed attempt in the same store transaction.
// Every attempt counts, including interrupted, failed and unfinished attempts.
export const allowsInitiative = (scope: Scope, attempts: InitiativeAttempt[], now: number): boolean => {
  const day = Math.floor((now + UTC8_OFFSET) / DAY) * DAY - UTC8_OFFSET;
  return attempts.filter(attempt => attempt.chatId === scope.chatId && attempt.startedAt > now - HOUR).length < 6 &&
    !attempts.some(attempt => attempt.chatId === scope.chatId && attempt.ownerId === scope.ownerId && attempt.startedAt >= day);
};
