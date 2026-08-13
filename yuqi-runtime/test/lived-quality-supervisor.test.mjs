import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVED_QUALITY_CODES,
  repairPlanForFinding,
  superviseLivedTurn
} from '../src/lived-quality-supervisor.mjs';

function finding(code, owner = 'expression') {
  return {
    code,
    owner,
    evidenceMessageIds: ['u1'],
    violatedRequirement: `violation for ${code}`,
    mustPreserve: ['authorized facts and action targets'],
    mustChange: ['the structural failure itself'],
    acceptanceCriteria: ['the same failure is absent in the revised result']
  };
}

for (const code of [
  'SOCIAL_BID_DROPPED',
  'SOFT_STANCE_FROZEN',
  'INTERNAL_POLICY_LEAK',
  'ONE_SIDED_RELATIONAL_DEMAND',
  'DIALOGUE_META_NARRATION',
  'CHARACTER_STATE_BREAK'
]) {
  test(`${code} preserves evidence, owner, preservation, change, and acceptance`, async () => {
    const result = await superviseLivedTurn({
      highRisk: true,
      cognitionPacket: { cognitionResult: { interactionDecision: {} } },
      draft: { reply: 'visible reply', actionIntent: {} },
      currentInteraction: { messages: [{ messageId: 'u1', text: 'hello' }] },
      applicableChecks: [code, 'OTHER_1', 'OTHER_2', 'OTHER_3'],
      reviewer: {
        async review(payload) {
          assert.equal(payload.checks.length, 3);
          return { approved: false, findings: [finding(code)] };
        }
      }
    });
    const [actual] = result.findings;
    assert.equal(actual.code, code);
    assert.ok(LIVED_QUALITY_CODES.includes(actual.code));
    assert.ok(['cognition', 'expression', 'action'].includes(actual.owner));
    assert.ok(actual.evidenceMessageIds.length);
    assert.ok(actual.mustPreserve.length);
    assert.ok(actual.mustChange.length);
    assert.ok(actual.acceptanceCriteria.length);
    assert.deepEqual(repairPlanForFinding(actual).acceptanceCriteria, actual.acceptanceCriteria);
  });
}

test('deterministic internal-policy leakage fails before model review', async () => {
  let reviewed = false;
  const result = await superviseLivedTurn({
    highRisk: false,
    cognitionPacket: { cognitionResult: { interactionDecision: {} } },
    draft: {
      reply: '按照当前关系阶段和系统规则，这一步不能太亲密。',
      actionIntent: {}
    },
    currentInteraction: { messages: [{ messageId: 'u1', text: '抱一下' }] },
    reviewer: {
      async review() {
        reviewed = true;
        return { approved: true, findings: [] };
      }
    }
  });

  assert.equal(reviewed, false);
  assert.equal(result.approved, false);
  assert.equal(result.findings[0].code, 'INTERNAL_POLICY_LEAK');
  assert.equal(result.findings[0].owner, 'expression');
});

test('ordinary low-risk output passes without loading the offline taxonomy', async () => {
  let reviewed = false;
  const result = await superviseLivedTurn({
    highRisk: false,
    cognitionPacket: { cognitionResult: { interactionDecision: {} } },
    draft: { reply: '刚泡上茶，你呢？', actionIntent: {} },
    currentInteraction: { messages: [{ messageId: 'u1', text: '在干嘛' }] },
    applicableChecks: Array.from({ length: 20 }, (_, index) => `offline_${index}`),
    reviewer: {
      async review() {
        reviewed = true;
      }
    }
  });

  assert.deepEqual(result, { approved: true, findings: [] });
  assert.equal(reviewed, false);
});

test('high-risk semantic review receives the pinned understanding disclosure policy', async () => {
  const disclosurePolicy = {
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
  };
  const result = await superviseLivedTurn({
    highRisk: true,
    cognitionPacket: { cognitionResult: { interactionDecision: {} } },
    draft: { reply: '那你再猜一次。', actionIntent: {} },
    currentInteraction: { messages: [{ messageId: 'u1', text: '你是不是早就看出来了' }] },
    disclosurePolicy,
    applicableChecks: ['DIALOGUE_META_NARRATION'],
    reviewer: {
      async review(payload) {
        assert.deepEqual(payload.disclosurePolicy, disclosurePolicy);
        return { approved: true, findings: [] };
      }
    }
  });
  assert.deepEqual(result, { approved: true, findings: [] });
});
