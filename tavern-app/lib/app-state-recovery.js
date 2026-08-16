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

  function safeCount(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  }

  function sanitizeNativeCensus(native = {}) {
    if (!native || typeof native !== 'object') return { unavailable: true };
    if (native.unavailable === true) return { unavailable: true };
    if (!Array.isArray(native.roles)) {
      return {
        roleCount: safeCount(native.roleCount),
        roles: [],
        databaseBytes: safeCount(native.databaseBytes),
        walBytes: safeCount(native.walBytes),
        shmBytes: safeCount(native.shmBytes),
        conflict: false
      };
    }
    const roles = [];
    const seen = new Map();
    let conflict = false;
    for (const raw of native.roles) {
      if (!raw || typeof raw !== 'object' || raw.tombstoned === true) continue;
      const characterId = typeof raw.characterId === 'string' ? raw.characterId.trim() : '';
      if (!characterId) {
        conflict = true;
        continue;
      }
      const sourceChecksum = typeof raw.sourceChecksum === 'string' ? raw.sourceChecksum : '';
      if (seen.has(characterId)) {
        const prior = seen.get(characterId);
        if (!sourceChecksum || !prior || sourceChecksum !== prior) conflict = true;
        else conflict = true;
        continue;
      }
      seen.set(characterId, sourceChecksum);
      roles.push({
        characterId,
        displayName: typeof raw.displayName === 'string' && raw.displayName
          ? raw.displayName : characterId,
        latestSnapshotAt: safeCount(raw.latestSnapshotAt),
        turnCount: safeCount(raw.turnCount),
        rawMessageCount: safeCount(raw.rawMessageCount),
        replyPartCount: safeCount(raw.replyPartCount),
        memoryCount: safeCount(raw.memoryCount),
        rolePlanCount: safeCount(raw.rolePlanCount),
        candidateAvailable: raw.candidateAvailable === true,
        ...(sourceChecksum ? { sourceChecksum } : {})
      });
    }
    roles.sort((left, right) => left.characterId.localeCompare(right.characterId));
    return {
      roleCount: roles.length,
      roles,
      databaseBytes: safeCount(native.databaseBytes),
      walBytes: safeCount(native.walBytes),
      shmBytes: safeCount(native.shmBytes),
      conflict
    };
  }

  function buildRecoveryScreenModel(recoveryDecision = {}) {
    const native = sanitizeNativeCensus(recoveryDecision.native || {});
    const sourceNames = {
      native: '手机原生数据库',
      mirror: '手机网页镜像',
      legacy: '旧版网页存储'
    };
    let roles;
    if (recoveryDecision.source === 'native') {
      roles = native.roles.map(role => ({
        characterId: role.characterId,
        displayName: role.displayName,
        rawMessageCount: role.rawMessageCount
      }));
    } else {
      const sourceState = recoveryDecision.source === 'mirror'
        ? recoveryDecision.mirror : recoveryDecision.local;
      const sourceChats = sourceState?.allChats && typeof sourceState.allChats === 'object'
        ? sourceState.allChats : {};
      roles = (Array.isArray(sourceState?.characters) ? sourceState.characters : [])
        .filter(role => role && typeof role.id === 'string' && role.id)
        .map(role => ({
          characterId: role.id,
          displayName: typeof role.name === 'string' && role.name ? role.name : role.id,
          rawMessageCount: Array.isArray(sourceChats[role.id]?.messages)
            ? sourceChats[role.id].messages.length : 0
        }));
    }
    return {
      mode: String(recoveryDecision.mode || 'diagnostic_only'),
      reasonCode: String(recoveryDecision.reasonCode || 'UNKNOWN'),
      source: String(recoveryDecision.source || ''),
      sourceName: sourceNames[recoveryDecision.source] || '仅诊断',
      roleCount: roles.length,
      databaseBytes: native.databaseBytes || 0,
      walBytes: native.walBytes || 0,
      shmBytes: native.shmBytes || 0,
      roles
    };
  }

  function decideRecovery({ local = {}, mirror = {}, native = {} } = {}) {
    const verifiedNative = sanitizeNativeCensus(native);
    if (verifiedNative.conflict === true) {
      return decision('diagnostic_only', true, '', 'NATIVE_RECOVERY_CENSUS_CONFLICT');
    }
    native = verifiedNative;
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

  function canonicalJson(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object') {
      return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('APP_STATE_RECOVERY_CANONICAL_NUMBER_INVALID');
      return JSON.stringify(value);
    }
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    throw new Error('APP_STATE_RECOVERY_CANONICAL_VALUE_INVALID');
  }

  async function sha256CanonicalJson(value) {
    const text = canonicalJson(value);
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    if (typeof require === 'function') {
      return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
    }
    throw new Error('APP_STATE_RECOVERY_SHA256_UNAVAILABLE');
  }

  const RECOVERY_RAW_KEYS = Object.freeze([
    'rpchat_settings',
    'rpchat_characters',
    'rpchat_chats',
    'rpchat_moments',
    'rpchat_app_state_updated_at'
  ]);

  function captureRecoveryRawState(storage) {
    const snapshot = {};
    for (const key of RECOVERY_RAW_KEYS) snapshot[key] = storage.getItem(key);
    return snapshot;
  }

  function restoreRecoveryRawState(storage, snapshot) {
    for (const key of RECOVERY_RAW_KEYS) {
      if (snapshot[key] === null || snapshot[key] === undefined) storage.removeItem(key);
      else storage.setItem(key, snapshot[key]);
    }
  }

  function recoverySemanticState(targetState = {}) {
    return {
      settings: clone(targetState.settings || {}),
      characters: clone(Array.isArray(targetState.characters) ? targetState.characters : []),
      allChats: clone(targetState.allChats && typeof targetState.allChats === 'object'
        ? targetState.allChats : {}),
      allMoments: clone(Array.isArray(targetState.allMoments) ? targetState.allMoments : []),
      updatedAt: safeCount(targetState.updatedAt)
    };
  }

  function readRecoverySemanticState(storage) {
    return recoverySemanticState({
      settings: JSON.parse(storage.getItem('rpchat_settings') || '{}'),
      characters: JSON.parse(storage.getItem('rpchat_characters') || '[]'),
      allChats: JSON.parse(storage.getItem('rpchat_chats') || '{}'),
      allMoments: JSON.parse(storage.getItem('rpchat_moments') || '[]'),
      updatedAt: Number(storage.getItem('rpchat_app_state_updated_at')) || 0
    });
  }

  function assertExactKeys(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
      throw new Error(`APP_STATE_RECOVERY_${label}_SHAPE_CONFLICT`);
    }
  }

  function requireRecoveryString(value, key, allowEmpty = false) {
    if (typeof value[key] !== 'string' || (!allowEmpty && !value[key])) {
      throw new Error(`APP_STATE_RECOVERY_${key.toUpperCase()}_TYPE_CONFLICT`);
    }
  }

  function requireRecoveryInteger(value, key) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`APP_STATE_RECOVERY_${key.toUpperCase()}_TYPE_CONFLICT`);
    }
  }

  async function verifyNativeRoleCandidate(candidate) {
    const keys = ['characterId', 'name', 'playerName', 'systemPrompt', 'createdAt',
      'sourceSnapshotId', 'sourceChecksum'];
    assertExactKeys(candidate, keys, 'ROLE_CANDIDATE');
    for (const key of ['characterId', 'sourceSnapshotId', 'sourceChecksum']) {
      requireRecoveryString(candidate, key);
    }
    for (const key of ['name', 'playerName', 'systemPrompt']) {
      requireRecoveryString(candidate, key, true);
    }
    requireRecoveryInteger(candidate, 'createdAt');
    if (!/^[0-9a-f]{64}$/.test(candidate.sourceChecksum)) {
      throw new Error('APP_STATE_RECOVERY_ROLE_CHECKSUM_CONFLICT');
    }
    const basis = clone(candidate);
    delete basis.sourceChecksum;
    if (await sha256CanonicalJson(basis) !== candidate.sourceChecksum) {
      throw new Error('APP_STATE_RECOVERY_ROLE_CHECKSUM_CONFLICT');
    }
    return clone(candidate);
  }

  async function verifyNativeRecoveryMessage(message) {
    const keys = ['messageId', 'turnId', 'characterId', 'speakerId', 'speakerType',
      'recipientId', 'content', 'sentAt', 'origin', 'deviceId', 'deviceSeq', 'sourceChecksum'];
    assertExactKeys(message, keys, 'MESSAGE_CANDIDATE');
    for (const key of ['messageId', 'turnId', 'characterId', 'speakerId', 'speakerType',
      'recipientId', 'origin', 'deviceId', 'sourceChecksum']) {
      requireRecoveryString(message, key);
    }
    requireRecoveryString(message, 'content', true);
    requireRecoveryInteger(message, 'sentAt');
    requireRecoveryInteger(message, 'deviceSeq');
    if (!/^[0-9a-f]{64}$/.test(message.sourceChecksum)) {
      throw new Error('APP_STATE_RECOVERY_MESSAGE_CHECKSUM_CONFLICT');
    }
    const basis = clone(message);
    delete basis.sourceChecksum;
    if (await sha256CanonicalJson(basis) !== message.sourceChecksum) {
      throw new Error('APP_STATE_RECOVERY_MESSAGE_CHECKSUM_CONFLICT');
    }
    return clone(message);
  }

  async function runRecoveryTransaction({
    storage,
    journal,
    writeMirror,
    readMirror,
    restoreMirror,
    unlock,
    source,
    reasonCode,
    targetState,
    now = Date.now(),
    faultAfter = 0
  } = {}) {
    if (!storage?.getItem || !storage?.setItem || !storage?.removeItem
      || !journal?.put || typeof writeMirror !== 'function' || typeof unlock !== 'function') {
      throw new Error('APP_STATE_RECOVERY_ADAPTER_INVALID');
    }
    const semantic = recoverySemanticState(targetState);
    const beforeRaw = captureRecoveryRawState(storage);
    const beforeMirror = typeof readMirror === 'function' ? await readMirror() : null;
    const beforeChecksum = await sha256CanonicalJson(beforeRaw);
    const beforeMirrorRecord = {
      version: 1,
      present: beforeMirror !== null && beforeMirror !== undefined,
      value: beforeMirror !== null && beforeMirror !== undefined ? clone(beforeMirror) : null
    };
    beforeMirrorRecord.checksum = await sha256CanonicalJson({
      present: beforeMirrorRecord.present,
      value: beforeMirrorRecord.value
    });
    const candidateChecksum = await sha256CanonicalJson(semantic);
    let record = {
      version: 1,
      state: 'prepared',
      source: String(source || ''),
      reasonCode: String(reasonCode || ''),
      beforeChecksum,
      candidateChecksum,
      preparedAt: safeCount(now),
      committedAt: null
    };
    let mirrorWritten = false;
    let unlocked = false;
    const fault = boundary => {
      if (Number(faultAfter) === boundary) throw new Error(`APP_STATE_RECOVERY_FAULT_${boundary}`);
    };
    try {
      await journal.put('recovery_before_v1', beforeRaw);
      await journal.put('recovery_before_mirror_v1', beforeMirrorRecord);
      await journal.put('recovery_candidate_v1', record);
      fault(1);

      storage.setItem('rpchat_settings', JSON.stringify(semantic.settings));
      storage.setItem('rpchat_characters', JSON.stringify(semantic.characters));
      fault(2);
      storage.setItem('rpchat_chats', JSON.stringify(semantic.allChats));
      fault(3);
      storage.setItem('rpchat_moments', JSON.stringify(semantic.allMoments));
      storage.setItem('rpchat_app_state_updated_at', String(semantic.updatedAt));
      fault(4);

      const verified = readRecoverySemanticState(storage);
      if (await sha256CanonicalJson(verified) !== candidateChecksum) {
        throw new Error('APP_STATE_RECOVERY_VERIFY_CONFLICT');
      }
      fault(5);

      await writeMirror(clone(semantic));
      mirrorWritten = true;
      fault(6);

      record = { ...record, state: 'committed', committedAt: safeCount(now) };
      await journal.put('recovery_candidate_v1', record);
      fault(7);

      unlock(candidateChecksum);
      unlocked = true;
      fault(8);
      return clone(record);
    } catch (error) {
      if (!unlocked) {
        restoreRecoveryRawState(storage, beforeRaw);
        if (mirrorWritten && typeof restoreMirror === 'function') {
          await restoreMirror(beforeMirror);
        }
        record = { ...record, state: 'rolled_back', committedAt: null };
        await journal.put('recovery_candidate_v1', record);
      }
      throw error;
    }
  }

  async function rollbackPreparedRecovery({ storage, journal, restoreMirror } = {}) {
    if (!storage?.getItem || !storage?.setItem || !storage?.removeItem
      || !journal?.get || !journal?.put) {
      throw new Error('APP_STATE_RECOVERY_ADAPTER_INVALID');
    }
    const record = await journal.get('recovery_candidate_v1');
    if (!record || record.state !== 'prepared') return false;
    assertExactKeys(record, [
      'version', 'state', 'source', 'reasonCode', 'beforeChecksum',
      'candidateChecksum', 'preparedAt', 'committedAt'
    ], 'JOURNAL');
    if (record.version !== 1 || record.committedAt !== null
      || !Number.isSafeInteger(record.preparedAt) || record.preparedAt < 0
      || typeof record.source !== 'string' || !record.source
      || typeof record.reasonCode !== 'string' || !record.reasonCode
      || !/^[0-9a-f]{64}$/.test(record.beforeChecksum)
      || !/^[0-9a-f]{64}$/.test(record.candidateChecksum)) {
      throw new Error('APP_STATE_RECOVERY_JOURNAL_CONFLICT');
    }
    const beforeRaw = await journal.get('recovery_before_v1');
    assertExactKeys(beforeRaw, RECOVERY_RAW_KEYS, 'BEFORE_SNAPSHOT');
    if (await sha256CanonicalJson(beforeRaw) !== record.beforeChecksum) {
      throw new Error('APP_STATE_RECOVERY_BEFORE_CHECKSUM_CONFLICT');
    }
    restoreRecoveryRawState(storage, beforeRaw);
    const beforeMirrorRecord = await journal.get('recovery_before_mirror_v1');
    if (beforeMirrorRecord !== null && typeof restoreMirror === 'function') {
      assertExactKeys(beforeMirrorRecord, ['version', 'present', 'value', 'checksum'], 'MIRROR_SNAPSHOT');
      if (beforeMirrorRecord.version !== 1 || typeof beforeMirrorRecord.present !== 'boolean'
        || !/^[0-9a-f]{64}$/.test(beforeMirrorRecord.checksum)
        || await sha256CanonicalJson({
          present: beforeMirrorRecord.present,
          value: beforeMirrorRecord.value
        }) !== beforeMirrorRecord.checksum) {
        throw new Error('APP_STATE_RECOVERY_MIRROR_SNAPSHOT_CONFLICT');
      }
      await restoreMirror(beforeMirrorRecord.present ? beforeMirrorRecord.value : null);
    }
    await journal.put('recovery_candidate_v1', {
      ...record,
      state: 'rolled_back',
      committedAt: null
    });
    return true;
  }

  async function runRecoveryUiAction({ button, statusNode, operation, pendingText } = {}) {
    if (!button || !statusNode || typeof operation !== 'function') {
      throw new Error('APP_STATE_RECOVERY_UI_ADAPTER_INVALID');
    }
    const idleText = String(button.textContent || '恢复角色入口');
    button.disabled = true;
    button.textContent = '正在恢复…';
    statusNode.textContent = String(pendingText || '正在读取并校验手机原生数据，请勿退出应用…');
    try {
      await operation();
      return true;
    } catch (error) {
      button.disabled = false;
      button.textContent = idleText;
      statusNode.textContent = error?.message || '恢复未完成';
      return false;
    }
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
    sanitizeNativeCensus,
    buildRecoveryScreenModel,
    decideRecovery,
    mergeRecoveryState,
    canonicalJson,
    sha256CanonicalJson,
    verifyNativeRoleCandidate,
    verifyNativeRecoveryMessage,
    runRecoveryTransaction,
    rollbackPreparedRecovery,
    runRecoveryUiAction,
    createWriteGuard
  });
});

