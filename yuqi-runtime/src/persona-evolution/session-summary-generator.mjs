const OUTPUT_KEYS = Object.freeze(['keyEvents', 'emotionalSummary', 'importantDecisions']);
import {
  SESSION_SUMMARY_OUTPUT_SCHEMA,
  SESSION_SUMMARY_SYSTEM_INSTRUCTION
} from './session-summary-prompt.mjs';

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function textArray(value, label) {
  if (!Array.isArray(value) || value.length > 512) throw new Error(`${label} must be a summary string array`);
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 32768) {
      throw new Error(`${label}[${index}] must be a summary string`);
    }
  });
}

export function validateSessionSummaryOutput(value) {
  exactKeys(value, OUTPUT_KEYS, 'session summary output');
  textArray(value.keyEvents, 'session summary keyEvents');
  exactKeys(value.emotionalSummary, ['user', 'al', 'interaction'], 'session summary emotionalSummary');
  for (const key of ['user', 'al', 'interaction']) {
    const item = value.emotionalSummary[key];
    if (item !== null && (typeof item !== 'string' || !item.trim() || item.length > 32768)) {
      throw new Error(`session summary emotionalSummary.${key} is invalid`);
    }
  }
  textArray(value.importantDecisions, 'session summary importantDecisions');
  return structuredClone(value);
}

export class SessionSummaryGenerator {
  constructor({ generate, model = 'unknown' } = {}) {
    if (typeof generate !== 'function') throw new Error('session summary generate function is required');
    this.generateImpl = generate;
    this.model = String(model || 'unknown');
  }

  async generate(input, options = {}) {
    return validateSessionSummaryOutput(await this.generateImpl(structuredClone(input), options));
  }
}

export class CodexSessionSummaryGenerator {
  constructor({
    codexClient,
    model = 'gpt-5.6-sol',
    effort = 'medium',
    turnTimeoutMs = 120_000
  } = {}) {
    if (!codexClient?.runIsolatedTurn) throw new Error('isolated Codex client is required');
    if (typeof model !== 'string' || !model.trim()) throw new Error('session summary model is required');
    if (typeof effort !== 'string' || !effort.trim()) throw new Error('session summary effort is required');
    if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 1) throw new Error('session summary timeout is invalid');
    this.codexClient = codexClient;
    this.model = model;
    this.effort = effort;
    this.turnTimeoutMs = turnTimeoutMs;
  }

  async generate(input) {
    const result = await this.codexClient.runIsolatedTurn({
      instruction: SESSION_SUMMARY_SYSTEM_INSTRUCTION,
      session: structuredClone(input)
    }, {
      model: this.model,
      effort: this.effort,
      turnTimeoutMs: this.turnTimeoutMs,
      outputSchema: SESSION_SUMMARY_OUTPUT_SCHEMA
    });
    let parsed;
    try {
      parsed = JSON.parse(String(result?.text || ''));
    } catch (error) {
      throw new Error('session summary model returned invalid JSON', { cause: error });
    }
    return validateSessionSummaryOutput(parsed);
  }
}
