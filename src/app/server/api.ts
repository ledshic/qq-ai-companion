import type { OutgoingHttpHeaders } from 'node:http';
import Fastify, { type FastifyRequest } from 'fastify';
import {
  APIError,
  object,
  text,
  parseMessage,
  pageLimit,
  eventCursor,
  type Principal,
  type ServiceStatus,
} from '@companion/contracts/service';
import { ServiceStore } from '../../runtime/service/store.js';
import { ServiceMemory } from '../../runtime/service/memory.js';
import { RunHost } from '../../runtime/service/host.js';
import { newToken } from './credentials.js';

export function createServiceAPI(options: {
  store: ServiceStore;
  host: RunHost;
  origins: string[];
  status: () => Omit<ServiceStatus, 'apiVersion' | 'environment' | 'accepting'>;
}) {
  const { store, host } = options;
  const origins = new Set(options.origins);
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
    forceCloseConnections: true,
  });
  const streams = new Set<() => void>();
  const rates = new Map<string, { at: number; count: number }>();
  const cookieToken = (request: FastifyRequest) =>
    request.headers.cookie
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('companion_session='))
      ?.slice('companion_session='.length);
  const authenticate = (
    request: FastifyRequest,
  ): { principal: Principal; cookie: boolean } => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : undefined;
    const principal = token
      ? store.device(token)
      : authorization
        ? undefined
        : store.session(cookieToken(request) ?? '');
    if (!principal) throw new APIError(401, 'unauthorized');
    return { principal, cookie: !authorization };
  };
  const admin = (request: FastifyRequest) => {
    const { principal } = authenticate(request);
    if (!principal.admin) throw new APIError(403, 'forbidden');
    return principal;
  };
  const routeId = (request: FastifyRequest) =>
    text((request.params as { id?: unknown }).id, 80);
  const query = (request: FastifyRequest, keys: string[]) =>
    object(request.query, keys);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof APIError)
      return reply.code(error.status).send({ error: { code: error.code } });
    const code =
      error && typeof error === 'object' && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    const status = code === 413 ? 413 : code < 500 ? 400 : 500;
    return reply.code(status).send({
      error: {
        code:
          status === 500
            ? 'internal_error'
            : status === 413
              ? 'body_too_large'
              : 'invalid_request',
      },
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'not_found' } }),
  );
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff');
    const origin = request.headers.origin;
    if (origin && !origins.has(origin))
      throw new APIError(403, 'origin_not_allowed');
    if (origin)
      reply
        .header('Access-Control-Allow-Origin', origin)
        .header('Access-Control-Allow-Credentials', 'true')
        .header('Vary', 'Origin');
    if (request.method === 'OPTIONS') {
      if (!origin) throw new APIError(403, 'origin_required');
      return reply
        .header(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, Last-Event-ID',
        )
        .header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        .code(204)
        .send();
    }
    const publicPairing =
      request.method === 'POST' &&
      (request.url === '/api/v1/pairings' ||
        /^\/api\/v1\/pairings\/[^/?]+\/claim$/.test(request.url));
    if (publicPairing) {
      const key = request.ip;
      const now = Date.now();
      for (const [ip, state] of rates)
        if (state.at < now - 60_000) rates.delete(ip);
      if (rates.size >= 1000 && !rates.has(key))
        throw new APIError(429, 'rate_limited');
      const state = rates.get(key) ?? { at: now, count: 0 };
      rates.set(key, state);
      if (++state.count > 30) throw new APIError(429, 'rate_limited');
    } else {
      const identity = authenticate(request);
      if (
        identity.cookie &&
        !['GET', 'HEAD'].includes(request.method) &&
        !origin
      )
        throw new APIError(403, 'origin_required');
    }
  });
  app.get('/api/v1/me', async (request) => ({
    ...authenticate(request).principal,
    permissions: authenticate(request).principal.admin
      ? ['chat', 'read', 'cancel', 'devices', 'runtime']
      : ['chat', 'read', 'cancel'],
  }));
  app.get(
    '/api/v1/status',
    async () =>
      ({
        apiVersion: 'v1',
        environment: 'service',
        accepting: store.accepting(),
        ...options.status(),
      }) satisfies ServiceStatus,
  );
  app.post('/api/v1/sessions', async (request, reply) => {
    if (authenticate(request).cookie)
      throw new APIError(403, 'bearer_required');
    object(request.body ?? {}, []);
    const token = newToken();
    store.createSession(authenticate(request).principal.deviceId, token);
    const secure = !!request.headers.origin?.startsWith('https:');
    reply.header(
      'Set-Cookie',
      `companion_session=${token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`,
    );
    return { authenticated: true };
  });
  app.delete('/api/v1/sessions/current', async (request, reply) => {
    const token = cookieToken(request);
    if (token) store.removeSession(token);
    reply.header(
      'Set-Cookie',
      'companion_session=; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=0',
    );
    return { authenticated: false };
  });
  app.post('/api/v1/pairings', async (request, reply) => {
    const body = object(request.body, ['name']);
    const secret = newToken();
    return reply.code(201).send({
      ...store.createPairing(text(body.name, 80), secret),
      claimSecret: secret,
    });
  });
  app.get('/api/v1/pairings', async (request) => {
    admin(request);
    return { pairings: store.pairings() };
  });
  app.post('/api/v1/pairings/:id/approve', async (request) => {
    object(request.body ?? {}, []);
    store.approvePairing(routeId(request), admin(request).ownerId);
    return { approved: true };
  });
  app.post('/api/v1/pairings/:id/claim', async (request, reply) => {
    const body = object(request.body, ['claimSecret']);
    const result = store.claimPairing(
      routeId(request),
      text(body.claimSecret, 100),
      newToken(),
    );
    if ('error' in result)
      throw new APIError(
        result.error === 'pairing_pending' ? 409 : 404,
        result.error!,
      );
    return reply.code(201).send(result);
  });
  app.get('/api/v1/devices', async (request) => ({
    devices: store.devices(admin(request).ownerId),
  }));
  app.delete('/api/v1/devices/:id', async (request) => {
    const principal = authenticate(request).principal;
    const requested = routeId(request),
      id = requested === 'current' ? principal.deviceId : requested;
    if (!principal.admin && id !== principal.deviceId)
      throw new APIError(403, 'forbidden');
    store.revoke(principal.ownerId, id);
    return { revoked: true };
  });
  app.get('/api/v1/conversations', async (request) => {
    const q = query(request, ['after', 'limit']);
    const after = q.after === undefined ? '' : text(q.after, 80);
    const conversations = store.conversations(
      authenticate(request).principal.ownerId,
      after,
      pageLimit(q.limit),
    );
    return { conversations, nextCursor: conversations.at(-1)?.id ?? after };
  });
  app.post('/api/v1/conversations', async (request, reply) => {
    const body = object(request.body, ['title']);
    return reply
      .code(201)
      .send(
        store.createConversation(
          authenticate(request).principal.ownerId,
          text(body.title, 120),
        ),
      );
  });
  app.get('/api/v1/conversations/:id/memory-sources', async (request) =>
    new ServiceMemory(store).policy(authenticate(request).principal.ownerId, routeId(request)),
  );
  app.post('/api/v1/conversations/:id/memory-sources', async (request) => {
    const principal = admin(request);
    const body = object(request.body, ['sourceConversationIds', 'expectedRevision']);
    if (!Array.isArray(body.sourceConversationIds)) throw new APIError(400, 'invalid_memory_sources');
    if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0))
      throw new APIError(400, 'invalid_memory_revision');
    return new ServiceMemory(store).setSources(principal.ownerId, routeId(request), body.sourceConversationIds as string[], body.expectedRevision as number | undefined);
  });
  app.get('/api/v1/conversations/:id/messages', async (request) => {
    const q = query(request, ['after', 'limit']);
    return store.messages(
      authenticate(request).principal.ownerId,
      routeId(request),
      eventCursor(q.after),
      pageLimit(q.limit),
    );
  });
  app.post('/api/v1/conversations/:id/messages', async (request, reply) => {
    const body = parseMessage(request.body);
    return reply
      .code(202)
      .send(
        host.submit(
          authenticate(request).principal.ownerId,
          routeId(request),
          body.clientMessageId,
          body.content,
        ),
      );
  });
  app.get('/api/v1/runs/:id', async (request) =>
    store.run(authenticate(request).principal.ownerId, routeId(request)),
  );
  app.post('/api/v1/runs/:id/cancel', async (request) => {
    object(request.body ?? {}, []);
    return host.cancel(
      authenticate(request).principal.ownerId,
      routeId(request),
    );
  });
  app.post('/api/v1/runtime/:action', async (request) => {
    admin(request);
    object(request.body ?? {}, []);
    const action = (request.params as { action: string }).action;
    if (!['pause', 'resume'].includes(action))
      throw new APIError(404, 'not_found');
    store.pause(action === 'pause');
    return { accepting: store.accepting() };
  });
  app.get('/api/v1/events', async (request, reply) => {
    const q = query(request, ['after', 'limit', 'conversationId']);
    const conversationId =
      q.conversationId === undefined ? undefined : text(q.conversationId, 80);
    const after = eventCursor(request.headers['last-event-id'] ?? q.after);
    const { principal } = authenticate(request);
    const page = store.events(
      principal.ownerId,
      after,
      pageLimit(q.limit),
      conversationId,
    );
    if (!request.headers.accept?.includes('text/event-stream')) return page;
    if (streams.size >= 64) throw new APIError(429, 'stream_limit');
    reply.hijack();
    reply.raw.writeHead(200, {
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    } as OutgoingHttpHeaders);
    let cursor = after,
      closed = false,
      lastHeartbeat = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      streams.delete(close);
      reply.raw.end();
    };
    const send = () => {
      if (closed) return;
      try {
        const current = authenticate(request).principal;
        if (
          current.ownerId !== principal.ownerId ||
          current.deviceId !== principal.deviceId
        ) {
          close();
          return;
        }
        const next = store.events(current.ownerId, cursor, 200, conversationId);
        for (const event of next.events) {
          if (
            !reply.raw.write(
              `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
          ) {
            close();
            return;
          }
        }
        cursor = next.nextCursor;
        if (Date.now() - lastHeartbeat >= 15_000) {
          lastHeartbeat = Date.now();
          if (!reply.raw.write(': heartbeat\n\n')) close();
        }
      } catch {
        close();
      }
    };
    streams.add(close);
    reply.raw.on('close', close);
    reply.raw.write(': connected\n\n');
    send();
    timer = setInterval(send, 250);
    timer.unref();
    if (closed) clearInterval(timer);
  });
  app.addHook('preClose', async () => {
    for (const close of streams) close();
  });
  return app;
}
