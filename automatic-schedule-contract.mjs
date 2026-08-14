const OWNER = new Set(['android-v1', 'web-v1']);
const OPERATION = new Set(['schedule', 'pause', 'disable']);
const KIND = new Set(['chat', 'moment']);
const MODE = new Set(['planned', 'dice']);
const SOURCE_TYPE = new Set([
  'bootstrap', 'settings_change', 'direct_input', 'direct_terminal',
  'proactive_terminal', 'failure_retry', 'lifecycle', 'migration_claim'
]);
const TRANSITION_KEYS = Object.freeze([
  'authorityEpoch', 'characterId', 'deviceId', 'dueAt',
  'expectedPreviousJobId', 'generation', 'jobId', 'kind', 'mode',
  'operation', 'owner', 'policyChecksum', 'policyRevision',
  'protocolVersion', 'scheduleChecksum', 'sourceChecksum', 'sourceId',
  'sourceType', 'streamKey', 'transitionChecksum'
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EPOCH_PATTERN = /^[a-f0-9]{32}$/;
const STATUS_KEYS = Object.freeze(['characterId', 'deviceId', 'kind']);
const DELIVERY_KEYS = Object.freeze([
  'authorityEpoch', 'generation', 'jobId', 'protocolVersion', 'streamKey'
]);
const DEFER_KEYS = Object.freeze([...DELIVERY_KEYS, 'awaitingAck', 'nextAttemptAt']);

function contract(field) {
  const error = new Error(`invalid automatic schedule ${field}`);
  error.code = 'SCHEDULE_CONTRACT_INVALID';
  return error;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalScheduleJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function scheduleStreamKey({ deviceId, characterId, kind }) {
  return `active:${encodeURIComponent(deviceId)}:${encodeURIComponent(characterId)}:${kind}`;
}

function assertExactKeys(value, expected, field) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw contract(field);
  }
}

export function validateScheduleStatusQuery(value) {
  assertExactKeys(value, STATUS_KEYS, 'status keys');
  if (typeof value.deviceId !== 'string' || typeof value.characterId !== 'string'
      || !ID_PATTERN.test(value.deviceId) || !ID_PATTERN.test(value.characterId)
      || !KIND.has(value.kind)) {
    throw contract('status');
  }
  return Object.freeze(structuredClone(value));
}

export function validateScheduleDeliveryReference(value, { defer = false } = {}) {
  assertExactKeys(value, defer ? DEFER_KEYS : DELIVERY_KEYS, 'delivery keys');
  if (value.protocolVersion !== 2 || typeof value.streamKey !== 'string'
      || typeof value.authorityEpoch !== 'string' || !EPOCH_PATTERN.test(value.authorityEpoch)
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || typeof value.jobId !== 'string' || !ID_PATTERN.test(value.jobId)) {
    throw contract('delivery');
  }
  if (defer && (typeof value.awaitingAck !== 'boolean'
      || !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt <= 0)) {
    throw contract('delivery defer');
  }
  return Object.freeze(structuredClone(value));
}

export async function scheduleTransitionChecksum(value) {
  const { protocolVersion, jobId, transitionChecksum, scheduleChecksum, ...basis } = value;
  return sha256(canonicalScheduleJson(basis));
}

export async function scheduleSemanticChecksum(value) {
  const { protocolVersion, scheduleChecksum, ...basis } = value;
  return sha256(canonicalScheduleJson(basis));
}

export async function validateScheduleTransition(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw contract('shape');
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...TRANSITION_KEYS].sort())) throw contract('keys');
  if (value.protocolVersion !== 2) throw contract('protocolVersion');
  if (!OWNER.has(value.owner) || !OPERATION.has(value.operation)
      || !KIND.has(value.kind) || !SOURCE_TYPE.has(value.sourceType)) {
    throw contract('enum');
  }
  if (typeof value.deviceId !== 'string' || typeof value.characterId !== 'string'
      || typeof value.sourceId !== 'string' || !ID_PATTERN.test(value.deviceId)
      || !ID_PATTERN.test(value.characterId) || !ID_PATTERN.test(value.sourceId)) {
    throw contract('identity');
  }
  if (typeof value.authorityEpoch !== 'string' || !EPOCH_PATTERN.test(value.authorityEpoch)) {
    throw contract('authorityEpoch');
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw contract('generation');
  if (!Number.isSafeInteger(value.policyRevision) || value.policyRevision < 1) throw contract('policyRevision');
  if (value.expectedPreviousJobId !== null
      && (typeof value.expectedPreviousJobId !== 'string' || !ID_PATTERN.test(value.expectedPreviousJobId))) {
    throw contract('expectedPreviousJobId');
  }
  if (typeof value.sourceChecksum !== 'string' || typeof value.policyChecksum !== 'string'
      || typeof value.transitionChecksum !== 'string' || typeof value.scheduleChecksum !== 'string'
      || !SHA256_PATTERN.test(value.sourceChecksum)
      || !SHA256_PATTERN.test(value.policyChecksum)
      || !SHA256_PATTERN.test(value.transitionChecksum)
      || !SHA256_PATTERN.test(value.scheduleChecksum)) {
    throw contract('checksum');
  }
  if (typeof value.streamKey !== 'string' || value.streamKey !== scheduleStreamKey(value)) {
    throw contract('streamKey');
  }

  if (value.operation === 'schedule') {
    if (typeof value.jobId !== 'string' || !ID_PATTERN.test(value.jobId) || !Number.isSafeInteger(value.dueAt)
        || value.dueAt <= 0 || !MODE.has(value.mode)) {
      throw contract('schedule');
    }
    const prefix = value.kind === 'moment' ? 'mom' : 'pro';
    const expectedJobId = `${prefix}_${value.transitionChecksum.slice(0, 16)}_${value.generation}`;
    if (value.jobId !== expectedJobId) throw contract('jobId');
  } else if (value.jobId !== null || value.dueAt !== null || value.mode !== null) {
    throw contract('inactive');
  }

  const normalized = structuredClone(value);
  if (await scheduleTransitionChecksum(normalized) !== normalized.transitionChecksum
      || await scheduleSemanticChecksum(normalized) !== normalized.scheduleChecksum) {
    throw contract('checksum');
  }
  return Object.freeze(normalized);
}
