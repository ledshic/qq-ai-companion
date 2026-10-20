import { withTimeout } from './abort.js';
import { CHAT_SYSTEM_PROMPT } from './persona.js';
import type { ChatTurn } from './memory.js';
import { isRecord } from './onebot.js';

export const createDeepSeekReply = (apiKey: string, model = 'deepseek-flash', request: typeof fetch = fetch) => {
  if (!apiKey.trim()) throw new Error('请在 .env 中配置 DEEPSEEK_API_KEY。');
  return async (content: string, history: ChatTurn[] = [], signal?: AbortSignal): Promise<string> => {
    const response = await request('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: withTimeout(signal, 30_000),
      body: JSON.stringify({
        model,
        thinking: { type: 'disabled' },
        stream: false,
        max_tokens: 512,
        messages: [
          { role: 'system', content: CHAT_SYSTEM_PROMPT },
          ...history,
          { role: 'user', content },
        ],
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (!isRecord(body) || !Array.isArray(body.choices)) throw new Error('DeepSeek 返回格式异常');
    const choice: unknown = body.choices[0];
    if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== 'string' ||
        !choice.message.content.trim()) throw new Error('DeepSeek 返回空回复');
    return Array.from(choice.message.content.trim()).slice(0, 1500).join('');
  };
};
