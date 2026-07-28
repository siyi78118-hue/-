const INITIATIVE_OWNERS = new Set(['user', 'yuqi', 'either', 'uncertain']);
const TOPIC_STATUSES = new Set(['closed', 'open', 'uncertain']);
const WAITING_ON = new Set(['user', 'yuqi', 'either', 'none', 'unclear']);

function cleanText(value, limit = 600) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function clampConfidence(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function validEvidenceIds(value, validIds) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter(id => validIds.has(id)))];
}

function normalizeHypotheses(value, validIds) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      intent: cleanText(item?.intent),
      confidence: clampConfidence(item?.confidence),
      evidenceMessageIds: validEvidenceIds(item?.evidenceMessageIds, validIds)
    }))
    .filter(item => item.intent)
    .slice(0, 3);
}

function normalizeBoundaries(value, validIds) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      type: cleanText(item?.type, 80),
      active: item?.active === true,
      reason: cleanText(item?.reason),
      evidenceMessageIds: validEvidenceIds(item?.evidenceMessageIds, validIds)
    }))
    .filter(item => item.active && item.type && item.reason && item.evidenceMessageIds.length)
    .slice(0, 6);
}

function normalizeCorrection(value, validIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rejectedInterpretation = cleanText(source.rejectedInterpretation);
  const evidenceMessageIds = validEvidenceIds(source.evidenceMessageIds, validIds);
  const active = source.active === true && Boolean(rejectedInterpretation) && evidenceMessageIds.length > 0;
  return {
    active,
    rejectedInterpretation: active ? rejectedInterpretation : '',
    expiresAfterBatches: active
      ? Math.max(1, Math.min(2, Math.trunc(Number(source.expiresAfterBatches) || 2)))
      : 0,
    evidenceMessageIds: active ? evidenceMessageIds : []
  };
}

function normalizeFrame(value, validIds) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const initiativeSource = source.initiative && typeof source.initiative === 'object'
    ? source.initiative
    : {};
  const topicSource = source.priorTopic && typeof source.priorTopic === 'object'
    ? source.priorTopic
    : {};
  const initiativeOwner = INITIATIVE_OWNERS.has(initiativeSource.suggestedNextCarrier)
    ? initiativeSource.suggestedNextCarrier
    : 'uncertain';
  const topicStatus = TOPIC_STATUSES.has(topicSource.status) ? topicSource.status : 'uncertain';
  const waitingOn = WAITING_ON.has(topicSource.waitingOn) ? topicSource.waitingOn : 'unclear';
  return {
    surfaceAct: cleanText(source.surfaceAct),
    intentHypotheses: normalizeHypotheses(source.intentHypotheses, validIds),
    interactionMode: cleanText(source.interactionMode, 120),
    emotionalTone: cleanText(source.emotionalTone, 120),
    relationshipMove: cleanText(source.relationshipMove),
    initiative: {
      suggestedNextCarrier: initiativeOwner,
      reason: cleanText(initiativeSource.reason)
    },
    priorTopic: {
      status: topicStatus,
      summary: cleanText(topicSource.summary),
      waitingOn,
      evidenceMessageIds: validEvidenceIds(topicSource.evidenceMessageIds, validIds),
      reason: cleanText(topicSource.reason)
    },
    ambiguities: Array.isArray(source.ambiguities)
      ? source.ambiguities.map(item => cleanText(item)).filter(Boolean).slice(0, 6)
      : [],
    responseRisks: Array.isArray(source.responseRisks)
      ? source.responseRisks.map(item => cleanText(item)).filter(Boolean).slice(0, 8)
      : [],
    explicitBoundaries: normalizeBoundaries(source.explicitBoundaries, validIds),
    recentCorrection: normalizeCorrection(source.recentCorrection, validIds)
  };
}

function preserveAmbiguity(frame) {
  if (frame.ambiguities.length > 0) return true;
  const [primary, alternative] = frame.intentHypotheses;
  if (!primary || !alternative || alternative.confidence < 0.25) return false;
  return primary.confidence - alternative.confidence <= 0.35;
}

function collectEvidence(frame) {
  return [...new Set([
    ...frame.intentHypotheses.flatMap(item => item.evidenceMessageIds),
    ...frame.priorTopic.evidenceMessageIds,
    ...frame.explicitBoundaries.flatMap(item => item.evidenceMessageIds),
    ...frame.recentCorrection.evidenceMessageIds
  ])];
}

function deriveMustAddress(frame, scene) {
  const requirements = [];
  const phase = cleanText(scene?.relationshipStage?.phase?.id, 80);
  if (frame.priorTopic.status === 'open' && ['conflict', 'cooling', 'repair'].includes(phase)) {
    requirements.push('回应仍然开放的争执或其造成的互动张力');
  } else if (frame.priorTopic.status === 'open') {
    requirements.push('承接仍然开放的话题');
  }
  if (frame.recentCorrection.active) {
    requirements.push('按用户刚刚的纠正重新理解当前互动');
  }
  return requirements;
}

function deriveForbiddenMoves(frame) {
  return [...new Set([
    ...frame.responseRisks,
    ...(frame.recentCorrection.active ? [frame.recentCorrection.rejectedInterpretation] : [])
  ])];
}

function isStructuralSilence({ envelope, interactionState, frame }) {
  if (envelope?.kind !== 'PROACTIVE_CHAT') return false;
  const openWaitingForUser = frame.priorTopic.status === 'open'
    && ['user', 'either'].includes(frame.priorTopic.waitingOn);
  const userOwnsInitiative = frame.initiative.suggestedNextCarrier === 'user';
  const waitingForReply = interactionState?.waitingForUserReply === true
    || Number(interactionState?.unansweredOutgoingCount || 0) > 0;
  const explicitActiveBoundary = frame.explicitBoundaries.some(boundary => boundary.active);
  return waitingForReply
    && userOwnsInitiative
    && (openWaitingForUser || explicitActiveBoundary);
}

function frozenContract(value) {
  for (const item of [
    value.explicitBoundaries,
    value.mustAddress,
    value.forbiddenMoves,
    value.evidenceMessageIds,
    value.recentCorrection.evidenceMessageIds
  ]) Object.freeze(item);
  Object.freeze(value.recentCorrection);
  return Object.freeze(value);
}

export function compileInteractionContract({
  envelope = {},
  scene = {},
  interactionState = {},
  conversationFrame = {},
  recentMessages = []
} = {}) {
  const validIds = new Set(
    (Array.isArray(recentMessages) ? recentMessages : [])
      .map(item => cleanText(item?.messageId, 200))
      .filter(Boolean)
  );
  const frame = normalizeFrame(conversationFrame, validIds);
  const [primary, alternative] = frame.intentHypotheses;
  const structuralSilence = isStructuralSilence({ envelope, interactionState, frame });
  const activeIssue = frame.priorTopic.status === 'open' ? frame.priorTopic.summary : '';

  return frozenContract({
    schemaVersion: 1,
    shouldRespond: !structuralSilence,
    structuralSilenceReason: structuralSilence ? 'open_conflict_waiting_for_user' : '',
    primaryIntent: primary?.intent || frame.surfaceAct,
    primaryIntentConfidence: primary?.confidence || 0,
    alternativeIntent: alternative?.intent || '',
    preserveAmbiguity: preserveAmbiguity(frame),
    activeIssue,
    initiativeOwner: frame.initiative.suggestedNextCarrier,
    explicitBoundaries: frame.explicitBoundaries,
    mustAddress: deriveMustAddress(frame, scene),
    forbiddenMoves: deriveForbiddenMoves(frame),
    recentCorrection: frame.recentCorrection,
    evidenceMessageIds: collectEvidence(frame)
  });
}
