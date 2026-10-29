import { RUN_LIST_STATUSES } from '@companion/contracts/service';
import { parseTaskArguments, TASK_FILTER_FLAGS } from './task-arguments.js';

export const INTERACTIVE_COMMANDS = ['/help', '/list', '/tasks', '/new', '/use', '/history', '/clear-input-history', '/retry', '/resume', '/cancel', '/exit'] as const;
export interface CommandCompletion { start: number; end: number; candidates: string[] }

// Lexical, synchronous completion only. No identities, credentials, files or API calls.
export function completeCommand(text: string, cursor: number): CommandCompletion | undefined {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length || /[\r\n]/.test(text) || !/^\s*\/(?!\/)/.test(text)) return;
  const tokens = [...text.matchAll(/\S+/g)].map(match => ({ value: match[0], start: match.index!, end: match.index! + match[0].length }));
  const current = tokens.find(token => token.start <= cursor && cursor <= token.end);
  const start = current?.start ?? cursor, end = current?.end ?? cursor;
  const prefix = text.slice(start, cursor), earlier = tokens.filter(token => token.end <= start), later = tokens.filter(token => token.start >= end && token !== current);
  if (!earlier.length) {
    if (!prefix.startsWith('/')) return;
    return { start, end, candidates: INTERACTIVE_COMMANDS.filter(command => command.startsWith(prefix)) };
  }
  const empty = { start, end, candidates: [] };
  if (earlier[0]!.value !== '/tasks') return empty;
  const args = earlier.slice(1).map(token => token.value);
  try { if (parseTaskArguments(args, true).more) return empty; } catch { return empty; }
  const pool: readonly string[] = args.length ? TASK_FILTER_FLAGS : [...RUN_LIST_STATUSES, 'more', ...TASK_FILTER_FLAGS];
  const candidates = pool.filter(candidate => {
    if (!candidate.startsWith(prefix)) return false;
    const combined = [...args, candidate, ...later.map(token => token.value)];
    // A flag awaiting an explicit ID can be suggested, but the ID is never guessed.
    if (combined.at(-1) === '--conversation') combined.push('conversation');
    try { parseTaskArguments(combined, true); return true; } catch { return false; }
  });
  return { start, end, candidates };
}
