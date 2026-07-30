import { contentHash } from './protocol.mjs';

const PRIVATE_KINDS = new Set([
  'DIRECT_REPLY',
  'PROACTIVE_CHAT',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_CHAT_PRIVATE'
]);
const PUBLIC_KINDS = new Set([
  'PROACTIVE_MOMENT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);
const MOMENT_THREAD_KINDS = new Set(['MOMENT_INTERACTION', 'MOMENT_REPLY']);

function kindOf(value) {
  return String(value?.kind || value?.turnKind || '');
}

function authoritativeMomentId(envelope) {
  const context = envelope?.featureContext || envelope?.context || {};
  const momentId = context.targetMoment?.momentId
    || context.moment?.momentId
    || context.momentId;
  if (!String(momentId || '').trim()) {
    throw new Error(`moment interaction requires an authoritative moment id`);
  }
  return String(momentId);
}

export function laneKeyForEnvelope(envelope) {
  const kind = kindOf(envelope);
  if (PRIVATE_KINDS.has(kind)) return 'private_chat';
  if (PUBLIC_KINDS.has(kind)) return 'public_moment';
  if (MOMENT_THREAD_KINDS.has(kind)) {
    return `moment_interaction:${authoritativeMomentId(envelope)}`;
  }
  throw new Error(`no interaction lane for ${kind}`);
}

export function priorityForEnvelope(envelope) {
  const kind = kindOf(envelope);
  if (kind === 'DIRECT_REPLY') return 300;
  if (kind.startsWith('ROLE_PLAN_')) return 200;
  return 100;
}

function normalizeVisibleText(value) {
  const bubbles = Array.isArray(value) ? value : [value];
  return bubbles.map((bubble) =>
    String(bubble?.text ?? bubble?.content ?? bubble ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
  ).filter(Boolean).join('\n');
}

function canonicalActionTargets(actionSet) {
  return (Array.isArray(actionSet) ? actionSet : [])
    .map((action) => ({
      type: String(action?.type || action?.kind || ''),
      action: String(action?.action || ''),
      messageId: action?.messageId ?? null,
      momentId: action?.momentId ?? null,
      commentId: action?.commentId ?? action?.replyToCommentId ?? null,
      rolePlanId: action?.rolePlanId ?? null,
      occurrenceId: action?.occurrenceId ?? null
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function generationFingerprint(input) {
  return contentHash({
    roleId: String(input?.roleId || ''),
    laneKey: String(input?.laneKey || ''),
    laneRevision: Number(input?.laneRevision || 0),
    normalizedReply: normalizeVisibleText(input?.visibleGroup),
    actionTargets: canonicalActionTargets(input?.actionSet),
    contextRevision: String(input?.contextRevision || '')
  });
}

export function decideLaneAdmission({ lane, incoming, now = Date.now() }) {
  const current = lane?.generatingTurn || null;
  const base = {
    admitted: false,
    incomingTurnId: incoming?.turnId || null,
    supersededTurnId: null,
    requeueTurnId: null,
    cancelTurnId: null,
    reasonCode: '',
    decidedAt: Number(now)
  };
  if (!current) return { ...base, admitted: true, reasonCode: 'lane_available' };
  if (current.turnId === incoming?.turnId) {
    return { ...base, admitted: true, reasonCode: 'already_lane_owner' };
  }
  if (current.committed) {
    return { ...base, reasonCode: 'current_turn_already_committed' };
  }
  const incomingKind = kindOf(incoming);
  const currentKind = kindOf(current);
  if (incomingKind === 'DIRECT_REPLY' && currentKind.startsWith('ROLE_PLAN_')) {
    return {
      ...base,
      admitted: true,
      requeueTurnId: current.turnId,
      reasonCode: 'postponed_by_user_batch'
    };
  }
  if (incomingKind === 'DIRECT_REPLY' && currentKind === 'PROACTIVE_CHAT') {
    return {
      ...base,
      admitted: true,
      supersededTurnId: current.turnId,
      reasonCode: 'superseded_by_user_batch'
    };
  }
  if (priorityForEnvelope(incoming) > priorityForEnvelope(current)) {
    return {
      ...base,
      admitted: true,
      supersededTurnId: current.turnId,
      reasonCode: 'superseded_by_higher_priority'
    };
  }
  return { ...base, reasonCode: 'lane_busy' };
}
