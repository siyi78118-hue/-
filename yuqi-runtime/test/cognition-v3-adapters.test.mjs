import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adapterForTurnKind,
  buildCognitionEnvelopeV3
} from '../src/cognition-v3-adapters.mjs';

const TURN_CASES = [
  ['DIRECT_REPLY', ['currentBatch', 'payment', 'attachments', 'quote']],
  ['PROACTIVE_CHAT', ['motiveCandidates', 'openThreads', 'dueCommitments']],
  ['PROACTIVE_MOMENT', ['committedLifeEvents', 'publicPrivacy']],
  ['MOMENT_INTERACTION', ['targetMoment', 'targetComment', 'thread']],
  ['MOMENT_REPLY', ['targetMoment', 'targetComment', 'thread']],
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

    assert.deepEqual(Object.keys(result.featureContext).sort(), [...featureKeys].sort());
    assert.equal(result.currentInteraction.messages.length, input.currentBatch.messages.length);
    assert.ok(result.relevantHistory.length <= 22);
    assert.equal(new Set(result.relevantHistory.map((item) => item.turnId)).size, 20);
    assert.ok(result.verifiedFacts.length <= 8);
    assert.ok(result.hardConstraints.length <= 5);
    assert.ok(result.currentStances.length <= 2);
    assert.ok(result.preferences.length <= 4);
    assert.ok(result.socialExperience.length <= 3);
    assert.ok(result.openThreads.length <= 3);
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
