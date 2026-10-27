export const PHASE = 'phase-a' as const;
export interface ClientInfo {
  platform: string;
  architecture: string;
  version: string;
  environment: 'web' | 'tauri';
}
export interface MockStatus {
  apiVersion: 'v1';
  environment: typeof PHASE;
  instanceId: string;
  time: string;
  runtime: 'mock';
  qq: 'not-connected';
  model: 'not-configured';
}
export interface ProbeInput {
  clientId: string;
  requestId: string;
  client: ClientInfo;
  message: string;
}
export interface ProbeResult extends ProbeInput {
  probeId: string;
  receivedAt: string;
  reply: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export function parseStatus(value: unknown): MockStatus {
  if (
    !record(value) ||
    value.apiVersion !== 'v1' ||
    value.environment !== PHASE ||
    typeof value.instanceId !== 'string' ||
    typeof value.time !== 'string' ||
    value.runtime !== 'mock' ||
    value.qq !== 'not-connected' ||
    value.model !== 'not-configured'
  )
    throw Error('服务不是阶段 A 模拟 API');
  return value as unknown as MockStatus;
}
export function parseProbe(value: unknown): ProbeInput {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['clientId', 'requestId', 'client', 'message'].includes(key),
    ) ||
    !['clientId', 'requestId'].every(
      (key) =>
        typeof value[key] === 'string' &&
        /^[\w-]{1,80}$/.test(value[key] as string),
    ) ||
    typeof value.message !== 'string' ||
    !value.message.trim() ||
    value.message.length > 200 ||
    !record(value.client)
  )
    throw Error('连接请求格式无效');
  const client = value.client;
  if (
    !['web', 'tauri'].includes(String(client.environment)) ||
    !['platform', 'architecture', 'version'].every(
      (key) =>
        typeof client[key] === 'string' &&
        (client[key] as string).length > 0 &&
        (client[key] as string).length <= 80,
    ) ||
    Object.keys(client).some(
      (key) =>
        !['platform', 'architecture', 'version', 'environment'].includes(key),
    )
  )
    throw Error('客户端信息无效');
  return value as unknown as ProbeInput;
}
export function parseProbeResult(value: unknown): ProbeResult {
  if (
    !record(value) ||
    typeof value.probeId !== 'string' ||
    typeof value.receivedAt !== 'string' ||
    typeof value.reply !== 'string'
  )
    throw Error('模拟 API 返回格式无效');
  parseProbe(
    Object.fromEntries(
      ['clientId', 'requestId', 'client', 'message'].map((key) => [
        key,
        value[key],
      ]),
    ),
  );
  return value as unknown as ProbeResult;
}
