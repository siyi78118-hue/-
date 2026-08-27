import {
  AUTOMATIC_SESSION_SUMMARY_PAYLOAD_KEYS,
  COMMON_ENTITY_KEYS,
  ENTITY_PAYLOAD_KEYS,
  ENTITY_TYPES,
  MEMORY_KINDS,
  MEMORY_STATUSES,
  PERSONA_SCHEMA_VERSION,
  PROPOSAL_OUTCOMES,
  PROPOSAL_STATUSES,
  SOURCE_REF_TYPES,
  TENDENCY_STATUSES
} from './schemas.mjs';
import { PersonaValidationError } from './errors.mjs';

const MAX_ROLE_ID = 512;
const MAX_ID = 240;
const MAX_SHORT_TEXT = 4096;
const MAX_SEMANTIC_TEXT = 32768;
const MAX_ARRAY_ITEMS = 512;

function fail(message) {
  throw new PersonaValidationError(message);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unknown or missing fields`);
  }
}

function string(value, label, { max = MAX_SEMANTIC_TEXT, nullable = false, empty = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (!empty && !value.trim()) fail(`${label} must not be empty`);
  if (value.length > max) fail(`${label} is too long`);
  return value;
}

function identifier(value, label, { nullable = false, prefix = null } = {}) {
  if (nullable && value === null) return null;
  string(value, label, { max: MAX_ID });
  if (prefix && (!value.startsWith(`${prefix}_`) || !/^[A-Za-z0-9_-]+$/.test(value))) {
    fail(`${label} has an invalid identity`);
  }
  return value;
}

function enumValue(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) fail(`${label} is invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}

function confidence(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be between 0 and 1`);
  }
  return value;
}

function isoTimestamp(value, label) {
  string(value, label, { max: 64 });
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(`${label} must be ISO 8601 UTC`);
  return value;
}

function array(value, label, validateItem, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_ARRAY_ITEMS) {
    fail(`${label} must be an array with a valid size`);
  }
  value.forEach((item, index) => validateItem(item, `${label}[${index}]`));
  return value;
}

function sourceRef(value, label) {
  exactKeys(value, ['type', 'id'], label);
  enumValue(value.type, SOURCE_REF_TYPES, `${label}.type`);
  identifier(value.id, `${label}.id`);
}

function sourceRefs(value, label = 'sourceRefs') {
  return array(value, label, sourceRef);
}

function uniqueStrings(value, label, { min = 0 } = {}) {
  array(value, label, (item, itemLabel) => string(item, itemLabel, { max: MAX_ID }), { min });
  if (new Set(value).size !== value.length) fail(`${label} must be unique`);
  return value;
}

function emotionalSummary(value, label = 'emotionalSummary') {
  exactKeys(value, ['user', 'al', 'interaction'], label);
  string(value.user, `${label}.user`, { nullable: true });
  string(value.al, `${label}.al`, { nullable: true });
  string(value.interaction, `${label}.interaction`, { nullable: true });
}

function summaryGeneration(value, label = 'generation') {
  exactKeys(value, ['summarizerVersion', 'promptVersion', 'model'], label);
  string(value.summarizerVersion, `${label}.summarizerVersion`, { max: 128 });
  string(value.promptVersion, `${label}.promptVersion`, { max: 128 });
  string(value.model, `${label}.model`, { max: 256 });
}

function uniqueObjectIds(value, label) {
  const ids = value.map(item => item.id);
  if (new Set(ids).size !== ids.length) fail(`${label} ids must be unique`);
}

function tendency(value, label) {
  exactKeys(value, ['id', 'statement', 'confidence', 'status', 'sourceRefs'], label);
  identifier(value.id, `${label}.id`);
  string(value.statement, `${label}.statement`);
  confidence(value.confidence, `${label}.confidence`);
  enumValue(value.status, TENDENCY_STATUSES, `${label}.status`);
  sourceRefs(value.sourceRefs, `${label}.sourceRefs`);
}

function tension(value, label) {
  exactKeys(value, ['id', 'left', 'right', 'description', 'sourceRefs'], label);
  identifier(value.id, `${label}.id`);
  string(value.left, `${label}.left`, { max: MAX_SHORT_TEXT });
  string(value.right, `${label}.right`, { max: MAX_SHORT_TEXT });
  string(value.description, `${label}.description`);
  sourceRefs(value.sourceRefs, `${label}.sourceRefs`);
}

function hypothesis(value, label) {
  exactKeys(value, ['statement', 'confidence'], label);
  string(value.statement, `${label}.statement`);
  confidence(value.confidence, `${label}.confidence`);
}

function proposedChange(value, label) {
  exactKeys(value, ['operation', 'targetType', 'targetId', 'before', 'after'], label);
  enumValue(value.operation, ['add', 'revise', 'remove'], `${label}.operation`);
  enumValue(value.targetType, ['self_description', 'tendency', 'tension'], `${label}.targetType`);
  identifier(value.targetId, `${label}.targetId`, { nullable: true });
  string(value.before, `${label}.before`, { nullable: true });
  string(value.after, `${label}.after`, { nullable: true });
  if (value.operation === 'revise' && (value.before === null || value.after === null)) {
    fail(`${label} revise requires before and after`);
  }
  if (value.operation === 'add' && value.after === null) fail(`${label} add requires after`);
  if (value.operation === 'remove' && value.before === null) fail(`${label} remove requires before`);
}

export function validateRoleId(roleId) {
  string(roleId, 'roleId', { max: MAX_ROLE_ID });
  return roleId;
}

export function validatePersonalityStateInput(input) {
  exactKeys(input, ENTITY_PAYLOAD_KEYS[ENTITY_TYPES.PERSONALITY_STATE], 'personality state input');
  string(input.selfDescription, 'selfDescription');
  array(input.tendencies, 'tendencies', tendency);
  array(input.tensions, 'tensions', tension);
  uniqueObjectIds(input.tendencies, 'tendencies');
  uniqueObjectIds(input.tensions, 'tensions');
  return input;
}

export function validateMemoryInput(input) {
  exactKeys(input, ENTITY_PAYLOAD_KEYS[ENTITY_TYPES.MEMORY], 'memory input');
  enumValue(input.kind, MEMORY_KINDS, 'kind');
  string(input.content, 'content');
  confidence(input.confidence, 'confidence');
  enumValue(input.status, MEMORY_STATUSES, 'status');
  sourceRefs(input.sourceRefs);
  identifier(input.supersedesId, 'supersedesId', { nullable: true, prefix: 'mem' });
  identifier(input.supersededById, 'supersededById', { nullable: true, prefix: 'mem' });
  return input;
}

export function validateSessionSummaryInput(input) {
  if (Object.hasOwn(input || {}, 'sourceSessionId')) return validateAutomaticSessionSummaryInput(input);
  exactKeys(input, ENTITY_PAYLOAD_KEYS[ENTITY_TYPES.SESSION_SUMMARY], 'session summary input');
  string(input.sourceSessionRef, 'sourceSessionRef', { nullable: true, max: MAX_ID });
  isoTimestamp(input.startedAt, 'startedAt');
  isoTimestamp(input.endedAt, 'endedAt');
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) fail('endedAt must not be before startedAt');
  string(input.summary, 'summary');
  array(input.keyEvents, 'keyEvents', (item, label) => string(item, label));
  sourceRefs(input.sourceRefs);
  return input;
}

export function validateAutomaticSessionSummaryInput(input) {
  exactKeys(input, AUTOMATIC_SESSION_SUMMARY_PAYLOAD_KEYS, 'automatic session summary input');
  string(input.sourceSessionId, 'sourceSessionId', { max: MAX_ID });
  if (!/^ses_[a-f0-9]{64}$/.test(input.sourceSessionId)) fail('sourceSessionId has an invalid identity');
  isoTimestamp(input.startedAt, 'startedAt');
  isoTimestamp(input.endedAt, 'endedAt');
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) fail('endedAt must not be before startedAt');
  uniqueStrings(input.sourceMessageIds, 'sourceMessageIds', { min: 1 });
  string(input.sourceDigest, 'sourceDigest', { max: 64 });
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) fail('sourceDigest must be lowercase SHA-256');
  array(input.keyEvents, 'keyEvents', (item, label) => string(item, label));
  emotionalSummary(input.emotionalSummary);
  array(input.importantDecisions, 'importantDecisions', (item, label) => string(item, label));
  summaryGeneration(input.generation);
  return input;
}

export function validateExperienceInterpretationInput(input) {
  exactKeys(input, ENTITY_PAYLOAD_KEYS[ENTITY_TYPES.EXPERIENCE_INTERPRETATION], 'experience interpretation input');
  identifier(input.sessionSummaryId, 'sessionSummaryId', { prefix: 'sum' });
  string(input.meaning, 'meaning');
  string(input.selfImpact, 'selfImpact');
  array(input.hypotheses, 'hypotheses', hypothesis);
  sourceRefs(input.sourceRefs);
  return input;
}

export function validateChangeProposalInput(input) {
  exactKeys(input, ['interpretationIds', 'outcome', 'rationale', 'proposedChanges'], 'change proposal input');
  array(input.interpretationIds, 'interpretationIds', (item, label) => identifier(item, label, { prefix: 'exp' }), { min: 1 });
  if (new Set(input.interpretationIds).size !== input.interpretationIds.length) fail('interpretationIds must be unique');
  enumValue(input.outcome, PROPOSAL_OUTCOMES, 'outcome');
  string(input.rationale, 'rationale');
  array(input.proposedChanges, 'proposedChanges', proposedChange);
  if (input.outcome === 'change' && input.proposedChanges.length === 0) {
    fail('outcome=change requires at least one proposed change');
  }
  return input;
}

export function validateProposalStatusUpdate(input) {
  exactKeys(input, ['status', 'decisionNote', 'expectedRevision'], 'proposal status update');
  enumValue(input.status, ['accepted', 'rejected'], 'status');
  string(input.decisionNote, 'decisionNote', { nullable: true });
  positiveInteger(input.expectedRevision, 'expectedRevision');
  return input;
}

export function validateExpectedRevision(value) {
  return positiveInteger(value, 'expectedRevision');
}

export function validateEntityId(entityType, id) {
  const prefixes = {
    personality_state: 'ps', memory: 'mem', session_summary: 'sum',
    experience_interpretation: 'exp', change_proposal: 'prop'
  };
  return identifier(id, `${entityType} id`, { prefix: prefixes[entityType] });
}

export function validateListOptions(options, allowedFilters) {
  exactKeys(options, Object.keys(options), 'list options');
  for (const key of Object.keys(options)) {
    if (![...allowedFilters, 'limit'].includes(key)) fail(`list option ${key} is not supported`);
  }
  if (Object.hasOwn(options, 'limit') && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    fail('limit must be a positive integer');
  }
  return options;
}

function validateCommonEntity(entity, expectedType) {
  const payloadKeys = expectedType === ENTITY_TYPES.SESSION_SUMMARY && Object.hasOwn(entity || {}, 'sourceSessionId')
    ? AUTOMATIC_SESSION_SUMMARY_PAYLOAD_KEYS
    : ENTITY_PAYLOAD_KEYS[expectedType];
  if (!payloadKeys) fail('entityType is invalid');
  exactKeys(entity, [...COMMON_ENTITY_KEYS, ...payloadKeys], `${expectedType} entity`);
  validateEntityId(expectedType, entity.id);
  if (entity.entityType !== expectedType) fail('entityType does not match');
  if (entity.schemaVersion !== PERSONA_SCHEMA_VERSION) fail('schemaVersion does not match');
  validateRoleId(entity.roleId);
  isoTimestamp(entity.createdAt, 'createdAt');
  isoTimestamp(entity.updatedAt, 'updatedAt');
  if (Date.parse(entity.updatedAt) < Date.parse(entity.createdAt)) fail('updatedAt predates createdAt');
  positiveInteger(entity.revision, 'revision');
}

export function validatePersistedEntity(entity, expectedType) {
  validateCommonEntity(entity, expectedType);
  const payloadKeys = expectedType === ENTITY_TYPES.SESSION_SUMMARY && Object.hasOwn(entity, 'sourceSessionId')
    ? AUTOMATIC_SESSION_SUMMARY_PAYLOAD_KEYS
    : ENTITY_PAYLOAD_KEYS[expectedType];
  const payload = Object.fromEntries(payloadKeys.map(key => [key, entity[key]]));
  if (expectedType === ENTITY_TYPES.PERSONALITY_STATE) validatePersonalityStateInput(payload);
  if (expectedType === ENTITY_TYPES.MEMORY) validateMemoryInput(payload);
  if (expectedType === ENTITY_TYPES.SESSION_SUMMARY) validateSessionSummaryInput(payload);
  if (expectedType === ENTITY_TYPES.EXPERIENCE_INTERPRETATION) validateExperienceInterpretationInput(payload);
  if (expectedType === ENTITY_TYPES.CHANGE_PROPOSAL) {
    const creationPayload = {
      interpretationIds: entity.interpretationIds,
      outcome: entity.outcome,
      rationale: entity.rationale,
      proposedChanges: entity.proposedChanges
    };
    validateChangeProposalInput(creationPayload);
    enumValue(entity.status, PROPOSAL_STATUSES, 'status');
    if (entity.status === 'pending') {
      if (entity.decisionNote !== null || entity.decidedAt !== null) fail('pending proposal has decision fields');
    } else {
      string(entity.decisionNote, 'decisionNote', { nullable: true });
      isoTimestamp(entity.decidedAt, 'decidedAt');
    }
  }
  return entity;
}
