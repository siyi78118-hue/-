(function attachCompleteAppRestoration(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ALCompleteAppRestoration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCompleteAppRestoration() {
  'use strict';

  const CONFIRMED_DELETION_ID = 'char_1783694247588_zojx';
  const ROLE_FIELDS = Object.freeze([
    'id', 'name', 'avatar', 'avatarData', 'profileVersion', 'description', 'personality',
    'scenario', 'firstMessage', 'mesExample', 'systemPrompt', 'postHistoryInstructions',
    'tags', 'creatorNotes', 'createdAt', 'stagePersona', 'stagePersonaConfig'
  ]);

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }

  function meaningful(value) {
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  function roleFrom(state, roleId) {
    return (Array.isArray(state?.characters) ? state.characters : [])
      .find(row => row && String(row.id || '') === roleId) || null;
  }

  function validAvatarData(value) {
    if (typeof value !== 'string') return false;
    const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return false;
    const payload = match[2];
    if (payload.length % 4 !== 0) return false;
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
    return ((payload.length * 3) / 4) - padding <= 20 * 1024 * 1024;
  }

  function mergeRoleByField(roleId, sources, fallback) {
    const rows = sources.map(source => roleFrom(source, roleId)).filter(Boolean);
    if (fallback && String(fallback.id || '') === roleId) rows.push(fallback);
    const result = { id: roleId };
    for (const field of ROLE_FIELDS) {
      if (field === 'id') continue;
      for (const row of rows) {
        if (!meaningful(row[field])) continue;
        if (field === 'avatarData' && !validAvatarData(row[field])) continue;
        result[field] = clone(row[field]);
        break;
      }
    }
    if (!result.name) result.name = roleId === 'yuqi' ? '虞栖' : roleId;
    if (!result.avatar) result.avatar = result.name.slice(0, 1) || 'R';
    if (!validAvatarData(result.avatarData)) result.avatarData = null;
    for (const field of ['description', 'personality', 'scenario', 'firstMessage', 'mesExample',
      'systemPrompt', 'postHistoryInstructions', 'creatorNotes']) {
      if (result[field] === undefined) result[field] = '';
    }
    if (!Array.isArray(result.tags)) result.tags = [];
    return result;
  }

  function messageRows(state, roleId) {
    const messages = state?.allChats?.[roleId]?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  function mergeMessages(sourcesLowToHigh) {
    const rows = new Map();
    for (const source of sourcesLowToHigh) {
      for (const raw of Array.isArray(source) ? source : []) {
        if (!raw || typeof raw !== 'object') continue;
        const id = String(raw.id || raw.messageId || '');
        if (!id) continue;
        rows.set(id, { ...clone(raw), id });
      }
    }
    return [...rows.values()].sort((left, right) =>
      Number(left.time || left.sentAt || 0) - Number(right.time || right.sentAt || 0)
      || String(left.id).localeCompare(String(right.id)));
  }

  function verifiedNativeMoments(native) {
    return (Array.isArray(native?.momentEvidence) ? native.momentEvidence : [])
      .filter(row => row && row.verified === true && typeof row.id === 'string' && row.id);
  }

  function mergeIdentityRows(sources) {
    const rows = new Map();
    for (const source of sources) {
      for (const row of Array.isArray(source) ? source : []) {
        if (!row || typeof row !== 'object' || !row.id) continue;
        rows.set(String(row.id), clone(row));
      }
    }
    return [...rows.values()];
  }

  function assertDeletionTargets(values) {
    if (!Array.isArray(values)) throw new Error('APP_RESTORATION_DELETION_TARGET_CONFLICT');
    const unique = [...new Set(values.map(value => String(value || '')))].filter(Boolean);
    if (unique.some(value => value !== CONFIRMED_DELETION_ID)) {
      throw new Error('APP_RESTORATION_DELETION_TARGET_CONFLICT');
    }
    return unique;
  }

  async function buildPlan({
    current = {}, recoveryBefore = {}, legacy = {}, mirror = {}, native = {},
    builtinYuqi = {}, deletionTargets = []
  } = {}) {
    const excludedRoleIds = assertDeletionTargets(deletionTargets);
    const roleSources = [current, recoveryBefore, legacy, mirror];
    const yuqi = mergeRoleByField('yuqi', roleSources, builtinYuqi);
    const nativeMessages = (Array.isArray(native.messages) ? native.messages : []).map(row => ({
      ...clone(row),
      id: String(row?.id || row?.messageId || ''),
      role: row?.role || (row?.speakerType === 'user' ? 'user' : 'assistant'),
      time: Number(row?.time || row?.sentAt || 0)
    }));
    const messages = mergeMessages([
      messageRows(mirror, 'yuqi'),
      messageRows(legacy, 'yuqi'),
      messageRows(recoveryBefore, 'yuqi'),
      nativeMessages,
      messageRows(current, 'yuqi')
    ]);
    const moments = mergeIdentityRows([
      mirror.allMoments, legacy.allMoments, recoveryBefore.allMoments,
      verifiedNativeMoments(native), current.allMoments
    ]);
    const unconfirmedEmptyRoleIds = (Array.isArray(native.roles) ? native.roles : [])
      .filter(row => row && Number(row.rawMessageCount) === 0
        && !excludedRoleIds.includes(String(row.characterId || '')))
      .map(row => String(row.characterId || '')).filter(Boolean).sort();
    const avatar = yuqi.avatarData
      ? { status: roleFrom(current, 'yuqi')?.avatarData === yuqi.avatarData
        ? 'already_present' : 'restored' }
      : { status: 'no_verified_source', reasonCode: 'avatar_bytes_missing' };
    return deepFreeze({
      version: 1,
      excludedRoleIds,
      roles: { yuqi },
      chats: { yuqi: { messages } },
      moments,
      memories: (Array.isArray(native.memories) ? native.memories : []).filter(row => row?.verified === true),
      rolePlans: (Array.isArray(native.rolePlans) ? native.rolePlans : []).filter(row => row?.verified === true),
      report: {
        unconfirmedEmptyRoleIds,
        categories: { avatar }
      }
    });
  }

  function applyWebCandidate(current = {}, plan = {}) {
    const excluded = new Set(Array.isArray(plan.excludedRoleIds) ? plan.excludedRoleIds : []);
    const currentCharacters = (Array.isArray(current.characters) ? current.characters : [])
      .filter(row => row && !excluded.has(String(row.id || '')));
    const planCharacters = Object.values(plan.roles || {})
      .filter(row => row && !excluded.has(String(row.id || '')));
    const characters = new Map();
    for (const row of [...planCharacters, ...currentCharacters]) characters.set(String(row.id), clone(row));
    const currentMessages = messageRows(current, 'yuqi');
    const planMessages = plan?.chats?.yuqi?.messages || [];
    const allChats = { ...(clone(current.allChats || {})) };
    for (const roleId of excluded) delete allChats[roleId];
    allChats.yuqi = {
      ...(clone(plan?.chats?.yuqi || {})),
      ...(clone(current?.allChats?.yuqi || {})),
      messages: mergeMessages([planMessages, currentMessages])
    };
    return {
      ...clone(current),
      characters: [...characters.values()],
      allChats,
      allMoments: mergeIdentityRows([plan.moments, current.allMoments])
    };
  }

  return Object.freeze({
    buildPlan,
    applyWebCandidate,
    validAvatarData,
    CONFIRMED_DELETION_ID
  });
});
