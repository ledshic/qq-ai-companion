import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExplicitCall, directedElsewhere, awaitingFollowUp, admitsWindowFollowUp, admitsEveryMessage,
  canMergeFragment, mergedFragment, repeatsUnansweredTopic } from './participation-policy.js';
import type { Inbound } from './participation-types.js';
import type { GroupMessage } from './message.js';

const message = (overrides: Partial<GroupMessage> = {}): GroupMessage => ({
  groupId: 'group', senderId: 'owner', selfId: 'bot', messageId: 'new', content: 'hello', isMentioned: false, ...overrides,
});
const pending = (overrides: Partial<Inbound> = {}): Inbound => ({
  kind: 'follow-up', message: message(), text: 'first', receivedAt: 1000, triggerIds: ['first'], ...overrides,
});

test('explicit triggers and legacy reply handling retain mode distinctions', () => {
  for (const unified of [true, false]) {
    for (const trigger of ['isMentioned', 'isCalledByName', 'isReplyToBot']) {
      assert.equal(isExplicitCall(message({ [trigger]: true }), unified), true);
    }
    assert.equal(isExplicitCall(message({ replyMessageId: 'quoted' }), unified), !unified);
    assert.equal(isExplicitCall(message(), unified), false);
  }
});

test('window and every-message admission preserve their distinct routing and length filters', () => {
  const other = message({ replyToSenderId: 'other' });
  assert.equal(directedElsewhere(other), true);
  assert.equal(admitsWindowFollowUp(other, 'hello'), false);
  assert.equal(admitsEveryMessage(other, 'hello'), true);
  assert.equal(directedElsewhere(message({ replyToSenderId: 'bot' })), false);
  for (const admit of [admitsWindowFollowUp, admitsEveryMessage]) {
    assert.equal(admit(message({ hasAnyMention: true }), 'hello'), false);
    assert.equal(admit(message(), ''), false);
    assert.equal(admit(message(), 'x'.repeat(4000)), true);
    assert.equal(admit(message(), 'x'.repeat(4001)), false);
  }
});

test('unanswered explicit requests and pending supplements take precedence until the exact deadline', () => {
  assert.equal(awaitingFollowUp(pending({ kind: 'explicit' }), undefined, 0, 1000), true);
  assert.equal(awaitingFollowUp(pending({ awaitingReply: true }), undefined, 0, 1000), true);
  assert.equal(awaitingFollowUp(undefined, pending({ awaitingReply: true }), 0, 1000), true);
  assert.equal(awaitingFollowUp(undefined, undefined, 1001, 1000), true);
  assert.equal(awaitingFollowUp(undefined, undefined, 1000, 1000), false);
});

test('fragment merging retains strict time and length boundaries for each task mode', () => {
  for (const mode of ['awaiting', 'follow-up', 'judge'] as const) {
    const task = pending({ kind: mode === 'judge' ? 'judge' : 'follow-up', awaitingReply: mode === 'awaiting' });
    assert.equal(canMergeFragment(task, 'next', 3999, mode), true);
    assert.equal(canMergeFragment(task, 'next', 4000, mode), false);
    assert.equal(canMergeFragment(task, 'x'.repeat(3994), 1000, mode), true);
    assert.equal(canMergeFragment(task, 'x'.repeat(3995), 1000, mode), false);
    assert.equal(canMergeFragment(undefined, 'next', 1000, mode), false);
  }
  assert.equal(canMergeFragment(pending({ kind: 'explicit' }), 'next', 1000, 'follow-up'), false);
  assert.equal(canMergeFragment(pending(), 'next', 1000, 'judge'), false);
  assert.equal(canMergeFragment(pending(), 'next', 1000, 'awaiting'), false);
});

test('merge patches retain pending candidate identity, accumulated trigger IDs and newest sender version', () => {
  const candidate = Object.assign(() => true, { consume: () => true });
  const task = pending({ candidate, awaitingReply: true });
  const patch = mergedFragment(task, 'next', 2000, 3, 'second');
  assert.equal(task.text, 'first');
  assert.deepEqual(patch, { text: 'first\nnext', receivedAt: 2000, senderVersion: 3, triggerIds: ['first', 'second'] });
  Object.assign(task, patch);
  assert.equal(task.candidate, candidate); assert.equal(task.awaitingReply, true);
});

test('topic suppression applies only to unanswered same-topic proactive participation in unified mode', () => {
  const previous = { topicKey: 'topic', basisIds: ['first'], at: 1000, responded: false };
  assert.equal(repeatsUnansweredTopic(true, previous, 'topic'), true);
  assert.equal(repeatsUnansweredTopic(false, previous, 'topic'), false);
  assert.equal(repeatsUnansweredTopic(true, { ...previous, responded: true }, 'topic'), false);
  assert.equal(repeatsUnansweredTopic(true, previous, 'new topic'), false);
});
