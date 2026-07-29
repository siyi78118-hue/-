import assert from 'node:assert/strict';
import test from 'node:test';

import { CognitivePipeline } from '../src/cognitive-pipeline.mjs';

function cognition(requiresDeepCognition = false) {
  return {
    schemaVersion: 2,
    query: '继续聊天',
    keywords: ['继续'],
    requiresDeepCognition,
    escalationReasons: requiresDeepCognition ? ['需要结合完整语境'] : [],
    relationshipStageReview: { base: null, phase: null },
    conversationFrame: {
      surfaceAct: '继续聊天',
      intentHypotheses: [{
        intent: '希望继续对话',
        confidence: 0.8,
        evidenceMessageIds: ['msg_1']
      }],
      interactionMode: 'light_conversation',
      emotionalTone: '轻松',
      relationshipMove: '维持',
      initiative: {
        topicIntroducedBy: 'user',
        suggestedNextCarrier: 'yuqi',
        reason: '用户刚回应'
      },
      priorTopic: {
        status: 'open',
        summary: '正在聊天',
        waitingOn: 'yuqi',
        evidenceMessageIds: ['msg_1'],
        reason: '需要回应'
      },
      interruption: { requiresReaction: false, reactionReason: '' },
      activeHooks: [],
      ambiguities: [],
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
      mood: '轻松',
      moodCause: '聊天自然',
      bodyState: '正常',
      attention: '聊天',
      stanceTowardUser: '愿意继续',
      ownNeed: '自然表达',
      continuity: '延续当前状态',
      intensity: 0.4
    },
    decision: {
      shouldRespond: true,
      silenceReason: '',
      relationshipGoal: '自然继续',
      primaryAction: 'reply',
      initiativeOwner: 'yuqi',
      mustAddress: ['当前消息'],
      forbiddenMoves: [],
      preserveAmbiguity: false,
      evidenceMessageIds: ['msg_1']
    },
    actionIntent: {
      channel: 'chat',
      paymentAction: null,
      momentIntent: null,
      rolePlanOperationsJson: '[]',
      lifePlan: null,
      lifeAdjustment: null
    }
  };
}

function expression(reply = '那就继续聊。') {
  return { action: 'send', reply, usedFactIds: [], rewriteResolution: null };
}

function fixture(responses, overrides = {}) {
  const calls = [];
  const turn = {
    turnId: 'turn_1',
    characterId: 'yuqi',
    state: 'queued',
    route: 'fast',
    pipelineMode: 'active',
    presetVersion: '2.0.0',
    annotationSnapshot: {}
  };
  const store = {
    getTurn: () => turn,
    getCognitiveState: () => null,
    advanceTurn(turnId, from, to, patch = {}) {
      assert.equal(turnId, turn.turnId);
      assert.equal(turn.state, from);
      turn.state = to;
      Object.assign(turn, patch);
      return turn;
    }
  };
  const codexClient = {
    async runTurn(role, input, options) {
      calls.push({ role, input: JSON.parse(input), options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { text: typeof next === 'string' ? next : JSON.stringify(next) };
    }
  };
  const pipeline = new CognitivePipeline({
    store,
    codexClient,
    presetRegistry: {
      resolvePresetBundle: ({ role, version }) => `${role}:${version}`
    },
    contextBuilder: async input => ({
      currentBatch: input.currentBatch,
      recentMessages: [],
      payment: null,
      trigger: null
    }),
    ...overrides
  });
  return { pipeline, store, turn, calls };
}

const envelope = {
  kind: 'DIRECT_REPLY',
  characterId: 'yuqi',
  turnId: 'turn_1'
};
const currentBatch = {
  batchId: 'batch_1',
  messageIds: ['msg_1'],
  messages: [{ messageId: 'msg_1', content: '继续吧' }]
};

test('fast cognition escalates once without rebuilding or truncating the current batch', async () => {
  const { pipeline, calls } = fixture([
    cognition(true),
    cognition(false),
    expression()
  ]);
  const result = await pipeline.runForeground({
    turn: { turnId: 'turn_1' },
    envelope,
    scene: {},
    currentBatch,
    routeDecision: { route: 'fast' }
  });
  assert.equal(result.draft.reply, '那就继续聊。');
  assert.deepEqual(calls.map(call => call.options.model), [
    'gpt-5.6-terra',
    'gpt-5.6-sol',
    'gpt-5.6-sol'
  ]);
  assert.deepEqual(
    calls[0].input.context.currentBatch,
    calls[1].input.context.currentBatch
  );
});

test('expression retry resumes from the persisted cognition checkpoint', async () => {
  const first = fixture([
    cognition(false),
    new Error('expression provider failed')
  ]);
  await assert.rejects(() => first.pipeline.runForeground({
    turn: { turnId: 'turn_1' },
    envelope,
    scene: {},
    currentBatch,
    routeDecision: { route: 'fast' }
  }), /provider failed/);
  assert.match(first.turn.memoryPacketJson, /cognition-v2/);

  const secondCalls = [];
  first.pipeline.codexClient.runTurn = async (role, input, options) => {
    secondCalls.push({ role, input, options });
    return { text: JSON.stringify(expression('从断点继续。')) };
  };
  const result = await first.pipeline.runForeground({
    turn: { turnId: 'turn_1' },
    envelope,
    scene: {},
    currentBatch,
    routeDecision: { route: 'fast' }
  });
  assert.equal(result.draft.reply, '从断点继续。');
  assert.deepEqual(secondCalls.map(call => call.role), ['brain']);
});

test('a direct cognition result can never materialize a skipped reply', async () => {
  const invalid = cognition(false);
  invalid.decision.shouldRespond = false;
  invalid.decision.silenceReason = '不回';
  const { pipeline } = fixture([invalid]);
  await assert.rejects(() => pipeline.runForeground({
    turn: { turnId: 'turn_1' },
    envelope,
    scene: {},
    currentBatch,
    routeDecision: { route: 'fast' }
  }), /DIRECT_REPLY/);
});
