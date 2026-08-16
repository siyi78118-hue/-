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
