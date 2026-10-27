import { withTimeout } from '../shared/abort.js';
import { isRecord } from '../shared/value.js';

export interface SearchSource { title: string; url: string; summary: string; date?: string }
export type SearchResult = { status: 'ok' | 'empty'; sources: SearchSource[]; retrievedAt: string }
  | { status: 'failed'; reason: string; sources: [] };
export const searchSpec = { type: 'function', function: {
  name: 'web_search', description: '搜索公开互联网。用户要求搜索、近期事实或需核实的信息时使用；不要搜索群友个人资料或发送完整群聊。',
  parameters: { type: 'object', properties: { query: { type: 'string', description: '简短公开信息检索词，最多128字符' } }, required: ['query'], additionalProperties: false },
} };
const cut = (value: string, limit: number) => Array.from(value).slice(0, limit).join('');
export const webSearch = async (raw: string, key: string, request: typeof fetch = fetch, signal?: AbortSignal,
  timeoutMs = 8000): Promise<SearchResult> => {
  signal?.throwIfAborted();
  let query: unknown;
  try { const args: unknown = JSON.parse(raw); query = isRecord(args) ? args.query : undefined; } catch { /* invalid arguments */ }
  if (typeof query !== 'string' || !query.trim() || Array.from(query.trim()).length > 128)
    return { status: 'failed', reason: 'invalid_query', sources: [] };
  const deadline = withTimeout(signal, timeoutMs);
  try {
    const response = await request('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.trim(), count: 3, need_content: false }), signal: deadline,
    });
    if (!response.ok) { await response.body?.cancel(); return { status: 'failed', reason: `http_${response.status}`, sources: [] }; }
    // Bound streamed bytes as well as normalized text. Never feed raw provider errors to the model.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('format');
    let size = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        deadline.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256_000) throw new Error('oversize');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(data) || !Array.isArray(data.results)) throw new Error('format');
    const sources: SearchSource[] = []; const seen = new Set<string>();
    for (const row of data.results) {
      if (!isRecord(row) || typeof row.url !== 'string' || typeof row.title !== 'string') continue;
      let url: URL; try { url = new URL(row.url); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || row.url.length > 500) continue;
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|adobe_mc$|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      sources.push({ title: cut(row.title.replace(/[\r\n]/g, ' '), 100), url: url.href,
        summary: cut(typeof row.summary === 'string' && row.summary ? row.summary : typeof row.snippet === 'string' ? row.snippet : '', 500),
        ...(typeof row.date === 'string' ? { date: cut(row.date, 40) } : {}) });
      if (sources.length === 3) break;
    }
    if (data.results.length && !sources.length) throw new Error('format');
    return { status: sources.length ? 'ok' : 'empty', sources, retrievedAt: new Date().toISOString() };
  } catch {
    signal?.throwIfAborted();
    return { status: 'failed', reason: deadline.aborted ? 'timeout' : 'unavailable_or_invalid_response', sources: [] };
  }
};
