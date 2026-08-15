import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileCognitionPacketV3,
  compileExpressionBriefV3,
  compileUnderstandingDisclosurePolicyV3,
  materializeV3Draft,
  normalizeCognitionV3Result,
  normalizeExpressionV3Result
} from '../src/cognition-v3-contract.mjs';
import { contentHash } from '../src/protocol.mjs';

function transition(overrides = {}) {
  return {
    stanceId: 's1',
    operation: 'maintain',
    topic: null,
    position: null,
    reason: 'the current bid supports it',
    strength: null,
    flexibility: null,
    evidenceMessageIds: ['u1'],
    expiresAt: null,
    remainingRelevantUserBatches: null,
    ...overrides
  };
}

function validCognitionV3(overrides = {}) {
  const stanceTransitions = [transition()];
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
      stanceTransitions
    },
    interactionDecision: {
      intendedResponse: 'send',
      relationshipEffect: 'meet the bid without overexplaining it',
      shouldAcknowledgeBid: true,
      intentionalNonResponseReason: null,
      mustConvey: ['she caught the playful bid'],
      mustNotClaim: ['a payment was accepted']
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
      currentStances: stanceTransitions,
      openThreads: ['playful_exchange']
    },
    ...overrides
  };
}

function validationContext(overrides = {}) {
  return {
    validMessageIds: ['u1', 'a0'],
    envelope: {
      kind: 'DIRECT_REPLY',
      createdAt: 1000,
      currentInteraction: {
        messages: [{ messageId: 'u1', speakerType: 'user', content: '废话废话' }]
      },
      featureContext: {}
    },
    relevantStances: [{ stanceId: 's1', topic: 'gift_play', status: 'active' }],
    allowedActions: [],
    allowedActionTargets: {},
    ...overrides
  };
}

function validExpressionV3(overrides = {}) {
  return {
    action: 'send',
    reply: '行，这次算你多说了两个字。',
    usedFactIds: [],
    bubblePlan: [{
      text: '行，这次算你多说了两个字。',
      purpose: 'continue the playful exchange'
    }],
    incompatibility: null,
    ...overrides
  };
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

test('v3 requires an intentional decision about an identified social bid', () => {
  const value = validCognitionV3();
  delete value.interactionDecision.shouldAcknowledgeBid;
  assert.throws(
    () => normalizeCognitionV3Result(value, validationContext()),
    /shouldAcknowledgeBid/
  );
});

test('every evidence id and every relevant stance transition is validated', () => {
  const unknown = validCognitionV3();
  unknown.interactionRead.evidenceMessageIds = ['invented'];
  assert.throws(
    () => normalizeCognitionV3Result(unknown, validationContext()),
    /unknown evidence messageId/
  );

  const missing = validCognitionV3();
  missing.selfResponse.stanceTransitions = [];
  missing.statePatch.currentStances = [];
  assert.throws(
    () => normalizeCognitionV3Result(missing, validationContext()),
    /transition coverage/
  );
});

test('DIRECT_REPLY cannot intentionally skip', () => {
  const value = validCognitionV3();
  value.interactionDecision.intendedResponse = 'skip';
  value.interactionDecision.intentionalNonResponseReason = 'does not feel like answering';
  assert.throws(
    () => normalizeCognitionV3Result(value, validationContext()),
    /DIRECT_REPLY/
  );
});

test('PROACTIVE_CHAT send must cite one to three pinned motive evidence ids', () => {
  const value = validCognitionV3({
    interactionDecision: { ...validCognitionV3().interactionDecision, motiveEvidenceIds: ['motive_1'] }
  });
  const context = validationContext({
    envelope: { ...validationContext().envelope, kind: 'PROACTIVE_CHAT' },
    proactiveMotiveIds: ['motive_1', 'motive_2']
  });
  assert.deepEqual(normalizeCognitionV3Result(value, context).interactionDecision.motiveEvidenceIds, ['motive_1']);
  for (const candidate of [undefined, [], ['motive_unknown'], ['motive_1', 'motive_1'], ['motive_1', 'motive_2', 'motive_3', 'motive_4']]) {
    const invalid = validCognitionV3({
      interactionDecision: {
        ...validCognitionV3().interactionDecision,
        ...(candidate === undefined ? {} : { motiveEvidenceIds: candidate })
      }
    });
    assert.throws(() => normalizeCognitionV3Result(invalid, context), /motiveEvidenceIds/);
  }
});

test('PROACTIVE_CHAT skip has no action intent and no motive evidence', () => {
  const value = validCognitionV3({
    interactionDecision: {
      ...validCognitionV3().interactionDecision,
      intendedResponse: 'skip',
      intentionalNonResponseReason: 'no persisted motive',
      motiveEvidenceIds: []
    }
  });
  const context = validationContext({
    envelope: { ...validationContext().envelope, kind: 'PROACTIVE_CHAT' },
    proactiveMotiveIds: []
  });
  assert.deepEqual(normalizeCognitionV3Result(value, context).interactionDecision.motiveEvidenceIds, []);
  for (const key of ['payment', 'moment', 'rolePlan', 'lifeAdjustment', 'relationshipReview']) {
    const invalid = structuredClone(value);
    invalid.actionIntent[key] = { bogus: true };
    assert.throws(() => normalizeCognitionV3Result(invalid, context), /PROACTIVE_CHAT skip|additional properties|not allowed|does not match/);
  }
});

test('structured actions require both an allowed action and the authoritative target', () => {
  const value = validCognitionV3();
  value.actionIntent.payment = {
    action: 'received',
    messageId: 'pay_wrong',
    kind: 'redpacket',
    amount: 20
  };
  assert.throws(
    () => normalizeCognitionV3Result(value, validationContext()),
    /payment.*not allowed/
  );
  assert.throws(
    () => normalizeCognitionV3Result(value, validationContext({
      allowedActions: ['payment'],
      envelope: {
        ...validationContext().envelope,
        featureContext: {
          payment: { messageId: 'pay_1', kind: 'redpacket', amount: 20 }
        }
      }
    })),
    /payment target/
  );
});

test('cognition v3 rejects a time-bearing role plan before expression when time confidence is missing', () => {
  const operation = {
    op: 'create',
    type: 'private_message',
    source: 'spoken',
    title: '早安',
    intent: '明早问候',
    sourceQuote: '但是明天的早安不要忘了',
    evidenceMessageIds: ['u1'],
    schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' }
  };
  const broken = validCognitionV3();
  broken.actionIntent.rolePlan = { operationsJson: JSON.stringify([operation]) };
  const context = validationContext({ allowedActions: ['rolePlan'] });
  assert.throws(
    () => normalizeCognitionV3Result(broken, context),
    /role plan operation contract conflict: time confidence/
  );

  operation.timeConfidence = 'inferred';
  const accepted = structuredClone(broken);
  accepted.actionIntent.rolePlan.operationsJson = JSON.stringify([operation]);
  const normalized = normalizeCognitionV3Result(accepted, context);
  assert.equal(
    normalized.actionIntent.rolePlan.operationsJson,
    accepted.actionIntent.rolePlan.operationsJson
  );
});

test('state patch must carry the same stance decisions as self response', () => {
  const value = validCognitionV3();
  value.statePatch.currentStances = structuredClone(value.statePatch.currentStances);
  value.statePatch.currentStances[0] = transition({ operation: 'reverse', position: 'accept' });
  assert.throws(
    () => normalizeCognitionV3Result(value, validationContext()),
    /statePatch.*stance/
  );
});

test('response risks and evaluator language cannot appear in the expression brief', () => {
  const cognitionResult = validCognitionV3();
  const brief = compileExpressionBriefV3({
    envelope: {
      ...validationContext().envelope,
      relevantHistory: [{ groupId: 'g1', messages: [{ messageId: 'a0', content: '前文' }] }],
      personaTone: ['自然', '有自己的判断'],
      continuityDetails: ['detail 1', 'detail 2', 'detail 3']
    },
    agencyView: {
      hardConstraints: [],
      preferences: [{ topic: 'food', value: 'sweet', binding: false }],
      currentStances: [{ stanceId: 's1', position: 'playful' }]
    },
    relationship: { formalFacts: [], toneTendencies: ['熟悉'] },
    cognitionResult,
    responseRisks: ['may look transactional'],
    evaluatorTaxonomy: ['SOCIAL_BID_DROPPED']
  });
  const serialized = JSON.stringify(brief);
  assert.equal(serialized.includes('may look transactional'), false);
  assert.equal(serialized.includes('SOCIAL_BID_DROPPED'), false);
  assert.equal(serialized.includes('confidence'), false);
  assert.equal(brief.continuityDetails.length, 2);
  assert.deepEqual(
    brief.currentInteraction.messages.map(message => message.messageId),
    ['u1']
  );
});

test('2.1.1 keeps private understanding out of dialogue while older briefs stay byte-shaped', () => {
  const cognitionResult = validCognitionV3();
  cognitionResult.interactionRead = {
    ...cognitionResult.interactionRead,
    surfaceAct: 'PRIVATE_SURFACE_SENTINEL',
    primarySocialMeaning: 'PRIVATE_PRIMARY_SENTINEL',
    alternativeMeaning: 'PRIVATE_ALTERNATIVE_SENTINEL'
  };
  cognitionResult.selfResponse = {
    ...cognitionResult.selfResponse,
    immediateFeeling: 'PRIVATE_FEELING_SENTINEL',
    desire: 'PRIVATE_DESIRE_SENTINEL',
    resistance: 'PRIVATE_RESISTANCE_SENTINEL',
    attention: 'PRIVATE_ATTENTION_SENTINEL'
  };
  const args = {
    envelope: validationContext().envelope,
    agencyView: { hardConstraints: [], preferences: [], currentStances: [] },
    relationship: { formalFacts: [], toneTendencies: [] },
    cognitionResult
  };
  const previous = compileExpressionBriefV3({ ...args, presetVersion: '2.1.0' });
  const current = compileExpressionBriefV3({ ...args, presetVersion: '2.1.1' });

  assert.equal(Object.hasOwn(previous, 'disclosurePolicy'), false);
  assert.deepEqual(current.disclosurePolicy, expectedDisclosurePolicy);
  assert.deepEqual(compileUnderstandingDisclosurePolicyV3('2.1.1'), expectedDisclosurePolicy);
  assert.deepEqual(compileUnderstandingDisclosurePolicyV3('2.1.9'), expectedDisclosurePolicy);
  for (const version of [undefined, '', '2.1.0', '2.0.9', '3.0.0', 'not-semver']) {
    assert.equal(compileUnderstandingDisclosurePolicyV3(version), null);
  }
  for (const privateValue of [
    cognitionResult.interactionRead.primarySocialMeaning,
    cognitionResult.interactionRead.surfaceAct,
    cognitionResult.interactionRead.alternativeMeaning,
    cognitionResult.selfResponse.immediateFeeling,
    cognitionResult.selfResponse.desire,
    cognitionResult.selfResponse.resistance,
    cognitionResult.selfResponse.attention
  ]) {
    assert.equal(JSON.stringify(current).includes(privateValue), false);
  }
});

test('expression cannot add payment, moment, plan, stage, stance, or factual actions', () => {
  const input = validExpressionV3();
  input.paymentAction = { action: 'accept' };
  assert.throws(() => normalizeExpressionV3Result(input), /additional properties/);
});

test('expression bubble plan is bounded and must agree with its visible reply', () => {
  assert.throws(() => normalizeExpressionV3Result(validExpressionV3({
    bubblePlan: Array.from({ length: 6 }, (_, index) => ({
      text: `bubble ${index}`,
      purpose: 'overflow'
    }))
  })), /bubblePlan/);
  assert.throws(() => normalizeExpressionV3Result(validExpressionV3({
    bubblePlan: [{ text: 'different', purpose: 'contradiction' }]
  })), /reply/);
});

test('cognition packet checksum covers exactly the v3 envelope and decision', () => {
  const cognitionResult = normalizeCognitionV3Result(
    validCognitionV3(),
    validationContext()
  );
  const packet = compileCognitionPacketV3({
    envelope: validationContext().envelope,
    cognitionResult
  });
  assert.equal(packet.schemaVersion, 3);
  assert.equal(packet.packetChecksum, contentHash({
    schemaVersion: 3,
    envelope: packet.envelope,
    cognitionResult: packet.cognitionResult
  }));
});

test('materialization preserves cognition authority and expression only controls wording', () => {
  const cognitionResult = normalizeCognitionV3Result(
    validCognitionV3(),
    validationContext()
  );
  const packet = compileCognitionPacketV3({
    envelope: validationContext().envelope,
    cognitionResult
  });
  const draft = materializeV3Draft({
    cognitionPacket: packet,
    expressionResult: validExpressionV3()
  });
  assert.equal(draft.action, 'send');
  assert.deepEqual(draft.actionIntent, cognitionResult.actionIntent);
  assert.deepEqual(draft.statePatch, cognitionResult.statePatch);
  assert.match(draft.draftChecksum, /^[a-f0-9]{64}$/);
});
