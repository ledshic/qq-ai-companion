import {
  APIError,
  parseServiceStatus,
  parseRun,
  parseEventPage,
  parseServiceEvent,
  type AcceptedMessage,
  type Conversation,
  type EventPage,
  type Message,
  type Principal,
  type Run,
  type ServiceEvent,
  type ServiceStatus,
} from '@companion/contracts/service';
export function serviceURL(address: string) {
  const url = new URL(address);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    )
  )
    throw Error('Service requires HTTPS or loopback HTTP');
  return url.origin;
}
function errorCode(value: unknown): string {
  if (
    value &&
    typeof value === 'object' &&
    'error' in value &&
    value.error &&
    typeof value.error === 'object' &&
    'code' in value.error &&
    typeof value.error.code === 'string'
  )
    return value.error.code;
  return 'request_failed';
}
export function createServiceClient(
  address: string,
  options: { token?: string; request?: typeof fetch } = {},
) {
  const base = serviceURL(address),
    request = options.request ?? fetch;
  const headers = (extra: Record<string, string> = {}) => ({
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });
  const call = async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const timeout = AbortSignal.timeout(15_000);
    const init: NonNullable<Parameters<typeof request>[1]> & {
      cache: 'no-store';
    } = {
      method,
      headers: headers(
        body === undefined ? {} : { 'Content-Type': 'application/json' },
      ),
      credentials: 'include',
      redirect: 'error',
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    let response: Response;
    try {
      response = await request(base + '/api/v1' + path, init);
    } catch (error) {
      if (method !== 'GET' || init.signal?.aborted) throw error;
      response = await request(base + '/api/v1' + path, init);
    }
    const result = await response.json();
    if (!response.ok) throw new APIError(response.status, errorCode(result));
    return result as T;
  };
  return {
    status: async (signal?: AbortSignal) =>
      parseServiceStatus(await call('/status', 'GET', undefined, signal)),
    me: () => call<Principal & { permissions: string[] }>('/me'),
    login: () => call<{ authenticated: boolean }>('/sessions', 'POST', {}),
    logout: () => call('/sessions/current', 'DELETE'),
    createPairing: (name: string) =>
      call<{ id: string; claimSecret: string; expiresAt: string }>(
        '/pairings',
        'POST',
        { name },
      ),
    pairings: () =>
      call<{ pairings: { id: string; name: string; expiresAt: string }[] }>(
        '/pairings',
      ),
    approvePairing: (id: string) =>
      call(`/pairings/${encodeURIComponent(id)}/approve`, 'POST', {}),
    claimPairing: (id: string, claimSecret: string) =>
      call<{ deviceId: string; token: string }>(
        `/pairings/${encodeURIComponent(id)}/claim`,
        'POST',
        { claimSecret },
      ),
    devices: () => call<{ devices: { id: string; name: string; admin: boolean; revoked: boolean }[] }>('/devices'),
    revokeDevice: (id: string) =>
      call(`/devices/${encodeURIComponent(id)}`, 'DELETE'),
    conversations: (after = '') =>
      call<{ conversations: Conversation[]; nextCursor: string }>(
        '/conversations' + (after ? '?after=' + encodeURIComponent(after) : ''),
      ),
    createConversation: (title: string) =>
      call<Conversation>('/conversations', 'POST', { title }),
    memorySources: (id: string) =>
      call<{ sourceConversationIds: string[]; revision: number }>(`/conversations/${encodeURIComponent(id)}/memory-sources`),
    setMemorySources: (id: string, sourceConversationIds: string[]) =>
      call<{ sourceConversationIds: string[]; revision: number }>(`/conversations/${encodeURIComponent(id)}/memory-sources`, 'POST', { sourceConversationIds }),
    messages: (id: string, after = 0) =>
      call<{ messages: Message[]; nextCursor: number }>(
        `/conversations/${encodeURIComponent(id)}/messages?after=${after}`,
      ),
    submit: (id: string, clientMessageId: string, content: string) =>
      call<AcceptedMessage>(
        `/conversations/${encodeURIComponent(id)}/messages`,
        'POST',
        { clientMessageId, content },
      ),
    run: (id: string) => call(`/runs/${encodeURIComponent(id)}`).then(parseRun),
    cancel: (id: string) =>
      call(`/runs/${encodeURIComponent(id)}/cancel`, 'POST', {}).then(parseRun),
    pause: () => call('/runtime/pause', 'POST', {}),
    resume: () => call('/runtime/resume', 'POST', {}),
    events: (after = 0) => call(`/events?after=${after}`).then(parseEventPage),
    async *watch(
      after = 0,
      signal?: AbortSignal,
    ): AsyncGenerator<ServiceEvent> {
      const init: NonNullable<Parameters<typeof request>[1]> & {
        cache: 'no-store';
      } = {
        headers: headers({ Accept: 'text/event-stream' }),
        credentials: 'include',
        redirect: 'error',
        cache: 'no-store',
        signal,
      };
      const response = await request(
        `${base}/api/v1/events?after=${after}`,
        init,
      );
      if (!response.ok) {
        const error = await response.json();
        throw new APIError(response.status, errorCode(error));
      }
      if (
        !response.headers
          .get('content-type')
          ?.startsWith('text/event-stream') ||
        !response.body
      )
        throw Error('Invalid event stream');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 1024 * 1024)
            throw Error('Event stream frame too large');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split('\n')
              .find((line) => line.startsWith('data: '));
            if (!data) continue;
            const event = parseServiceEvent(JSON.parse(data.slice(6)));
            if (event.eventId > after) {
              after = event.eventId;
              yield event;
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
