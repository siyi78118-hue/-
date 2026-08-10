import { canonicalJson, contentHash } from './protocol.mjs';

export const LIFE_CONTEXT_AUTHORITY_VERSION = 2;

const SEMANTIC_KEYS = Object.freeze([
  'contextAuthorityVersion',
  'cognitiveState',
  'allowedActions',
  'current',
  'recent',
  'upcoming'
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectReference(reference) {
  if (reference === null) return null;
  if (!isObject(reference)) throw new Error('life planning context authority conflict: reference');
  const projected = {};
  for (const key of Object.keys(reference).sort()) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    projected[key] = reference[key];
  }
  return projected;
}

export function projectLifePlanningContext(snapshot) {
  if (!isObject(snapshot)) throw new Error('life planning context authority conflict: snapshot');
  const projected = {
    contextAuthorityVersion: LIFE_CONTEXT_AUTHORITY_VERSION,
    cognitiveState: snapshot.cognitiveState ?? {},
    allowedActions: snapshot.allowedActions ?? [],
    current: projectReference(snapshot.current ?? null),
    recent: Array.isArray(snapshot.recent) ? snapshot.recent.map(projectReference) : [],
    upcoming: Array.isArray(snapshot.upcoming) ? snapshot.upcoming.map(projectReference) : []
  };
  return JSON.parse(canonicalJson(projected));
}

export const projectLifePlanningContextV2 = projectLifePlanningContext;

export function lifePlanningContextChecksum(snapshot) {
  if (Object.hasOwn(snapshot || {}, 'contextAuthorityVersion')) {
    assertLifePlanningContextAuthority(snapshot);
  }
  return contentHash(projectLifePlanningContext(snapshot));
}

export const computeLifePlanningContextChecksum = lifePlanningContextChecksum;

export function lifePlanningRequestBaseKey({
  roleId, startAt, endAt, lifeBasisChecksum, contextChecksum
}) {
  return contentHash({ roleId, startAt, endAt, lifeBasisChecksum, contextChecksum });
}

export function assertLifePlanningContextAuthority(snapshot) {
  if (!isObject(snapshot)
    || snapshot.contextAuthorityVersion !== LIFE_CONTEXT_AUTHORITY_VERSION
    || !Number.isSafeInteger(snapshot.contextAuthorityVersion)) {
    throw new Error('life planning context authority version conflict');
  }
  if (!isObject(snapshot.cognitiveState)
    || !Array.isArray(snapshot.allowedActions)
    || !('current' in snapshot)
    || !Array.isArray(snapshot.recent)
    || !Array.isArray(snapshot.upcoming)) {
    throw new Error('life planning context authority conflict: semantic projection');
  }
  for (const [name, value] of [
    ['current', snapshot.current],
    ...snapshot.recent.map((value, index) => [`recent[${index}]`, value]),
    ...snapshot.upcoming.map((value, index) => [`upcoming[${index}]`, value])
  ]) {
    if (value !== null && !isObject(value)) {
      throw new Error(`life planning context authority conflict: ${name}`);
    }
  }
  projectLifePlanningContext(snapshot);
  return snapshot;
}

export const assertLifePlanningContextV2 = assertLifePlanningContextAuthority;

export function isLegacyLifePlanningContext(snapshot) {
  return isObject(snapshot) && !Object.hasOwn(snapshot, 'contextAuthorityVersion');
}

export function isLifePlanningContextV2(snapshot) {
  return isObject(snapshot) && snapshot.contextAuthorityVersion === LIFE_CONTEXT_AUTHORITY_VERSION;
}

export { SEMANTIC_KEYS };
