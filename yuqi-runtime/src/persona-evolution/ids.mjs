import { randomUUID } from 'node:crypto';

import { PersonaValidationError } from './errors.mjs';

export const ENTITY_ID_PREFIXES = Object.freeze({
  personality_state: 'ps',
  memory: 'mem',
  session_summary: 'sum',
  experience_interpretation: 'exp',
  change_proposal: 'prop'
});

export function defaultPersonaIdFactory(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function createEntityId(entityType, idFactory = defaultPersonaIdFactory) {
  const prefix = ENTITY_ID_PREFIXES[entityType];
  if (!prefix) throw new PersonaValidationError(`unsupported persona entity type: ${entityType}`);
  const id = idFactory(prefix);
  if (typeof id !== 'string' || !id.startsWith(`${prefix}_`) || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new PersonaValidationError(`invalid generated ${entityType} id`);
  }
  if (id.length > 240) throw new PersonaValidationError(`generated ${entityType} id is too long`);
  return id;
}

export function encodeRoleDirectoryKey(roleId) {
  if (typeof roleId !== 'string' || !roleId.trim()) {
    throw new PersonaValidationError('roleId must be a non-empty string');
  }
  if (roleId.length > 512) throw new PersonaValidationError('roleId is too long');
  return `role_${Buffer.from(roleId, 'utf8').toString('base64url')}`;
}
