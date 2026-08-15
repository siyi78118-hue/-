const OPERATIONS = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete']);
const TYPES = new Set(['private_message', 'moment_post', 'role_schedule']);
const SOURCES = new Set(['spoken', 'accepted_request', 'private_decision', 'user_created']);
const TIME_CONFIDENCE = new Set(['explicit', 'inferred']);
const ORIGINS = new Set(['ai', 'user']);
const CREATE_ALLOWED = new Set([
  'op', 'planId', 'type', 'source', 'title', 'intent', 'schedule',
  'timeConfidence', 'durationMs', 'origin', 'sourceQuote', 'evidenceMessageIds'
]);
const CREATE_REQUIRED = new Set([
  'op', 'type', 'source', 'title', 'intent', 'schedule', 'timeConfidence'
]);
const UPDATE_ALLOWED = new Set(['op', 'planId', 'patch', 'reason']);
const UPDATE_REQUIRED = new Set(['op', 'planId', 'patch']);
const TERMINAL_ALLOWED = new Set(['op', 'planId', 'reason']);
const TERMINAL_REQUIRED = new Set(['op', 'planId']);
const PATCH_ALLOWED = new Set([
  'type', 'source', 'title', 'intent', 'schedule', 'timeConfidence',
  'durationMs', 'origin', 'sourceQuote', 'evidenceMessageIds'
]);

function conflict(detail) {
  throw new Error(`role plan operation contract conflict: ${detail}`);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) conflict(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) conflict(`${label} is invalid`);
}

function exactKeys(value, allowed, required, label) {
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.has(key)) || [...required].some(key => !Object.hasOwn(value, key))) {
    conflict(`${label} fields are invalid`);
  }
}

function text(value, label, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength) conflict(`${label} is invalid`);
}

function optionalText(value, key, label, maxLength) {
  if (Object.hasOwn(value, key)) text(value[key], label, maxLength);
}

function enumValue(value, key, allowed, label) {
  if (Object.hasOwn(value, key) && (typeof value[key] !== 'string' || !allowed.has(value[key]))) {
    conflict(`${label} is invalid`);
  }
}

function validateSchedule(schedule) {
  plainObject(schedule, 'schedule');
  const byKind = {
    once: {
      allowed: new Set(['kind', 'at', 'endsAt']),
      required: new Set(['kind', 'at'])
    },
    interval: {
      allowed: new Set(['kind', 'startsAt', 'intervalMs', 'endsAt']),
      required: new Set(['kind', 'startsAt', 'intervalMs'])
    },
    daily: {
      allowed: new Set(['kind', 'time', 'endsAt']),
      required: new Set(['kind', 'time'])
    },
    weekly: {
      allowed: new Set(['kind', 'weekdays', 'time', 'endsAt']),
      required: new Set(['kind', 'weekdays', 'time'])
    },
    monthly: {
      allowed: new Set(['kind', 'day', 'time', 'endsAt']),
      required: new Set(['kind', 'day', 'time'])
    }
  };
  if (typeof schedule.kind !== 'string' || !Object.hasOwn(byKind, schedule.kind)) {
    conflict('schedule kind is invalid');
  }
  const shape = byKind[schedule.kind];
  exactKeys(schedule, shape.allowed, shape.required, 'schedule');
  if (Object.hasOwn(schedule, 'endsAt')) text(schedule.endsAt, 'schedule end time', 64);
  if (schedule.kind === 'once') {
    text(schedule.at, 'schedule time', 64);
  } else if (schedule.kind === 'interval') {
    text(schedule.startsAt, 'schedule start time', 64);
    if (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 300_000) {
      conflict('schedule interval is invalid');
    }
  } else {
    if (typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
      conflict('schedule time is invalid');
    }
    if (schedule.kind === 'weekly' && (
      !Array.isArray(schedule.weekdays)
      || schedule.weekdays.length < 1
      || schedule.weekdays.length > 7
      || new Set(schedule.weekdays).size !== schedule.weekdays.length
      || schedule.weekdays.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6)
    )) conflict('schedule weekdays are invalid');
    if (schedule.kind === 'monthly'
      && (!Number.isSafeInteger(schedule.day) || schedule.day < 1 || schedule.day > 31)) {
      conflict('schedule day is invalid');
    }
  }
}

function validateEvidence(value, validMessageIds) {
  if (!Array.isArray(value) || value.length > 12
    || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !id || id.length > 96)) {
    conflict('evidence identities are invalid');
  }
  if (validMessageIds !== null) {
    const allowed = new Set(validMessageIds);
    if (value.some(id => !allowed.has(id))) conflict('evidence target is not authorized');
  }
}

function validateSemanticFields(value, validMessageIds) {
  enumValue(value, 'type', TYPES, 'type');
  enumValue(value, 'source', SOURCES, 'source');
  enumValue(value, 'origin', ORIGINS, 'origin');
  if (Object.hasOwn(value, 'timeConfidence')
    && (typeof value.timeConfidence !== 'string' || !TIME_CONFIDENCE.has(value.timeConfidence))) {
    conflict('time confidence is invalid');
  }
  optionalText(value, 'planId', 'plan identity', 96);
  optionalText(value, 'title', 'title', 80);
  optionalText(value, 'intent', 'intent', 600);
  optionalText(value, 'sourceQuote', 'source quote', 240);
  if (Object.hasOwn(value, 'durationMs')
    && (!Number.isSafeInteger(value.durationMs) || value.durationMs < 1)) {
    conflict('duration is invalid');
  }
  if (Object.hasOwn(value, 'evidenceMessageIds')) {
    validateEvidence(value.evidenceMessageIds, validMessageIds);
  }
  if (Object.hasOwn(value, 'schedule')) validateSchedule(value.schedule);
}

function validateOperation(operation, allowedPlanIds, validMessageIds) {
  plainObject(operation, 'operation');
  if (typeof operation.op !== 'string' || !OPERATIONS.has(operation.op)) {
    conflict('operation is unknown');
  }
  if (operation.op === 'create') {
    if (!Object.hasOwn(operation, 'timeConfidence')
      || typeof operation.timeConfidence !== 'string'
      || !TIME_CONFIDENCE.has(operation.timeConfidence)) {
      conflict('time confidence is invalid for role plan create');
    }
    exactKeys(operation, CREATE_ALLOWED, CREATE_REQUIRED, 'create');
    validateSemanticFields(operation, validMessageIds);
    if (operation.type === 'role_schedule'
      && (!Number.isSafeInteger(operation.durationMs) || operation.durationMs < 60_000)) {
      conflict('role schedule duration is invalid');
    }
    return;
  }
  const allowed = operation.op === 'update' ? UPDATE_ALLOWED : TERMINAL_ALLOWED;
  const required = operation.op === 'update' ? UPDATE_REQUIRED : TERMINAL_REQUIRED;
  exactKeys(operation, allowed, required, operation.op === 'update' ? 'update' : 'target operation');
  text(operation.planId, 'plan identity', 96);
  if (allowedPlanIds !== null && !new Set(allowedPlanIds).has(operation.planId)) {
    conflict('role plan target is not authorized');
  }
  optionalText(operation, 'reason', 'reason', 240);
  if (operation.op !== 'update') return;
  plainObject(operation.patch, 'patch');
  const patchKeys = Object.keys(operation.patch);
  if (!patchKeys.length || patchKeys.some(key => !PATCH_ALLOWED.has(key))) {
    conflict('patch fields are invalid');
  }
  validateSemanticFields(operation.patch, validMessageIds);
  if (Object.hasOwn(operation.patch, 'schedule')
    && (typeof operation.patch.timeConfidence !== 'string'
      || !TIME_CONFIDENCE.has(operation.patch.timeConfidence))) {
    conflict('time confidence is invalid');
  }
  if (operation.patch.type === 'role_schedule'
    && (!Number.isSafeInteger(operation.patch.durationMs) || operation.patch.durationMs < 60_000)) {
    conflict('role schedule duration is invalid');
  }
}

export function normalizeRolePlanOperationList(value, {
  allowedPlanIds = null,
  validMessageIds = null
} = {}) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      conflict('rolePlanOperationsJson JSON is invalid');
    }
  }
  if (!Array.isArray(parsed)) conflict('list is invalid');
  if (parsed.length > 12) conflict('operation count exceeds twelve');
  const operations = structuredClone(parsed);
  for (const operation of operations) validateOperation(operation, allowedPlanIds, validMessageIds);
  return operations;
}

export function rolePlanOperationHasTimeChange(operation) {
  return operation?.op === 'create'
    || (operation?.op === 'update'
      && operation.patch
      && typeof operation.patch === 'object'
      && !Array.isArray(operation.patch)
      && Object.hasOwn(operation.patch, 'schedule'));
}

export function rolePlanModelContractV1() {
  return {
    version: 1,
    container: 'JSON array string',
    timeConfidence: {
      requiredFor: ['create', 'update_with_schedule'],
      allowed: ['explicit', 'inferred'],
      explicit: 'the user supplied a concrete execution time',
      inferred: 'the user used a vague natural time and Yuqi selected the concrete execution time'
    },
    rejectMissingOrAliases: true
  };
}
