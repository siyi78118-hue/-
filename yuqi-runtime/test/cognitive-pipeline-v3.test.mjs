import assert from 'node:assert/strict';
import test from 'node:test';

import { runCognitionV3Turn } from '../src/cognitive-pipeline.mjs';

function cognitionResult(overrides = {}) {
  return {
    interactionRead: {
      surfaceAct: 'playful statement',
      primarySocialMeaning: 'playful reassurance bid',
      alternativeMeaning: null,
      confidence: 0.86,
      evidenceMessageIds: ['u1']
    },
    selfResponse: {
      immediateFeeling: 'amused',
      desire: 'stay in the exchange',
      resistance: '',
      attention: 'the playful bid',
      stanceTransitions: []
    },
    interactionDecision: {
      intendedResponse: 'send',
      relationshipEffect: 'meet the bid without overexplaining it',
      shouldAcknowledgeBid: true,
      intentionalNonResponseReason: null,
      mustConvey: ['she caught the playful bid'],
      mustNotClaim: []
    },
    actionIntent: {
      payment: null,
      moment: null,
      rolePlan: null,
      lifeAdjustment: null,
      relationshipReview: null
    },
    statePatch: {
      mood: 'amused',
      currentStances: [],
      openThreads: ['playful_exchange']
    },
    ...overrides
  };
}

function expressionResult() {
  return {
    action: 'send',
    reply: '行，这次算你多说了两个字。',
    usedFactIds: [],
    bubblePlan: [{
      text: '行，这次算你多说了两个字。',
      purpose: 'continue the playful exchange'
    }],
    incompatibility: null
  };
}

function envelope() {
  return {
    schemaVersion: 3,
    turnId: 'turn_v3',
    characterId: 'yuqi',
    turnKind: 'DIRECT_REPLY',
    currentInteraction: {
      batchId: 'batch_1',
      messages: [{ messageId: 'u1', type: 'text', text: '废话废话' }]
    },
    relevantHistory: [],
    verifiedFacts: [],
    hardConstraints: [],
    preferences: [],
    currentStances: [],
    relationshipBasePhase: {
      base: 'familiar',
      phase: 'normal',
      formalFacts: [],
      toneTendencies: ['熟悉']
    },
    lifeSignals: [],
    authorSettings: {},
    allowedActions: ['send'],
    featureContext: {
      currentBatch: { batchId: 'batch_1' },
      payment: null,
      attachments: [],
      quote: null
    },
    socialExperience: [],
    openThreads: []
  };
}

class FakeStore {
  constructor() {
    this.checkpoints = new Map();
  }

  getTurnCheckpoint(turnId) {
    return this.checkpoints.get(turnId) || {};
  }

  saveCognitionCheckpointInternal(turnId, packet) {
    this.checkpoints.set(turnId, {
      ...(this.checkpoints.get(turnId) || {}),
      cognitionEnvelope: packet.envelope,
      cognitionPacket: packet
    });
  }
}

class FakeClient {
  constructor(...responses) {
    this.responses = responses;
    this.calls = [];
  }

  async runRole(role, payload, options) {
    this.calls.push({ role, payload, options });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
}

function input(overrides = {}) {
  return {
    turn: {
      turnId: 'turn_v3',
      characterId: 'yuqi',
      authoritativeReleaseId: 'release_v3'
    },
    store: new FakeStore(),
    client: new FakeClient(cognitionResult(), expressionResult()),
    cognitionEnvelope: envelope(),
    presetBundles: {
      cognition: 'cognition v3',
      expression: 'expression v3'
    },
    queueShadow() {},
    now: () => Date.now(),
    ...overrides
  };
}

test('fast cognition can escalate before expression with fixed role budgets', async () => {
  const client = new FakeClient(
    { routeDecision: 'deep', cognitionResult: cognitionResult() },
    cognitionResult({
      interactionRead: {
        ...cognitionResult().interactionRead,
        primarySocialMeaning: 'repair bid'
      }
    }),
    expressionResult()
  );
  const result = await runCognitionV3Turn(input({ client }));

  assert.deepEqual(client.calls.map((call) => call.role), [
    'cognition_fast',
    'cognition_deep',
    'expression_v3'
  ]);
  assert.deepEqual(client.calls.map((call) => call.options.deadlineMs), [
    45_000,
    120_000,
    60_000
  ]);
  assert.deepEqual(
    client.calls[0].options.outputSchema.properties.routeDecision.enum,
    ['fast', 'deep']
  );
  assert.equal(result.draft.rewriteMetadata.source, 'cognition-v3');
});

test('retry reuses the committed cognition checkpoint after expression failure', async () => {
  const store = new FakeStore();
  const client = new FakeClient(
    cognitionResult(),
    new Error('expression temporarily failed'),
    expressionResult()
  );
  await assert.rejects(
    runCognitionV3Turn(input({ store, client })),
    /expression temporarily failed/
  );
  const result = await runCognitionV3Turn(input({ store, client }));

  assert.equal(client.calls.filter((call) => call.role.startsWith('cognition_')).length, 1);
  assert.equal(client.calls.filter((call) => call.role === 'expression_v3').length, 2);
  assert.equal(result.cognitionPacket.packetChecksum,
    store.getTurnCheckpoint('turn_v3').cognitionPacket.packetChecksum);
});

test('shadow comparison is queued and never awaited by visible completion', async () => {
  let shadowQueued = 0;
  const never = new Promise(() => {});
  const startedAt = Date.now();
  const result = await runCognitionV3Turn(input({
    queueShadow() {
      shadowQueued += 1;
      return never;
    }
  }));

  assert.equal(shadowQueued, 1);
  assert.equal(result.shadowState, 'queued');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(result.timings.visibleCompletedAt >= result.timings.startedAt);
});

test('a five-minute outer deadline leaves a recoverable checkpoint', async () => {
  let timeout;
  const client = {
    async runRole(role, payload, options) {
      timeout = options.outerDeadlineMs;
      throw Object.assign(new Error('Codex turn timed out'), { status: 'timeout' });
    }
  };
  await assert.rejects(
    runCognitionV3Turn(input({ client, outerDeadlineMs: 300_000 })),
    /timed out/
  );
  assert.equal(timeout, 300_000);
});
