import { createHash } from 'node:crypto';

import { deriveAuthorityLineageKey } from './authority-identity.mjs';
import { laneKeyForEnvelope } from './interaction-lanes.mjs';

export const TURN_STATES = Object.freeze([
  'queued',
  'memory_running',
  'memory_done',
  'brain_running',
  'brain_done',
  'supervisor_running',
  'approved',
  'committed',
  'delivered',
  'completed',
  'fallback',
  'failed'
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIRECT_KINDS = new Set(['DIRECT_REPLY']);
const AUTOMATIC_KINDS = new Set([
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY'
]);
const TRIGGER_TYPES = new Set([
  'role_plan_chat',
  'role_plan_moment',
  'role_plan_chat_private',
  'role_plan_moment_private',
  'proactive_chat',
  'proactive_moment',
  'moment_interaction',
  'moment_reply'
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function deliveryItemsForResult(result = {}) {
  const turnId = String(result?.turnId || '');
  if (!turnId) return [];
  const items = [];
  if (result.reply?.messageId) {
    items.push({
      kind: 'message',
      id: String(result.reply.messageId),
      checksum: contentHash({
        messageId: String(result.reply.messageId),
        content: String(result.reply.content || ''),
        recipientId: String(result.reply.recipientId || '')
      })
    });
  }
  const actionEntries = [
    ['payment', result.paymentAction],
    ['moment', result.momentAction],
    ['life_adjustment', result.lifeAdjustment],
    ['relationship_stage', result.relationshipStageAction]
  ].filter(([, value]) => value != null);
  (Array.isArray(result.rolePlanOperations) ? result.rolePlanOperations : [])
    .forEach((value, index) => actionEntries.push([`role_plan_${index}`, value]));
  for (const [name, payload] of actionEntries) {
    items.push({
      kind: 'action',
      id: `${turnId}:${name}`,
      checksum: contentHash({ name, payload })
    });
  }
  return items;
}

export function validateDeliveryReceipt(value) {
  if (!value || value.protocolVersion !== 1 || !ID_PATTERN.test(String(value.turnId || ''))) {
    throw new Error('invalid delivery receipt identity');
  }
  if (!Number.isSafeInteger(Number(value.deliveredAt)) || Number(value.deliveredAt) < 0) {
    throw new Error('invalid delivery receipt time');
  }
  if (!Array.isArray(value.items) || !value.items.length) {
    throw new Error('delivery receipt items are required');
  }
  const seen = new Set();
  const items = value.items.map(item => {
    const kind = String(item?.kind || '');
    const id = String(item?.id || '');
    const checksum = String(item?.checksum || '');
    if (!['message', 'action'].includes(kind) || !id || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error('invalid delivery receipt item');
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) throw new Error('duplicate delivery receipt item');
    seen.add(key);
    return { kind, id, checksum };
  });
  return {
    protocolVersion: 1,
    turnId: String(value.turnId),
    deliveredAt: Number(value.deliveredAt),
    items
  };
}

const AUTHORITY_DELIVERY_RECEIPT_KEYS = Object.freeze([
  'protocolVersion',
  'type',
  'peerId',
  'turnId',
  'authorityLineageKey',
  'visibleGroupId',
  'commitChecksum',
  'terminalDisposition',
  'deliveredAt'
]);

export function validateAuthorityDeliveryReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid authority delivery receipt');
  }
  const keys = Object.keys(value).sort();
  const expectedKeys = [...AUTHORITY_DELIVERY_RECEIPT_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('invalid authority delivery receipt shape');
  }
  if (value.protocolVersion !== 3 || value.type !== 'AUTHORITY_DELIVERY_RECEIPT') {
    throw new Error('invalid authority delivery receipt identity');
  }
  if (typeof value.terminalDisposition !== 'string'
    || !['visible', 'action_only', 'skip'].includes(value.terminalDisposition)) {
    throw new Error('invalid authority delivery receipt disposition');
  }
  const terminalDisposition = value.terminalDisposition;
  if (typeof value.commitChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.commitChecksum)) {
    throw new Error('invalid authority delivery receipt checksum');
  }
  const commitChecksum = value.commitChecksum;
  for (const [key, label] of [
    ['peerId', 'peer'],
    ['turnId', 'turn'],
    ['authorityLineageKey', 'lineage'],
    ['visibleGroupId', 'group']
  ]) {
    if (typeof value[key] !== 'string') {
      throw new Error(`invalid authority delivery receipt ${label}`);
    }
  }
  if (typeof value.deliveredAt !== 'number') {
    throw new Error('invalid authority delivery receipt time');
  }
  return {
    protocolVersion: 3,
    type: 'AUTHORITY_DELIVERY_RECEIPT',
    peerId: requireId(value.peerId, 'authority delivery receipt peer'),
    turnId: requireId(value.turnId, 'authority delivery receipt turn'),
    authorityLineageKey: requireId(value.authorityLineageKey, 'authority delivery receipt lineage'),
    visibleGroupId: requireId(value.visibleGroupId, 'authority delivery receipt group'),
    commitChecksum,
    terminalDisposition,
    deliveredAt: requireTimestamp(value.deliveredAt, 'authority delivery receipt time')
  };
}

function requireId(value, label, prefix = '') {
  const text = String(value || '');
  if (!ID_PATTERN.test(text) || (prefix && !text.startsWith(prefix))) {
    throw new Error(`invalid ${label}`);
  }
  return text;
}

function requireTimestamp(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid ${label}`);
  return number;
}

const V3_AUTHORITY_KEYS = Object.freeze([
  'algorithm',
  'roleId',
  'laneKey',
  'rootSourceId',
  'lineageKey',
  'claimedLineageRevision',
  'retryOfTurnId'
]);
const V3_CURSOR_KEYS = Object.freeze([
  'nativeCompletedTurnId',
  'nativeCompletedGroupId',
  'nativeCompletedSequence',
  'uiAppliedTurnId',
  'uiAppliedGroupId',
  'uiAppliedSequence',
  'localSequence',
  'clearedThroughSequence',
  'clearEpoch',
  'clearedAt',
  'chatOpen',
  'quotedMessageId'
]);
const V3_DIRECT_CONTEXT_KEYS = Object.freeze([
  'scene', 'currentBatch', 'retry', 'payment', 'visibilityCursor'
]);
const V3_AUTOMATIC_CONTEXT_KEYS = Object.freeze(['visibilityCursor']);

function assertClosedKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(required)) {
    throw new Error(`${label} keys conflict`);
  }
}

function assertNoUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid ${label}`);
  }
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    throw new Error(`${label} keys conflict`);
  }
}

function rejectAuthorityVersionSelector(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Object.hasOwn(value, 'resultAuthorityVersion')) {
    throw new Error('resultAuthorityVersion is store-owned');
  }
  for (const nested of Object.values(value)) rejectAuthorityVersionSelector(nested, seen);
}

function requireNonNegativeSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function validateCursorIdentity(cursor, prefix) {
  const sequence = cursor[`${prefix}Sequence`];
  const turnField = `${prefix}TurnId`;
  const groupField = `${prefix}GroupId`;
  const turnId = cursor[turnField];
  const groupId = cursor[groupField];
  const bothNull = turnId === null && groupId === null;
  const bothText = typeof turnId === 'string' && typeof groupId === 'string';
  if (!bothNull && !bothText) throw new Error(`${prefix} identity conflict`);
  if (sequence === 0) {
    if (bothNull) return;
    if (!/^turn_[A-Za-z0-9_-]+$/.test(turnId) || turnId !== groupId) {
      throw new Error(`${prefix} legacy anchor conflict`);
    }
    return;
  }
  if (!bothText || !/^turn_[A-Za-z0-9_-]+$/.test(turnId) || !/^grp_[a-f0-9]{64}$/.test(groupId)) {
    throw new Error(`${prefix} identity conflict`);
  }
}

function validateVisibilityCursor(value) {
  assertClosedKeys(value, V3_CURSOR_KEYS, 'visibility cursor');
  const normalizeLegacyAnchor = candidate => (
    typeof candidate === 'string' && /^(?:cloud|plan)_/.test(candidate)
      ? `turn_${candidate}`
      : candidate
  );
  const cursor = {
    nativeCompletedTurnId: normalizeLegacyAnchor(value.nativeCompletedTurnId),
    nativeCompletedGroupId: normalizeLegacyAnchor(value.nativeCompletedGroupId),
    nativeCompletedSequence: requireNonNegativeSafeInteger(value.nativeCompletedSequence, 'nativeCompletedSequence'),
    uiAppliedTurnId: normalizeLegacyAnchor(value.uiAppliedTurnId),
    uiAppliedGroupId: normalizeLegacyAnchor(value.uiAppliedGroupId),
    uiAppliedSequence: requireNonNegativeSafeInteger(value.uiAppliedSequence, 'uiAppliedSequence'),
    localSequence: requireNonNegativeSafeInteger(value.localSequence, 'localSequence'),
    clearedThroughSequence: requireNonNegativeSafeInteger(value.clearedThroughSequence, 'clearedThroughSequence'),
    clearEpoch: requireNonNegativeSafeInteger(value.clearEpoch, 'clearEpoch'),
    clearedAt: requireNonNegativeSafeInteger(value.clearedAt, 'clearedAt'),
    chatOpen: value.chatOpen,
    quotedMessageId: value.quotedMessageId
  };
  if (typeof cursor.chatOpen !== 'boolean') throw new Error('invalid chatOpen');
  if (cursor.quotedMessageId !== null) requireId(cursor.quotedMessageId, 'quotedMessageId', 'msg_');
  if (cursor.uiAppliedSequence > cursor.nativeCompletedSequence) {
    throw new Error('uiAppliedSequence exceeds nativeCompletedSequence');
  }
  if (cursor.nativeCompletedSequence >= cursor.localSequence) {
    throw new Error('nativeCompletedSequence must precede localSequence');
  }
  if (cursor.clearedThroughSequence > cursor.localSequence) {
    throw new Error('clearedThroughSequence exceeds localSequence');
  }
  validateCursorIdentity(cursor, 'nativeCompleted');
  validateCursorIdentity(cursor, 'uiApplied');
  if (
    cursor.nativeCompletedSequence > 0
    && cursor.nativeCompletedSequence === cursor.uiAppliedSequence
    && (
      cursor.nativeCompletedTurnId !== cursor.uiAppliedTurnId
      || cursor.nativeCompletedGroupId !== cursor.uiAppliedGroupId
    )
  ) {
    throw new Error('positive cursor identity conflict');
  }
  if (
    cursor.nativeCompletedSequence > 0
    && cursor.uiAppliedSequence > 0
    && cursor.nativeCompletedGroupId === cursor.uiAppliedGroupId
    && cursor.nativeCompletedSequence !== cursor.uiAppliedSequence
  ) {
    throw new Error('positive cursor identity conflict');
  }
  return cursor;
}

export function authorityLaneKeyForEnvelope(envelope) {
  if (!['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(envelope.kind)) {
    return laneKeyForEnvelope(envelope);
  }
  return laneKeyForEnvelope({ ...envelope, context: envelope.trigger?.context || {} });
}

function validateV3Authority(value, envelope) {
  assertClosedKeys(value, V3_AUTHORITY_KEYS, 'authority');
  if (value.algorithm !== 'al-authority-v1') throw new Error('invalid authority algorithm');
  if (value.roleId !== envelope.characterId) throw new Error('authority role mismatch');
  const laneKey = authorityLaneKeyForEnvelope(envelope);
  if (value.laneKey !== laneKey) throw new Error('authority lane mismatch');
  const retryOfTurnId = envelope.context?.retry?.retryOfTurnId || null;
  if (value.retryOfTurnId !== retryOfTurnId) throw new Error('authority retry mismatch');
  const rootSourceId = envelope.kind === 'DIRECT_REPLY'
    ? (envelope.context?.retry?.canonicalMessageId || envelope.message.messageId)
    : envelope.trigger.triggerId;
  if (value.rootSourceId !== rootSourceId) throw new Error('authority root mismatch');
  if (
    typeof value.claimedLineageRevision !== 'number'
    || !Number.isSafeInteger(value.claimedLineageRevision)
    || value.claimedLineageRevision < 1
  ) {
    throw new Error('invalid authority revision');
  }
  const lineageKey = deriveAuthorityLineageKey({
    roleId: envelope.characterId,
    laneKey,
    rootSourceId
  });
  if (value.lineageKey !== lineageKey) throw new Error('authority lineage mismatch');
  return {
    algorithm: 'al-authority-v1',
    roleId: envelope.characterId,
    laneKey,
    rootSourceId,
    lineageKey,
    claimedLineageRevision: value.claimedLineageRevision,
    retryOfTurnId
  };
}

export function validateEnvelope(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid envelope');
  if (![1, 2, 3].includes(value.protocolVersion)) throw new Error('invalid protocolVersion');
  if (value.protocolVersion === 3) rejectAuthorityVersionSelector(value);

  const incomingKind = value.protocolVersion >= 2 ? String(value.kind || '') : '';
  const incomingTurnId = String(value.turnId || '');
  const legacyAutomaticTurnId = value.protocolVersion >= 2
    && AUTOMATIC_KINDS.has(incomingKind)
    && /^(?:cloud|plan)_/.test(incomingTurnId);

  const envelope = {
    protocolVersion: value.protocolVersion,
    turnId: legacyAutomaticTurnId ? `turn_${incomingTurnId}` : value.turnId,
    characterId: value.characterId,
    deviceId: value.deviceId,
    deviceSeq: value.deviceSeq,
    createdAt: value.createdAt,
    message: value.message ? structuredClone(value.message) : value.message
  };
  requireId(envelope.turnId, 'turnId', 'turn_');
  requireId(envelope.characterId, 'characterId');
  requireId(envelope.deviceId, 'deviceId');
  if (!Number.isSafeInteger(envelope.deviceSeq) || envelope.deviceSeq < 1) {
    throw new Error('invalid deviceSeq');
  }
  requireTimestamp(envelope.createdAt, 'createdAt');

  if (envelope.protocolVersion >= 2) {
    envelope.kind = incomingKind;
    if (DIRECT_KINDS.has(envelope.kind)) {
      if (value.trigger !== undefined) throw new Error('direct turn cannot contain a trigger');
    } else if (AUTOMATIC_KINDS.has(envelope.kind)) {
      if (value.message !== undefined) throw new Error('automatic turn cannot contain a message');
      delete envelope.message;
      envelope.trigger = validateTrigger(value.trigger);
      if (envelope.protocolVersion === 2) return envelope;
    } else {
      throw new Error('invalid turn kind');
    }
  }

  if (DIRECT_KINDS.has(envelope.kind) || envelope.protocolVersion === 1) {
    validateUserMessage(envelope.message, envelope);
  }
  if (DIRECT_KINDS.has(envelope.kind) && value.context !== undefined) {
    envelope.context = validateDirectContext(value.context, envelope, {
      requireCompleteBatch: envelope.protocolVersion === 3
    });
  }
  if (envelope.protocolVersion === 3) {
    if (!value.context || typeof value.context !== 'object' || Array.isArray(value.context)) {
      throw new Error('visibility cursor is required');
    }
    assertNoUnknownKeys(
      value.context,
      DIRECT_KINDS.has(envelope.kind) ? V3_DIRECT_CONTEXT_KEYS : V3_AUTOMATIC_CONTEXT_KEYS,
      'context'
    );
    if (!DIRECT_KINDS.has(envelope.kind)) envelope.context = {};
    envelope.context.visibilityCursor = validateVisibilityCursor(value.context.visibilityCursor);
    envelope.authority = validateV3Authority(value.authority, envelope);
  }
  return envelope;
}

function validateDirectContext(context, envelope, { requireCompleteBatch = false } = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('invalid direct context');
  }
  const normalized = {};
  if (context.scene !== undefined) normalized.scene = validateScene(context.scene);
  if (context.currentBatch !== undefined) {
    normalized.currentBatch = validateCurrentBatch(context.currentBatch, envelope);
  }
  if (requireCompleteBatch && !Array.isArray(normalized.currentBatch?.messages)) {
    throw new Error('current batch messages are required');
  }
  if (context.retry !== undefined) {
    const retry = context.retry;
    if (!retry || typeof retry !== 'object' || Array.isArray(retry)) {
      throw new Error('invalid retry context');
    }
    const retryOfTurnId = String(retry.retryOfTurnId || '');
    const canonicalMessageId = String(retry.canonicalMessageId || '');
    requireId(retryOfTurnId, 'retryOfTurnId', 'turn_');
    requireId(canonicalMessageId, 'canonicalMessageId');
    normalized.retry = { retryOfTurnId, canonicalMessageId };
  }
  if (context.payment !== undefined) {
    const payment = context.payment;
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
      throw new Error('invalid payment context');
    }
    const kind = String(payment.kind || '');
    const amount = Number(payment.amount);
    const note = String(payment.note || '').trim();
    const messageId = String(payment.messageId || '');
    const status = String(payment.status || 'pending');
    if (!['redpacket', 'transfer'].includes(kind)) throw new Error('invalid payment kind');
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('invalid payment amount');
    if (note.length > 500) throw new Error('payment note too large');
    requireId(messageId, 'payment messageId');
    if (!['pending', 'received', 'refused'].includes(status)) throw new Error('invalid payment status');
    normalized.payment = { kind, amount, note, messageId, status };
  }
  return normalized;
}

function canonicalMessageId(value, label = 'batch messageId') {
  const incoming = String(value || '');
  const messageId = /^pay_[A-Za-z0-9_-]+$/.test(incoming) ? `msg_${incoming}` : incoming;
  requireId(messageId, label, 'msg_');
  return messageId;
}

function normalizedBatchMessage(value, envelope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid current batch message');
  }
  const message = structuredClone(value);
  message.messageId = canonicalMessageId(message.messageId);
  validateUserMessage(message, envelope);
  if (message.speakerType !== 'user' || message.speakerId !== 'user') {
    throw new Error('current batch messages must be user messages');
  }
  if (message.recipientId !== envelope.characterId) {
    throw new Error('current batch recipient mismatch');
  }
  return {
    messageId: message.messageId,
    speakerId: message.speakerId,
    speakerType: message.speakerType,
    recipientId: message.recipientId,
    content: message.content,
    ...(message.attachments ? { attachments: message.attachments } : {}),
    sentAt: message.sentAt
  };
}

function validateCurrentBatch(value, envelope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid current batch');
  }
  const batchId = String(value.batchId || '');
  requireId(batchId, 'current batchId', 'batch_');
  if (!Array.isArray(value.messageIds) || value.messageIds.length < 1 || value.messageIds.length > 64) {
    throw new Error('invalid current batch messageIds');
  }
  const messageIds = value.messageIds.map(messageId => canonicalMessageId(messageId));
  if (new Set(messageIds).size !== messageIds.length) throw new Error('duplicate batch messageId');
  if (messageIds.at(-1) !== envelope.message.messageId) throw new Error('current batch source message mismatch');

  const startedAt = requireTimestamp(value.startedAt, 'current batch startedAt');
  const committedAt = requireTimestamp(value.committedAt, 'current batch committedAt');
  if (startedAt > committedAt) throw new Error('invalid current batch timing');
  const normalized = { batchId, messageIds, startedAt, committedAt };

  if (value.messages !== undefined) {
    if (!Array.isArray(value.messages) || value.messages.length !== messageIds.length) {
      throw new Error('current batch messages must match messageIds');
    }
    const messages = value.messages.map(message => normalizedBatchMessage(message, envelope));
    const normalizedIds = messages.map(message => message.messageId);
    if (canonicalJson(normalizedIds) !== canonicalJson(messageIds)) {
      throw new Error('current batch message order mismatch');
    }
    const source = messages.at(-1);
    const sourceMatchesEnvelope = envelope.protocolVersion === 3
      ? canonicalJson(source) === canonicalJson(normalizedBatchMessage(envelope.message, envelope))
      : (
        source.messageId === envelope.message.messageId
        && source.content === envelope.message.content
        && Number(source.sentAt) === Number(envelope.message.sentAt)
      );
    if (!sourceMatchesEnvelope) {
      throw new Error('current batch source message mismatch');
    }
    if (
      startedAt !== Number(messages[0].sentAt)
      || messages.some((message, index) =>
        Number(message.sentAt) > committedAt
        || (index > 0 && Number(message.sentAt) < Number(messages[index - 1].sentAt))
      )
    ) {
      throw new Error('invalid current batch timing');
    }
    const totalText = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (totalText > 200_000) throw new Error('current batch content too large');
    const totalAttachments = messages.reduce(
      (sum, message) => sum + (Array.isArray(message.attachments) ? message.attachments.length : 0),
      0
    );
    if (totalAttachments > 1) throw new Error('current batch supports at most one image attachment');
    normalized.messages = messages;
  }
  return normalized;
}

function limitedText(value, maximum) {
  const text = String(value || '').trim();
  if (text.length > maximum) throw new Error('scene text too large');
  return text;
}

function validateScene(scene) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) throw new Error('invalid scene');
  const sourceStage = scene.relationshipStage;
  if (!sourceStage || typeof sourceStage !== 'object' || Array.isArray(sourceStage)) {
    throw new Error('invalid relationship stage');
  }
  const id = limitedText(sourceStage.id || 'new', 64);
  if (!ID_PATTERN.test(id)) throw new Error('invalid relationship stage id');
  const catalog = Array.isArray(scene.stageCatalog) ? scene.stageCatalog.slice(0, 20).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid stage catalog');
    const stageId = limitedText(item.id, 64);
    if (!ID_PATTERN.test(stageId)) throw new Error('invalid stage catalog id');
    return {
      id: stageId,
      label: limitedText(item.label || stageId, 80),
      content: limitedText(item.content, 12_000)
    };
  }) : [];
  if (!catalog.some(item => item.id === id)) {
    catalog.unshift({
      id,
      label: limitedText(sourceStage.label || id, 80),
      content: limitedText(sourceStage.content, 12_000)
    });
  }
  const phaseCatalog = Array.isArray(scene.phaseCatalog) ? scene.phaseCatalog.slice(0, 20).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid phase catalog');
    const phaseId = limitedText(item.id, 64);
    if (!ID_PATTERN.test(phaseId)) throw new Error('invalid phase catalog id');
    return {
      id: phaseId,
      label: limitedText(item.label || phaseId, 80),
      content: limitedText(item.content, 12_000)
    };
  }) : [{ id: 'normal', label: '正常相处', content: '' }];
  const sourceBase = sourceStage.base && typeof sourceStage.base === 'object' && !Array.isArray(sourceStage.base)
    ? sourceStage.base
    : sourceStage;
  const sourcePhase = sourceStage.phase && typeof sourceStage.phase === 'object' && !Array.isArray(sourceStage.phase)
    ? sourceStage.phase
    : (scene.relationshipPhase && typeof scene.relationshipPhase === 'object' ? scene.relationshipPhase : {});
  const baseId = limitedText(sourceBase.id || id, 64);
  if (!ID_PATTERN.test(baseId)) throw new Error('invalid relationship base id');
  const phaseId = limitedText(sourcePhase.id || scene.currentPhase || 'normal', 64);
  if (!ID_PATTERN.test(phaseId)) throw new Error('invalid relationship phase id');
  if (!phaseCatalog.some(item => item.id === phaseId)) {
    phaseCatalog.unshift({
      id: phaseId,
      label: limitedText(sourcePhase.label || phaseId, 80),
      content: limitedText(sourcePhase.content, 12_000)
    });
  }
  const base = {
    id: baseId,
    label: limitedText(sourceBase.label || baseId, 80),
    content: limitedText(sourceBase.content, 12_000),
    since: Math.max(0, Number(sourceBase.since ?? sourceStage.since) || 0),
    reason: limitedText(sourceBase.reason ?? sourceStage.reason, 500),
    confidence: Math.max(0, Math.min(1, Number(sourceBase.confidence ?? sourceStage.confidence) || 0))
  };
  const phase = {
    id: phaseId,
    label: limitedText(sourcePhase.label || phaseId, 80),
    content: limitedText(sourcePhase.content, 12_000),
    since: Math.max(0, Number(sourcePhase.since) || 0),
    reason: limitedText(sourcePhase.reason, 500),
    confidence: Math.max(0, Math.min(1, Number(sourcePhase.confidence) || 0))
  };
  return {
    playerName: limitedText(scene.playerName || '用户', 120),
    characterName: limitedText(scene.characterName || '虞栖', 120),
    relationshipStage: {
      id,
      label: limitedText(sourceStage.label || id, 80),
      content: limitedText(sourceStage.content, 12_000),
      since: Math.max(0, Number(sourceStage.since) || 0),
      reason: limitedText(sourceStage.reason, 500),
      confidence: Math.max(0, Math.min(1, Number(sourceStage.confidence) || 0)),
      base,
      phase
    },
    conversationExtraPrompt: limitedText(scene.conversationExtraPrompt, 12_000),
    globalExtraPrompt: limitedText(scene.globalExtraPrompt, 12_000),
    rolePlanCatalog: limitedText(scene.rolePlanCatalog, 20_000),
    roleScheduleContext: limitedText(scene.roleScheduleContext, 12_000),
    momentContext: limitedText(scene.momentContext, 20_000),
    stageCatalog: catalog,
    phaseCatalog,
    currentPhase: phaseId
  };
}

function validateUserMessage(message, envelope) {
  if (!message || typeof message !== 'object') throw new Error('invalid message');
  if (/^pay_[A-Za-z0-9_-]+$/.test(String(message.messageId || ''))) {
    message.messageId = `msg_${message.messageId}`;
  }
  requireId(message.messageId, 'messageId', 'msg_');
  requireId(message.speakerId, 'speakerId');
  requireId(message.recipientId, 'recipientId');
  requireTimestamp(message.sentAt, 'sentAt');
  if (!['user', 'character'].includes(message.speakerType)) throw new Error('invalid speakerType');
  if (message.speakerType === 'user' && message.speakerId !== 'user') {
    throw new Error('speaker mismatch: user messages must use speakerId=user');
  }
  if (message.speakerType === 'character' && message.speakerId !== envelope.characterId) {
    throw new Error('speaker mismatch: character speakerId must equal characterId');
  }
  if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('empty message content');
  if (message.content.length > 100_000) throw new Error('message content too large');
  if (message.attachments !== undefined) {
    if (Array.isArray(message.attachments) && message.attachments.length === 0) {
      delete message.attachments;
    } else {
      message.attachments = validateImageAttachments(message.attachments, message.messageId);
    }
  }
  return message;
}

function validateImageAttachments(attachments, messageId) {
  if (!Array.isArray(attachments) || attachments.length !== 1) {
    throw new Error('direct message supports exactly one image attachment');
  }
  const source = attachments[0];
  if (!source || typeof source !== 'object' || Array.isArray(source) || source.kind !== 'image') {
    throw new Error('invalid image attachment');
  }
  const attachmentId = String(source.attachmentId || '');
  requireId(attachmentId, 'attachmentId', 'att_');
  if (String(source.messageId || '') !== messageId) throw new Error('image attachment message mismatch');
  const mime = String(source.mime || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error('invalid image attachment MIME');
  const match = new RegExp(`^data:${mime.replace('/', '\\/')};base64,([A-Za-z0-9+/]+={0,2})$`, 'i')
    .exec(String(source.dataUrl || ''));
  if (!match) throw new Error('invalid image attachment data URL');
  const decoded = Buffer.from(match[1], 'base64');
  if (!decoded.length || decoded.length > 96 * 1024) throw new Error('image attachment exceeds 96KB');
  if (Number(source.bytes) !== decoded.length) throw new Error('image attachment byte count mismatch');
  const signatureValid = mime === 'image/jpeg'
    ? decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff
    : mime === 'image/png'
      ? decoded.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : decoded.subarray(0, 4).toString('ascii') === 'RIFF' && decoded.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!signatureValid) throw new Error('invalid image attachment signature');
  const width = Number(source.width);
  const height = Number(source.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error('invalid image attachment dimensions');
  }
  return [{
    attachmentId,
    messageId,
    kind: 'image',
    mime,
    name: String(source.name || 'image').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120),
    width,
    height,
    bytes: decoded.length,
    dataUrl: String(source.dataUrl)
  }];
}

function validateTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) throw new Error('invalid trigger');
  const normalized = {
    triggerId: String(trigger.triggerId || ''),
    triggerType: String(trigger.triggerType || ''),
    scheduledFor: Number(trigger.scheduledFor),
    executedAt: Number(trigger.executedAt)
  };
  requireId(normalized.triggerId, 'triggerId', 'trigger_');
  if (!TRIGGER_TYPES.has(normalized.triggerType)) throw new Error('invalid triggerType');
  requireTimestamp(normalized.scheduledFor, 'scheduledFor');
  requireTimestamp(normalized.executedAt, 'executedAt');
  if (trigger.context !== undefined) {
    if (!trigger.context || typeof trigger.context !== 'object' || Array.isArray(trigger.context)) {
      throw new Error('invalid trigger context');
    }
    normalized.context = structuredClone(trigger.context);
    const suppliedScene = trigger.context.scene || trigger.context.snapshot?.scene;
    if (suppliedScene !== undefined) normalized.context.scene = validateScene(suppliedScene);
  }
  return normalized;
}
