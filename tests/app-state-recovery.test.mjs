import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function recoveryModule() {
  const path = require.resolve('../tavern-app/lib/app-state-recovery.js');
  delete require.cache[path];
  return require(path);
}

function fakeStorage(values = {}) {
  const rows = new Map(Object.entries(values));
  return {
    getItem(key) { return rows.has(key) ? rows.get(key) : null; },
    setItem(key, value) { rows.set(key, String(value)); },
    removeItem(key) { rows.delete(key); }
  };
}

function webState({ characters = [], chats = {}, moments = [], updatedAt = 0, invalidCritical = false } = {}) {
  return { characters, allChats: chats, allMoments: moments, updatedAt, invalidCritical };
}

test('invalid primary JSON falls back to a valid legacy slot while retaining corruption evidence', () => {
  const { readStorageSlot } = recoveryModule();
  const storage = fakeStorage({
    rpchat_characters: '{',
    tavern_characters: JSON.stringify([{ id: 'yuqi' }])
  });

  const result = readStorageSlot(storage, 'rpchat_characters', 'tavern_characters');

  assert.equal(result.status, 'valid');
  assert.equal(result.source, 'legacy');
  assert.deepEqual(result.value, [{ id: 'yuqi' }]);
  assert.equal(result.errorCode, 'PRIMARY_JSON_INVALID');
  assert.ok(result.rawBytes > 0);
});

test('invalid critical JSON never becomes a legitimate empty value', () => {
  const { readStorageSlot } = recoveryModule();
  const storage = fakeStorage({ rpchat_chats: '{broken' });

  const result = readStorageSlot(storage, 'rpchat_chats', 'tavern_chats');

  assert.equal(result.status, 'invalid');
  assert.equal(result.source, 'primary');
  assert.equal(result.value, undefined);
  assert.equal(result.errorCode, 'PRIMARY_JSON_INVALID');
});

test('an older non-empty mirror recovers a newer empty local role directory', () => {
  const { decideRecovery } = recoveryModule();

  const result = decideRecovery({
    local: webState({ characters: [], updatedAt: 200 }),
    mirror: webState({ characters: [{ id: 'yuqi' }], updatedAt: 100 }),
    native: { roleCount: 1 }
  });

  assert.deepEqual(result, {
    mode: 'restore_mirror',
    frozen: true,
    source: 'mirror',
    reasonCode: 'LOCAL_ROLE_DIRECTORY_EMPTY'
  });
});

test('a newer empty mirror never overwrites valid local roles', () => {
  const { decideRecovery } = recoveryModule();

  const result = decideRecovery({
    local: webState({ characters: [{ id: 'yuqi' }], updatedAt: 100 }),
    mirror: webState({ characters: [], updatedAt: 200 }),
    native: { roleCount: 1 }
  });

  assert.deepEqual(result, {
    mode: 'normal',
    frozen: false,
    source: 'local',
    reasonCode: ''
  });
});

test('native roles with empty Web sources freeze normal boot', () => {
  const { decideRecovery } = recoveryModule();

  const result = decideRecovery({
    local: webState(),
    mirror: webState(),
    native: { roleCount: 1 }
  });

  assert.deepEqual(result, {
    mode: 'native_candidate',
    frozen: true,
    source: 'native',
    reasonCode: 'WEB_ROLE_DIRECTORY_MISSING'
  });
});

test('merge recovery state only adds missing identities and preserves richer current rows', () => {
  const { mergeRecoveryState } = recoveryModule();
  const current = webState({
    characters: [{ id: 'yuqi', name: '虞栖', avatarData: 'existing-avatar' }],
    chats: { yuqi: { messages: [{ id: 'm2', content: 'current' }] } },
    moments: [{ id: 'moment-current', content: 'current' }]
  });
  const candidate = webState({
    characters: [{ id: 'yuqi', name: 'older' }, { id: 'second', name: '二号' }],
    chats: { yuqi: { messages: [{ id: 'm1', content: 'older' }, { id: 'm2', content: 'candidate' }] } },
    moments: [{ id: 'moment-old', content: 'old' }]
  });

  const merged = mergeRecoveryState(current, candidate);

  assert.equal(merged.characters.length, 2);
  assert.equal(merged.characters.find(row => row.id === 'yuqi').avatarData, 'existing-avatar');
  assert.deepEqual(merged.allChats.yuqi.messages.map(row => row.id), ['m1', 'm2']);
  assert.equal(merged.allChats.yuqi.messages.find(row => row.id === 'm2').content, 'current');
  assert.deepEqual(merged.allMoments.map(row => row.id), ['moment-old', 'moment-current']);
  assert.deepEqual(current.allChats.yuqi.messages.map(row => row.id), ['m2'], 'input is not mutated');
});

test('a valid legacy role directory remains frozen until it is committed to the primary slot', () => {
  const { decideRecovery } = recoveryModule();
  const result = decideRecovery({
    local: { ...webState({ characters: [{ id: 'yuqi' }] }), source: 'legacy' },
    mirror: webState(),
    native: { roleCount: 1 }
  });
  assert.deepEqual(result, {
    mode: 'restore_legacy', frozen: true, source: 'legacy', reasonCode: 'PRIMARY_ROLE_DIRECTORY_INVALID'
  });
});

test('an unavailable native census freezes an empty native Web app instead of declaring it empty', () => {
  const { decideRecovery } = recoveryModule();
  const result = decideRecovery({
    local: webState(), mirror: webState(), native: { unavailable: true }
  });
  assert.deepEqual(result, {
    mode: 'diagnostic_only', frozen: true, source: '', reasonCode: 'NATIVE_RECOVERY_CENSUS_UNAVAILABLE'
  });
});

test('write guard is frozen by default and only an explicit normal decision unlocks it', () => {
  const { createWriteGuard } = recoveryModule();
  const guard = createWriteGuard();

  assert.equal(guard.frozen, true);
  assert.throws(() => guard.assertWritable('characters'), /APP_STATE_RECOVERY_FROZEN/);

  guard.applyDecision({ mode: 'normal', frozen: false, source: 'local', reasonCode: '' });
  assert.equal(guard.frozen, false);
  assert.doesNotThrow(() => guard.assertWritable('characters'));
});

test('a recovery decision remains frozen until a verified commit explicitly unlocks it', () => {
  const { createWriteGuard } = recoveryModule();
  const guard = createWriteGuard();

  guard.applyDecision({
    mode: 'restore_mirror', frozen: true, source: 'mirror', reasonCode: 'LOCAL_ROLE_DIRECTORY_EMPTY'
  });
  assert.equal(guard.frozen, true);
  assert.equal(guard.reasonCode, 'LOCAL_ROLE_DIRECTORY_EMPTY');
  assert.throws(() => guard.assertWritable('app_state'), /LOCAL_ROLE_DIRECTORY_EMPTY/);

  guard.unlockAfterVerifiedRecovery('candidate-checksum');
  assert.equal(guard.frozen, false);
  assert.equal(guard.recoveryChecksum, 'candidate-checksum');
});

test('native recovery census excludes tombstoned roles before source selection', () => {
  const { sanitizeNativeCensus } = recoveryModule();
  const census = sanitizeNativeCensus({
    roleCount: 2,
    roles: [
      { characterId: 'yuqi', displayName: '虞栖', candidateAvailable: true },
      { characterId: 'deleted', displayName: '已删除', candidateAvailable: true, tombstoned: true }
    ],
    databaseBytes: 100,
    walBytes: 20,
    shmBytes: 10
  });
  assert.equal(census.roleCount, 1);
  assert.deepEqual(census.roles.map(row => row.characterId), ['yuqi']);
});

test('conflicting native role identities fail closed into diagnostic-only mode', () => {
  const { decideRecovery } = recoveryModule();
  const result = decideRecovery({
    local: webState(),
    mirror: webState(),
    native: {
      roleCount: 2,
      roles: [
        { characterId: 'yuqi', displayName: '虞栖', candidateAvailable: true, sourceChecksum: 'a'.repeat(64) },
        { characterId: 'yuqi', displayName: '另一个虞栖', candidateAvailable: true, sourceChecksum: 'b'.repeat(64) }
      ]
    }
  });
  assert.deepEqual(result, {
    mode: 'diagnostic_only', frozen: true, source: '', reasonCode: 'NATIVE_RECOVERY_CENSUS_CONFLICT'
  });
});

test('recovery screen model exposes metadata but never semantic fields', () => {
  const { buildRecoveryScreenModel } = recoveryModule();
  const model = buildRecoveryScreenModel({
    mode: 'native_candidate', frozen: true, source: 'native', reasonCode: 'WEB_ROLE_DIRECTORY_MISSING',
    native: {
      roleCount: 1,
      databaseBytes: 6000,
      walBytes: 200,
      shmBytes: 100,
      roles: [{
        characterId: 'yuqi', displayName: '虞栖', rawMessageCount: 200,
        systemPrompt: 'secret prompt', content: 'secret message'
      }]
    }
  });
  assert.equal(model.sourceName, '手机原生数据库');
  assert.deepEqual(model.roles, [{ characterId: 'yuqi', displayName: '虞栖', rawMessageCount: 200 }]);
  assert.equal(JSON.stringify(model).includes('secret'), false);
});

test('mirror and legacy recovery screen models retain only safe role labels', () => {
  const { buildRecoveryScreenModel } = recoveryModule();
  const mirror = buildRecoveryScreenModel({
    mode: 'restore_mirror', frozen: true, source: 'mirror', reasonCode: 'LOCAL_ROLE_DIRECTORY_EMPTY',
    mirror: {
      characters: [{ id: 'yuqi', name: '虞栖', systemPrompt: 'secret prompt' }],
      allChats: { yuqi: { messages: [{ id: 'm1', content: 'secret message' }] } }
    }
  });
  assert.equal(mirror.roleCount, 1);
  assert.deepEqual(mirror.roles, [{ characterId: 'yuqi', displayName: '虞栖', rawMessageCount: 1 }]);
  assert.equal(JSON.stringify(mirror).includes('secret'), false);

  const legacy = buildRecoveryScreenModel({
    mode: 'restore_legacy', frozen: true, source: 'legacy', reasonCode: 'PRIMARY_ROLE_DIRECTORY_INVALID',
    local: { characters: [{ id: 'yuqi', name: '虞栖', systemPrompt: 'secret' }], allChats: {} }
  });
  assert.equal(legacy.roleCount, 1);
  assert.equal(legacy.roles[0].displayName, '虞栖');
});

function transactionHarness(initial = {}, initialMirror = null) {
  const rows = new Map(Object.entries(initial));
  const journal = new Map();
  let mirror = structuredClone(initialMirror);
  let unlocked = '';
  return {
    storage: {
      getItem(key) { return rows.has(key) ? rows.get(key) : null; },
      setItem(key, value) { rows.set(key, String(value)); },
      removeItem(key) { rows.delete(key); }
    },
    journal: {
      async get(key) { return journal.get(key) ?? null; },
      async put(key, value) { journal.set(key, structuredClone(value)); }
    },
    async readMirror() { return structuredClone(mirror); },
    async writeMirror(value) { mirror = structuredClone(value); },
    async restoreMirror(value) { mirror = structuredClone(value); },
    unlock(checksum) { unlocked = checksum; },
    rows,
    journalRows: journal,
    get mirror() { return mirror; },
    get unlocked() { return unlocked; }
  };
}

const emptyRawState = {
  rpchat_settings: JSON.stringify({ playerName: '青衫困' }),
  rpchat_characters: '[]',
  rpchat_chats: '{}',
  rpchat_moments: '[]',
  rpchat_app_state_updated_at: '1'
};

const recoveredState = {
  settings: { playerName: '青衫困' },
  characters: [{ id: 'yuqi', name: '虞栖' }],
  allChats: { yuqi: { messages: [{ id: 'm1', role: 'user', content: '你好', time: 2 }] } },
  allMoments: [],
  updatedAt: 20
};

test('native role and message candidates use frozen cross-language checksums', async () => {
  const { verifyNativeRoleCandidate, verifyNativeRecoveryMessage } = recoveryModule();
  const role = {
    characterId: 'yuqi', name: '虞栖', playerName: '青衫困', systemPrompt: '提示',
    createdAt: 100, sourceSnapshotId: 'snap-1',
    sourceChecksum: '3b015a2fed4f0868eae8de94a48289bf0d3775fc0e742be0b36b945264905663'
  };
  const message = {
    messageId: 'm1', turnId: 't1', characterId: 'yuqi', speakerId: 'user',
    speakerType: 'user', recipientId: 'yuqi', content: '你好', sentAt: 200,
    origin: 'phone', deviceId: 'phone', deviceSeq: 1,
    sourceChecksum: '4b0058f9adc0826e88cb141efd3fc525597a86f0b5edff0acf24a770578c7e65'
  };
  assert.equal((await verifyNativeRoleCandidate(role)).characterId, 'yuqi');
  assert.equal((await verifyNativeRecoveryMessage(message)).messageId, 'm1');
  await assert.rejects(() => verifyNativeRoleCandidate({ ...role, name: '篡改' }), /CHECKSUM_CONFLICT/);
  await assert.rejects(() => verifyNativeRecoveryMessage({ ...message, content: '篡改' }), /CHECKSUM_CONFLICT/);
});

test('native role candidates allow empty historical presentation fields', async () => {
  const { verifyNativeRoleCandidate, sha256CanonicalJson } = recoveryModule();
  const basis = {
    characterId: 'legacy-role',
    name: '',
    playerName: '',
    systemPrompt: '',
    createdAt: 1,
    sourceSnapshotId: 'legacy-snapshot'
  };
  const candidate = { ...basis, sourceChecksum: await sha256CanonicalJson(basis) };
  const verified = await verifyNativeRoleCandidate(candidate);
  assert.equal(verified.characterId, 'legacy-role');
  assert.equal(verified.name, '');
  assert.equal(verified.playerName, '');
});

test('two-phase recovery commits verified state before unlocking writes', async () => {
  const { runRecoveryTransaction } = recoveryModule();
  const harness = transactionHarness(emptyRawState);
  const result = await runRecoveryTransaction({
    storage: harness.storage,
    journal: harness.journal,
    readMirror: () => harness.readMirror(),
    writeMirror: value => harness.writeMirror(value),
    restoreMirror: value => harness.restoreMirror(value),
    unlock: checksum => harness.unlock(checksum),
    source: 'native',
    reasonCode: 'WEB_ROLE_DIRECTORY_MISSING',
    targetState: recoveredState,
    now: 100
  });
  assert.equal(result.state, 'committed');
  assert.deepEqual(JSON.parse(harness.rows.get('rpchat_characters')), recoveredState.characters);
  assert.deepEqual(harness.mirror.characters, recoveredState.characters);
  assert.equal(harness.journalRows.get('recovery_candidate_v1').state, 'committed');
  assert.equal(harness.unlocked, result.candidateChecksum);
});

test('a prepared recovery journal rolls back exact raw state after restart', async () => {
  const { rollbackPreparedRecovery, sha256CanonicalJson } = recoveryModule();
  const originalMirror = { characters: [{ id: 'prior' }], updatedAt: 1 };
  const harness = transactionHarness(emptyRawState, originalMirror);
  const mirrorBasis = { present: true, value: originalMirror };
  await harness.journal.put('recovery_before_v1', emptyRawState);
  await harness.journal.put('recovery_before_mirror_v1', {
    version: 1,
    ...mirrorBasis,
    checksum: await sha256CanonicalJson(mirrorBasis)
  });
  await harness.journal.put('recovery_candidate_v1', {
    version: 1, state: 'prepared', source: 'native', reasonCode: 'WEB_ROLE_DIRECTORY_MISSING',
    beforeChecksum: await sha256CanonicalJson(emptyRawState),
    candidateChecksum: 'a'.repeat(64), preparedAt: 100, committedAt: null
  });
  harness.storage.setItem('rpchat_characters', JSON.stringify([{ id: 'partial' }]));
  await harness.writeMirror({ characters: [{ id: 'partial' }], updatedAt: 2 });
  assert.equal(await rollbackPreparedRecovery({
    storage: harness.storage,
    journal: harness.journal,
    restoreMirror: value => harness.restoreMirror(value)
  }), true);
  assert.deepEqual(Object.fromEntries(harness.rows), emptyRawState);
  assert.deepEqual(harness.mirror, originalMirror);
  assert.equal(harness.journalRows.get('recovery_candidate_v1').state, 'rolled_back');
});

test('faults at every pre-unlock boundary restore the exact prior raw state', async () => {
  const { runRecoveryTransaction } = recoveryModule();
  for (let boundary = 1; boundary <= 7; boundary += 1) {
    const harness = transactionHarness(emptyRawState);
    await assert.rejects(() => runRecoveryTransaction({
      storage: harness.storage,
      journal: harness.journal,
      writeMirror: value => harness.writeMirror(value),
      unlock: checksum => harness.unlock(checksum),
      source: 'native',
      reasonCode: 'WEB_ROLE_DIRECTORY_MISSING',
      targetState: recoveredState,
      now: 100,
      faultAfter: boundary
    }), new RegExp(`APP_STATE_RECOVERY_FAULT_${boundary}`));
    assert.deepEqual(Object.fromEntries(harness.rows), emptyRawState, `boundary ${boundary}`);
    assert.equal(harness.journalRows.get('recovery_candidate_v1').state, 'rolled_back');
    assert.equal(harness.unlocked, '');
  }
});

test('recovery action keeps a stable button reference and reports asynchronous failure', async () => {
  const { runRecoveryUiAction } = recoveryModule();
  const button = { disabled: false, textContent: '恢复角色入口' };
  const statusNode = { textContent: '' };

  const ok = await runRecoveryUiAction({
    button,
    statusNode,
    pendingText: '正在读取手机原生数据…',
    operation: async () => {
      await Promise.resolve();
      throw new Error('APP_STATE_RECOVERY_MESSAGE_CHECKSUM_CONFLICT');
    }
  });

  assert.equal(ok, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '恢复角色入口');
  assert.equal(statusNode.textContent, 'APP_STATE_RECOVERY_MESSAGE_CHECKSUM_CONFLICT');
});

