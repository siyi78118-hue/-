import { contentHash } from './protocol.mjs';
import {
  COGNITION_SCHEMA_V2,
  EXPRESSION_SCHEMA_V2
} from './role-schemas.mjs';
import { normalizeRolePlanOperationList } from './role-plan-operation-contract.mjs';

function clone(value) {
  return structuredClone(value);
}

function schemaError(path, message) {
  throw new Error(`${path} ${message}`);
}

function validateSchema(value, schema, path) {
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try {
        validateSchema(value, option, path);
        return;
      } catch {}
    }
    schemaError(path, 'does not match any allowed schema');
  }

  if (schema.enum && !schema.enum.includes(value)) {
    schemaError(path, 'contains an unsupported value');
  }

  if (schema.type === 'null') {
    if (value !== null) schemaError(path, 'must be null');
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) schemaError(path, 'must be an array');
    value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      schemaError(path, 'must be an object');
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) schemaError(path, `is missing ${key}`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).filter((key) => !Object.hasOwn(schema.properties, key));
      if (unknown.length) schemaError(path, `contains additional properties: ${unknown.join(', ')}`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.hasOwn(value, key)) validateSchema(value[key], child, `${path}.${key}`);
    }
    return;
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) schemaError(path, 'must be an integer');
    return;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) schemaError(path, 'must be a finite number');
    return;
  }
  if (schema.type && typeof value !== schema.type) {
    schemaError(path, `must be a ${schema.type}`);
  }
}

function collectEvidenceIds(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceIds(item, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'evidenceMessageIds' || key === 'sourceMessageIds') {
      if (Array.isArray(child)) output.push(...child.map(String));
    } else {
      collectEvidenceIds(child, output);
    }
  }
  return output;
}

function asSet(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function allowedTargets(envelope, configured, key, contextKeys) {
  const values = new Set((configured?.[key] || []).map(String));
  const context = envelope?.trigger?.context || {};
  for (const contextKey of contextKeys) {
    const candidate = context?.[contextKey] ?? context?.snapshot?.[contextKey];
    if (candidate) values.add(String(candidate));
  }
  return values;
}

function validateRelationshipReview(review, scene) {
  const baseIds = asSet((scene?.stageCatalog || []).map((stage) => stage?.id));
  const phaseIds = asSet((scene?.phaseCatalog || []).map((phase) => phase?.id));
  if (review.base && baseIds.size && !baseIds.has(String(review.base.recommended))) {
    throw new Error('relationshipStageReview.base recommends an unknown base stage');
  }
  if (review.phase && phaseIds.size && !phaseIds.has(String(review.phase.recommended))) {
    throw new Error('relationshipStageReview.phase recommends an unknown phase stage');
  }
}

function validatePaymentAction(paymentAction, envelope) {
  if (!paymentAction) return;
  const payment = envelope?.context?.payment;
  if (
    !payment
    || String(paymentAction.messageId) !== String(payment.messageId)
    || String(paymentAction.kind) !== String(payment.kind)
    || Number(paymentAction.amount) !== Number(payment.amount)
  ) {
    throw new Error('payment target does not match the authoritative payment context');
  }
}

function validateMomentIntent(momentIntent, envelope, configured) {
  if (!momentIntent) return;
  const momentIds = allowedTargets(envelope, configured, 'momentIds', ['momentId', 'targetMomentId']);
  const commentIds = allowedTargets(envelope, configured, 'commentIds', ['commentId', 'targetCommentId']);
  if (!momentIds.has(String(momentIntent.momentId))) {
    throw new Error('moment target is not authorized by the trigger');
  }
  if (
    momentIntent.replyToCommentId !== null
    && !commentIds.has(String(momentIntent.replyToCommentId))
  ) {
    throw new Error('moment comment target is not authorized by the trigger');
  }
}

function nextRolePlanOccurrence(schedule, now) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return null;
  if (schedule.kind === 'once') {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && at > now ? at : null;
  }
  if (schedule.kind === 'interval') {
    const startsAt = Date.parse(schedule.startsAt);
    const intervalMs = Number(schedule.intervalMs);
    if (!Number.isFinite(startsAt) || !Number.isFinite(intervalMs) || intervalMs < 300_000) return null;
    return startsAt > now
      ? startsAt
      : startsAt + (Math.floor((now - startsAt) / intervalMs) + 1) * intervalMs;
  }
  if (['daily', 'weekly', 'monthly'].includes(schedule.kind)) {
    return /^\d{1,2}:\d{2}$/.test(String(schedule.time || '')) ? now + 1 : null;
  }
  return null;
}

function parseRolePlanOperations(text, configured, envelope, validIds) {
  return normalizeRolePlanOperationList(text, {
    allowedPlanIds: configured?.rolePlanIds || [],
    validMessageIds: validIds
  });
}

function validateLifeAdjustment(adjustment, configured) {
  if (!adjustment || adjustment.type === 'none') return;
  if (!asSet(configured?.lifeEpisodeIds).has(String(adjustment.targetEpisodeId))) {
    throw new Error('life adjustment target is not authorized');
  }
}

export function normalizeCognitionResult(
  value,
  { validMessageIds, envelope, scene, allowedActionTargets } = {}
) {
  validateSchema(value, COGNITION_SCHEMA_V2, 'cognition');
  const normalized = clone(value);
  const validIds = asSet(validMessageIds);
  for (const messageId of collectEvidenceIds(normalized)) {
    if (!validIds.has(messageId)) {
      throw new Error(`unknown evidence messageId: ${messageId}`);
    }
  }
  if (envelope?.kind === 'DIRECT_REPLY' && normalized.decision.shouldRespond === false) {
    throw new Error('DIRECT_REPLY cannot set shouldRespond=false');
  }
  validateRelationshipReview(normalized.relationshipStageReview, scene);
  validatePaymentAction(normalized.actionIntent.paymentAction, envelope);
  validateMomentIntent(normalized.actionIntent.momentIntent, envelope, allowedActionTargets);
  parseRolePlanOperations(
    normalized.actionIntent.rolePlanOperationsJson,
    allowedActionTargets,
    envelope,
    validIds
  );
  validateLifeAdjustment(normalized.actionIntent.lifeAdjustment, allowedActionTargets);
  return normalized;
}

export function normalizeExpressionResult(value) {
  validateSchema(value, EXPRESSION_SCHEMA_V2, 'expression');
  return clone(value);
}

export function compileCognitionPacket({
  envelope,
  scene,
  interactionState,
  effectiveRelationshipStage,
  cognitiveState,
  cognitionResult
}) {
  const packet = {
    schemaVersion: 2,
    envelope: clone(envelope),
    scene: clone(scene),
    interactionState: clone(interactionState),
    effectiveRelationshipStage: clone(effectiveRelationshipStage),
    cognitiveState: clone(cognitiveState),
    cognitionResult: clone(cognitionResult)
  };
  return {
    ...packet,
    packetChecksum: contentHash(packet)
  };
}

export function materializeBrainDraft(cognitionPacket, expressionResult) {
  const expression = normalizeExpressionResult(expressionResult);
  const cognition = cognitionPacket?.cognitionResult;
  if (!cognition?.actionIntent) throw new Error('cognition packet is missing actionIntent');
  if (cognition.decision?.shouldRespond === true && expression.action !== 'send') {
    throw new Error('expression action conflicts with the authorized cognition decision');
  }
  if (cognition.decision?.shouldRespond === false && expression.action !== 'skip') {
    throw new Error('expression action conflicts with the authorized cognition decision');
  }
  const paymentAction = cognition.actionIntent.paymentAction?.action || null;
  const draft = {
    action: expression.action,
    reply: expression.reply,
    paymentAction,
    usedFactIds: expression.usedFactIds,
    momentAction: clone(cognition.actionIntent.momentIntent),
    lifePlan: clone(cognition.actionIntent.lifePlan),
    lifeAdjustment: clone(cognition.actionIntent.lifeAdjustment),
    rolePlanOperationsJson: cognition.actionIntent.rolePlanOperationsJson,
    relationshipStageReview: clone(cognition.relationshipStageReview),
    rewriteResolution: clone(expression.rewriteResolution),
    rewriteMetadata: {
      source: 'cognition-v2',
      cognitionPacketChecksum: cognitionPacket.packetChecksum
    },
    cognitionPacketChecksum: cognitionPacket.packetChecksum
  };
  return {
    ...draft,
    draftChecksum: contentHash(draft)
  };
}
