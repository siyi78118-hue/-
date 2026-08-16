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
  const WEB_SOURCE_FIELDS = Object.freeze([
    ['settings', 'settings', {}],
    ['characters', 'characters', []],
    ['chats', 'allChats', {}],
    ['moments', 'allMoments', []]
  ]);
  const AVATAR_SOURCE_PRIORITY = Object.freeze([
    ['current', 'current'],
    ['recovery_before', 'recoveryBefore'],
    ['legacy', 'legacy'],
    ['pre_recovery_mirror', 'preRecoveryMirror'],
    ['current_mirror', 'mirror']
  ]);
  const NATIVE_PAGE_METHODS = Object.freeze({
    readAppRecoveryReplyParts: {
      contract: 'android-app-recovery-reply-part-v1', timeKey: 'createdAt', idKey: 'replyPartId'
    },
    readAppRecoveryMemoryRecords: {
      contract: 'android-app-recovery-memory-v1', timeKey: 'updatedAt', idKey: 'memoryId'
    },
    readAppRecoveryRolePlans: {
      contract: 'android-app-recovery-role-plan-v1', timeKey: 'updatedAt', idKey: 'planId'
    },
    readAppRecoveryMomentEvidence: {
      contract: 'android-app-recovery-moment-evidence-v1', timeKey: 'createdAt', idKey: 'replyPartId'
    }
  });
  const NATIVE_ROW_KEYS = Object.freeze({
    'android-app-recovery-reply-part-v1': Object.freeze([
      'replyPartId', 'turnId', 'attemptId', 'sequence', 'type', 'content',
      'payload', 'createdAt', 'sourceChecksum'
    ]),
    'android-app-recovery-moment-evidence-v1': Object.freeze([
      'replyPartId', 'turnId', 'attemptId', 'sequence', 'type', 'content',
      'payload', 'createdAt', 'sourceChecksum'
    ]),
    'android-app-recovery-memory-v1': Object.freeze([
      'memoryId', 'sourceKey', 'characterId', 'type', 'title', 'content',
      'vectorJson', 'eventTime', 'createdAt', 'updatedAt', 'manual', 'sourceChecksum'
    ]),
    'android-app-recovery-role-plan-v1': Object.freeze([
      'planId', 'characterId', 'status', 'planJson', 'nextRunAt',
      'updatedAt', 'history', 'sourceChecksum'
    ])
  });
  const LOSSLESS_REPLY_ACTION_TYPES = Object.freeze(new Set([
    'PAYMENT_STATUS', 'MOMENT_CREATE', 'MOMENT_ACTION', 'PLAN', 'LIFE_EPISODE',
    'LIFE_ADJUSTMENT', 'RELATIONSHIP_STAGE', 'SCHEDULE'
  ]));

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function canonicalJson(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (typeof value === 'object') {
      return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('APP_RESTORATION_CANONICAL_NUMBER_INVALID');
      return JSON.stringify(value);
    }
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    throw new Error('APP_RESTORATION_CANONICAL_VALUE_INVALID');
  }

  async function sha256CanonicalJson(value) {
    const text = canonicalJson(value);
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
      const bytes = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    if (typeof require === 'function') {
      return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
    }
    throw new Error('APP_RESTORATION_SHA256_UNAVAILABLE');
  }

  function assertExactKeys(value, keys, code) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
      throw new Error(code);
    }
  }

  function requireSafeInteger(value, code) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
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

  function emptySemanticState() {
    return { settings: {}, characters: [], allChats: {}, allMoments: [], updatedAt: 0 };
  }

  function parseRawSemanticSource(raw, keyPrefix, invalidSources, label) {
    const result = emptySemanticState();
    if (raw === null || raw === undefined) return result;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      invalidSources.push(`${label}:shape`);
      return result;
    }
    for (const [slot, semanticKey] of WEB_SOURCE_FIELDS) {
      const key = `${keyPrefix}_${slot}`;
      const value = raw[key];
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') {
        invalidSources.push(`${label}:${key}`);
        continue;
      }
      try {
        const parsed = JSON.parse(value);
        const valid = semanticKey === 'characters' || semanticKey === 'allMoments'
          ? Array.isArray(parsed)
          : parsed && typeof parsed === 'object' && !Array.isArray(parsed);
        if (!valid) throw new Error('shape');
        result[semanticKey] = clone(parsed);
      } catch {
        invalidSources.push(`${label}:${key}`);
      }
    }
    const updatedKey = `${keyPrefix}_app_state_updated_at`;
    if (raw[updatedKey] !== null && raw[updatedKey] !== undefined) {
      const updatedAt = Number(raw[updatedKey]);
      if (Number.isSafeInteger(updatedAt) && updatedAt >= 0) result.updatedAt = updatedAt;
      else invalidSources.push(`${label}:${updatedKey}`);
    }
    return result;
  }

  function readLegacyRawStorage(storage) {
    const raw = {};
    for (const [slot] of WEB_SOURCE_FIELDS) {
      raw[`tavern_${slot}`] = storage?.getItem?.(`tavern_${slot}`) ?? null;
    }
    raw.tavern_app_state_updated_at = storage?.getItem?.('tavern_app_state_updated_at') ?? null;
    return raw;
  }

  function semanticState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptySemanticState();
    return {
      settings: value.settings && typeof value.settings === 'object' && !Array.isArray(value.settings)
        ? clone(value.settings) : {},
      characters: Array.isArray(value.characters) ? clone(value.characters) : [],
      allChats: value.allChats && typeof value.allChats === 'object' && !Array.isArray(value.allChats)
        ? clone(value.allChats) : {},
      allMoments: Array.isArray(value.allMoments) ? clone(value.allMoments) : [],
      updatedAt: Number.isSafeInteger(Number(value.updatedAt)) && Number(value.updatedAt) >= 0
        ? Number(value.updatedAt) : 0
    };
  }

  async function collectWebRestorationSources({
    current = {}, storage, journal, mirror = {}, builtinYuqi = {}, sha256CanonicalJson
  } = {}) {
    if (!storage?.getItem || !journal?.get) {
      throw new Error('APP_RESTORATION_SOURCE_ADAPTER_INVALID');
    }
    const invalidSources = [];
    const beforeRaw = await journal.get('recovery_before_v1');
    const beforeMirror = await journal.get('recovery_before_mirror_v1');
    const recoveryBefore = parseRawSemanticSource(
      beforeRaw, 'rpchat', invalidSources, 'recovery_before');
    const legacy = parseRawSemanticSource(
      readLegacyRawStorage(storage), 'tavern', invalidSources, 'legacy');
    let preRecoveryMirror = emptySemanticState();
    if (beforeMirror !== null && beforeMirror !== undefined) {
      const keys = beforeMirror && typeof beforeMirror === 'object' && !Array.isArray(beforeMirror)
        ? Object.keys(beforeMirror).sort().join(',') : '';
      if (keys !== 'checksum,present,value,version'
        || beforeMirror.version !== 1 || typeof beforeMirror.present !== 'boolean'
        || !/^[0-9a-f]{64}$/.test(beforeMirror.checksum || '')
        || typeof sha256CanonicalJson !== 'function') {
        throw new Error('APP_RESTORATION_PRE_MIRROR_SHAPE_CONFLICT');
      }
      const actual = await sha256CanonicalJson({
        present: beforeMirror.present,
        value: beforeMirror.value
      });
      if (actual !== beforeMirror.checksum) {
        throw new Error('APP_RESTORATION_PRE_MIRROR_CHECKSUM_CONFLICT');
      }
      if (beforeMirror.present) preRecoveryMirror = semanticState(beforeMirror.value);
    }
    return deepFreeze({
      current: semanticState(current),
      recoveryBefore,
      legacy,
      preRecoveryMirror,
      mirror: semanticState(mirror),
      builtinYuqi: clone(builtinYuqi),
      invalidSources: [...new Set(invalidSources)].sort()
    });
  }

  function readVerifiedAvatarCandidate(roleId, sources = {}) {
    const safeRoleId = String(roleId || '');
    if (!safeRoleId) return null;
    for (const [source, key] of AVATAR_SOURCE_PRIORITY) {
      const role = roleFrom(sources[key], safeRoleId);
      if (role && validAvatarData(role.avatarData)) {
        return deepFreeze({ source, avatarData: role.avatarData });
      }
    }
    return null;
  }

  async function verifyNativeHistoryRow(row) {
    assertExactKeys(row, [
      'historyId', 'planId', 'historyJson', 'createdAt', 'sourceChecksum'
    ], 'APP_RESTORATION_NATIVE_HISTORY_SHAPE_CONFLICT');
    if (typeof row.historyId !== 'string' || !row.historyId
      || typeof row.planId !== 'string' || !row.planId
      || !row.historyJson || typeof row.historyJson !== 'object' || Array.isArray(row.historyJson)
      || !/^[0-9a-f]{64}$/.test(row.sourceChecksum || '')) {
      throw new Error('APP_RESTORATION_NATIVE_HISTORY_SHAPE_CONFLICT');
    }
    requireSafeInteger(row.createdAt, 'APP_RESTORATION_NATIVE_HISTORY_SHAPE_CONFLICT');
    const basis = clone(row);
    delete basis.sourceChecksum;
    if (await sha256CanonicalJson(basis) !== row.sourceChecksum) {
      throw new Error('APP_RESTORATION_NATIVE_HISTORY_CHECKSUM_CONFLICT');
    }
  }

  async function verifyNativeRow(row, contract) {
    const keys = NATIVE_ROW_KEYS[contract];
    if (!keys) throw new Error('APP_RESTORATION_NATIVE_CONTRACT_CONFLICT');
    assertExactKeys(row, keys, 'APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
    if (!/^[0-9a-f]{64}$/.test(row.sourceChecksum || '')) {
      throw new Error('APP_RESTORATION_NATIVE_ROW_CHECKSUM_CONFLICT');
    }
    if (contract === 'android-app-recovery-reply-part-v1'
      || contract === 'android-app-recovery-moment-evidence-v1') {
      for (const key of ['replyPartId', 'turnId', 'attemptId', 'type']) {
        if (typeof row[key] !== 'string' || !row[key]) {
          throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
        }
      }
      if (typeof row.content !== 'string' || !row.payload || typeof row.payload !== 'object'
        || Array.isArray(row.payload)) {
        throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      }
      requireSafeInteger(row.sequence, 'APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      requireSafeInteger(row.createdAt, 'APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      if (contract === 'android-app-recovery-moment-evidence-v1'
        && row.type !== 'MOMENT_CREATE' && row.type !== 'MOMENT_ACTION') {
        throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      }
    } else if (contract === 'android-app-recovery-memory-v1') {
      for (const key of ['memoryId', 'sourceKey', 'characterId', 'type', 'title', 'content', 'vectorJson']) {
        if (typeof row[key] !== 'string' || (key !== 'title' && key !== 'content' && !row[key])) {
          throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
        }
      }
      if (!['EVENT', 'SUMMARY', 'PROFILE'].includes(row.type) || typeof row.manual !== 'boolean') {
        throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      }
      for (const key of ['eventTime', 'createdAt', 'updatedAt']) {
        requireSafeInteger(row[key], 'APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      }
    } else {
      for (const key of ['planId', 'characterId', 'status']) {
        if (typeof row[key] !== 'string' || !row[key]) {
          throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
        }
      }
      if (!row.planJson || typeof row.planJson !== 'object' || Array.isArray(row.planJson)
        || !Array.isArray(row.history)
        || (row.nextRunAt !== null && (!Number.isSafeInteger(row.nextRunAt) || row.nextRunAt < 0))) {
        throw new Error('APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      }
      requireSafeInteger(row.updatedAt, 'APP_RESTORATION_NATIVE_ROW_SHAPE_CONFLICT');
      for (const history of row.history) await verifyNativeHistoryRow(history);
    }
    const basis = clone(row);
    delete basis.sourceChecksum;
    if (await sha256CanonicalJson(basis) !== row.sourceChecksum) {
      throw new Error('APP_RESTORATION_NATIVE_ROW_CHECKSUM_CONFLICT');
    }
    return clone(row);
  }

  async function verifyNativePage(page, contract, characterId = 'yuqi') {
    assertExactKeys(page, [
      'contract', 'characterId', 'snapshotToken', 'nextCursor',
      'hasMore', 'rows', 'pageChecksum'
    ], 'APP_RESTORATION_NATIVE_PAGE_SHAPE_CONFLICT');
    if (page.contract !== contract || page.characterId !== characterId
      || !/^sha256:[0-9a-f]{64}$/.test(page.snapshotToken || '')
      || typeof page.hasMore !== 'boolean' || !Array.isArray(page.rows)
      || !/^[0-9a-f]{64}$/.test(page.pageChecksum || '')) {
      throw new Error('APP_RESTORATION_NATIVE_PAGE_SHAPE_CONFLICT');
    }
    assertExactKeys(page.nextCursor, ['afterCreatedAt', 'afterId'],
      'APP_RESTORATION_NATIVE_CURSOR_CONFLICT');
    requireSafeInteger(page.nextCursor.afterCreatedAt,
      'APP_RESTORATION_NATIVE_CURSOR_CONFLICT');
    if (typeof page.nextCursor.afterId !== 'string') {
      throw new Error('APP_RESTORATION_NATIVE_CURSOR_CONFLICT');
    }
    const basis = clone(page);
    delete basis.pageChecksum;
    if (await sha256CanonicalJson(basis) !== page.pageChecksum) {
      throw new Error('APP_RESTORATION_NATIVE_PAGE_CHECKSUM_CONFLICT');
    }
    for (const row of page.rows) await verifyNativeRow(row, contract);
    return clone(page);
  }

  function compareNativeCursor(leftTime, leftId, rightTime, rightId) {
    if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
    if (leftId === rightId) return 0;
    return leftId < rightId ? -1 : 1;
  }

  async function readAllNativeRecoveryPages(
    plugin, method, characterId, { limit = 100, maxRows = 100000 } = {}
  ) {
    const spec = NATIVE_PAGE_METHODS[method];
    if (!spec || typeof plugin?.[method] !== 'function'
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || !Number.isSafeInteger(maxRows) || maxRows < 1) {
      throw new Error('APP_RESTORATION_NATIVE_READER_CONFLICT');
    }
    let cursor = { afterCreatedAt: 0, afterId: '' };
    let snapshotToken = '';
    const rows = [];
    const identities = new Set();
    for (let pageNumber = 0; pageNumber < 10000; pageNumber += 1) {
      const page = await verifyNativePage(await plugin[method]({
        characterId, ...cursor, limit
      }), spec.contract, characterId);
      if (snapshotToken && page.snapshotToken !== snapshotToken) {
        throw new Error('APP_RESTORATION_NATIVE_SNAPSHOT_CHANGED');
      }
      snapshotToken = page.snapshotToken;
      let lastTime = cursor.afterCreatedAt;
      let lastId = cursor.afterId;
      for (const row of page.rows) {
        const rowTime = row[spec.timeKey];
        const rowId = row[spec.idKey];
        if (compareNativeCursor(rowTime, rowId, lastTime, lastId) <= 0
          || identities.has(rowId)) {
          throw new Error('APP_RESTORATION_NATIVE_CURSOR_CONFLICT');
        }
        identities.add(rowId);
        rows.push(row);
        lastTime = rowTime;
        lastId = rowId;
        if (rows.length > maxRows) throw new Error('APP_RESTORATION_PAGE_LIMIT_CONFLICT');
      }
      if (page.nextCursor.afterCreatedAt !== lastTime || page.nextCursor.afterId !== lastId
        || (page.hasMore && page.rows.length === 0)) {
        throw new Error('APP_RESTORATION_NATIVE_CURSOR_CONFLICT');
      }
      cursor = clone(page.nextCursor);
      if (!page.hasMore) return deepFreeze({ snapshotToken, rows: clone(rows) });
    }
    throw new Error('APP_RESTORATION_PAGE_LIMIT_CONFLICT');
  }

  function mapNativeReplyEvidence(rows = []) {
    const messages = [];
    const actions = [];
    const nativeOnly = [];
    for (const row of rows) {
      if (row.type === 'TEXT') {
        messages.push({
          id: row.replyPartId,
          role: 'assistant',
          content: row.content,
          time: row.createdAt,
          sourceTurnId: 'native:' + row.turnId,
          nativeRecoveryChecksum: row.sourceChecksum
        });
      } else if (LOSSLESS_REPLY_ACTION_TYPES.has(row.type)) {
        actions.push(clone(row));
      } else {
        nativeOnly.push(clone(row));
      }
    }
    return deepFreeze({ messages, actions, nativeOnly });
  }

  function mapNativeMemoryRows(rows = []) {
    const stores = { EVENT: 'events', SUMMARY: 'summaries', PROFILE: 'profiles' };
    return deepFreeze(rows.map(row => {
      let vector;
      try { vector = JSON.parse(row.vectorJson); } catch {
        throw new Error('APP_RESTORATION_NATIVE_MEMORY_VECTOR_CONFLICT');
      }
      if (!Array.isArray(vector) || vector.some(value => !Number.isFinite(value))) {
        throw new Error('APP_RESTORATION_NATIVE_MEMORY_VECTOR_CONFLICT');
      }
      const common = {
        id: row.memoryId,
        charId: row.characterId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        manual: row.manual,
        nativeRecoverySourceKey: row.sourceKey,
        nativeRecoveryChecksum: row.sourceChecksum
      };
      const item = row.type === 'SUMMARY'
        ? { ...common, content: row.content }
        : {
            ...common,
            type: row.type === 'EVENT' ? 'fact' : 'profile',
            title: row.title,
            detail: row.content,
            ...(row.type === 'EVENT' ? { happenedAt: row.eventTime } : {})
          };
      return { storeName: stores[row.type], item, vector, verified: true };
    }));
  }

  function mapNativeRolePlanRows(rows = []) {
    const plans = [];
    const history = [];
    for (const row of rows) {
      if ((row.planJson.planId && row.planJson.planId !== row.planId)
        || (row.planJson.characterId && row.planJson.characterId !== row.characterId)) {
        throw new Error('APP_RESTORATION_NATIVE_ROLE_PLAN_CONFLICT');
      }
      plans.push({
        ...clone(row.planJson),
        planId: row.planId,
        characterId: row.characterId,
        status: row.status,
        nextRunAt: row.nextRunAt,
        updatedAt: row.updatedAt,
        nativeRecoveryChecksum: row.sourceChecksum,
        verified: true
      });
      for (const record of row.history) {
        if ((record.historyJson.historyId && record.historyJson.historyId !== record.historyId)
          || (record.historyJson.planId && record.historyJson.planId !== row.planId)) {
          throw new Error('APP_RESTORATION_NATIVE_ROLE_PLAN_CONFLICT');
        }
        history.push({
          ...clone(record.historyJson),
          historyId: record.historyId,
          planId: row.planId,
          createdAt: record.createdAt,
          nativeRecoveryChecksum: record.sourceChecksum
        });
      }
    }
    return deepFreeze({ plans, history });
  }

  function mapNativeMomentRows(rows = []) {
    const creates = [];
    const actions = [];
    const nativeOnly = [];
    for (const row of rows) {
      if (row.type === 'MOMENT_CREATE') {
        const id = String(row.payload?.momentId || '');
        if (!id) throw new Error('APP_RESTORATION_NATIVE_MOMENT_IDENTITY_CONFLICT');
        creates.push({
          ...clone(row.payload), id, verified: true,
          nativeRecoveryEvidenceId: row.replyPartId,
          nativeRecoveryChecksum: row.sourceChecksum
        });
      } else if (row.type === 'MOMENT_ACTION') actions.push(clone(row));
      else nativeOnly.push(clone(row));
    }
    return deepFreeze({ creates, actions, nativeOnly });
  }

  const COMPLETE_STORE_ORDER = Object.freeze(['web', 'mirror', 'memories', 'rolePlans']);
  const DELETION_FROZEN_STATES = Object.freeze(new Set([
    'waiting', 'pending', 'relay_accepted', 'applied'
  ]));

  function countTargetCategories(target) {
    const chats = target.web?.allChats && typeof target.web.allChats === 'object'
      ? Object.values(target.web.allChats).reduce((count, chat) =>
          count + (Array.isArray(chat?.messages) ? chat.messages.length : 0), 0)
      : 0;
    return {
      roles: Array.isArray(target.web?.characters) ? target.web.characters.length : 0,
      chats,
      moments: Array.isArray(target.web?.allMoments) ? target.web.allMoments.length : 0,
      memories: Array.isArray(target.memories) ? target.memories.length : 0,
      rolePlans: (Array.isArray(target.rolePlans?.plans) ? target.rolePlans.plans.length : 0)
        + (Array.isArray(target.rolePlans?.history) ? target.rolePlans.history.length : 0)
    };
  }

  async function targetCategoryChecksums(target) {
    return {
      roles: await sha256CanonicalJson(target.web?.characters || []),
      chats: await sha256CanonicalJson(target.web?.allChats || {}),
      moments: await sha256CanonicalJson(target.web?.allMoments || []),
      memories: await sha256CanonicalJson(target.memories || []),
      rolePlans: await sha256CanonicalJson(target.rolePlans || { plans: [], history: [] })
    };
  }

  function assertCompleteTransactionAdapters(journal, stores, target, ensureDeletion, unlock) {
    if (!journal?.put || !target || typeof target !== 'object' || Array.isArray(target)
      || Object.keys(target).sort().join(',') !== [...COMPLETE_STORE_ORDER].sort().join(',')
      || typeof ensureDeletion !== 'function' || typeof unlock !== 'function') {
      throw new Error('APP_RESTORATION_TRANSACTION_ADAPTER_CONFLICT');
    }
    for (const name of COMPLETE_STORE_ORDER) {
      const store = stores?.[name];
      if (!store || typeof store.read !== 'function' || typeof store.write !== 'function'
        || typeof store.restore !== 'function') {
        throw new Error('APP_RESTORATION_TRANSACTION_ADAPTER_CONFLICT');
      }
    }
  }

  async function runCompleteRestorationTransaction({
    journal, stores, target, ensureDeletion, unlock, now = Date.now(), faultAfter = 0
  } = {}) {
    assertCompleteTransactionAdapters(journal, stores, target, ensureDeletion, unlock);
    requireSafeInteger(now, 'APP_RESTORATION_TIME_CONFLICT');
    const frozenTarget = clone(target);
    const candidateChecksum = await sha256CanonicalJson(frozenTarget);
    const categoryChecksums = await targetCategoryChecksums(frozenTarget);
    const categoryCounts = countTargetCategories(frozenTarget);
    const before = {};
    const beforeChecksums = {};
    for (const name of COMPLETE_STORE_ORDER) {
      before[name] = clone(await stores[name].read());
      beforeChecksums[name] = await sha256CanonicalJson(before[name]);
      await journal.put('complete_restoration_before_' + name + '_v1', before[name]);
    }
    let record = {
      version: 1,
      state: 'prepared',
      deletionCharacterId: CONFIRMED_DELETION_ID,
      deletionState: 'not_started',
      beforeChecksums,
      candidateChecksum,
      categoryChecksums,
      categoryCounts,
      preparedAt: now,
      committedAt: null
    };
    const written = [];
    let unlocked = false;
    const fault = boundary => {
      if (Number(faultAfter) === boundary) {
        throw new Error('APP_RESTORATION_FAULT_' + boundary);
      }
    };
    try {
      await journal.put('complete_restoration_v1', record);
      fault(1);

      const deletion = await ensureDeletion(CONFIRMED_DELETION_ID);
      const deletionState = String(deletion?.state || '');
      if (!DELETION_FROZEN_STATES.has(deletionState)) {
        throw new Error('APP_RESTORATION_DELETION_AUTHORITY_CONFLICT');
      }
      record = { ...record, deletionState };
      await journal.put('complete_restoration_v1', record);
      fault(2);

      for (let index = 0; index < COMPLETE_STORE_ORDER.length; index += 1) {
        const name = COMPLETE_STORE_ORDER[index];
        await stores[name].write(clone(frozenTarget[name]));
        written.push(name);
        fault(index + 3);
      }

      for (const name of COMPLETE_STORE_ORDER) {
        const actual = await stores[name].read();
        if (await sha256CanonicalJson(actual) !== await sha256CanonicalJson(frozenTarget[name])) {
          throw new Error('APP_RESTORATION_VERIFY_CONFLICT:' + name);
        }
      }
      fault(7);

      record = { ...record, state: 'committed', committedAt: now };
      await journal.put('complete_restoration_v1', record);
      fault(8);

      unlock(candidateChecksum);
      unlocked = true;
      return clone(record);
    } catch (error) {
      if (!unlocked) {
        let rollbackError = null;
        for (const name of [...written].reverse()) {
          try { await stores[name].restore(clone(before[name])); }
          catch (restoreError) { rollbackError ||= restoreError; }
        }
        for (const name of written) {
          try {
            const restored = await stores[name].read();
            if (await sha256CanonicalJson(restored) !== beforeChecksums[name]) {
              rollbackError ||= new Error('APP_RESTORATION_ROLLBACK_VERIFY_CONFLICT:' + name);
            }
          } catch (verifyError) { rollbackError ||= verifyError; }
        }
        record = { ...record, state: 'rolled_back', committedAt: null };
        await journal.put('complete_restoration_v1', record);
        if (rollbackError) {
          const failure = new Error('APP_RESTORATION_ROLLBACK_FAILED');
          failure.cause = rollbackError;
          throw failure;
        }
      }
      throw error;
    }
  }

  async function rollbackPreparedCompleteRestoration({ journal, stores } = {}) {
    if (!journal?.get || !journal?.put) {
      throw new Error('APP_RESTORATION_TRANSACTION_ADAPTER_CONFLICT');
    }
    for (const name of COMPLETE_STORE_ORDER) {
      if (!stores?.[name] || typeof stores[name].read !== 'function'
        || typeof stores[name].restore !== 'function') {
        throw new Error('APP_RESTORATION_TRANSACTION_ADAPTER_CONFLICT');
      }
    }
    const record = await journal.get('complete_restoration_v1');
    if (!record || record.state !== 'prepared') return false;
    assertExactKeys(record, [
      'version', 'state', 'deletionCharacterId', 'deletionState', 'beforeChecksums',
      'candidateChecksum', 'categoryChecksums', 'categoryCounts',
      'preparedAt', 'committedAt'
    ], 'APP_RESTORATION_JOURNAL_CONFLICT');
    if (record.version !== 1 || record.deletionCharacterId !== CONFIRMED_DELETION_ID
      || !['not_started', ...DELETION_FROZEN_STATES].includes(record.deletionState)
      || record.committedAt !== null || !Number.isSafeInteger(record.preparedAt)
      || record.preparedAt < 0 || !/^[0-9a-f]{64}$/.test(record.candidateChecksum || '')) {
      throw new Error('APP_RESTORATION_JOURNAL_CONFLICT');
    }
    assertExactKeys(record.beforeChecksums, COMPLETE_STORE_ORDER,
      'APP_RESTORATION_JOURNAL_CONFLICT');
    assertExactKeys(record.categoryChecksums,
      ['roles', 'chats', 'moments', 'memories', 'rolePlans'],
      'APP_RESTORATION_JOURNAL_CONFLICT');
    assertExactKeys(record.categoryCounts,
      ['roles', 'chats', 'moments', 'memories', 'rolePlans'],
      'APP_RESTORATION_JOURNAL_CONFLICT');
    const checksumValues = [
      ...Object.values(record.beforeChecksums),
      ...Object.values(record.categoryChecksums)
    ];
    if (checksumValues.some(value => !/^[0-9a-f]{64}$/.test(value || ''))
      || Object.values(record.categoryCounts).some(value =>
        !Number.isSafeInteger(value) || value < 0)) {
      throw new Error('APP_RESTORATION_JOURNAL_CONFLICT');
    }
    const before = {};
    for (const name of COMPLETE_STORE_ORDER) {
      before[name] = await journal.get('complete_restoration_before_' + name + '_v1');
      if (await sha256CanonicalJson(before[name]) !== record.beforeChecksums[name]) {
        throw new Error('APP_RESTORATION_BEFORE_CHECKSUM_CONFLICT:' + name);
      }
    }
    for (const name of [...COMPLETE_STORE_ORDER].reverse()) {
      await stores[name].restore(clone(before[name]));
    }
    for (const name of COMPLETE_STORE_ORDER) {
      if (await sha256CanonicalJson(await stores[name].read()) !== record.beforeChecksums[name]) {
        throw new Error('APP_RESTORATION_ROLLBACK_VERIFY_CONFLICT:' + name);
      }
    }
    await journal.put('complete_restoration_v1', {
      ...record, state: 'rolled_back', committedAt: null
    });
    return true;
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
    const rows = Array.isArray(native?.moments?.creates)
      ? native.moments.creates
      : (Array.isArray(native?.momentEvidence) ? native.momentEvidence : []);
    return rows.filter(row => row && row.verified === true
      && typeof row.id === 'string' && row.id);
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
    current = {}, recoveryBefore = {}, legacy = {}, preRecoveryMirror = {}, mirror = {}, native = {},
    builtinYuqi = {}, deletionTargets = []
  } = {}) {
    const excludedRoleIds = assertDeletionTargets(deletionTargets);
    const roleSources = [current, recoveryBefore, legacy, preRecoveryMirror, mirror];
    const yuqi = mergeRoleByField('yuqi', roleSources, builtinYuqi);
    const nativeMessages = [
      ...(Array.isArray(native.messages) ? native.messages : []),
      ...(Array.isArray(native.reply?.messages) ? native.reply.messages : [])
    ].map(row => ({
      ...clone(row),
      id: String(row?.id || row?.messageId || ''),
      role: row?.role || (row?.speakerType === 'user' ? 'user' : 'assistant'),
      time: Number(row?.time || row?.sentAt || 0)
    }));
    const messages = mergeMessages([
      messageRows(mirror, 'yuqi'),
      messageRows(preRecoveryMirror, 'yuqi'),
      messageRows(legacy, 'yuqi'),
      messageRows(recoveryBefore, 'yuqi'),
      nativeMessages,
      messageRows(current, 'yuqi')
    ]);
    const moments = mergeIdentityRows([
      mirror.allMoments, preRecoveryMirror.allMoments, legacy.allMoments,
      recoveryBefore.allMoments, verifiedNativeMoments(native), current.allMoments
    ]);
    const unconfirmedEmptyRoleIds = (Array.isArray(native.roles) ? native.roles : [])
      .filter(row => row && Number(row.rawMessageCount) === 0
        && !excludedRoleIds.includes(String(row.characterId || '')))
      .map(row => String(row.characterId || '')).filter(Boolean).sort();
    const avatar = yuqi.avatarData
      ? { status: roleFrom(current, 'yuqi')?.avatarData === yuqi.avatarData
        ? 'already_present' : 'restored' }
      : { status: 'no_verified_source', reasonCode: 'avatar_bytes_missing' };
    const settings = Object.assign({},
      clone(native.settings || {}), clone(mirror.settings || {}),
      clone(preRecoveryMirror.settings || {}), clone(legacy.settings || {}),
      clone(recoveryBefore.settings || {}), clone(current.settings || {}));
    const memories = (Array.isArray(native.memories) ? native.memories : [])
      .filter(row => row?.verified === true);
    const rolePlans = {
      plans: (Array.isArray(native.rolePlans?.plans) ? native.rolePlans.plans : [])
        .filter(row => row?.verified === true),
      history: Array.isArray(native.rolePlans?.history) ? clone(native.rolePlans.history) : []
    };
    const nativeOnly = [
      ...(Array.isArray(native.reply?.nativeOnly) ? native.reply.nativeOnly : []),
      ...(Array.isArray(native.moments?.nativeOnly) ? native.moments.nativeOnly : [])
    ];
    return deepFreeze({
      version: 1,
      excludedRoleIds,
      settings,
      roles: { yuqi },
      chats: { yuqi: { messages } },
      moments,
      memories,
      rolePlans,
      nativeOnly,
      report: {
        unconfirmedEmptyRoleIds,
        categories: {
          avatar,
          messages: { status: 'restored', count: messages.length },
          moments: { status: moments.length ? 'restored' : 'no_verified_source', count: moments.length },
          memories: { status: memories.length ? 'restored' : 'no_verified_source', count: memories.length },
          rolePlans: { status: rolePlans.plans.length ? 'restored' : 'no_verified_source', count: rolePlans.plans.length },
          nativeOnly: { status: nativeOnly.length ? 'native_only' : 'already_present', count: nativeOnly.length }
        }
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
      settings: { ...(clone(plan.settings || {})), ...(clone(current.settings || {})) },
      characters: [...characters.values()],
      allChats,
      allMoments: mergeIdentityRows([plan.moments, current.allMoments])
    };
  }

  return Object.freeze({
    buildPlan,
    applyWebCandidate,
    collectWebRestorationSources,
    readVerifiedAvatarCandidate,
    verifyNativePage,
    readAllNativeRecoveryPages,
    mapNativeReplyEvidence,
    mapNativeMemoryRows,
    mapNativeRolePlanRows,
    mapNativeMomentRows,
    runCompleteRestorationTransaction,
    rollbackPreparedCompleteRestoration,
    validAvatarData,
    CONFIRMED_DELETION_ID
  });
});
