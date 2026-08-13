import { resolveCurrentUserBatch } from './current-user-batch.mjs';

const DEFAULT_PROFILES = Object.freeze({
  fast: Object.freeze({
    memory: Object.freeze({ model: 'gpt-5.6-terra', effort: 'medium' }),
    brain: Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' }),
    supervisor: null
  }),
  deep: Object.freeze({
    memory: Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' }),
    brain: Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' }),
    supervisor: Object.freeze({ model: 'gpt-5.6-terra', effort: 'medium' })
  })
});

const SUPPORTED_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

const RELATIONSHIP_PATTERN = /答应|承诺|约定|说好|记得|忘(?:了|记)|唯一|最重要|占有|属于|关系|喜欢|爱(?:我|你|上)|分手|分开|不合适|不在乎|冷落|吃醋|以后|永远|骗(?:我|人)|以前说|你说过|我说过/u;
const STRONG_EMOTION_PATTERN = /失望|难过|伤心|生气|愤怒|害怕|恐惧|崩溃|痛苦|委屈|绝望|受伤|不安|焦虑|心寒|累了/u;
const CORRECTION_PATTERN = /不是这样|你记错|说反了|我没说|你说的|别弄错|纠正|更正/u;

function collectDeepReasons(text, recentMessages) {
  const reasons = [];
  if (RELATIONSHIP_PATTERN.test(text)) reasons.push('commitment_or_relationship');
  if (STRONG_EMOTION_PATTERN.test(text)) reasons.push('strong_emotion');
  if (CORRECTION_PATTERN.test(text)) reasons.push('memory_or_speaker_correction');
  if (text.length >= 240 || (text.match(/[？?]/g) || []).length >= 2) reasons.push('complex_content');
  if (recentMessages.some(message => message?.speakerAmbiguity || message?.factConflict)) {
    reasons.push('context_conflict');
  }
  return [...new Set(reasons)];
}

function collectStructuralDeepReasons(envelope) {
  const context = envelope?.context || {};
  const signals = context.routeSignals || {};
  const reasons = [];
  if (context.payment) reasons.push('payment_as_social_action');
  if (context.moment || context.targetMoment || context.rolePlan || context.occurrence) {
    reasons.push('structured_action');
  }
  if ((signals.relevantStanceIds || []).length || signals.stanceTransition) {
    reasons.push('stance_reconsideration');
  }
  if (signals.relationshipTest) reasons.push('relationship_test');
  if (signals.conflictOrRepair) reasons.push('conflict_or_repair');
  if (signals.jealousyOrAffection) reasons.push('jealousy_or_affection');
  if (signals.userCorrection) reasons.push('user_correction');
  if (signals.multiplePlausibleMeanings) reasons.push('multiple_plausible_meanings');
  if (signals.relationshipChange) reasons.push('relationship_change');
  return reasons;
}

export function selectTurnRoute({ envelope, recentMessages = [] }) {
  if (!envelope || typeof envelope !== 'object') throw new Error('envelope is required');
  if (envelope.kind && envelope.kind !== 'DIRECT_REPLY') {
    return { route: 'deep', reasons: ['automatic_task'] };
  }
  const currentBatch = resolveCurrentUserBatch(envelope, recentMessages);
  const text = String(currentBatch?.combinedText || envelope.message?.content || '').trim();
  const reasons = [
    ...collectDeepReasons(text, recentMessages),
    ...collectStructuralDeepReasons(envelope)
  ];
  if (currentBatch && !currentBatch.complete) reasons.push('incomplete_current_batch');
  return { route: reasons.length ? 'deep' : 'fast', reasons: [...new Set(reasons)] };
}

export function roleExecutionProfile(route, role, configuredProfiles = DEFAULT_PROFILES) {
  if (!['fast', 'deep'].includes(route)) throw new Error('invalid route');
  if (!['memory', 'brain', 'supervisor'].includes(role)) throw new Error('invalid role');
  const profile = configuredProfiles?.[route]?.[role];
  if (profile === null && route === 'fast' && role === 'supervisor') return null;
  if (!profile?.model || typeof profile.effort !== 'string'
    || !SUPPORTED_REASONING_EFFORTS.has(profile.effort)) {
    throw new Error('invalid role execution profile');
  }
  return { model: String(profile.model), effort: profile.effort };
}

export { DEFAULT_PROFILES };
