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

const baseRelationshipReviewSchema = objectSchema({
    current: { type: 'string' },
    recommended: { type: 'string' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    evidenceMessageIds: stringArray(),
    explicitMutualChange: { type: 'boolean' }
  }, ['current', 'recommended', 'confidence', 'reason', 'evidenceMessageIds', 'explicitMutualChange']);

const phaseRelationshipReviewSchema = objectSchema({
  current: { type: 'string' },
  recommended: { type: 'string' },
  confidence: { type: 'number' },
  reason: { type: 'string' },
  evidenceMessageIds: stringArray(),
  explicitAcknowledgedChange: { type: 'boolean' }
}, ['current', 'recommended', 'confidence', 'reason', 'evidenceMessageIds', 'explicitAcknowledgedChange']);

const relationshipStageReviewSchema = {
  anyOf: [objectSchema({
    base: { anyOf: [baseRelationshipReviewSchema, { type: 'null' }] },
    phase: { anyOf: [phaseRelationshipReviewSchema, { type: 'null' }] }
  }, ['base', 'phase']), { type: 'null' }]
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
  explicitBoundaries: {
    type: 'array',
    items: objectSchema({
      type: { type: 'string' },
      active: { type: 'boolean' },
      reason: { type: 'string' },
      evidenceMessageIds: stringArray()
    }, ['type', 'active', 'reason', 'evidenceMessageIds'])
  },
  recentCorrection: objectSchema({
    active: { type: 'boolean' },
    rejectedInterpretation: { type: 'string' },
    expiresAfterBatches: { type: 'integer' },
    evidenceMessageIds: stringArray()
  }, ['active', 'rejectedInterpretation', 'expiresAfterBatches', 'evidenceMessageIds']),
  needsNuanceReview: { type: 'boolean' }
}, [
  'surfaceAct', 'intentHypotheses', 'interactionMode', 'emotionalTone', 'relationshipMove',
  'initiative', 'priorTopic', 'interruption', 'activeHooks', 'ambiguities', 'responseRisks',
  'needsNuanceReview'
]);

const rewriteResolutionSchema = objectSchema({
  resolvedIssueIds: stringArray(),
  resolutionNotes: {
    type: 'array',
    items: objectSchema({
      issueId: { type: 'string' },
      strategy: { type: 'string' },
      result: { type: 'string' }
    }, ['issueId', 'strategy', 'result'])
  },
  formedCharacterFacts: {
    type: 'array',
    items: objectSchema({
      predicate: {
        type: 'string',
        enum: [
          'currently_reading',
          'current_meal',
          'current_activity',
          'minor_preference',
          'minor_encounter',
          'daily_detail'
        ]
      },
      summary: { type: 'string' },
      detailsJson: { type: 'string' },
      evidenceQuote: { type: 'string' }
    }, ['predicate', 'summary', 'detailsJson', 'evidenceQuote'])
  }
}, ['resolvedIssueIds', 'resolutionNotes', 'formedCharacterFacts']);

const supervisorIssueSchema = objectSchema({
  issueId: { type: 'string' },
  code: { type: 'string' },
  severity: { type: 'string', enum: ['hard', 'soft'] },
  message: { type: 'string' },
  mustPreserve: stringArray(),
  mustChange: stringArray(),
  allowedStrategies: stringArray(),
  acceptanceCriteria: stringArray()
}, [
  'issueId',
  'code',
  'severity',
  'message',
  'mustPreserve',
  'mustChange',
  'allowedStrategies',
  'acceptanceCriteria'
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
    }, ['momentId', 'like', 'comment', 'replyToCommentId']), { type: 'null' }] },
    lifePlan: { anyOf: [objectSchema({
      planKey: { type: 'string' },
      episodes: {
        type: 'array',
        items: objectSchema({
          episodeId: { type: 'string' },
          kind: { type: 'string' },
          title: { type: 'string' },
          startAt: { type: 'number' },
          endAt: { type: 'number' }
        }, ['episodeId', 'kind', 'title', 'startAt', 'endAt'])
      }
    }, ['planKey', 'episodes']), { type: 'null' }] },
    lifeAdjustment: { anyOf: [objectSchema({
      type: { type: 'string', enum: ['none', 'reschedule', 'shorten', 'extend', 'cancel'] },
      targetEpisodeId: { type: 'string' },
      startAt: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      endAt: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      reason: { type: 'string' }
    }, ['type', 'targetEpisodeId', 'startAt', 'endAt', 'reason']), { type: 'null' }] },
    rolePlanOperationsJson: { type: 'string' },
    rewriteResolution: {
      anyOf: [rewriteResolutionSchema, { type: 'null' }]
    }
  }, [
    'action', 'reply', 'paymentAction', 'usedFactIds', 'momentAction', 'lifePlan', 'lifeAdjustment',
    'rolePlanOperationsJson', 'rewriteResolution'
  ]),
  supervisor: objectSchema({
    decision: { type: 'string', enum: ['approve', 'rewrite', 'skip', 'reject'] },
    reviewedIssueIds: stringArray(),
    resolvedIssueIds: stringArray(),
    issues: {
      type: 'array',
      items: supervisorIssueSchema
    }
  }, ['decision', 'reviewedIssueIds', 'resolvedIssueIds', 'issues'])
});
