function stringArray() {
  return { type: 'array', items: { type: 'string' } };
}

function objectSchema(properties, required) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
}

function nullable(type) {
  return { anyOf: [{ type }, { type: 'null' }] };
}

const quoteSchema = objectSchema({
  messageId: { type: 'string' },
  speakerId: { type: 'string' },
  text: { type: 'string' }
}, ['messageId', 'speakerId', 'text']);

const factCandidateSchema = objectSchema({
  factId: { type: 'string' },
  characterId: { type: 'string' },
  subjectId: { type: 'string' },
  predicate: { type: 'string' },
  object: objectSchema({
    summary: { type: 'string' },
    detailsJson: { type: 'string' }
  }, ['summary', 'detailsJson']),
  evidenceMode: { type: 'string' },
  sourceMessageIds: stringArray(),
  exactQuotes: { type: 'array', items: quoteSchema },
  type: nullable('string'),
  promisedBy: nullable('string'),
  promisedTo: nullable('string'),
  confidence: nullable('number'),
  supersedes: nullable('string'),
  origin: nullable('string'),
  createdAt: nullable('integer'),
  verifiedAt: nullable('integer')
}, [
  'factId', 'characterId', 'subjectId', 'predicate', 'object', 'evidenceMode',
  'sourceMessageIds', 'exactQuotes', 'type', 'promisedBy', 'promisedTo', 'confidence',
  'supersedes', 'origin', 'createdAt', 'verifiedAt'
]);

const relationshipStageReviewSchema = {
  anyOf: [objectSchema({
    current: { type: 'string' },
    recommended: { type: 'string' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    evidenceMessageIds: stringArray(),
    explicitMutualChange: { type: 'boolean' }
  }, ['current', 'recommended', 'confidence', 'reason', 'evidenceMessageIds', 'explicitMutualChange']), { type: 'null' }]
};

const conversationFrameSchema = objectSchema({
  surfaceAct: { type: 'string' },
  intentHypotheses: {
    type: 'array',
    items: objectSchema({
      intent: { type: 'string' },
      confidence: { type: 'number' },
      evidenceMessageIds: stringArray()
    }, ['intent', 'confidence', 'evidenceMessageIds'])
  },
  interactionMode: { type: 'string' },
  emotionalTone: { type: 'string' },
  relationshipMove: { type: 'string' },
  initiative: objectSchema({
    topicIntroducedBy: { type: 'string' },
    suggestedNextCarrier: { type: 'string' },
    reason: { type: 'string' }
  }, ['topicIntroducedBy', 'suggestedNextCarrier', 'reason']),
  priorTopic: objectSchema({
    status: { type: 'string', enum: ['closed', 'open', 'uncertain'] },
    summary: { type: 'string' },
    waitingOn: { type: 'string', enum: ['user', 'yuqi', 'either', 'none', 'unclear'] },
    evidenceMessageIds: stringArray(),
    reason: { type: 'string' }
  }, ['status', 'summary', 'waitingOn', 'evidenceMessageIds', 'reason']),
  interruption: objectSchema({
    requiresReaction: { type: 'boolean' },
    reactionReason: { type: 'string' }
  }, ['requiresReaction', 'reactionReason']),
  activeHooks: stringArray(),
  ambiguities: stringArray(),
  responseRisks: stringArray(),
  needsNuanceReview: { type: 'boolean' }
}, [
  'surfaceAct', 'intentHypotheses', 'interactionMode', 'emotionalTone', 'relationshipMove',
  'initiative', 'priorTopic', 'interruption', 'activeHooks', 'ambiguities', 'responseRisks',
  'needsNuanceReview'
]);

export const ROLE_OUTPUT_SCHEMAS = Object.freeze({
  memory: objectSchema({
    query: { type: 'string' },
    keywords: stringArray(),
    candidates: {
      type: 'array',
      items: factCandidateSchema
    },
    requiresDeepMemory: { type: 'boolean' },
    escalationReasons: stringArray(),
    speakerAmbiguity: { type: 'boolean' },
    commitmentRisk: { type: 'boolean' },
    relationshipStageReview: relationshipStageReviewSchema,
    conversationFrame: conversationFrameSchema
  }, [
    'query', 'keywords', 'candidates', 'requiresDeepMemory', 'escalationReasons',
    'speakerAmbiguity', 'commitmentRisk', 'relationshipStageReview', 'conversationFrame'
  ]),
  brain: objectSchema({
    action: { type: 'string', enum: ['send', 'skip'] },
    reply: { type: 'string' },
    paymentAction: { anyOf: [
      { type: 'string', enum: ['received', 'refused', 'pending'] },
      { type: 'null' }
    ] },
    usedFactIds: stringArray(),
    momentAction: { anyOf: [objectSchema({
      momentId: { type: 'string' },
      like: { type: 'boolean' },
      comment: { type: 'string' },
      replyToCommentId: nullable('string')
    }, ['momentId', 'like', 'comment', 'replyToCommentId']), { type: 'null' }] }
  }, ['action', 'reply', 'paymentAction', 'usedFactIds', 'momentAction']),
  supervisor: objectSchema({
    decision: { type: 'string', enum: ['approve', 'rewrite', 'skip', 'reject'] },
    issues: {
      type: 'array',
      items: objectSchema({
        code: { type: 'string' },
        message: { type: 'string' }
      }, ['code', 'message'])
    }
  }, ['decision', 'issues'])
});
