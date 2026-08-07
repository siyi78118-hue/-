import { contentHash } from './protocol.mjs';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function safeTimestamp(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function safeRevision(value, name) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer or null`);
  }
  return value;
}

function sourceChecksum(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${name} must be a lowercase sha256 checksum`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 2048) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return normalized;
}

function normalizedCandidateString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 2048 ? normalized : null;
}

export function motiveIdForSource(source) {
  const sourceType = nonEmptyString(source?.sourceType, 'sourceType');
  const sourceId = nonEmptyString(source?.sourceId, 'sourceId');
  const sourceRevision = safeRevision(source?.sourceRevision, 'sourceRevision');
  const checksum = sourceChecksum(source?.sourceChecksum, 'sourceChecksum');
  return `motive_${contentHash({ sourceType, sourceId, sourceRevision, sourceChecksum: checksum }).slice(0, 24)}`;
}

function episodeCandidate(episode, sourceType, consideredAt) {
  if (!episode || episode.status === 'cancelled') return null;
  const episodeId = normalizedCandidateString(episode.episodeId);
  if (!episodeId) return null;
  if (typeof episode.startAt !== 'number' || !Number.isSafeInteger(episode.startAt)
    || episode.startAt < 0 || typeof episode.endAt !== 'number' || !Number.isSafeInteger(episode.endAt)
    || episode.endAt < 0) return null;
  if (sourceType === 'current_life_episode') {
    if (!(episode.startAt <= consideredAt && consideredAt < episode.endAt)) return null;
  } else {
    if (episode.startAt > consideredAt || episode.endAt > consideredAt
      || consideredAt - episode.endAt >= 6 * HOUR) return null;
  }
  if (episode.endAt <= episode.startAt) return null;
  if (typeof episode.checksum !== 'string' || !SHA256.test(episode.checksum)) return null;
  // Episodes have no independent semantic revision.  `updatedAt` is lifecycle
  // bookkeeping and must not mint a new motive identity; checksum is the
  // immutable semantic version instead.
  const sourceRevision = null;
  const summary = normalizedCandidateString(episode.payload?.summary)
    || normalizedCandidateString(episode.title);
  if (!summary) return null;
  const expiresAt = sourceType === 'current_life_episode'
    ? episode.endAt
    : episode.endAt + 6 * HOUR;
  if (!Number.isSafeInteger(expiresAt)) return null;
  const source = {
    sourceType,
    sourceId: episodeId,
    sourceRevision,
    sourceChecksum: episode.checksum,
    occurredAt: episode.startAt,
    expiresAt,
    summary
  };
  return { ...source, motiveId: motiveIdForSource(source) };
}

function threadCandidate(thread, cognitiveState, consideredAt) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return null;
  const sourceId = normalizedCandidateString(thread.threadId);
  const sourceTurnId = normalizedCandidateString(thread.sourceTurnId);
  const summary = normalizedCandidateString(thread.summary);
  const occurredAt = thread.lastTouchedAt;
  const checksum = cognitiveState?.checksum;
  if (!sourceId || !sourceTurnId || !summary || typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt)
    || occurredAt < consideredAt - 7 * DAY || occurredAt > consideredAt
    || occurredAt < 0 || typeof checksum !== 'string' || !SHA256.test(checksum)) return null;
  const sourceRevision = safeRevision(cognitiveState?.revision ?? null, 'cognitiveState.revision');
  if (Number(cognitiveState?.schemaVersion) === 2
    && (typeof cognitiveState?.lastTurnId !== 'string'
      || cognitiveState.lastTurnId !== sourceTurnId)) return null;
  const expiresAt = occurredAt + 7 * DAY;
  if (!Number.isSafeInteger(expiresAt)) return null;
  const source = {
    sourceType: 'open_thread',
    sourceId,
    sourceRevision,
    sourceChecksum: checksum,
    occurredAt,
    expiresAt,
    summary
  };
  return { ...source, motiveId: motiveIdForSource(source) };
}

export function buildProactiveMotiveAuthority({
  consideredAt,
  lifeContext = {},
  cognitiveState = null,
  consumedMotiveIds = [],
  hardConstraints = []
} = {}) {
  const at = safeTimestamp(consideredAt, 'consideredAt');
  if (!Array.isArray(consumedMotiveIds)
    || consumedMotiveIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(consumedMotiveIds).size !== consumedMotiveIds.length) {
    throw new Error('consumedMotiveIds must be a unique array of non-empty strings');
  }
  const consumed = new Set(consumedMotiveIds);
  const candidates = [];
  const seen = new Set();
  const add = candidate => {
    if (!candidate || consumed.has(candidate.motiveId) || seen.has(candidate.motiveId)) return;
    seen.add(candidate.motiveId);
    candidates.push(candidate);
  };
  add(episodeCandidate(lifeContext.current, 'current_life_episode', at));
  for (const episode of Array.isArray(lifeContext.recent) ? lifeContext.recent : []) {
    add(episodeCandidate(episode, 'recent_life_episode', at));
  }
  const openThreads = Number(cognitiveState?.schemaVersion) === 2
    ? (Array.isArray(cognitiveState?.state?.fastState?.openThreads)
      ? cognitiveState.state.fastState.openThreads
      : [])
    : (Array.isArray(cognitiveState?.state?.openThreads)
      ? cognitiveState.state.openThreads
      : []);
  for (const thread of openThreads) add(threadCandidate(thread, cognitiveState, at));
  candidates.sort((left, right) => right.occurredAt - left.occurredAt || left.motiveId.localeCompare(right.motiveId));
  candidates.splice(6);

  const refs = [];
  for (const constraint of Array.isArray(hardConstraints) ? hardConstraints : []) {
    if (!constraint || constraint.status !== 'active') continue;
    const channel = constraint.scope?.channel;
    const kind = constraint.kind;
    const rule = constraint.rule;
    if ((channel === 'private_chat' || channel === 'all')
      && (kind === 'action' || kind === 'consent')
      && (rule === 'deny_proactive_chat' || rule === 'deny_all_contact')
      && typeof constraint.constraintId === 'string' && constraint.constraintId
      && Number.isSafeInteger(constraint.revision) && constraint.revision >= 0) {
      refs.push({ constraintId: constraint.constraintId, revision: constraint.revision });
    }
  }
  refs.sort((left, right) => left.constraintId.localeCompare(right.constraintId) || left.revision - right.revision);
  const structuralSilence = refs.length
    ? { reasonCode: 'ACTIVE_PRIVATE_CHAT_CONSTRAINT', constraintRefs: refs }
    : null;
  const authority = {
    version: 'proactive-motive-v1',
    consideredAt: at,
    candidates,
    structuralSilence
  };
  return Object.freeze({ ...authority, checksum: contentHash(authority) });
}

// The motive authority path must inspect every eligible source.  The generic
// prompt context intentionally caps recent episodes for model context, but
// that cap is not an authority rule and would make older eligible motives
// permanently invisible.
export function proactiveMotiveSourceContext(store, characterId, consideredAt) {
  if (!store || typeof store.listLifeEpisodes !== 'function') {
    throw new Error('proactive motive source store is required');
  }
  const at = safeTimestamp(consideredAt, 'consideredAt');
  const episodes = store.listLifeEpisodes(String(characterId)).filter(
    episode => episode && episode.status !== 'cancelled'
  );
  const current = episodes.find(item => item.startAt <= at && at < item.endAt) || null;
  const recent = episodes.filter(item => item.endAt <= at && at - item.endAt < 6 * HOUR);
  return Object.freeze({
    current,
    recent,
    upcoming: []
  });
}

export class LifeSimulationCoordinator {
  constructor({ store, planningThresholdMs = 6 * HOUR, targetPlanMs = 12 * HOUR } = {}) {
    if (!store) throw new Error('life simulation store is required');
    this.store = store;
    this.planningThresholdMs = Math.max(HOUR, Number(planningThresholdMs) || 6 * HOUR);
    this.targetPlanMs = Math.max(this.planningThresholdMs, Number(targetPlanMs) || 12 * HOUR);
  }

  ensureHorizon(characterId, now = Date.now()) {
    return this.store.listLifeEpisodes(characterId, { from: Number(now) });
  }

  advanceTo(characterId, now = Date.now()) {
    this.store.retireLegacyGeneratedLifeEpisodes(characterId, now);
    this.store.advanceLifeState(characterId, now, { timezone: 'Asia/Shanghai' });
    return this.contextFor(characterId, now);
  }

  contextFor(characterId, now = Date.now()) {
    const episodes = this.store.listLifeEpisodes(characterId);
    const activeEpisodes = episodes.filter(item => item.status !== 'cancelled');
    const current = activeEpisodes.find(item => item.startAt <= now && item.endAt > now) || null;
    const recent = activeEpisodes.filter(item => item.endAt <= now).slice(-3);
    const upcoming = activeEpisodes.filter(item => item.startAt > now).slice(0, 3);
    const horizonEndAt = activeEpisodes.reduce(
      (maximum, item) => Math.max(maximum, item.endAt),
      0
    ) || null;
    const planWindowStartAt = Math.max(Number(now), Number(horizonEndAt || 0));
    return {
      computedAt: Number(now),
      timezone: 'Asia/Shanghai',
      current,
      recent,
      upcoming,
      revision: this.store.getCharacterLifeState(characterId)?.revision || 0,
      horizonEndAt,
      planWindowStartAt,
      targetPlanEndAt: planWindowStartAt + this.targetPlanMs,
      needsPlan: !horizonEndAt || horizonEndAt - Number(now) < this.planningThresholdMs,
      cognitiveSignals: {
        currentEpisodeId: current?.episodeId || null,
        elapsedSinceRecentEpisodeMs: recent.length
          ? Math.max(0, Number(now) - Number(recent.at(-1).endAt))
          : null,
        bodyState: String(current?.payload?.bodyState || ''),
        attention: String(current?.payload?.attention || current?.title || ''),
        intensityDelta: Number(current?.payload?.intensityDelta || 0)
      }
    };
  }

  applyAdjustment(characterId, adjustment, turnId, now = Date.now()) {
    return this.store.transaction(() => (
      this.store.applyLifeAdjustment(characterId, adjustment, turnId, now)
    ));
  }
}
