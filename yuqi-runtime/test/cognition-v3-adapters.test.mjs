import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adapterForTurnKind,
  buildCognitionEnvelopeV3
} from '../src/cognition-v3-adapters.mjs';
import { runCognitionV3Turn } from '../src/cognitive-pipeline.mjs';

const TURN_CASES = [
  ['DIRECT_REPLY', ['currentBatch', 'payment', 'attachments', 'quote']],
  ['PROACTIVE_CHAT', ['motiveCandidates', 'openThreads', 'dueCommitments']],
  ['PROACTIVE_MOMENT', ['committedLifeEvents', 'publicPrivacy']],
  ['MOMENT_INTERACTION', ['targetMoment', 'targetComment', 'thread', 'publicPrivacy']],
  ['MOMENT_REPLY', ['targetMoment', 'targetComment', 'thread', 'publicPrivacy']],
  ['ROLE_PLAN_CHAT', ['rolePlan', 'occurrence']],
  ['ROLE_PLAN_MOMENT', ['rolePlan', 'occurrence', 'publicPrivacy']],
  ['ROLE_PLAN_CHAT_PRIVATE', ['rolePlan', 'occurrence']],
  ['ROLE_PLAN_MOMENT_PRIVATE', ['rolePlan', 'occurrence', 'publicPrivacy']],
  ['LIFE_PLANNING', ['planningWindow', 'existingEpisodes']]
];

function historyGroup(index, bubbles = 1) {
  return Array.from({ length: bubbles }, (_, bubble) => ({
    messageId: `history_${index}_${bubble}`,
    turnId: `history_turn_${index}`,
    speakerType: index % 2 ? 'character' : 'user',
    sentAt: index * 10 + bubble,
    content: `history ${index}/${bubble}`
  }));
}

function oversizedInput(kind) {
  const currentBatch = {
    batchId: 'batch_current',
    sourceMessageId: 'msg_current_3',
    messageIds: ['msg_current_1', 'msg_current_2', 'msg_current_3'],
    messages: [
      {
        messageId: 'msg_current_1',
        messageType: 'text',
        content: '第一条',
        sentAt: 100
      },
      {
        messageId: 'msg_current_2',
        messageType: 'voice',
        content: '',
        transcript: '语音转写内容',
        quote: { messageId: 'quoted_1', text: '被引用的话' },
        sentAt: 101
      },
      {
        messageId: 'msg_current_3',
        messageType: 'image',
        content: '看这个',
        attachments: [{
          attachmentId: 'attachment_1',
          kind: 'image',
          mime: 'image/jpeg',
          dataUrl: 'data:image/jpeg;base64,DO_NOT_COPY'
        }],
        payment: {
          messageId: 'payment_1',
          kind: 'redpacket',
          amount: 20
        },
        sentAt: 102
      }
    ]
  };
  return {
    envelope: {
      turnId: `turn_${kind.toLowerCase()}`,
      characterId: 'yuqi',
      kind,
      context: {
        currentBatch,
        payment: currentBatch.messages[2].payment,
        quote: currentBatch.messages[1].quote
      }
    },
    currentBatch,
    relevantHistory: [
      ...historyGroup(0, 3),
      ...Array.from({ length: 21 }, (_, index) => historyGroup(index + 1)).flat()
    ],
    verifiedFacts: Array.from({ length: 12 }, (_, index) => ({
      factId: `fact_${index}`,
      relevanceScore: 12 - index
    })),
    constraints: Array.from({ length: 8 }, (_, index) => ({
      constraintId: `constraint_${index}`,
      authority: 'user',
      authorityRank: 300,
      scope: { kinds: ['all'] },
      rule: `constraint ${index}`,
      status: 'active',
      evidenceIds: [`message_${index}`],
      createdAt: index
    })),
    preferences: Array.from({ length: 7 }, (_, index) => ({
      preferenceId: `preference_${index}`,
      topic: `topic_${index}`,
      value: `value_${index}`,
      weight: 7 - index,
      scope: { kinds: ['all'] }
    })),
    stances: Array.from({ length: 5 }, (_, index) => ({
      stanceId: `stance_${index}`,
      topic: `stance topic ${index}`,
      position: `position ${index}`,
      strength: 5 - index,
      status: 'active',
      scope: { kinds: ['all'] },
      lastConfirmedAt: 10 + index
    })),
    relationship: {
      base: 'familiar',
      phase: 'normal',
      formalFacts: [{ factId: 'relationship_1' }],
      privateInternalNotes: ['must not leak']
    },
    lifeSignals: Array.from({ length: 10 }, (_, index) => ({
      id: `life_${index}`,
      relevanceScore: 10 - index
    })),
    authorSettings: { language: 'zh-CN', bubbleLimit: 5 },
    socialExperience: Array.from({ length: 6 }, (_, index) => ({
      lessonId: `lesson_${index}`,
      relevanceScore: 6 - index
    })),
    openThreads: Array.from({ length: 6 }, (_, index) => ({
      id: `thread_${index}`,
      relevanceScore: 6 - index
    })),
    motiveCandidates: [{ id: 'motive_1' }],
    dueCommitments: [{ id: 'commitment_1' }],
    lifeEvents: [
      { id: 'event_private', state: 'committed', privacy: 'private' },
      { id: 'event_public', state: 'committed', privacy: 'public' },
      { id: 'event_draft', state: 'draft', privacy: 'public' }
    ],
    publicPrivacy: { allowPublic: true },
    targetMoment: { momentId: 'moment_1' },
    targetComment: { commentId: 'comment_1' },
    thread: [{ commentId: 'comment_1' }],
    rolePlan: { rolePlanId: 'plan_1' },
    occurrence: { occurrenceId: 'occurrence_1' },
    planningWindow: { from: 100, to: 200 },
    existingEpisodes: [{ episodeId: 'episode_1' }],
    now: 150
  };
}

for (const [kind, featureKeys] of TURN_CASES) {
  test(`${kind} receives only its bounded feature context`, () => {
    const input = oversizedInput(kind);
    const result = buildCognitionEnvelopeV3(input);
    const publicMomentKind = new Set([
      'PROACTIVE_MOMENT',
      'MOMENT_INTERACTION',
      'MOMENT_REPLY',
      'ROLE_PLAN_MOMENT',
      'ROLE_PLAN_MOMENT_PRIVATE'
    ]).has(kind);

    assert.deepEqual(Object.keys(result.featureContext).sort(), [...featureKeys].sort());
    assert.equal(
      result.currentInteraction.messages.length,
      publicMomentKind ? 0 : input.currentBatch.messages.length
    );
    assert.ok(result.relevantHistory.length <= 22);
    assert.equal(
      new Set(result.relevantHistory.map((item) => item.turnId)).size,
      publicMomentKind ? 0 : 20
    );
    assert.ok(result.verifiedFacts.length <= 8);
    assert.ok(result.hardConstraints.length <= 5);
    assert.ok(result.currentStances.length <= 2);
    assert.ok(result.preferences.length <= 4);
    assert.ok(result.socialExperience.length <= 3);
    assert.equal(result.openThreads.length, publicMomentKind ? 0 : 3);
    assert.ok(Array.isArray(result.allowedActions));
    assert.ok(result.allowedActions.length > 0);
  });
}

test('current interaction preserves every submitted bubble and safe rich-message references', () => {
  const result = buildCognitionEnvelopeV3(oversizedInput('DIRECT_REPLY'));

  assert.deepEqual(result.currentInteraction.messages.map((item) => item.messageId), [
    'msg_current_1',
    'msg_current_2',
    'msg_current_3'
  ]);
  assert.equal(result.currentInteraction.messages[1].transcript, '语音转写内容');
  assert.deepEqual(result.currentInteraction.messages[1].quote, {
    messageId: 'quoted_1',
    text: '被引用的话'
  });
  assert.equal(result.currentInteraction.messages[2].payment.amount, 20);
  assert.deepEqual(result.currentInteraction.messages[2].attachments, [{
    attachmentId: 'attachment_1',
    kind: 'image',
    mime: 'image/jpeg'
  }]);
  assert.equal(JSON.stringify(result).includes('DO_NOT_COPY'), false);
});

test('PROACTIVE_CHAT consumes pinned motive authority candidates instead of rebuilding timer input', () => {
  const input = oversizedInput('PROACTIVE_CHAT');
  input.motiveCandidates = [{ motiveId: 'legacy_should_not_win' }];
  input.proactiveMotiveAuthority = {
    version: 'proactive-motive-v1',
    consideredAt: 100,
    candidates: [{
      motiveId: 'motive_pinned',
      sourceType: 'open_thread',
      sourceId: 'thread_1',
      sourceRevision: 2,
      sourceChecksum: 'a'.repeat(64),
      occurredAt: 90,
      expiresAt: 1000,
      summary: 'pinned summary'
    }],
    structuralSilence: null,
    checksum: 'b'.repeat(64)
  };
  const result = buildCognitionEnvelopeV3(input);
  assert.deepEqual(result.featureContext.motiveCandidates, input.proactiveMotiveAuthority.candidates);
  assert.equal(JSON.stringify(result.featureContext).includes('legacy_should_not_win'), false);
});

test('PROACTIVE_CHAT prefers the persisted turn annotation over caller motive candidates', () => {
  const input = oversizedInput('PROACTIVE_CHAT');
  input.motiveCandidates = [{ motiveId: 'caller_must_not_win' }];
  input.proactiveMotiveAuthority = { candidates: [{ motiveId: 'caller_authority' }] };
  input.turn = {
    annotationSnapshot: {
      proactiveMotiveAuthority: {
        candidates: [{ motiveId: 'persisted_motive' }]
      }
    }
  };
  const result = buildCognitionEnvelopeV3(input);
  assert.deepEqual(result.featureContext.motiveCandidates, [{ motiveId: 'persisted_motive' }]);
});

test('v3 PROACTIVE_CHAT with no persisted authority never accepts caller motive candidates', () => {
  const input = oversizedInput('PROACTIVE_CHAT');
  input.envelope.protocolVersion = 3;
  input.motiveCandidates = [{ motiveId: 'caller_must_not_win' }];
  input.proactiveMotiveAuthority = { candidates: [{ motiveId: 'caller_authority' }] };
  input.turn = {
    protocolVersion: 3,
    rolloutKey: 'PROACTIVE_CHAT',
    annotationSnapshot: {}
  };
  const result = buildCognitionEnvelopeV3(input);
  assert.deepEqual(result.featureContext.motiveCandidates, []);
});

test('the history budget drops whole old groups and never cuts the boundary batch', () => {
  const input = oversizedInput('DIRECT_REPLY');
  const result = buildCognitionEnvelopeV3(input);

  assert.equal(result.relevantHistory.some((item) => item.turnId === 'history_turn_0'), false);
  assert.equal(result.relevantHistory.some((item) => item.turnId === 'history_turn_1'), false);
  assert.equal(result.relevantHistory.some((item) => item.turnId === 'history_turn_2'), true);
});

test('unknown TurnKinds fail closed instead of receiving a generic action surface', () => {
  assert.throws(() => adapterForTurnKind('UNKNOWN_KIND'), /unsupported cognition-v3 TurnKind/);
});

test('v3 formal cognition request and expression request receive separate relationship views', async () => {
  const relationship = {
    base: { id: 'familiar', label: '熟悉', content: '还没到阶段，不允许靠近' },
    phase: { id: 'normal', label: '正常', content: '阶段门槛词不应泄漏' },
    formalFacts: [{ factId: 'rf_1', value: 'mutual_contact' }],
    allowedFormalTransitions: { familiar: ['close'] },
    stagePersonaRevision: 9,
    effectiveStagePersona: '温和直接的编辑语气事实',
    stagePersona: {
      toneTendencies: ['温和', '直接'],
      forbiddenMoves: ['never_leak']
    },
    forbiddenMoves: ['never_leak'],
    stageThresholds: { close: 0.9 }
  };
  const envelope = {
    schemaVersion: 3,
    turnId: 'relationship_view_turn',
    characterId: 'yuqi',
    kind: 'DIRECT_REPLY',
    protocolVersion: 3,
    trigger: { triggerType: 'user_message', context: {} }
  };
  const calls = [];
  const client = {
    async runRole(role, payload) {
      calls.push({ role, payload });
      if (role === 'cognition_fast') {
        return {
          routeDecision: 'fast',
          cognitionResult: {
            interactionRead: {
              surfaceAct: 'statement', primarySocialMeaning: 'continue',
              alternativeMeaning: null, confidence: 0.9, evidenceMessageIds: []
            },
            selfResponse: {
              immediateFeeling: 'calm', desire: 'continue', resistance: '',
              attention: 'message', stanceTransitions: []
            },
            interactionDecision: {
              intendedResponse: 'send', relationshipEffect: 'continue',
              shouldAcknowledgeBid: false, intentionalNonResponseReason: null,
              mustConvey: [], mustNotClaim: []
            },
            actionIntent: {
              payment: null, moment: null, rolePlan: null,
              lifeAdjustment: null, relationshipReview: null
            },
            statePatch: { mood: 'calm', currentStances: [], openThreads: [] }
          }
        };
      }
      if (role === 'expression_v3') {
        return {
          action: 'send', reply: '我听到了。', usedFactIds: [],
          bubblePlan: [{ text: '我听到了。', purpose: 'continue' }], incompatibility: null
        };
      }
      throw new Error(`unexpected role ${role}`);
    }
  };
  await runCognitionV3Turn({
    turn: { turnId: 'relationship_view_turn', characterId: 'yuqi', protocolVersion: 3, rolloutKey: 'DIRECT_REPLY' },
    envelope,
    contextLoader: {
      load: async () => ({
        envelope,
        relationship,
        relationshipExpression: {
          formalFacts: relationship.formalFacts,
          toneTendencies: [
            ...relationship.stagePersona.toneTendencies,
            relationship.effectiveStagePersona
          ]
        },
        currentBatch: { messages: [{ messageId: 'u1', type: 'text', text: '你好', sentAt: 1 }] },
        relevantHistory: [],
        verifiedFacts: [],
        constraints: [], preferences: [], stances: [], lifeSignals: [],
        socialExperience: [], openThreads: [], authorSettings: {}
      })
    },
    client,
    store: { getTurnCheckpoint: () => ({}) },
    presetBundles: { cognition: 'cognition', expression: 'expression' },
    now: () => 100,
    review: () => ({ approved: true, findings: [] })
  });

  const cognitionPayload = calls.find(call => call.role === 'cognition_fast').payload;
  const expressionPayload = calls.find(call => call.role === 'expression_v3').payload;
  const formal = cognitionPayload.cognitionEnvelope.relationshipBasePhase;
  assert.deepEqual(Object.keys(formal).sort(), [
    'allowedFormalTransitions', 'base', 'formalFacts', 'phase', 'stagePersonaRevision'
  ]);
  assert.equal(JSON.stringify(cognitionPayload).includes('还没到阶段'), false);
  assert.equal(JSON.stringify(cognitionPayload).includes('never_leak'), false);
  assert.deepEqual(expressionPayload.expressionBrief.relationship, {
    formalFacts: relationship.formalFacts,
    toneTendencies: [
      ...relationship.stagePersona.toneTendencies,
      relationship.effectiveStagePersona
    ]
  });
});
