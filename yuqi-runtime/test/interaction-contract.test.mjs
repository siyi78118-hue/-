import assert from 'node:assert/strict';
import test from 'node:test';

import { compileInteractionContract } from '../src/interaction-contract.mjs';

function message(messageId, speakerId, content, sentAt) {
  return {
    messageId,
    turnId: `turn_${messageId}`,
    characterId: 'yuqi',
    speakerId,
    speakerType: speakerId === 'user' ? 'user' : 'character',
    recipientId: speakerId === 'user' ? 'yuqi' : 'user',
    content,
    sentAt,
    origin: 'codex'
  };
}

function conflictHistory() {
  return [
    message('u_pause', 'user', '那没有什么好说的了，等你愿意稍作退让我们再谈', 1_000),
    message('y_daily_1', 'yuqi', '我去改稿了', 2_000),
    message('y_daily_2', 'yuqi', '下班了，饭做咸了', 3_000),
    message('u_now', 'user', '你干嘛？', 4_000)
  ];
}

function conflictScene() {
  return {
    relationshipStage: {
      id: 'familiar',
      phase: { id: 'conflict', label: '闹矛盾期' }
    }
  };
}

function frame(overrides = {}) {
  return {
    surfaceAct: '简短追问',
    intentHypotheses: [],
    interactionMode: 'conflict_follow_up',
    emotionalTone: '质疑',
    relationshipMove: '要求正视未解决矛盾',
    initiative: {
      topicIntroducedBy: 'user',
      suggestedNextCarrier: 'user',
      reason: '用户明确表示等条件变化后再谈'
    },
    priorTopic: {
      status: 'open',
      summary: '双方争执仍未解决',
      waitingOn: 'user',
      evidenceMessageIds: ['u_pause'],
      reason: '用户要求暂停并等待虞栖作出改变'
    },
    interruption: { requiresReaction: true, reactionReason: '用户在质疑当前互动' },
    activeHooks: [],
    ambiguities: [],
    responseRisks: [],
    needsNuanceReview: true,
    explicitBoundaries: [],
    recentCorrection: {
      active: false,
      rejectedInterpretation: '',
      expiresAfterBatches: 0,
      evidenceMessageIds: []
    },
    ...overrides
  };
}

function directEnvelope(content = '你干嘛？') {
  return {
    turnId: 'turn_direct',
    characterId: 'yuqi',
    kind: 'CHAT',
    message: {
      messageId: 'u_now',
      speakerId: 'user',
      speakerType: 'user',
      content,
      sentAt: 4_000
    }
  };
}

function proactiveEnvelope() {
  return {
    turnId: 'turn_proactive',
    characterId: 'yuqi',
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: 'trigger_proactive',
      triggerType: 'proactive_chat',
      scheduledFor: 5_000,
      executedAt: 5_000
    }
  };
}

test('compiles an evidence-backed compact contract and preserves plausible ambiguity', () => {
  const history = conflictHistory();
  const result = compileInteractionContract({
    envelope: directEnvelope(),
    scene: conflictScene(),
    interactionState: { unansweredOutgoingCount: 0, waitingForUserReply: false },
    recentMessages: history,
    conversationFrame: frame({
      intentHypotheses: [
        {
          intent: '询问虞栖此刻在做什么',
          confidence: 0.70,
          evidenceMessageIds: ['u_now', 'invented_message']
        },
        {
          intent: '质问虞栖为何无视未解决争执继续闲聊',
          confidence: 0.42,
          evidenceMessageIds: ['u_pause', 'u_now']
        }
      ],
      ambiguities: ['字面询问与互动质问同时可能']
    })
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.shouldRespond, true);
  assert.equal(result.primaryIntent, '询问虞栖此刻在做什么');
  assert.equal(result.alternativeIntent, '质问虞栖为何无视未解决争执继续闲聊');
  assert.equal(result.preserveAmbiguity, true);
  assert.equal(result.activeIssue, '双方争执仍未解决');
  assert.equal(result.initiativeOwner, 'user');
  assert.ok(result.mustAddress.includes('回应仍然开放的争执或其造成的互动张力'));
  assert.ok(result.evidenceMessageIds.includes('u_pause'));
  assert.ok(result.evidenceMessageIds.includes('u_now'));
  assert.equal(result.evidenceMessageIds.includes('invented_message'), false);
  assert.equal(Object.isFrozen(result), true);
});

test('an unresolved conflict waiting on the user creates structural silence before proactive generation', () => {
  const result = compileInteractionContract({
    envelope: proactiveEnvelope(),
    scene: conflictScene(),
    interactionState: { unansweredOutgoingCount: 2, waitingForUserReply: true },
    recentMessages: conflictHistory().slice(0, 3),
    conversationFrame: frame()
  });

  assert.equal(result.shouldRespond, false);
  assert.equal(result.structuralSilenceReason, 'open_conflict_waiting_for_user');
  assert.equal(result.initiativeOwner, 'user');
});

test('ordinary proactive contact remains eligible when no open issue is waiting on the user', () => {
  const result = compileInteractionContract({
    envelope: proactiveEnvelope(),
    scene: {
      relationshipStage: {
        id: 'familiar',
        phase: { id: 'normal', label: '正常相处' }
      }
    },
    interactionState: { unansweredOutgoingCount: 1, waitingForUserReply: true },
    recentMessages: conflictHistory().slice(1, 3),
    conversationFrame: frame({
      interactionMode: 'ordinary_pause',
      initiative: {
        topicIntroducedBy: 'either',
        suggestedNextCarrier: 'either',
        reason: '没有未解决请求'
      },
      priorTopic: {
        status: 'closed',
        summary: '上一话题已经自然结束',
        waitingOn: 'none',
        evidenceMessageIds: ['y_daily_2'],
        reason: '没有开放问题'
      }
    })
  });

  assert.equal(result.shouldRespond, true);
  assert.equal(result.structuralSilenceReason, '');
});

test('keeps an explicit correction temporary and forbids the rejected interpretation', () => {
  const history = [
    ...conflictHistory(),
    message('u_correction', 'user', '我们还在吵架吧，你在干嘛？', 5_000)
  ];
  const rejectedInterpretation = '用户只是在询问虞栖此刻做什么';
  const result = compileInteractionContract({
    envelope: {
      ...directEnvelope('我们还在吵架吧，你在干嘛？'),
      message: {
        ...directEnvelope().message,
        messageId: 'u_correction',
        content: '我们还在吵架吧，你在干嘛？',
        sentAt: 5_000
      }
    },
    scene: conflictScene(),
    interactionState: { unansweredOutgoingCount: 0, waitingForUserReply: false },
    recentMessages: history,
    conversationFrame: frame({
      intentHypotheses: [{
        intent: '明确纠正此前把质问误读为日常询问',
        confidence: 0.96,
        evidenceMessageIds: ['u_correction']
      }],
      recentCorrection: {
        active: true,
        rejectedInterpretation,
        expiresAfterBatches: 2,
        evidenceMessageIds: ['u_correction', 'missing']
      }
    })
  });

  assert.deepEqual(result.recentCorrection, {
    active: true,
    rejectedInterpretation,
    expiresAfterBatches: 2,
    evidenceMessageIds: ['u_correction']
  });
  assert.ok(result.forbiddenMoves.includes(rejectedInterpretation));
});
