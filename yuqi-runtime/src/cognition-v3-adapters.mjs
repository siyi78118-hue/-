import { compileAgencyView } from './agency-state.mjs';
import { rankCognitionItems, sanitizeCognitionMessage } from './cognition-context.mjs';
import { takeCompleteMessageGroups } from './conversation-context.mjs';
import { currentUserInteractionForCognition } from './current-user-batch.mjs';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function attachmentReferences(batch) {
  return (batch?.messages || []).flatMap((message) =>
    sanitizeCognitionMessage(message)?.attachments || []);
}

function relationshipBasePhase(input) {
  const relationship = input.relationship || input.relationshipStage || {};
  return {
    base: clone(relationship.base ?? null),
    phase: clone(relationship.phase ?? null),
    formalFacts: clone(relationship.formalFacts || []),
    allowedFormalTransitions: clone(relationship.allowedFormalTransitions
      || relationship.allowedTransitions
      || []),
    toneTendencies: clone(relationship.toneTendencies
      || relationship.stagePersona?.toneTendencies
      || [])
  };
}

function publicCommittedEvents(input) {
  const authority = input.turn?.annotationSnapshot?.publicMomentAuthority;
  if (!authority || !Array.isArray(authority.candidates)) return [];
  return authority.candidates.map(clone);
}

function fixedPublicBoundary() {
  return {
    version: 'public-boundary-v1',
    visibility: 'public',
    recipientId: 'public_moments',
    allowPrivateChatContext: false,
    allowPaymentContext: false,
    allowRelationshipContext: false,
    allowPrivateMemoryContext: false
  };
}

function publicAuthorSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const key of ['language', 'publicName', 'displayName']) {
    if (typeof source[key] === 'string' && source[key].trim()) output[key] = source[key].trim();
  }
  return output;
}

function directReplyFeatureContext(input) {
  const batch = input.currentBatch || input.envelope?.context?.currentBatch || null;
  return {
    currentBatch: currentUserInteractionForCognition(batch),
    payment: clone(input.envelope?.context?.payment || input.payment || null),
    attachments: attachmentReferences(batch),
    quote: clone(input.envelope?.context?.quote || input.quote || null)
  };
}

function proactiveChatFeatureContext(input) {
  const persistedAuthority = input.turn?.annotationSnapshot?.proactiveMotiveAuthority;
  const protocolVersion = Number(input.turn?.protocolVersion ?? input.envelope?.protocolVersion ?? 0);
  const turnKind = input.turn?.turnKind || input.turn?.rolloutKey || input.envelope?.kind;
  if (protocolVersion === 3 && turnKind === 'PROACTIVE_CHAT') {
    return {
      motiveCandidates: clone(persistedAuthority?.candidates || []),
      openThreads: rankCognitionItems(input.openThreads, 3).map(clone),
      dueCommitments: clone(input.dueCommitments || [])
    };
  }
  const authority = persistedAuthority !== undefined
    ? persistedAuthority
    : input.proactiveMotiveAuthority;
  return {
    motiveCandidates: clone(authority?.candidates || input.motiveCandidates || []),
    openThreads: rankCognitionItems(input.openThreads, 3).map(clone),
    dueCommitments: clone(input.dueCommitments || [])
  };
}

function proactiveMomentFeatureContext(input) {
  return {
    committedLifeEvents: publicCommittedEvents(input),
    publicPrivacy: fixedPublicBoundary()
  };
}

function momentInteractionFeatureContext(input) {
  const authority = input.turn?.annotationSnapshot?.momentTargetAuthority;
  if (!authority) {
    return {
      targetMoment: null,
      targetComment: null,
      thread: [],
      publicPrivacy: fixedPublicBoundary()
    };
  }
  return {
    targetMoment: clone(authority.targetMoment || null),
    targetComment: clone(authority.targetComment || null),
    thread: clone(authority.targetMoment?.comments || []),
    publicPrivacy: fixedPublicBoundary()
  };
}

function rolePlanChatFeatureContext(input) {
  return {
    rolePlan: clone(input.rolePlan || null),
    occurrence: clone(input.occurrence || null)
  };
}

function rolePlanMomentFeatureContext(input) {
  return {
    // Task 19 owns the validated occurrence/role-plan authority.  Until that
    // authority is present, the public lane must not trust direct caller
    // objects (which may contain private decisions or scene data).
    rolePlan: null,
    occurrence: null,
    publicPrivacy: fixedPublicBoundary()
  };
}

function lifePlanningFeatureContext(input) {
  return {
    planningWindow: clone(input.planningWindow || null),
    existingEpisodes: clone(input.existingEpisodes || [])
  };
}

function adapter(buildFeatureContext, actions) {
  return Object.freeze({
    buildFeatureContext,
    allowedActions() {
      return [...actions];
    }
  });
}

const ADAPTERS = Object.freeze({
  DIRECT_REPLY: adapter(directReplyFeatureContext, ['send', 'payment_accept', 'payment_decline']),
  PROACTIVE_CHAT: adapter(proactiveChatFeatureContext, ['send', 'skip']),
  PROACTIVE_MOMENT: adapter(proactiveMomentFeatureContext, ['post', 'skip']),
  MOMENT_INTERACTION: adapter(momentInteractionFeatureContext, ['like', 'comment', 'skip']),
  MOMENT_REPLY: adapter(momentInteractionFeatureContext, ['reply', 'skip']),
  ROLE_PLAN_CHAT: adapter(rolePlanChatFeatureContext, ['send', 'create', 'update', 'delete', 'skip']),
  ROLE_PLAN_MOMENT: adapter(rolePlanMomentFeatureContext, ['post', 'create', 'update', 'delete', 'skip']),
  ROLE_PLAN_CHAT_PRIVATE: adapter(rolePlanChatFeatureContext, ['send', 'create', 'update', 'delete', 'skip']),
  ROLE_PLAN_MOMENT_PRIVATE: adapter(
    rolePlanMomentFeatureContext,
    ['post', 'create', 'update', 'delete', 'skip']
  ),
  LIFE_PLANNING: adapter(lifePlanningFeatureContext, ['plan', 'skip'])
});

export function adapterForTurnKind(kind) {
  const adapterValue = ADAPTERS[String(kind || '')];
  if (!adapterValue) throw new Error(`unsupported cognition-v3 TurnKind: ${kind}`);
  return adapterValue;
}

export function buildCognitionEnvelopeV3(input) {
  const kind = String(input?.envelope?.kind || '');
  const turnAdapter = adapterForTurnKind(kind);
  const featureContext = turnAdapter.buildFeatureContext(input);
  const publicMomentKind = [
    'PROACTIVE_MOMENT',
    'MOMENT_INTERACTION',
    'MOMENT_REPLY',
    'ROLE_PLAN_MOMENT',
    'ROLE_PLAN_MOMENT_PRIVATE'
  ].includes(kind);
  const agencyView = publicMomentKind
    ? {
      hardConstraints: [],
      currentStances: [],
      preferences: []
    }
    : compileAgencyView({
      constraints: input.constraints,
      preferences: input.preferences,
      stances: input.stances,
      featureContext: {
        ...featureContext,
        kind,
        now: input.now
      },
      limits: {
        hardConstraints: 5,
        currentStances: 2,
        preferences: 4
      }
    });
  const currentInteraction = publicMomentKind
    ? { messageIds: [], messages: [] }
    : currentUserInteractionForCognition(
      input.currentBatch || input.envelope?.context?.currentBatch
    );
  return {
    schemaVersion: 3,
    turnId: String(input.envelope?.turnId || ''),
    characterId: String(input.envelope?.characterId || ''),
    turnKind: kind,
    currentInteraction,
    relevantHistory: publicMomentKind
      ? []
      : takeCompleteMessageGroups(
        (input.relevantHistory || []).map(sanitizeCognitionMessage),
        20
      ),
    verifiedFacts: publicMomentKind ? [] : rankCognitionItems(input.verifiedFacts, 8).map(clone),
    ...agencyView,
    relationshipBasePhase: publicMomentKind
      ? { base: null, phase: null, formalFacts: [], allowedFormalTransitions: [], toneTendencies: [] }
      : relationshipBasePhase(input),
    lifeSignals: publicMomentKind ? [] : rankCognitionItems(input.lifeSignals, 5).map(clone),
    authorSettings: publicMomentKind
      ? publicAuthorSettings(input.authorSettings)
      : clone(input.authorSettings || {}),
    allowedActions: turnAdapter.allowedActions(input),
    featureContext,
    socialExperience: publicMomentKind ? [] : rankCognitionItems(input.socialExperience, 3).map(clone),
    openThreads: publicMomentKind ? [] : rankCognitionItems(input.openThreads, 3).map(clone)
  };
}
