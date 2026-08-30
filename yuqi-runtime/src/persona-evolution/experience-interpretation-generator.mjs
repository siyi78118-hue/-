import {
  EXPERIENCE_INTERPRETATION_OUTPUT_SCHEMA,
  EXPERIENCE_INTERPRETATION_SYSTEM_INSTRUCTION
} from './experience-interpretation-prompt.mjs';

const OUTPUT_KEYS = Object.freeze([
  'meaning', 'selfImpact', 'hypotheses', 'impact', 'nextStage', 'memoryRefsUsed'
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 32768) {
    throw new Error(`${label} must be experience interpretation text`);
  }
}

export function validateExperienceInterpretationOutput(value, { allowedMemoryIds = [] } = {}) {
  exactKeys(value, OUTPUT_KEYS, 'experience interpretation output');
  text(value.meaning, 'experience interpretation meaning');
  text(value.selfImpact, 'experience interpretation selfImpact');
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length > 5) {
    throw new Error('experience interpretation hypotheses are invalid');
  }
  value.hypotheses.forEach((item, index) => {
    exactKeys(item, ['statement', 'confidence'], `experience interpretation hypotheses[${index}]`);
    text(item.statement, `experience interpretation hypotheses[${index}].statement`);
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`experience interpretation hypotheses[${index}].confidence is invalid`);
    }
  });
  exactKeys(value.impact, ['level', 'rationale'], 'experience interpretation impact');
  if (!['none', 'low', 'medium', 'high'].includes(value.impact.level)) {
    throw new Error('experience interpretation impact.level is invalid');
  }
  text(value.impact.rationale, 'experience interpretation impact.rationale');
  exactKeys(value.nextStage, ['recommendProposal', 'rationale'], 'experience interpretation nextStage');
  if (typeof value.nextStage.recommendProposal !== 'boolean') {
    throw new Error('experience interpretation nextStage.recommendProposal must be a boolean');
  }
  text(value.nextStage.rationale, 'experience interpretation nextStage.rationale');
  if (!Array.isArray(value.memoryRefsUsed)
    || value.memoryRefsUsed.some(id => typeof id !== 'string' || !/^mem_[A-Za-z0-9_-]+$/.test(id))
    || new Set(value.memoryRefsUsed).size !== value.memoryRefsUsed.length) {
    throw new Error('experience interpretation memoryRefsUsed are invalid');
  }
  const allowed = new Set(allowedMemoryIds);
  if (value.memoryRefsUsed.some(id => !allowed.has(id))) {
    throw new Error('experience interpretation memory reference was not provided');
  }
  return structuredClone(value);
}

export class ExperienceInterpretationGenerator {
  async generate(_input) {
    throw new Error('not implemented');
  }
}

export class CodexExperienceInterpretationGenerator extends ExperienceInterpretationGenerator {
  constructor({ codexClient, model = 'gpt-5.6-sol', effort = 'medium', turnTimeoutMs = 120_000 } = {}) {
    super();
    if (!codexClient?.runIsolatedTurn) throw new Error('isolated Codex client is required');
    if (typeof model !== 'string' || !model.trim()) throw new Error('experience interpretation model is required');
    if (typeof effort !== 'string' || !effort.trim()) throw new Error('experience interpretation effort is required');
    if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1) throw new Error('experience interpretation timeout is invalid');
    this.codexClient = codexClient;
    this.model = model;
    this.effort = effort;
    this.turnTimeoutMs = turnTimeoutMs;
  }

  async generate(input) {
    const result = await this.codexClient.runIsolatedTurn({
      instruction: EXPERIENCE_INTERPRETATION_SYSTEM_INSTRUCTION,
      context: structuredClone(input)
    }, {
      model: this.model,
      effort: this.effort,
      turnTimeoutMs: this.turnTimeoutMs,
      outputSchema: EXPERIENCE_INTERPRETATION_OUTPUT_SCHEMA
    });
    let parsed;
    try {
      parsed = JSON.parse(String(result?.text || ''));
    } catch (error) {
      throw new Error('experience interpretation model returned invalid JSON', { cause: error });
    }
    return validateExperienceInterpretationOutput(parsed, {
      allowedMemoryIds: input.relevantMemories.map(memory => memory.id)
    });
  }
}
