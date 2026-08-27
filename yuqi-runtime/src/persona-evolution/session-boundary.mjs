import { createHash } from 'node:crypto';

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
}

function exactKeys(value, keys, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function time(value, label) {
  nonempty(value, label);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be ISO UTC`);
  return parsed;
}

function idle(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('idleTimeoutMs must be a positive safe integer');
  return value;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) throw new Error('messages must be an array');
  const normalized = messages.map((item, index) => {
    exactKeys(item, ['id', 'speaker', 'createdAt', 'content'], `messages[${index}]`);
    nonempty(item.id, `messages[${index}].id`);
    if (!['user', 'assistant', 'system_event'].includes(item.speaker)) {
      throw new Error(`messages[${index}].speaker is invalid`);
    }
    time(item.createdAt, `messages[${index}].createdAt`);
    nonempty(item.content, `messages[${index}].content`);
    return structuredClone(item);
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  if (new Set(normalized.map(item => item.id)).size !== normalized.length) throw new Error('message ids must be unique');
  return normalized;
}

export function deriveSessionId({ roleId, conversationId, firstMessageId }) {
  const tuple = [
    nonempty(roleId, 'roleId'),
    nonempty(conversationId, 'conversationId'),
    nonempty(firstMessageId, 'firstMessageId')
  ];
  return `ses_${createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')}`;
}

export function splitVisibleSessions({ roleId, conversationId, messages, idleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS }) {
  nonempty(roleId, 'roleId');
  nonempty(conversationId, 'conversationId');
  idle(idleTimeoutMs);
  const ordered = normalizeMessages(messages);
  const groups = [];
  for (const item of ordered) {
    const current = groups.at(-1);
    if (!current || Date.parse(item.createdAt) - Date.parse(current.at(-1).createdAt) >= idleTimeoutMs) {
      groups.push([item]);
    } else {
      current.push(item);
    }
  }
  return groups.map(group => ({
    roleId,
    conversationId,
    sessionId: deriveSessionId({ roleId, conversationId, firstMessageId: group[0].id }),
    messages: group,
    startedAt: group[0].createdAt,
    endedAt: group.at(-1).createdAt
  }));
}

export function discoverClosedSessions({ roleId, conversationId, messages, now = Date.now(), idleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('now must be a non-negative safe integer');
  const sessions = splitVisibleSessions({ roleId, conversationId, messages, idleTimeoutMs });
  return sessions.filter((session, index) =>
    index < sessions.length - 1 || now - Date.parse(session.endedAt) >= idleTimeoutMs
  );
}
