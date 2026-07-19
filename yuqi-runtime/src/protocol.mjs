import { createHash } from 'node:crypto';

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
  'PROACTIVE_MOMENT'
]);
const TRIGGER_TYPES = new Set([
  'role_plan_chat',
  'role_plan_moment',
  'role_plan_chat_private',
  'role_plan_moment_private',
  'proactive_chat',
  'proactive_moment'
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

export function validateEnvelope(value) {
  if (!value || typeof value !== 'object') throw new Error('invalid envelope');
  if (![1, 2].includes(value.protocolVersion)) throw new Error('invalid protocolVersion');

  const envelope = {
    protocolVersion: value.protocolVersion,
    turnId: value.turnId,
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

  if (envelope.protocolVersion === 2) {
    envelope.kind = String(value.kind || '');
    if (DIRECT_KINDS.has(envelope.kind)) {
      if (value.trigger !== undefined) throw new Error('direct turn cannot contain a trigger');
    } else if (AUTOMATIC_KINDS.has(envelope.kind)) {
      if (value.message !== undefined) throw new Error('automatic turn cannot contain a message');
      delete envelope.message;
      envelope.trigger = validateTrigger(value.trigger);
      return envelope;
    } else {
      throw new Error('invalid turn kind');
    }
  }

  validateUserMessage(envelope.message, envelope);
  return envelope;
}

function validateUserMessage(message, envelope) {
  if (!message || typeof message !== 'object') throw new Error('invalid message');
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
  return message;
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
  }
  return normalized;
}
