const HARD_AUTHORITIES = new Set(['system', 'author', 'user']);
const HARD_KINDS = new Set([
  'capability',
  'consent',
  'privacy',
  'action',
  'commitment',
  'relationship_fact'
]);
const CONSTRAINT_STATUSES = new Set(['active', 'released', 'archived']);
const STANCE_OPS = new Set(['maintain', 'strengthen', 'soften', 'reverse', 'expire', 'create']);
const STANCE_STATUSES = new Set(['active', 'expired', 'superseded']);

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function requiredText(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function finiteNumber(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, finiteNumber(value)));
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.trunc(finiteNumber(value, fallback))));
}

function normalizedMessageIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item ?? '').trim()).filter(Boolean))];
}

function normalizeScope(value) {
  const scope = value && typeof value === 'object' ? value : {};
  const channel = String(scope.channel || 'all');
  if (!['private_chat', 'public_moment', 'all'].includes(channel)) {
    throw new Error('hard constraint scope channel is invalid');
  }
  return {
    ...clone(scope),
    channel,
    target: requiredText(scope.target || 'all', 'hard constraint scope target')
  };
}

function evidenceForIds(ids, evidenceIndex) {
  return ids.map(id => evidenceIndex.get(String(id)));
}

function assertUserConstraintEvidence(sourceMessageIds, evidenceIndex) {
  const evidence = evidenceForIds(sourceMessageIds, evidenceIndex);
  if (!evidence.length || evidence.some(item => item?.speakerType !== 'user')) {
    throw new Error('user hard constraint requires user message evidence');
  }
}

export function normalizeHardConstraint(value, evidenceIndex = new Map()) {
  if (!value || typeof value !== 'object') throw new Error('hard constraint is required');
  if (!HARD_AUTHORITIES.has(value.authority)) {
    throw new Error('hard constraint authority is invalid');
  }
  const kind = requiredText(value.kind, 'hard constraint kind');
  if (!HARD_KINDS.has(kind)) throw new Error('hard constraint kind is invalid');
  const sourceMessageIds = normalizedMessageIds(value.sourceMessageIds);
  if (value.authority === 'user') assertUserConstraintEvidence(sourceMessageIds, evidenceIndex);
  const status = value.status || 'active';
  if (!CONSTRAINT_STATUSES.has(status)) throw new Error('hard constraint status is invalid');
  const revision = boundedInteger(value.revision, 1, 1, Number.MAX_SAFE_INTEGER);
  return deepFreeze({
    ...clone(value),
    constraintId: requiredText(value.constraintId, 'hard constraint id'),
    authority: value.authority,
    kind,
    subject: value.subject || 'both',
    scope: normalizeScope(value.scope),
    rule: requiredText(value.rule || kind, 'hard constraint rule'),
    sourceMessageIds,
    sourceConfigRef: value.sourceConfigRef ?? null,
    createdAt: finiteNumber(value.createdAt),
    releaseCondition: value.releaseCondition == null ? null : String(value.releaseCondition),
    status,
    revision,
    supersedes: value.supersedes ?? null
  });
}

export function normalizePreference(value) {
  if (!value || typeof value !== 'object') throw new Error('preference is required');
  return deepFreeze({
    ...clone(value),
    binding: false
  });
}

function expectedEvidenceSpeaker(authority) {
  if (authority === 'user') return 'user';
  if (authority === 'author') return 'author';
  return 'system';
}

function assertMatchingReleaseAuthority(constraint, authorityEvidence) {
  if (!Array.isArray(authorityEvidence) || authorityEvidence.length === 0) {
    throw new Error('constraint transition requires matching authority evidence');
  }
  const expected = expectedEvidenceSpeaker(constraint.authority);
  if (authorityEvidence.some(item =>
    item?.speakerType !== expected || !String(item?.messageId || '').trim())) {
    throw new Error('constraint transition requires matching authority evidence');
  }
}

export function transitionHardConstraint({
  constraint,
  operation,
  authorityEvidence,
  now = Date.now()
}) {
  if (!constraint || constraint.status !== 'active') {
    throw new Error('only an active hard constraint can transition');
  }
  if (!['release', 'archive'].includes(operation)) {
    throw new Error('invalid constraint transition');
  }
  assertMatchingReleaseAuthority(constraint, authorityEvidence);
  return deepFreeze({
    ...clone(constraint),
    revision: boundedInteger(constraint.revision, 1, 1, Number.MAX_SAFE_INTEGER) + 1,
    status: operation === 'release' ? 'released' : 'archived',
    supersedes: constraint.constraintId,
    sourceMessageIds: normalizedMessageIds(authorityEvidence.map(item => item.messageId)),
    updatedAt: finiteNumber(now)
  });
}

export function normalizeCurrentStance(value, now = Date.now()) {
  if (!value || typeof value !== 'object') throw new Error('current stance is required');
  const expiresAt = value.expiresAt == null ? null : finiteNumber(value.expiresAt);
  const requestedStatus = value.status || 'active';
  if (!STANCE_STATUSES.has(requestedStatus)) throw new Error('current stance status is invalid');
  const status = expiresAt != null && expiresAt <= finiteNumber(now)
    ? 'expired'
    : requestedStatus;
  return deepFreeze({
    ...clone(value),
    stanceId: requiredText(value.stanceId, 'stance id'),
    topic: requiredText(value.topic, 'stance topic'),
    position: requiredText(value.position, 'stance position'),
    reason: value.reason == null ? '' : String(value.reason),
    strength: clamp01(value.strength),
    flexibility: clamp01(value.flexibility),
    sourceMessageIds: normalizedMessageIds(value.sourceMessageIds),
    createdAt: finiteNumber(value.createdAt),
    lastConfirmedAt: finiteNumber(value.lastConfirmedAt ?? value.createdAt),
    expiresAt,
    remainingRelevantUserBatches: boundedInteger(
      value.remainingRelevantUserBatches,
      3,
      0,
      3
    ),
    status,
    revision: boundedInteger(value.revision, 1, 1, Number.MAX_SAFE_INTEGER),
    supersedes: value.supersedes ?? null
  });
}

function batchTopics(relevantBatch) {
  return new Set((relevantBatch?.topics || []).map(item => String(item)));
}

function stanceIsRelevant(stance, relevantBatch) {
  const topics = batchTopics(relevantBatch);
  return topics.has(stance.topic) || topics.has('*') || topics.has('all');
}

function assertFreshEvidence(transition, relevantBatch, evidenceIndex) {
  const freshIds = new Set(normalizedMessageIds(relevantBatch?.messageIds));
  const transitionIds = normalizedMessageIds(transition.evidenceMessageIds);
  if (!transitionIds.length || transitionIds.some(id => !freshIds.has(id))) {
    throw new Error('stance transition requires fresh evidence from the submitted batch');
  }
  if (evidenceIndex instanceof Map && evidenceIndex.size > 0) {
    const evidence = evidenceForIds(transitionIds, evidenceIndex);
    if (evidence.some(item => !item || item.speakerType !== 'user')) {
      throw new Error('stance transition requires fresh user evidence');
    }
  }
  return transitionIds;
}

function validateTransitionCoverage(stances, transitions, relevantBatch) {
  if (!Array.isArray(transitions)) throw new Error('stance transitions are required');
  for (const transition of transitions) {
    if (!STANCE_OPS.has(transition?.operation)) throw new Error('invalid stance transition operation');
  }
  const transitionCounts = new Map();
  for (const transition of transitions.filter(item => item.operation !== 'create')) {
    const stanceId = String(transition.stanceId || '');
    transitionCounts.set(stanceId, (transitionCounts.get(stanceId) || 0) + 1);
  }
  for (const current of stances.filter(item => item.status === 'active')) {
    const required = stanceIsRelevant(current, relevantBatch);
    const count = transitionCounts.get(current.stanceId) || 0;
    if ((required && count !== 1) || (!required && count !== 0)) {
      throw new Error(`stance transition coverage is invalid for ${current.stanceId}`);
    }
  }
  const activeIds = new Set(stances.filter(item => item.status === 'active').map(item => item.stanceId));
  for (const stanceId of transitionCounts.keys()) {
    if (!activeIds.has(stanceId)) throw new Error(`stance transition target is not active: ${stanceId}`);
  }
}

function terminalStance(current, status, transition, now, remaining) {
  return deepFreeze({
    ...clone(current),
    revision: current.revision + 1,
    status,
    supersedes: `${current.stanceId}@${current.revision}`,
    sourceMessageIds: normalizedMessageIds(transition.evidenceMessageIds),
    lastConfirmedAt: finiteNumber(now),
    remainingRelevantUserBatches: Math.max(0, remaining)
  });
}

function revisedActiveStance(current, transition, now, remaining) {
  const revision = current.revision + 1;
  const operation = transition.operation;
  const defaultStrength = operation === 'strengthen'
    ? current.strength + 0.15
    : operation === 'soften'
      ? current.strength - 0.15
      : current.strength;
  const extended = transition.extendRelevantUserBatches == null
    ? remaining
    : boundedInteger(transition.extendRelevantUserBatches, remaining, 0, 3);
  return normalizeCurrentStance({
    ...clone(current),
    stanceId: current.stanceId,
    position: operation === 'reverse'
      ? requiredText(transition.position, 'reversed stance position')
      : transition.position ?? current.position,
    reason: transition.reason ?? current.reason,
    strength: transition.strength ?? defaultStrength,
    flexibility: transition.flexibility ?? current.flexibility,
    sourceTurnId: transition.sourceTurnId ?? current.sourceTurnId,
    sourceMessageIds: transition.evidenceMessageIds,
    lastConfirmedAt: finiteNumber(now),
    expiresAt: transition.expiresAt === undefined ? current.expiresAt : transition.expiresAt,
    remainingRelevantUserBatches: extended,
    status: 'active',
    revision,
    supersedes: `${current.stanceId}@${current.revision}`
  }, now);
}

function createStance(transition, relevantBatch, now) {
  return normalizeCurrentStance({
    stanceId: requiredText(transition.stanceId, 'created stance id'),
    topic: transition.topic,
    position: transition.position,
    reason: transition.reason ?? '',
    strength: transition.strength ?? 0.5,
    flexibility: transition.flexibility ?? 0.5,
    sourceTurnId: transition.sourceTurnId ?? relevantBatch?.turnId ?? null,
    sourceMessageIds: transition.evidenceMessageIds,
    createdAt: finiteNumber(now),
    lastConfirmedAt: finiteNumber(now),
    expiresAt: transition.expiresAt ?? null,
    remainingRelevantUserBatches: transition.remainingRelevantUserBatches ?? 3,
    status: 'active',
    revision: 1,
    supersedes: null
  }, now);
}

export function applyStanceTransitions({
  stances = [],
  transitions = [],
  relevantBatch = {},
  evidenceIndex = new Map(),
  now = Date.now()
}) {
  const normalized = stances.map(item => normalizeCurrentStance(item, now));
  const timeExpired = normalized.flatMap((item, index) =>
    item.status === 'expired' && stances[index]?.status === 'active'
      ? [terminalStance(
          normalizeCurrentStance(
            stances[index],
            Math.min(finiteNumber(now), finiteNumber(stances[index].expiresAt) - 1)
          ),
          'expired',
          { evidenceMessageIds: stances[index].sourceMessageIds || [] },
          now,
          0
        )]
      : []);
  const current = normalized.filter(item => item.status === 'active');
  validateTransitionCoverage(current, transitions, relevantBatch);

  const activeStances = [];
  const changedRecords = [...timeExpired];
  const transitionByStance = new Map(
    transitions.filter(item => item.operation !== 'create').map(item => [String(item.stanceId), item])
  );

  for (const stance of current) {
    const transition = transitionByStance.get(stance.stanceId);
    if (!transition) {
      activeStances.push(stance);
      continue;
    }
    const evidenceMessageIds = assertFreshEvidence(transition, relevantBatch, evidenceIndex);
    const transitionWithEvidence = { ...transition, evidenceMessageIds };
    const remaining = Math.max(0, stance.remainingRelevantUserBatches - 1);
    if (transition.operation === 'expire' || remaining === 0) {
      changedRecords.push(terminalStance(
        stance,
        'expired',
        transitionWithEvidence,
        now,
        remaining
      ));
      continue;
    }

    const replacement = revisedActiveStance(stance, transitionWithEvidence, now, remaining);
    changedRecords.push(replacement);
    activeStances.push(replacement);
  }

  for (const transition of transitions.filter(item => item.operation === 'create')) {
    const evidenceMessageIds = assertFreshEvidence(transition, relevantBatch, evidenceIndex);
    const created = createStance({ ...transition, evidenceMessageIds }, relevantBatch, now);
    if (activeStances.some(item => item.stanceId === created.stanceId)
      || normalized.some(item => item.stanceId === created.stanceId)) {
      throw new Error(`created stance id already exists: ${created.stanceId}`);
    }
    activeStances.push(created);
    changedRecords.push(created);
  }

  const auditRecords = changedRecords.map(record => ({
    stanceId: record.stanceId,
    revision: record.revision,
    status: record.status,
    supersedes: record.supersedes ?? null,
    sourceMessageIds: [...record.sourceMessageIds],
    lastConfirmedAt: record.lastConfirmedAt
  }));
  return deepFreeze({
    activeStances: activeStances.sort((left, right) => left.stanceId.localeCompare(right.stanceId)),
    changedRecords,
    auditRecords
  });
}

function normalizedTopics(featureContext) {
  return new Set([
    ...(featureContext?.topics || []),
    featureContext?.topic,
    featureContext?.target
  ].filter(Boolean).map(item => String(item)));
}

function recordMatchesContext(record, featureContext) {
  const topics = normalizedTopics(featureContext);
  const topic = String(record.topic ?? record.scope?.target ?? 'all');
  if (topic !== 'all' && topics.size && !topics.has(topic)) return false;
  const channel = record.scope?.channel;
  if (channel && channel !== 'all' && featureContext?.channel && channel !== featureContext.channel) {
    return false;
  }
  return true;
}

const AUTHORITY_RANK = Object.freeze({ system: 3, author: 2, user: 1 });

function compareConstraints(left, right) {
  return (AUTHORITY_RANK[right.authority] || 0) - (AUTHORITY_RANK[left.authority] || 0)
    || finiteNumber(right.revision) - finiteNumber(left.revision)
    || finiteNumber(right.createdAt) - finiteNumber(left.createdAt)
    || String(left.constraintId).localeCompare(String(right.constraintId));
}

function compareStances(left, right) {
  return finiteNumber(right.strength) - finiteNumber(left.strength)
    || finiteNumber(right.lastConfirmedAt) - finiteNumber(left.lastConfirmedAt)
    || String(left.stanceId).localeCompare(String(right.stanceId));
}

function comparePreferences(left, right) {
  return finiteNumber(right.weight) - finiteNumber(left.weight)
    || finiteNumber(right.updatedAt ?? right.createdAt) - finiteNumber(left.updatedAt ?? left.createdAt)
    || String(left.preferenceId ?? left.topic).localeCompare(
      String(right.preferenceId ?? right.topic)
    );
}

export function compileAgencyView({
  constraints = [],
  preferences = [],
  stances = [],
  featureContext = {},
  limits = {}
}) {
  const now = finiteNumber(featureContext.now, Date.now());
  const hardConstraintLimit = boundedInteger(limits.hardConstraints, 5, 0, 5);
  const stanceLimit = boundedInteger(limits.currentStances, 2, 0, 2);
  const preferenceLimit = boundedInteger(limits.preferences, 4, 0, 4);

  const hardConstraints = constraints
    .filter(item => item?.status === 'active' && recordMatchesContext(item, featureContext))
    .map(clone)
    .sort(compareConstraints)
    .slice(0, hardConstraintLimit);
  const currentStances = stances
    .map(item => normalizeCurrentStance(item, now))
    .filter(item => item.status === 'active' && recordMatchesContext(item, featureContext))
    .sort(compareStances)
    .slice(0, stanceLimit)
    .map(clone);
  const relevantPreferences = preferences
    .map(normalizePreference)
    .filter(item => recordMatchesContext(item, featureContext))
    .sort(comparePreferences)
    .slice(0, preferenceLimit)
    .map(clone);

  return deepFreeze({
    hardConstraints,
    currentStances,
    preferences: relevantPreferences
  });
}
