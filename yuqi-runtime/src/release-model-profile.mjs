export const RELEASE_PROFILE_KEYS = Object.freeze([
  'cognitionFast',
  'cognitionDeep',
  'expression',
  'supervisor'
]);

export const RELEASE_REASONING_EFFORTS = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

export function parseReleaseModelProfile(modelProfile, label = 'release model profile') {
  if (!modelProfile || typeof modelProfile !== 'object' || Array.isArray(modelProfile)
    || Object.keys(modelProfile).sort().join(',') !== [...RELEASE_PROFILE_KEYS].sort().join(',')) {
    throw new Error(`${label} closed shape conflict`);
  }
  const parsed = {};
  for (const key of RELEASE_PROFILE_KEYS) {
    const value = modelProfile[key];
    if (typeof value !== 'string' || !value || value !== value.trim()) {
      throw new Error(`${label} ${key} conflict`);
    }
    const separator = value.lastIndexOf('/');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`${label} ${key} must be model/effort`);
    }
    const model = value.slice(0, separator);
    const effort = value.slice(separator + 1);
    if (!model || model !== model.trim() || !RELEASE_REASONING_EFFORTS.has(effort)) {
      throw new Error(`${label} ${key} effort conflict`);
    }
    parsed[key] = Object.freeze({ model, effort });
  }
  return Object.freeze(parsed);
}
