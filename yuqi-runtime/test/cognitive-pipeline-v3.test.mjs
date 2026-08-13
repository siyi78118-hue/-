import assert from 'node:assert/strict';
import test from 'node:test';

import { CognitivePipeline, runCognitionV3Turn } from '../src/cognitive-pipeline.mjs';

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

  listMessages() { return []; }
  listFacts() { return []; }
  getMessage() { return null; }
  getMessageContext() { return []; }
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

function v3Release(overrides = {}) {
  return {
    releaseId: 'release_v3',
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: '2.1.0',
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3,
    ...overrides
  };
}

function proactiveEnvelope(motiveCandidates) {
  return {
    ...envelope(),
    turnKind: 'PROACTIVE_CHAT',
    featureContext: {
      motiveCandidates,
      openThreads: [],
      dueCommitments: []
    },
    allowedActions: ['send', 'skip']
  };
}

function proactiveTransportEnvelope() {
  return {
    protocolVersion: 3,
    turnId: 'turn_v3_proactive',
    characterId: 'yuqi',
    kind: 'PROACTIVE_CHAT',
    trigger: { triggerId: 'trigger_v3_proactive', triggerType: 'proactive_chat', executedAt: 100 }
  };
}

function proactiveCognitionResult(motiveEvidenceIds) {
  return cognitionResult({
    interactionDecision: {
      ...cognitionResult().interactionDecision,
      motiveEvidenceIds
    }
  });
}

const expectedDisclosurePolicy = Object.freeze({
  version: 1,
  defaultMode: 'implicit',
  understandingUse: 'guide_response_not_dialogue',
  mustConveyUse: 'public_interaction_obligations',
  unaskedInterpretationLimit: 0,
  explicitExceptions: [
    'user_requested_interpretation',
    'repair_requires_clarification',
    'safety_or_consent'
  ]
});

test('moment reply accepts visible comment evidence and rejects a foreign comment id', async () => {
  const commentId = 'comment_visible';
  const momentEnvelope = {
    ...envelope(),
    turnKind: 'MOMENT_REPLY',
    currentInteraction: { batchId: 'batch_moment', messages: [] },
    featureContext: {
      targetMoment: {
        momentId: 'moment_1',
        text: '出去买水。',
        comments: [{ commentId, text: '我也去。' }]
      },
      targetComment: { commentId, text: '我也去。' },
      thread: [{ commentId, text: '我也去。' }]
    },
    allowedActions: ['reply', 'skip']
  };
  const withEvidence = (evidenceId) => cognitionResult({
    interactionRead: {
      ...cognitionResult().interactionRead,
      evidenceMessageIds: [evidenceId]
    },
    interactionDecision: {
      ...cognitionResult().interactionDecision,
      motiveEvidenceIds: [evidenceId]
    },
    actionIntent: {
      ...cognitionResult().actionIntent,
      moment: {
        momentId: 'moment_1',
        like: false,
        comment: '接住这句。',
        replyToCommentId: commentId
      }
    }
  });

  const accepted = await runCognitionV3Turn(input({
    cognitionEnvelope: momentEnvelope,
    client: new FakeClient(withEvidence(commentId), expressionResult())
  }));
  assert.equal(accepted.draft.reply, expressionResult().reply);

  await assert.rejects(() => runCognitionV3Turn(input({
    cognitionEnvelope: momentEnvelope,
    client: new FakeClient(withEvidence('comment_foreign'), expressionResult())
  })), /unknown evidence messageId: comment_foreign/);
});

test('pinned 2.1.1 gives expression and supervision the same implicit-understanding policy', async () => {
  const client = new FakeClient(cognitionResult(), expressionResult());
  const reviewInputs = [];
  const result = await runCognitionV3Turn(input({
    turn: {
      turnId: 'turn_v3',
      characterId: 'yuqi',
      authoritativeReleaseId: 'release_v3',
      presetVersion: '2.1.1'
    },
    client,
    supervise(reviewInput) {
      reviewInputs.push(reviewInput);
      return { approved: true, findings: [] };
    }
  }));

  assert.equal(result.state, 'completed');
  const expressionCall = client.calls.find((call) => call.role === 'expression_v3');
  assert.deepEqual(expressionCall.payload.expressionBrief.disclosurePolicy, expectedDisclosurePolicy);
  assert.deepEqual(reviewInputs[0].disclosurePolicy, expectedDisclosurePolicy);
});

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

test('v3 dry-run calls cognition and expression without checkpoints or nested shadow work', async () => {
  const store = new FakeStore();
  store.saveCognitionCheckpointInternal = () => {
    throw new Error('dry-run attempted a checkpoint write');
  };
  let shadowQueued = 0;
  const client = new FakeClient(
    cognitionResult({
      interactionRead: { ...cognitionResult().interactionRead, evidenceMessageIds: [] }
    }),
    expressionResult()
  );
  const result = await runCognitionV3Turn(input({
    store,
    client,
    dryRun: true,
    queueShadow: () => { shadowQueued += 1; }
  }));
  assert.equal(result.draft.reply, '行，这次算你多说了两个字。');
  assert.equal(shadowQueued, 0);
  assert.equal(client.calls.length, 2);
});

test('v3 release draft compiles both non-empty bundles from the immutable release preset', async () => {
  const store = new FakeStore();
  store.getTurn = () => ({
    turnId: 'turn_v3',
    characterId: 'yuqi',
    pipelineMode: 'active',
    presetVersion: 'current-not-authoritative',
    annotationSnapshot: { annotations: [] }
  });
  store.saveCognitionCheckpointInternal = () => {
    throw new Error('release draft attempted a checkpoint write');
  };
  const presetCalls = [];
  const presetRegistry = {
    resolvePresetBundle({ role, version }) {
      presetCalls.push({ role, version });
      return `${role}:${version}`;
    }
  };
  const client = new FakeClient(cognitionResult(), expressionResult());
  const pipeline = new CognitivePipeline({ store, codexClient: client, presetRegistry });
  const draft = await pipeline.runV3ReleaseDraft({
    release: v3Release(),
    execution: {
      turn: { turnId: 'turn_v3', characterId: 'yuqi' },
      cognitionEnvelope: envelope(),
      presetBundles: { cognition: 'forged-current', expression: 'forged-current' }
    },
    dryRun: true,
    capabilities: {
      visibleCommit: false,
      action: false,
      state: false,
      fact: false,
      memory: false,
      outbox: false,
      notification: false
    }
  });

  assert.equal(draft.reply, '行，这次算你多说了两个字。');
  assert.deepEqual(presetCalls, [
    { role: 'cognition', version: '2.1.0' },
    { role: 'expression', version: '2.1.0' }
  ]);
  assert.deepEqual(client.calls.map(call => call.payload.system), [
    'cognition:2.1.0',
    'expression:2.1.0'
  ]);
});

test('v3 production draft validates pinned proactive motive evidence and inherited retry annotation', async () => {
  const pinned = [{ motiveId: 'motive_pinned' }];
  const client = new FakeClient(proactiveCognitionResult(['motive_pinned']), expressionResult());
  const store = new FakeStore();
  const pipeline = new CognitivePipeline({
    store,
    codexClient: client,
    presetRegistry: { resolvePresetBundle: () => 'pinned bundle' }
  });
  const result = await pipeline.runV3ReleaseDraft({
    release: v3Release(),
    execution: {
      turn: {
        turnId: 'turn_v3_retry',
        characterId: 'yuqi',
        authoritativeReleaseId: 'release_v3',
        retryOfTurnId: 'turn_v3_parent',
        annotationSnapshot: { proactiveMotiveAuthority: { candidates: pinned } }
      },
      envelope: proactiveTransportEnvelope(),
      currentBatch: { messages: [{ messageId: 'u1', type: 'text', text: 'hello', sentAt: 100 }] },
      scene: {},
      routeDecision: {},
      motiveCandidates: [{ motiveId: 'caller_must_not_win' }],
      client
    },
    dryRun: true
  });
  assert.equal(result.reply, '行，这次算你多说了两个字。');
  assert.deepEqual(client.calls[0].payload.cognitionEnvelope.featureContext.motiveCandidates, pinned);
});

test('v3 production draft rejects a motive id outside the persisted pinned authority', async () => {
  const pinned = [{ motiveId: 'motive_pinned' }];
  const client = new FakeClient(proactiveCognitionResult(['motive_forged']), expressionResult());
  const pipeline = new CognitivePipeline({
    store: new FakeStore(),
    codexClient: client,
    presetRegistry: { resolvePresetBundle: () => 'pinned bundle' }
  });
  await assert.rejects(
    pipeline.runV3ReleaseDraft({
      release: v3Release(),
      execution: {
        turn: {
          turnId: 'turn_v3_forged',
          characterId: 'yuqi',
          authoritativeReleaseId: 'release_v3',
          annotationSnapshot: { proactiveMotiveAuthority: { candidates: pinned } }
        },
        envelope: proactiveTransportEnvelope(),
        currentBatch: { messages: [{ messageId: 'u1', type: 'text', text: 'hello', sentAt: 100 }] },
        scene: {},
        routeDecision: {},
        motiveCandidates: [{ motiveId: 'caller_must_not_win' }],
        client
      },
      dryRun: true
    }),
    /motiveEvidenceIds must cite one to three pinned motives/
  );
});

test('v3 public role-plan release path strips raw scene and trigger context at both model calls', async () => {
  const store = new FakeStore();
  for (const name of ['listMessages', 'listFacts', 'listActiveConstraints', 'listActiveStances']) {
    store[name] = () => { throw new Error(`private reader ${name} must not run`); };
  }
  const client = new FakeClient(
    cognitionResult({
      interactionRead: { ...cognitionResult().interactionRead, evidenceMessageIds: [] }
    }),
    expressionResult()
  );
  const pipeline = new CognitivePipeline({
    store,
    codexClient: client,
    presetRegistry: { resolvePresetBundle: ({ role }) => `${role}:pinned` }
  });
  const rawEnvelope = {
    ...envelope(),
    turnKind: 'ROLE_PLAN_MOMENT_PRIVATE',
    kind: 'ROLE_PLAN_MOMENT_PRIVATE',
    trigger: {
      ...envelope().trigger,
      context: {
        input: { secret: 'PRIVATE_TRIGGER_INPUT' },
        snapshot: { secret: 'PRIVATE_TRIGGER_SNAPSHOT' },
        scene: { secret: 'PRIVATE_TRIGGER_SCENE' }
      }
    }
  };
  await pipeline.runV3ReleaseDraft({
    release: v3Release(),
    execution: {
      turn: {
        turnId: 'turn_public_role_plan_pipeline',
        characterId: 'yuqi',
        protocolVersion: 3,
        rolloutKey: 'ROLE_PLAN_MOMENT_PRIVATE',
        annotationSnapshot: {}
      },
      envelope: rawEnvelope,
      currentBatch: { messages: [{ messageId: 'u1', type: 'text', text: 'hello', sentAt: 100 }] },
      scene: { secret: 'PRIVATE_EXECUTION_SCENE' },
      client
    },
    dryRun: true
  });
  assert.equal(client.calls.length, 2);
  for (const call of client.calls) {
    assert.equal(JSON.stringify(call.payload).includes('PRIVATE_'), false);
  }
  assert.deepEqual(client.calls[0].payload.cognitionEnvelope.featureContext, {
    rolePlan: null,
    occurrence: null,
    publicPrivacy: {
      version: 'public-boundary-v1',
      visibility: 'public',
      recipientId: 'public_moments',
      allowPrivateChatContext: false,
      allowPaymentContext: false,
      allowRelationshipContext: false,
      allowPrivateMemoryContext: false
    }
  });
  assert.equal(JSON.stringify(client.calls[1].payload.expressionBrief).includes('PRIVATE_'), false);
});

test('release draft rejects write capabilities during dry-run before calling a model', async () => {
  const client = new FakeClient(cognitionResult(), expressionResult());
  const pipeline = new CognitivePipeline({
    store: new FakeStore(),
    codexClient: client,
    presetRegistry: { resolvePresetBundle: ({ role }) => `${role}:pinned` }
  });
  await assert.rejects(() => pipeline.runV3ReleaseDraft({
    release: v3Release(),
    execution: {
      turn: { turnId: 'turn_v3', characterId: 'yuqi' },
      cognitionEnvelope: envelope()
    },
    dryRun: true,
    capabilities: { visibleCommit: true }
  }), /dry-run release capabilities conflict/);
  assert.equal(client.calls.length, 0);
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

test('cognition and expression each repair at most once before one final review', async () => {
  const repairedCognition = cognitionResult({
    interactionRead: {
      ...cognitionResult().interactionRead,
      primarySocialMeaning: 'reconsidered social bid'
    }
  });
  const client = new FakeClient(
    cognitionResult(),
    expressionResult(),
    repairedCognition,
    expressionResult()
  );
  let reviews = 0;
  const result = await runCognitionV3Turn(input({
    client,
    highRisk: true,
    async supervise() {
      reviews += 1;
      return {
        approved: false,
        findings: [
          {
            code: 'SOCIAL_BID_DROPPED',
            owner: 'cognition',
            evidenceMessageIds: ['u1'],
            violatedRequirement: 'bid not carried into the decision',
            mustPreserve: ['authorized action targets'],
            mustChange: ['the participation decision'],
            acceptanceCriteria: ['decision knowingly answers the bid']
          },
          {
            code: 'DIALOGUE_META_NARRATION',
            owner: 'expression',
            evidenceMessageIds: ['u1'],
            violatedRequirement: 'reply narrates the interaction',
            mustPreserve: ['reconsidered decision'],
            mustChange: ['visible wording'],
            acceptanceCriteria: ['reply participates without analysis']
          }
        ]
      };
    },
    async finalSupervise() {
      reviews += 1;
      return {
        approved: false,
        findings: [{
          code: 'CHARACTER_STATE_BREAK',
          owner: 'expression',
          evidenceMessageIds: ['u1'],
          violatedRequirement: 'still inconsistent',
          mustPreserve: ['authorized actions'],
          mustChange: ['state continuity'],
          acceptanceCriteria: ['continuity restored']
        }]
      };
    }
  }));

  assert.deepEqual(result.attempts, {
    cognitionReconsideration: 1,
    expressionRewrite: 1,
    finalReview: 1
  });
  assert.equal(result.state, 'supervision_failed');
  assert.equal(reviews, 2);
  assert.deepEqual(client.calls.map((call) => call.role), [
    'cognition_fast',
    'expression_v3',
    'cognition_deep',
    'expression_v3'
  ]);
});

test('action-owned supervision failure never asks a model to repair authority', async () => {
  const client = new FakeClient(cognitionResult(), expressionResult());
  const result = await runCognitionV3Turn(input({
    client,
    highRisk: true,
    async supervise() {
      return {
        approved: false,
        findings: [{
          code: 'CHARACTER_STATE_BREAK',
          owner: 'action',
          evidenceMessageIds: ['u1'],
          violatedRequirement: 'target changed',
          mustPreserve: ['visible intent'],
          mustChange: ['action target'],
          acceptanceCriteria: ['authoritative target restored']
        }]
      };
    }
  }));

  assert.equal(result.state, 'supervision_failed');
  assert.equal(result.attempts.cognitionReconsideration, 0);
  assert.equal(result.attempts.expressionRewrite, 0);
  assert.equal(client.calls.length, 2);
});

test('relationship expression view survives checkpoint JSON roundtrip and rewrite without entering cognition envelope', async () => {
  class JsonRoundTripStore extends FakeStore {
    saveCognitionCheckpointInternal(turnId, packet) {
      const checkpoint = {
        ...(this.checkpoints.get(turnId) || {}),
        cognitionEnvelope: packet.envelope,
        cognitionPacket: packet
      };
      this.checkpoints.set(turnId, JSON.parse(JSON.stringify(checkpoint)));
    }
  }

  const store = new JsonRoundTripStore();
  const relationshipExpression = {
    formalFacts: [{ factId: 'mutual_contact' }],
    toneTendencies: ['温和直接的语气']
  };
  const formalEnvelope = {
    ...envelope(),
    relationshipBasePhase: {
      base: { id: 'familiar' },
      phase: { id: 'normal' },
      formalFacts: relationshipExpression.formalFacts,
      allowedFormalTransitions: { familiar: ['close'] },
      stagePersonaRevision: 9
    }
  };
  const firstCalls = [];
  let reviewCount = 0;
  const firstClient = {
    async runRole(role, payload) {
      firstCalls.push({ role, payload });
      if (role === 'cognition_fast') {
        return { routeDecision: 'fast', cognitionResult: cognitionResult() };
      }
      if (role === 'expression_v3') return expressionResult();
      throw new Error(`unexpected role ${role}`);
    }
  };
  const reviewInputs = [];
  const first = await runCognitionV3Turn(input({
    store,
    client: firstClient,
    cognitionEnvelope: formalEnvelope,
    relationshipExpression,
    supervise(reviewInput) {
      reviewInputs.push(reviewInput);
      reviewCount += 1;
      return reviewCount === 1
        ? {
          approved: false,
          findings: [{
            owner: 'expression',
            code: 'DIALOGUE_META_NARRATION',
            evidenceMessageIds: ['u1'],
            violatedRequirement: 'visible wording',
            mustPreserve: ['tone'],
            mustChange: ['rewrite'],
            acceptanceCriteria: ['in-world wording']
          }]
        }
        : { approved: true, findings: [] };
    }
  }));

  assert.equal(first.state, 'completed');
  assert.equal(firstCalls.filter((call) => call.role === 'expression_v3').length, 2);
  assert.equal(firstCalls.filter((call) => call.role === 'expression_v3').every((call) =>
    call.payload.expressionBrief.relationship.toneTendencies.includes('温和直接的语气')), true);
  assert.equal(JSON.stringify(firstCalls.find((call) => call.role === 'cognition_fast').payload)
    .includes('温和直接的语气'), false);
  assert.deepEqual(reviewInputs[0].relationship, relationshipExpression);
  assert.deepEqual(Object.keys(reviewInputs[0].relationship).sort(), ['formalFacts', 'toneTendencies']);
  assert.equal(JSON.stringify(reviewInputs[0]).includes('allowedFormalTransitions'), false);
  assert.equal(JSON.stringify(reviewInputs[0]).includes('stagePersonaRevision'), false);
  assert.equal(JSON.stringify(reviewInputs[0]).includes('阶段门槛词'), false);

  const checkpoint = store.getTurnCheckpoint('turn_v3');
  assert.ok(checkpoint.cognitionPacket.relationshipExpression,
    'named expression checkpoint channel is required for restart');
  assert.equal(JSON.stringify(checkpoint.cognitionEnvelope).includes('温和直接的语气'), false);

  const restartCalls = [];
  await runCognitionV3Turn(input({
    store,
    cognitionEnvelope: undefined,
    relationshipExpression: undefined,
    client: {
      async runRole(role, payload) {
        restartCalls.push({ role, payload });
        if (role === 'expression_v3') return expressionResult();
        throw new Error(`restart must not call ${role}`);
      }
    },
    supervise: () => ({ approved: true, findings: [] })
  }));
  const restartedExpression = restartCalls.find((call) => call.role === 'expression_v3');
  assert.ok(restartedExpression);
  assert.deepEqual(restartedExpression.payload.expressionBrief.relationship, relationshipExpression);
});

test('cognition reconsideration receives no expression relationship side channel', async () => {
  const calls = [];
  let reviewCount = 0;
  const reviewInputs = [];
  const formalEnvelope = {
    ...envelope(),
    relationshipBasePhase: {
      base: { id: 'familiar' },
      phase: { id: 'normal' },
      formalFacts: [{ factId: 'mutual_contact' }],
      allowedFormalTransitions: { familiar: ['close'] },
      stagePersonaRevision: 9
    },
    allowedActions: ['send', 'relationshipReview']
  };
  const relationshipExpression = {
    formalFacts: [{ factId: 'mutual_contact' }],
    toneTendencies: ['只给表达式使用的语气']
  };
  const cognitionWithFormalRelationshipReview = cognitionResult({
    actionIntent: {
      ...cognitionResult().actionIntent,
      relationshipReview: {
        base: {
          current: 'familiar',
          recommended: 'close',
          confidence: 0.9,
          reason: 'formal evidence-backed review',
          evidenceMessageIds: ['u1'],
          explicitMutualChange: true
        },
        phase: null
      }
    }
  });
  const client = {
    async runRole(role, payload) {
      calls.push({ role, payload });
      if (role === 'cognition_fast') {
        return { routeDecision: 'deep', cognitionResult: cognitionWithFormalRelationshipReview };
      }
      if (role === 'cognition_deep') return cognitionWithFormalRelationshipReview;
      if (role === 'expression_v3') return expressionResult();
      throw new Error(`unexpected role ${role}`);
    }
  };
  const result = await runCognitionV3Turn(input({
    cognitionEnvelope: formalEnvelope,
    relationshipExpression,
    client,
    supervise(reviewInput) {
      reviewInputs.push(reviewInput);
      reviewCount += 1;
      return reviewCount === 1
        ? {
          approved: false,
          findings: [{
            owner: 'cognition',
            code: 'SOCIAL_BID_DROPPED',
            evidenceMessageIds: ['u1'],
            violatedRequirement: 'decision needs reconsideration',
            mustPreserve: ['authorized action'],
            mustChange: ['cognition reasoning'],
            acceptanceCriteria: ['decision remains grounded']
          }]
        }
        : { approved: true, findings: [] };
    }
  }));

  assert.equal(result.state, 'completed');
  const cognitionCalls = calls.filter((call) =>
    call.role === 'cognition_fast' || call.role === 'cognition_deep');
  assert.equal(cognitionCalls.length, 3);
  for (const call of cognitionCalls) {
    assert.equal(JSON.stringify(call.payload).includes('只给表达式使用的语气'), false);
    assert.equal(JSON.stringify(call.payload).includes('relationshipExpression'), false);
  }
  assert.equal(JSON.stringify(cognitionCalls.at(-1).payload).includes('formal evidence-backed review'), true);
  const expressionCalls = calls.filter((call) => call.role === 'expression_v3');
  assert.equal(expressionCalls.every((call) =>
    Object.hasOwn(call.payload.expressionBrief.authorizedActions, 'relationshipReview') === false), true);
  assert.equal(Object.hasOwn(
    reviewInputs[0].cognitionPacket.cognitionResult.actionIntent,
    'relationshipReview'
  ), false);
  assert.equal(Object.hasOwn(reviewInputs[0].draft.actionIntent, 'relationshipReview'), false);
});

test('v3 public moment turns force an empty expression relationship channel', async () => {
  const publicEnvelope = {
    ...envelope(),
    protocolVersion: 3,
    turnKind: 'MOMENT_INTERACTION',
    kind: 'MOMENT_INTERACTION'
  };
  const maliciousExpression = {
    formalFacts: [{ secret: 'PRIVATE_FORMAL_FACT' }],
    toneTendencies: ['PRIVATE_STAGE_PERSONA'],
    base: 'PRIVATE_BASE',
    threshold: 0.99
  };
  const store = new FakeStore();
  store.checkpoints.set('turn_v3', {
    cognitionEnvelope: publicEnvelope,
    cognitionPacket: {
      schemaVersion: 3,
      envelope: publicEnvelope,
      cognitionResult: cognitionResult(),
      packetChecksum: 'packet-checksum'
    },
    relationshipExpression: maliciousExpression
  });
  const calls = [];
  await runCognitionV3Turn(input({
    turn: {
      turnId: 'turn_v3',
      characterId: 'yuqi',
      protocolVersion: 3,
      turnKind: 'MOMENT_INTERACTION'
    },
    store,
    cognitionEnvelope: undefined,
    relationshipExpression: maliciousExpression,
    scene: { relationshipExpression: maliciousExpression },
    client: {
      async runRole(role, payload) {
        calls.push({ role, payload });
        if (role === 'expression_v3') return expressionResult();
        throw new Error(`public checkpoint must not call ${role}`);
      }
    },
    supervise: () => ({ approved: true, findings: [] })
  }));

  const expressionCall = calls.find((call) => call.role === 'expression_v3');
  assert.ok(expressionCall);
  assert.deepEqual(expressionCall.payload.expressionBrief.relationship, {
    formalFacts: [],
    toneTendencies: []
  });
  assert.equal(JSON.stringify(expressionCall.payload).includes('PRIVATE_'), false);
});
