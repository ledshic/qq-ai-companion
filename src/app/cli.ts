import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '../../packages/client/src/service.js';
import { APIError, RUN_LIST_STATUSES } from '@companion/contracts/service';
import type { Readable, Writable } from 'node:stream';
import { runInteractiveChat } from './interactive-cli.js';
import { parseTaskArguments } from './task-arguments.js';
import { instanceDataDir } from '../runtime/lock.js';

const help = `Usage: pnpm agent:cli <command>
  chat [conversationId]
  status
  conversations
  tasks [status] [--conversation <conversationId>] [--before <runId>] [--limit <1..200>]
    status: ${RUN_LIST_STATUSES.join('|')}
  new <title>
  send <conversationId> <content> [clientMessageId]
  run <runId>
  cancel <runId>
  watch [afterEventId]
  sources <conversationId>
  grant-sources <conversationId> <sourceId> [...sourceIds] (replaces entire list)
  clear-sources <conversationId>
Environment: AGENT_URL, AGENT_CREDENTIAL_FILE, MEMORY_DB
Credentials are read from a local file, never from command arguments.
Ctrl+C stops observation; use cancel to stop a remote run.`;
const arity: Record<string, [number, number]> = {
  chat: [0, 1], status: [0, 0], conversations: [0, 0], tasks: [0, 7], new: [1, 1], send: [2, 3], run: [1, 1], cancel: [1, 1],
  watch: [0, 1], sources: [1, 1], 'grant-sources': [2, 9], 'clear-sources': [1, 1],
};
interface CLIOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  out?: (line: string) => void;
  error?: (line: string) => void;
  request?: typeof fetch;
  input?: Readable;
  terminalOutput?: Writable;
}
export async function runCLI(argv: string[], options: CLIOptions = {}): Promise<number> {
  const out = options.out ?? console.log, error = options.error ?? console.error;
  const [command, ...args] = argv;
  if (command === 'help' || command === '--help' || !command) { out(help); return 0; }
  const allowed = arity[command];
  if (!allowed || args.length < allowed[0] || args.length > allowed[1] || args.some(arg => !arg.trim()) ||
    command === 'watch' && args[0] !== undefined && (!/^\d+$/.test(args[0]) || !Number.isSafeInteger(Number(args[0])))) {
    error('invalid_arguments\n' + help); return 2;
  }
  let taskArgs: ReturnType<typeof parseTaskArguments> | undefined;
  try { if (command === 'tasks') taskArgs = parseTaskArguments(args, false); }
  catch { error('invalid_arguments\n' + help); return 2; }
  const env = options.env ?? process.env;
  const lifetime = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  let token: string;
  try {
    const path = env.AGENT_CREDENTIAL_FILE || join(instanceDataDir(env.MEMORY_DB || 'data/memory.db'), 'service-owner.json');
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || !('token' in value) || typeof value.token !== 'string' || !value.token.trim()) throw Error();
    token = value.token;
  } catch { error('credential_unavailable: set AGENT_CREDENTIAL_FILE to an existing credential JSON file'); return 1; }
  try {
    signal.throwIfAborted();
    const request: typeof fetch = (url, init) => {
      const signals = [signal, ...(init?.signal ? [init.signal] : [])];
      if (!new Headers(init?.headers).get('Accept')?.includes('text/event-stream')) signals.push(AbortSignal.timeout(15_000));
      return (options.request ?? fetch)(url, { ...init, signal: AbortSignal.any(signals) });
    };
    const client = createServiceClient(env.AGENT_URL || 'http://127.0.0.1:4320', { token, request });
    const print = (value: unknown) => out(JSON.stringify(value));
    switch (command) {
      case 'chat': return await runInteractiveChat({ client, signal, input: options.input ?? process.stdin, output: options.terminalOutput ?? process.stdout, out, error, conversationId: args[0] });
      case 'status': print(await client.status()); break;
      case 'tasks': print(await client.runs(taskArgs!.query)); break;
      case 'conversations': {
        let after = '';
        for (;;) {
          signal.throwIfAborted();
          const page = await client.conversations(after);
          for (const conversation of page.conversations) print(conversation);
          if (!page.conversations.length) break;
          if (!page.nextCursor || page.nextCursor <= after) throw Error('invalid_cursor');
          after = page.nextCursor;
        }
        break;
      }
      case 'new': print(await client.createConversation(args[0]!)); break;
      case 'send': {
        const clientMessageId = args[2] ?? randomUUID();
        // Emit the id before the request, so an uncertain network failure can be
        // retried explicitly without submitting a second logical message.
        print({ type: 'submission', conversationId: args[0], clientMessageId });
        print(await client.submit(args[0]!, clientMessageId, args[1]!));
        break;
      }
      case 'run': print(await client.run(args[0]!)); break;
      case 'cancel': print(await client.cancel(args[0]!)); break;
      case 'sources': print(await client.memorySources(args[0]!)); break;
      case 'grant-sources': print(await client.setMemorySources(args[0]!, args.slice(1))); break;
      case 'clear-sources': print(await client.setMemorySources(args[0]!, [])); break;
      case 'watch':
        for await (const event of client.watch(Number(args[0] ?? 0), signal)) print(event);
        break;
    }
    return 0;
  } catch (failure) {
    if (signal.aborted) return 0;
    // Do not print exception stacks, credential content or upstream response bodies.
    error(failure instanceof APIError ? failure.code : 'request_failed');
    return 1;
  } finally { lifetime.abort(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  process.exitCode = await runCLI(process.argv.slice(2), { signal: controller.signal });
}
