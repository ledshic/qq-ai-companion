// Portable SSE framing for provider responses and authenticated service streams.
// Limits apply to each event, not the lifetime of a long-lived subscription.
export async function* sseData(response: Response, signal?: AbortSignal, maxFrame = 262144): AsyncGenerator<string> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw Error('Invalid event stream');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], size = 0;
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const at = buffer.search(/[\r\n]/);
        if (at < 0 || buffer[at] === '\r' && at === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + (buffer.slice(at, at + 2) === '\r\n' ? 2 : 1));
        if (!line) {
          if (data.length) { const event = data.join('\n'); data = []; size = 0; yield event; signal?.throwIfAborted(); }
        } else if (line === 'data' || line.startsWith('data:')) {
          const value = line === 'data' ? '' : line.slice(5).replace(/^ /, '');
          size += value.length + 1;
          if (size > maxFrame) throw Error('Event stream frame too large');
          data.push(value);
        }
      }
      if (buffer.length + size > maxFrame) throw Error('Event stream frame too large');
      if (chunk.done) {
        if (buffer || data.length) throw Error('Truncated event stream frame');
        return;
      }
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
