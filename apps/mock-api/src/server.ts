import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PHASE,
  parseProbe,
  type ProbeResult,
  type MockStatus,
} from '@companion/contracts';
const ORIGINS = new Set([
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
]);
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
    if (size > 4096) throw Error('request_too_large');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createMockAPI(options: { evidenceFile?: string } = {}) {
  const probes = new Map<string, ProbeResult>();
  const instanceId = randomUUID();
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Companion-Mock', PHASE);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    const origin = request.headers.origin;
    if (origin && !ORIGINS.has(origin)) {
      reply(403, { error: 'origin_not_allowed' });
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Companion-Phase',
      );
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.headers['x-companion-phase'] !== 'A') {
      reply(403, { error: 'mock_marker_required' });
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      const status: MockStatus = {
        apiVersion: 'v1',
        environment: PHASE,
        instanceId,
        time: new Date().toISOString(),
        runtime: 'mock',
        qq: 'not-connected',
        model: 'not-configured',
      };
      reply(200, status);
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/probes') {
      reply(200, [...probes.values()]);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/probes') {
      try {
        const input = parseProbe(await readBody(request));
        const key = JSON.stringify([input.clientId, input.requestId]);
        const existing = probes.get(key);
        if (
          existing &&
          (input.message !== existing.message ||
            ['platform', 'architecture', 'version', 'environment'].some(
              (field) =>
                input.client[field as keyof typeof input.client] !==
                existing.client[field as keyof typeof existing.client],
            ))
        ) {
          reply(409, { error: 'request_id_conflict' });
          return;
        }
        const result: ProbeResult = existing ?? {
          ...input,
          probeId: randomUUID(),
          receivedAt: new Date().toISOString(),
          reply: `模拟服务已收到 ${input.client.platform} 客户端消息：${input.message}`,
        };
        if (!existing) {
          if (options.evidenceFile) {
            mkdirSync(dirname(options.evidenceFile), { recursive: true });
            appendFileSync(options.evidenceFile, JSON.stringify(result) + '\n');
          }
          probes.set(key, result);
          while (probes.size > 1000) probes.delete(probes.keys().next().value!);
          console.log(JSON.stringify({ event: 'probe.received', ...result }));
        }
        reply(existing ? 200 : 201, result);
        return;
      } catch {
        reply(400, { error: 'invalid_probe' });
        return;
      }
    }
    reply(404, { error: 'not_found' });
  });
}
