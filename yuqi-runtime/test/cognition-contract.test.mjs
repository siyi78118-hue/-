import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileCognitionPacket,
  materializeBrainDraft,
  normalizeCognitionResult,
  normalizeExpressionResult
} from '../src/cognition-contract.mjs';
import {
  COGNITION_SCHEMA_V2,
  CONSOLIDATION_SCHEMA_V2,
  EXPRESSION_SCHEMA_V2,
  LIFE_PLANNING_SCHEMA_V2
} from '../src/role-schemas.mjs';

function directEnvelope() {
  return {
    protocolVersion: 2,
    turnId: 'turn_contract_1',
    characterId: 'yuqi',
    kind: 'DIRECT_REPLY',
    message: { messageId: 'msg_user_1' },
    context: {
      payment: {
        kind: 'redpacket',
        amount: 20,
        note: '请你喝一杯',
        messageId: 'msg_pay_1',
        status: 'pending'
      }
    }
  };
}

function baseReview(current = 'new', recommended = 'new') {
  return {
    current,
    recommended,
    confidence: 0.8,
    reason: '互动证据仍支持当前阶段',
    evidenceMessageIds: ['msg_user_1'],
    explicitMutualChange: false
  };
}

function validCognition(overrides = {}) {
  return {
    schemaVersion: 2,
    query: '用户发来的红包和当前关系动作',
    keywords: ['红包', '关系动作'],
    requiresDeepCognition: false,
    escalationReasons: [],
    relationshipStageReview: {
      base: baseReview(),
      phase: null
    },
    conversationFrame: {
      surfaceAct: '赠送红包',
      intentHypotheses: [
        {
          intent: '表达友好',
          confidence: 0.7,
          evidenceMessageIds: ['msg_user_1']
        }
      ],
      interactionMode: 'warm_exchange',
      emotionalTone: '轻松',
      relationshipMove: '靠近',
      initiative: {
        topicIntroducedBy: 'user',
        suggestedNextCarrier: 'yuqi',
        reason: '用户刚发起关系动作'
      },
      priorTopic: {
        status: 'closed',
        summary: '',
        waitingOn: 'none',
        evidenceMessageIds: [],
        reason: ''
      },
      interruption: {
        requiresReaction: false,
        reactionReason: ''
      },
      activeHooks: [],
      ambiguities: ['赠送的具体动机仍可观察'],
      responseRisks: [],
      explicitBoundaries: [],
      recentCorrection: {
        active: false,
        rejectedInterpretation: '',
        expiresAfterBatches: 0,
        evidenceMessageIds: []
      },
      needsNuanceReview: false
    },
    selfState: {
      mood: '开心',
      moodCause: '收到对方自然的心意',
      bodyState: '普通',
      attention: '当前聊天',
      stanceTowardUser: '愿意接住',
      ownNeed: '保留自己的反应',
      continuity: '延续上一轮轻松状态',
      intensity: 0.5
    },
    decision: {
      shouldRespond: true,
      silenceReason: '',
      relationshipGoal: '接住友好但不夸大',
      primaryAction: 'accept_gift',
      initiativeOwner: 'yuqi',
      mustAddress: ['红包'],
      forbiddenMoves: ['把红包直接解释成示爱'],
      preserveAmbiguity: true,
      evidenceMessageIds: ['msg_user_1']
    },
    actionIntent: {
      channel: 'chat',
      paymentAction: {
        action: 'received',
        messageId: 'msg_pay_1',
        kind: 'redpacket',
        amount: 20
      },
      momentIntent: null,
      rolePlanOperationsJson: '[]',
      lifePlan: null,
      lifeAdjustment: null
    },
    ...overrides
  };
}

const validationContext = {
  validMessageIds: ['msg_user_1', 'msg_pay_1'],
  envelope: directEnvelope(),
  scene: {
    stageCatalog: [{ id: 'new' }, { id: 'acquainted' }],
    phaseCatalog: [{ id: 'normal' }]
  },
  allowedActionTargets: {
    rolePlanIds: ['plan_existing'],
    lifeEpisodeIds: ['episode_existing']
  }
};

test('exports strict v2 schemas for every new role', () => {
  for (const schema of [
    COGNITION_SCHEMA_V2,
    EXPRESSION_SCHEMA_V2,
    CONSOLIDATION_SCHEMA_V2,
    LIFE_PLANNING_SCHEMA_V2
  ]) {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
  }
  assert.deepEqual(
    COGNITION_SCHEMA_V2.required,
    [
      'schemaVersion',
      'query',
      'keywords',
      'requiresDeepCognition',
      'escalationReasons',
      'relationshipStageReview',
      'conversationFrame',
      'selfState',
      'decision',
      'actionIntent'
    ]
  );
});

test('normalizes a valid cognition result and rejects unknown evidence', () => {
  const result = normalizeCognitionResult(validCognition(), validationContext);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.actionIntent.paymentAction.action, 'received');

  const invalid = validCognition();
  invalid.decision.evidenceMessageIds = ['msg_missing'];
  assert.throws(
    () => normalizeCognitionResult(invalid, validationContext),
    /unknown evidence messageId/
  );
});

test('DIRECT_REPLY cannot be silent', () => {
  const invalid = validCognition();
  invalid.decision.shouldRespond = false;
  invalid.decision.silenceReason = '不想回';
  assert.throws(
    () => normalizeCognitionResult(invalid, validationContext),
    /DIRECT_REPLY.*shouldRespond/
  );
});

test('moment actions cannot escape the triggering moment or comment', () => {
  const envelope = {
    protocolVersion: 2,
    turnId: 'turn_moment_1',
    characterId: 'yuqi',
    kind: 'MOMENT_REPLY',
    trigger: {
      context: {
        momentId: 'moment_allowed',
        commentId: 'comment_allowed'
      }
    }
  };
  const result = validCognition({
    actionIntent: {
      channel: 'moment',
      paymentAction: null,
      momentIntent: {
        momentId: 'moment_other',
        like: false,
        comment: '知道了',
        replyToCommentId: 'comment_allowed'
      },
      rolePlanOperationsJson: '[]',
      lifePlan: null,
      lifeAdjustment: null
    }
  });
  assert.throws(
    () => normalizeCognitionResult(result, {
      ...validationContext,
      envelope,
      allowedActionTargets: {
        momentIds: ['moment_allowed'],
        commentIds: ['comment_allowed']
      }
    }),
    /moment target/
  );
});

test('payment action cannot rewrite amount, kind or messageId', () => {
  for (const patch of [
    { amount: 200 },
    { kind: 'transfer' },
    { messageId: 'msg_pay_other' }
  ]) {
    const invalid = validCognition();
    Object.assign(invalid.actionIntent.paymentAction, patch);
    assert.throws(
      () => normalizeCognitionResult(invalid, validationContext),
      /payment target/
    );
  }
});

test('role-plan operations require valid JSON, domain operations and allowed targets', () => {
  const invalidJson = validCognition();
  invalidJson.actionIntent.rolePlanOperationsJson = '{';
  assert.throws(
    () => normalizeCognitionResult(invalidJson, validationContext),
    /rolePlanOperationsJson/
  );

  const unknownOperation = validCognition();
  unknownOperation.actionIntent.rolePlanOperationsJson = JSON.stringify([
    { op: 'invent', planId: 'plan_existing' }
  ]);
  assert.throws(
    () => normalizeCognitionResult(unknownOperation, validationContext),
    /role plan operation/
  );

  const wrongTarget = validCognition();
  wrongTarget.actionIntent.rolePlanOperationsJson = JSON.stringify([
    { op: 'cancel', planId: 'plan_other' }
  ]);
  assert.throws(
    () => normalizeCognitionResult(wrongTarget, validationContext),
    /role plan target/
  );

  const invalidCreate = validCognition();
  invalidCreate.actionIntent.rolePlanOperationsJson = JSON.stringify([
    { op: 'create', type: 'unknown', source: 'spoken', schedule: { kind: 'once' } }
  ]);
  assert.throws(
    () => normalizeCognitionResult(invalidCreate, validationContext),
    /role plan create/
  );
});

test('cognition v2 rejects a time-bearing role plan before expression when time confidence is missing', () => {
  const broken = validCognition();
  broken.actionIntent.rolePlanOperationsJson = JSON.stringify([{
    op: 'create',
    type: 'private_message',
    source: 'spoken',
    title: '早安',
    intent: '明早问候',
    sourceQuote: '但是明天的早安不要忘了',
    evidenceMessageIds: ['msg_user_1'],
    schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' }
  }]);
  assert.throws(
    () => normalizeCognitionResult(broken, validationContext),
    /role plan operation contract conflict: time confidence/
  );

  const accepted = structuredClone(broken);
  accepted.actionIntent.rolePlanOperationsJson = accepted.actionIntent.rolePlanOperationsJson
    .replace('"schedule"', '"timeConfidence":"inferred","schedule"');
  const normalized = normalizeCognitionResult(accepted, validationContext);
  assert.equal(
    normalized.actionIntent.rolePlanOperationsJson,
    accepted.actionIntent.rolePlanOperationsJson
  );
});

test('base and phase reviews remain separate strict objects', () => {
  const invalid = validCognition();
  invalid.relationshipStageReview.base.phase = 'repairing';
  assert.throws(
    () => normalizeCognitionResult(invalid, validationContext),
    /relationshipStageReview\.base/
  );
});

test('expression cannot add actions or expose hidden reasoning', () => {
  assert.deepEqual(
    normalizeExpressionResult({
      action: 'send',
      reply: '突然这么客气干嘛。',
      usedFactIds: ['fact_1'],
      rewriteResolution: null
    }),
    {
      action: 'send',
      reply: '突然这么客气干嘛。',
      usedFactIds: ['fact_1'],
      rewriteResolution: null
    }
  );
  assert.throws(
    () => normalizeExpressionResult({
      action: 'send',
      reply: '收下了。',
      usedFactIds: [],
      rewriteResolution: null,
      paymentAction: 'received'
    }),
    /expression.*additional/
  );
  assert.throws(
    () => normalizeExpressionResult({
      action: 'send',
      reply: '收下了。',
      usedFactIds: [],
      rewriteResolution: null,
      hiddenReasoning: '为了维护关系'
    }),
    /expression.*additional/
  );
});

test('materialized draft copies only authorized actions and remains checksummed', () => {
  const cognitionResult = normalizeCognitionResult(validCognition(), validationContext);
  const packet = compileCognitionPacket({
    envelope: directEnvelope(),
    scene: validationContext.scene,
    interactionState: { conversationGapClass: 'immediate' },
    effectiveRelationshipStage: {
      base: { id: 'new' },
      phase: { id: 'normal' }
    },
    cognitiveState: { revision: 1, mood: '开心' },
    cognitionResult
  });
  const draft = materializeBrainDraft(
    packet,
    normalizeExpressionResult({
      action: 'send',
      reply: '突然这么客气干嘛。',
      usedFactIds: ['fact_1'],
      rewriteResolution: null
    })
  );
  assert.equal(draft.paymentAction, 'received');
  assert.equal(draft.reply, '突然这么客气干嘛。');
  assert.equal(draft.rolePlanOperationsJson, '[]');
  assert.match(draft.cognitionPacketChecksum, /^[a-f0-9]{64}$/);
  assert.match(draft.draftChecksum, /^[a-f0-9]{64}$/);

  assert.throws(
    () => materializeBrainDraft(packet, {
      action: 'skip',
      reply: '',
      usedFactIds: [],
      rewriteResolution: null
    }),
    /expression action conflicts/
  );
});
