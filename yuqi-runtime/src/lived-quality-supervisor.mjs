export const LIVED_QUALITY_CODES = Object.freeze([
  'SOCIAL_BID_DROPPED',
  'SOFT_STANCE_FROZEN',
  'INTERNAL_POLICY_LEAK',
  'ONE_SIDED_RELATIONAL_DEMAND',
  'DIALOGUE_META_NARRATION',
  'CHARACTER_STATE_BREAK'
]);

const CODE_SET = new Set(LIVED_QUALITY_CODES);
const OWNER_SET = new Set(['cognition', 'expression', 'action']);
const POLICY_LEAK = /(?:系统|内部|后台|模型|提示词|规则|策略|风险|当前关系阶段|这个阶段|还没到.{0,8}阶段|按.{0,6}阶段)/u;

function strings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];
}

function evidenceIds(input) {
  return strings((input.currentInteraction?.messages || []).map((message) => message?.messageId));
}

function finding(value, input) {
  const code = String(value?.code || '');
  const owner = String(value?.owner || '');
  if (!CODE_SET.has(code)) throw new Error(`unsupported lived-quality finding code: ${code}`);
  if (!OWNER_SET.has(owner)) throw new Error(`invalid lived-quality finding owner: ${owner}`);
  const normalized = {
    code,
    owner,
    evidenceMessageIds: strings(value?.evidenceMessageIds).length
      ? strings(value.evidenceMessageIds)
      : evidenceIds(input),
    violatedRequirement: String(value?.violatedRequirement || '').trim(),
    mustPreserve: strings(value?.mustPreserve),
    mustChange: strings(value?.mustChange),
    acceptanceCriteria: strings(value?.acceptanceCriteria)
  };
  for (const [key, field] of Object.entries({
    evidenceMessageIds: normalized.evidenceMessageIds,
    mustPreserve: normalized.mustPreserve,
    mustChange: normalized.mustChange,
    acceptanceCriteria: normalized.acceptanceCriteria
  })) {
    if (!field.length) throw new Error(`lived-quality finding ${key} is required`);
  }
  if (!normalized.violatedRequirement) {
    throw new Error('lived-quality finding violatedRequirement is required');
  }
  return normalized;
}

function deterministicFindings(input) {
  const findings = [];
  const reply = String(input.draft?.reply || '');
  if (POLICY_LEAK.test(reply)) {
    findings.push(finding({
      code: 'INTERNAL_POLICY_LEAK',
      owner: 'expression',
      evidenceMessageIds: evidenceIds(input),
      violatedRequirement: 'visible dialogue must not narrate internal policy or stage control',
      mustPreserve: ['the authorized social decision and factual content'],
      mustChange: ['remove policy, stage, risk, and system narration from visible dialogue'],
      acceptanceCriteria: ['the revised dialogue participates in-world without internal-policy language']
    }, input));
  }
  if (input.turnSuperseded) {
    findings.push(finding({
      code: 'CHARACTER_STATE_BREAK',
      owner: 'action',
      evidenceMessageIds: evidenceIds(input),
      violatedRequirement: 'a superseded turn cannot become visible',
      mustPreserve: ['the newer authoritative user batch'],
      mustChange: ['prevent the superseded result from committing'],
      acceptanceCriteria: ['no message, action, state, or memory side effect is committed']
    }, input));
  }
  if (input.actionAuthorized === false) {
    findings.push(finding({
      code: 'CHARACTER_STATE_BREAK',
      owner: 'action',
      evidenceMessageIds: evidenceIds(input),
      violatedRequirement: 'structured action differs from the authoritative action target',
      mustPreserve: ['the visible social intent'],
      mustChange: ['reject the unauthorized structured action'],
      acceptanceCriteria: ['only the authoritative action target may commit']
    }, input));
  }
  return findings;
}

function compactDecision(input) {
  const result = input.cognitionPacket?.cognitionResult || {};
  return {
    interactionRead: result.interactionRead || null,
    selfResponse: result.selfResponse || null,
    interactionDecision: result.interactionDecision || null,
    actionIntent: result.actionIntent || null
  };
}

export function repairPlanForFinding(value) {
  const normalized = finding(value, {
    currentInteraction: {
      messages: strings(value?.evidenceMessageIds).map((messageId) => ({ messageId }))
    }
  });
  return {
    owner: normalized.owner,
    code: normalized.code,
    evidenceMessageIds: normalized.evidenceMessageIds,
    mustPreserve: normalized.mustPreserve,
    mustChange: normalized.mustChange,
    acceptanceCriteria: normalized.acceptanceCriteria
  };
}

export async function superviseLivedTurn(input) {
  const deterministic = deterministicFindings(input);
  if (deterministic.length) return { approved: false, findings: deterministic };
  if (!input.highRisk) return { approved: true, findings: [] };
  if (!input.reviewer?.review) throw new Error('high-risk lived-quality review requires a reviewer');
  const checks = strings(input.applicableChecks).slice(0, 3);
  const reviewed = await input.reviewer.review({
    cognitionDecision: compactDecision(input),
    visibleDraft: String(input.draft?.reply || ''),
    currentInteraction: input.currentInteraction || { messages: [] },
    continuity: input.continuity || null,
    ...(input.disclosurePolicy
      ? { disclosurePolicy: structuredClone(input.disclosurePolicy) }
      : {}),
    checks
  });
  const findings = (reviewed?.findings || []).map((item) => finding(item, input));
  const approved = reviewed?.approved === true && findings.length === 0;
  return { approved, findings };
}
