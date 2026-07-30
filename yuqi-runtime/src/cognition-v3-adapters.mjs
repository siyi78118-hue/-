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
  return (input.lifeEvents || input.committedLifeEvents || [])
    .filter((event) => event?.state === 'committed' && event?.privacy === 'public')
    .map(clone);
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
  return {
    motiveCandidates: clone(input.motiveCandidates || []),
    openThreads: rankCognitionItems(input.openThreads, 3).map(clone),
    dueCommitments: clone(input.dueCommitments || [])
  };
}

function proactiveMomentFeatureContext(input) {
  return {
    committedLifeEvents: publicCommittedEvents(input),
    publicPrivacy: clone(input.publicPrivacy || {})
  };
}

function momentInteractionFeatureContext(input) {
  return {
    targetMoment: clone(input.targetMoment || null),
    targetComment: clone(input.targetComment || null),
    thread: clone(input.thread || [])
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
    ...rolePlanChatFeatureContext(input),
    publicPrivacy: clone(input.publicPrivacy || {})
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
  const agencyView = compileAgencyView({
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
  const currentInteraction = currentUserInteractionForCognition(
    input.currentBatch || input.envelope?.context?.currentBatch
  );
  return {
    schemaVersion: 3,
    turnId: String(input.envelope?.turnId || ''),
    characterId: String(input.envelope?.characterId || ''),
    turnKind: kind,
    currentInteraction,
    relevantHistory: takeCompleteMessageGroups(
      (input.relevantHistory || []).map(sanitizeCognitionMessage),
      20
    ),
    verifiedFacts: rankCognitionItems(input.verifiedFacts, 8).map(clone),
    ...agencyView,
    relationshipBasePhase: relationshipBasePhase(input),
    lifeSignals: rankCognitionItems(input.lifeSignals, 5).map(clone),
    authorSettings: clone(input.authorSettings || {}),
    allowedActions: turnAdapter.allowedActions(input),
    featureContext,
    socialExperience: rankCognitionItems(input.socialExperience, 3).map(clone),
    openThreads: rankCognitionItems(input.openThreads, 3).map(clone)
  };
}
