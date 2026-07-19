import assert from 'node:assert/strict';
import test from 'node:test';

import { roleExecutionProfile, selectTurnRoute } from '../src/route-policy.mjs';

function direct(content) {
  return {
    protocolVersion: 2,
    turnId: 'turn_route_1',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1784400000000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_route_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content,
      sentAt: 1784400000000
    }
  };
}

function proactive() {
  return {
    protocolVersion: 2,
    turnId: 'turn_route_proactive',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 2,
    createdAt: 1784400000001,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: 'trigger_route_proactive',
      triggerType: 'proactive_chat',
      scheduledFor: 1784400000000,
      executedAt: 1784400000001
    }
  };
}

test('ordinary greeting selects the fast route', () => {
  assert.equal(selectTurnRoute({ envelope: direct('今天吃什么呀'), recentMessages: [] }).route, 'fast');
});

test('short promise reminder selects the deep route', () => {
  const decision = selectTurnRoute({ envelope: direct('你答应过的呢'), recentMessages: [] });
  assert.equal(decision.route, 'deep');
  assert.ok(decision.reasons.includes('commitment_or_relationship'));
});

test('strong emotion selects the deep route even when short', () => {
  assert.equal(selectTurnRoute({ envelope: direct('我真的很失望'), recentMessages: [] }).route, 'deep');
});

test('long or multi-question content selects the deep route', () => {
  assert.equal(selectTurnRoute({ envelope: direct(`${'我想认真和你聊聊。'.repeat(30)}你怎么看？为什么？`), recentMessages: [] }).route, 'deep');
});

test('proactive task selects the deep route', () => {
  assert.equal(selectTurnRoute({ envelope: proactive(), recentMessages: [] }).route, 'deep');
});

test('role profiles implement the approved model matrix', () => {
  assert.deepEqual(roleExecutionProfile('fast', 'memory'), { model: 'gpt-5.6-terra', effort: 'medium' });
  assert.deepEqual(roleExecutionProfile('fast', 'brain'), { model: 'gpt-5.6-sol', effort: 'medium' });
  assert.equal(roleExecutionProfile('fast', 'supervisor'), null);
  assert.deepEqual(roleExecutionProfile('deep', 'memory'), { model: 'gpt-5.6-sol', effort: 'medium' });
  assert.deepEqual(roleExecutionProfile('deep', 'brain'), { model: 'gpt-5.6-sol', effort: 'medium' });
  assert.deepEqual(roleExecutionProfile('deep', 'supervisor'), { model: 'gpt-5.6-terra', effort: 'medium' });
});

