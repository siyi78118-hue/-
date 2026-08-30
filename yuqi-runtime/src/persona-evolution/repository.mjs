/**
 * Storage boundary for experimental persona evolution data.
 *
 * Getters return null when one requested entity is absent. List methods are
 * role-scoped and return createdAt ASC, then id ASC. Implementations may use a
 * different backend, but must preserve these semantics, optimistic revisions,
 * validation failures, and proposal-state behavior.
 */
export class PersonaEvolutionRepository {
  async getPersonalityState(_roleId) { throw new Error('not implemented'); }
  async createPersonalityState(_roleId, _input) { throw new Error('not implemented'); }
  async updatePersonalityState(_roleId, _input, _options) { throw new Error('not implemented'); }
  async createMemory(_roleId, _input) { throw new Error('not implemented'); }
  async getMemory(_roleId, _memoryId) { throw new Error('not implemented'); }
  async listMemories(_roleId, _options) { throw new Error('not implemented'); }
  async createSessionSummary(_roleId, _input) { throw new Error('not implemented'); }
  async getSessionSummary(_roleId, _summaryId) { throw new Error('not implemented'); }
  async getSessionSummaryBySourceSessionId(_roleId, _sourceSessionId) { throw new Error('not implemented'); }
  async putSessionSummaryForSession(_roleId, _input) { throw new Error('not implemented'); }
  async listSessionSummaries(_roleId, _options) { throw new Error('not implemented'); }
  async createExperienceInterpretation(_roleId, _input) { throw new Error('not implemented'); }
  async getExperienceInterpretation(_roleId, _interpretationId) { throw new Error('not implemented'); }
  async listExperienceInterpretations(_roleId, _options) { throw new Error('not implemented'); }
  async getExperienceInterpretationBySessionSummary(_roleId, _sessionSummaryId) { throw new Error('not implemented'); }
  async putExperienceInterpretationForSessionSummary(_roleId, _input) { throw new Error('not implemented'); }
  async createChangeProposal(_roleId, _input) { throw new Error('not implemented'); }
  async getChangeProposal(_roleId, _proposalId) { throw new Error('not implemented'); }
  async listChangeProposals(_roleId, _options) { throw new Error('not implemented'); }
  async updateChangeProposalStatus(_roleId, _proposalId, _input) { throw new Error('not implemented'); }
}
