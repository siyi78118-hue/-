import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DELETED_XUMI_ID = 'char_1783694247588_zojx';

function restorationModule() {
  const path = require.resolve('../tavern-app/lib/complete-app-restoration.js');
  delete require.cache[path];
  return require(path);
}

function state(character = null, extras = {}) {
  return {
    settings: extras.settings || {},
    characters: character ? [character] : [],
    allChats: extras.allChats || {},
    allMoments: extras.allMoments || [],
    updatedAt: extras.updatedAt || 0
  };
}

function builtinYuqi() {
  return {
    id: 'yuqi',
    name: '虞栖',
    avatar: '栖',
    description: '正式人物设定',
    personality: '正式说话方式',
    scenario: '正式关系设定',
    firstMessage: '',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    tags: ['虞栖', '专属AL']
  };
}

test('complete restoration uses field-level source priority and permanently excludes the confirmed deleted role', async () => {
  const { buildPlan } = restorationModule();
  const plan = await buildPlan({
    current: state({ id: 'yuqi', name: '虞栖', avatarData: 'data:image/png;base64,YQ==' }),
    recoveryBefore: state({ id: 'yuqi', name: '虞栖', description: '恢复前人物设定' }),
    legacy: state({ id: 'yuqi', name: '虞栖', personality: '旧版说话方式' }),
    mirror: state({ id: 'yuqi', name: '虞栖', scenario: '镜像关系设定' }),
    native: {
      roles: [
        { characterId: 'yuqi', rawMessageCount: 1759, systemPrompt: '编译后的执行提示词' },
        { characterId: DELETED_XUMI_ID, rawMessageCount: 0 }
      ],
      messages: []
    },
    builtinYuqi: builtinYuqi(),
    deletionTargets: [DELETED_XUMI_ID]
  });

  assert.deepEqual(plan.excludedRoleIds, [DELETED_XUMI_ID]);
  assert.equal(plan.roles.yuqi.avatarData, 'data:image/png;base64,YQ==');
  assert.equal(plan.roles.yuqi.description, '恢复前人物设定');
  assert.equal(plan.roles.yuqi.personality, '旧版说话方式');
  assert.equal(plan.roles.yuqi.scenario, '镜像关系设定');
  assert.equal(plan.roles.yuqi.systemPrompt, '');
  assert.equal(JSON.stringify(plan).includes('编译后的执行提示词'), false);
  assert.equal(Object.hasOwn(plan.roles, DELETED_XUMI_ID), false);
  assert.equal(plan.report.categories.avatar.status, 'already_present');
});

test('only the explicitly confirmed character id can become a restoration deletion target', async () => {
  const { buildPlan } = restorationModule();
  await assert.rejects(() => buildPlan({
    current: state(), recoveryBefore: state(), legacy: state(), mirror: state(),
    native: { roles: [{ characterId: 'empty-but-valid', rawMessageCount: 0 }] },
    builtinYuqi: builtinYuqi(), deletionTargets: ['empty-but-valid']
  }), /APP_RESTORATION_DELETION_TARGET_CONFLICT/);

  const plan = await buildPlan({
    current: state(), recoveryBefore: state(), legacy: state(), mirror: state(),
    native: { roles: [{ characterId: 'empty-but-valid', rawMessageCount: 0 }] },
    builtinYuqi: builtinYuqi(), deletionTargets: []
  });
  assert.deepEqual(plan.excludedRoleIds, []);
  assert.deepEqual(plan.report.unconfirmedEmptyRoleIds, ['empty-but-valid']);
});

test('the frozen Yuqi profile fills only missing editable fields and never fabricates an avatar', async () => {
  const { buildPlan } = restorationModule();
  const plan = await buildPlan({
    current: state({ id: 'yuqi', name: '虞栖' }),
    recoveryBefore: state(), legacy: state(), mirror: state(),
    native: { roles: [{ characterId: 'yuqi', rawMessageCount: 1759, systemPrompt: 'compiled' }] },
    builtinYuqi: builtinYuqi(), deletionTargets: [DELETED_XUMI_ID]
  });

  assert.equal(plan.roles.yuqi.description, '正式人物设定');
  assert.equal(plan.roles.yuqi.personality, '正式说话方式');
  assert.equal(plan.roles.yuqi.scenario, '正式关系设定');
  assert.equal(plan.roles.yuqi.avatarData, null);
  assert.deepEqual(plan.report.categories.avatar, {
    status: 'no_verified_source', reasonCode: 'avatar_bytes_missing'
  });
});

test('current messages win conflicts while verified missing native messages are added once', async () => {
  const { buildPlan, applyWebCandidate } = restorationModule();
  const current = state({ id: 'yuqi', name: '虞栖' }, {
    allChats: { yuqi: { messages: [{ id: 'm2', role: 'assistant', content: 'current', time: 2 }] } }
  });
  const plan = await buildPlan({
    current,
    recoveryBefore: state(null, {
      allChats: { yuqi: { messages: [{ id: 'm1', role: 'user', content: 'before', time: 1 }] } }
    }),
    legacy: state(), mirror: state(), builtinYuqi: builtinYuqi(),
    native: { messages: [
      { id: 'm2', role: 'assistant', content: 'native-conflict', time: 2 },
      { id: 'm3', role: 'assistant', content: 'native-new', time: 3 }
    ] },
    deletionTargets: [DELETED_XUMI_ID]
  });
  const restored = applyWebCandidate(current, plan);
  assert.deepEqual(restored.allChats.yuqi.messages.map(row => row.id), ['m1', 'm2', 'm3']);
  assert.equal(restored.allChats.yuqi.messages.find(row => row.id === 'm2').content, 'current');
  const repeated = applyWebCandidate(restored, plan);
  assert.deepEqual(repeated, restored);
});

test('native moments require explicit verified evidence and are never inferred from ordinary chat', async () => {
  const { buildPlan } = restorationModule();
  const plan = await buildPlan({
    current: state({ id: 'yuqi', name: '虞栖' }),
    recoveryBefore: state(), legacy: state(), mirror: state(), builtinYuqi: builtinYuqi(),
    native: {
      messages: [{ id: 'chat-mentions-moment', role: 'assistant', content: '我发了朋友圈', time: 1 }],
      momentEvidence: []
    },
    deletionTargets: [DELETED_XUMI_ID]
  });
  assert.deepEqual(plan.moments, []);
});

test('web restoration collector reads every intact source without deleting recovery snapshots', async () => {
  const { collectWebRestorationSources, readVerifiedAvatarCandidate } = restorationModule();
  const { sha256CanonicalJson } = require('../tavern-app/lib/app-state-recovery.js');
  const beforeRaw = {
    rpchat_settings: JSON.stringify({ playerName: '恢复前用户' }),
    rpchat_characters: JSON.stringify([{
      id: 'yuqi', name: '虞栖', description: '恢复前资料',
      avatarData: 'data:image/png;base64,YmVmb3Jl'
    }]),
    rpchat_chats: JSON.stringify({ yuqi: { messages: [{ id: 'before-message', content: '旧消息' }] } }),
    rpchat_moments: '[]',
    rpchat_app_state_updated_at: '10'
  };
  const preMirrorValue = state({
    id: 'yuqi', name: '虞栖', personality: '恢复前镜像性格',
    avatarData: 'data:image/png;base64,cHJlLW1pcnJvcg=='
  });
  const preMirrorRecord = {
    version: 1,
    present: true,
    value: preMirrorValue
  };
  preMirrorRecord.checksum = await sha256CanonicalJson({
    present: preMirrorRecord.present,
    value: preMirrorRecord.value
  });
  const values = new Map([
    ['tavern_settings', JSON.stringify({ playerName: '旧版用户' })],
    ['tavern_characters', JSON.stringify([{
      id: 'yuqi', name: '虞栖', scenario: '旧版关系',
      avatarData: 'data:image/png;base64,bGVnYWN5'
    }])],
    ['tavern_chats', '{}'],
    ['tavern_moments', '[]'],
    ['tavern_app_state_updated_at', '5']
  ]);
  const storage = { getItem: key => values.has(key) ? values.get(key) : null };
  const journalReads = [];
  const journal = {
    async get(key) {
      journalReads.push(key);
      if (key === 'recovery_before_v1') return beforeRaw;
      if (key === 'recovery_before_mirror_v1') return preMirrorRecord;
      return null;
    },
    async put() { throw new Error('collector must be read-only'); }
  };

  const sources = await collectWebRestorationSources({
    current: state({ id: 'yuqi', name: '虞栖' }),
    storage,
    journal,
    mirror: state({ id: 'yuqi', name: '虞栖', creatorNotes: '当前镜像' }),
    builtinYuqi: builtinYuqi(),
    sha256CanonicalJson
  });

  assert.deepEqual(journalReads, ['recovery_before_v1', 'recovery_before_mirror_v1']);
  assert.equal(sources.recoveryBefore.characters[0].description, '恢复前资料');
  assert.equal(sources.legacy.characters[0].scenario, '旧版关系');
  assert.equal(sources.preRecoveryMirror.characters[0].personality, '恢复前镜像性格');
  assert.equal(sources.mirror.characters[0].creatorNotes, '当前镜像');
  assert.equal(readVerifiedAvatarCandidate('yuqi', sources).source, 'recovery_before');
});

test('avatar recovery is role-bound, priority-ordered, and never scrapes malformed JSON', async () => {
  const { collectWebRestorationSources, readVerifiedAvatarCandidate } = restorationModule();
  const values = new Map([
    ['tavern_characters', JSON.stringify([
      { id: 'not-yuqi', avatarData: 'data:image/png;base64,d3Jvbmc=' },
      { id: 'yuqi', avatarData: 'not-an-image' }
    ])],
    ['tavern_settings', '{}'], ['tavern_chats', '{}'], ['tavern_moments', '[]']
  ]);
  const sources = await collectWebRestorationSources({
    current: state({ id: 'yuqi', name: '虞栖' }),
    storage: { getItem: key => values.get(key) ?? null },
    journal: {
      async get(key) {
        if (key === 'recovery_before_v1') {
          return {
            rpchat_settings: '{}',
            rpchat_characters: '[{"id":"yuqi","avatarData":"data:image/png;base64,c2VjcmV0"}',
            rpchat_chats: '{}', rpchat_moments: '[]', rpchat_app_state_updated_at: '1'
          };
        }
        return null;
      }
    },
    mirror: state(), builtinYuqi: builtinYuqi()
  });

  assert.equal(readVerifiedAvatarCandidate('yuqi', sources), null);
  assert.deepEqual(sources.invalidSources, ['recovery_before:rpchat_characters']);
});

test('pre-recovery mirror checksum mismatch rejects the complete source collection', async () => {
  const { collectWebRestorationSources } = restorationModule();
  await assert.rejects(() => collectWebRestorationSources({
    current: state(), storage: { getItem: () => null },
    journal: {
      async get(key) {
        return key === 'recovery_before_mirror_v1'
          ? { version: 1, present: true, value: state(), checksum: '0'.repeat(64) }
          : null;
      }
    },
    mirror: state(), builtinYuqi: builtinYuqi(),
    sha256CanonicalJson: async () => '1'.repeat(64)
  }), /APP_RESTORATION_PRE_MIRROR_CHECKSUM_CONFLICT/);
});

async function checksummedRow(value) {
  const { sha256CanonicalJson } = require('../tavern-app/lib/app-state-recovery.js');
  return { ...value, sourceChecksum: await sha256CanonicalJson(value) };
}

async function nativePage(contract, rows, nextCursor, hasMore, snapshotToken = 'sha256:' + 'a'.repeat(64)) {
  const { sha256CanonicalJson } = require('../tavern-app/lib/app-state-recovery.js');
  const basis = { contract, characterId: 'yuqi', snapshotToken, nextCursor, hasMore, rows };
  return { ...basis, pageChecksum: await sha256CanonicalJson(basis) };
}

test('native recovery page drain preserves three-page order and rejects snapshot or identity drift', async () => {
  const { readAllNativeRecoveryPages } = restorationModule();
  const rows = [
    await checksummedRow({ replyPartId: 'part-1', turnId: 'turn-1', attemptId: 'attempt-1',
      sequence: 0, type: 'TEXT', content: '第一泡', payload: {}, createdAt: 10 }),
    await checksummedRow({ replyPartId: 'part-2', turnId: 'turn-1', attemptId: 'attempt-1',
      sequence: 1, type: 'PAYMENT_STATUS', content: '', payload: { status: 'received' }, createdAt: 11 }),
    await checksummedRow({ replyPartId: 'part-3', turnId: 'turn-2', attemptId: 'attempt-2',
      sequence: 0, type: 'FUTURE_NATIVE_ACTION', content: '', payload: { retained: true }, createdAt: 12 })
  ];
  const pages = [
    await nativePage('android-app-recovery-reply-part-v1', [rows[0]],
      { afterCreatedAt: 10, afterId: 'part-1' }, true),
    await nativePage('android-app-recovery-reply-part-v1', [rows[1]],
      { afterCreatedAt: 11, afterId: 'part-2' }, true),
    await nativePage('android-app-recovery-reply-part-v1', [rows[2]],
      { afterCreatedAt: 12, afterId: 'part-3' }, false)
  ];
  const plugin = {
    async readAppRecoveryReplyParts({ afterId }) {
      return pages[afterId === '' ? 0 : afterId === 'part-1' ? 1 : 2];
    }
  };
  const result = await readAllNativeRecoveryPages(
    plugin, 'readAppRecoveryReplyParts', 'yuqi', { limit: 1 });
  assert.deepEqual(result.rows.map(row => row.replyPartId), ['part-1', 'part-2', 'part-3']);
  assert.equal(result.snapshotToken, 'sha256:' + 'a'.repeat(64));

  const changed = structuredClone(pages);
  changed[1] = await nativePage('android-app-recovery-reply-part-v1', [rows[1]],
    { afterCreatedAt: 11, afterId: 'part-2' }, true, 'sha256:' + 'b'.repeat(64));
  await assert.rejects(() => readAllNativeRecoveryPages({
    async readAppRecoveryReplyParts({ afterId }) {
      return changed[afterId === '' ? 0 : afterId === 'part-1' ? 1 : 2];
    }
  }, 'readAppRecoveryReplyParts', 'yuqi', { limit: 1 }),
  /APP_RESTORATION_NATIVE_SNAPSHOT_CHANGED/);

  const duplicate = structuredClone(pages);
  duplicate[1] = await nativePage('android-app-recovery-reply-part-v1', [rows[0]],
    { afterCreatedAt: 10, afterId: 'part-1' }, true);
  await assert.rejects(() => readAllNativeRecoveryPages({
    async readAppRecoveryReplyParts({ afterId }) { return duplicate[afterId === '' ? 0 : 1]; }
  }, 'readAppRecoveryReplyParts', 'yuqi', { limit: 1 }),
  /APP_RESTORATION_NATIVE_CURSOR_CONFLICT/);
});

test('native evidence mappers preserve lossless rows and report unsupported actions as native-only', async () => {
  const { mapNativeReplyEvidence, mapNativeMemoryRows, mapNativeRolePlanRows } = restorationModule();
  const replyRows = [
    await checksummedRow({ replyPartId: 'part-text', turnId: 'turn-1', attemptId: 'attempt-1',
      sequence: 0, type: 'TEXT', content: '正文', payload: {}, createdAt: 10 }),
    await checksummedRow({ replyPartId: 'part-action', turnId: 'turn-1', attemptId: 'attempt-1',
      sequence: 1, type: 'FUTURE_NATIVE_ACTION', content: '', payload: { exact: true }, createdAt: 11 })
  ];
  const reply = mapNativeReplyEvidence(replyRows);
  assert.equal(reply.messages[0].id, 'part-text');
  assert.equal(reply.nativeOnly[0].replyPartId, 'part-action');
  assert.deepEqual(reply.nativeOnly[0].payload, { exact: true });

  const memoryRow = await checksummedRow({
    memoryId: 'memory-1', sourceKey: 'event:1', characterId: 'yuqi', type: 'EVENT',
    title: '标题', content: '内容', vectorJson: '[0.25,-0.5]', eventTime: 12,
    createdAt: 13, updatedAt: 14, manual: true
  });
  const memory = mapNativeMemoryRows([memoryRow]);
  assert.equal(memory[0].storeName, 'events');
  assert.deepEqual(memory[0].vector, [0.25, -0.5]);
  assert.equal(memory[0].item.manual, true);

  const planRow = await checksummedRow({
    planId: 'plan-1', characterId: 'yuqi', status: 'active',
    planJson: { planId: 'plan-1', characterId: 'yuqi', status: 'active' },
    nextRunAt: 20, updatedAt: 21,
    history: [{ historyId: 'history-1', planId: 'plan-1',
      historyJson: { historyId: 'history-1', planId: 'plan-1' }, createdAt: 20,
      sourceChecksum: 'c'.repeat(64) }]
  });
  const plans = mapNativeRolePlanRows([planRow]);
  assert.equal(plans.plans[0].planId, 'plan-1');
  assert.equal(plans.history[0].historyId, 'history-1');
});

function completeTransactionHarness() {
  const before = {
    web: { characters: [{ id: 'yuqi', name: '旧虞栖' }], allChats: {}, allMoments: [] },
    mirror: { version: 'before' },
    memories: [{ storeName: 'events', item: { id: 'old-memory', charId: 'yuqi' }, vector: [] }],
    rolePlans: { plans: [{ planId: 'old-plan', characterId: 'yuqi' }], history: [] }
  };
  const state = structuredClone(before);
  const journalRows = new Map();
  const events = [];
  const stores = Object.fromEntries(Object.keys(state).map(name => [name, {
    async read() { events.push(`read:${name}`); return structuredClone(state[name]); },
    async write(value) { events.push(`write:${name}`); state[name] = structuredClone(value); },
    async restore(value) { events.push(`restore:${name}`); state[name] = structuredClone(value); }
  }]));
  return {
    before, state, stores, events, journalRows,
    journal: {
      async get(key) { return structuredClone(journalRows.get(key) ?? null); },
      async put(key, value) { journalRows.set(key, structuredClone(value)); }
    }
  };
}

function completeTransactionTarget() {
  return {
    web: {
      characters: [{ id: 'yuqi', name: '虞栖' }],
      allChats: { yuqi: { messages: [{ id: 'm1', content: '找回的消息' }] } },
      allMoments: [{ id: 'moment-1' }]
    },
    mirror: { version: 'restored' },
    memories: [{ storeName: 'events', item: { id: 'memory-1', charId: 'yuqi' }, vector: [0.5] }],
    rolePlans: { plans: [{ planId: 'plan-1', characterId: 'yuqi' }], history: [] }
  };
}

test('complete restoration persists the exact confirmed deletion before atomically verifying every store', async () => {
  const { runCompleteRestorationTransaction } = restorationModule();
  const harness = completeTransactionHarness();
  const target = completeTransactionTarget();
  const deletionCalls = [];
  let unlocked = '';
  const result = await runCompleteRestorationTransaction({
    journal: harness.journal,
    stores: harness.stores,
    target,
    ensureDeletion: async characterId => {
      deletionCalls.push(characterId);
      harness.events.push('deletion');
      return { state: 'waiting', controlId: 'delete-xumi' };
    },
    unlock: checksum => { unlocked = checksum; harness.events.push('unlock'); },
    now: 100
  });

  assert.deepEqual(deletionCalls, [DELETED_XUMI_ID]);
  assert.deepEqual(harness.state, target);
  assert.match(unlocked, /^[0-9a-f]{64}$/);
  assert.equal(result.state, 'committed');
  assert.equal(result.deletionState, 'waiting');
  assert.ok(harness.events.indexOf('deletion') < harness.events.indexOf('write:web'));
  const journal = harness.journalRows.get('complete_restoration_v1');
  assert.deepEqual(Object.keys(journal).sort(), [
    'beforeChecksums', 'candidateChecksum', 'categoryChecksums', 'categoryCounts',
    'committedAt', 'deletionCharacterId', 'deletionState', 'preparedAt', 'state', 'version'
  ].sort());
  assert.equal(JSON.stringify(journal).includes('找回的消息'), false);
  assert.equal(JSON.stringify(journal).includes('old-memory'), false);
});

test('faults after deletion or any store write roll every recoverable store back but retain deletion authority', async () => {
  const { runCompleteRestorationTransaction } = restorationModule();
  for (let boundary = 1; boundary <= 8; boundary += 1) {
    const harness = completeTransactionHarness();
    let deletionCount = 0;
    await assert.rejects(() => runCompleteRestorationTransaction({
      journal: harness.journal,
      stores: harness.stores,
      target: completeTransactionTarget(),
      ensureDeletion: async characterId => {
        assert.equal(characterId, DELETED_XUMI_ID);
        deletionCount += 1;
        return { state: 'pending', controlId: 'delete-xumi' };
      },
      unlock: () => {},
      now: 100,
      faultAfter: boundary
    }), new RegExp(`APP_RESTORATION_FAULT_${boundary}`));
    assert.deepEqual(harness.state, harness.before, `boundary ${boundary}`);
    assert.equal(harness.journalRows.get('complete_restoration_v1').state, 'rolled_back');
    if (boundary >= 2) assert.equal(deletionCount, 1);
  }
});

test('a failed verified-backup deletion intent performs zero restoration writes', async () => {
  const { runCompleteRestorationTransaction } = restorationModule();
  const harness = completeTransactionHarness();
  await assert.rejects(() => runCompleteRestorationTransaction({
    journal: harness.journal,
    stores: harness.stores,
    target: completeTransactionTarget(),
    ensureDeletion: async () => { throw new Error('BACKUP_UNAVAILABLE'); },
    unlock: () => {}
  }), /BACKUP_UNAVAILABLE/);
  assert.deepEqual(harness.state, harness.before);
  assert.equal(harness.events.some(event => event.startsWith('write:')), false);
});

test('complete restoration is idempotent and never reintroduces the confirmed deleted role', async () => {
  const { buildPlan, applyWebCandidate, runCompleteRestorationTransaction } = restorationModule();
  const current = state({ id: DELETED_XUMI_ID, name: '许弥' }, {
    allChats: { [DELETED_XUMI_ID]: { messages: [{ id: 'x1', content: '旧数据' }] } }
  });
  const plan = await buildPlan({
    current,
    recoveryBefore: current,
    legacy: current,
    mirror: current,
    builtinYuqi: builtinYuqi(),
    native: { roles: [{ characterId: 'yuqi', rawMessageCount: 1759 }] },
    deletionTargets: [DELETED_XUMI_ID]
  });
  const web = applyWebCandidate(current, plan);
  assert.equal(web.characters.some(row => row.id === DELETED_XUMI_ID), false);
  assert.equal(Object.hasOwn(web.allChats, DELETED_XUMI_ID), false);

  const harness = completeTransactionHarness();
  const target = { ...completeTransactionTarget(), web };
  const options = {
    journal: harness.journal, stores: harness.stores, target,
    ensureDeletion: async () => ({ state: 'applied', controlId: 'delete-xumi' }),
    unlock: () => {}, now: 100
  };
  await runCompleteRestorationTransaction(options);
  const once = structuredClone(harness.state);
  await runCompleteRestorationTransaction(options);
  assert.deepEqual(harness.state, once);
});

test('startup rolls an interrupted complete restoration back from checksum-closed before images', async () => {
  const { rollbackPreparedCompleteRestoration } = restorationModule();
  const { sha256CanonicalJson } = require('../tavern-app/lib/app-state-recovery.js');
  const harness = completeTransactionHarness();
  const beforeChecksums = {};
  for (const [name, value] of Object.entries(harness.before)) {
    beforeChecksums[name] = await sha256CanonicalJson(value);
    harness.journalRows.set('complete_restoration_before_' + name + '_v1', structuredClone(value));
    harness.state[name] = { interrupted: name };
  }
  harness.journalRows.set('complete_restoration_v1', {
    version: 1, state: 'prepared', deletionCharacterId: DELETED_XUMI_ID,
    deletionState: 'pending', beforeChecksums,
    candidateChecksum: 'a'.repeat(64),
    categoryChecksums: {
      roles: 'b'.repeat(64), chats: 'c'.repeat(64), moments: 'd'.repeat(64),
      memories: 'e'.repeat(64), rolePlans: 'f'.repeat(64)
    },
    categoryCounts: { roles: 1, chats: 1, moments: 0, memories: 1, rolePlans: 1 },
    preparedAt: 100, committedAt: null
  });
  assert.equal(await rollbackPreparedCompleteRestoration({
    journal: harness.journal, stores: harness.stores
  }), true);
  assert.deepEqual(harness.state, harness.before);
  assert.equal(harness.journalRows.get('complete_restoration_v1').state, 'rolled_back');
});
