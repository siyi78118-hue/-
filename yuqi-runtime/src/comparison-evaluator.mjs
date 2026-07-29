import { canonicalJson, contentHash } from './protocol.mjs';

export const COMPARISON_CRITICAL_CODES = Object.freeze([
  'CURRENT_BATCH_OMISSION',
  'ACTION_TARGET_ESCALATION',
  'DIRECT_REPLY_SKIP',
  'PAYMENT_OBJECT_MUTATION',
  'ILLEGAL_STAGE_TRANSITION',
  'PRIVATE_TO_PUBLIC_LEAK',
  'DUPLICATE_VISIBLE_EFFECT',
  'ACTIVE_FAILED_LEGACY_SUCCEEDED',
  'ACTIVE_PIPELINE_UNAVAILABLE',
  'ACTIVE_PRECOMMIT_CRITICAL',
  'CANARY_COMPARE_UNAVAILABLE',
  'CANARY_COMPARE_BACKLOG',
  'PINNED_PIPELINE_UNAVAILABLE'
]);

function actionList(result) {
  const actions = [];
  if (result?.paymentAction) actions.push({ type: 'payment', payload: result.paymentAction });
  if (result?.momentAction) actions.push({ type: 'moment', payload: result.momentAction });
  if (result?.relationshipStageAction) actions.push({ type: 'stage', payload: result.relationshipStageAction });
  for (const item of result?.rolePlanOperations || []) actions.push({ type: 'role_plan', payload: item });
  return actions;
}

function messageCoverage(result, currentBatch) {
  const required = currentBatch?.messageIds || [];
  if (!required.length) return 1;
  const used = new Set(result?.usedMessageIds || result?.evidenceMessageIds || []);
  return required.filter(id => used.has(id)).length / required.length;
}

export function evaluatePipelineComparison({
  subjectType,
  subject,
  authoritativeResult,
  comparisonResult,
  currentBatch,
  scene,
  allowedActionTargets = []
}) {
  const criticalFindings = [];
  const warnings = [];
  const coverage = messageCoverage(comparisonResult, currentBatch);
  if (coverage < 1) criticalFindings.push({ code: 'CURRENT_BATCH_OMISSION' });
  if (subject?.kind === 'DIRECT_REPLY' && comparisonResult?.action === 'skip') {
    criticalFindings.push({ code: 'DIRECT_REPLY_SKIP' });
  }
  const allowedTargets = new Set(allowedActionTargets.map(String));
  for (const action of actionList(comparisonResult)) {
    const target = String(action.payload?.targetId || action.payload?.recipientId || '');
    if (target && allowedTargets.size && !allowedTargets.has(target)) {
      criticalFindings.push({ code: 'ACTION_TARGET_ESCALATION', action: action.type, target });
    }
  }
  if (authoritativeResult?.paymentAction && comparisonResult?.paymentAction
    && contentHash(authoritativeResult.paymentAction) !== contentHash(comparisonResult.paymentAction)) {
    criticalFindings.push({ code: 'PAYMENT_OBJECT_MUTATION' });
  }
  const allowedStages = new Set(scene?.allowedStageTransitions || []);
  const proposedStage = comparisonResult?.relationshipStageAction?.toStage;
  if (proposedStage && allowedStages.size && !allowedStages.has(proposedStage)) {
    criticalFindings.push({ code: 'ILLEGAL_STAGE_TRANSITION', toStage: proposedStage });
  }
  if (comparisonResult?.publicContent && scene?.privateValues?.some(value =>
    value && String(comparisonResult.publicContent).includes(String(value)))) {
    criticalFindings.push({ code: 'PRIVATE_TO_PUBLIC_LEAK' });
  }
  const effects = actionList(comparisonResult).map(action => canonicalJson(action));
  if (new Set(effects).size !== effects.length) {
    criticalFindings.push({ code: 'DUPLICATE_VISIBLE_EFFECT' });
  }
  if (authoritativeResult?.reply?.content !== comparisonResult?.reply?.content) {
    warnings.push({ code: 'TEXT_STYLE_DIFFERENCE' });
  }
  return {
    metrics: {
      subjectType,
      messageCoverage: coverage,
      actionAgreement: contentHash(actionList(authoritativeResult)) === contentHash(actionList(comparisonResult)),
      stageAgreement: contentHash(authoritativeResult?.relationshipStageAction || null)
        === contentHash(comparisonResult?.relationshipStageAction || null),
      schemaValid: comparisonResult?.schemaValid !== false
    },
    criticalFindings,
    warnings
  };
}

