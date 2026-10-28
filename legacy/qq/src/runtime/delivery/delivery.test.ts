import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverPersonaReply, splitPersonaReply } from './delivery.js';

test('short reply stays whole and longer reply sends at most three parts', async () => {
  assert.deepEqual(splitPersonaReply('？'), ['？']);
  assert.deepEqual(splitPersonaReply('一\n二\n三\n四'), ['一', '二', '三 四']);
  const sent: string[] = [];
  const result = await deliverPersonaReply('一\n二', async part => { sent.push(part); return true; }, () => true, async () => {});
  assert.deepEqual(sent, ['一', '二']);
  assert.equal(result, '一\n二');
});

test('interruptions and send failures keep only text actually delivered', async () => {
  let allowed = true;
  const sent: string[] = [];
  const delivered = await deliverPersonaReply('一\n二', async part => { sent.push(part); return true; }, () => allowed, async () => { allowed = false; });
  assert.equal(delivered, '一');
  assert.deepEqual(sent, ['一']);
  let calls = 0;
  assert.equal(await deliverPersonaReply('一\n二', async () => ++calls === 1, () => true, async () => {}), '一');
});


test('asynchronous timing guards are awaited before each segment', async () => {
  const sent: string[] = []; let checks = 0;
  const delivered = await deliverPersonaReply('one\ntwo', async text => { sent.push(text); return true; },
    async () => ++checks === 1, async () => {});
  assert.deepEqual(sent, ['one']); assert.equal(delivered, 'one');
});


test('a failed asynchronous recheck preserves the already delivered prefix', async () => {
  const sent: string[] = []; let checks = 0;
  const delivered = await deliverPersonaReply('one\ntwo', async text => { sent.push(text); return true; },
    async () => { if (++checks > 1) throw new Error('review unavailable'); return true; }, async () => {});
  assert.deepEqual(sent, ['one']); assert.equal(delivered, 'one');
});
