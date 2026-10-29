import { sseData } from '@companion/contracts/sse';
import type { ModelReply, ToolCall } from '../../agent/contracts.js';
import { withTimeout } from '../../shared/abort.js';
import { isRecord } from '../../shared/value.js';

export async function streamDeepSeek(key: string, body: Record<string, unknown>, request: typeof fetch,
  parent: AbortSignal, onDelta: (text: string) => void): Promise<ModelReply> {
  const signal = withTimeout(parent, 30_000);
  const response = await request('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }), signal,
  });
  if (!response.ok) { await response.body?.cancel(); throw Error('Model request failed'); }
  let text = '', reasoning = '', finish: string | undefined, done = false, bytes = 0;
  const calls = new Map<number, ToolCall>();
  for await (const data of sseData(response, signal)) {
    bytes += data.length;
    if (bytes > 4 * 1024 * 1024) throw Error('Model stream too large');
    if (data === '[DONE]') { done = true; break; }
    const event: unknown = JSON.parse(data);
    if (!isRecord(event) || !Array.isArray(event.choices)) throw Error('Invalid model stream');
    if (!event.choices.length) continue; // Optional usage-only chunk.
    const choice: unknown = event.choices[0];
    if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta)) throw Error('Invalid model stream choice');
    const delta = choice.delta;
    if (finish) throw Error('Model data after finish');
    if (delta.content != null) {
      if (typeof delta.content !== 'string') throw Error('Invalid model text');
      text += delta.content;
      if (text.length > 64000) throw Error('Model text too large');
      if (delta.content) { signal.throwIfAborted(); onDelta(delta.content); }
    }
    if (delta.reasoning_content != null) {
      if (typeof delta.reasoning_content !== 'string') throw Error('Invalid model reasoning');
      reasoning += delta.reasoning_content;
      if (reasoning.length > 32000) throw Error('Model reasoning too large');
    }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls)) throw Error('Invalid model tools');
      for (const fragment of delta.tool_calls) {
        if (!isRecord(fragment) || !Number.isInteger(fragment.index) || Number(fragment.index) < 0 || Number(fragment.index) >= 8) throw Error('Invalid tool index');
        if (fragment.type != null && fragment.type !== 'function') throw Error('Invalid tool type');
        const index = Number(fragment.index), call = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (fragment.id !== undefined) {
          if (typeof fragment.id !== 'string' || call.id && call.id !== fragment.id) throw Error('Invalid tool id');
          call.id = fragment.id;
        }
        if (fragment.function !== undefined) {
          if (!isRecord(fragment.function)) throw Error('Invalid tool function');
          for (const field of ['name', 'arguments'] as const) if (fragment.function[field] !== undefined) {
            if (typeof fragment.function[field] !== 'string') throw Error('Invalid tool fragment');
            call[field] += fragment.function[field];
          }
        }
        if (call.id.length > 200 || call.name.length > 200 || call.arguments.length > 16000) throw Error('Tool call too large');
        calls.set(index, call);
      }
    }
    if (choice.finish_reason != null) {
      if (!['stop', 'tool_calls'].includes(String(choice.finish_reason))) throw Error('Incomplete model response');
      finish = String(choice.finish_reason);
    }
  }
  signal.throwIfAborted();
  if (!done || !finish || (finish === 'tool_calls') !== !!calls.size || [...calls.values()].some(call => !call.id || !call.name)) throw Error('Incomplete model stream');
  return { text, calls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call), ...(reasoning ? { reasoning } : {}) };
}
