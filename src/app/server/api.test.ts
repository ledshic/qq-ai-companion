import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceStore, tokenHash } from '../../runtime/service/store.js';
import { RunHost, type ConsoleGenerator } from '../../runtime/service/host.js';
import { createServiceAPI } from './api.js';
import { createServiceClient } from '../../../packages/client/src/service.js';
const headers = { authorization: 'Bearer owner-token' };
const origin = 'http://127.0.0.1:1420';
function fixture(
  generate: ConsoleGenerator = async (text) => 'answer:' + text,
) {
  const store = new ServiceStore(':memory:');
  store.ensureOwner('owner', 'owner-device', 'owner-token');
  const host = new RunHost(store, generate);
  const api = createServiceAPI({
    store,
    host,
    origins: [origin],
    status: () => ({ qq: 'disconnected', model: 'configured' }),
  });
  return {
    store,
    host,
    api,
    close: async () => {
      host.stop();
      await api.close();
      store.close();
    },
  };
}
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition did not settle');
};
test('formal API authentication, cookie CSRF and strict ownership input', async () => {
  const f = fixture();
  try {
    assert.equal((await f.api.inject('/api/v1/status')).statusCode, 401);
    assert.equal(
      (await f.api.inject({ url: '/api/v1/status?token=owner-token' }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await f.api.inject({
          url: '/api/v1/status',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: '/api/v1/conversations',
          headers,
          payload: { title: 'Own', ownerId: 'victim' },
        })
      ).statusCode,
      400,
    );
    const login = await f.api.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { ...headers, origin },
      payload: {},
    });
    assert.equal(login.statusCode, 200);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    assert.equal(
      (await f.api.inject({ url: '/api/v1/me', headers: { cookie } })).json()
        .ownerId,
      'owner',
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: '/api/v1/conversations',
          headers: { cookie },
          payload: { title: 'Blocked' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: '/api/v1/conversations',
          headers: { cookie, origin },
          payload: { title: 'Allowed' },
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'DELETE',
          url: '/api/v1/sessions/current',
          headers: { cookie, origin },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.api.inject({ url: '/api/v1/me', headers: { cookie } }))
        .statusCode,
      401,
    );
    const state = (
      await f.api.inject({ url: '/api/v1/status', headers })
    ).json();
    assert.equal(state.environment, 'service');
    assert.equal(state.qq, 'disconnected');
    assert.equal('token' in state, false);
  } finally {
    await f.close();
  }
});
test('pairing requires approval, one-use secret and supports device revocation', async () => {
  const f = fixture();
  try {
    const pairing = (
      await f.api.inject({
        method: 'POST',
        url: '/api/v1/pairings',
        payload: { name: 'CLI' },
      })
    ).json();
    const claim = () =>
      f.api.inject({
        method: 'POST',
        url: `/api/v1/pairings/${pairing.id}/claim`,
        payload: { claimSecret: pairing.claimSecret },
      });
    assert.equal((await claim()).statusCode, 409);
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: `/api/v1/pairings/${pairing.id}/approve`,
          payload: {},
        })
      ).statusCode,
      401,
    );
    await f.api.inject({
      method: 'POST',
      url: `/api/v1/pairings/${pairing.id}/approve`,
      headers,
      payload: {},
    });
    const device = (await claim()).json();
    assert.equal((await claim()).statusCode, 404);
    const deviceHeaders = { authorization: `Bearer ${device.token}` };
    assert.equal(
      (await f.api.inject({ url: '/api/v1/me', headers: deviceHeaders })).json()
        .ownerId,
      'owner',
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: '/api/v1/runtime/pause',
          headers: deviceHeaders,
          payload: {},
        })
      ).statusCode,
      403,
    );
    const login = await f.api.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: deviceHeaders,
      payload: {},
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    assert.equal(
      (
        await f.api.inject({
          method: 'DELETE',
          url: '/api/v1/devices/owner-device',
          headers: deviceHeaders,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'DELETE',
          url: '/api/v1/devices/current',
          headers: deviceHeaders,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.api.inject({ url: '/api/v1/events', headers: deviceHeaders }))
        .statusCode,
      401,
    );
    assert.equal(
      (await f.api.inject({ url: '/api/v1/events', headers: { cookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'DELETE',
          url: '/api/v1/devices/owner-device',
          headers,
        })
      ).statusCode,
      409,
    );
  } finally {
    await f.close();
  }
});
test('foreign identities cannot read runs, messages or serialized events', async () => {
  const f = fixture();
  try {
    f.store.exec(
      'INSERT INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,0)',
      'other-device',
      'other',
      'Other',
      tokenHash('other-token'),
    );
    const c = f.store.createConversation('owner', 'Private');
    const accepted = f.host.submit('owner', c.id, 'first', 'workbench secret');
    await wait(
      () => f.store.run('owner', accepted.runId).state === 'completed',
    );
    const otherHeaders = { authorization: 'Bearer other-token' };
    for (const url of [
      `/api/v1/runs/${accepted.runId}`,
      `/api/v1/conversations/${c.id}/messages`,
      `/api/v1/events?conversationId=${c.id}`,
    ])
      assert.equal(
        (await f.api.inject({ url, headers: otherHeaders })).statusCode,
        404,
      );
    const events = (
      await f.api.inject({ url: '/api/v1/events', headers: otherHeaders })
    ).json();
    assert.equal(events.events.length, 0);
    assert.equal(JSON.stringify(events).includes('workbench secret'), false);
    assert.equal(
      (
        await f.api.inject({
          url: '/api/v1/conversations',
          headers: otherHeaders,
        })
      ).json().conversations.length,
      0,
    );
    assert.equal(
      (
        await f.api.inject({
          method: 'POST',
          url: `/api/v1/runs/${accepted.runId}/cancel`,
          headers: otherHeaders,
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
test('SDK roundtrip, SSE replay and revoked live connections', async () => {
  let resolve!: (s: string) => void;
  const f = fixture(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const controller = new AbortController();
  try {
    await f.api.listen({ host: '127.0.0.1', port: 0 });
    const address = f.api.server.address();
    assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`,
      client = createServiceClient(base, { token: 'owner-token' });
    assert.equal((await client.status()).environment, 'service');
    const c = await client.createConversation('SSE');
    const accepted = await client.submit(c.id, 'first', 'hello');
    const stream = client.watch(0, controller.signal);
    const event = await stream.next();
    assert.equal(event.value?.type, 'message.accepted');
    controller.abort();
    await stream.return(undefined).catch(() => {});
    await wait(() => !!resolve);
    resolve('persisted while disconnected');
    await wait(
      () => f.store.run('owner', accepted.runId).state === 'completed',
    );
    assert.equal(
      (await client.run(accepted.runId)).result,
      'persisted while disconnected',
    );
    const replay = await client.events(event.value!.eventId);
    assert(replay.events.some((e) => e.type === 'message.committed'));
    assert.equal(
      (await client.submit(c.id, 'first', 'hello')).runId,
      accepted.runId,
    );
    const p = await createServiceClient(base).createPairing('Revoked stream');
    await client.approvePairing(p.id);
    const device = await createServiceClient(base).claimPairing(
      p.id,
      p.claimSecret,
    );
    const abort = new AbortController();
    const response = await fetch(
      base + '/api/v1/events?after=' + replay.nextCursor,
      {
        headers: {
          Authorization: `Bearer ${device.token}`,
          Accept: 'text/event-stream',
        },
        signal: abort.signal,
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await client.revokeDevice(device.deviceId);
    const ended = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          abort.abort();
          reject(Error('revoked stream stayed open'));
        }, 1500).unref(),
      ),
    ]);
    assert.equal(ended.done, true);
    await reader.cancel();
  } finally {
    controller.abort();
    await f.close();
  }
});
test('pairing expiry and failed claims are bounded, provider errors stay private', async () => {
  let now = 1000;
  const store = new ServiceStore(':memory:', () => now);
  store.ensureOwner('owner', 'device', 'token');
  const host = new RunHost(store, async () => {
    throw Error('provider-secret-token');
  });
  try {
    const p = store.createPairing('Device', 'secret');
    store.approvePairing(p.id, 'owner');
    for (let i = 0; i < 10; i++)
      assert('error' in store.claimPairing(p.id, 'wrong', 'unused'));
    assert('error' in store.claimPairing(p.id, 'secret', 'unused'));
    const expiring = store.createPairing('Expires', 'secret');
    now += 300001;
    assert('error' in store.claimPairing(expiring.id, 'secret', 'unused'));
    const c = store.createConversation('owner', 'Errors');
    const run = host.submit('owner', c.id, 'first', 'hello');
    await wait(() => store.run('owner', run.runId).state === 'failed');
    assert.equal(store.run('owner', run.runId).error, 'generation_failed');
    assert.equal(
      JSON.stringify(store.events('owner', 0)).includes(
        'provider-secret-token',
      ),
      false,
    );
  } finally {
    host.stop();
    store.close();
  }
});
test('memory source grants require owner administration and cannot forge identity or authorize foreign conversations', async () => {
  const f = fixture();
  try {
    const a = f.store.createConversation('owner', 'Target');
    const b = f.store.createConversation('owner', 'Source');
    const foreign = f.store.createConversation('other', 'Foreign');
    f.store.exec('INSERT INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,0)', 'ordinary', 'owner', 'Ordinary', tokenHash('ordinary-token'));
    const url = `/api/v1/conversations/${a.id}/memory-sources`;
    const grant = (payload: unknown, auth = headers) => f.api.inject({ method: 'POST', url, headers: auth, payload: payload as Record<string, unknown> });
    assert.equal((await grant({ sourceConversationIds: [b.id] }, { authorization: 'Bearer ordinary-token' })).statusCode, 403);
    assert.equal((await grant({ sourceConversationIds: [b.id], ownerId: 'other' })).statusCode, 400);
    assert.equal((await grant({ sourceConversationIds: [foreign.id] })).statusCode, 404);
    assert.equal((await grant({ sourceConversationIds: [b.id, b.id] })).statusCode, 400);
    assert.equal((await grant({ sourceConversationIds: [12] })).statusCode, 400);
    assert.equal((await grant({ sourceConversationIds: [b.id] })).statusCode, 200);
    const policy = (await f.api.inject({ url, headers })).json();
    assert.deepEqual(policy.sourceConversationIds, [b.id]); assert.equal(policy.revision, 1);
    assert.equal((await grant({ sourceConversationIds: [] })).statusCode, 200);
    assert.deepEqual((await f.api.inject({ url, headers })).json().sourceConversationIds, []);
    assert.equal((await f.api.inject({ url: `/api/v1/conversations/${foreign.id}/memory-sources`, headers })).statusCode, 404);
  } finally { await f.close(); }
});
