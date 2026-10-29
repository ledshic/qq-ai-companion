import { isRunListStatus, type RunListOptions } from '@companion/contracts/service';
export const TASK_FILTER_FLAGS = ['--here', '--conversation'] as const;
const SINGLE_TASK_FLAGS = ['--conversation', '--before', '--limit'] as const;
// Shared CLI grammar; parsing performs no I/O, including credential reads.
export function parseTaskArguments(args: string[], interactive: boolean): { query: RunListOptions; here: boolean; more: boolean } {
  if (interactive && args[0] === 'more') {
    if (args.length !== 1) throw Error('invalid_arguments');
    return { query: {}, here: false, more: true };
  }
  const rest = [...args], query: RunListOptions = { status: 'active' }; let here = false;
  if (isRunListStatus(rest[0])) query.status = rest.shift() as NonNullable<RunListOptions['status']>;
  const seen = new Set<string>();
  while (rest.length) {
    const flag = rest.shift()!;
    if (seen.has(flag)) throw Error('invalid_arguments');
    seen.add(flag);
    if (!((interactive ? TASK_FILTER_FLAGS : SINGLE_TASK_FLAGS) as readonly string[]).includes(flag)) throw Error('invalid_arguments');
    if (flag === '--here') { if (query.conversationId) throw Error('invalid_arguments'); here = true; continue; }
    const value = rest.shift();
    if (!value || value.startsWith('--')) throw Error('invalid_arguments');
    if (flag === '--limit') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 200) throw Error('invalid_arguments');
      query.limit = Number(value);
    } else {
      if (!/^[\w][\w-]{0,79}$/.test(value)) throw Error('invalid_arguments');
      if (flag === '--conversation') { if (here) throw Error('invalid_arguments'); query.conversationId = value; }
      else query.before = value;
    }
  }
  return { query, here, more: false };
}
