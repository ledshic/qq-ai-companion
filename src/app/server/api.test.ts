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
test('source policy revision conflicts cannot overwrite concurrent grants or revoke a newer list', async () => {
  const f = fixture();
  try {
    const a = f.store.createConversation('owner', 'Target'), b = f.store.createConversation('owner', 'Source B'), c = f.store.createConversation('owner', 'Source C');
    const url = `/api/v1/conversations/${a.id}/memory-sources`;
    const post = (sourceConversationIds: string[], expectedRevision: unknown) => f.api.inject({ method: 'POST', url, headers, payload: { sourceConversationIds, expectedRevision } });
    assert.equal((await post([b.id], 0)).statusCode, 200);
    assert.equal((await post([c.id], 0)).statusCode, 409);
    assert.equal((await post([], 0)).json().error.code, 'memory_policy_conflict');
    assert.deepEqual((await f.api.inject({ url, headers })).json(), { sourceConversationIds: [b.id], revision: 1 });
    for (const revision of [-1, 1.5, '1', null]) assert.equal((await post([], revision)).statusCode, 400);
    assert.equal((await post([], 1)).statusCode, 200);
    assert.deepEqual((await f.api.inject({ url, headers })).json(), { sourceConversationIds: [], revision: 2 });
  } finally { await f.close(); }
});
test('real provider deltas cross HTTP and SDK before commit; source revocation clears reconnect snapshots', async () => {
  const { createConsoleReply } = await import('../../channels/console/generator.js');
  const { ServiceMemory } = await import('../../runtime/service/memory.js');
  let generate!: ConsoleGenerator, finish!: () => void, cancelled = false;
  const f = fixture((...args) => generate(...args)); const controller = new AbortController();
  try {
    const source = f.store.createConversation('owner', 'Evidence'), target = f.store.createConversation('owner', 'Streaming');
    const evidence = f.store.accept('owner', source.id, 'source', '考试在周五'); f.store.start('owner', evidence.runId); f.store.finish('owner', evidence.runId, 'ack', null);
    const memory = new ServiceMemory(f.store); memory.setSources('owner', target.id, [source.id]);
    const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    generate = createConsoleReply('fixture', 'test', 9, false, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new TextEncoder().encode(frame({ content: '考试资料的草稿' })));
        finish = () => { if (!cancelled) { stream.enqueue(new TextEncoder().encode(frame({ content: '最终回答' }, 'stop') + 'data: [DONE]\n\n')); stream.close(); } };
      }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }, undefined, { memory });
    await f.api.listen({ host: '127.0.0.1', port: 0 }); const address = f.api.server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`, client = createServiceClient(base, { token: 'owner-token' });
    const accepted = await client.submit(target.id, 'stream', '考试资料'); const stream = client.watchRun(accepted.runId, controller.signal);
    let preview = await stream.next();
    while (!preview.value?.text) preview = await stream.next();
    assert.equal(preview.value?.text, '考试资料的草稿'); assert.equal(preview.value?.run.result, null);
    assert.deepEqual(f.store.history('owner', target.id), []);
    assert.equal((await f.api.inject({ url: `/api/v1/runs/${accepted.runId}/output` })).statusCode, 401);
    f.store.exec('INSERT INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,0)', 'foreign-stream-device', 'foreign', 'Foreign', tokenHash('foreign-token'));
    assert.equal((await f.api.inject({ url: `/api/v1/runs/${accepted.runId}/output`, headers: { authorization: 'Bearer foreign-token' } })).statusCode, 404);
    await client.setMemorySources(target.id, []);
    const terminal = await stream.next(); assert.equal(terminal.value?.text, ''); assert.equal(terminal.value?.run.error, 'memory_context_changed');
    assert.equal((await stream.next()).done, true);
    assert.equal((await client.output(accepted.runId)).text, '');
    finish(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.store.history('owner', target.id), []);
    assert.equal(f.store.messages('owner', target.id, 0, 50).messages.some(m => m.role === 'assistant'), false);
    // A new run takes a fresh authorized scope and commits the actual provider stream.
    await client.setMemorySources(target.id, [source.id]); cancelled = false;
    const recovered = await client.submit(target.id, 'recovered', '再查考试资料');
    const recovery = client.watchRun(recovered.runId, controller.signal);
    let first = await recovery.next(); while (!first.value?.text) first = await recovery.next();
    assert.equal(first.value?.run.result, null); finish();
    const completed = await recovery.next(); assert.equal(completed.value?.run.state, 'completed');
    assert.equal(completed.value?.text, ''); assert.equal(completed.value?.run.result, '考试资料的草稿最终回答');
    assert.equal((await recovery.next()).done, true);
    assert.deepEqual(f.store.history('owner', target.id).map(message => message.content), ['再查考试资料', '考试资料的草稿最终回答']);
  } finally { controller.abort(); await f.close(); }
});
test('output streams reconnect with snapshots, finish once and stop when device credentials are revoked', async () => {
  let emit!: (text: string) => void, finish!: (text: string) => void;
  const f = fixture((_content, _history, _signal, _reasoning, context) => { emit = context!.onOutput!; return new Promise(resolve => { finish = resolve; }); });
  const first = new AbortController(), second = new AbortController(), revoked = new AbortController();
  try {
    await f.api.listen({ host: '127.0.0.1', port: 0 }); const address = f.api.server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`, client = createServiceClient(base, { token: 'owner-token' });
    const c = await client.createConversation('Output'); const accepted = await client.submit(c.id, 'first', 'hello'); await wait(() => !!emit);
    emit('first'); const stream = client.watchRun(accepted.runId, first.signal); assert.equal((await stream.next()).value?.text, 'first');
    first.abort(); await stream.return(undefined).catch(() => {}); assert.equal(f.store.run('owner', accepted.runId).state, 'running');
    emit('first second'); const reconnected = client.watchRun(accepted.runId, second.signal);
    assert.equal((await reconnected.next()).value?.text, 'first second');
    finish('complete answer'); const complete = await reconnected.next();
    assert.equal(complete.value?.text, ''); assert.equal(complete.value?.run.result, 'complete answer'); assert.equal((await reconnected.next()).done, true);
    assert.deepEqual(f.store.history('owner', c.id).map(m => m.content), ['hello', 'complete answer']);
    emit = undefined!; const pending = await client.submit(c.id, 'second', 'remain running'); await wait(() => !!emit); emit('authorized');
    f.store.exec('INSERT INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,0)', 'stream-device', 'owner', 'Device', tokenHash('device-token'));
    const device = createServiceClient(base, { token: 'device-token' }), observation = device.watchRun(pending.runId, revoked.signal);
    assert.equal((await observation.next()).value?.text, 'authorized');
    f.store.revoke('owner', 'stream-device'); emit('must not reach revoked reader');
    await assert.rejects(observation.next(), /before terminal/);
    assert.equal(f.store.run('owner', pending.runId).state, 'running'); finish('owner can still finish');
  } finally { first.abort(); second.abort(); revoked.abort(); await f.close(); }
});
test('task summaries paginate by creation, isolate owners and never expose prompt, result, reasoning or draft', async () => {
  const f = fixture();
  try {
    const create = (owner: string, title: string, key: string) => { const c = f.store.createConversation(owner, title); return f.store.accept(owner, c.id, key, 'private-input-' + key).runId; };
    const first = create('owner', 'Completed', 'first'); f.store.start('owner', first); f.store.finish('owner', first, 'private-result', null, 'private-reasoning');
    const queued = create('owner', 'Queued', 'queued'), running = create('owner', 'Running', 'running'); f.store.start('owner', running);
    const foreign = create('other', 'foreign-title', 'foreign');
    const get = async (query = '', auth: Record<string, string> = headers) => f.api.inject({ url: '/api/v1/runs' + query, headers: auth });
    assert.equal((await f.api.inject('/api/v1/runs')).statusCode, 401);
    assert.equal((await get('', { ...headers, origin: 'https://evil.example' })).statusCode, 403);
    for (const query of ['?status=bogus', '?limit=0', '?limit=201', '?limit=1.2', '?before=', '?ownerId=other']) assert.equal((await get(query)).statusCode, 400);
    assert.equal((await get('?before=' + foreign)).statusCode, 404);
    const page = (await get('?status=all&limit=1')).json(); assert.deepEqual(page.runs.map((run: any) => run.id), [running]); assert.equal(page.nextCursor, running);
    const newest = create('owner', 'Arrived between pages', 'newest');
    const next = (await get('?status=all&limit=2&before=' + page.nextCursor)).json(); assert.deepEqual(next.runs.map((run: any) => run.id), [queued, first]); assert.equal(next.nextCursor, null);
    const active = (await get('?status=active')).json(); assert.deepEqual(active.runs.map((run: any) => run.id), [newest, running, queued]);
    f.store.finish('owner', running, 'finished between pages', null);
    const afterChangedCursor = (await get('?status=active&before=' + running)).json();
    assert.deepEqual(afterChangedCursor.runs.map((run: any) => run.id), [queued]);
    const all = (await get()).body; for (const hidden of ['private-input', 'private-result', 'private-reasoning', 'foreign-title', '"input"', '"result"', '"text"']) assert(!all.includes(hidden));
    f.store.exec('INSERT INTO service_devices(id,owner_id,name,token_hash,admin) VALUES(?,?,?,?,0)', 'list-device', 'owner', 'Device', tokenHash('list-token'));
    const device = { authorization: 'Bearer list-token' }; assert.equal((await get('', device)).statusCode, 200);
    f.store.revoke('owner', 'list-device'); assert.equal((await get('', device)).statusCode, 401);
  } finally { await f.close(); }
});
test('conversation task filtering checks ownership, scoped cursors, empty owned conversations and pagination', async () => {
  const f = fixture();
  try {
    const a = f.store.createConversation('owner', 'A'), b = f.store.createConversation('owner', 'B');
    const empty = f.store.createConversation('owner', 'Empty'), foreign = f.store.createConversation('other', 'Private');
    const add = (id: string, key: string, completed = true) => { const run = f.store.accept('owner', id, key, 'secret body'); if (completed) { f.store.start('owner', run.runId); f.store.finish('owner', run.runId, 'secret answer', null); } return run.runId; };
    const a1 = add(a.id, 'a1'), other = add(b.id, 'b', false), a2 = add(a.id, 'a2');
    const get = (suffix: string) => f.api.inject({ url: '/api/v1/runs?' + suffix, headers });
    const first = (await get('conversationId=' + a.id + '&limit=1')).json(); assert.deepEqual(first.runs.map((r: any) => r.id), [a2]);
    add(a.id, 'a3'); const next = (await get('conversationId=' + a.id + '&limit=1&before=' + first.nextCursor)).json();
    assert.deepEqual(next.runs.map((r: any) => r.id), [a1]); assert.equal(next.nextCursor, null);
    assert.deepEqual((await get('conversationId=' + a.id + '&status=active')).json(), { runs: [], nextCursor: null });
    assert.deepEqual((await get('conversationId=' + b.id + '&status=active')).json().runs.map((r: any) => r.id), [other]);
    assert.deepEqual((await get('conversationId=' + empty.id)).json(), { runs: [], nextCursor: null });
    for (const query of ['conversationId=' + foreign.id, 'conversationId=missing', 'conversationId=' + a.id + '&before=' + other]) assert.equal((await get(query)).statusCode, 404);
    for (const query of ['conversationId=', 'conversationId=' + a.id + '&conversationId=' + b.id]) assert.equal((await get(query)).statusCode, 400);
    assert.equal((await f.api.inject('/api/v1/runs?conversationId=' + a.id)).statusCode, 401);
    assert.equal((await f.api.inject({ url: '/api/v1/runs?conversationId=' + a.id, headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
  } finally { await f.close(); }
});
test('specific task states isolate owners, combine with conversation scope and retain cursors after state transitions', async () => {
  const f = fixture();
  try {
    const states = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
    const own = new Map<string, string>();
    for (const state of states) {
      for (const owner of ['owner', 'other']) {
        const c = f.store.createConversation(owner, owner + '-' + state), run = f.store.accept(owner, c.id, state, 'private input');
        if (state === 'running' || state === 'completed' || state === 'failed') f.store.start(owner, run.runId);
        if (state === 'completed') f.store.finish(owner, run.runId, 'private result', null);
        if (state === 'failed') f.store.finish(owner, run.runId, null, 'generation_failed');
        if (state === 'cancelled') f.store.cancel(owner, run.runId);
        if (state === 'interrupted') f.store.exec("UPDATE service_runs SET state='interrupted',error='service_restarted' WHERE id=?", run.runId);
        if (owner === 'owner') own.set(state, run.runId);
      }
    }
    const get = (query: string) => f.api.inject({ url: '/api/v1/runs?' + query, headers });
    for (const state of states) {
      const page = (await get('status=' + state)).json(); assert.deepEqual(page.runs.map((run: any) => [run.id, run.state]), [[own.get(state), state]]);
      assert.equal(page.nextCursor, null); assert(!JSON.stringify(page).includes('private'));
    }
    const c = f.store.createConversation('owner', 'Scoped history'); const completed: string[] = [];
    for (let i = 0; i < 3; i++) { const run = f.store.accept('owner', c.id, 'c-' + i, 'question'); f.store.start('owner', run.runId); f.store.finish('owner', run.runId, i === 1 ? null : 'answer', i === 1 ? 'generation_failed' : null); if (i !== 1) completed.push(run.runId); }
    const first = (await get('status=completed&conversationId=' + c.id + '&limit=1')).json(); assert.equal(first.runs[0].id, completed[1]);
    const next = (await get('status=completed&conversationId=' + c.id + '&limit=1&before=' + first.nextCursor)).json(); assert.deepEqual(next.runs.map((run: any) => run.id), [completed[0]]); assert.equal(next.nextCursor, null);
    const newer = f.store.createConversation('owner', 'New running'), nr = f.store.accept('owner', newer.id, 'running', 'question'); f.store.start('owner', nr.runId);
    const running = (await get('status=running&limit=1')).json(); assert.equal(running.runs[0].id, nr.runId); f.store.finish('owner', nr.runId, 'finished', null);
    assert.deepEqual((await get('status=running&before=' + running.nextCursor)).json().runs.map((run: any) => run.id), [own.get('running')]);
    for (const status of ['finished', 'RUNNING', '', 'running,queued', 'running&status=failed']) assert.equal((await get('status=' + status)).statusCode, 400);
    const foreign = f.store.createConversation('other', 'Foreign'); assert.equal((await get('status=failed&conversationId=' + foreign.id)).statusCode, 404);
  } finally { await f.close(); }
});
