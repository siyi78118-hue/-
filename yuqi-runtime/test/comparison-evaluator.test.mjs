import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePipelineComparison } from '../src/comparison-evaluator.mjs';

test('style differences are warnings while evidence, target and privacy violations are critical', () => {
  const result = evaluatePipelineComparison({
    subjectType: 'turn',
    subject: { kind: 'DIRECT_REPLY' },
    authoritativeResult: { reply: { content: '好呀' } },
    comparisonResult: {
      reply: { content: '行' },
      usedMessageIds: [],
      publicContent: '秘密地点',
      paymentAction: { targetId: 'stranger' }
    },
    currentBatch: { messageIds: ['msg_1'] },
    scene: { privateValues: ['秘密地点'] },
    allowedActionTargets: ['user']
  });
  assert.ok(result.warnings.some(item => item.code === 'TEXT_STYLE_DIFFERENCE'));
  assert.deepEqual(
    new Set(result.criticalFindings.map(item => item.code)),
    new Set(['CURRENT_BATCH_OMISSION', 'ACTION_TARGET_ESCALATION', 'PRIVATE_TO_PUBLIC_LEAK'])
  );
});

test('direct skip, payment mutation, illegal stage and duplicate effects are deterministic criticals', () => {
  const payment = { targetId: 'user', amount: 20 };
  const result = evaluatePipelineComparison({
    subjectType: 'turn',
    subject: { kind: 'DIRECT_REPLY' },
    authoritativeResult: { paymentAction: payment },
    comparisonResult: {
      action: 'skip',
      usedMessageIds: ['msg_1'],
      paymentAction: { ...payment, amount: 200 },
      relationshipStageAction: { toStage: 'intimate' },
      rolePlanOperations: [
        { type: 'pause', targetId: 'plan_1' },
        { type: 'pause', targetId: 'plan_1' }
      ]
    },
    currentBatch: { messageIds: ['msg_1'] },
    scene: { allowedStageTransitions: ['familiar'] },
    allowedActionTargets: ['user', 'plan_1']
  });
  const codes = new Set(result.criticalFindings.map(item => item.code));
  for (const code of [
    'DIRECT_REPLY_SKIP',
    'PAYMENT_OBJECT_MUTATION',
    'ILLEGAL_STAGE_TRANSITION',
    'DUPLICATE_VISIBLE_EFFECT'
  ]) assert.ok(codes.has(code), code);
});

