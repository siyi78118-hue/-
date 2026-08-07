import { buildGenerationWindow } from './conversation-context.mjs';
import { buildEvidencePack } from './retrieval.mjs';
import { selectSocialExperience } from './social-experience.mjs';

export const COGNITION_CONTEXT_LIMITS = Object.freeze({
  recentMessages: 20,
  combinedMemoryItems: 8,
  openThreads: 3,
  socialLessons: 5
});

const PUBLIC_MOMENT_KINDS = new Set([
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);

function isPublicMomentKind(kind) {
  return PUBLIC_MOMENT_KINDS.has(String(kind || ''));
}

function publicEnvelopeProjection(envelope) {
  const source = envelope && typeof envelope === 'object' ? envelope : {};
  const projected = {};
  for (const key of ['protocolVersion', 'turnId', 'characterId', 'deviceId', 'deviceSeq', 'createdAt', 'kind']) {
    if (source[key] !== undefined) projected[key] = structuredClone(source[key]);
  }
  if (source.trigger && typeof source.trigger === 'object') {
    const trigger = {};
    for (const key of ['triggerId', 'triggerType', 'scheduledFor', 'executedAt']) {
      if (source.trigger[key] !== undefined) trigger[key] = structuredClone(source.trigger[key]);
    }
    // Public moment authority is carried in the store-owned turn annotation;
    // transport trigger context is intentionally not a cognition input.
    trigger.context = {};
    projected.trigger = trigger;
  }
  return projected;
}

export class CognitionContextOverflowError extends Error {
  constructor(regionCharacters) {
    super('protected cognition context exceeds model limit');
    this.name = 'CognitionContextOverflowError';
    this.regionCharacters = regionCharacters;
  }
}

function jsonCharacters(value) {
  return JSON.stringify(value).length;
}

function sanitizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return attachment;
  const { dataUrl, base64, bytes, ...metadata } = attachment;
  return metadata;
}

export function sanitizeCognitionMessage(message) {
  if (!message || typeof message !== 'object') return message;
  return {
    ...message,
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map(sanitizeAttachment)
      : []
  };
}

export function rankCognitionItems(items, limit, scoreKeys = ['relevanceScore', 'score']) {
  const boundedLimit = Math.max(0, Number(limit) || 0);
  return [...(Array.isArray(items) ? items : [])]
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftScore = scoreKeys.reduce(
        (score, key) => score || Number(left.item?.[key] || 0),
        0
      );
      const rightScore = scoreKeys.reduce(
        (score, key) => score || Number(right.item?.[key] || 0),
        0
      );
      return rightScore - leftScore || left.index - right.index;
    })
    .slice(0, boundedLimit)
    .map(({ item }) => item);
}

function localMemoryItem(hint) {
  return {
    kind: 'phone_memory_hint',
    recordId: String(hint?.recordId || ''),
    text: String(hint?.text || ''),
    importance: Number(hint?.importance || 0),
    score: Number(hint?.score || 0),
    createdAt: Number(hint?.createdAt || 0),
    provenance: {
      sourceType: String(hint?.sourceType || 'vector'),
      recordId: String(hint?.recordId || '')
    }
  };
}

function factMemoryItem(fact) {
  return {
    kind: 'pc_verified_fact',
    factId: fact.factId,
    type: fact.type,
    subjectId: fact.subjectId,
    predicate: fact.predicate,
    object: fact.object,
    exactQuotes: fact.exactQuotes || [],
    sourceMessageIds: fact.sourceMessageIds || [],
    confidence: fact.confidence,
    relevanceScore: fact.relevanceScore,
    provenance: {
      sourceType: 'pc_verified_fact',
      factId: fact.factId,
      sourceMessageIds: fact.sourceMessageIds || []
    }
  };
}

function regionSizes(context) {
  return Object.fromEntries([
    'currentBatch',
    'relationshipStage',
    'activeExplicitBoundaries',
    'payment',
    'recentMessages',
    'memoryItems',
    'openThreads',
    'socialLessons',
    'lifeContext'
  ].map(key => [key, jsonCharacters(context[key])]));
}

function protectedProjection(context) {
  return {
    kind: context.kind,
    characterId: context.characterId,
    currentBatch: context.currentBatch,
    trigger: context.trigger,
    relationshipStage: context.relationshipStage,
    activeExplicitBoundaries: context.activeExplicitBoundaries,
    payment: context.payment
  };
}

function markTrimmed(context, region) {
  if (!context.trimmedRegions.includes(region)) context.trimmedRegions.push(region);
}

function trimToLimit(context, maxCharacters) {
  if (jsonCharacters(protectedProjection(context)) > maxCharacters) {
    throw new CognitionContextOverflowError(regionSizes(context));
  }
  while (jsonCharacters(context) > maxCharacters && context.socialLessons.length) {
    context.socialLessons.pop();
    markTrimmed(context, 'socialLessons');
  }
  while (jsonCharacters(context) > maxCharacters) {
    const candidates = context.memoryItems
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.kind === 'phone_memory_hint'
        && item.provenance?.sourceType !== 'manual')
      .sort((left, right) => left.item.score - right.item.score
        || left.item.createdAt - right.item.createdAt);
    if (!candidates.length) break;
    context.memoryItems.splice(candidates[0].index, 1);
    markTrimmed(context, 'automaticLocalMemoryHints');
  }
  while (jsonCharacters(context) > maxCharacters) {
    const index = context.memoryItems.findLastIndex(item => item.kind === 'pc_verified_fact');
    if (index < 0) break;
    context.memoryItems.splice(index, 1);
    markTrimmed(context, 'pcVerifiedFacts');
  }
  while (jsonCharacters(context) > maxCharacters && context.recentMessages.length) {
    const first = context.recentMessages[0];
    const groupId = first?.batchId
      ? `${first.speakerType || first.speakerId}:batch:${first.batchId}`
      : first?.turnId
        ? `${first.speakerType || first.speakerId}:turn:${first.turnId}`
        : `message:${first?.messageId}`;
    while (context.recentMessages.length) {
      const current = context.recentMessages[0];
      const currentGroupId = current?.batchId
        ? `${current.speakerType || current.speakerId}:batch:${current.batchId}`
        : current?.turnId
          ? `${current.speakerType || current.speakerId}:turn:${current.turnId}`
          : `message:${current?.messageId}`;
      if (currentGroupId !== groupId) break;
      context.recentMessages.shift();
    }
    markTrimmed(context, 'recentMessages');
  }
  if (jsonCharacters(context) > maxCharacters) {
    throw new CognitionContextOverflowError(regionSizes(context));
  }
  return context;
}

export async function buildCognitionContext({
  store,
  envelope,
  scene,
  localMemoryHints = [],
  currentBatch,
  interactionState,
  cognitiveState,
  lifeContext,
  catalog,
  maxCharacters = 80_000
}) {
  if (isPublicMomentKind(envelope?.kind)) {
    return {
      kind: envelope?.kind,
      characterId: envelope?.characterId,
      currentBatch: { messageIds: [], messages: [] },
      trigger: envelope?.trigger || null,
      relationshipStage: null,
      activeExplicitBoundaries: [],
      payment: null,
      recentMessages: [],
      memoryItems: [],
      openThreads: [],
      socialLessons: [],
      lifeContext: null,
      trimmedRegions: []
    };
  }
  const batchMessages = (currentBatch?.messages || []).map(sanitizeCognitionMessage);
  const currentMessageIds = batchMessages.map(item => item.messageId).filter(Boolean);
  const allMessages = typeof store?.listMessages === 'function'
    ? store.listMessages(envelope?.characterId)
    : [];
  const recentMessages = buildGenerationWindow(allMessages, {
    currentMessageIds,
    limit: COGNITION_CONTEXT_LIMITS.recentMessages
  }).map(sanitizeCognitionMessage);
  const query = batchMessages.map(item => item.content).filter(Boolean).join(' ');
  const evidencePack = buildEvidencePack(store, {
    characterId: envelope?.characterId,
    query,
    limit: COGNITION_CONTEXT_LIMITS.combinedMemoryItems
  });

  const manual = localMemoryHints
    .filter(item => item?.sourceType === 'manual')
    .sort((left, right) => Number(right.importance || 0) - Number(left.importance || 0)
      || Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .map(localMemoryItem);
  const facts = evidencePack.facts.map(factMemoryItem);
  const automatic = localMemoryHints
    .filter(item => item?.sourceType !== 'manual')
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0)
      || Number(right.importance || 0) - Number(left.importance || 0)
      || Number(right.createdAt || 0) - Number(left.createdAt || 0))
    .map(localMemoryItem);
  const memoryItems = [...manual, ...facts, ...automatic]
    .slice(0, COGNITION_CONTEXT_LIMITS.combinedMemoryItems);
  const activeExplicitBoundaries = (interactionState?.conversationFrame?.explicitBoundaries || [])
    .filter(item => item?.active);
  const socialLessons = selectSocialExperience({
    catalog,
    turnKind: envelope?.kind,
    currentBatch: { ...currentBatch, messages: batchMessages },
    trigger: envelope?.trigger,
    relationshipStage: scene?.relationshipStage,
    routeReasons: envelope?.routeReasons,
    limit: COGNITION_CONTEXT_LIMITS.socialLessons
  });

  const context = {
    kind: envelope?.kind,
    characterId: envelope?.characterId,
    currentBatch: {
      ...currentBatch,
      messageIds: currentBatch?.messageIds || currentMessageIds,
      messages: batchMessages
    },
    trigger: envelope?.trigger || null,
    relationshipStage: scene?.relationshipStage || null,
    activeExplicitBoundaries,
    payment: envelope?.context?.payment || null,
    recentMessages,
    memoryItems,
    openThreads: (cognitiveState?.openThreads || [])
      .slice(0, COGNITION_CONTEXT_LIMITS.openThreads),
    socialLessons,
    lifeContext: lifeContext || null,
    trimmedRegions: []
  };
  return trimToLimit(context, Math.max(1, Number(maxCharacters) || 80_000));
}

export async function buildCognitionV3Input(input) {
  const context = await buildCognitionContext(input);
  const roleId = String(input.envelope?.characterId || '');
  if (isPublicMomentKind(input.envelope?.kind)) {
    const sourceTurn = input.turn && typeof input.turn === 'object' ? input.turn : {};
    const annotationSnapshot = {};
    for (const key of ['publicMomentAuthority', 'momentTargetAuthority']) {
      if (sourceTurn.annotationSnapshot?.[key] !== undefined) {
        annotationSnapshot[key] = structuredClone(sourceTurn.annotationSnapshot[key]);
      }
    }
    return {
      envelope: publicEnvelopeProjection(input.envelope),
      turn: {
        protocolVersion: sourceTurn.protocolVersion ?? input.envelope?.protocolVersion,
        turnKind: sourceTurn.turnKind || sourceTurn.rolloutKey || input.envelope?.kind,
        rolloutKey: sourceTurn.rolloutKey || input.envelope?.kind,
        annotationSnapshot
      },
      currentBatch: context.currentBatch,
      relevantHistory: [],
      verifiedFacts: [],
      constraints: [],
      preferences: [],
      stances: [],
      relationship: null,
      lifeSignals: [],
      socialExperience: [],
      openThreads: [],
      publicMomentAuthority: input.turn?.annotationSnapshot?.publicMomentAuthority || null,
      momentTargetAuthority: input.turn?.annotationSnapshot?.momentTargetAuthority || null,
      publicPrivacy: input.publicPrivacy && typeof input.publicPrivacy === 'object'
        ? { allowPublic: input.publicPrivacy.allowPublic === true }
        : { allowPublic: true }
    };
  }
  return {
    ...input,
    currentBatch: context.currentBatch,
    relevantHistory: context.recentMessages,
    verifiedFacts: context.memoryItems.filter((item) => item.kind === 'pc_verified_fact'),
    constraints: typeof input.store?.listActiveConstraints === 'function'
      ? input.store.listActiveConstraints(roleId)
      : (input.constraints || []),
    preferences: input.preferences || [],
    stances: typeof input.store?.listActiveStances === 'function'
      ? input.store.listActiveStances(roleId, input.now || Date.now())
      : (input.stances || []),
    relationship: input.scene?.relationshipStage || input.relationship || null,
    lifeSignals: input.lifeSignals || (context.lifeContext ? [context.lifeContext] : []),
    socialExperience: context.socialLessons,
    openThreads: context.openThreads
  };
}
