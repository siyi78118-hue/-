(function attachAppStateRecovery(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ALAppStateRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAppStateRecovery() {
  'use strict';

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function utf8Bytes(value) {
    const text = String(value ?? '');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).byteLength;
    if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
    return unescape(encodeURIComponent(text)).length;
  }

  function parseSlot(raw) {
    if (raw === null || raw === undefined) return { status: 'absent' };
    try {
      return { status: 'valid', value: JSON.parse(raw), rawBytes: utf8Bytes(raw) };
    } catch {
      return { status: 'invalid', rawBytes: utf8Bytes(raw) };
    }
  }

  function readStorageSlot(storage, primaryKey, legacyKey) {
    const primaryRaw = storage?.getItem?.(primaryKey) ?? null;
    const primary = parseSlot(primaryRaw);
    if (primary.status === 'valid') {
      return { ...primary, source: 'primary', errorCode: '' };
    }

    const legacyRaw = legacyKey ? (storage?.getItem?.(legacyKey) ?? null) : null;
    const legacy = parseSlot(legacyRaw);
    if (legacy.status === 'valid') {
      return {
        ...legacy,
        source: 'legacy',
        errorCode: primary.status === 'invalid' ? 'PRIMARY_JSON_INVALID' : ''
      };
    }

    if (primary.status === 'invalid') {
      return {
        status: 'invalid',
        source: 'primary',
        value: undefined,
        rawBytes: primary.rawBytes,
        errorCode: 'PRIMARY_JSON_INVALID'
      };
    }
    if (legacy.status === 'invalid') {
      return {
        status: 'invalid',
        source: 'legacy',
        value: undefined,
        rawBytes: legacy.rawBytes,
        errorCode: 'LEGACY_JSON_INVALID'
      };
    }
    return { status: 'absent', source: '', value: undefined, rawBytes: 0, errorCode: '' };
  }

  function hasRoles(state) {
    return Array.isArray(state?.characters) && state.characters.some(role =>
      role && typeof role === 'object' && typeof role.id === 'string' && role.id.length > 0
    );
  }

  function decision(mode, frozen, source, reasonCode) {
    return { mode, frozen, source, reasonCode };
  }

  function decideRecovery({ local = {}, mirror = {}, native = {} } = {}) {
    if (local.invalidCritical === true) {
      if (hasRoles(mirror)) return decision('restore_mirror', true, 'mirror', 'LOCAL_STATE_INVALID');
      if (Number(native.roleCount) > 0) return decision('native_candidate', true, 'native', 'LOCAL_STATE_INVALID');
      return decision('diagnostic_only', true, '', 'LOCAL_STATE_INVALID');
    }
    if (hasRoles(local)) {
      if (local.source === 'legacy') {
        return decision('restore_legacy', true, 'legacy', 'PRIMARY_ROLE_DIRECTORY_INVALID');
      }
      return decision('normal', false, 'local', '');
    }
    if (hasRoles(mirror)) return decision('restore_mirror', true, 'mirror', 'LOCAL_ROLE_DIRECTORY_EMPTY');
    if (Number(native.roleCount) > 0) {
      return decision('native_candidate', true, 'native', 'WEB_ROLE_DIRECTORY_MISSING');
    }
    if (native.unavailable === true) {
      return decision('diagnostic_only', true, '', 'NATIVE_RECOVERY_CENSUS_UNAVAILABLE');
    }
    return decision('normal', false, 'local', '');
  }

  function identityRows(candidateRows, currentRows, identity) {
    const rows = new Map();
    for (const row of [...(Array.isArray(candidateRows) ? candidateRows : []),
      ...(Array.isArray(currentRows) ? currentRows : [])]) {
      if (!row || typeof row !== 'object') continue;
      const key = identity(row);
      if (!key) continue;
      rows.set(key, clone(row));
    }
    return [...rows.values()];
  }

  function mergeRecoveryState(current = {}, candidate = {}) {
    const currentChats = current.allChats && typeof current.allChats === 'object' ? current.allChats : {};
    const candidateChats = candidate.allChats && typeof candidate.allChats === 'object' ? candidate.allChats : {};
    const allChats = {};
    const characterIds = new Set([...Object.keys(candidateChats), ...Object.keys(currentChats)]);
    for (const characterId of characterIds) {
      const candidateChat = candidateChats[characterId] && typeof candidateChats[characterId] === 'object'
        ? candidateChats[characterId] : {};
      const currentChat = currentChats[characterId] && typeof currentChats[characterId] === 'object'
        ? currentChats[characterId] : {};
      allChats[characterId] = {
        ...clone(candidateChat),
        ...clone(currentChat),
        messages: identityRows(candidateChat.messages, currentChat.messages, row => String(row.id || ''))
      };
    }

    return {
      ...clone(candidate),
      ...clone(current),
      characters: identityRows(candidate.characters, current.characters, row => String(row.id || '')),
      allChats,
      allMoments: identityRows(candidate.allMoments, current.allMoments, row => String(row.id || '')),
      updatedAt: Math.max(Number(candidate.updatedAt) || 0, Number(current.updatedAt) || 0)
    };
  }

  function createWriteGuard() {
    let decisionState = decision('pending', true, '', 'APP_STATE_RECOVERY_FROZEN');
    let recoveryChecksum = '';
    return {
      get frozen() { return decisionState.frozen === true; },
      get reasonCode() { return decisionState.reasonCode || ''; },
      get recoveryChecksum() { return recoveryChecksum; },
      get decision() { return clone(decisionState); },
      assertWritable(scope = 'state') {
        if (!this.frozen) return true;
        throw new Error(`APP_STATE_RECOVERY_FROZEN:${this.reasonCode || 'PENDING'}:${scope}`);
      },
      applyDecision(nextDecision) {
        if (!nextDecision || typeof nextDecision !== 'object') {
          throw new Error('APP_STATE_RECOVERY_DECISION_INVALID');
        }
        decisionState = decision(
          String(nextDecision.mode || ''),
          nextDecision.frozen === true,
          String(nextDecision.source || ''),
          String(nextDecision.reasonCode || '')
        );
        return this.decision;
      },
      unlockAfterVerifiedRecovery(checksum) {
        if (typeof checksum !== 'string' || !checksum) {
          throw new Error('APP_STATE_RECOVERY_CHECKSUM_REQUIRED');
        }
        recoveryChecksum = checksum;
        decisionState = decision('recovered', false, decisionState.source, '');
        return this.decision;
      }
    };
  }

  return Object.freeze({
    readStorageSlot,
    decideRecovery,
    mergeRecoveryState,
    createWriteGuard
  });
});

