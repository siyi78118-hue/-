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

  const incomingKind = value.protocolVersion === 2 ? String(value.kind || '') : '';
  const incomingTurnId = String(value.turnId || '');
  const legacyAutomaticTurnId = value.protocolVersion === 2
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

  if (envelope.protocolVersion === 2) {
    envelope.kind = incomingKind;
    if (DIRECT_KINDS.has(envelope.kind)) {
      if (value.trigger !== undefined) throw new Error('direct turn cannot contain a trigger');
      if (value.context !== undefined) envelope.context = validateDirectContext(value.context);
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

function validateDirectContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('invalid direct context');
  }
  const normalized = {};
  if (context.scene !== undefined) normalized.scene = validateScene(context.scene);
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
    const suppliedScene = trigger.context.scene || trigger.context.snapshot?.scene;
    if (suppliedScene !== undefined) normalized.context.scene = validateScene(suppliedScene);
  }
  return normalized;
}
