import { streamDeepSeek } from './deepseek-stream.js';
import type { Model } from '../../agent/contracts.js';
import { completionMessage, requestChatCompletion } from './model-request.js';
import { isRecord } from '../../shared/value.js';

export function createDeepSeekModel(key: string, model: string, request: typeof fetch = fetch): Model {
  if (!key.trim()) throw Error('Missing model API key');
  return { async complete(messages, tools, signal, onDelta) {
    signal.throwIfAborted();
    const body = {
      model, thinking: { type: 'disabled' }, stream: false, max_tokens: 512,
      messages: messages.map(message => {
        if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.callId };
        if (message.role !== 'assistant') return message;
        return { role: 'assistant', content: message.content || null,
          ...(message.calls ? { tool_calls: message.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
          ...(message.reasoning ? { reasoning_content: message.reasoning } : {}) };
      }),
      ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}),
    };
    if (onDelta) return streamDeepSeek(key, body, request, signal, onDelta);
    const data = await requestChatCompletion(key, body, { request, signal, timeoutMs: 30_000, httpError: 'Model request failed' });
    signal.throwIfAborted();
    const message = completionMessage(data, 'Invalid model response');
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw Error('Invalid tool calls');
    const raw: unknown[] = message.tool_calls ?? [];
    if (raw.length > 8) throw Error('Too many tool calls');
    const calls = raw.map(call => {
      if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw Error('Invalid tool call');
      return { id: call.id, name: call.function.name, arguments: call.function.arguments };
    });
    return { text: typeof message.content === 'string' ? message.content : '', calls,
      ...(typeof message.reasoning_content === 'string' ? { reasoning: message.reasoning_content } : {}) };
  } };
}
