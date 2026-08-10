import { createHash } from 'node:crypto';

import { commitVerifiedFacts } from './evidence-memory.mjs';
import { contentHash, validateEnvelope } from './protocol.mjs';
import { buildEvidencePack } from './retrieval.mjs';
import { ROLE_OUTPUT_SCHEMAS } from './role-schemas.mjs';
import { DEFAULT_PROFILES, roleExecutionProfile, selectTurnRoute } from './route-policy.mjs';
import {
  relationshipViewsFromScene,
  resolveRelationshipStage,
  sceneFromEnvelope
} from './relationship-stage.mjs';
import { buildAuthoritativeInteractionState } from './interaction-state.mjs';
import { compileInteractionContract } from './interaction-contract.mjs';
import { buildGenerationWindow } from './conversation-context.mjs';
import { currentUserBatchForRole, resolveCurrentUserBatch } from './current-user-batch.mjs';
import {
  LifeSimulationCoordinator,
  buildProactiveMotiveAuthority,
  proactiveMotiveSourceContext
} from './life-simulation.mjs';
import { materializeImageAttachments } from './image-attachments.mjs';
import { reduceCognitiveState } from './cognitive-state.mjs';
import { compileAgencyView } from './agency-state.mjs';
import { comparisonContractForMode } from './comparison-contract.mjs';

export function canonicalActionSetForDraft({ isProactiveV3, draft, resolve }) {
  if (typeof resolve !== 'function') throw new Error('canonical action resolver is required');
  return isProactiveV3 && draft?.action === 'skip' ? [] : resolve();
}

export function assertCanonicalActionSetForTurn({ turnKind, action, actionSet } = {}) {
  if (!Array.isArray(actionSet)) throw new Error('canonical moment action authority conflict');
  const kind = String(turnKind || '');
  if (!['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(kind)) return true;
  if (action === 'skip') {
    if (actionSet.length !== 0) throw new Error('canonical moment action authority conflict');
    return true;
  }
  const allowed = kind === 'MOMENT_REPLY'
    ? new Set(['moment_reply'])
    : new Set(['moment_like', 'moment_comment']);
  if (actionSet.length === 0 || actionSet.some(item => !allowed.has(item?.kind))) {
    throw new Error('canonical moment action authority conflict');
  }
  return true;
}
import { generationFingerprint, laneKeyForEnvelope } from './interaction-lanes.mjs';
import { commitVisibleResult } from './visible-result-commit.mjs';
import {
  characterFactCandidatesForReply,
  hasHighPriorityIssues,
  normalizeRewriteResolution,
  normalizeSupervisorResult,
  rewriteContractForBrain
} from './rewrite-contract.mjs';

function parseRoleJson(text, role) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(source); } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${role} returned invalid object`);
  return value;
}

function withoutCurrentBatch(messages, batch, limit = null) {
  const currentIds = new Set(batch?.messageIds || []);
  const historical = (Array.isArray(messages) ? messages : [])
    .filter(message => !currentIds.has(String(message?.messageId || '')));
  return limit === null ? historical : historical.slice(-Math.max(1, Number(limit) || 1));
}

function evidenceMessages(messages, batch) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = String(message?.messageId || '');
    if (messageId) byId.set(messageId, message);
  }
  for (const message of batch?.messages || []) {
    const messageId = String(message?.messageId || '');
    if (messageId) byId.set(messageId, message);
  }
  return [...byId.values()]
    .sort((left, right) => Number(left?.sentAt || 0) - Number(right?.sentAt || 0));
}

function failureClassForTurn(turn) {
  if (!turn?.errorJson) return null;
  try {
    const failure = JSON.parse(turn.errorJson);
    return typeof failure?.failureClass === 'string' ? failure.failureClass : null;
  } catch {
    return null;
  }
}

const CANONICAL_TURN_KINDS = new Set([
  'DIRECT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY'
]);

const PUBLIC_MOMENT_KINDS = new Set([
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);

function cognitionSceneForV3(scene) {
  const views = relationshipViewsFromScene(scene);
  return {
    relationshipStage: views.formal,
    relationshipExpression: views.expression
  };
}

export function canonicalInteractionAt(envelope, fallback = Date.now()) {
  const value = envelope?.message?.sentAt
    ?? envelope?.trigger?.executedAt
    ?? envelope?.trigger?.scheduledFor
    ?? envelope?.createdAt
    ?? fallback;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : Number(fallback);
}

function stripAttachmentData(message) {
  if (!message || !Array.isArray(message.attachments)) return message;
  return {
    ...message,
    attachments: message.attachments.map(({ dataUrl, ...metadata }) => metadata)
  };
}

export function hardValidateReply(reply) {
  const issues = [];
  const text = String(reply || '').trim();
  if (!text) issues.push({ code: 'EMPTY_REPLY', message: 'reply is empty' });
  if (text.length > 20_000) issues.push({ code: 'REPLY_TOO_LARGE', message: 'reply is too large' });
  return { ok: issues.length === 0, issues };
}

function normalizeRolePlanOperations(value) {
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text || text === '[]') return [];
    try { source = JSON.parse(text); } catch {
      throw new Error('brain returned invalid rolePlanOperationsJson');
    }
  }
  if (!Array.isArray(source)) return [];
  const allowed = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete']);
  return source.slice(0, 12).map(operation => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('brain returned invalid role plan operation');
    }
    const normalized = JSON.parse(JSON.stringify(operation));
    normalized.op = String(normalized.op || '');
    if (!allowed.has(normalized.op)) throw new Error('brain returned unknown role plan operation');
    return normalized;
  });
}

export function normalizeCanonicalV3RolePlanOperations(value) {
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text || text === '[]') return [];
    try { source = JSON.parse(text); } catch {
      throw new Error('canonical v3 role plan operations authority conflict');
    }
  }
  if (!Array.isArray(source)) {
    throw new Error('canonical v3 role plan operations must be an array');
  }
  if (source.length > 12) {
    throw new Error('canonical v3 role plan operations exceed limit');
  }
  return normalizeRolePlanOperations(source);
}

const ROLE_PLAN_CONFIRMATION_SOURCES = new Set([
  'spoken', 'accepted_request', 'user_created'
]);
const ROLE_PLAN_ALL_SOURCES = new Set([
  'spoken', 'accepted_request', 'private_decision', 'user_created'
]);
const ROLE_PLAN_CONFIRMATION_OPS = new Set([
  'create', 'update', 'cancel', 'pause', 'resume', 'complete'
]);
const ROLE_PLAN_V3_KINDS = new Set([
  'DIRECT_REPLY',
  'ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'
]);
const ROLE_PLAN_CONFIRMATION_ERROR = 'role plan confirmation authority conflict';

function rolePlanConfirmationConflict(detail = '') {
  throw new Error(detail ? `${ROLE_PLAN_CONFIRMATION_ERROR}: ${detail}` : ROLE_PLAN_CONFIRMATION_ERROR);
}

function isPlainRolePlanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rolePlanScheduleValue(schedule, label = 'schedule') {
  if (!isPlainRolePlanObject(schedule)) rolePlanConfirmationConflict(`${label} must be an object`);
  const allowedByKind = {
    once: new Set(['kind', 'at', 'endsAt']),
    interval: new Set(['kind', 'startsAt', 'intervalMs', 'endsAt']),
    daily: new Set(['kind', 'time', 'endsAt']),
    weekly: new Set(['kind', 'weekdays', 'time', 'endsAt']),
    monthly: new Set(['kind', 'day', 'time', 'endsAt'])
  };
  const allowed = allowedByKind[schedule.kind];
  if (!allowed || Object.keys(schedule).some(key => !allowed.has(key))) {
    rolePlanConfirmationConflict(`${label} fields or kind conflict`);
  }
  const hasEndsAt = Object.hasOwn(schedule, 'endsAt');
  const endsAt = hasEndsAt ? schedule.endsAt : null;
  const parseTimestamp = (value, fieldLabel) => {
    if (typeof value !== 'string' || !value.trim()) {
      rolePlanConfirmationConflict(`${label} ${fieldLabel} is invalid`);
    }
    const text = value.trim();
    let timestamp;
    if (/(?:Z|[+-]\d\d:\d\d)$/.test(text)) {
      timestamp = Date.parse(text);
    } else {
      const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text);
      if (!match) rolePlanConfirmationConflict(`${label} ${fieldLabel} must use Asia/Shanghai time`);
      const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', millisText = '0'] = match;
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      const hour = Number(hourText);
      const minute = Number(minuteText);
      const second = Number(secondText);
      const millis = Number(millisText.padEnd(3, '0'));
      const utcWallClock = Date.UTC(year, month - 1, day, hour, minute, second, millis);
      const check = new Date(utcWallClock);
      if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1
        || check.getUTCDate() !== day || check.getUTCHours() !== hour
        || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
        || check.getUTCMilliseconds() !== millis) {
        rolePlanConfirmationConflict(`${label} ${fieldLabel} is invalid`);
      }
      // The protocol defines offset-free schedule values as Asia/Shanghai wall time.
      timestamp = utcWallClock - (8 * 60 * 60 * 1000);
    }
    if (!Number.isFinite(timestamp) || !Number.isSafeInteger(timestamp)) {
      rolePlanConfirmationConflict(`${label} ${fieldLabel} is invalid`);
    }
    return { value: text, timestamp };
  };
  const parsedEndsAt = hasEndsAt ? parseTimestamp(endsAt, 'end time') : null;
  const normalizedEndsAt = parsedEndsAt?.value ?? null;
  if (schedule.kind === 'once') {
    const at = parseTimestamp(schedule.at, 'time');
    return { kind: 'once', at: at.value, endsAt: normalizedEndsAt,
      endsAtTimestamp: parsedEndsAt?.timestamp ?? null, timestamp: at.timestamp };
  }
  if (schedule.kind === 'interval') {
    const startsAt = parseTimestamp(schedule.startsAt, 'start time');
    if (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 300_000) {
      rolePlanConfirmationConflict(`${label} interval is invalid`);
    }
    return { kind: 'interval', startsAt: startsAt.value, startsAtTimestamp: startsAt.timestamp,
      intervalMs: schedule.intervalMs, endsAt: normalizedEndsAt,
      endsAtTimestamp: parsedEndsAt?.timestamp ?? null };
  }
  if (schedule.kind === 'daily') {
    if (typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
      rolePlanConfirmationConflict(`${label} time is invalid`);
    }
    return { kind: 'daily', time: schedule.time, endsAt: normalizedEndsAt,
      endsAtTimestamp: parsedEndsAt?.timestamp ?? null };
  }
  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1 || schedule.weekdays.length > 7
      || new Set(schedule.weekdays).size !== schedule.weekdays.length
      || schedule.weekdays.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6)
      || typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
      rolePlanConfirmationConflict(`${label} weekly rule is invalid`);
    }
    return { kind: 'weekly', weekdays: [...schedule.weekdays].sort((a, b) => a - b), time: schedule.time,
      endsAt: normalizedEndsAt, endsAtTimestamp: parsedEndsAt?.timestamp ?? null };
  }
  if (!Number.isSafeInteger(schedule.day) || schedule.day < 1 || schedule.day > 31
    || typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    rolePlanConfirmationConflict(`${label} monthly rule is invalid`);
  }
  return { kind: 'monthly', day: schedule.day, time: schedule.time, endsAt: normalizedEndsAt,
    endsAtTimestamp: parsedEndsAt?.timestamp ?? null };
}

function rolePlanTargetSnapshot(snapshot, operation) {
  if (!isPlainRolePlanObject(snapshot)) {
    rolePlanConfirmationConflict(`${operation.op} requires a pinned target snapshot`);
  }
  const planId = snapshot.planId ?? snapshot.rolePlanId;
  if (typeof planId !== 'string' || !planId.trim()) {
    rolePlanConfirmationConflict('pinned target identity is invalid');
  }
  const source = snapshot.source;
  if (!ROLE_PLAN_ALL_SOURCES.has(source)) {
    rolePlanConfirmationConflict('pinned target source is not user-authorized');
  }
  const title = snapshot.title;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 240) {
    rolePlanConfirmationConflict('pinned target title is invalid');
  }
  if (operation.planId != null && operation.planId !== planId) {
    rolePlanConfirmationConflict('pinned target identity conflict');
  }
  if (operation.targetRevision != null && snapshot.targetRevision != null
    && operation.targetRevision !== snapshot.targetRevision) {
    rolePlanConfirmationConflict('pinned target revision conflict');
  }
  return {
    planId: planId.trim(),
    source,
    title: title.trim(),
    targetRevision: snapshot.targetRevision ?? null,
    targetKey: snapshot.targetKey ?? null,
    schedule: snapshot.schedule ?? null
  };
}

function rolePlanOperationNeedsExplicitTime(operation) {
  if (operation.op === 'create') return true;
  if (operation.op !== 'update') return false;
  const patch = operation.patch;
  return Object.hasOwn(operation, 'schedule')
    || (isPlainRolePlanObject(patch) && Object.hasOwn(patch, 'schedule'));
}

function canonicalRolePlanActionPayload(operation) {
  if (!isPlainRolePlanObject(operation) || !ROLE_PLAN_CONFIRMATION_OPS.has(operation.op)) {
    rolePlanConfirmationConflict('canonical role plan operation is unknown');
  }
  const payload = structuredClone(operation);
  if (payload.op === 'create' && payload.schedule) {
    rolePlanScheduleValue(payload.schedule, 'canonical schedule');
    const { kind, endsAt, ...rest } = payload.schedule;
    payload.schedule = { kind, ...rest, ...(endsAt != null ? { endsAt } : {}) };
  }
  if (payload.op === 'update' && isPlainRolePlanObject(payload.patch)
    && Object.hasOwn(payload.patch, 'schedule')) {
    rolePlanScheduleValue(payload.patch.schedule, 'canonical patch schedule');
    const { kind, endsAt, ...rest } = payload.patch.schedule;
    payload.patch = {
      ...payload.patch,
      schedule: { kind, ...rest, ...(endsAt != null ? { endsAt } : {}) }
    };
  }
  return payload;
}

function freezeCanonicalRolePlanValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeCanonicalRolePlanValue(child);
  return Object.freeze(value);
}

function canonicalRolePlanDescriptor(descriptor, targetSnapshot = null) {
  if (!isPlainRolePlanObject(descriptor) || typeof descriptor.kind !== 'string'
    || !descriptor.kind.startsWith('role_plan_') || !isPlainRolePlanObject(descriptor.payload)) {
    rolePlanConfirmationConflict('canonical role plan descriptor is invalid');
  }
  const operation = descriptor.payload;
  const op = descriptor.kind.slice('role_plan_'.length);
  if (operation.op !== op) rolePlanConfirmationConflict('canonical role plan descriptor operation conflict');
  const validated = validateRolePlanConfirmationOperation(operation, targetSnapshot);
  const target = validated.target ? { ...validated.target } : null;
  if (target && operation.op === 'update' && isPlainRolePlanObject(operation.patch)) {
    if (typeof operation.patch.title === 'string' && operation.patch.title.trim()) {
      target.title = operation.patch.title.trim();
    }
    if (Object.hasOwn(operation.patch, 'schedule')) {
      rolePlanScheduleValue(operation.patch.schedule, 'canonical patch schedule');
      target.schedule = structuredClone(operation.patch.schedule);
    }
  }
  return {
    operation: validated.operation,
    target,
    targetRevision: descriptor.targetRevision
  };
}

function validateRolePlanConfirmationOperation(operation, targetSnapshot = null) {
  if (!isPlainRolePlanObject(operation) || !ROLE_PLAN_CONFIRMATION_OPS.has(operation.op)) {
    rolePlanConfirmationConflict('operation is unknown');
  }
  if (operation.source != null && !ROLE_PLAN_ALL_SOURCES.has(operation.source)) {
    rolePlanConfirmationConflict('operation source is not user-authorized');
  }
  if (rolePlanOperationNeedsExplicitTime(operation)) {
    if (operation.timeConfidence !== 'explicit') {
      rolePlanConfirmationConflict('explicit time confidence is required');
    }
    const schedule = operation.op === 'create'
      ? operation.schedule
      : operation.schedule ?? operation.patch?.schedule;
    rolePlanScheduleValue(schedule);
  }
  if (operation.op === 'create') {
    if (!ROLE_PLAN_CONFIRMATION_SOURCES.has(operation.source)) {
      rolePlanConfirmationConflict('operation source is not user-confirmation eligible');
    }
    if (typeof operation.title !== 'string' || !operation.title.trim()) {
      rolePlanConfirmationConflict('operation title is invalid');
    }
    if (!rolePlanOperationNeedsExplicitTime(operation)) {
      rolePlanConfirmationConflict('explicit schedule is required');
    }
    return { operation, target: null };
  }
  const target = rolePlanTargetSnapshot(targetSnapshot, operation);
  if (!ROLE_PLAN_CONFIRMATION_SOURCES.has(target.source)) {
    rolePlanConfirmationConflict('pinned target source is not user-confirmation eligible');
  }
  if (operation.source != null && operation.source !== target.source) {
    rolePlanConfirmationConflict('operation source conflicts with pinned target');
  }
  return { operation, target };
}

export function requiresUserConfirmation({
  protocolVersion,
  kind,
  operations,
  targetSnapshots = []
} = {}) {
  if (Number(protocolVersion) !== 3 || kind !== 'DIRECT_REPLY') return false;
  if (!Array.isArray(operations)) rolePlanConfirmationConflict('operations must be an array');
  if (operations.length === 0) return false;
  const sources = operations.map((operation, index) => {
    if (!isPlainRolePlanObject(operation) || !ROLE_PLAN_CONFIRMATION_OPS.has(operation.op)) {
      rolePlanConfirmationConflict('operation is unknown');
    }
    if (operation.op === 'create') {
      if (!ROLE_PLAN_ALL_SOURCES.has(operation.source)) {
        rolePlanConfirmationConflict('operation source is not user-authorized');
      }
      return operation.source;
    }
    const target = targetSnapshots[index];
    if (!isPlainRolePlanObject(target) || !ROLE_PLAN_ALL_SOURCES.has(target.source)) {
      rolePlanConfirmationConflict('pinned target source is not user-authorized');
    }
    return target.source;
  });
  const privateCount = sources.filter(source => source === 'private_decision').length;
  if (privateCount === sources.length) return false;
  if (privateCount > 0) rolePlanConfirmationConflict('mixed private and user role plan operations');
  operations.map((operation, index) =>
    validateRolePlanConfirmationOperation(operation, targetSnapshots[index] ?? null)
  );
  return true;
}

function rolePlanScheduleText(schedule, timeZone) {
  const normalized = rolePlanScheduleValue(schedule);
  const formatDate = timestamp => {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const weekday = values.weekday?.startsWith('周') ? values.weekday : `周${values.weekday || ''}`;
    return `${values.year}年${values.month}月${values.day}日（${weekday}）${values.hour}:${values.minute}`;
  };
  const endSuffix = normalized.endsAt ? `，截至${formatDate(normalized.endsAtTimestamp)}` : '';
  if (normalized.kind === 'once') return `${formatDate(normalized.timestamp)}${endSuffix}`;
  if (normalized.kind === 'interval') {
    const intervalText = normalized.intervalMs % 60_000 === 0
      ? `${normalized.intervalMs / 60_000}分钟`
      : normalized.intervalMs % 1000 === 0
        ? `${normalized.intervalMs / 1000}秒`
        : `${normalized.intervalMs}毫秒`;
    return `从${formatDate(normalized.startsAtTimestamp)}起每${intervalText}${endSuffix}`;
  }
  if (normalized.kind === 'daily') return `每天${normalized.time}${endSuffix}`;
  if (normalized.kind === 'weekly') {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每周${normalized.weekdays.map(day => weekdays[day]).join('、')}${normalized.time}${endSuffix}`;
  }
  return `每月${normalized.day}日${normalized.time}${endSuffix}`;
}

export function renderRolePlanConfirmation(operation, targetSnapshot = null, timeZone = 'Asia/Shanghai') {
  const { operation: normalized, target } = canonicalRolePlanDescriptor(operation, targetSnapshot);
  if (targetSnapshot?.targetKey != null && operation.targetKey !== targetSnapshot.targetKey) {
    rolePlanConfirmationConflict('canonical target key conflict');
  }
  if (targetSnapshot?.targetRevision != null && operation.targetRevision !== targetSnapshot.targetRevision) {
    rolePlanConfirmationConflict('canonical target revision conflict');
  }
  if (target && operation.targetRevision !== target.targetRevision) {
    rolePlanConfirmationConflict('canonical target revision conflict');
  }
  const title = target?.title || normalized.title.trim();
  if (normalized.op === 'create') {
    return `好的，我会在${rolePlanScheduleText(normalized.schedule, timeZone)}提醒你「${title}」。`;
  }
  if (normalized.op === 'update' && rolePlanOperationNeedsExplicitTime(normalized)) {
    const canonicalSchedule = target?.schedule;
    if (!canonicalSchedule) rolePlanConfirmationConflict('canonical target schedule is missing');
    return `好的，已将「${title}」调整为${rolePlanScheduleText(
      canonicalSchedule,
      timeZone
    )}。`;
  }
  const labels = {
    update: '更新',
    cancel: '取消',
    pause: '暂停',
    resume: '恢复',
    complete: '完成'
  };
  return `好的，已${labels[normalized.op] || normalized.op}「${title}」。`;
}

function renderRolePlanConfirmationSet(operations, targetSnapshots, timeZone) {
  const rendered = operations.map((descriptor, index) =>
    renderRolePlanConfirmation(descriptor, targetSnapshots[index] ?? null, timeZone)
  );
  return rendered.length === 1
    ? rendered[0]
    : rendered.map((text, index) => `${index + 1}. ${text}`).join('\n');
}

export function normalizeBrainDraft(draft) {
  const momentSource = draft?.momentAction ?? draft?.actionIntent?.moment;
  const paymentIntentAction = draft?.actionIntent?.payment?.action;
  const paymentAction = ['received', 'refused', 'pending'].includes(draft?.paymentAction)
    ? draft.paymentAction
    : ['received', 'refused', 'pending'].includes(paymentIntentAction)
      ? paymentIntentAction
    : null;
  const normalized = {
    ...(draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {}),
    action: draft?.action === 'skip' ? 'skip' : 'send',
    reply: String(draft?.reply || '').trim(),
    skipReason: String(draft?.skipReason || ''),
    paymentAction,
    momentAction: momentSource && typeof momentSource === 'object' && !Array.isArray(momentSource)
      ? {
          momentId: String(momentSource.momentId || ''),
          like: momentSource.like === true,
          comment: String(momentSource.comment || '').trim().slice(0, 1000),
          replyToCommentId: momentSource.replyToCommentId ? String(momentSource.replyToCommentId) : null
        }
      : null,
    relationshipStageReview: draft?.relationshipStageReview
      ?? draft?.actionIntent?.relationshipReview
      ?? null,
    lifePlan: draft?.lifePlan && typeof draft.lifePlan === 'object' && !Array.isArray(draft.lifePlan)
      ? {
          planKey: String(draft.lifePlan.planKey || ''),
          episodes: Array.isArray(draft.lifePlan.episodes) ? draft.lifePlan.episodes : []
        }
      : null,
    lifeAdjustment: draft?.lifeAdjustment && typeof draft.lifeAdjustment === 'object' && !Array.isArray(draft.lifeAdjustment)
      ? {
          type: String(draft.lifeAdjustment.type || 'none'),
          targetEpisodeId: String(draft.lifeAdjustment.targetEpisodeId || ''),
          startAt: draft.lifeAdjustment.startAt === null ? null : Number(draft.lifeAdjustment.startAt),
          endAt: draft.lifeAdjustment.endAt === null ? null : Number(draft.lifeAdjustment.endAt),
          reason: String(draft.lifeAdjustment.reason || '')
        }
      : null,
    usedFactIds: Array.isArray(draft?.usedFactIds) ? draft.usedFactIds.map(String) : [],
    rewriteResolution: normalizeRewriteResolution(draft?.rewriteResolution),
    rolePlanOperations: normalizeRolePlanOperations(
      draft?.rolePlanOperationsJson ?? draft?.rolePlanOperations
    )
  };
  for (let depth = 0; depth < 3 && normalized.reply.startsWith('{') && normalized.reply.endsWith('}'); depth += 1) {
    let nested;
    try { nested = JSON.parse(normalized.reply); } catch { break; }
    if (!nested || typeof nested !== 'object' || Array.isArray(nested) || typeof nested.reply !== 'string') break;
    normalized.reply = nested.reply.trim();
    if (nested.action === 'skip') normalized.action = 'skip';
    if (['received', 'refused', 'pending'].includes(nested.paymentAction)) {
      normalized.paymentAction = nested.paymentAction;
    }
    if (!normalized.usedFactIds.length && Array.isArray(nested.usedFactIds)) {
      normalized.usedFactIds = nested.usedFactIds.map(String);
    }
  }
  return normalized;
}

const CANONICAL_MOMENT_SOURCE_KEYS = Object.freeze([
  'momentId', 'like', 'comment', 'replyToCommentId'
]);
const CANONICAL_RELATIONSHIP_SOURCE_KEYS = Object.freeze([
  'baseAction', 'phaseAction', 'expectedSceneRevision', 'label', 'changedAt'
]);
const INTERNAL_RELATIONSHIP_FLATTENED_KEYS = Object.freeze([
  'from', 'to', 'reason', 'confidence', 'evidenceMessageIds', 'explicitMutualChange'
]);

function assertCanonicalSourcePrototype(value, label) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} inherited fields conflict`);
  }
}

function assertExactCanonicalSourceKeys(value, expected, label) {
  assertCanonicalSourcePrototype(value, label);
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new Error(`${label} fields conflict`);
  }
}

function canonicalMomentPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('canonical moment action must be an object');
  }
  assertExactCanonicalSourceKeys(value, CANONICAL_MOMENT_SOURCE_KEYS, 'canonical moment action');
  if (typeof value.momentId !== 'string' || !value.momentId
    || typeof value.like !== 'boolean'
    || typeof value.comment !== 'string'
    || value.comment.length > 1000
    || !(value.replyToCommentId === null
      || (typeof value.replyToCommentId === 'string' && value.replyToCommentId.length > 0))) {
    throw new Error('canonical moment action type conflict');
  }
  const payload = {
    momentId: value.momentId,
    like: value.like,
    comment: value.comment.trim(),
    replyToCommentId: value.replyToCommentId
  };
  if (payload.replyToCommentId && !payload.comment) {
    throw new Error('canonical moment reply requires comment content');
  }
  if (payload.replyToCommentId && payload.like) {
    throw new Error('canonical moment reply cannot also like');
  }
  return payload;
}

function canonicalRelationshipPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('canonical relationship transition must be an object');
  }
  assertCanonicalSourcePrototype(value, 'canonical relationship transition');
  const allowedKeys = new Set([
    ...CANONICAL_RELATIONSHIP_SOURCE_KEYS,
    ...INTERNAL_RELATIONSHIP_FLATTENED_KEYS
  ]);
  if (Object.keys(value).some(key => !allowedKeys.has(key))
    || CANONICAL_RELATIONSHIP_SOURCE_KEYS.some(key => !Object.hasOwn(value, key))) {
    throw new Error('canonical relationship transition fields conflict');
  }
  const baseAction = value.baseAction == null ? null : structuredClone(value.baseAction);
  const phaseAction = value.phaseAction == null ? null : structuredClone(value.phaseAction);
  if (!baseAction && !phaseAction) throw new Error('canonical relationship transition is empty');
  if (typeof value.expectedSceneRevision !== 'number'
    || !Number.isSafeInteger(value.expectedSceneRevision)
    || value.expectedSceneRevision < 0
    || typeof value.changedAt !== 'number'
    || !Number.isSafeInteger(value.changedAt)
    || value.changedAt < 0
    || typeof value.label !== 'string' || !value.label.trim()) {
    throw new Error('canonical relationship transition is invalid');
  }
  return {
    baseAction,
    phaseAction,
    expectedSceneRevision: value.expectedSceneRevision,
    label: value.label.trim(),
    changedAt: value.changedAt
  };
}

export function normalizeCanonicalBrainDraft(draft) {
  const momentSource = draft?.momentAction ?? draft?.actionIntent?.moment;
  const momentAction = momentSource == null ? null : canonicalMomentPayload(momentSource);
  const relationshipSource = draft?.relationshipStageAction;
  const relationshipStageAction = relationshipSource == null
    ? null
    : canonicalRelationshipPayload(relationshipSource);
  const normalized = normalizeBrainDraft(draft);
  const payment = normalized.actionIntent?.payment;
  return {
    ...normalized,
    momentAction,
    ...(payment ? { paymentAction: payment.action } : {}),
    ...(relationshipSource == null ? {} : { relationshipStageAction })
  };
}

function isMomentKind(kind) {
  return kind === 'MOMENT_INTERACTION' || kind === 'MOMENT_REPLY';
}

function isMomentPostKind(kind) {
  return ['PROACTIVE_MOMENT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'].includes(kind);
}

function currentRolePlanExecution(envelope) {
  if (!String(envelope?.kind || '').startsWith('ROLE_PLAN_')) return null;
  const context = envelope.trigger?.context || {};
  const snapshot = context.snapshot && typeof context.snapshot === 'object' ? context.snapshot : {};
  const input = context.input && typeof context.input === 'object' ? context.input : {};
  const plan = snapshot.rolePlan && typeof snapshot.rolePlan === 'object' ? snapshot.rolePlan : null;
  return {
    plan,
    occurrence: {
      planId: String(input.planId || plan?.planId || ''),
      occurrenceId: String(input.occurrenceId || ''),
      scheduledFor: Number(input.scheduledFor || envelope.trigger?.scheduledFor || 0),
      executedAt: Number(input.executedAt || envelope.trigger?.executedAt || 0)
    },
    timingContext: String(snapshot.timingContext || ''),
    delayMs: Math.max(0, Number(snapshot.delayMs) || 0)
  };
}

export function isAutomaticKind(kind) {
  return [
    'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE',
    'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY'
  ].includes(kind);
}

export function shouldSkipProactiveSilence(turn) {
  if (Number(turn?.protocolVersion) !== 3 || turn?.rolloutKey !== 'PROACTIVE_CHAT') return false;
  const authority = turn?.annotationSnapshot?.proactiveMotiveAuthority;
  if (!authority || !Array.isArray(authority.candidates)) return false;
  return authority.candidates.length === 0 || authority.structuralSilence != null;
}

export function shouldSkipPublicMomentSilence(turn) {
  if (Number(turn?.protocolVersion) !== 3 || turn?.rolloutKey !== 'PROACTIVE_MOMENT') return false;
  const authority = turn?.annotationSnapshot?.publicMomentAuthority;
  return Boolean(authority && Array.isArray(authority.candidates)
    && (authority.candidates.length === 0 || authority.structuralSilence != null));
}

function normalizeConversationFrame(frame) {
  const source = frame && typeof frame === 'object' && !Array.isArray(frame) ? frame : {};
  const initiative = source.initiative && typeof source.initiative === 'object' && !Array.isArray(source.initiative)
    ? source.initiative
    : {};
  const priorTopic = source.priorTopic && typeof source.priorTopic === 'object' && !Array.isArray(source.priorTopic)
    ? source.priorTopic
    : {};
  const interruption = source.interruption && typeof source.interruption === 'object' && !Array.isArray(source.interruption)
    ? source.interruption
    : {};
  const priorTopicStatus = ['closed', 'open', 'uncertain'].includes(priorTopic.status)
    ? priorTopic.status
    : 'uncertain';
  const waitingOn = ['user', 'yuqi', 'either', 'none', 'unclear'].includes(priorTopic.waitingOn)
    ? priorTopic.waitingOn
    : 'unclear';
  return {
    surfaceAct: String(source.surfaceAct || ''),
    intentHypotheses: Array.isArray(source.intentHypotheses)
      ? source.intentHypotheses.map(item => ({
          intent: String(item?.intent || ''),
          confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
          evidenceMessageIds: Array.isArray(item?.evidenceMessageIds) ? item.evidenceMessageIds.map(String) : []
        })).filter(item => item.intent)
      : [],
    interactionMode: String(source.interactionMode || ''),
    emotionalTone: String(source.emotionalTone || ''),
    relationshipMove: String(source.relationshipMove || ''),
    initiative: {
      topicIntroducedBy: String(initiative.topicIntroducedBy || 'unclear'),
      suggestedNextCarrier: String(initiative.suggestedNextCarrier || 'unclear'),
      reason: String(initiative.reason || '')
    },
    priorTopic: {
      status: priorTopicStatus,
      summary: String(priorTopic.summary || ''),
      waitingOn,
      evidenceMessageIds: Array.isArray(priorTopic.evidenceMessageIds)
        ? priorTopic.evidenceMessageIds.map(String)
        : [],
      reason: String(priorTopic.reason || '')
    },
    interruption: {
      requiresReaction: interruption.requiresReaction === true,
      reactionReason: String(interruption.reactionReason || '')
    },
    activeHooks: Array.isArray(source.activeHooks) ? source.activeHooks.map(String) : [],
    ambiguities: Array.isArray(source.ambiguities) ? source.ambiguities.map(String) : [],
    responseRisks: Array.isArray(source.responseRisks) ? source.responseRisks.map(String) : [],
    explicitBoundaries: Array.isArray(source.explicitBoundaries)
      ? source.explicitBoundaries.map(item => ({
          type: String(item?.type || ''),
          active: item?.active === true,
          reason: String(item?.reason || ''),
          evidenceMessageIds: Array.isArray(item?.evidenceMessageIds)
            ? item.evidenceMessageIds.map(String)
            : []
        })).filter(item => item.type && item.reason)
      : [],
    recentCorrection: source.recentCorrection && typeof source.recentCorrection === 'object'
      ? {
          active: source.recentCorrection.active === true,
          rejectedInterpretation: String(source.recentCorrection.rejectedInterpretation || ''),
          expiresAfterBatches: Math.max(
            0,
            Math.min(2, Math.trunc(Number(source.recentCorrection.expiresAfterBatches) || 0))
          ),
          evidenceMessageIds: Array.isArray(source.recentCorrection.evidenceMessageIds)
            ? source.recentCorrection.evidenceMessageIds.map(String)
            : []
        }
      : {
          active: false,
          rejectedInterpretation: '',
          expiresAfterBatches: 0,
          evidenceMessageIds: []
        },
    needsNuanceReview: source.needsNuanceReview === true
  };
}

function elapsedText(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return '不到1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}小时${remainingMinutes ? `${remainingMinutes}分钟` : ''}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}天${remainingHours ? `${remainingHours}小时` : ''}`;
}

function delayClass(milliseconds) {
  if (milliseconds < 5 * 60_000) return 'immediate';
  if (milliseconds < 60 * 60_000) return 'minutes';
  if (milliseconds < 6 * 60 * 60_000) return 'hours';
  if (milliseconds < 24 * 60 * 60_000) return 'same_day_long_gap';
  return 'day_or_more';
}

export function buildInteractionState(envelope, recentMessages, computedAt = Date.now()) {
  return buildAuthoritativeInteractionState({ envelope, messages: recentMessages, now: computedAt });
  /* istanbul ignore next -- retained temporarily for source-level compatibility */
  const messages = [...recentMessages].sort((left, right) => Number(left.sentAt || 0) - Number(right.sentAt || 0));
  const currentTime = Number(computedAt || Date.now());
  const sourceOccurredAt = Number(
    envelope.message?.sentAt || envelope.trigger?.executedAt || envelope.trigger?.scheduledFor || envelope.createdAt || currentTime
  );
  const processingDelayMs = Math.max(0, currentTime - sourceOccurredAt);
  const lastMessage = messages.at(-1) || null;
  const lastUserMessage = [...messages].reverse().find(message => message.speakerId === 'user') || null;
  const lastYuqiMessage = [...messages].reverse().find(message => message.speakerId === envelope.characterId) || null;
  const unansweredOutgoingCount = lastUserMessage
    ? messages.filter(message => message.speakerId === envelope.characterId && Number(message.sentAt || 0) > Number(lastUserMessage.sentAt || 0)).length
    : messages.filter(message => message.speakerId === envelope.characterId).length;
  const elapsed = message => message ? Math.max(0, currentTime - Number(message.sentAt || currentTime)) : null;
  return {
    computedAt: currentTime,
    computedAtIso: new Date(currentTime).toISOString(),
    sourceOccurredAt,
    sourceOccurredAtIso: new Date(sourceOccurredAt).toISOString(),
    processingDelayMs,
    processingDelayText: elapsedText(processingDelayMs),
    processingDelayClass: delayClass(processingDelayMs),
    replyFromPresent: true,
    lastMessageId: lastMessage?.messageId || null,
    lastSpeakerId: lastMessage?.speakerId || null,
    lastUserMessageId: lastUserMessage?.messageId || null,
    lastYuqiMessageId: lastYuqiMessage?.messageId || null,
    silenceMsSinceLastMessage: elapsed(lastMessage),
    silenceMsSinceLastUserMessage: elapsed(lastUserMessage),
    silenceMsSinceLastYuqiMessage: elapsed(lastYuqiMessage),
    unansweredOutgoingCount,
    waitingForUserReply: unansweredOutgoingCount > 0,
    triggerSnapshotIsAdvisory: Boolean(envelope.trigger?.context?.snapshot)
  };
}

function inferredPaymentAction(text) {
  const value = String(text || '');
  if (/(?:不收|不领|拒收|退给你|还给你|你拿回去)/.test(value)) return 'refused';
  if (/(?:那我就收|我收下|收了|领了|领取了|点开了|拆了)/.test(value)) return 'received';
  return null;
}

function resolvedPaymentAction(envelope, draft) {
  if (!envelope.context?.payment) return null;
  if (envelope.protocolVersion === 3) {
    const payment = draft?.actionIntent?.payment;
    if (!payment || !['received', 'refused', 'pending'].includes(payment.action)
      || payment.messageId !== envelope.context.payment.messageId
      || payment.kind !== envelope.context.payment.kind
      || payment.amount !== envelope.context.payment.amount) {
      throw new Error('v3 payment intent authority mismatch');
    }
    return payment.action;
  }
  return inferredPaymentAction(draft.reply) || draft.paymentAction || 'pending';
}

function repairReplyForDelivery(reply, kind = 'DIRECT_REPLY') {
  const text = String(reply || '').trim();
  if (!text) {
    return kind === 'DIRECT_REPLY'
      ? '刚才那句话没发出来，你再跟我说一次？'
      : '';
  }
  return text.length > 20_000 ? text.slice(0, 20_000) : text;
}

function hasLifeDecision(draft) {
  return Boolean(
    draft?.lifePlan?.episodes?.length
    || (draft?.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none')
  );
}

function proactiveDeliveryRewrite(previous = null, attempt = 1, originalDecision = 'skip') {
  return normalizeSupervisorResult({
    decision: 'rewrite',
    approved: false,
    originalDecision,
    issues: [{
      code: 'PROACTIVE_DELIVERY_REQUIRED',
      severity: 'soft',
      message: '本轮主动私聊需要形成自然可见正文，不要以沉默结束',
      mustPreserve: ['事实、身份、时间、关系状态和生活连续性'],
      mustChange: ['把空草稿改成虞栖此刻真实想发的一条消息'],
      allowedStrategies: ['分享生活片段', '自然换话题', '轻量试探', '重新开口'],
      acceptanceCriteria: ['reply 是非空可见正文', '不解释系统规则']
    }]
  }, { attempt, previous, direct: false });
}

export class YuqiOrchestrator {
  constructor({
    store, presets, codex, workerId = 'yuqi-worker', clock = Date.now, contextLimit = 200,
    generationContextLimit = 20, roleProfiles = DEFAULT_PROFILES, lifeSimulation = null,
    lifePlanningEnabled = true, cognitivePipeline = null, promotionController = null,
    lifePlanningDispatcher = null, releaseExecutor = null
  }) {
    if (!store || !presets || !codex) throw new Error('store, presets, and codex are required');
    this.store = store;
    this.presets = presets;
    this.codex = codex;
    this.workerId = workerId;
    this.clock = clock;
    this.contextLimit = Math.max(1, Math.min(5000, Number(contextLimit) || 200));
    this.generationContextLimit = Math.max(1, Math.min(200, Number(generationContextLimit) || 20));
    this.roleProfiles = roleProfiles;
    this.lifeSimulation = lifeSimulation || new LifeSimulationCoordinator({ store });
    this.lifePlanningEnabled = lifePlanningEnabled !== false;
    this.lifePlanningPromises = new Map();
    this.lifePlanningRetryAfter = new Map();
    this.brainRolePromise = null;
    this.turnImagePaths = new Map();
    this.cognitivePipeline = cognitivePipeline;
    this.promotionController = promotionController;
    this.lifePlanningDispatcher = lifePlanningDispatcher;
    this.releaseExecutor = releaseExecutor;
    this.releaseExecutorAttached = Boolean(releaseExecutor);
  }

  attachReleaseExecutor(releaseExecutor) {
    if (this.releaseExecutorAttached) throw new Error('release executor already attached');
    if (!releaseExecutor || typeof releaseExecutor.executeTurn !== 'function'
      || typeof releaseExecutor.executeLife !== 'function') {
      throw new Error('complete release executor is required');
    }
    this.releaseExecutor = releaseExecutor;
    this.releaseExecutorAttached = true;
    return this;
  }

  accept(rawEnvelope) {
    const envelope = validateEnvelope(rawEnvelope);
    if (this.promotionController && !this.releaseExecutorAttached) {
      throw new Error('canonical release executor is not attached');
    }
    const canonical = Boolean(
      this.promotionController
      && envelope?.characterId === 'yuqi'
      && [2, 3].includes(Number(envelope?.protocolVersion))
      && CANONICAL_TURN_KINDS.has(String(envelope?.kind || ''))
    );
    let submitted = canonical
      ? this.createCanonicalTurnForEnvelope(envelope)
      : this.promotionController
        ? this.promotionController.createTurn({
            envelope,
            presetVersion: this.presets.current().version,
            annotationSnapshot: {}
          })
        : this.store.submitTurn(envelope);
    if (submitted.state === 'failed') {
      if (Number(submitted.resultAuthorityVersion || 0) === 1) {
        if (Number(submitted.protocolVersion) === 2 && failureClassForTurn(submitted) === 'transient') {
          submitted = this.store.requeueCanonicalFailedTurnInternal({
            turnId: submitted.turnId,
            expectedTurnRevision: submitted.turnRevision,
            allowedFailureClass: 'transient'
          });
        }
      } else {
        const recovery = this.store.requeueTransientFailedTurn(submitted.turnId);
        if (recovery.requeued) submitted = recovery.turn;
      }
    }
    if (submitted.state === 'queued' && (!submitted.routeReasons || submitted.routeReasons.length === 0)) {
      const decision = selectTurnRoute({
        envelope,
        recentMessages: this.store.listMessages(envelope.characterId, this.contextLimit)
      });
      if (Number(submitted.resultAuthorityVersion || 0) === 1) {
        return this.store.setCanonicalTurnRouteInternal({
          turnId: submitted.turnId,
          expectedState: submitted.state,
          expectedTurnRevision: submitted.turnRevision,
          route: decision.route,
          reasons: decision.reasons
        });
      }
      return this.store.setTurnRoute(submitted.turnId, decision.route, decision.reasons);
    }
    return submitted;
  }

  createCanonicalTurnForEnvelope(envelope) {
    const exactTurn = this.store.getTurn(envelope.turnId);
    const exactCanonicalTurn = Number(exactTurn?.resultAuthorityVersion || 0) === 1
      ? exactTurn
      : null;
    const retryParentId = envelope?.context?.retry?.retryOfTurnId || null;
    const retryParent = retryParentId ? this.store.getTurn(retryParentId) : null;
    if (retryParentId && !retryParent) {
      throw new Error('missing canonical retry parent');
    }
    if (retryParent
      && Number(retryParent.resultAuthorityVersion || 0) !== 1
      && envelope.protocolVersion !== 3) {
      return this.promotionController.createTurn({
        envelope,
        presetVersion: this.presets.current().version,
        annotationSnapshot: {}
      });
    }
    const pinnedTurn = exactCanonicalTurn || retryParent;
    const selection = pinnedTurn
      ? null
      : this.promotionController.selectPipelinePairForFreshSubject(
          envelope.kind,
          { now: this.clock() }
        );
    const pair = pinnedTurn
      ? {
          visibleReleaseId: pinnedTurn.authoritativeReleaseId,
          comparisonReleaseId: pinnedTurn.comparisonReleaseId,
          comparisonDirection: comparisonContractForMode(
            pinnedTurn.comparisonMode
          ).comparisonDirection
        }
      : selection.pair;
    const rollout = selection?.rollout || null;
    const laneKey = envelope.protocolVersion === 3
      ? envelope.authority.laneKey
      : laneKeyForEnvelope(envelope);
    const lane = this.store.getInteractionLane(envelope.characterId, laneKey) || {
      revision: 0,
      localSequence: 0,
      clearEpoch: 0,
      clearedThroughSequence: 0
    };
    const currentBatch = resolveCurrentUserBatch(envelope);
    const agencySnapshot = exactCanonicalTurn
      ? { checksum: exactCanonicalTurn.agencySnapshotChecksum }
      : this.store.readAgencyAuthoritySnapshotInternal({
          roleId: envelope.characterId,
          at: canonicalInteractionAt(envelope, this.clock())
        });
    const annotationSnapshot = exactCanonicalTurn?.annotationSnapshot
      || retryParent?.annotationSnapshot
      || (envelope.kind === 'PROACTIVE_CHAT'
        ? {
            proactiveMotiveAuthority: buildProactiveMotiveAuthority({
              consideredAt: canonicalInteractionAt(envelope, this.clock()),
              lifeContext: proactiveMotiveSourceContext(
                this.store,
                envelope.characterId,
                canonicalInteractionAt(envelope, this.clock())
              ),
              cognitiveState: this.store.getCognitiveState?.(envelope.characterId),
              consumedMotiveIds: this.store.listConsumedProactiveMotiveIdsInternal?.({
                roleId: envelope.characterId
              }) || [],
              hardConstraints: agencySnapshot.constraints || []
            })
          }
        : envelope.kind === 'PROACTIVE_MOMENT'
          ? {
              publicMomentAuthority: this.store.rebuildPublicMomentAuthorityInternal({ envelope })
            }
          : ['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(envelope.kind)
            ? {
                momentTargetAuthority: this.store.rebuildMomentTargetAuthorityInternal({ envelope })
              }
            : {});
    const creation = this.store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: envelope.kind,
      expectedRolloutRevision: pinnedTurn?.rolloutRevision ?? rollout.revision,
      authoritativeReleaseId: pair.visibleReleaseId,
      comparisonReleaseId: pair.comparisonReleaseId,
      comparisonDirection: pair.comparisonDirection,
      laneKey,
      expectedLaneRevision: lane.revision,
      inputUserBatchId: currentBatch?.batchId
        || envelope.message?.messageId
        || envelope.trigger?.triggerId,
      inputVisibilitySequence: envelope.protocolVersion === 3
        ? envelope.context.visibilityCursor.localSequence
        : Number(lane.localSequence || 0),
      inputClearEpoch: envelope.protocolVersion === 3
        ? envelope.context.visibilityCursor.clearEpoch
        : Number(lane.clearEpoch || 0),
      agencySnapshotChecksum: agencySnapshot.checksum,
      annotationSnapshot
    });
    if (creation.status === 'already_committed') {
      return {
        ...creation.receipt,
        status: 'already_committed',
        state: 'committed',
        terminal: true,
        turnId: creation.receipt.authoritativeTurnId
      };
    }
    if (creation.status === 'redacted') {
      return {
        status: 'redacted',
        state: 'redacted',
        terminal: true,
        visible: false,
        turnId: creation.receipt?.authoritativeTurnId ?? creation.lineage?.latestTurnId ?? null,
        authorityLineageKey:
          creation.receipt?.authorityLineageKey ?? creation.lineage?.lineageKey ?? null,
        visibleGroupId: creation.receipt?.visibleGroupId ?? null,
        commitChecksum: creation.receipt?.commitChecksum ?? null,
        replyParts: [],
        actions: []
      };
    }
    return creation.turn;
  }

  async recover(turnId) {
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new Error('turn not found');
    if (Number(turn.resultAuthorityVersion || 0) === 0) {
      return { ...(await this.run(turnId)), recoveryPath: 'legacy' };
    }
    const lineage = this.store.getTurnAuthorityLineage(turn.authorityLineageKey);
    let failure = null;
    if (turn.errorJson) {
      try { failure = JSON.parse(turn.errorJson); } catch { failure = null; }
    }
    if (turn.state === 'failed'
      && lineage?.state === 'cancelled'
      && failure?.code === 'superseded_by_user_batch') {
      return {
        status: 'superseded',
        state: 'failed',
        terminal: true,
        visible: false,
        turnId: turn.turnId,
        authorityLineageKey: turn.authorityLineageKey,
        replyParts: [],
        actions: [],
        recoveryPath: 'canonical'
      };
    }
    const validLineage = lineage
      && ['open', 'committed'].includes(lineage.state)
      && lineage.latestTurnId === turn.turnId
      && Number(lineage.revision) >= Number(turn.lineageRevisionAtCreation || 0);
    if (!validLineage) {
      const reasonCode = !lineage
        ? 'missing canonical lineage'
        : 'canonical lineage latest turn invariant';
      this.store.putDiagnostic?.({
        turnId,
        stage: 'canonical_recovery_quarantine',
        level: 'error',
        detail: { reasonCode }
      });
      return { status: 'quarantined', reasonCode, recoveryPath: 'canonical' };
    }
    const outcome = this.store.readCanonicalCommitOutcomeInternal?.({
      lineageKey: turn.authorityLineageKey,
      expectedTurnId: turn.turnId
    });
    if (outcome) {
      return { ...outcome, recoveryPath: 'canonical' };
    }
    return {
      ...turn,
      recoveryPath: 'canonical',
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      laneRevision: turn.laneRevision
    };
  }

  deliveryPolicyFor(envelope) {
    if (envelope.kind !== 'PROACTIVE_CHAT') return null;
    try {
      return this.store.getProactiveChatDeliveryPolicy(envelope.characterId);
    } catch (error) {
      const fallback = {
        kind: 'proactive_chat',
        windowSize: 4,
        maxSkips: 1,
        usedSkips: 0,
        skipAllowed: true,
        inspectedTurnIds: [],
        resetAfterTurnId: null
      };
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'proactive_delivery_policy',
        level: 'warning',
        detail: {
          action: 'policy_read_failed',
          message: error.message,
          skipAllowed: true
        }
      });
      return fallback;
    }
  }

  async process(envelope) {
    const submitted = this.accept(envelope);
    if (submitted?.terminal === true) return submitted;
    return this.run(submitted.turnId);
  }

  async withBrainRoleLock(operation) {
    const previous = this.brainRolePromise || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.brainRolePromise = current;
    try {
      return await current;
    } finally {
      if (this.brainRolePromise === current) this.brainRolePromise = null;
    }
  }

  async ensureLifePlan(characterId, at = this.clock()) {
    const now = Number(at);
    const context = this.lifeSimulation.advanceTo(characterId, now);
    if (!this.lifePlanningEnabled) return { planned: false, reason: 'disabled', context };
    if (!context.needsPlan) return { planned: false, reason: 'horizon_sufficient', context };
    if (this.lifePlanningDispatcher && this.promotionController) {
      const attempt = this.promotionController.createLifePlanningAttempt({
        roleId: characterId,
        planningContext: context,
        now
      });
      this.lifePlanningDispatcher.poke();
      return {
        planned: false,
        reason: 'planning_queued',
        planningId: attempt.planningId,
        state: attempt.executionState,
        context
      };
    }
    if (Number(this.lifePlanningRetryAfter.get(characterId) || 0) > now) {
      return { planned: false, reason: 'retry_cooldown', context };
    }
    if (this.lifePlanningPromises.has(characterId)) return this.lifePlanningPromises.get(characterId);

    const planKey = `life_plan_${contentHash({
      characterId,
      planWindowStartAt: context.planWindowStartAt,
      presetVersion: this.presets.current().version
    }).slice(0, 24)}`;
    const operation = this.withBrainRoleLock(async () => {
      const profile = roleExecutionProfile('deep', 'brain', this.roleProfiles);
      const request = {
        task: 'plan_yuqi_life',
        preset: this.presets.compileFor('brain', { scene: { kind: 'LIFE_PLANNING' } }),
        characterId,
        planKey,
        lifeContext: context,
        planningWindow: {
          startAt: context.planWindowStartAt,
          targetEndAt: context.targetPlanEndAt,
          minimumCoverageMs: 6 * 60 * 60_000,
          maximumCoverageMs: 24 * 60 * 60_000
        }
      };
      try {
        const response = await this.codex.runTurn('brain', JSON.stringify(request), {
          clientUserMessageId: planKey,
          outputSchema: ROLE_OUTPUT_SCHEMAS.brain,
          model: profile.model,
          effort: profile.effort
        });
        const draft = normalizeBrainDraft(parseRoleJson(response.text, 'brain'));
        if (draft.action !== 'skip' || draft.reply || draft.momentAction || draft.lifeAdjustment) {
          throw new Error('chat brain planning task must stay silent');
        }
        const episodes = Array.isArray(draft.lifePlan?.episodes) ? draft.lifePlan.episodes : [];
        const ordered = episodes
          .map(item => ({ ...item, startAt: Number(item.startAt), endAt: Number(item.endAt) }))
          .sort((left, right) => left.startAt - right.startAt);
        if (!ordered.length || ordered.length > 12) throw new Error('chat brain returned an invalid life plan size');
        if (ordered[0].startAt < context.planWindowStartAt) throw new Error('chat brain life plan starts in the past');
        if (ordered[0].startAt - context.planWindowStartAt > 60 * 60_000) {
          throw new Error('chat brain life plan leaves a large initial gap');
        }
        for (let index = 1; index < ordered.length; index += 1) {
          if (ordered[index].startAt < ordered[index - 1].endAt) {
            throw new Error('chat brain life plan overlaps');
          }
        }
        const coverageMs = ordered.at(-1).endAt - ordered[0].startAt;
        if (coverageMs < 6 * 60 * 60_000 || coverageMs > 24 * 60 * 60_000) {
          throw new Error('chat brain life plan coverage is outside the allowed window');
        }
        this.store.putLifePlan(characterId, ordered, { sourceTurnId: planKey });
        this.lifePlanningRetryAfter.delete(characterId);
        return {
          planned: true,
          planKey,
          episodes: this.store.listLifeEpisodes(characterId, { from: context.planWindowStartAt }),
          context: this.lifeSimulation.advanceTo(characterId, now)
        };
      } catch (error) {
        this.lifePlanningRetryAfter.set(characterId, now + 10 * 60_000);
        throw error;
      }
    });
    this.lifePlanningPromises.set(characterId, operation);
    try {
      return await operation;
    } finally {
      if (this.lifePlanningPromises.get(characterId) === operation) {
        this.lifePlanningPromises.delete(characterId);
      }
    }
  }

  setLifePlanningDispatcher(dispatcher) {
    this.lifePlanningDispatcher = dispatcher;
  }

  buildLifePlanningReleaseExecution(attempt) {
    return { attempt };
  }

  async executeLegacyReleaseTurnDraft({ release, execution }) {
    const turn = execution?.turn;
    const envelope = execution?.envelope;
    if (!turn?.turnId || !envelope?.characterId) {
      throw new Error('legacy release turn draft execution is unavailable');
    }
    const declaredBatch = execution.currentBatch || resolveCurrentUserBatch(envelope);
    const storedMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds?.length || 0))
    );
    const currentBatch = execution.currentBatch
      || resolveCurrentUserBatch(envelope, storedMessages);
    const stateMessages = evidenceMessages(storedMessages, currentBatch);
    const recentMessages = withoutCurrentBatch(stateMessages, currentBatch, this.contextLimit);
    let route = execution.routeDecision?.route || turn.route || 'deep';
    const baseScene = execution.scene || sceneFromEnvelope(envelope);
    const interactionState = buildAuthoritativeInteractionState({
      envelope,
      messages: stateMessages,
      currentStage: baseScene.relationshipStage,
      now: this.clock()
    });
    const lifeContext = this.lifeSimulation.contextFor(envelope.characterId, this.clock());
    const memoryRequest = {
      task: envelope.message ? 'retrieve_and_extract_evidence' : 'retrieve_context_for_trigger',
      preset: this.legacyReleasePreset('memory', release, {
        ...baseScene,
        kind: envelope.kind
      }),
      scene: baseScene,
      ...(currentBatch
        ? { currentUserBatch: currentUserBatchForRole(currentBatch) }
        : { currentTrigger: envelope.trigger, triggerIsNotUserEvidence: true }),
      recentMessages,
      interactionState,
      lifeContext
    };
    const memoryProfile = roleExecutionProfile(route === 'fast' ? 'fast' : 'deep', 'memory', this.roleProfiles);
    let memoryResult = await this.runStructuredRoleDraftOnly({
      turnId: turn.turnId,
      role: 'memory',
      request: memoryRequest,
      clientUserMessageId: `${turn.turnId}_release_memory`,
      profile: memoryProfile,
      localImagePaths: execution.localImagePaths
    });
    if (route === 'fast' && memoryResult.requiresDeepMemory === true) {
      route = 'deep';
      memoryResult = await this.runStructuredRoleDraftOnly({
        turnId: turn.turnId,
        role: 'memory',
        request: {
          ...memoryRequest,
          task: 'deep_retrieve_and_extract_evidence',
          fastMemoryReview: memoryResult
        },
        clientUserMessageId: `${turn.turnId}_release_memory_deep`,
        profile: roleExecutionProfile('deep', 'memory', this.roleProfiles),
        localImagePaths: execution.localImagePaths
      });
    }
    const conversationFrame = normalizeConversationFrame(memoryResult.conversationFrame);
    const relationship = resolveRelationshipStage(
      baseScene,
      memoryResult.relationshipStageReview,
      stateMessages,
      this.clock()
    );
    const withRelationshipStageAction = draft => ({
      ...draft,
      relationshipStageAction: relationship.action
        ? structuredClone(relationship.action)
        : null
    });
    const scene = {
      ...baseScene,
      relationshipStage: relationship.stage
    };
    const interactionContract = compileInteractionContract({
      envelope,
      scene,
      interactionState,
      conversationFrame,
      recentMessages: stateMessages
    });
    if (route === 'fast' && (
      interactionContract.preserveAmbiguity
      || interactionContract.recentCorrection.active
      || interactionContract.explicitBoundaries.length > 0
      || conversationFrame.needsNuanceReview
    )) {
      route = 'deep';
    }
    if (envelope.kind === 'PROACTIVE_CHAT' && interactionContract.shouldRespond === false) {
      return withRelationshipStageAction(normalizeBrainDraft({
        action: 'skip',
        reply: '',
        skipReason: 'structural_silence',
        usedFactIds: [],
        rolePlanOperationsJson: '[]'
      }));
    }
    const memoryPacket = {
      query: String(memoryResult.query || currentBatch?.combinedText || envelope.trigger?.triggerType || ''),
      keywords: Array.isArray(memoryResult.keywords) ? memoryResult.keywords.map(String) : [],
      conversationFrame,
      interactionContract,
      effectiveRelationshipStage: relationship.stage,
      relationshipStageAction: relationship.action,
      lifeContext
    };
    const generationMessages = buildGenerationWindow(stateMessages, {
      currentMessageIds: currentBatch?.messageIds || [],
      limit: this.generationContextLimit
    });
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const deliveryPolicy = this.readDraftDeliveryPolicy(envelope);
    let previous = null;
    let previousDraft = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const brainRequest = {
        task: previous?.decision === 'rewrite' ? 'rewrite_as_yuqi' : 'reply_as_yuqi',
        preset: this.legacyReleasePreset('brain', release, {
          ...scene,
          kind: envelope.kind,
          revealedFactIds: evidencePack.facts.map(fact => fact.factId)
        }),
        scene,
        ...(currentBatch
          ? { currentUserBatch: currentUserBatchForRole(currentBatch) }
          : { currentTrigger: envelope.trigger }),
        ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
        ...(currentRolePlanExecution(envelope)
          ? { currentRolePlanExecution: currentRolePlanExecution(envelope) }
          : {}),
        recentMessages: generationMessages,
        interactionState,
        lifeContext,
        evidencePack,
        interactionContract,
        ...(execution.agencyView ? { agencyView: execution.agencyView } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        ...(previous?.decision === 'rewrite' ? {
          rejectedDraft: previousDraft,
          supervisorIssues: previous.issues || [],
          rewriteContract: rewriteContractForBrain(previous)
        } : {})
      };
      let draft = normalizeBrainDraft(await this.withBrainRoleLock(() =>
        this.runStructuredRoleDraftOnly({
          turnId: turn.turnId,
          role: 'brain',
          request: brainRequest,
          clientUserMessageId: `${turn.turnId}_release_brain_${attempt}`,
          profile: roleExecutionProfile(route === 'fast' ? 'fast' : 'deep', 'brain', this.roleProfiles),
          localImagePaths: execution.localImagePaths
        })
      ));
      if (draft.action === 'skip' && !isAutomaticKind(envelope.kind)) {
        draft = { ...draft, action: 'send', reply: repairReplyForDelivery('', envelope.kind) };
      }
      const validMomentAction = isMomentKind(envelope.kind)
        && draft.momentAction?.momentId
        && (draft.momentAction.like || draft.momentAction.comment);
      if (isMomentKind(envelope.kind) && !validMomentAction) {
        draft = { ...draft, action: 'skip', reply: '' };
      }
      const hard = draft.action === 'skip' || validMomentAction
        ? { ok: true, issues: [] }
        : hardValidateReply(draft.reply);
      if (!hard.ok) {
        draft = isAutomaticKind(envelope.kind) && !String(draft.reply || '').trim()
          ? { ...draft, action: 'skip', reply: '' }
          : { ...draft, action: 'send', reply: repairReplyForDelivery(draft.reply, envelope.kind) };
      }
      if (draft.action === 'skip' && deliveryPolicy?.skipAllowed === false) {
        previous = proactiveDeliveryRewrite(previous, attempt, 'brain_skip');
        previousDraft = draft;
        route = 'deep';
        continue;
      }
      if (draft.action === 'skip' || (
        route === 'fast'
        && !hasLifeDecision(draft)
        && draft.rolePlanOperations.length === 0
      )) {
        return withRelationshipStageAction(draft);
      }
      route = 'deep';
      const supervisorRequest = {
        task: 'review_yuqi_reply',
        preset: this.legacyReleasePreset('supervisor', release, {
          ...scene,
          kind: envelope.kind
        }),
        scene,
        ...(currentBatch
          ? { currentUserBatch: currentUserBatchForRole(currentBatch) }
          : { currentTrigger: envelope.trigger }),
        ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
        ...(currentRolePlanExecution(envelope)
          ? { currentRolePlanExecution: currentRolePlanExecution(envelope) }
          : {}),
        recentMessages: generationMessages,
        interactionState,
        lifeContext,
        evidencePack,
        conversationFrame,
        interactionContract,
        ...(execution.agencyView ? { agencyView: execution.agencyView } : {}),
        ...(deliveryPolicy ? { deliveryPolicy } : {}),
        draft,
        previousReview: previous,
        rewriteResolution: draft.rewriteResolution
      };
      let reviewed = normalizeSupervisorResult(await this.runStructuredRoleDraftOnly({
        turnId: turn.turnId,
        role: 'supervisor',
        request: supervisorRequest,
        clientUserMessageId: `${turn.turnId}_release_supervisor_${attempt}`,
        profile: roleExecutionProfile('deep', 'supervisor', this.roleProfiles),
        localImagePaths: execution.localImagePaths
      }), {
        attempt,
        previous,
        direct: !isAutomaticKind(envelope.kind)
      });
      if (deliveryPolicy?.skipAllowed === false
        && ['skip', 'reject'].includes(reviewed.decision)) {
        reviewed = proactiveDeliveryRewrite(previous, attempt, reviewed.decision);
      }
      if (reviewed.decision === 'approve') return withRelationshipStageAction(draft);
      if (reviewed.decision === 'skip') {
        if (!isAutomaticKind(envelope.kind)) {
          throw new Error('supervisor cannot skip a direct reply');
        }
        return withRelationshipStageAction({ ...draft, action: 'skip', reply: '' });
      }
      if (reviewed.decision === 'reject') {
        if (!isAutomaticKind(envelope.kind)) throw new Error('supervisor rejected the reply');
        return withRelationshipStageAction({ ...draft, action: 'skip', reply: '' });
      }
      if (attempt >= 3) {
        if (deliveryPolicy?.skipAllowed === false) {
          if (hasHighPriorityIssues(reviewed) || !String(draft.reply || '').trim()) {
            throw new Error('PROACTIVE_DELIVERY_BLOCKED: no safe visible reply after rewrites');
          }
          return withRelationshipStageAction(draft);
        }
        if (isAutomaticKind(envelope.kind)) {
          return withRelationshipStageAction({ ...draft, action: 'skip', reply: '' });
        }
        if (!(hasHighPriorityIssues(reviewed) && attempt === 3)) {
          return withRelationshipStageAction(draft);
        }
      }
      previous = reviewed;
      previousDraft = draft;
    }
    throw new Error('legacy release draft exceeded supervisor rewrite limit');
  }

  legacyReleasePreset(role, release, scene) {
    const pinnedVersion = String(release?.presetVersion || '');
    if (!pinnedVersion || typeof this.presets.resolvePresetBundle !== 'function') {
      return this.presets.compileFor(role, { scene });
    }
    const current = this.presets.current();
    if (current.version === pinnedVersion) return this.presets.compileFor(role, { scene });
    const bundle = this.presets.resolvePresetBundle({ role, version: pinnedVersion, annotations: [] });
    return [
      bundle,
      '',
      '## 本轮运行边界',
      `当前关系阶段：${scene?.relationshipStage?.label || scene?.relationshipStage?.id || '初识'}`,
      scene?.kind ? `当前场景：${scene.kind}` : '',
      `当前预设版本：${pinnedVersion}`
    ].filter(Boolean).join('\n');
  }

  readDraftDeliveryPolicy(envelope) {
    if (envelope.kind !== 'PROACTIVE_CHAT') return null;
    try {
      return this.store.getProactiveChatDeliveryPolicy(envelope.characterId);
    } catch {
      return {
        kind: 'proactive_chat',
        windowSize: 4,
        maxSkips: 1,
        usedSkips: 0,
        skipAllowed: true,
        inspectedTurnIds: [],
        resetAfterTurnId: null
      };
    }
  }

  async runStructuredRoleDraftOnly({
    turnId,
    role,
    request,
    clientUserMessageId,
    profile,
    localImagePaths = []
  }) {
    if (!profile?.model || !profile?.effort) throw new Error(`missing execution profile for ${role}`);
    if (!String(turnId || '')) throw new Error(`turnId is required for ${role}`);
    let invalidOutput = '';
    let activeProfile = profile;
    let capacityFallbackUsed = false;
    const roleImagePaths = Array.isArray(localImagePaths) && localImagePaths.length
      ? localImagePaths
      : this.turnImagePaths.get(turnId) || [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const payload = attempt === 1 ? request : {
        ...request,
        protocolRepair: {
          attempt,
          rule: 'Return exactly one JSON object that matches the supplied output schema.',
          invalidOutput: invalidOutput.slice(0, 2_000)
        }
      };
      const baseMessageId = attempt === 1
        ? clientUserMessageId
        : `${clientUserMessageId}_protocol_${attempt}`;
      let response;
      try {
        response = await this.codex.runTurn(role, JSON.stringify(payload), {
          clientUserMessageId: baseMessageId,
          outputSchema: ROLE_OUTPUT_SCHEMAS[role],
          model: activeProfile.model,
          effort: activeProfile.effort,
          localImagePaths: roleImagePaths
        });
      } catch (error) {
        const alternate = capacityFallbackUsed ? null : fallbackRoleProfile(activeProfile);
        if (!isModelCapacityError(error) || !alternate) throw error;
        capacityFallbackUsed = true;
        activeProfile = alternate;
        response = await this.codex.runTurn(role, JSON.stringify(payload), {
          clientUserMessageId: `${baseMessageId}_capacity_fallback`,
          outputSchema: ROLE_OUTPUT_SCHEMAS[role],
          model: activeProfile.model,
          effort: activeProfile.effort,
          localImagePaths: roleImagePaths
        });
      }
      invalidOutput = String(response.text || '');
      try {
        return parseRoleJson(invalidOutput, role);
      } catch (error) {
        if (attempt === 2 || !String(error.message).startsWith(`${role} returned invalid`)) throw error;
      }
    }
    throw new Error(`${role} returned invalid structured output twice`);
  }

  async executeLegacyLifeReleaseDraft({ execution }) {
    return this.executeLifePlanningAttempt({
      ...execution?.attempt,
      authoritativePipeline: 'legacy'
    });
  }

  async executeCognitionV2LifeReleaseDraft({ execution }) {
    return this.executeLifePlanningAttempt({
      ...execution?.attempt,
      authoritativePipeline: 'cognition'
    });
  }

  async executeCognitionV3LifeReleaseDraft({ execution }) {
    return this.executeLifePlanningAttempt({
      ...execution?.attempt,
      authoritativePipeline: 'cognition-v3'
    });
  }

  async executeLifePlanningAttempt(attempt) {
    const snapshot = attempt?.inputSnapshot || {};
    const planningWindow = snapshot.planningWindow || {};
    const planKey = attempt.planningId;
    return this.withBrainRoleLock(async () => {
      const profile = roleExecutionProfile('deep', 'brain', this.roleProfiles);
      const request = {
        task: ['cognition', 'cognition-v3'].includes(attempt.authoritativePipeline)
          ? 'plan_yuqi_life_with_cognition'
          : 'plan_yuqi_life',
        preset: this.presets.compileFor('brain', { scene: { kind: 'LIFE_PLANNING' } }),
        characterId: attempt.roleId,
        planKey,
        lifeContext: snapshot,
        planningWindow: {
          startAt: Number(planningWindow.startAt),
          targetEndAt: Number(planningWindow.targetEndAt),
          minimumCoverageMs: 6 * 60 * 60_000,
          maximumCoverageMs: 24 * 60 * 60_000
        }
      };
      const response = await this.codex.runTurn('brain', JSON.stringify(request), {
        clientUserMessageId: planKey,
        outputSchema: ROLE_OUTPUT_SCHEMAS.brain,
        model: profile.model,
        effort: profile.effort
      });
      const draft = normalizeBrainDraft(parseRoleJson(response.text, 'brain'));
      if (draft.action !== 'skip' || draft.reply || draft.momentAction || draft.lifeAdjustment) {
        throw new Error('life planning task must stay silent');
      }
      const episodes = Array.isArray(draft.lifePlan?.episodes) ? draft.lifePlan.episodes : [];
      const ordered = episodes
        .map(item => ({
          ...item,
          startAt: Number(item.startAt),
          endAt: Number(item.endAt)
        }))
        .sort((left, right) => left.startAt - right.startAt);
      if (!ordered.length || ordered.length > 12) throw new Error('invalid life plan size');
      if (ordered[0].startAt < Number(planningWindow.startAt)) throw new Error('life plan starts in the past');
      if (ordered[0].startAt - Number(planningWindow.startAt) > 60 * 60_000) {
        throw new Error('life plan leaves a large initial gap');
      }
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].startAt < ordered[index - 1].endAt) throw new Error('life plan overlaps');
      }
      const coverageMs = ordered.at(-1).endAt - ordered[0].startAt;
      if (coverageMs < 6 * 60 * 60_000 || coverageMs > 24 * 60 * 60_000) {
        throw new Error('life plan coverage is outside the allowed window');
      }
      return { episodes: ordered };
    });
  }

  buildCanonicalReleaseExecution(turnId, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['localImagePaths', 'localImageReceipt'].includes(key))) {
      throw new Error('canonical release execution options conflict');
    }
    const turn = this.store.getTurn(String(turnId || ''));
    if (!turn || Number(turn.resultAuthorityVersion) !== 1
      || turn.authorityRedactedAt != null
      || !turn.authorityLineageKey
      || !turn.agencySnapshotChecksum) {
      throw new Error('canonical release execution authority conflict');
    }
    const lineage = this.store.getTurnAuthorityLineage(turn.authorityLineageKey);
    if (!lineage || lineage.state !== 'open'
      || lineage.latestTurnId !== turn.turnId
      || lineage.committedGroupId != null) {
      throw new Error('canonical release execution authority conflict');
    }
    let storedEnvelope;
    try {
      storedEnvelope = JSON.parse(turn.envelopeJson);
    } catch {
      throw new Error('canonical release execution envelope conflict');
    }
    if (!storedEnvelope || storedEnvelope.redacted === true
      || storedEnvelope.turnId !== turn.turnId
      || storedEnvelope.characterId !== turn.characterId) {
      throw new Error('canonical release execution envelope conflict');
    }
    if (typeof this.store.assertCanonicalTurnInputAuthorityInternal !== 'function') {
      throw new Error('canonical release execution authority conflict');
    }
    this.store.assertCanonicalTurnInputAuthorityInternal({
      storedTurn: turn,
      incomingEnvelope: storedEnvelope,
      mode: 'live_reopen'
    });
    const declaredBatch = resolveCurrentUserBatch(storedEnvelope);
    const persistedBatch = this.store.getCurrentUserBatch(turn.turnId) || declaredBatch;
    const rawAttachments = (declaredBatch?.messages || []).flatMap(message =>
      Array.isArray(message?.attachments) ? message.attachments : []
    );
    const localImagePaths = options.localImagePaths === undefined
      ? []
      : options.localImagePaths;
    if (!Array.isArray(localImagePaths)
      || localImagePaths.some(path => typeof path !== 'string' || !path.trim())
      || new Set(localImagePaths).size !== localImagePaths.length
      || localImagePaths.length !== rawAttachments.length
      || (Number(turn.protocolVersion) === 3 && localImagePaths.length > 1)) {
      throw new Error('canonical release execution image paths conflict');
    }
    const localImageReceipt = options.localImageReceipt ?? null;
    if (localImageReceipt !== null) {
      if (!localImageReceipt || typeof localImageReceipt !== 'object' || Array.isArray(localImageReceipt)
        || Object.keys(localImageReceipt).sort().join(',') !== 'attachmentChecksum,path,turnId'
        || localImageReceipt.turnId !== turn.turnId
        || localImageReceipt.path !== localImagePaths[0]
        || typeof localImageReceipt.attachmentChecksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(localImageReceipt.attachmentChecksum)) {
        throw new Error('canonical release execution image receipt conflict');
      }
      const declaredImage = String(rawAttachments[0]?.dataUrl || '').match(
        /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i
      );
      const declaredChecksum = declaredImage
        ? createHash('sha256').update(Buffer.from(declaredImage[1], 'base64')).digest('hex')
        : null;
      if (declaredChecksum !== localImageReceipt.attachmentChecksum) {
        throw new Error('canonical release execution image receipt conflict');
      }
    }
    if ((Number(turn.protocolVersion) === 3 && localImagePaths.length > 0) !== Boolean(localImageReceipt)) {
      throw new Error('canonical release execution image receipt conflict');
    }
    const envelope = structuredClone(storedEnvelope);
    const currentBatch = persistedBatch ? structuredClone(persistedBatch) : null;
    if (localImagePaths.length) {
      envelope.message = stripAttachmentData(envelope.message);
      if (Array.isArray(envelope.context?.currentBatch?.messages)) {
        envelope.context.currentBatch.messages =
          envelope.context.currentBatch.messages.map(stripAttachmentData);
      }
      if (Array.isArray(currentBatch.messages)) {
        currentBatch.messages = currentBatch.messages.map(stripAttachmentData);
      }
    }
    const agencySnapshot = this.store.readAgencyAuthoritySnapshotInternal({
      roleId: turn.characterId,
      at: canonicalInteractionAt(envelope, this.clock())
    });
    if (agencySnapshot.checksum !== turn.agencySnapshotChecksum) {
      const error = new Error('canonical agency authority is stale');
      error.code = 'AGENCY_AUTHORITY_STALE';
      throw error;
    }
    const agencyView = compileAgencyView({
      constraints: agencySnapshot.constraints,
      preferences: agencySnapshot.preferenceFacts || [],
      stances: agencySnapshot.stances,
      featureContext: envelope.context || {},
      limits: { hardConstraints: 5, currentStances: 2, preferences: 4 }
    });
    return {
      turn,
      envelope,
      scene: Number(turn.protocolVersion) === 3 && PUBLIC_MOMENT_KINDS.has(turn.rolloutKey)
        ? {}
        : Number(turn.protocolVersion) === 3
          ? cognitionSceneForV3(sceneFromEnvelope(envelope))
          : sceneFromEnvelope(envelope),
      currentBatch,
      localImagePaths: [...localImagePaths],
      ...(localImageReceipt ? { localImageReceipt: structuredClone(localImageReceipt) } : {}),
      agencyView,
      routeDecision: {
        route: turn.route,
        cognitiveState: this.store.getCognitiveState?.(turn.characterId) || {},
        allowedActionTargets: {}
      }
    };
  }

  async run(turnId) {
    let current = this.store.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (Number(current.resultAuthorityVersion || 0) === 1) {
      if (!this.releaseExecutorAttached) {
        throw new Error('canonical release executor is not attached');
      }
      return this.runCanonicalReleaseTurn(current);
    }
    if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
    if (['delivered', 'completed'].includes(current.state) && current.replyJson) return JSON.parse(current.replyJson);
    if (['failed', 'fallback'].includes(current.state)) throw new Error(`turn is already ${current.state}`);
    const envelope = JSON.parse(current.envelopeJson);
    const initialBatch = resolveCurrentUserBatch(envelope);
    const rawAttachments = initialBatch?.messages.flatMap(message =>
      Array.isArray(message?.attachments) ? message.attachments : []
    ) || [];
    const preparedImages = await materializeImageAttachments(rawAttachments, { turnId });
    if (preparedImages.paths.length) {
      this.turnImagePaths.set(turnId, preparedImages.paths);
      envelope.message = stripAttachmentData(envelope.message);
      if (Array.isArray(envelope.context?.currentBatch?.messages)) {
        envelope.context.currentBatch.messages = envelope.context.currentBatch.messages.map(stripAttachmentData);
      }
    }

    try {
      current = this.store.getTurn(turnId);
      if (
        current.pipelineMode === 'active'
        && [
          'DIRECT_REPLY',
          'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
          'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE',
          'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
          'MOMENT_INTERACTION', 'MOMENT_REPLY'
        ].includes(envelope.kind)
        && this.cognitivePipeline
        && ['queued', 'memory_running', 'memory_done', 'brain_running'].includes(current.state)
      ) {
        const stateMessages = this.store.listMessages(
          envelope.characterId,
          Math.min(5000, this.contextLimit + Number(initialBatch?.messageIds.length || 0))
        );
        const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
        const scene = sceneFromEnvelope(envelope);
        const interactionState = buildAuthoritativeInteractionState({
          envelope,
          messages: stateMessages,
          currentStage: scene.relationshipStage,
          now: this.clock()
        });
        const cognition = await this.cognitivePipeline.runForeground({
          turn: current,
          envelope,
          scene,
          currentBatch,
          routeDecision: {
            route: current.route,
            interactionState,
            lifeContext: this.lifeSimulation.advanceTo(envelope.characterId, this.clock()),
            cognitiveState: this.store.getCognitiveState?.(envelope.characterId) || {},
            allowedActionTargets: {
              lifeEpisodeIds: this.store.listLifeEpisodes?.(envelope.characterId)
                ?.map(item => item.episodeId) || [],
              momentIds: [
                envelope.trigger?.context?.momentId,
                envelope.trigger?.context?.targetMomentId
              ].filter(Boolean),
              commentIds: [
                envelope.trigger?.context?.commentId,
                envelope.trigger?.context?.targetCommentId
              ].filter(Boolean),
              rolePlanIds: [
                envelope.trigger?.context?.planId
              ].filter(Boolean)
            }
          }
        });
        current = this.store.getTurn(turnId);
        if (current.state === 'memory_done') {
          this.store.advanceTurn(turnId, 'memory_done', 'brain_running');
          current = this.store.getTurn(turnId);
        }
        if (current.state === 'brain_running') {
          this.store.advanceTurn(turnId, 'brain_running', 'brain_done', {
            brainDraftJson: JSON.stringify(cognition.draft)
          });
          current = this.store.getTurn(turnId);
        }
        if (current.state === 'brain_done') {
          const hard = cognition.draft.action === 'send'
            ? hardValidateReply(cognition.draft.reply)
            : { ok: true, issues: [] };
          if (!hard.ok) throw new Error(`active cognition reply is not deliverable: ${hard.issues.map(item => item.code).join(',')}`);
          this.store.advanceTurn(turnId, 'brain_done', 'approved', {
            brainDraftJson: JSON.stringify(cognition.draft)
          });
        }
      }
      for (let step = 0; step < 16; step += 1) {
        current = this.store.getTurn(turnId);
        if (current.state === 'queued') {
          current = this.store.claimTurnById(turnId, this.workerId);
          if (!current) throw new Error('turn could not be claimed');
          continue;
        }
        if (current.state === 'memory_running') {
          await this.completeMemory(envelope);
          continue;
        }
        if (current.state === 'memory_done') {
          const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
          if (
            envelope.kind === 'PROACTIVE_CHAT'
            && memoryPacket.interactionContract?.shouldRespond === false
          ) {
            const reason = String(
              memoryPacket.interactionContract.structuralSilenceReason
              || 'structural_silence'
            );
            this.store.putDiagnostic({
              turnId,
              stage: 'structural_silence',
              level: 'info',
              detail: {
                action: 'structural_silence',
                reason,
                initiativeOwner: memoryPacket.interactionContract.initiativeOwner,
                activeIssue: memoryPacket.interactionContract.activeIssue
              }
            });
            this.store.advanceTurn(turnId, 'memory_done', 'approved', {
              brainDraftJson: JSON.stringify({
                action: 'skip',
                reply: '',
                skipReason: 'structural_silence',
                usedFactIds: [],
                rolePlanOperationsJson: '[]'
              })
            });
            continue;
          }
          this.store.advanceTurn(turnId, 'memory_done', 'brain_running');
          continue;
        }
        if (current.state === 'brain_running') {
          await this.completeBrain(envelope, current);
          continue;
        }
        if (current.state === 'brain_done') {
          let draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
          if (draft.action === 'skip' && !isAutomaticKind(envelope.kind)) {
            draft = { ...draft, action: 'send', reply: repairReplyForDelivery('', envelope.kind) };
          }
          const deliveryPolicy = this.deliveryPolicyFor(envelope);
          if (draft.action === 'skip' && deliveryPolicy?.skipAllowed === false) {
            const previousRaw = current.supervisorJson
              ? parseRoleJson(current.supervisorJson, 'supervisor')
              : null;
            const previous = previousRaw
              ? normalizeSupervisorResult(previousRaw, {
                  attempt: Number(previousRaw.attempt || 1),
                  direct: false
                })
              : null;
            const review = proactiveDeliveryRewrite(
              previous,
              Number(previous?.attempt || 0) + 1,
              'brain_skip'
            );
            this.store.putDiagnostic({
              turnId,
              stage: 'proactive_skip_rewrite_requested',
              level: 'warning',
              detail: {
                policy: deliveryPolicy,
                modelDecision: 'skip',
                rewriteAttempt: review.attempt
              }
            });
            this.store.advanceTurn(turnId, 'brain_done', 'brain_running', {
              brainDraftJson: JSON.stringify(draft),
              supervisorJson: JSON.stringify(review)
            });
            continue;
          }
          if (draft.action === 'skip') {
            if (current.route !== 'deep' && (hasLifeDecision(draft) || draft.rolePlanOperations.length)) {
              this.store.setTurnRoute(turnId, 'fast_to_deep', [
                ...(Array.isArray(current.routeReasons) ? current.routeReasons : []),
                ...(hasLifeDecision(draft) ? ['life_decision'] : []),
                ...(draft.rolePlanOperations.length ? ['role_plan_decision'] : [])
              ]);
              current = this.store.getTurn(turnId);
            }
            this.store.advanceTurn(
              turnId, 'brain_done', current.route === 'fast' ? 'approved' : 'supervisor_running',
              { brainDraftJson: JSON.stringify(draft) }
            );
            continue;
          }
          const validMomentAction = isMomentKind(envelope.kind)
            && draft.momentAction?.momentId
            && (draft.momentAction.like || draft.momentAction.comment);
          if (isMomentKind(envelope.kind) && !validMomentAction) draft = { ...draft, action: 'skip', reply: '' };
          const hard = validMomentAction ? { ok: true, issues: [] } : hardValidateReply(draft.reply);
          const repairedDraft = hard.ok
            ? draft
            : isAutomaticKind(envelope.kind) && !String(draft.reply || '').trim()
              ? { ...draft, action: 'skip', reply: '' }
              : { ...draft, action: 'send', reply: repairReplyForDelivery(draft.reply, envelope.kind) };
          if (!hard.ok) {
            this.store.putDiagnostic({
              turnId,
              stage: 'brain_done',
              level: 'warning',
              detail: { action: 'reply_repaired_for_delivery', issues: hard.issues.map(issue => issue.code) }
            });
          }
          if (current.route !== 'deep' && (hasLifeDecision(repairedDraft) || repairedDraft.rolePlanOperations.length)) {
            this.store.setTurnRoute(turnId, 'fast_to_deep', [
              ...(Array.isArray(current.routeReasons) ? current.routeReasons : []),
              ...(hasLifeDecision(repairedDraft) ? ['life_decision'] : []),
              ...(repairedDraft.rolePlanOperations.length ? ['role_plan_decision'] : [])
            ]);
            current = this.store.getTurn(turnId);
          }
          this.store.advanceTurn(
            turnId,
            'brain_done',
            current.route === 'fast' ? 'approved' : 'supervisor_running',
            { brainDraftJson: JSON.stringify(repairedDraft) }
          );
          continue;
        }
        if (current.state === 'supervisor_running') {
          await this.completeSupervisor(envelope, current);
          continue;
        }
        if (current.state === 'approved') return this.commitApproved(envelope, current);
        if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
        throw new Error(`turn cannot resume from ${current.state}`);
      }
      throw new Error('turn exceeded orchestration step limit');
    } catch (error) {
      current = this.store.getTurn(turnId);
      if (current && !['committed', 'delivered', 'completed', 'failed'].includes(current.state)) {
        try {
          this.store.advanceTurn(turnId, current.state, 'failed', {
            errorJson: JSON.stringify({ name: error.name, message: error.message })
          });
        } catch {}
      }
      if (current?.pipelineMode === 'active' && this.promotionController) {
        try {
          const transient = /timeout|rate.?limit|capacity|temporar/i.test(
            `${error?.name || ''} ${error?.message || ''}`
          );
          this.promotionController.recordActivePipelineFailure({
            subjectType: 'turn',
            subjectId: turnId,
            errorCode: String(error?.code || error?.name || 'ACTIVE_PRECOMMIT_CRITICAL'),
            failureClass: transient ? 'transient' : 'deterministic',
            report: { summary: { stage: current.state } },
            now: this.clock()
          });
        } catch (rollbackError) {
          this.store.putDiagnostic({
            turnId,
            stage: 'active_rollout_failure',
            level: 'error',
            detail: { name: rollbackError.name, message: rollbackError.message }
          });
        }
      }
      this.store.putDiagnostic({
        turnId,
        stage: current?.state || 'unknown',
        level: 'error',
        detail: { name: error.name, message: error.message }
      });
      throw error;
    } finally {
      this.turnImagePaths.delete(turnId);
      await preparedImages.cleanup();
    }
  }

  canonicalVisibleGroup(turn, envelope, draft) {
    const texts = Array.isArray(draft?.bubblePlan) && draft.bubblePlan.length
      ? draft.bubblePlan.map(item => String(item?.text || '').trim()).filter(Boolean)
      : String(draft?.reply || '').trim()
        ? [String(draft.reply).trim()]
        : [];
    if (draft?.action === 'skip') return { items: [] };
    const recipientId = ['PROACTIVE_MOMENT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE']
      .includes(turn.rolloutKey)
      ? 'public_moments'
      : 'user';
    return {
      items: texts.map(content => ({
        content,
        speakerId: envelope.characterId,
        speakerType: 'character',
        recipientId
      }))
    };
  }

  commitCanonicalVisibleResult(input) {
    return commitVisibleResult(input);
  }

  canonicalResolvedActionBundle(turn, draft) {
    const actionInputs = [];
    if (draft?.paymentAction && draft.paymentAction !== 'pending' && draft?.actionIntent?.payment) {
      const payment = draft.actionIntent.payment;
      actionInputs.push({
        kind: payment.action === 'received' ? 'payment_accept' : 'payment_decline',
        payload: { messageId: payment.messageId }
      });
    }
    if (draft?.momentAction) {
      const payload = canonicalMomentPayload(draft.momentAction);
      const kind = payload.replyToCommentId
        ? 'moment_reply'
        : payload.comment
          ? 'moment_comment'
          : payload.like
            ? 'moment_like'
            : '';
      if (kind) actionInputs.push({ kind, payload });
    }
    if (draft?.relationshipStageAction) {
      actionInputs.push({
        kind: 'relationship_transition',
        payload: canonicalRelationshipPayload(draft.relationshipStageAction)
      });
    }
    const rolePlanOperations = Number(turn?.protocolVersion) === 3
      && ROLE_PLAN_V3_KINDS.has(turn?.rolloutKey)
      && draft?.rolePlanOperations != null
      ? normalizeCanonicalV3RolePlanOperations(draft.rolePlanOperations)
      : [];
    for (const operation of rolePlanOperations) {
      actionInputs.push({
        kind: `role_plan_${operation.op}`,
        payload: canonicalRolePlanActionPayload(operation),
        rolePlan: true
      });
    }
    const resolved = actionInputs.map(action => {
      const target = this.store.resolveCanonicalActionTargetInternal({ turn, action });
      const descriptor = Object.freeze({
        kind: action.kind,
        targetKey: target.targetKey,
        targetRevision: target.targetRevision,
        payload: freezeCanonicalRolePlanValue(structuredClone(action.payload))
      });
      const targetSnapshot = action.rolePlan
        ? freezeCanonicalRolePlanValue({
            ...(isPlainRolePlanObject(target.canonicalTarget)
              ? structuredClone(target.canonicalTarget)
              : {}),
            ...(isPlainRolePlanObject(target.canonicalTarget)
              && (target.canonicalTarget.planId ?? target.canonicalTarget.plan_id)
              ? { planId: target.canonicalTarget.planId ?? target.canonicalTarget.plan_id }
              : {}),
            targetKey: target.targetKey,
            targetRevision: target.targetRevision
          })
        : null;
      return {
        descriptor,
        targetSnapshot,
        rolePlan: Boolean(action.rolePlan)
      };
    });
    return {
      actions: resolved.map(entry => entry.descriptor),
      rolePlan: resolved.filter(entry => entry.rolePlan).map(entry => ({
        descriptor: entry.descriptor,
        targetSnapshot: entry.targetSnapshot
      }))
    };
  }

  canonicalActionSet(turn, draft) {
    return this.canonicalResolvedActionBundle(turn, draft).actions;
  }

  canonicalRolePlanActionBundle(turn, draft) {
    const bundle = this.canonicalResolvedActionBundle(turn, draft);
    return {
      actions: bundle.rolePlan.map(entry => entry.descriptor),
      targetSnapshots: bundle.rolePlan.map(entry => entry.targetSnapshot)
    };
  }

  comparisonJobDraftFromCanonicalTurn(turn, envelope) {
    const contract = comparisonContractForMode(turn.comparisonMode);
    if (!contract.comparisonDirection) return null;
    return {
      jobId: `compare_${contentHash({
        lineageKey: turn.authorityLineageKey,
        releaseId: turn.comparisonReleaseId,
        direction: contract.comparisonDirection
      }).slice(0, 24)}`,
      jobType: contract.jobType,
      payload: {
        turnId: turn.turnId,
        comparisonReleaseId: turn.comparisonReleaseId,
        comparisonDirection: contract.comparisonDirection,
        rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
        shadowEpoch: turn.shadowEpoch,
        canaryEpoch: turn.canaryEpoch,
        canarySlot: turn.canarySlot,
        annotationSnapshotChecksum: contentHash(turn.annotationSnapshot || {}),
        inputChecksum: contentHash({
          envelope,
          authoritativeReleaseId: turn.authoritativeReleaseId,
          authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
          comparisonReleaseId: turn.comparisonReleaseId,
          comparisonPipelineChecksum: turn.comparisonPipelineChecksum,
          rolloutRevision: turn.rolloutRevision,
          rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
          shadowEpoch: turn.shadowEpoch,
          canaryEpoch: turn.canaryEpoch,
          canarySlot: turn.canarySlot
        })
      }
    };
  }

  commitCanonicalProactiveSkip(turn, envelope) {
    const authority = turn.annotationSnapshot?.proactiveMotiveAuthority;
    const proactiveAuthorityChecksum = authority?.checksum;
    if (typeof proactiveAuthorityChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(proactiveAuthorityChecksum)) {
      throw new Error('proactive motive authority conflict');
    }
    const current = this.store.getTurn(turn.turnId);
    const lineage = this.store.getTurnAuthorityLineage(turn.authorityLineageKey);
    const lane = this.store.getInteractionLane(turn.characterId, turn.laneKey);
    const visibleGroup = { items: [] };
    const actionSet = [];
    const fingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet,
      contextRevision: contentHash({
        agencySnapshotChecksum: turn.agencySnapshotChecksum,
        proactiveMotiveAuthorityChecksum: proactiveAuthorityChecksum
      })
    });
    return commitVisibleResult({
      store: this.store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: current.turnRevision,
      expectedLineageRevision: lineage.revision,
      expectedLaneRevision: lane.revision,
      expectedCognitiveStateRevision:
        Number(this.store.getCognitiveState?.(turn.characterId)?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonDirection: comparisonContractForMode(turn.comparisonMode).comparisonDirection,
      visibleGroup,
      actionSet,
      proactiveMotiveEvidenceIds: [],
      statePatch: null,
      memoryJobs: [],
      comparisonJob: this.comparisonJobDraftFromCanonicalTurn(turn, envelope),
      generationFingerprint: fingerprint,
      now: this.clock()
    });
  }

  commitCanonicalMomentSkip(turn, envelope) {
    const isProactiveMoment = turn.rolloutKey === 'PROACTIVE_MOMENT';
    const authority = isProactiveMoment
      ? turn.annotationSnapshot?.publicMomentAuthority
      : turn.annotationSnapshot?.momentTargetAuthority;
    const authorityChecksum = authority?.checksum;
    if (!authority || typeof authorityChecksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(authorityChecksum)) {
      throw new Error('moment authority conflict');
    }
    const current = this.store.getTurn(turn.turnId);
    const lineage = this.store.getTurnAuthorityLineage(turn.authorityLineageKey);
    const lane = this.store.getInteractionLane(turn.characterId, turn.laneKey);
    const visibleGroup = { items: [] };
    const actionSet = [];
    const fingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet,
      contextRevision: contentHash({
        agencySnapshotChecksum: turn.agencySnapshotChecksum,
        momentTargetAuthorityChecksum: authorityChecksum
      })
    });
    return commitVisibleResult({
      store: this.store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: current.turnRevision,
      expectedLineageRevision: lineage.revision,
      expectedLaneRevision: lane.revision,
      expectedCognitiveStateRevision:
        Number(this.store.getCognitiveState?.(turn.characterId)?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonDirection: comparisonContractForMode(turn.comparisonMode).comparisonDirection,
      visibleGroup,
      actionSet,
      ...(isProactiveMoment
        ? { publicMomentEvidenceIds: [] }
        : { momentTargetAuthorityChecksum: authorityChecksum }),
      statePatch: null,
      memoryJobs: [],
      comparisonJob: this.comparisonJobDraftFromCanonicalTurn(turn, envelope),
      generationFingerprint: fingerprint,
      now: this.clock()
    });
  }

  async runCanonicalReleaseTurn(turn) {
    const readSupersededOutcome = () => {
      const current = this.store.getTurn(turn.turnId);
      const lineage = current?.authorityLineageKey
        ? this.store.getTurnAuthorityLineage(current.authorityLineageKey)
        : null;
      const error = current?.errorJson ? (() => {
        try { return JSON.parse(current.errorJson); } catch { return null; }
      })() : null;
      if (current?.state === 'failed'
        && lineage?.state === 'cancelled'
        && error?.code === 'superseded_by_user_batch') {
        return {
          status: 'superseded',
          state: 'failed',
          terminal: true,
          visible: false,
          turnId: current.turnId,
          authorityLineageKey: current.authorityLineageKey,
          replyParts: [],
          actions: []
        };
      }
      return null;
    };
    const supersededBeforeExecution = readSupersededOutcome();
    if (supersededBeforeExecution) return supersededBeforeExecution;
    const existing = this.store.readCanonicalCommitOutcomeInternal({
      lineageKey: turn.authorityLineageKey,
      expectedTurnId: turn.turnId
    });
    if (existing?.receipt) return existing.receipt;
    if (existing?.status === 'redacted') return existing;
    const storedEnvelope = JSON.parse(turn.envelopeJson);
    const shouldSkipPublicMoment = shouldSkipPublicMomentSilence(turn);
    if (shouldSkipProactiveSilence(turn) || shouldSkipPublicMoment) {
      try {
        return shouldSkipPublicMoment
          ? this.commitCanonicalMomentSkip(turn, storedEnvelope)
          : this.commitCanonicalProactiveSkip(turn, storedEnvelope);
      } catch (error) {
        const supersededAfterSkipCommitFailure = readSupersededOutcome();
        if (supersededAfterSkipCommitFailure) return supersededAfterSkipCommitFailure;
        throw error;
      }
    }
    const declaredBatch = resolveCurrentUserBatch(storedEnvelope);
    const persistedBatch = this.store.getCurrentUserBatch(turn.turnId) || declaredBatch;
    const rawAttachments = (declaredBatch?.messages || []).flatMap(message =>
      Array.isArray(message?.attachments) ? message.attachments : []
    );
    let preparedImages;
    try {
      preparedImages = await materializeImageAttachments(rawAttachments, {
        turnId: turn.turnId,
        retainReceipt: turn.protocolVersion === 3
      });
    } catch (error) {
      const supersededAfterImageFailure = readSupersededOutcome();
      if (supersededAfterImageFailure) return supersededAfterImageFailure;
      throw error;
    }
    if (preparedImages.paths.length) {
      this.turnImagePaths.set(turn.turnId, preparedImages.paths);
    }
    try {
      const supersededAfterPreparation = readSupersededOutcome();
      if (supersededAfterPreparation) return supersededAfterPreparation;
      const execution = this.buildCanonicalReleaseExecution(turn.turnId, {
        localImagePaths: [...preparedImages.paths],
        ...(preparedImages.receipt ? { localImageReceipt: preparedImages.receipt } : {})
      });
      if (contentHash(execution.turn) !== contentHash(turn)) {
        throw new Error('canonical release execution identity conflict');
      }
      const { envelope, currentBatch } = execution;
      let executionResult;
      try {
        executionResult = await this.releaseExecutor.executeTurn({
          releaseId: turn.authoritativeReleaseId,
          releaseChecksum: turn.authoritativePipelineChecksum,
          execution,
          dryRun: false
        });
      } catch (error) {
        const supersededAfterFailure = readSupersededOutcome();
        if (supersededAfterFailure) return supersededAfterFailure;
        throw error;
      }
      const supersededAfterExecution = readSupersededOutcome();
      if (supersededAfterExecution) return supersededAfterExecution;
      const rawRolePlanOperations = executionResult?.draft
        && (Object.hasOwn(executionResult.draft, 'rolePlanOperationsJson')
          ? executionResult.draft.rolePlanOperationsJson
          : Object.hasOwn(executionResult.draft, 'rolePlanOperations')
            ? executionResult.draft.rolePlanOperations
            : undefined);
      const isRolePlanV3 = Number(turn.protocolVersion) === 3 && ROLE_PLAN_V3_KINDS.has(turn.rolloutKey);
      if (isRolePlanV3 && rawRolePlanOperations !== undefined) {
        normalizeCanonicalV3RolePlanOperations(rawRolePlanOperations);
      }
      const normalizedDraft = normalizeCanonicalBrainDraft(executionResult.draft);
      let relationshipStageAction = normalizedDraft.relationshipStageAction || null;
      if (!relationshipStageAction && normalizedDraft.relationshipStageReview) {
        const relationshipMessages = evidenceMessages(
          this.store.listMessages(
            envelope.characterId,
            Math.min(5000, this.contextLimit + Number(currentBatch?.messageIds?.length || 0))
          ),
          currentBatch
        );
        relationshipStageAction = resolveRelationshipStage(
          sceneFromEnvelope(envelope),
          normalizedDraft.relationshipStageReview,
          relationshipMessages,
          this.clock()
        ).action;
      }
      let draft = {
        ...normalizedDraft,
        relationshipStageAction: relationshipStageAction
          ? structuredClone(relationshipStageAction)
          : null
      };
      const isProactiveV3 = Number(turn.protocolVersion) === 3
        && turn.rolloutKey === 'PROACTIVE_CHAT';
      const isMomentV3 = Number(turn.protocolVersion) === 3
        && ['PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(turn.rolloutKey);
      if (isProactiveV3 && draft.action === 'skip') {
        const intent = draft.actionIntent || {};
        const polluted = ['payment', 'moment', 'rolePlan', 'lifeAdjustment', 'relationshipReview']
          .some(key => intent[key] != null);
        if (polluted || draft.relationshipStageAction != null
          || String(draft.reply || '').trim()
          || (Array.isArray(draft.bubblePlan) && draft.bubblePlan.length)) {
          throw new Error('PROACTIVE_CHAT skip authority conflict');
        }
      }
      if (draft.action === 'skip' && !isAutomaticKind(turn.rolloutKey)) {
        throw new Error('DIRECT_REPLY cannot commit an empty canonical result');
      }
      // A proactive skip is a terminal zero-result disposition.  A stale
      // relationship review must never smuggle an action into that group.
      const resolvedActionBundle = this.canonicalResolvedActionBundle(turn, draft);
      const actionSet = canonicalActionSetForDraft({
        isProactiveV3,
        draft,
        resolve: () => resolvedActionBundle.actions
      });
      const rolePlanBundle = {
        actions: resolvedActionBundle.rolePlan.map(entry => entry.descriptor),
        targetSnapshots: resolvedActionBundle.rolePlan.map(entry => entry.targetSnapshot)
      };
      const isRolePlanV3Direct = Number(turn.protocolVersion) === 3
        && turn.rolloutKey === 'DIRECT_REPLY';
      if (isRolePlanV3Direct && rolePlanBundle.actions.length) {
        if (draft.action === 'skip') {
          throw new Error('role plan confirmation authority conflict');
        }
        const confirmationRequired = requiresUserConfirmation({
          protocolVersion: turn.protocolVersion,
          kind: turn.rolloutKey,
          operations: rolePlanBundle.actions.map(action => action.payload),
          targetSnapshots: rolePlanBundle.targetSnapshots
        });
        if (confirmationRequired) {
          const renderedReply = renderRolePlanConfirmationSet(
            rolePlanBundle.actions,
            rolePlanBundle.targetSnapshots,
            'Asia/Shanghai'
          );
          draft = {
            ...draft,
            reply: renderedReply,
            bubblePlan: null
          };
        }
      }
      const visibleGroup = this.canonicalVisibleGroup(turn, envelope, draft);
      assertCanonicalActionSetForTurn({
        turnKind: turn.rolloutKey,
        action: draft.action,
        actionSet
      });
      const proactiveAuthorityChecksum = isProactiveV3
        ? turn.annotationSnapshot?.proactiveMotiveAuthority?.checksum
        : null;
      const momentTargetAuthorityChecksum = isMomentV3
        && turn.rolloutKey !== 'PROACTIVE_MOMENT'
        ? turn.annotationSnapshot?.momentTargetAuthority?.checksum
        : null;
      if (isProactiveV3 && (typeof proactiveAuthorityChecksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(proactiveAuthorityChecksum))) {
        throw new Error('proactive motive authority conflict');
      }
      const fingerprint = generationFingerprint({
        roleId: turn.characterId,
        laneKey: turn.laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup,
        actionSet,
        contextRevision: isProactiveV3
          ? contentHash({
              agencySnapshotChecksum: turn.agencySnapshotChecksum,
              proactiveMotiveAuthorityChecksum: proactiveAuthorityChecksum
            })
          : isMomentV3
            ? contentHash({
                agencySnapshotChecksum: turn.agencySnapshotChecksum,
                momentTargetAuthorityChecksum:
                  turn.rolloutKey === 'PROACTIVE_MOMENT'
                    ? turn.annotationSnapshot?.publicMomentAuthority?.checksum
                    : momentTargetAuthorityChecksum
              })
            : turn.agencySnapshotChecksum
      });
      const current = this.store.getTurn(turn.turnId);
      const lineage = this.store.getTurnAuthorityLineage(turn.authorityLineageKey);
      const lane = this.store.getInteractionLane(turn.characterId, turn.laneKey);
      try {
        return this.commitCanonicalVisibleResult({
          store: this.store,
          turnId: turn.turnId,
          authorityLineageKey: turn.authorityLineageKey,
          laneKey: turn.laneKey,
          expectedTurnRevision: current.turnRevision,
          expectedLineageRevision: lineage.revision,
          expectedLaneRevision: lane.revision,
          expectedCognitiveStateRevision:
            Number(this.store.getCognitiveState?.(turn.characterId)?.revision || 0),
          expectedLatestUserBatchId: turn.inputUserBatchId,
          inputVisibilitySequence: turn.inputVisibilitySequence,
          inputClearEpoch: turn.inputClearEpoch,
          agencySnapshotChecksum: turn.agencySnapshotChecksum,
          authoritativeReleaseId: turn.authoritativeReleaseId,
          comparisonReleaseId: turn.comparisonReleaseId,
          comparisonDirection: comparisonContractForMode(turn.comparisonMode).comparisonDirection,
          visibleGroup,
          actionSet,
          ...(isMomentV3
            ? turn.rolloutKey === 'PROACTIVE_MOMENT'
              ? {
                  publicMomentEvidenceIds: draft.action === 'skip'
                    ? []
                    : draft.interactionDecision?.publicMomentEvidenceIds
                      || draft.publicMomentEvidenceIds
              }
              : { momentTargetAuthorityChecksum }
            : {}),
          ...(isProactiveV3
            ? {
                proactiveMotiveEvidenceIds: draft.action === 'skip'
                  ? []
                  : draft.interactionDecision?.motiveEvidenceIds
              }
            : {}),
          statePatch: Number(turn.protocolVersion) === 3
            ? (draft.statePatch || null)
            : null,
          memoryJobs: [],
          comparisonJob: this.comparisonJobDraftFromCanonicalTurn(turn, envelope),
          generationFingerprint: fingerprint,
          now: this.clock()
        });
      } catch (error) {
        const supersededAfterCommitFailure = readSupersededOutcome();
        if (supersededAfterCommitFailure) return supersededAfterCommitFailure;
        throw error;
      }
    } finally {
      this.turnImagePaths.delete(turn.turnId);
      await preparedImages.cleanup();
    }
  }

  async completeMemory(envelope) {
    try {
      await this.ensureLifePlan(envelope.characterId, this.clock());
    } catch (error) {
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'life_planning',
        level: 'warning',
        detail: { name: error.name, message: error.message }
      });
    }
    const lifeContext = this.lifeSimulation.advanceTo(envelope.characterId, this.clock());
    const declaredBatch = resolveCurrentUserBatch(envelope);
    const stateMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds.length || 0))
    );
    const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
    const recentMessages = withoutCurrentBatch(stateMessages, currentBatch, this.contextLimit);
    const evidenceSourceMessages = evidenceMessages(stateMessages, currentBatch);
    const scene = sceneFromEnvelope(envelope);
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: stateMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const memoryRequest = {
      task: envelope.message ? 'retrieve_and_extract_evidence' : 'retrieve_context_for_trigger',
      preset: this.presets.compileFor('memory', { scene: { ...scene, kind: envelope.kind } }),
      scene,
      ...(currentBatch
        ? { currentUserBatch: currentUserBatchForRole(currentBatch) }
        : { currentTrigger: envelope.trigger, triggerIsNotUserEvidence: true }),
      recentMessages,
      interactionState,
      lifeContext
    };
    let current = this.store.getTurn(envelope.turnId);
    const initialRoute = current.route === 'fast' ? 'fast' : 'deep';
    let memoryResult = await this.runStructuredRole({
      turnId: envelope.turnId,
      role: 'memory',
      request: memoryRequest,
      clientUserMessageId: `${envelope.turnId}_memory`,
      profile: roleExecutionProfile(initialRoute, 'memory', this.roleProfiles),
      stage: initialRoute === 'fast' ? 'memory_fast' : 'memory_deep'
    });
    if (initialRoute === 'fast' && memoryResult.requiresDeepMemory === true) {
      const reasons = Array.isArray(memoryResult.escalationReasons)
        ? memoryResult.escalationReasons.map(String)
        : ['memory_role_requested'];
      this.store.setTurnRoute(envelope.turnId, 'fast_to_deep', reasons.length ? reasons : ['memory_role_requested']);
      memoryResult = await this.runStructuredRole({
        turnId: envelope.turnId,
        role: 'memory',
        request: { ...memoryRequest, task: 'deep_retrieve_and_extract_evidence', fastMemoryReview: memoryResult },
        clientUserMessageId: `${envelope.turnId}_memory_deep`,
        profile: roleExecutionProfile('deep', 'memory', this.roleProfiles),
        stage: 'memory_deep'
      });
      current = this.store.getTurn(envelope.turnId);
    }
    const conversationFrame = normalizeConversationFrame(memoryResult.conversationFrame);
    current = this.store.getTurn(envelope.turnId);
    if (current.route === 'fast' && conversationFrame.needsNuanceReview) {
      this.store.setTurnRoute(envelope.turnId, 'fast_to_deep', ['conversation_nuance']);
      current = this.store.getTurn(envelope.turnId);
    }
    const candidates = Array.isArray(memoryResult.candidates) ? memoryResult.candidates : [];
    const committedFacts = commitVerifiedFacts(this.store, candidates, evidenceSourceMessages);
    const relationship = resolveRelationshipStage(
      scene, memoryResult.relationshipStageReview, evidenceSourceMessages, this.clock()
    );
    const interactionContract = compileInteractionContract({
      envelope,
      scene: { ...scene, relationshipStage: relationship.stage },
      interactionState,
      conversationFrame,
      recentMessages: evidenceSourceMessages
    });
    current = this.store.getTurn(envelope.turnId);
    if (
      current.route === 'fast'
      && (
        interactionContract.preserveAmbiguity
        || interactionContract.recentCorrection.active
        || interactionContract.explicitBoundaries.length > 0
      )
    ) {
      this.store.setTurnRoute(envelope.turnId, 'fast_to_deep', ['interaction_contract']);
      current = this.store.getTurn(envelope.turnId);
    }
    const memoryPacket = {
      query: String(memoryResult.query || currentBatch?.combinedText || envelope.trigger?.triggerType || ''),
      keywords: Array.isArray(memoryResult.keywords) ? memoryResult.keywords.map(String) : [],
      committedFacts: {
        verified: committedFacts.verified.map(item => item.fact.factId),
        provisional: committedFacts.provisional.map(item => item.fact.factId),
        rejected: committedFacts.rejected.map(item => item.fact?.factId || null).filter(Boolean)
      },
      requiresDeepMemory: memoryResult.requiresDeepMemory === true,
      escalationReasons: Array.isArray(memoryResult.escalationReasons) ? memoryResult.escalationReasons.map(String) : [],
      speakerAmbiguity: memoryResult.speakerAmbiguity === true,
      commitmentRisk: memoryResult.commitmentRisk === true,
      relationshipStageReview: memoryResult.relationshipStageReview || null,
      conversationFrame,
      interactionContract,
      effectiveRelationshipStage: relationship.stage,
      relationshipStageAction: relationship.action,
      lifeContext
    };
    this.store.advanceTurn(envelope.turnId, 'memory_running', 'memory_done', {
      memoryPacketJson: JSON.stringify(memoryPacket)
    });
  }

  async completeBrain(envelope, current) {
    const declaredBatch = resolveCurrentUserBatch(envelope);
    const stateMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds.length || 0))
    );
    const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
    const recentMessages = buildGenerationWindow(stateMessages, {
      currentMessageIds: currentBatch?.messageIds || [],
      limit: this.generationContextLimit
    });
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    const baseScene = sceneFromEnvelope(envelope);
    const scene = {
      ...baseScene,
      relationshipStage: memoryPacket.effectiveRelationshipStage || baseScene.relationshipStage
    };
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: stateMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const previousSupervisor = current.supervisorJson
      ? normalizeSupervisorResult(parseRoleJson(current.supervisorJson, 'supervisor'), {
          attempt: Number(parseRoleJson(current.supervisorJson, 'supervisor').attempt || 1),
          direct: !isAutomaticKind(envelope.kind)
        })
      : null;
    const previousDraft = current.brainDraftJson ? parseRoleJson(current.brainDraftJson, 'brain') : null;
    const deliveryPolicy = this.deliveryPolicyFor(envelope);
    const brainRequest = {
      task: previousSupervisor?.decision === 'rewrite' ? 'rewrite_as_yuqi' : 'reply_as_yuqi',
      preset: this.presets.compileFor('brain', {
        scene: { ...scene, kind: envelope.kind },
        revealedFactIds: evidencePack.facts.map(fact => fact.factId)
      }),
      scene,
      ...(currentBatch ? { currentUserBatch: currentUserBatchForRole(currentBatch) } : { currentTrigger: envelope.trigger }),
      ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
      ...(currentRolePlanExecution(envelope) ? { currentRolePlanExecution: currentRolePlanExecution(envelope) } : {}),
      recentMessages,
      interactionState,
      lifeContext: this.lifeSimulation.advanceTo(envelope.characterId, this.clock()),
      evidencePack,
      interactionContract: memoryPacket.interactionContract,
      ...(deliveryPolicy ? { deliveryPolicy } : {}),
      ...(previousSupervisor?.decision === 'rewrite' ? {
        rejectedDraft: previousDraft,
        supervisorIssues: Array.isArray(previousSupervisor.issues) ? previousSupervisor.issues : [],
        rewriteContract: rewriteContractForBrain(previousSupervisor)
      } : {})
    };
    const attempt = Number(previousSupervisor?.attempt || 0) + 1;
    const route = current.route === 'fast' ? 'fast' : 'deep';
    const draft = await this.runBrain(envelope.turnId, brainRequest, attempt, route);
    this.store.advanceTurn(envelope.turnId, 'brain_running', 'brain_done', {
      brainDraftJson: JSON.stringify(draft)
    });
  }

  async completeSupervisor(envelope, current) {
    const draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
    const declaredBatch = resolveCurrentUserBatch(envelope);
    const stateMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds.length || 0))
    );
    const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
    const recentMessages = buildGenerationWindow(stateMessages, {
      currentMessageIds: currentBatch?.messageIds || [],
      limit: this.generationContextLimit
    });
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    const baseScene = sceneFromEnvelope(envelope);
    const scene = {
      ...baseScene,
      relationshipStage: memoryPacket.effectiveRelationshipStage || baseScene.relationshipStage
    };
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: stateMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const previousRaw = current.supervisorJson ? parseRoleJson(current.supervisorJson, 'supervisor') : null;
    const previous = previousRaw
      ? normalizeSupervisorResult(previousRaw, {
          attempt: Number(previousRaw.attempt || 1),
          direct: !isAutomaticKind(envelope.kind)
        })
      : null;
    const attempt = Number(previous?.attempt || 0) + 1;
    const deliveryPolicy = this.deliveryPolicyFor(envelope);
    const supervisorRequest = {
      task: 'review_yuqi_reply',
      preset: this.presets.compileFor('supervisor', { scene: { ...scene, kind: envelope.kind } }),
      scene,
      ...(currentBatch ? { currentUserBatch: currentUserBatchForRole(currentBatch) } : { currentTrigger: envelope.trigger }),
      ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
      ...(currentRolePlanExecution(envelope) ? { currentRolePlanExecution: currentRolePlanExecution(envelope) } : {}),
      recentMessages,
      interactionState,
      lifeContext: this.lifeSimulation.advanceTo(envelope.characterId, this.clock()),
      evidencePack,
      conversationFrame: normalizeConversationFrame(memoryPacket.conversationFrame),
      interactionContract: memoryPacket.interactionContract,
      ...(deliveryPolicy ? { deliveryPolicy } : {}),
      draft,
      previousReview: previous,
      rewriteResolution: draft.rewriteResolution
    };
    const reviewed = await this.runStructuredRole({
      turnId: envelope.turnId,
      role: 'supervisor',
      request: supervisorRequest,
      clientUserMessageId: `${envelope.turnId}_supervisor_${attempt}`,
      profile: roleExecutionProfile('deep', 'supervisor', this.roleProfiles),
      stage: `supervisor_${attempt}`
    });
    let supervisorResult = normalizeSupervisorResult(reviewed, {
      attempt,
      previous,
      direct: !isAutomaticKind(envelope.kind)
    });
    if (
      deliveryPolicy?.skipAllowed === false
      && ['skip', 'reject'].includes(supervisorResult.decision)
    ) {
      const originalDecision = supervisorResult.decision;
      supervisorResult = proactiveDeliveryRewrite(previous, attempt, originalDecision);
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'proactive_supervisor_rewrite_requested',
        level: 'warning',
        detail: {
          policy: deliveryPolicy,
          originalDecision,
          rewriteAttempt: attempt
        }
      });
    }
    if (supervisorResult.decision === 'approve') {
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify(supervisorResult)
      });
      return;
    }
    if (supervisorResult.decision === 'skip') {
      if (!isAutomaticKind(envelope.kind)) throw new Error('supervisor cannot skip a direct reply');
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify(supervisorResult),
        brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
      });
      return;
    }
    if (supervisorResult.decision === 'reject') {
      if (isAutomaticKind(envelope.kind)) {
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify(supervisorResult),
          brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
        });
        return;
      }
      throw new Error('supervisor rejected the reply');
    }
    if (attempt >= 3) {
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'supervisor_running',
        level: 'warning',
        detail: { action: 'supervisor_veto_after_rewrites', issues: supervisorResult.issues || [] }
      });
      if (deliveryPolicy?.skipAllowed === false) {
        if (hasHighPriorityIssues(supervisorResult) || !String(draft.reply || '').trim()) {
          this.store.putDiagnostic({
            turnId: envelope.turnId,
            stage: 'proactive_delivery_blocked',
            level: 'error',
            detail: {
              policy: deliveryPolicy,
              issueIds: supervisorResult.issues.map(issue => issue.issueId),
              hardIssue: hasHighPriorityIssues(supervisorResult),
              visibleDraft: Boolean(String(draft.reply || '').trim())
            }
          });
          throw new Error('PROACTIVE_DELIVERY_BLOCKED: no safe visible reply after rewrites');
        }
        this.store.putDiagnostic({
          turnId: envelope.turnId,
          stage: 'proactive_soft_fallback_selected',
          level: 'warning',
          detail: {
            policy: deliveryPolicy,
            issueIds: supervisorResult.issues.map(issue => issue.issueId),
            selectedDraft: draft.reply
          }
        });
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify({ ...supervisorResult, fallbackSelected: true })
        });
        return;
      }
      if (isAutomaticKind(envelope.kind)) {
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify({ ...supervisorResult, vetoed: true }),
          brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
        });
        return;
      }
      if (hasHighPriorityIssues(supervisorResult) && attempt === 3) {
        this.store.putDiagnostic({
          turnId: envelope.turnId,
          stage: 'hard_repair_requested',
          level: 'warning',
          detail: {
            attempt,
            issueIds: supervisorResult.issues.map(issue => issue.issueId)
          }
        });
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
          supervisorJson: JSON.stringify({ ...supervisorResult, finalHardRepair: true })
        });
        return;
      }
      const fallbackStage = hasHighPriorityIssues(supervisorResult)
        ? 'hard_repair_fallback_selected'
        : 'soft_issue_fallback_selected';
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: fallbackStage,
        level: 'warning',
        detail: {
          attempt,
          issueIds: supervisorResult.issues.map(issue => issue.issueId),
          selectedDraft: draft.reply
        }
      });
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify({ ...supervisorResult, fallbackSelected: true })
      });
      return;
    }
    this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
      supervisorJson: JSON.stringify(supervisorResult)
    });
  }

  persistCommittedCognitionInternal(envelope, current, memoryPacket) {
    if (memoryPacket?.packetType !== 'cognition-v2' || !memoryPacket?.packet?.cognitionResult) return null;
    const previousRecord = this.store.getCognitiveState(envelope.characterId);
    const previous = previousRecord ? {
      ...previousRecord.state,
      revision: previousRecord.revision,
      lastTurnId: previousRecord.lastTurnId,
      updatedAt: previousRecord.updatedAt
    } : null;
    const supervisorDecision = current.supervisorJson
      ? String(parseRoleJson(current.supervisorJson, 'supervisor').decision || 'approve')
      : 'approve';
    const committedAt = this.clock();
    const next = reduceCognitiveState({
      previous,
      cognitionPacket: memoryPacket.packet,
      committedTurn: {
        turnId: envelope.turnId,
        kind: envelope.kind,
        state: 'committed',
        supervisorDecision,
        hasUserBatch: Boolean(resolveCurrentUserBatch(envelope)?.messages?.length)
      },
      lifeState: this.lifeSimulation.contextFor(envelope.characterId, committedAt),
      now: committedAt
    });
    if (next.lastTurnId !== envelope.turnId) return previousRecord;
    const { checksum: _checksum, ...state } = next;
    const saved = this.store.putCognitiveStateInternal({
      roleId: envelope.characterId,
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      lastTurnId: state.lastTurnId,
      state,
      expectedChecksum: previousRecord?.checksum,
      updatedAt: state.updatedAt
    });
    this.store.createConsolidationJobInternal({
      subjectType: 'turn',
      subjectId: envelope.turnId,
      turnId: envelope.turnId,
      roleId: envelope.characterId,
      jobType: 'turn_consolidation',
      dueAt: committedAt,
      createdAt: committedAt,
      payload: {
        turnId: envelope.turnId,
        roleId: envelope.characterId,
        pipelineMode: current.pipelineMode,
        presetVersion: current.presetVersion,
        cognitionPacketChecksum: memoryPacket.packet.packetChecksum || null,
        cognitiveStateChecksum: saved.checksum
      }
    });
    return saved;
  }

  queueComparisonJobInternal(envelope, current, result) {
    if (!['cognition_compare', 'legacy_compare'].includes(current.comparisonMode)) return null;
    const cognitionCompare = current.comparisonMode === 'cognition_compare';
    const comparisonDirection = cognitionCompare
      ? 'legacy_authoritative_cognition_compare'
      : 'cognition_authoritative_legacy_compare';
    const jobType = cognitionCompare ? 'shadow_cognition' : 'active_canary_compare';
    const authoritativeResultChecksum = contentHash(result);
    const payload = {
      subjectType: 'turn',
      subjectId: envelope.turnId,
      turnId: envelope.turnId,
      rolloutKey: current.rolloutKey || envelope.kind,
      rolloutRevision: current.rolloutRevision,
      rolloutEvidenceEpoch: current.rolloutEvidenceEpoch,
      shadowEpoch: current.shadowEpoch,
      canaryEpoch: current.canaryEpoch,
      canarySlot: current.canarySlot,
      comparisonDirection,
      authoritativePipeline: cognitionCompare ? 'legacy' : 'cognition',
      comparisonPipeline: cognitionCompare ? 'cognition' : 'legacy',
      authoritativeResultChecksum,
      pipelineMode: current.pipelineMode,
      comparisonMode: current.comparisonMode,
      presetVersion: current.presetVersion,
      pipelineChecksum: current.pipelineChecksum,
      annotationSnapshotChecksum: contentHash(current.annotationSnapshot || {}),
      inputChecksum: contentHash({
        envelope,
        route: current.route,
        routeReasons: current.routeReasons,
        presetVersion: current.presetVersion,
        annotationSnapshot: current.annotationSnapshot
      })
    };
    return this.store.putConsolidationJobInternal({
      jobId: `compare_${contentHash({
        subjectId: envelope.turnId,
        comparisonDirection,
        authoritativeResultChecksum
      }).slice(0, 24)}`,
      subjectType: 'turn',
      subjectId: envelope.turnId,
      turnId: envelope.turnId,
      roleId: envelope.characterId,
      jobType,
      state: 'queued',
      dueAt: this.clock(),
      createdAt: this.clock(),
      payload
    });
  }

  commitApproved(envelope, current) {
    const draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    if (draft.action === 'skip' && isAutomaticKind(envelope.kind)) {
      return this.store.transaction(() => {
        if (draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none') {
          throw new Error('PLAN_REPLY_MISMATCH: a silent action cannot change an existing plan');
        }
        if (draft.lifePlan?.episodes?.length) {
          this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
            sourceTurnId: envelope.turnId
          });
        }
        const result = {
          turnId: envelope.turnId,
          presetVersion: current.presetVersion || this.presets.current().version,
          action: draft.rolePlanOperations.length ? 'send' : 'skip',
          skipReason: draft.skipReason || null,
          paymentAction: null,
          reply: null,
          usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
          relationshipStageAction: memoryPacket.relationshipStageAction || null,
          lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
          lifeAdjustment: null,
          momentAction: null,
          rolePlanOperations: draft.rolePlanOperations
        };
        this.persistCommittedCognitionInternal(envelope, current, memoryPacket);
        this.queueComparisonJobInternal(envelope, current, result);
        this.store.advanceTurn(
          envelope.turnId, 'approved', 'committed', { replyJson: JSON.stringify(result) }
        );
        return result;
      });
    }
    if (isMomentKind(envelope.kind)) {
      return this.store.transaction(() => {
        if (draft.lifePlan?.episodes?.length) {
          this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
            sourceTurnId: envelope.turnId
          });
        }
        const lifeAdjustment = draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none'
          ? this.store.applyLifeAdjustment(
              envelope.characterId, draft.lifeAdjustment, envelope.turnId, this.clock()
            )
          : null;
        const result = {
          turnId: envelope.turnId,
          presetVersion: current.presetVersion || this.presets.current().version,
          action: 'send',
          paymentAction: null,
          relationshipStageAction: memoryPacket.relationshipStageAction || null,
          momentAction: draft.momentAction,
          rolePlanOperations: draft.rolePlanOperations,
          lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
          lifeAdjustment: lifeAdjustment ? {
            type: draft.lifeAdjustment.type,
            episodeId: lifeAdjustment.episodeId
          } : null,
          reply: null,
          usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : []
        };
        this.persistCommittedCognitionInternal(envelope, current, memoryPacket);
        this.queueComparisonJobInternal(envelope, current, result);
        this.store.advanceTurn(
          envelope.turnId, 'approved', 'committed', { replyJson: JSON.stringify(result) }
        );
        return result;
      });
    }
    if (isMomentPostKind(envelope.kind)) {
      return this.store.transaction(() => {
        if (draft.lifePlan?.episodes?.length) {
          this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
            sourceTurnId: envelope.turnId
          });
        }
        const lifeAdjustment = draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none'
          ? this.store.applyLifeAdjustment(
              envelope.characterId, draft.lifeAdjustment, envelope.turnId, this.clock()
            )
          : null;
        const result = {
          turnId: envelope.turnId,
          presetVersion: current.presetVersion || this.presets.current().version,
          action: 'send',
          paymentAction: null,
          reply: {
            messageId: `msg_yuqi_${contentHash(envelope.turnId).slice(0, 24)}`,
            turnId: envelope.turnId,
            characterId: envelope.characterId,
            speakerId: envelope.characterId,
            speakerType: 'character',
            recipientId: 'public_moments',
            content: draft.reply.trim(),
            sentAt: this.clock(),
            origin: 'codex'
          },
          usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
          relationshipStageAction: memoryPacket.relationshipStageAction || null,
          lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
          lifeAdjustment: lifeAdjustment ? {
            type: draft.lifeAdjustment.type,
            episodeId: lifeAdjustment.episodeId
          } : null,
          momentAction: null,
          rolePlanOperations: draft.rolePlanOperations
        };
        this.persistCommittedCognitionInternal(envelope, current, memoryPacket);
        this.queueComparisonJobInternal(envelope, current, result);
        this.store.advanceTurn(envelope.turnId, 'approved', 'committed', {
          replyJson: JSON.stringify(result)
        });
        return result;
      });
    }
    const reply = {
      messageId: `msg_yuqi_${contentHash(envelope.turnId).slice(0, 24)}`,
      turnId: envelope.turnId,
      characterId: envelope.characterId,
      speakerId: envelope.characterId,
      speakerType: 'character',
      recipientId: 'user',
      content: draft.reply.trim(),
      sentAt: this.clock(),
      origin: 'codex'
    };
    const committedResult = this.store.transaction(() => {
      if (draft.lifePlan?.episodes?.length) {
        this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
          sourceTurnId: envelope.turnId
        });
      }
      const lifeAdjustment = draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none'
        ? this.store.applyLifeAdjustment(
            envelope.characterId, draft.lifeAdjustment, envelope.turnId, this.clock()
          )
        : null;
      const savedReply = this.store.putMessageInternal(reply);
      if (['PROACTIVE_CHAT', 'PROACTIVE_MOMENT'].includes(envelope.kind)) {
        this.store.quarantinePendingReply(savedReply.messageId);
      }
      const result = {
        turnId: envelope.turnId,
        presetVersion: current.presetVersion || this.presets.current().version,
        action: 'send',
        paymentAction: resolvedPaymentAction(envelope, draft),
        reply: savedReply,
        usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
        relationshipStageAction: memoryPacket.relationshipStageAction || null,
        lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
        lifeAdjustment: lifeAdjustment ? {
          type: draft.lifeAdjustment.type,
          episodeId: lifeAdjustment.episodeId
        } : null,
        momentAction: null,
        rolePlanOperations: draft.rolePlanOperations
      };
      this.persistCommittedCognitionInternal(envelope, current, memoryPacket);
      this.queueComparisonJobInternal(envelope, current, result);
      this.store.advanceTurn(envelope.turnId, 'approved', 'committed', {
        replyJson: JSON.stringify(result)
      });
      return result;
    });
    const formedCharacterFacts = characterFactCandidatesForReply(
      draft.rewriteResolution,
      committedResult.reply
    );
    if (formedCharacterFacts.length) {
      commitVerifiedFacts(this.store, formedCharacterFacts, [committedResult.reply]);
    }
    return committedResult;
  }

  cancel(turnId) {
    const current = this.store.getTurn(turnId);
    if (!current || ['committed', 'delivered', 'completed', 'failed'].includes(current.state)) return false;
    this.store.advanceTurn(turnId, current.state, 'failed', {
      errorJson: JSON.stringify({ name: 'CancelledError', message: 'turn cancelled by device' })
    });
    return true;
  }

  async runBrain(turnId, request, attempt = 1, route = 'deep') {
    const result = await this.withBrainRoleLock(() => this.runStructuredRole({
      turnId,
      role: 'brain',
      request,
      clientUserMessageId: `${turnId}_brain_${attempt}`,
      profile: roleExecutionProfile(route, 'brain', this.roleProfiles),
      stage: `brain_${attempt}`
    }));
    if (typeof result.reply !== 'string') throw new Error('brain reply is missing');
    return normalizeBrainDraft(result);
  }

  async runStructuredRole({
    turnId,
    role,
    request,
    clientUserMessageId,
    profile,
    stage = role
  }) {
    if (!profile?.model || !profile?.effort) throw new Error(`missing execution profile for ${role}`);
    if (!String(turnId || '')) throw new Error(`turnId is required for ${role}`);
    this.store.beginStage(turnId, stage, profile.model, profile.effort, this.clock());
    let invalidOutput = '';
    let activeProfile = profile;
    let capacityFallbackUsed = false;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
      const payload = attempt === 1 ? request : {
        ...request,
        protocolRepair: {
          attempt,
          rule: 'Return exactly one JSON object that matches the supplied output schema.',
          invalidOutput: invalidOutput.slice(0, 2_000)
        }
      };
        const baseMessageId = attempt === 1 ? clientUserMessageId : `${clientUserMessageId}_protocol_${attempt}`;
        let response;
        try {
          response = await this.codex.runTurn(role, JSON.stringify(payload), {
            clientUserMessageId: baseMessageId,
            outputSchema: ROLE_OUTPUT_SCHEMAS[role],
            model: activeProfile.model,
            effort: activeProfile.effort,
            localImagePaths: this.turnImagePaths.get(turnId) || []
          });
        } catch (error) {
          const alternate = capacityFallbackUsed ? null : fallbackRoleProfile(activeProfile);
          if (!isModelCapacityError(error) || !alternate) throw error;
          capacityFallbackUsed = true;
          this.store.putDiagnostic({
            turnId,
            stage: 'model_capacity_failover',
            level: 'warn',
            detail: {
              role,
              failedModel: activeProfile.model,
              fallbackModel: alternate.model,
              effort: alternate.effort,
              error: 'model_capacity'
            }
          });
          activeProfile = alternate;
          response = await this.codex.runTurn(role, JSON.stringify(payload), {
            clientUserMessageId: `${baseMessageId}_capacity_fallback`,
            outputSchema: ROLE_OUTPUT_SCHEMAS[role],
            model: activeProfile.model,
            effort: activeProfile.effort,
            localImagePaths: this.turnImagePaths.get(turnId) || []
          });
        }
        invalidOutput = String(response.text || '');
        try {
          return parseRoleJson(invalidOutput, role);
        } catch (error) {
          if (attempt === 2 || !String(error.message).startsWith(`${role} returned invalid`)) throw error;
        }
      }
      throw new Error(`${role} returned invalid structured output twice`);
    } finally {
      this.store.finishStage(turnId, stage, this.clock());
    }
  }
}
export function isModelCapacityError(error) {
  return String(error?.name || '') === 'CodexTurnError'
    && /(?:selected model is at capacity|model.+capacity|capacity.+model)/i.test(String(error?.message || ''));
}

export function fallbackRoleProfile(profile) {
  const model = String(profile?.model || '');
  if (model.includes('gpt-5.6-sol')) return { ...profile, model: 'gpt-5.6-terra' };
  if (model.includes('gpt-5.6-terra')) return { ...profile, model: 'gpt-5.6-sol' };
  return null;
}
