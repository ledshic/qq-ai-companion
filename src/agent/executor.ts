import type { Model, ModelMessage, Tool } from './contracts.js';

// RunHost owns the overall deadline. Each awaited operation must also settle on
// cancellation even when an injected implementation ignores its signal.
async function cancellable<T>(signal: AbortSignal, run: () => Promise<T> | T): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener('abort', abort); }
}
export async function executeAgent(input: {
  model: Model; tools: Tool[]; messages: ModelMessage[]; signal: AbortSignal;
  onReasoning?: (text: string) => void;
  limits?: { rounds?: number; calls?: number; resultChars?: number; toolTimeoutMs?: number };
}): Promise<string> {
  const limits = { rounds: 3, calls: 8, resultChars: 2000, toolTimeoutMs: 8000, ...input.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid execution budget');
  const registry = new Map(input.tools.map(tool => [tool.name, tool]));
  if (registry.size !== input.tools.length) throw Error('Duplicate tool name');
  const messages = structuredClone(input.messages);
  let calls = 0;
  for (let round = 0; round <= limits.rounds; round++) {
    const reply = await cancellable(input.signal, () => input.model.complete(messages,
      round < limits.rounds && calls < limits.calls ? input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) : [], input.signal));
    if (!reply.calls.length) {
      if (!reply.text.trim()) throw Error('Model returned empty reply');
      if (reply.reasoning?.trim()) input.onReasoning?.(reply.reasoning.slice(0, 32000));
      input.signal.throwIfAborted();
      return Array.from(reply.text.trim()).slice(0, 1500).join('');
    }
    if (round === limits.rounds || calls + reply.calls.length > limits.calls) throw Error('Tool budget exhausted');
    if (new Set(reply.calls.map(call => call.id)).size !== reply.calls.length || reply.calls.some(call => !call.id || !call.name))
      throw Error('Invalid tool calls');
    calls += reply.calls.length;
    messages.push({ role: 'assistant', content: reply.text, calls: reply.calls, ...(reply.reasoning ? { reasoning: reply.reasoning } : {}) });
    for (const call of reply.calls) {
      input.signal.throwIfAborted();
      const tool = registry.get(call.name);
      let result: string;
      const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(limits.toolTimeoutMs)]);
      try {
        if (!tool) result = `未知工具：${call.name}`;
        else {
          const args: unknown = JSON.parse(call.arguments || '{}');
          result = await cancellable(deadline, () => tool.execute(args, { signal: deadline }));
        }
      } catch {
        input.signal.throwIfAborted();
        result = deadline.aborted ? '工具执行超时' : '工具执行失败或参数无效';
      }
      input.signal.throwIfAborted();
      messages.push({ role: 'tool', callId: call.id, content: result.slice(0, limits.resultChars) });
    }
  }
  throw Error('Tool budget exhausted');
}
