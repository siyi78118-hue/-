import { createHash } from 'node:crypto';

import { buildExperienceContext } from './experience-context-builder.mjs';
import { validateExperienceInterpretationOutput } from './experience-interpretation-generator.mjs';
import {
  EXPERIENCE_INTERPRETER_VERSION,
  EXPERIENCE_INTERPRETATION_PROMPT_VERSION
} from './experience-interpretation-prompt.mjs';

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export class ExperienceInterpreter {
  constructor({ repository, retriever, generator, memoryLimit = 8, logger = null } = {}) {
    if (!repository?.getSessionSummary || !repository?.getPersonalityState
      || !repository?.listMemories || !repository?.getExperienceInterpretationBySessionSummary
      || !repository?.putExperienceInterpretationForSessionSummary) {
      throw new Error('experience interpretation repository is required');
    }
    if (!retriever?.retrieve) throw new Error('experience memory retriever is required');
    if (!generator?.generate) throw new Error('experience interpretation generator is required');
    if (!Number.isSafeInteger(memoryLimit) || memoryLimit < 0 || memoryLimit > 100) {
      throw new Error('experience interpretation memoryLimit is invalid');
    }
    this.repository = repository;
    this.retriever = retriever;
    this.generator = generator;
    this.memoryLimit = memoryLimit;
    this.logger = logger;
    this.inFlight = new Map();
  }

  interpretSession({ roleId, sessionSummaryId, force = false } = {}) {
    const key = `${roleId || ''}\0${sessionSummaryId || ''}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const operation = this.#interpret({ roleId, sessionSummaryId, force }).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  async #interpret({ roleId, sessionSummaryId, force }) {
    const started = Date.now();
    const fields = { roleId, summaryId: sessionSummaryId };
    const sessionSummary = await this.repository.getSessionSummary(roleId, sessionSummaryId);
    if (!sessionSummary || !Object.hasOwn(sessionSummary, 'sourceDigest')) {
      throw new Error('automatic session summary was not found for experience interpretation');
    }
    const existing = await this.repository.getExperienceInterpretationBySessionSummary(roleId, sessionSummaryId);
    if (!force && existing?.context?.summaryRevision === sessionSummary.revision
      && existing.context.summarySourceDigest === sessionSummary.sourceDigest) {
      this.logger?.({
        event: 'experience_interpretation_skipped_existing', ...fields,
        interpretationId: existing.id, durationMs: Date.now() - started
      });
      return {
        status: 'unchanged', interpretationId: existing.id, revision: existing.revision,
        impactLevel: existing.impact.level,
        recommendProposal: existing.nextStage.recommendProposal
      };
    }
    this.logger?.({ event: 'experience_interpretation_started', ...fields, durationMs: 0 });
    try {
      const personalityState = await this.repository.getPersonalityState(roleId);
      const memories = await this.repository.listMemories(roleId, { status: 'active' });
      const relevantMemories = this.retriever.retrieve({
        roleId, sessionSummary, memories, limit: this.memoryLimit
      });
      const context = buildExperienceContext({ sessionSummary, personalityState, relevantMemories });
      const generated = validateExperienceInterpretationOutput(
        await this.generator.generate(structuredClone(context)),
        { allowedMemoryIds: relevantMemories.map(memory => memory.id) }
      );
      const memoryById = new Map(relevantMemories.map(memory => [memory.id, memory]));
      const selectedRefs = relevantMemories.map(memory => ({ id: memory.id, revision: memory.revision }));
      const inputDigest = digest({
        sessionSummaryId,
        summaryRevision: sessionSummary.revision,
        summarySourceDigest: sessionSummary.sourceDigest,
        personalityRevision: personalityState?.revision ?? null,
        memoryRefs: selectedRefs,
        promptVersion: EXPERIENCE_INTERPRETATION_PROMPT_VERSION,
        interpreterVersion: EXPERIENCE_INTERPRETER_VERSION
      });
      const stored = await this.repository.putExperienceInterpretationForSessionSummary(roleId, {
        sessionSummaryId,
        meaning: generated.meaning,
        selfImpact: generated.selfImpact,
        hypotheses: generated.hypotheses,
        impact: generated.impact,
        nextStage: generated.nextStage,
        sourceRefs: [
          { type: 'session_summary', id: sessionSummaryId },
          ...generated.memoryRefsUsed.map(id => ({ type: 'memory', id: memoryById.get(id).id }))
        ],
        inputDigest,
        context: {
          summaryRevision: sessionSummary.revision,
          summarySourceDigest: sessionSummary.sourceDigest,
          personalityRevision: personalityState?.revision ?? null,
          memoryRefs: selectedRefs
        },
        generation: {
          interpreterVersion: EXPERIENCE_INTERPRETER_VERSION,
          promptVersion: EXPERIENCE_INTERPRETATION_PROMPT_VERSION,
          model: String(this.generator.model || 'unknown')
        }
      });
      const entity = stored.entity;
      this.logger?.({
        event: stored.status === 'updated'
          ? 'experience_interpretation_regenerated'
          : stored.status === 'unchanged'
            ? 'experience_interpretation_skipped_existing'
            : 'experience_interpretation_completed',
        ...fields,
        interpretationId: entity.id,
        memoryCount: relevantMemories.length,
        impactLevel: entity.impact.level,
        recommendProposal: entity.nextStage.recommendProposal,
        durationMs: Date.now() - started
      });
      return {
        status: stored.status,
        interpretationId: entity.id,
        revision: entity.revision,
        impactLevel: entity.impact.level,
        recommendProposal: entity.nextStage.recommendProposal
      };
    } catch (error) {
      this.logger?.({
        event: 'experience_interpretation_failed', ...fields,
        durationMs: Date.now() - started, error: error?.name || 'Error'
      });
      throw error;
    }
  }
}
