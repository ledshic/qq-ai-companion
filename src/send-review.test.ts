import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveSend, type SendReviewServices } from './send-review.js';
import type { ContextMessage, GroupSnapshot, ReplyContext } from './context.js';

const bot = (id: string, replyTo = 'request', mentions = ['owner']): ContextMessage => ({
  id, replyTo, mentions, senderId: 'bot', role: 'assistant', text: 'part', at: 1000, revision: 1, media: false,
});
function fixture(unified = true) {
  const initial: GroupSnapshot = { groupId: 'group', version: 1, incomingVersion: 1, capturedAt: 1000, messages: [] };
  let snapshot = initial;
  let sender = true, window = true, memory = true;
  const reviewed: ReplyContext[] = [];
  const logs: string[] = [];
  const controller = new AbortController();
  const context: ReplyContext = { kind: 'explicit', targetSenderId: 'owner', triggerIds: ['request'], snapshot: initial,
    memoryGuard: () => memory };
  const services: SendReviewServices = { unified, senderCurrent: () => sender, candidate: () => window,
    snapshot: () => snapshot, reconsider: async context => { reviewed.push(context); return true; }, log: line => logs.push(line) };
  return { services, context, controller, reviewed, logs,
    approve: () => approveSend({ messageId: 'request', senderId: 'owner' }, context, 'draft', controller.signal, services),
    change: (patch: Partial<GroupSnapshot>) => { snapshot = { ...snapshot, ...patch }; },
    invalidate: (kind: string) => { if (kind === 'sender') sender = false; else if (kind === 'window') window = false;
      else if (kind === 'memory') memory = false; else controller.abort(); },
  };
}

test('legacy review checks local freshness without reading discussion or invoking a judge', async () => {
  const f = fixture(false);
  f.services.snapshot = () => { throw Error('must not read discussion'); };
  const guard = await f.approve(); assert.ok(guard);
  assert.equal(await guard(), true); assert.deepEqual(f.reviewed, []);
  f.invalidate('memory'); assert.equal(await guard(), false);
});

test('own acknowledged parts do not trigger rechecks while other bot replies do', async () => {
  const f = fixture(); const guard = await f.approve(); assert.ok(guard);
  f.change({ version: 2, messages: [bot('own-part')] });
  assert.equal(await guard(), true); assert.equal(f.reviewed.length, 0);
  f.change({ version: 3, messages: [bot('own-part'), bot('other-request', 'different-request')] });
  assert.equal(await guard(), true); assert.equal(f.reviewed.length, 1);
  assert.equal(await guard(), true); assert.equal(f.reviewed.length, 1, 'approved key is reused');
  f.change({ version: 4, messages: [bot('own-part'), bot('other-request', 'different-request'), bot('other-owner', 'request', ['other'])] });
  assert.equal(await guard(), true); assert.equal(f.reviewed.length, 2);
});

test('human-version changes trigger before-send review even when the visible message list is unchanged', async () => {
  const f = fixture(); f.change({ incomingVersion: 2, version: 2 });
  const guard = await f.approve(); assert.ok(guard);
  assert.equal(f.reviewed.length, 1);
  assert.equal(f.reviewed[0].phase, 'before_send'); assert.equal(f.reviewed[0].draft, 'draft');
  assert.equal(f.reviewed[0].snapshot.incomingVersion, 2);
  assert.equal(f.context.phase, undefined); assert.equal(f.context.snapshot.incomingVersion, 1);
  f.change({ capturedAt: 2000, version: 3 });
  assert.equal(await guard(), true); assert.equal(f.reviewed.length, 1);
});

test('negative or missing reconsideration rejects a changed draft before enqueueing', async () => {
  for (const response of [false, undefined]) {
    const f = fixture(); f.change({ incomingVersion: 2 });
    f.services.reconsider = async () => response;
    assert.equal(await f.approve(), undefined);
    assert.deepEqual(f.logs, ['[时机] 新讨论使回复不再适合发送，跳过。']);
  }
});

test('discussion changing again while a judge is pending rejects the result', async () => {
  const f = fixture(); const guard = await f.approve(); assert.ok(guard);
  let resolve!: (value: boolean) => void;
  f.services.reconsider = async () => new Promise<boolean>(done => { resolve = done; });
  f.change({ incomingVersion: 2 });
  const review = guard();
  f.change({ incomingVersion: 3 }); resolve(true);
  assert.equal(await review, false);
  assert.deepEqual(f.logs, ['[时机] 复查期间讨论再次变化，跳过本次发送。']);
});

test('cancellation, sender, window and memory freshness are checked before approval and after reconsideration', async () => {
  for (const kind of ['cancel', 'sender', 'window', 'memory']) {
    const stale = fixture(); stale.invalidate(kind); assert.equal(await stale.approve(), undefined);
    const f = fixture(); const guard = await f.approve(); assert.ok(guard);
    f.change({ incomingVersion: 2 });
    f.services.reconsider = async () => { f.invalidate(kind); return true; };
    assert.equal(await guard(), false, kind);
  }
});

test('judge errors propagate to delivery so an already delivered prefix can be preserved there', async () => {
  const f = fixture(); const guard = await f.approve(); assert.ok(guard);
  const failure = new Error('judge unavailable');
  f.services.reconsider = async () => { throw failure; };
  f.change({ incomingVersion: 2 });
  await assert.rejects(async () => guard(), error => error === failure);
});
