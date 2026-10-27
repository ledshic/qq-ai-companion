import {
  parseStatus,
  parseProbeResult,
  type ProbeInput,
} from '@companion/contracts';
export const DEFAULT_MOCK_URL = 'http://127.0.0.1:4317';
export function normalizeMockURL(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw Error('阶段 A 仅连接本机或 Android 模拟器的 HTTP 模拟服务');
  return url.origin;
}
export function createMockClient(
  address: string,
  request: typeof fetch = fetch,
) {
  const base = normalizeMockURL(address);
  const call = async (
    path: string,
    body?: ProbeInput,
    signal?: AbortSignal,
  ) => {
    const response = await request(base + path, {
      method: body ? 'POST' : 'GET',
      signal,
      headers: {
        'X-Companion-Phase': 'A',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok)
      throw Error(`模拟服务请求失败（HTTP ${response.status}）`);
    return response.json() as Promise<unknown>;
  };
  return {
    status: async (signal?: AbortSignal) =>
      parseStatus(await call('/api/v1/status', undefined, signal)),
    probe: async (input: ProbeInput, signal?: AbortSignal) =>
      parseProbeResult(await call('/api/v1/probes', input, signal)),
  };
}
