export const SESSION_SUMMARIZER_VERSION = '0.1.0';
export const SESSION_SUMMARY_PROMPT_VERSION = '0.1.0';

export const SESSION_SUMMARY_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['keyEvents', 'emotionalSummary', 'importantDecisions'],
  properties: {
    keyEvents: { type: 'array', items: { type: 'string' } },
    emotionalSummary: {
      type: 'object', additionalProperties: false,
      required: ['user', 'al', 'interaction'],
      properties: {
        user: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        al: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        interaction: { anyOf: [{ type: 'string' }, { type: 'null' }] }
      }
    },
    importantDecisions: { type: 'array', items: { type: 'string' } }
  }
});

export const SESSION_SUMMARY_SYSTEM_INSTRUCTION = [
  'Summarize only the visible events in the supplied A.L. conversation session.',
  'Do not invent facts, motives, emotions, decisions, advice, evaluation, personality interpretations, or hidden reasoning.',
  'Use null when an emotion cannot be grounded. Record a decision only when the visible conversation explicitly made it.',
  'Return only the required JSON object. Never add topic, category, identifiers, timestamps, model metadata, or prose outside JSON.'
].join('\n');
