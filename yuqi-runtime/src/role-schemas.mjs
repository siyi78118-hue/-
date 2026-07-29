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
  'explicitBoundaries', 'recentCorrection', 'needsNuanceReview'
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

const cognitionRelationshipReviewSchema = objectSchema({
  base: { anyOf: [baseRelationshipReviewSchema, { type: 'null' }] },
  phase: { anyOf: [phaseRelationshipReviewSchema, { type: 'null' }] }
}, ['base', 'phase']);

const selfStateSchema = objectSchema({
  mood: { type: 'string' },
  moodCause: { type: 'string' },
  bodyState: { type: 'string' },
  attention: { type: 'string' },
  stanceTowardUser: { type: 'string' },
  ownNeed: { type: 'string' },
  continuity: { type: 'string' },
  intensity: { type: 'number' }
}, [
  'mood',
  'moodCause',
  'bodyState',
  'attention',
  'stanceTowardUser',
  'ownNeed',
  'continuity',
  'intensity'
]);

const cognitionDecisionSchema = objectSchema({
  shouldRespond: { type: 'boolean' },
  silenceReason: { type: 'string' },
  relationshipGoal: { type: 'string' },
  primaryAction: { type: 'string' },
  initiativeOwner: { type: 'string' },
  mustAddress: stringArray(),
  forbiddenMoves: stringArray(),
  preserveAmbiguity: { type: 'boolean' },
  evidenceMessageIds: stringArray()
}, [
  'shouldRespond',
  'silenceReason',
  'relationshipGoal',
  'primaryAction',
  'initiativeOwner',
  'mustAddress',
  'forbiddenMoves',
  'preserveAmbiguity',
  'evidenceMessageIds'
]);

const cognitionPaymentActionSchema = objectSchema({
  action: { type: 'string', enum: ['received', 'refused', 'pending'] },
  messageId: { type: 'string' },
  kind: { type: 'string', enum: ['redpacket', 'transfer'] },
  amount: { type: 'number' }
}, ['action', 'messageId', 'kind', 'amount']);

const cognitionMomentIntentSchema = objectSchema({
  momentId: { type: 'string' },
  like: { type: 'boolean' },
  comment: { type: 'string' },
  replyToCommentId: nullable('string')
}, ['momentId', 'like', 'comment', 'replyToCommentId']);

const lifeEpisodeSchema = objectSchema({
  episodeId: { type: 'string' },
  kind: { type: 'string' },
  title: { type: 'string' },
  startAt: { type: 'number' },
  endAt: { type: 'number' }
}, ['episodeId', 'kind', 'title', 'startAt', 'endAt']);

const cognitionLifePlanSchema = objectSchema({
  planKey: { type: 'string' },
  episodes: { type: 'array', items: lifeEpisodeSchema }
}, ['planKey', 'episodes']);

const cognitionLifeAdjustmentSchema = objectSchema({
  type: { type: 'string', enum: ['none', 'reschedule', 'shorten', 'extend', 'cancel'] },
  targetEpisodeId: { type: 'string' },
  startAt: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  endAt: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  reason: { type: 'string' }
}, ['type', 'targetEpisodeId', 'startAt', 'endAt', 'reason']);

const cognitionActionIntentSchema = objectSchema({
  channel: { type: 'string', enum: ['chat', 'moment', 'private', 'none'] },
  paymentAction: { anyOf: [cognitionPaymentActionSchema, { type: 'null' }] },
  momentIntent: { anyOf: [cognitionMomentIntentSchema, { type: 'null' }] },
  rolePlanOperationsJson: { type: 'string' },
  lifePlan: { anyOf: [cognitionLifePlanSchema, { type: 'null' }] },
  lifeAdjustment: { anyOf: [cognitionLifeAdjustmentSchema, { type: 'null' }] }
}, [
  'channel',
  'paymentAction',
  'momentIntent',
  'rolePlanOperationsJson',
  'lifePlan',
  'lifeAdjustment'
]);

export const COGNITION_SCHEMA_V2 = objectSchema({
  schemaVersion: { type: 'integer', enum: [2] },
  query: { type: 'string' },
  keywords: stringArray(),
  requiresDeepCognition: { type: 'boolean' },
  escalationReasons: stringArray(),
  relationshipStageReview: cognitionRelationshipReviewSchema,
  conversationFrame: conversationFrameSchema,
  selfState: selfStateSchema,
  decision: cognitionDecisionSchema,
  actionIntent: cognitionActionIntentSchema
}, [
  'schemaVersion',
  'query',
  'keywords',
  'requiresDeepCognition',
  'escalationReasons',
  'relationshipStageReview',
  'conversationFrame',
  'selfState',
  'decision',
  'actionIntent'
]);

export const EXPRESSION_SCHEMA_V2 = objectSchema({
  action: { type: 'string', enum: ['send', 'skip'] },
  reply: { type: 'string' },
  usedFactIds: stringArray(),
  rewriteResolution: { anyOf: [rewriteResolutionSchema, { type: 'null' }] }
}, ['action', 'reply', 'usedFactIds', 'rewriteResolution']);

export const CONSOLIDATION_SCHEMA_V2 = objectSchema({
  schemaVersion: { type: 'integer', enum: [2] },
  query: { type: 'string' },
  keywords: stringArray(),
  candidates: { type: 'array', items: factCandidateSchema },
  conflicts: {
    type: 'array',
    items: objectSchema({
      factId: { type: 'string' },
      conflictsWithFactId: { type: 'string' },
      evidenceMessageIds: stringArray(),
      reason: { type: 'string' }
    }, ['factId', 'conflictsWithFactId', 'evidenceMessageIds', 'reason'])
  },
  supersessions: {
    type: 'array',
    items: objectSchema({
      oldFactId: { type: 'string' },
      newFactId: { type: 'string' },
      evidenceMessageIds: stringArray(),
      reason: { type: 'string' }
    }, ['oldFactId', 'newFactId', 'evidenceMessageIds', 'reason'])
  }
}, ['schemaVersion', 'query', 'keywords', 'candidates', 'conflicts', 'supersessions']);

export const LIFE_PLANNING_SCHEMA_V2 = objectSchema({
  schemaVersion: { type: 'integer', enum: [2] },
  planKey: { type: 'string' },
  episodes: { type: 'array', items: lifeEpisodeSchema },
  cognitiveStatePatch: objectSchema({
    bodyState: { type: 'string' },
    attention: { type: 'string' },
    ownNeed: { type: 'string' }
  }, ['bodyState', 'attention', 'ownNeed'])
}, ['schemaVersion', 'planKey', 'episodes', 'cognitiveStatePatch']);

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
