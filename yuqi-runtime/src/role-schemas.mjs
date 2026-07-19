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
    commitmentRisk: { type: 'boolean' }
  }, [
    'query', 'keywords', 'candidates', 'requiresDeepMemory', 'escalationReasons',
    'speakerAmbiguity', 'commitmentRisk'
  ]),
  brain: objectSchema({
    reply: { type: 'string', minLength: 1 },
    usedFactIds: stringArray()
  }, ['reply', 'usedFactIds']),
  supervisor: objectSchema({
    approved: { type: 'boolean' },
    issues: {
      type: 'array',
      items: objectSchema({
        code: { type: 'string' },
        message: { type: 'string' }
      }, ['code', 'message'])
    }
  }, ['approved', 'issues'])
});
