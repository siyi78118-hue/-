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

