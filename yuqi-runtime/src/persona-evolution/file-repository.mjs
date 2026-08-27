import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  PersonaDataCorruptionError,
  PersonaDuplicateEntityError,
  PersonaNotFoundError,
  PersonaRevisionConflictError,
  PersonaValidationError
} from './errors.mjs';
import { createEntityId, defaultPersonaIdFactory, encodeRoleDirectoryKey } from './ids.mjs';
import { PersonaEvolutionRepository } from './repository.mjs';
import { ENTITY_TYPES, MEMORY_KINDS, MEMORY_STATUSES, PERSONA_SCHEMA_VERSION, PROPOSAL_OUTCOMES } from './schemas.mjs';
import {
  validateChangeProposalInput,
  validateAutomaticSessionSummaryInput,
  validateEntityId,
  validateExpectedRevision,
  validateExperienceInterpretationInput,
  validateListOptions,
  validateMemoryInput,
  validatePersistedEntity,
  validatePersonalityStateInput,
  validateProposalStatusUpdate,
  validateRoleId,
  validateSessionSummaryInput
} from './validation.mjs';

const COLLECTIONS = Object.freeze({
  memory: 'memories',
  session_summary: 'session_summaries',
  experience_interpretation: 'interpretations',
  change_proposal: 'proposals'
});

function clone(value) {
  return structuredClone(value);
}

function normalizeNow(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PersonaValidationError('repository clock returned an invalid time');
  return date.toISOString();
}

export class FilePersonaEvolutionRepository extends PersonaEvolutionRepository {
  constructor({ rootDir, now = () => new Date(), idFactory = defaultPersonaIdFactory } = {}) {
    super();
    if (typeof rootDir !== 'string' || !rootDir.trim()) throw new PersonaValidationError('rootDir is required');
    if (typeof now !== 'function') throw new PersonaValidationError('now must be a function');
    if (typeof idFactory !== 'function') throw new PersonaValidationError('idFactory must be a function');
    this.rootDir = resolve(rootDir);
    this.now = now;
    this.idFactory = idFactory;
    this.sessionSummaryOperations = new Map();
  }

  #inside(path) {
    const absolute = resolve(path);
    const rel = relative(this.rootDir, absolute);
    if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) return absolute;
    throw new PersonaValidationError('persona path escapes rootDir');
  }

  #roleDir(roleId) {
    validateRoleId(roleId);
    return this.#inside(join(this.rootDir, encodeRoleDirectoryKey(roleId)));
  }

  #entityPath(roleId, entityType, id = null) {
    const roleDir = this.#roleDir(roleId);
    if (entityType === ENTITY_TYPES.PERSONALITY_STATE) return this.#inside(join(roleDir, 'personality_state.json'));
    validateEntityId(entityType, id);
    return this.#inside(join(roleDir, COLLECTIONS[entityType], `${id}.json`));
  }

  #collectionDir(roleId, entityType) {
    return this.#inside(join(this.#roleDir(roleId), COLLECTIONS[entityType]));
  }

  #entity(entityType, roleId, input) {
    const now = normalizeNow(this.now);
    return {
      id: createEntityId(entityType, this.idFactory),
      entityType,
      schemaVersion: PERSONA_SCHEMA_VERSION,
      roleId,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      ...clone(input)
    };
  }

  async #atomicCreate(path, entity) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(entity, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      try {
        await link(temporary, path);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new PersonaDuplicateEntityError(`persona entity already exists: ${entity.id}`);
        throw error;
      }
    } finally {
      await unlink(temporary).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async #atomicReplace(path, entity) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(entity, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(error => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async #read(path, entityType, roleId) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const entity = JSON.parse(raw);
      validatePersistedEntity(entity, entityType);
      if (entity.roleId !== roleId) throw new PersonaValidationError('persisted roleId does not match directory');
      return clone(entity);
    } catch (error) {
      if (error instanceof PersonaDataCorruptionError) throw error;
      throw new PersonaDataCorruptionError(`corrupt ${entityType} data at ${path}`, { cause: error });
    }
  }

  async #list(roleId, entityType, options = {}, allowedFilters = []) {
    validateRoleId(roleId);
    validateListOptions(options, allowedFilters);
    let names;
    try {
      names = await readdir(this.#collectionDir(roleId, entityType));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const entities = [];
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      const id = name.slice(0, -5);
      let path;
      try {
        path = this.#entityPath(roleId, entityType, id);
      } catch (error) {
        throw new PersonaDataCorruptionError(`unexpected ${entityType} collection entry: ${name}`, { cause: error });
      }
      const entity = await this.#read(path, entityType, roleId);
      if (entity) entities.push(entity);
    }
    entities.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const filtered = entities.filter(entity => allowedFilters.every(key =>
      !Object.hasOwn(options, key) || entity[key] === options[key]
    ));
    return clone(Object.hasOwn(options, 'limit') ? filtered.slice(0, options.limit) : filtered);
  }

  async getPersonalityState(roleId) {
    return this.#read(this.#entityPath(roleId, ENTITY_TYPES.PERSONALITY_STATE), ENTITY_TYPES.PERSONALITY_STATE, roleId);
  }

  async createPersonalityState(roleId, input) {
    validateRoleId(roleId);
    validatePersonalityStateInput(input);
    const entity = this.#entity(ENTITY_TYPES.PERSONALITY_STATE, roleId, input);
    validatePersistedEntity(entity, ENTITY_TYPES.PERSONALITY_STATE);
    await this.#atomicCreate(this.#entityPath(roleId, ENTITY_TYPES.PERSONALITY_STATE), entity);
    return clone(entity);
  }

  async updatePersonalityState(roleId, input, { expectedRevision } = {}) {
    validateRoleId(roleId);
    validatePersonalityStateInput(input);
    validateExpectedRevision(expectedRevision);
    const path = this.#entityPath(roleId, ENTITY_TYPES.PERSONALITY_STATE);
    const current = await this.#read(path, ENTITY_TYPES.PERSONALITY_STATE, roleId);
    if (!current) throw new PersonaNotFoundError('personality state does not exist');
    if (current.revision !== expectedRevision) throw new PersonaRevisionConflictError('personality state revision conflict');
    const updated = {
      ...current,
      ...clone(input),
      updatedAt: normalizeNow(this.now),
      revision: current.revision + 1
    };
    validatePersistedEntity(updated, ENTITY_TYPES.PERSONALITY_STATE);
    await this.#atomicReplace(path, updated);
    return clone(updated);
  }

  async createMemory(roleId, input) {
    validateRoleId(roleId);
    validateMemoryInput(input);
    const entity = this.#entity(ENTITY_TYPES.MEMORY, roleId, input);
    validatePersistedEntity(entity, ENTITY_TYPES.MEMORY);
    await this.#atomicCreate(this.#entityPath(roleId, ENTITY_TYPES.MEMORY, entity.id), entity);
    return clone(entity);
  }

  async getMemory(roleId, memoryId) {
    return this.#read(this.#entityPath(roleId, ENTITY_TYPES.MEMORY, memoryId), ENTITY_TYPES.MEMORY, roleId);
  }

  async listMemories(roleId, options = {}) {
    if (Object.hasOwn(options, 'kind') && !MEMORY_KINDS.includes(options.kind)) throw new PersonaValidationError('memory kind filter is invalid');
    if (Object.hasOwn(options, 'status') && !MEMORY_STATUSES.includes(options.status)) throw new PersonaValidationError('memory status filter is invalid');
    return this.#list(roleId, ENTITY_TYPES.MEMORY, options, ['kind', 'status']);
  }

  async createSessionSummary(roleId, input) {
    validateRoleId(roleId);
    validateSessionSummaryInput(input);
    const entity = this.#entity(ENTITY_TYPES.SESSION_SUMMARY, roleId, input);
    validatePersistedEntity(entity, ENTITY_TYPES.SESSION_SUMMARY);
    await this.#atomicCreate(this.#entityPath(roleId, ENTITY_TYPES.SESSION_SUMMARY, entity.id), entity);
    return clone(entity);
  }

  async getSessionSummary(roleId, summaryId) {
    return this.#read(this.#entityPath(roleId, ENTITY_TYPES.SESSION_SUMMARY, summaryId), ENTITY_TYPES.SESSION_SUMMARY, roleId);
  }

  async getSessionSummaryBySourceSessionId(roleId, sourceSessionId) {
    validateRoleId(roleId);
    if (typeof sourceSessionId !== 'string' || !/^ses_[a-f0-9]{64}$/.test(sourceSessionId)) {
      throw new PersonaValidationError('sourceSessionId has an invalid identity');
    }
    const matches = (await this.listSessionSummaries(roleId)).filter(
      entity => entity.sourceSessionId === sourceSessionId
    );
    if (matches.length > 1) throw new PersonaDataCorruptionError('duplicate automatic session summaries');
    return matches[0] || null;
  }

  async putSessionSummaryForSession(roleId, input) {
    validateRoleId(roleId);
    validateAutomaticSessionSummaryInput(input);
    const key = `${roleId}\0${input.sourceSessionId}`;
    const before = this.sessionSummaryOperations.get(key) || Promise.resolve();
    const current = before.catch(() => {}).then(async () => {
      const existing = await this.getSessionSummaryBySourceSessionId(roleId, input.sourceSessionId);
      if (!existing) {
        const entity = this.#entity(ENTITY_TYPES.SESSION_SUMMARY, roleId, input);
        validatePersistedEntity(entity, ENTITY_TYPES.SESSION_SUMMARY);
        await this.#atomicCreate(this.#entityPath(roleId, ENTITY_TYPES.SESSION_SUMMARY, entity.id), entity);
        return { status: 'created', entity: clone(entity) };
      }
      if (existing.sourceDigest === input.sourceDigest) {
        return { status: 'unchanged', entity: clone(existing) };
      }
      const updated = {
        ...existing,
        ...clone(input),
        updatedAt: normalizeNow(this.now),
        revision: existing.revision + 1
      };
      validatePersistedEntity(updated, ENTITY_TYPES.SESSION_SUMMARY);
      await this.#atomicReplace(
        this.#entityPath(roleId, ENTITY_TYPES.SESSION_SUMMARY, existing.id),
        updated
      );
      return { status: 'updated', entity: clone(updated) };
    });
    const tail = current.finally(() => {
      if (this.sessionSummaryOperations.get(key) === tail) this.sessionSummaryOperations.delete(key);
    });
    this.sessionSummaryOperations.set(key, tail);
    return current;
  }

  async listSessionSummaries(roleId, options = {}) {
    return this.#list(roleId, ENTITY_TYPES.SESSION_SUMMARY, options);
  }

  async createExperienceInterpretation(roleId, input) {
    validateRoleId(roleId);
    validateExperienceInterpretationInput(input);
    if (!await this.getSessionSummary(roleId, input.sessionSummaryId)) {
      throw new PersonaValidationError('sessionSummaryId does not reference this role');
    }
    const entity = this.#entity(ENTITY_TYPES.EXPERIENCE_INTERPRETATION, roleId, input);
    validatePersistedEntity(entity, ENTITY_TYPES.EXPERIENCE_INTERPRETATION);
    await this.#atomicCreate(this.#entityPath(roleId, ENTITY_TYPES.EXPERIENCE_INTERPRETATION, entity.id), entity);
    return clone(entity);
  }

  async getExperienceInterpretation(roleId, interpretationId) {
    return this.#read(this.#entityPath(roleId, ENTITY_TYPES.EXPERIENCE_INTERPRETATION, interpretationId), ENTITY_TYPES.EXPERIENCE_INTERPRETATION, roleId);
  }

  async listExperienceInterpretations(roleId, options = {}) {
    return this.#list(roleId, ENTITY_TYPES.EXPERIENCE_INTERPRETATION, options);
  }

  async createChangeProposal(roleId, input) {
    validateRoleId(roleId);
    validateChangeProposalInput(input);
    for (const interpretationId of input.interpretationIds) {
      if (!await this.getExperienceInterpretation(roleId, interpretationId)) {
        throw new PersonaValidationError('interpretationIds must reference this role');
      }
    }
    const entity = this.#entity(ENTITY_TYPES.CHANGE_PROPOSAL, roleId, {
      ...input,
      status: 'pending',
      decisionNote: null,
      decidedAt: null
    });
    validatePersistedEntity(entity, ENTITY_TYPES.CHANGE_PROPOSAL);
    await this.#atomicCreate(this.#entityPath(roleId, ENTITY_TYPES.CHANGE_PROPOSAL, entity.id), entity);
    return clone(entity);
  }

  async getChangeProposal(roleId, proposalId) {
    return this.#read(this.#entityPath(roleId, ENTITY_TYPES.CHANGE_PROPOSAL, proposalId), ENTITY_TYPES.CHANGE_PROPOSAL, roleId);
  }

  async listChangeProposals(roleId, options = {}) {
    if (Object.hasOwn(options, 'status') && !['pending', 'accepted', 'rejected'].includes(options.status)) {
      throw new PersonaValidationError('proposal status filter is invalid');
    }
    if (Object.hasOwn(options, 'outcome') && !PROPOSAL_OUTCOMES.includes(options.outcome)) {
      throw new PersonaValidationError('proposal outcome filter is invalid');
    }
    return this.#list(roleId, ENTITY_TYPES.CHANGE_PROPOSAL, options, ['status', 'outcome']);
  }

  async updateChangeProposalStatus(roleId, proposalId, input) {
    validateRoleId(roleId);
    validateProposalStatusUpdate(input);
    const path = this.#entityPath(roleId, ENTITY_TYPES.CHANGE_PROPOSAL, proposalId);
    const current = await this.#read(path, ENTITY_TYPES.CHANGE_PROPOSAL, roleId);
    if (!current) throw new PersonaNotFoundError('change proposal does not exist');
    if (current.revision !== input.expectedRevision) throw new PersonaRevisionConflictError('change proposal revision conflict');
    if (current.status !== 'pending') throw new PersonaValidationError('change proposal is already terminal');
    const now = normalizeNow(this.now);
    const updated = {
      ...current,
      status: input.status,
      decisionNote: input.decisionNote,
      decidedAt: now,
      updatedAt: now,
      revision: current.revision + 1
    };
    validatePersistedEntity(updated, ENTITY_TYPES.CHANGE_PROPOSAL);
    await this.#atomicReplace(path, updated);
    return clone(updated);
  }
}
