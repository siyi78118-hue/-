import { canonicalJson, contentHash } from './protocol.mjs';
import {
  COGNITION_SCHEMA_V3,
  EXPRESSION_SCHEMA_V3
} from './role-schemas.mjs';

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
      const unknown = Object.keys(value).filter(key => !Object.hasOwn(schema.properties, key));
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
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      schemaError(path, 'must be a finite number');
    }
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

function allowedActionSet(value) {
  if (Array.isArray(value)) return new Set(value.map(String));
  if (value && typeof value === 'object') {
    return new Set(Object.entries(value).filter(([, allowed]) => Boolean(allowed)).map(([name]) => name));
  }
  return new Set();
}

function actionAllowed(allowed, name) {
  return allowed.has(name)
    || allowed.has(name.toUpperCase())
    || [...allowed].some(value => value.startsWith(`${name}:`));
}

function requireAllowedAction(intent, allowed, name) {
  if (intent !== null && !actionAllowed(allowed, name)) {
    throw new Error(`${name} action is not allowed`);
  }
}

function authoritativePayment(envelope) {
  return envelope?.featureContext?.payment
    || envelope?.context?.payment
    || envelope?.trigger?.context?.payment
    || null;
}

function validatePayment(payment, envelope) {
  if (!payment) return;
  const target = authoritativePayment(envelope);
  if (!target
    || String(payment.messageId) !== String(target.messageId)
    || String(payment.kind) !== String(target.kind)
    || Number(payment.amount) !== Number(target.amount)) {
    throw new Error('payment target does not match the authoritative payment context');
  }
}

function configuredIds(context, key, featureKeys = []) {
  const ids = new Set((context?.allowedActionTargets?.[key] || []).map(String));
  for (const featureKey of featureKeys) {
    const value = context?.envelope?.featureContext?.[featureKey]
      ?? context?.envelope?.context?.[featureKey]
      ?? context?.envelope?.trigger?.context?.[featureKey];
    if (value != null) ids.add(String(value));
  }
  return ids;
}

function validateMoment(moment, context) {
  if (!moment) return;
  const momentIds = configuredIds(context, 'momentIds', ['momentId', 'targetMomentId']);
  const commentIds = configuredIds(context, 'commentIds', ['commentId', 'targetCommentId']);
  if (!momentIds.has(String(moment.momentId))) {
    throw new Error('moment target is not authorized');
  }
  if (moment.replyToCommentId !== null
    && !commentIds.has(String(moment.replyToCommentId))) {
    throw new Error('moment comment target is not authorized');
  }
}

function validateRolePlan(rolePlan, context, validMessageIds) {
  if (!rolePlan) return;
  let operations;
  try {
    operations = JSON.parse(rolePlan.operationsJson);
  } catch {
    throw new Error('rolePlan operationsJson must be a valid JSON array');
  }
  if (!Array.isArray(operations)) {
    throw new Error('rolePlan operationsJson must be a valid JSON array');
  }
  const allowedOps = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete']);
  const allowedPlanIds = asSet(context?.allowedActionTargets?.rolePlanIds);
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || !allowedOps.has(String(operation.op))) {
      throw new Error('rolePlan operation is outside the existing domain');
    }
    if (operation.op !== 'create' && !allowedPlanIds.has(String(operation.planId))) {
      throw new Error('rolePlan target is not authorized');
    }
    for (const id of operation.evidenceMessageIds || []) {
      if (!validMessageIds.has(String(id))) {
        throw new Error(`unknown evidence messageId: ${id}`);
      }
    }
  }
}

function validateLifeAdjustment(adjustment, context) {
  if (!adjustment || adjustment.type === 'none') return;
  const allowed = asSet(context?.allowedActionTargets?.lifeEpisodeIds);
  if (!allowed.has(String(adjustment.targetEpisodeId))) {
    throw new Error('life adjustment target is not authorized');
  }
}

function validateRelationshipReview(review, context) {
  if (!review) return;
  const baseIds = asSet((context?.scene?.stageCatalog || []).map(item => item?.id));
  const phaseIds = asSet((context?.scene?.phaseCatalog || []).map(item => item?.id));
  if (review.base && baseIds.size && !baseIds.has(String(review.base.recommended))) {
    throw new Error('relationship review base target is not authorized');
  }
  if (review.phase && phaseIds.size && !phaseIds.has(String(review.phase.recommended))) {
    throw new Error('relationship review phase target is not authorized');
  }
}

function validateTransitionCoverage(transitions, relevantStances) {
  const relevant = (relevantStances || []).filter(stance => stance?.status !== 'expired');
  const counts = new Map();
  for (const transition of transitions) {
    if (transition.operation === 'create') continue;
    counts.set(String(transition.stanceId), (counts.get(String(transition.stanceId)) || 0) + 1);
  }
  for (const stance of relevant) {
    if ((counts.get(String(stance.stanceId)) || 0) !== 1) {
      throw new Error(`stance transition coverage is invalid for ${stance.stanceId}`);
    }
  }
  const relevantIds = new Set(relevant.map(stance => String(stance.stanceId)));
  for (const id of counts.keys()) {
    if (!relevantIds.has(id)) throw new Error(`stance transition target is not relevant: ${id}`);
  }
}

export function normalizeCognitionV3Result(value, validationContext = {}) {
  validateSchema(value, COGNITION_SCHEMA_V3, 'cognitionV3');
  const normalized = clone(value);
  if (normalized.interactionRead.confidence < 0 || normalized.interactionRead.confidence > 1) {
    throw new Error('interactionRead confidence must be between zero and one');
  }
  const validMessageIds = asSet(validationContext.validMessageIds);
  for (const messageId of collectEvidenceIds(normalized)) {
    if (!validMessageIds.has(messageId)) {
      throw new Error(`unknown evidence messageId: ${messageId}`);
    }
  }
  if (validationContext.envelope?.kind === 'DIRECT_REPLY'
    && normalized.interactionDecision.intendedResponse === 'skip') {
    throw new Error('DIRECT_REPLY cannot intentionally skip');
  }
  if (normalized.interactionDecision.intendedResponse === 'skip'
    && !String(normalized.interactionDecision.intentionalNonResponseReason || '').trim()) {
    throw new Error('intentional skip requires intentionalNonResponseReason');
  }
  if (normalized.interactionDecision.intendedResponse === 'send'
    && normalized.interactionDecision.intentionalNonResponseReason !== null) {
    throw new Error('send decision cannot include intentionalNonResponseReason');
  }
  validateTransitionCoverage(
    normalized.selfResponse.stanceTransitions,
    validationContext.relevantStances
  );
  if (canonicalJson(normalized.selfResponse.stanceTransitions)
    !== canonicalJson(normalized.statePatch.currentStances)) {
    throw new Error('statePatch current stance decisions conflict with selfResponse stance transitions');
  }

  const allowed = allowedActionSet(validationContext.allowedActions);
  requireAllowedAction(normalized.actionIntent.payment, allowed, 'payment');
  requireAllowedAction(normalized.actionIntent.moment, allowed, 'moment');
  requireAllowedAction(normalized.actionIntent.rolePlan, allowed, 'rolePlan');
  requireAllowedAction(normalized.actionIntent.lifeAdjustment, allowed, 'lifeAdjustment');
  requireAllowedAction(normalized.actionIntent.relationshipReview, allowed, 'relationshipReview');
  validatePayment(normalized.actionIntent.payment, validationContext.envelope);
  validateMoment(normalized.actionIntent.moment, validationContext);
  validateRolePlan(normalized.actionIntent.rolePlan, validationContext, validMessageIds);
  validateLifeAdjustment(normalized.actionIntent.lifeAdjustment, validationContext);
  validateRelationshipReview(normalized.actionIntent.relationshipReview, validationContext);
  return normalized;
}

function completeCurrentInteraction(envelope) {
  return clone(envelope?.currentInteraction || envelope?.context?.currentBatch || { messages: [] });
}

export function compileExpressionBriefV3({
  envelope,
  agencyView,
  relationship,
  cognitionResult
}) {
  if (!cognitionResult?.interactionDecision || !cognitionResult?.actionIntent) {
    throw new Error('expression brief requires an authorized cognition result');
  }
  return {
    schemaVersion: 3,
    personaTone: clone(envelope?.personaTone || []),
    relationship: {
      formalFacts: clone(relationship?.formalFacts || []),
      toneTendencies: clone(relationship?.toneTendencies || [])
    },
    currentInteraction: completeCurrentInteraction(envelope),
    relevantHistory: clone(envelope?.relevantHistory || []),
    currentState: {
      hardConstraints: clone(agencyView?.hardConstraints || []),
      preferences: clone(agencyView?.preferences || []),
      currentStances: clone(agencyView?.currentStances || [])
    },
    interactionDecision: {
      intendedResponse: cognitionResult.interactionDecision.intendedResponse,
      relationshipEffect: cognitionResult.interactionDecision.relationshipEffect,
      shouldAcknowledgeBid: cognitionResult.interactionDecision.shouldAcknowledgeBid
    },
    mustConvey: clone(cognitionResult.interactionDecision.mustConvey),
    mustNotClaim: clone(cognitionResult.interactionDecision.mustNotClaim),
    authorizedActions: clone(cognitionResult.actionIntent),
    continuityDetails: clone(envelope?.continuityDetails || []).slice(0, 2)
  };
}

function normalizedVisibleText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeExpressionV3Result(value) {
  validateSchema(value, EXPRESSION_SCHEMA_V3, 'expressionV3');
  const normalized = clone(value);
  if (normalized.bubblePlan.length > 5) {
    throw new Error('expressionV3 bubblePlan exceeds five bubbles');
  }
  if (normalized.action === 'send') {
    if (!normalizedVisibleText(normalized.reply) || normalized.bubblePlan.length === 0) {
      throw new Error('expressionV3 send requires a visible reply and bubblePlan');
    }
    const planned = normalized.bubblePlan.map(item => item.text).join(' ');
    if (normalizedVisibleText(planned) !== normalizedVisibleText(normalized.reply)) {
      throw new Error('expressionV3 bubblePlan does not match reply');
    }
  } else if (normalizedVisibleText(normalized.reply) || normalized.bubblePlan.length) {
    throw new Error('expressionV3 skip cannot contain a visible reply');
  }
  return normalized;
}

export function compileCognitionPacketV3({ envelope, cognitionResult }) {
  const packet = {
    schemaVersion: 3,
    envelope: clone(envelope),
    cognitionResult: clone(cognitionResult)
  };
  return {
    ...packet,
    packetChecksum: contentHash(packet)
  };
}

export function materializeV3Draft({ cognitionPacket, expressionResult }) {
  if (cognitionPacket?.schemaVersion !== 3 || !cognitionPacket?.cognitionResult) {
    throw new Error('cognition-v3 packet is required');
  }
  const expression = normalizeExpressionV3Result(expressionResult);
  const cognition = cognitionPacket.cognitionResult;
  if (expression.action !== cognition.interactionDecision.intendedResponse) {
    throw new Error('expression action conflicts with the authorized cognition decision');
  }
  const draft = {
    action: expression.action,
    reply: expression.reply,
    usedFactIds: clone(expression.usedFactIds),
    bubblePlan: clone(expression.bubblePlan),
    incompatibility: expression.incompatibility,
    actionIntent: clone(cognition.actionIntent),
    statePatch: clone(cognition.statePatch),
    interactionDecision: clone(cognition.interactionDecision),
    cognitionPacketChecksum: cognitionPacket.packetChecksum,
    rewriteMetadata: {
      source: 'cognition-v3',
      cognitionPacketChecksum: cognitionPacket.packetChecksum
    }
  };
  return {
    ...draft,
    draftChecksum: contentHash(draft)
  };
}
