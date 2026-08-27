export const PERSONA_SCHEMA_VERSION = 1;

export const ENTITY_TYPES = Object.freeze({
  PERSONALITY_STATE: 'personality_state',
  MEMORY: 'memory',
  SESSION_SUMMARY: 'session_summary',
  EXPERIENCE_INTERPRETATION: 'experience_interpretation',
  CHANGE_PROPOSAL: 'change_proposal'
});

export const MEMORY_KINDS = Object.freeze([
  'user_fact',
  'self_fact',
  'relationship',
  'event',
  'commitment',
  'preference',
  'interpretation'
]);

export const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'redacted', 'expired']);
export const TENDENCY_STATUSES = Object.freeze(['tentative', 'established', 'contested']);
export const PROPOSAL_OUTCOMES = Object.freeze(['change', 'hold', 'reinforce']);
export const PROPOSAL_STATUSES = Object.freeze(['pending', 'accepted', 'rejected']);
export const SOURCE_REF_TYPES = Object.freeze([
  'message',
  'session',
  'session_summary',
  'memory',
  'experience_interpretation',
  'change_proposal',
  'manual'
]);

export const COMMON_ENTITY_KEYS = Object.freeze([
  'id', 'entityType', 'schemaVersion', 'roleId', 'createdAt', 'updatedAt', 'revision'
]);

export const ENTITY_PAYLOAD_KEYS = Object.freeze({
  personality_state: ['selfDescription', 'tendencies', 'tensions'],
  memory: ['kind', 'content', 'confidence', 'status', 'sourceRefs', 'supersedesId', 'supersededById'],
  session_summary: ['sourceSessionRef', 'startedAt', 'endedAt', 'summary', 'keyEvents', 'sourceRefs'],
  experience_interpretation: ['sessionSummaryId', 'meaning', 'selfImpact', 'hypotheses', 'sourceRefs'],
  change_proposal: [
    'interpretationIds', 'outcome', 'rationale', 'proposedChanges',
    'status', 'decisionNote', 'decidedAt'
  ]
});
