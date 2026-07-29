import { contentHash } from './protocol.mjs';

const WAITING_ON = new Set(['user', 'yuqi', 'none']);

function boundedIntensity(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeThread(value) {
  const summary = String(value?.summary || value?.label || '').trim();
  const sourceTurnId = String(value?.sourceTurnId || '');
  if (!summary || !sourceTurnId) return null;
  return {
    threadId: String(value?.threadId || `thread_${contentHash({ summary, sourceTurnId }).slice(0, 20)}`),
    summary,
    waitingOn: WAITING_ON.has(value?.waitingOn) ? value.waitingOn : 'none',
    sourceTurnId,
    lastTouchedAt: Number(value?.lastTouchedAt || 0)
  };
}

function normalizeBoundary(value) {
  const sourceMessageIds = Array.isArray(value?.sourceMessageIds)
    ? value.sourceMessageIds.map(String).filter(Boolean)
    : Array.isArray(value?.evidenceMessageIds)
      ? value.evidenceMessageIds.map(String).filter(Boolean)
      : [];
  if (!sourceMessageIds.length) return null;
  return {
    type: String(value?.type || ''),
    reason: String(value?.reason || ''),
    sourceMessageIds,
    expiresAfterBatches: Math.max(0, Number(value?.expiresAfterBatches || 0))
  };
}

export function normalizeCognitiveState(value = {}) {
  const state = {
    schemaVersion: 1,
    revision: Math.max(0, Number(value?.revision || 0)),
    lastTurnId: String(value?.lastTurnId || ''),
    mood: {
      label: String(value?.mood?.label || value?.mood || '平静'),
      cause: String(value?.mood?.cause || value?.moodCause || ''),
      intensity: boundedIntensity(value?.mood?.intensity ?? value?.intensity ?? 0.3),
      updatedAt: Number(value?.mood?.updatedAt || value?.updatedAt || 0)
    },
    bodyState: String(value?.bodyState || '正常'),
    attention: String(value?.attention || ''),
    ownNeed: String(value?.ownNeed || ''),
    stanceTowardUser: String(value?.stanceTowardUser || ''),
    openThreads: (Array.isArray(value?.openThreads) ? value.openThreads : [])
      .map(normalizeThread).filter(Boolean)
      .sort((left, right) => right.lastTouchedAt - left.lastTouchedAt)
      .slice(0, 3),
    activeBoundaries: (Array.isArray(value?.activeBoundaries) ? value.activeBoundaries : [])
      .map(normalizeBoundary).filter(Boolean),
    recentCorrection: value?.recentCorrection?.active ? {
      active: true,
      rejectedInterpretation: String(value.recentCorrection.rejectedInterpretation || ''),
      remainingBatches: Math.max(0, Math.min(2, Number(
        value.recentCorrection.remainingBatches
        ?? value.recentCorrection.expiresAfterBatches
        ?? 2
      ))),
      evidenceMessageIds: Array.isArray(value.recentCorrection.evidenceMessageIds)
        ? value.recentCorrection.evidenceMessageIds.map(String)
        : []
    } : {
      active: false,
      rejectedInterpretation: '',
      remainingBatches: 0,
      evidenceMessageIds: []
    },
    updatedAt: Number(value?.updatedAt || 0)
  };
  return {
    ...state,
    checksum: contentHash(state)
  };
}

export function reduceCognitiveState({
  previous,
  cognitionPacket,
  committedTurn,
  lifeState,
  now = Date.now()
}) {
  const before = normalizeCognitiveState(previous || {});
  if (
    !committedTurn
    || !['committed', 'delivered', 'completed'].includes(committedTurn.state)
    || committedTurn.supervisorDecision === 'reject'
    || !cognitionPacket?.cognitionResult
  ) {
    return before;
  }
  if (before.lastTurnId === committedTurn.turnId) return before;
  const cognition = cognitionPacket.cognitionResult;
  if (committedTurn.kind === 'DIRECT_REPLY' && cognition.decision?.shouldRespond === false) {
    throw new Error('DIRECT_REPLY cognitive state cannot authorize skip');
  }
  const elapsed = Math.max(0, Number(now) - Number(before.updatedAt || now));
  const decay = Math.min(0.35, elapsed / (7 * 24 * 60 * 60_000) * 0.35);
  const proposedIntensity = boundedIntensity(cognition.selfState?.intensity);
  const lifeIntensityDelta = Number(lifeState?.cognitiveSignals?.intensityDelta || 0);
  const mood = {
    label: String(cognition.selfState?.mood || before.mood.label || '平静'),
    cause: String(cognition.selfState?.moodCause || before.mood.cause || ''),
    intensity: boundedIntensity(
      (proposedIntensity || before.mood.intensity) * (1 - decay) + lifeIntensityDelta
    ),
    updatedAt: Number(now)
  };
  const frame = cognition.conversationFrame || {};
  const hooks = (frame.activeHooks || []).map(hook => normalizeThread({
    ...(typeof hook === 'string' ? { summary: hook } : hook),
    sourceTurnId: committedTurn.turnId,
    lastTouchedAt: Number(now)
  })).filter(Boolean);
  const prior = frame.priorTopic?.status === 'open'
    ? normalizeThread({
        summary: frame.priorTopic.summary,
        waitingOn: frame.priorTopic.waitingOn,
        sourceTurnId: committedTurn.turnId,
        lastTouchedAt: Number(now)
      })
    : null;
  const mergedThreads = [...hooks, ...(prior ? [prior] : []), ...before.openThreads];
  const threadsById = new Map();
  for (const thread of mergedThreads) {
    if (!threadsById.has(thread.threadId)) threadsById.set(thread.threadId, thread);
  }
  let recentCorrection;
  if (frame.recentCorrection?.active) {
    recentCorrection = {
      active: true,
      rejectedInterpretation: String(frame.recentCorrection.rejectedInterpretation || ''),
      remainingBatches: Math.max(0, Math.min(2, Number(frame.recentCorrection.expiresAfterBatches || 2))),
      evidenceMessageIds: Array.isArray(frame.recentCorrection.evidenceMessageIds)
        ? frame.recentCorrection.evidenceMessageIds.map(String)
        : []
    };
  } else if (before.recentCorrection.active && committedTurn.hasUserBatch) {
    const remainingBatches = Math.max(0, before.recentCorrection.remainingBatches - 1);
    recentCorrection = {
      ...before.recentCorrection,
      active: remainingBatches > 0,
      remainingBatches
    };
  } else {
    recentCorrection = before.recentCorrection;
  }
  const boundaries = [
    ...(frame.explicitBoundaries || []).map(normalizeBoundary).filter(Boolean),
    ...before.activeBoundaries
  ];
  return normalizeCognitiveState({
    revision: before.revision + 1,
    lastTurnId: committedTurn.turnId,
    mood,
    bodyState: String(lifeState?.cognitiveSignals?.bodyState || cognition.selfState?.bodyState || before.bodyState),
    attention: String(lifeState?.cognitiveSignals?.attention || cognition.selfState?.attention || before.attention),
    ownNeed: String(cognition.selfState?.ownNeed || before.ownNeed),
    stanceTowardUser: String(cognition.selfState?.stanceTowardUser || before.stanceTowardUser),
    openThreads: [...threadsById.values()].slice(0, 3),
    activeBoundaries: boundaries,
    recentCorrection,
    updatedAt: Number(now)
  });
}
