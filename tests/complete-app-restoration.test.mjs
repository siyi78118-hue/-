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
