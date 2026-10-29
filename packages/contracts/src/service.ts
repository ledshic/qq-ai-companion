export const SERVICE_API_VERSION = 'v1' as const;
export type RunState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface Conversation {
  id: string;
  ownerId: string;
  channelId: 'console';
  kind: 'direct';
  title: string;
  createdAt: string;
}
export interface Message {
  id: string;
  conversationId: string;
  runId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  createdAt: string;
}
export interface Run {
  id: string;
  conversationId: string;
  clientMessageId: string;
  state: RunState;
  input: string;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
// Ephemeral draft; only run.result / committed messages are authoritative.
export interface RunOutput { run: Run; text: string; sequence: number }
export function parseRunOutput(value: unknown): RunOutput {
  if (!isRecord(value) || typeof value.text !== 'string' || value.text.length > 16000 ||
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) throw Error('Invalid run output');
  const run = parseRun(value.run);
  if (run.state !== 'running' && value.text !== '') throw Error('Draft outside running state');
  return { run, text: value.text, sequence: Number(value.sequence) };
}
export interface ServiceEvent {
  eventId: number;
  conversationId: string;
  runId: string;
  type: string;
  time: string;
  data: Record<string, unknown>;
}
export interface EventPage {
  events: ServiceEvent[];
  nextCursor: number;
}
export interface AcceptedMessage {
  messageId: string;
  runId: string;
  eventId: number;
  duplicate: boolean;
}
export interface ServiceStatus {
  apiVersion: 'v1';
  environment: 'service';
  accepting: boolean;
  model: 'configured' | 'not-configured';
  qq: 'disabled' | 'connected' | 'disconnected';
}
export interface Principal {
  ownerId: string;
  deviceId: string;
  admin: boolean;
}
export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export function object(
  value: unknown,
  allowed: string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new APIError(400, 'invalid_request');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new APIError(400, 'invalid_request');
  return value;
}
export function parseMessage(value: unknown): {
  clientMessageId: string;
  content: string;
} {
  const body = object(value, ['clientMessageId', 'content']);
  const clientMessageId = text(body.clientMessageId, 80);
  if (!/^[\w-]+$/.test(clientMessageId))
    throw new APIError(400, 'invalid_request');
  return { clientMessageId, content: text(body.content, 8000) };
}
export function pageLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    Number(value) < 1 ||
    Number(value) > 200
  )
    throw new APIError(400, 'invalid_limit');
  return Number(value);
}
export function eventCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new APIError(400, 'invalid_cursor');
  return Number(value);
}

export const EVENT_TYPES = [
  'message.accepted',
  'run.started',
  'message.committed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isTime = (value: unknown) =>
  isString(value) && Number.isFinite(Date.parse(value));
export function parseServiceStatus(value: unknown): ServiceStatus {
  if (
    !isRecord(value) ||
    value.apiVersion !== SERVICE_API_VERSION ||
    value.environment !== 'service' ||
    typeof value.accepting !== 'boolean' ||
    !['configured', 'not-configured'].includes(String(value.model)) ||
    !['disabled', 'connected', 'disconnected'].includes(String(value.qq))
  )
    throw Error('Not a compatible Agent service');
  return value as unknown as ServiceStatus;
}
export function parseRun(value: unknown): Run {
  if (
    !isRecord(value) ||
    !['id', 'conversationId', 'clientMessageId', 'input'].every((key) =>
      isString(value[key]),
    ) ||
    ![
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ].includes(String(value.state)) ||
    !(value.result === null || typeof value.result === 'string') ||
    !(value.error === null || typeof value.error === 'string') ||
    !isTime(value.createdAt) ||
    !isTime(value.updatedAt)
  )
    throw Error('Invalid run response');
  return value as unknown as Run;
}
export function parseServiceEvent(value: unknown): ServiceEvent {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.eventId) ||
    Number(value.eventId) < 1 ||
    !['runId', 'conversationId'].every((key) => isString(value[key])) ||
    !(EVENT_TYPES as readonly unknown[]).includes(value.type) ||
    !isTime(value.time) ||
    !isRecord(value.data)
  )
    throw Error('Invalid service event');
  return value as unknown as ServiceEvent;
}
export function parseEventPage(value: unknown): EventPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    value.events.length > 200 ||
    !Number.isSafeInteger(value.nextCursor) ||
    Number(value.nextCursor) < 0
  )
    throw Error('Invalid event page');
  const events = value.events.map(parseServiceEvent);
  if (
    events.some(
      (event, index) =>
        event.eventId > Number(value.nextCursor) ||
        (index > 0 && event.eventId <= events[index - 1]!.eventId),
    )
  )
    throw Error('Invalid event order');
  return { events, nextCursor: Number(value.nextCursor) };
}
