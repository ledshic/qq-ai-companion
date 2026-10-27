import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyContextPreparer } from './reply-context.js';
import type { ReplyContext } from './context.js';
import { resolveExpression } from '../../cognitive/personality/personality-policy.js';
import type { ObservationReceipt } from '../../cognitive/observation-types.js';
import type { RecallView } from '../../memory/events/recall-types.js';

const context = (kind: ReplyContext['kind'] = 'explicit'): ReplyContext => ({ kind, targetSenderId: 'owner', triggerIds: ['message'],
  snapshot: { chatId: 'group', version: 1, incomingVersion: 1, capturedAt: 1000, messages: [] } });
const receipt: ObservationReceipt = { inputRevision: 'revision', analyzerVersion: 'version', status: 'unknown' };
const view: RecallView = { status: 'empty', capturedAt: 'now', timezone: 'Asia/Shanghai', records: [] };
const signal = () => new AbortController().signal;

test('recall precedes personality planning with unchanged history, receipt and local freshness guard', async () => {
  for (const kind of ['explicit', 'follow-up'] as const) {
    const input = context(kind), history = [{ role: 'user' as const, content: 'history' }];
    const calls: string[] = [];
    let current = true;
    const guard = () => current;
    const plan = resolveExpression();
    const prepare = createReplyContextPreparer({
      eventMemory: { recall: async query => {
        calls.push('recall');
        assert.deepEqual(query, { chatId: 'group', ownerId: 'owner', text: 'question', history });
        return { view, isCurrent: guard };
      } },
      personality: { plan: async (analysis, _signal, reused, local) => {
        calls.push('plan');
        assert.equal(analysis.history, history); assert.equal(reused, receipt); assert.equal(local, undefined);
        assert.equal(analysis.context?.longTermMemory, view); assert.equal(analysis.context?.memoryGuard, guard);
        return plan;
      } },
    });
    const result = await prepare(input, 'question', history, signal(), receipt);
    assert.deepEqual(calls, ['recall', 'plan']);
    assert.equal(result.expressionPlan, plan); assert.ok(Object.isFrozen(result));
    assert.equal(input.longTermMemory, undefined);
    current = false; assert.equal(result.memoryGuard!(), false);
  }
});

test('bare calls, warmups and images keep their local expression modes; proactive paths never recall', async () => {
  for (const entry of [
    { kind: 'explicit' as const, text: '', image: false, local: 'bare', recalls: 0 },
    { kind: 'warmup' as const, text: '', image: false, local: 'warmup', recalls: 0 },
    { kind: 'interject' as const, text: 'topic', image: false, local: undefined, recalls: 0 },
    { kind: 'explicit' as const, text: 'picture', image: true, local: 'image', recalls: 1 },
  ]) {
    let recalls = 0;
    const prepare = createReplyContextPreparer({
      eventMemory: { recall: async () => { recalls++; return { view, isCurrent: () => true }; } },
      personality: { plan: async (_input, _signal, _receipt, local) => {
        assert.equal(local, entry.local); return resolveExpression();
      } },
    });
    await prepare(context(entry.kind), entry.text, [], signal(), undefined, entry.image);
    assert.equal(recalls, entry.recalls);
  }
});

test('cancellation after recall prevents planning and cancellation after planning rejects the result', async () => {
  for (const stage of ['recall', 'plan']) {
    const controller = new AbortController(), reason = new Error('superseded');
    let plans = 0;
    const prepare = createReplyContextPreparer({
      eventMemory: { recall: async () => {
        if (stage === 'recall') controller.abort(reason);
        return { view, isCurrent: () => true };
      } },
      personality: { plan: async () => { plans++; controller.abort(reason); return resolveExpression(); } },
    });
    await assert.rejects(prepare(context(), 'question', [], controller.signal), error => error === reason);
    assert.equal(plans, stage === 'plan' ? 1 : 0);
  }
});

test('disabled services preserve context identity; recall failures propagate without invoking personality', async () => {
  const input = context();
  assert.equal(await createReplyContextPreparer({})(input, 'question', [], signal()), input);
  const failure = new Error('recall unavailable');
  let plans = 0;
  const prepare = createReplyContextPreparer({
    eventMemory: { recall: async () => { throw failure; } },
    personality: { plan: async () => { plans++; return resolveExpression(); } },
  });
  await assert.rejects(prepare(input, 'question', [], signal()), error => error === failure);
  assert.equal(plans, 0);
});
