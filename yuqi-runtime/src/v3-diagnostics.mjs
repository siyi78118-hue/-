import { COMPARISON_CRITICAL_CODES } from './comparison-evaluator.mjs';

const TOP_LEVEL_KEYS = new Set([
  'turn', 'authority', 'visibleGroup', 'outbox', 'lane', 'pipeline', 'comparison', 'timings'
]);
const TURN_KEYS = new Set([
  'turnId', 'kind', 'state', 'protocolVersion', 'resultAuthorityVersion',
  'turnRevision', 'inputVisibilitySequence', 'inputClearEpoch', 'createdAt', 'updatedAt'
]);
const AUTHORITY_KEYS = new Set([
  'kind', 'lineageKey', 'lineageRevision', 'origin', 'commitPayloadVersion',
  'commitChecksum', 'chainValid', 'errorCode', 'retryAllowed'
]);
const VISIBLE_GROUP_KEYS = new Set(['groupId', 'authoritativeTurnId', 'redacted']);
const OUTBOX_KEYS = new Set(['authorityGroupId', 'peerId', 'state', 'recoveryAckSeq']);
const LANE_KEYS = new Set(['key', 'revision', 'localSequence', 'clearEpoch', 'clearedThroughSequence']);
const PIPELINE_KEYS = new Set(['turnPin', 'currentRollout']);
const TURN_PIN_KEYS = new Set([
  'authoritativeReleaseId', 'comparisonReleaseId', 'authoritativePipelineChecksum',
  'comparisonPipelineChecksum', 'rolloutRevision', 'evidenceEpoch', 'shadowEpoch',
  'canaryEpoch', 'canarySlot'
]);
const CURRENT_ROLLOUT_KEYS = new Set([
  'candidatePhase', 'revision', 'evidenceEpoch', 'stableReleaseId', 'candidateReleaseId', 'lastReasonCode'
]);
const COMPARISON_KEYS = new Set(['stateCounts', 'staleCount', 'criticalCodes']);
const COMPARISON_STATES = new Set(['queued', 'retry_wait', 'running', 'completed', 'failed', 'cancelled']);
const COMPARISON_CRITICAL_CODE_SET = new Set(COMPARISON_CRITICAL_CODES);
const TIMINGS_KEYS = new Set(['acceptedAt', 'updatedAt', 'committedAt']);
const AUTHORITY_KINDS = new Set([
  'legacy_turn_identity', 'pc_canonical_live', 'android_fallback', 'canonical_failure', 'redacted'
]);
const TERMINAL_STATES = new Set(['open', 'queued', 'running', 'committed', 'delivered', 'completed', 'failed', 'fallback', 'cancelled']);
const OUTBOX_STATES = new Set([
  'waiting', 'pending', 'mailboxed', 'confirmed', 'redaction_pending', 'redacted',
  'not_applicable_external_visibility', 'quarantined', 'superseded', 'superseded_mailboxed'
]);
const HEX64 = /^[a-f0-9]{64}$/;

export class V3DiagnosticAuthorityConflict extends Error {
  constructor(message = 'V3 diagnostic authority conflict') {
    super(message);
    this.name = 'V3DiagnosticAuthorityConflict';
    this.code = 'V3_DIAGNOSTIC_AUTHORITY_CONFLICT';
  }
}

function fail(message) {
  throw new V3DiagnosticAuthorityConflict(message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exact(value, keys, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains unknown or missing fields`);
  }
}

function text(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a string`);
  return value;
}

function integer(value, label, { nullable = false, min = 0 } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    fail(`${label} must be a safe integer`);
  }
  return value;
}

function checksum(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HEX64.test(value)) fail(`${label} checksum conflict`);
  return value;
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function validateTurn(turn) {
  exact(turn, TURN_KEYS, 'turn');
  text(turn.turnId, 'turn.turnId');
  text(turn.kind, 'turn.kind');
  if (!TERMINAL_STATES.has(turn.state)) fail('turn.state conflict');
  integer(turn.protocolVersion, 'turn.protocolVersion', { min: 0 });
  integer(turn.resultAuthorityVersion, 'turn.resultAuthorityVersion', { min: 0 });
  integer(turn.turnRevision, 'turn.turnRevision');
  integer(turn.inputVisibilitySequence, 'turn.inputVisibilitySequence');
  integer(turn.inputClearEpoch, 'turn.inputClearEpoch');
  integer(turn.createdAt, 'turn.createdAt');
  integer(turn.updatedAt, 'turn.updatedAt');
}

function validateAuthority(authority) {
  exact(authority, AUTHORITY_KEYS, 'authority');
  if (!AUTHORITY_KINDS.has(authority.kind)) fail('authority.kind conflict');
  text(authority.lineageKey, 'authority.lineageKey', { nullable: true });
  integer(authority.lineageRevision, 'authority.lineageRevision', { nullable: true });
  text(authority.origin, 'authority.origin', { nullable: true });
  text(authority.commitPayloadVersion, 'authority.commitPayloadVersion', { nullable: true });
  checksum(authority.commitChecksum, 'authority.commitChecksum', { nullable: true });
  if (typeof authority.chainValid !== 'boolean') fail('authority.chainValid conflict');
  text(authority.errorCode, 'authority.errorCode', { nullable: true });
  if (authority.kind === 'canonical_failure') {
    if (typeof authority.retryAllowed !== 'boolean') fail('authority.retryAllowed conflict');
  } else if (authority.retryAllowed !== null) {
    fail('authority.retryAllowed conflict');
  }
}

function validateVisibleGroup(group) {
  if (group === null) return;
  exact(group, VISIBLE_GROUP_KEYS, 'visibleGroup');
  text(group.groupId, 'visibleGroup.groupId');
  text(group.authoritativeTurnId, 'visibleGroup.authoritativeTurnId');
  if (typeof group.redacted !== 'boolean') fail('visibleGroup.redacted conflict');
}

function validateOutbox(outbox) {
  if (outbox === null) return;
  exact(outbox, OUTBOX_KEYS, 'outbox');
  text(outbox.authorityGroupId, 'outbox.authorityGroupId', { nullable: true });
  text(outbox.peerId, 'outbox.peerId', { nullable: true });
  if (!OUTBOX_STATES.has(outbox.state)) fail('outbox.state conflict');
  integer(outbox.recoveryAckSeq, 'outbox.recoveryAckSeq');
}

function validateLane(lane) {
  if (lane === null) return;
  exact(lane, LANE_KEYS, 'lane');
  text(lane.key, 'lane.key');
  integer(lane.revision, 'lane.revision');
  integer(lane.localSequence, 'lane.localSequence');
  integer(lane.clearEpoch, 'lane.clearEpoch');
  integer(lane.clearedThroughSequence, 'lane.clearedThroughSequence');
}

function validateTurnPin(pin) {
  if (pin === null) return;
  exact(pin, TURN_PIN_KEYS, 'pipeline.turnPin');
  text(pin.authoritativeReleaseId, 'pipeline.turnPin.authoritativeReleaseId');
  text(pin.comparisonReleaseId, 'pipeline.turnPin.comparisonReleaseId', { nullable: true });
  checksum(pin.authoritativePipelineChecksum, 'pipeline.turnPin.authoritativePipelineChecksum');
  checksum(pin.comparisonPipelineChecksum, 'pipeline.turnPin.comparisonPipelineChecksum', { nullable: true });
  integer(pin.rolloutRevision, 'pipeline.turnPin.rolloutRevision');
  integer(pin.evidenceEpoch, 'pipeline.turnPin.evidenceEpoch');
  integer(pin.shadowEpoch, 'pipeline.turnPin.shadowEpoch');
  integer(pin.canaryEpoch, 'pipeline.turnPin.canaryEpoch');
  integer(pin.canarySlot, 'pipeline.turnPin.canarySlot', { nullable: true });
}

function validateCurrentRollout(rollout) {
  if (rollout === null) return;
  exact(rollout, CURRENT_ROLLOUT_KEYS, 'pipeline.currentRollout');
  if (!['none', 'shadow', 'canary', 'rolled_back'].includes(rollout.candidatePhase)) fail('rollout phase conflict');
  integer(rollout.revision, 'pipeline.currentRollout.revision');
  integer(rollout.evidenceEpoch, 'pipeline.currentRollout.evidenceEpoch');
  text(rollout.stableReleaseId, 'pipeline.currentRollout.stableReleaseId', { nullable: true });
  text(rollout.candidateReleaseId, 'pipeline.currentRollout.candidateReleaseId', { nullable: true });
  text(rollout.lastReasonCode, 'pipeline.currentRollout.lastReasonCode', { nullable: true });
}

function validatePipeline(pipeline) {
  exact(pipeline, PIPELINE_KEYS, 'pipeline');
  validateTurnPin(pipeline.turnPin);
  validateCurrentRollout(pipeline.currentRollout);
}

function validateComparison(comparison) {
  if (comparison === null) return;
  exact(comparison, COMPARISON_KEYS, 'comparison');
  object(comparison.stateCounts, 'comparison.stateCounts');
  for (const [key, value] of Object.entries(comparison.stateCounts)) {
    if (!COMPARISON_STATES.has(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      fail('comparison.stateCounts conflict');
    }
  }
  integer(comparison.staleCount, 'comparison.staleCount');
  if (!Array.isArray(comparison.criticalCodes)
    || comparison.criticalCodes.some(code => typeof code !== 'string' || !COMPARISON_CRITICAL_CODE_SET.has(code))
    || new Set(comparison.criticalCodes).size !== comparison.criticalCodes.length) {
    fail('comparison.criticalCodes conflict');
  }
}

function validateTimings(timings) {
  exact(timings, TIMINGS_KEYS, 'timings');
  integer(timings.acceptedAt, 'timings.acceptedAt', { nullable: true });
  integer(timings.updatedAt, 'timings.updatedAt');
  integer(timings.committedAt, 'timings.committedAt', { nullable: true });
  if (timings.acceptedAt !== null) fail('timings.acceptedAt is not independently persisted');
}

export function projectV3Diagnostics(input) {
  exact(input, TOP_LEVEL_KEYS, 'diagnostic projection');
  validateTurn(input.turn);
  validateAuthority(input.authority);
  validateVisibleGroup(input.visibleGroup);
  validateOutbox(input.outbox);
  validateLane(input.lane);
  validatePipeline(input.pipeline);
  validateComparison(input.comparison);
  validateTimings(input.timings);

  if (input.authority.kind === 'redacted') {
    return {
      turn: {
        turnId: input.turn.turnId,
        state: input.turn.state,
        resultAuthorityVersion: input.turn.resultAuthorityVersion
      },
      authority: {
        kind: 'redacted'
      },
      visibleGroup: null,
      outbox: null,
      lane: null,
      pipeline: null,
      comparison: null,
      timings: null
    };
  }

  if (input.authority.kind === 'legacy_turn_identity') {
    if (input.turn.resultAuthorityVersion !== 0 || input.visibleGroup || input.outbox
      || input.lane || input.pipeline.turnPin || input.pipeline.currentRollout || input.comparison) {
      fail('legacy diagnostic has canonical authority rows');
    }
  }
  if (input.authority.kind === 'pc_canonical_live' && input.visibleGroup?.redacted) {
    fail('live diagnostic has redacted group');
  }
  if (input.authority.kind === 'android_fallback'
    && (!input.outbox || input.outbox.authorityGroupId === null
      || input.outbox.peerId !== null
      || input.outbox.state !== 'not_applicable_external_visibility')) {
    fail('android fallback diagnostic outbox conflict');
  }
  if (input.authority.kind === 'canonical_failure'
    && (!input.outbox || input.outbox.authorityGroupId !== null || typeof input.outbox.peerId !== 'string')) {
    fail('canonical failure diagnostic outbox conflict');
  }
  if (input.authority.kind === 'pc_canonical_live'
    && (!input.outbox || typeof input.outbox.authorityGroupId !== 'string' || typeof input.outbox.peerId !== 'string')) {
    fail('canonical live diagnostic outbox conflict');
  }
  return clone(input);
}

export function isV3DiagnosticAuthorityConflict(error) {
  return error instanceof V3DiagnosticAuthorityConflict;
}
