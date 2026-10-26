import { withTimeout } from './abort.js';

export interface ModelRequestOptions {
  request?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs: number;
  httpError: string | ((status: number) => string);
  // Preserve callers that historically left HTTP error bodies untouched.
  cancelErrorBody?: boolean;
}

// Callers own prompts, budgets, retries and business validation. This adapter
// sends one non-streaming completion request and reads its JSON envelope once.
export const requestChatCompletion = async (key: string, body: Record<string, unknown>,
  options: ModelRequestOptions): Promise<unknown> => {
  const response = await (options.request ?? fetch)('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: withTimeout(options.signal, options.timeoutMs),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    if (options.cancelErrorBody !== false) await response.body?.cancel();
    throw new Error(typeof options.httpError === 'function' ? options.httpError(response.status) : options.httpError);
  }
  return response.json();
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Keep tool calls intact; only text consumers require string content.
export const completionMessage = (data: unknown, messageError: string,
  envelopeError = messageError): Record<string, unknown> => {
  if (!isObject(data) || !Array.isArray(data.choices)) throw new Error(envelopeError);
  const choice: unknown = data.choices[0];
  if (!isObject(choice) || !isObject(choice.message)) throw new Error(messageError);
  return choice.message;
};

export const completionText = (data: unknown, messageError: string, envelopeError = messageError): string => {
  const message = completionMessage(data, messageError, envelopeError);
  if (typeof message.content !== 'string') throw new Error(messageError);
  return message.content;
};
