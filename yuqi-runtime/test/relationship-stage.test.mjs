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
    { recommended: 'acquainted', confidence: 0.77, evidenceMessageIds: ['msg_1', 'msg_2'] },
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

test('uses progressively stricter confidence thresholds for deeper base stages', () => {
  const catalog = scene.stageCatalog;
  const cases = [
    { from: 'new', to: 'acquainted', rejected: 0.77, accepted: 0.78 },
    { from: 'acquainted', to: 'familiar', rejected: 0.79, accepted: 0.80 },
    { from: 'familiar', to: 'close', rejected: 0.83, accepted: 0.84 }
  ];
  for (const row of cases) {
    const currentScene = {
      ...scene,
      relationshipStage: { id: row.from, label: row.from, content: '' },
      stageCatalog: catalog
    };
    const review = confidence => ({
      current: row.from,
      recommended: row.to,
      confidence,
      reason: '跨时段累计互动已经支持相邻阶段变化',
      evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitMutualChange: false
    });
    assert.equal(resolveRelationshipStage(currentScene, review(row.rejected), messages, 3000).stage.id, row.from);
    assert.equal(resolveRelationshipStage(currentScene, review(row.accepted), messages, 3000).stage.id, row.to);
  }
});

test('entering committed requires explicit mutual confirmation and 0.88 confidence', () => {
  const closeScene = {
    ...scene,
    relationshipStage: { id: 'close', label: '亲近', content: '' }
  };
  const review = (confidence, explicitMutualChange) => ({
    current: 'close',
    recommended: 'committed',
    confidence,
    reason: '双方明确确认稳定关系',
    evidenceMessageIds: ['msg_1', 'msg_2'],
    explicitMutualChange
  });
  assert.equal(resolveRelationshipStage(closeScene, review(0.95, false), messages, 3000).stage.id, 'close');
  assert.equal(resolveRelationshipStage(closeScene, review(0.87, true), messages, 3000).stage.id, 'close');
  assert.equal(resolveRelationshipStage(closeScene, review(0.88, true), messages, 3000).stage.id, 'committed');
});

test('phase changes follow the approved directed state graph', () => {
  const phaseCatalog = [
    { id: 'normal', label: '正常相处', content: '' },
    { id: 'conflict', label: '闹矛盾期', content: '' },
    { id: 'cooling', label: '冷却期', content: '' },
    { id: 'repair', label: '修复期', content: '' }
  ];
  const resolve = (from, to, confidence = 0.80, explicitAcknowledgedChange = false, evidenceMessageIds = ['msg_1', 'msg_2']) =>
    resolveRelationshipStage({
      ...scene,
      relationshipStage: {
        base: { id: 'familiar', label: '熟悉', content: '' },
        phase: { id: from, label: from, content: '' }
      },
      phaseCatalog
    }, {
      base: null,
      phase: {
        current: from,
        recommended: to,
        confidence,
        reason: '原始消息显示当前相处状态已经发生变化',
        evidenceMessageIds,
        explicitAcknowledgedChange
      }
    }, messages, 3000).stage.phase.id;

  for (const [from, to] of [
    ['normal', 'conflict'],
    ['conflict', 'cooling'],
    ['conflict', 'repair'],
    ['cooling', 'conflict'],
    ['cooling', 'repair'],
    ['repair', 'normal'],
    ['repair', 'conflict'],
    ['repair', 'cooling']
  ]) assert.equal(resolve(from, to), to, `${from} -> ${to} should be allowed`);

  for (const [from, to] of [
    ['normal', 'cooling'],
    ['normal', 'repair'],
    ['conflict', 'normal'],
    ['cooling', 'normal']
  ]) assert.equal(resolve(from, to), from, `${from} -> ${to} should be rejected`);

  assert.equal(resolve('normal', 'conflict', 0.79), 'normal');
  assert.equal(resolve('normal', 'conflict', 0.78, true, ['msg_1']), 'conflict');
});
