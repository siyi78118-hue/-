import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRelationshipStage } from '../src/relationship-stage.mjs';

const scene = {
  relationshipStage: {
    id: 'new', label: '初识', content: '保持普通社交边界。',
    since: 1000, reason: '第一次认识', confidence: 1
  },
  stageCatalog: [
    { id: 'new', label: '初识', content: '保持普通社交边界。' },
    { id: 'acquainted', label: '认识', content: '愿意维持联系。' },
    { id: 'familiar', label: '熟悉', content: '已经形成稳定聊天习惯。' },
    { id: 'close', label: '亲近', content: '允许更深的情绪交流。' },
    { id: 'committed', label: '关系确立', content: '双方已经明确确认稳定关系。' }
  ]
};

const messages = [
  { messageId: 'msg_1', speakerId: 'user', content: '以后常聊啊', sentAt: 1000 },
  { messageId: 'msg_2', speakerId: 'yuqi', content: '行，我也想继续认识你', sentAt: 2000 }
];

test('accepts an adjacent evidence-backed stage progression at the threshold', () => {
  const result = resolveRelationshipStage(scene, {
    current: 'new', recommended: 'acquainted', confidence: 0.82,
    reason: '双方明确愿意继续稳定联系', evidenceMessageIds: ['msg_1', 'msg_2'],
    explicitMutualChange: false
  }, messages, 3000);

  assert.equal(result.stage.id, 'acquainted');
  assert.equal(result.stage.content, '愿意维持联系。');
  assert.deepEqual(result.action.evidenceMessageIds, ['msg_1', 'msg_2']);
});

test('rejects low confidence, fabricated evidence and a non-mutual multi-stage jump', () => {
  for (const review of [
    { recommended: 'acquainted', confidence: 0.81, evidenceMessageIds: ['msg_1', 'msg_2'] },
    { recommended: 'acquainted', confidence: 0.99, evidenceMessageIds: ['msg_fake', 'msg_2'] },
    { recommended: 'close', confidence: 0.99, evidenceMessageIds: ['msg_1', 'msg_2'] }
  ]) {
    const result = resolveRelationshipStage(scene, {
      current: 'new', reason: '不满足确定性门槛', explicitMutualChange: false, ...review
    }, messages, 3000);
    assert.equal(result.stage.id, 'new');
    assert.equal(result.action, null);
  }
});

test('accepts an explicit mutual relationship confirmation with one real source', () => {
  const result = resolveRelationshipStage(scene, {
    current: 'new', recommended: 'committed', confidence: 0.95,
    reason: '双方明确确认恋爱关系', evidenceMessageIds: ['msg_2'], explicitMutualChange: true
  }, messages, 3000);
  assert.equal(result.stage.id, 'committed');
  assert.equal(result.action.from, 'new');
  assert.equal(result.action.to, 'committed');
});

test('tracks conflict as a separate phase without erasing familiar closeness', () => {
  const familiarScene = {
    ...scene,
    relationshipStage: {
      base: { id: 'familiar', label: '熟悉', content: '已经形成稳定聊天习惯。' },
      phase: { id: 'normal', label: '正常相处', content: '' }
    },
    phaseCatalog: [
      { id: 'normal', label: '正常相处', content: '' },
      { id: 'conflict', label: '闹矛盾期', content: '仍在意，但有未解决冲突。' },
      { id: 'cooling', label: '冷却期', content: '暂时拉开一点距离。' },
      { id: 'repair', label: '修复期', content: '双方正在重新靠近。' }
    ]
  };
  const result = resolveRelationshipStage(familiarScene, {
    base: null,
    phase: {
      current: 'normal',
      recommended: 'conflict',
      confidence: 0.91,
      reason: '双方明确围绕同一件事持续争执且情绪尚未解决',
      evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitAcknowledgedChange: false
    }
  }, messages, 3000);

  assert.equal(result.stage.base.id, 'familiar');
  assert.equal(result.stage.phase.id, 'conflict');
  assert.equal(result.stage.label, '熟悉 · 闹矛盾期');
  assert.equal(result.action.baseAction, null);
  assert.equal(result.action.phaseAction.to, 'conflict');
});

test('one disagreement does not enter conflict and elapsed time alone cannot repair it', () => {
  const conflictScene = {
    ...scene,
    relationshipStage: {
      base: { id: 'familiar', label: '熟悉', content: '' },
      phase: { id: 'conflict', label: '闹矛盾期', content: '' }
    }
  };
  const oneMessage = resolveRelationshipStage(conflictScene, {
    base: null,
    phase: {
      recommended: 'cooling',
      confidence: 0.95,
      reason: '刚刚有一句不同意见',
      evidenceMessageIds: ['msg_1'],
      explicitAcknowledgedChange: false
    }
  }, messages, 3000);
  assert.equal(oneMessage.stage.phase.id, 'conflict');

  const timeOnly = resolveRelationshipStage(conflictScene, {
    base: null,
    phase: {
      recommended: 'normal',
      confidence: 0.99,
      reason: '已经过去很久了',
      evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitAcknowledgedChange: false
    }
  }, messages, 3000);
  assert.equal(timeOnly.stage.phase.id, 'conflict');
});

test('sustained evidence permits an adjacent base regression', () => {
  const familiarScene = {
    ...scene,
    relationshipStage: { id: 'familiar', label: '熟悉', content: '' }
  };
  const result = resolveRelationshipStage(familiarScene, {
    base: {
      current: 'familiar',
      recommended: 'acquainted',
      confidence: 0.87,
      reason: '双方持续明确拉开距离并撤回原有亲密互动',
      evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitMutualChange: false
    },
    phase: null
  }, messages, 3000);
  assert.equal(result.stage.base.id, 'acquainted');
});
