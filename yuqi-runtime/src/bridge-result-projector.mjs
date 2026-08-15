import { contentHash } from './protocol.mjs';
import { normalizeRolePlanOperationList } from './role-plan-operation-contract.mjs';

const FAILURE_KEYS = Object.freeze([
  'protocolVersion', 'type', 'turnId', 'roleId', 'authorityLineageKey',
  'lineageRevision', 'turnRevision', 'laneKey', 'laneRevision', 'retryOfTurnId',
  'inputVisibilitySequence', 'inputClearEpoch', 'generationFingerprint',
  'releaseId', 'state', 'errorCode', 'failureClass', 'retryAllowed', 'failedAt'
]);
const FAILURE_CODES = Object.freeze({
  transient: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
  deterministic: 'YUQI_DETERMINISTIC_EXECUTION_FAILURE'
});
const CANONICAL_RESULT_KEYS = Object.freeze([
  'protocolVersion', 'turnId', 'roleId', 'authorityOrigin', 'authorityLineageKey',
  'visibleGroupId', 'lineageRevision', 'turnRevision', 'laneKey', 'laneRevision',
  'inputVisibilitySequence', 'inputClearEpoch', 'generationFingerprint', 'releaseId',
  'commitPayloadVersion', 'commitChecksum', 'terminalDisposition', 'replyParts', 'actions'
]);
const CANONICAL_ACTION_KINDS = Object.freeze(new Set([
  'payment_accept', 'payment_decline',
  'moment_create', 'moment_like', 'moment_comment', 'moment_reply',
  'role_plan_create', 'role_plan_update', 'role_plan_cancel', 'role_plan_pause',
  'role_plan_resume', 'role_plan_complete',
  'life_episode_create', 'life_episode_update', 'life_episode_cancel',
  'relationship_transition'
]));

const CANONICAL_AUTHORITY_CONFLICT_MESSAGES = Object.freeze(new Set([
  'canonical bridge lookup turn conflict',
  'canonical bridge lineage conflict',
  'canonical bridge receipt conflict',
  'canonical bridge join conflict',
  'canonical bridge reply checksum conflict',
  'canonical bridge result authority conflict',
  'canonical bridge result projection conflict',
  'canonical visible group authority conflict',
  'canonical visible group receipt authority conflict',
  'canonical visible group lineage attempt commitment conflict',
  'canonical visible group turn kind anchor conflict',
  'canonical visible group manifest authority conflict',
  'canonical visible group item authority conflict',
  'canonical visible group action authority conflict',
  'canonical visible group tombstone commitment conflict',
  'canonical visible group job authority conflict',
  'canonical visible group stance authority conflict',
  'canonical visible group cognitive state authority conflict',
  'canonical visible group delivery authority conflict',
  'canonical visible delivery target conflict',
  'canonical visible delivery quarantine state conflict',
  'canonical visible delivery quarantine diagnostic conflict',
  'canonical cloud delivery authority conflict',
  'canonical cloud delivery payload checksum conflict',
  'canonical failure authority conflict',
  'canonical failure target set conflict',
  'canonical failure retry permission conflict',
  'canonical failure shape conflict',
  'canonical failure delivery authority conflict',
  'canonical failure delivery checksum conflict',
  'canonical failure delivery lease conflict',
  'canonical failure delivery lease time conflict',
  'canonical failure delivery relay conflict',
  'canonical failure delivery state conflict',
  'canonical failure delivery time conflict',
  'canonical failure delivery quarantine conflict',
  'canonical failure delivery quarantine diagnostic conflict',
  'canonical failure delivery quarantine reason conflict',
  'canonical failure delivery quarantine snapshot conflict',
  'canonical failure delivery quarantine target conflict',
  'canonical failure relay identity conflict'
]));
const CANONICAL_FAILURE_INVALID_FIELDS = Object.freeze(new Set([
  'turnId', 'roleId', 'authorityLineageKey', 'lineageRevision', 'turnRevision',
  'laneKey', 'laneRevision', 'retryOfTurnId', 'inputVisibilitySequence',
  'inputClearEpoch', 'generationFingerprint', 'releaseId', 'failedAt'
]));

export function isCanonicalAuthorityConflictError(error) {
  if (!(error instanceof Error) || error instanceof TypeError) return false;
  if (typeof error.message !== 'string') return false;
  return CANONICAL_AUTHORITY_CONFLICT_MESSAGES.has(error.message)
    || (error.message.startsWith('invalid canonical failure ')
      && CANONICAL_FAILURE_INVALID_FIELDS.has(error.message.slice('invalid canonical failure '.length)));
}

function requireString(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid canonical failure ${name}`);
  return value;
}

function requireSafeInteger(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid canonical failure ${name}`);
  return value;
}

export function projectCanonicalFailureSnapshotForWire(authority) {
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    throw new Error('canonical failure authority is required');
  }
  const { turn, lineage, failure } = authority;
  if (!turn || !failure
    || Number(turn.resultAuthorityVersion) !== 1
    || Number(turn.protocolVersion) !== 3
    || turn.state !== 'failed') {
    throw new Error('canonical failure authority conflict');
  }
  if (!['transient', 'deterministic'].includes(failure.failureClass)
    || typeof failure.retryAllowed !== 'boolean'
    || (failure.retryAllowed && failure.failureClass !== 'transient')
    || failure.code !== FAILURE_CODES[failure.failureClass]
    || Object.keys(failure).sort().join(',') !== 'code,failedAt,failureClass,message,name,retryAllowed'
    || typeof failure.name !== 'string' || failure.name.length === 0
    || typeof failure.message !== 'string' || failure.message.length > 2000
    || !Number.isSafeInteger(failure.failedAt) || failure.failedAt <= 0) {
    throw new Error('canonical failure retry permission conflict');
  }
  const raw = {
    protocolVersion: 3,
    type: 'BACKLOG_FAILED',
    turnId: requireString(turn.turnId, 'turnId'),
    roleId: requireString(turn.characterId, 'roleId'),
    authorityLineageKey: requireString(turn.authorityLineageKey, 'authorityLineageKey'),
    lineageRevision: requireSafeInteger(authority.lineageRevision, 'lineageRevision'),
    turnRevision: requireSafeInteger(turn.turnRevision, 'turnRevision'),
    laneKey: requireString(turn.laneKey, 'laneKey'),
    laneRevision: requireSafeInteger(turn.laneRevision, 'laneRevision'),
    retryOfTurnId: requireString(turn.retryOfTurnId, 'retryOfTurnId', { nullable: true }),
    inputVisibilitySequence: requireSafeInteger(turn.inputVisibilitySequence, 'inputVisibilitySequence'),
    inputClearEpoch: requireSafeInteger(turn.inputClearEpoch, 'inputClearEpoch'),
    generationFingerprint: requireString(turn.generationFingerprint, 'generationFingerprint', { nullable: true }),
    releaseId: requireString(turn.authoritativeReleaseId, 'releaseId'),
    state: 'failed',
    errorCode: failure.code,
    failureClass: failure.failureClass,
    retryAllowed: failure.retryAllowed,
    failedAt: requireSafeInteger(failure.failedAt, 'failedAt')
  };
  if (Object.keys(raw).length !== FAILURE_KEYS.length) throw new Error('canonical failure shape conflict');
  return { ...raw, rawStatusChecksum: contentHash(raw) };
}

export function projectCanonicalFailureForWire(authority) {
  const { turn, lineage } = authority || {};
  if (!lineage || lineage.latestTurnId !== turn?.turnId || lineage.state !== 'open') {
    throw new Error('canonical failure authority conflict');
  }
  return projectCanonicalFailureSnapshotForWire({
    ...authority,
    lineageRevision: lineage.revision
  });
}

function projectionConflict() {
  throw new Error('canonical bridge result projection conflict');
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isChecksum(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function closedCanonicalResult(canonicalResult) {
  if (!canonicalResult || typeof canonicalResult !== 'object' || Array.isArray(canonicalResult)) {
    projectionConflict();
  }
  if (canonicalResult.status === 'redacted') {
    const commitChecksum = requireString(canonicalResult.commitChecksum, 'commitChecksum');
    if (!isChecksum(commitChecksum)) projectionConflict();
    return {
      status: 'redacted',
      deliverable: false,
      turnId: requireString(canonicalResult.turnId, 'turnId'),
      authorityLineageKey: requireString(canonicalResult.authorityLineageKey, 'authorityLineageKey'),
      visibleGroupId: requireString(canonicalResult.visibleGroupId, 'visibleGroupId'),
      commitChecksum
    };
  }
  if (Number(canonicalResult.protocolVersion) !== 3
    || !['visible', 'action_only', 'skip'].includes(canonicalResult.terminalDisposition)
    || !Array.isArray(canonicalResult.replyParts)
    || !Array.isArray(canonicalResult.actions)) {
    projectionConflict();
  }
  const result = Object.fromEntries(CANONICAL_RESULT_KEYS.map(key => [key, structuredClone(canonicalResult[key])]));
  for (const key of [
    'turnId', 'roleId', 'authorityOrigin', 'authorityLineageKey', 'visibleGroupId', 'laneKey',
    'releaseId', 'commitPayloadVersion', 'commitChecksum'
  ]) {
    if (typeof result[key] !== 'string' || result[key].length === 0) projectionConflict();
  }
  for (const key of ['lineageRevision', 'turnRevision', 'laneRevision', 'inputVisibilitySequence', 'inputClearEpoch']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) projectionConflict();
  }
  if (!isChecksum(result.commitChecksum)) projectionConflict();
  result.replyParts.forEach((part, ordinal) => {
    if (!isPlainObject(part)
      || part.ordinal !== ordinal
      || typeof part.messageId !== 'string' || part.messageId.length === 0
      || typeof part.content !== 'string' || !isChecksum(part.itemChecksum)) {
      projectionConflict();
    }
  });
  result.actions.forEach((action, ordinal) => {
    if (!isPlainObject(action)
      || action.ordinal !== ordinal
      || typeof action.actionId !== 'string' || action.actionId.length === 0
      || !CANONICAL_ACTION_KINDS.has(action.kind)
      || typeof action.targetKey !== 'string' || action.targetKey.length === 0
      || typeof action.targetRevision !== 'string' || action.targetRevision.length === 0
      || !isPlainObject(action.payload) || !isChecksum(action.actionChecksum)) {
      projectionConflict();
    }
  });
  try {
    const rolePlanOperations = result.actions
      .filter(action => action.kind.startsWith('role_plan_'))
      .map(action => action.payload);
    if (rolePlanOperations.length) normalizeRolePlanOperationList(rolePlanOperations);
  } catch {
    projectionConflict();
  }
  const { terminalDisposition, replyParts, actions } = result;
  if ((terminalDisposition === 'visible' && replyParts.length === 0)
    || (terminalDisposition === 'action_only' && (replyParts.length !== 0 || actions.length === 0))
    || (terminalDisposition === 'skip' && (replyParts.length !== 0 || actions.length !== 0))) {
    projectionConflict();
  }
  return result;
}

function singleCompatibilityAction(result, property, action) {
  if (result[property] !== null) projectionConflict();
  result[property] = structuredClone(action.payload);
}

function legacyActionFields(actions) {
  const fields = {
    paymentAction: null,
    momentAction: null,
    relationshipStageAction: null,
    rolePlanOperations: [],
    lifeAdjustment: null
  };
  for (const action of actions) {
    switch (action.kind) {
      case 'payment_accept':
        if (fields.paymentAction !== null) projectionConflict();
        fields.paymentAction = 'received';
        break;
      case 'payment_decline':
        if (fields.paymentAction !== null) projectionConflict();
        fields.paymentAction = 'refused';
        break;
      case 'moment_create':
      case 'moment_like':
      case 'moment_comment':
      case 'moment_reply':
        singleCompatibilityAction(fields, 'momentAction', action);
        break;
      case 'relationship_transition':
        singleCompatibilityAction(fields, 'relationshipStageAction', action);
        break;
      case 'role_plan_create':
      case 'role_plan_update':
      case 'role_plan_cancel':
      case 'role_plan_pause':
      case 'role_plan_resume':
      case 'role_plan_complete':
        fields.rolePlanOperations.push(structuredClone(action.payload));
        break;
      case 'life_episode_create':
      case 'life_episode_update':
      case 'life_episode_cancel':
        singleCompatibilityAction(fields, 'lifeAdjustment', action);
        break;
      default:
        projectionConflict();
    }
  }
  return fields;
}

export function projectBridgeResultForWire(canonicalResult, wireVersion) {
  if (![2, 3].includes(Number(wireVersion))) {
    throw new Error('unsupported bridge result wire version');
  }
  const canonical = closedCanonicalResult(canonicalResult);
  if (Number(wireVersion) === 3) return canonical;
  if (canonical.status === 'redacted') {
    return {
      status: 'redacted',
      deliverable: false,
      turnId: canonical.turnId,
      terminal: true,
      reply: null,
      replyParts: [],
      actions: [],
      deliveryItems: []
    };
  }
  const replyParts = canonical.replyParts.map(part => structuredClone(part));
  const actions = canonical.actions.map(action => structuredClone(action));
  const disposition = canonical.terminalDisposition;
  const reply = replyParts.length === 0 ? null : {
    ...replyParts[0],
    content: replyParts.map(part => String(part.content || '')).join('\n')
  };
  return {
    turnId: canonical.turnId,
    state: 'committed',
    terminal: true,
    allowFallback: false,
    action: disposition === 'skip' ? 'skip' : 'send',
    reply,
    replyParts,
    actions,
    deliveryItems: [
      ...replyParts.map(part => ({ kind: 'message', id: part.messageId, checksum: part.itemChecksum })),
      ...actions.map(action => ({ kind: 'action', id: action.actionId, checksum: action.actionChecksum }))
    ],
    origin: canonical.authorityOrigin,
    updatedAt: 0,
    retryAfterMs: 0,
    ...legacyActionFields(actions)
  };
}
