import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  PRESET_ROLES,
  PRESET_ROLE_ALIASES,
  PresetRegistry,
  normalizePresetRole,
  resolvePresetBundle
} from '../src/preset-registry.mjs';
import { ROLE_OUTPUT_SCHEMAS } from '../src/role-schemas.mjs';
import { YuqiStore } from '../src/store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const presetDir = join(here, '..', 'presets');

function withRegistry(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-presets-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const registry = new PresetRegistry({ presetDir, store, clock: () => 1784400000000 });
  try {
    return run(registry, store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loads a checksummed immutable seed version', () => withRegistry(registry => {
  const current = registry.current();
  assert.equal(current.version, '1.9.2');
  assert.match(current.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(current.changedModules.sort(), ['brain', 'foundation', 'memory', 'supervisor']);
}));

test('exposes cognition roles while preserving legacy turn role aliases', () => {
  assert.deepEqual(PRESET_ROLES, ['cognition', 'expression', 'consolidation', 'supervisor']);
  assert.deepEqual(PRESET_ROLE_ALIASES, {
    brain: 'expression',
    memory: 'consolidation'
  });
  assert.equal(normalizePresetRole('brain'), 'expression');
  assert.equal(normalizePresetRole('memory'), 'consolidation');
  assert.equal(normalizePresetRole('cognition'), 'cognition');
  assert.throws(() => normalizePresetRole('unknown'), /unknown preset role/);
});

test('schema 2 stores immutable legacy, current, and candidate versions', () => withRegistry((registry, store) => {
  assert.equal(registry.current().version, '1.9.2');
  assert.deepEqual(
    store.listPresetVersions().map((preset) => preset.version).sort(),
    ['1.9.1', '1.9.2', '2.0.0', '2.1.0', '2.1.1']
  );
  assert.ok(store.getPresetVersion('2.0.0'));
  assert.equal(store.getCurrentPresetVersion(), '1.9.2');
}));

test('2.1.0 is an immutable complete v3 seed without replacing older versions', () =>
  withRegistry((registry, store) => {
    const preset = store.getPresetVersion('2.1.0');
    assert.ok(store.getPresetVersion('1.9.2'));
    assert.ok(store.getPresetVersion('2.0.0'));
    assert.deepEqual(Object.keys(preset.modules).sort(), [
      'cognition',
      'consolidation',
      'expression',
      'foundation',
      'socialExperience',
      'supervisor'
    ]);
    assert.equal(store.getCurrentPresetVersion(), '1.9.2');
  }));

test('2.1.1 separates private understanding from public dialogue obligations', () =>
  withRegistry((registry, store) => {
    const previous = store.getPresetVersion('2.1.0');
    const preset = store.getPresetVersion('2.1.1');
    assert.ok(previous);
    assert.ok(preset);
    assert.match(preset.modules.cognition, /mustConvey.*公开互动义务.*不是.*心理诊断/s);
    assert.match(preset.modules.expression, /理解.*决定.*回应.*不是.*台词素材/s);
    assert.match(preset.modules.supervisor, /证明.*懂.*DIALOGUE_META_NARRATION/s);
    assert.deepEqual(Object.keys(preset.modules).sort(), [
      'cognition',
      'consolidation',
      'expression',
      'foundation',
      'socialExperience',
      'supervisor'
    ]);
    assert.equal(store.getPresetVersion('2.1.0').checksum, previous.checksum);
    assert.equal(store.getCurrentPresetVersion(), '1.9.2');
  }));

test('v3 release checksum covers baseline evaluator adapter model and schemas', () =>
  withRegistry((registry) => {
    const original = registry.pipelineReleaseManifest('2.1.0', 'release_stable_a');
    const changedInputs = [
      ['baseline', registry.pipelineReleaseManifest('2.1.0', 'release_stable_b')],
      ['evaluator', registry.pipelineReleaseManifest(
        '2.1.0',
        'release_stable_a',
        { evaluatorVersion: 'yuqi-lived-quality-v1.1' }
      )],
      ['adapter', registry.pipelineReleaseManifest(
        '2.1.0',
        'release_stable_a',
        { adapterRegistryVersion: 'cognition-v3-adapters-test' }
      )],
      ['model', registry.pipelineReleaseManifest(
        '2.1.0',
        'release_stable_a',
        { modelProfile: { cognitionFast: 'test-model' } }
      )],
      ['schema', registry.pipelineReleaseManifest(
        '2.1.0',
        'release_stable_a',
        { cognitionSchemaVersion: 4 }
      )]
    ];
    assert.equal(original.pipelineVersion, 'yuqi-lived-agency-v3');
    assert.equal(original.presetVersion, '2.1.0');
    assert.match(original.checksum, /^[a-f0-9]{64}$/);
    for (const [label, changed] of changedInputs) {
      assert.notEqual(changed.checksum, original.checksum, `${label} must affect release checksum`);
    }
    assert.deepEqual(
      registry.pipelineReleaseManifest('2.1.0', 'release_stable_a'),
      original
    );
  }));

test('resolves the exact cognition candidate in deterministic module order', () => {
  const prompt = resolvePresetBundle({
    role: 'cognition',
    version: '2.0.0',
    annotations: [
      {
        lessonId: 'lesson_emotion_before_function'
      },
      {
        annotationId: 'ann_cognition_1',
        targetModule: 'cognition',
        instruction: '本轮保留两个有证据的解释，不把次解释写成事实。'
      }
    ]
  });
  const foundationIndex = prompt.indexOf('你正在进行中文手机私聊式角色扮演');
  const cognitionIndex = prompt.indexOf('# 虞栖认知核心');
  const lessonsIndex = prompt.indexOf('## 已批准社会经验');
  const annotationsIndex = prompt.indexOf('## cognition 人工标注');
  assert.ok(foundationIndex >= 0);
  assert.ok(foundationIndex < cognitionIndex);
  assert.ok(cognitionIndex < lessonsIndex);
  assert.ok(lessonsIndex < annotationsIndex);
  assert.match(prompt, /lesson_emotion_before_function/);
  assert.doesNotMatch(prompt, /lesson_gift_as_relationship_action/);
  assert.match(prompt, /本轮保留两个有证据的解释/);
});

test('candidate expression and consolidation stay isolated', () => {
  const expression = resolvePresetBundle({
    role: 'expression',
    version: '2.0.0',
    annotations: []
  });
  const consolidation = resolvePresetBundle({
    role: 'consolidation',
    version: '2.0.0',
    annotations: []
  });
  assert.match(expression, /微信|气泡/);
  assert.doesNotMatch(expression, /事实候选|写入记忆库|取代关系/);
  assert.match(consolidation, /事实候选|证据/);
  assert.match(consolidation, /不得替虞栖写回复|不得生成可发送台词/);
  assert.doesNotMatch(consolidation, /请(?:直接)?输出(?:可发送台词|聊天正文)/);
  assert.throws(
    () => resolvePresetBundle({ role: 'unknown', version: '2.0.0', annotations: [] }),
    /unknown preset role/
  );
});

test('reads a schema 1 manifest and restores legacy brain and memory turns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-presets-schema1-'));
  const fixturePresetDir = join(dir, 'presets');
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    mkdirSync(fixturePresetDir, { recursive: true });
    writeFileSync(join(fixturePresetDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      currentVersion: '1.9.1',
      characterId: 'yuqi',
      modules: {
        foundation: 'foundation.md',
        brain: 'brain.md',
        memory: 'memory.md',
        supervisor: 'supervisor.md'
      }
    }), 'utf8');
    writeFileSync(join(fixturePresetDir, 'foundation.md'), 'legacy foundation', 'utf8');
    writeFileSync(join(fixturePresetDir, 'brain.md'), 'legacy brain', 'utf8');
    writeFileSync(join(fixturePresetDir, 'memory.md'), 'legacy memory evidence', 'utf8');
    writeFileSync(join(fixturePresetDir, 'supervisor.md'), 'legacy supervisor', 'utf8');

    const registry = new PresetRegistry({
      presetDir: fixturePresetDir,
      store,
      clock: () => 1000
    });
    assert.match(registry.compileFor('brain', { stage: 'initial' }), /legacy foundation[\s\S]*legacy brain/);
    assert.match(registry.compileFor('memory', { stage: 'initial' }), /legacy memory evidence/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reopens a durable seed without changing its publication manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-presets-reopen-'));
  const databasePath = join(dir, 'runtime.sqlite');
  let secondStore;
  try {
    const firstStore = new YuqiStore(databasePath);
    const first = new PresetRegistry({ presetDir, store: firstStore, clock: () => 1000 }).current();
    firstStore.close();

    secondStore = new YuqiStore(databasePath);
    const reopened = new PresetRegistry({ presetDir, store: secondStore, clock: () => 2000 }).current();
    assert.deepEqual(reopened, first);
    secondStore.close();
    secondStore = null;
  } finally {
    secondStore?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promotes an older current seed to the newer packaged preset version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-presets-upgrade-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    store.putPresetVersion({
      version: '1.0.0', parentVersion: null, characterId: 'yuqi',
      modules: { brain: 'old brain', memory: 'old memory', supervisor: 'old supervisor' },
      changedModules: ['brain', 'memory', 'supervisor'], annotationIds: [], rollbackOf: null,
      checksum: 'old-seed-checksum', publishedAt: 1000
    });
    store.setCurrentPresetVersion('1.0.0');

    const registry = new PresetRegistry({ presetDir, store, clock: () => 2000 });

    assert.equal(registry.current().version, '1.9.2');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('brain prompt starts at first acquaintance without hidden user history', () => withRegistry(registry => {
  const prompt = registry.compileFor('brain', { stage: 'initial', revealedFactIds: [] });
  assert.ok(prompt.indexOf('你正在进行中文手机私聊式角色扮演') < prompt.indexOf('# 虞栖核心人物预设'));
  assert.match(prompt, /活生生的人/);
  assert.match(prompt, /一次意外.*手机.*平行世界.*联系/s);
  assert.match(prompt, /24岁.*现代临江城市/s);
  assert.match(prompt, /初识/);
  assert.match(prompt, /不得声称知道用户尚未亲口透露的经历/);
  assert.doesNotMatch(prompt, /神奇的手机/);
  assert.doesNotMatch(prompt, /许弥|焦虑依恋|用户曾经在许弥关系中|隐藏画像/);
}));

test('core preset preserves equality, uniqueness, and emotionally genuine speech', () => withRegistry(registry => {
  const prompt = registry.compileFor('brain', { stage: 'familiar', revealedFactIds: ['fact_1'] });
  assert.match(prompt, /亲密关系以平等为起点/);
  assert.match(prompt, /唯一的爱人和心中最重要的人/);
  assert.match(prompt, /理性的内核.*感性/s);
  assert.match(prompt, /调情来自真实的心动和兴趣/);
}));

test('all role prompts receive the authoritative dynamic relationship stage', () => withRegistry(registry => {
  const scene = {
    kind: 'DIRECT_REPLY',
    playerName: '姜隽倚',
    characterName: '虞栖',
    relationshipStage: { id: 'familiar', label: '熟悉', content: '双方已经形成稳定聊天习惯。' },
    conversationExtraPrompt: '今天回复可以短一点。',
    globalExtraPrompt: '不要客服腔。'
  };
  for (const role of ['memory', 'brain', 'supervisor']) {
    const prompt = registry.compileFor(role, { scene });
    assert.match(prompt, /当前关系阶段：熟悉（familiar）/);
    assert.match(prompt, /双方已经形成稳定聊天习惯/);
    assert.match(prompt, /姜隽倚/);
  }
}));

test('brain preset supports silent proactive decisions without leaking them into visible chat text', () => withRegistry(registry => {
  const prompt = registry.compileFor('brain', { stage: 'initial' });
  assert.match(prompt, /主动联系不是必须发言/);
  assert.match(prompt, /action: "skip".*本轮不发送/s);
  assert.match(prompt, /不要把.*判断写给用户看/s);
  assert.match(prompt, /不要把.*JSON.*塞进.*reply/s);
}));

test('brain and supervisor honor a general proactive delivery policy without literal phrase rules', () => withRegistry(registry => {
  const brain = registry.compileFor('brain', { stage: 'initial' });
  const supervisor = registry.compileFor('supervisor', { stage: 'initial' });

  assert.match(brain, /deliveryPolicy/);
  assert.match(brain, /skipAllowed/);
  assert.match(brain, /不要求服从用户的字面命令/);
  assert.match(supervisor, /deliveryPolicy\.skipAllowed=false/);
  assert.match(supervisor, /PROACTIVE_DELIVERY_REQUIRED/);
  assert.doesNotMatch(brain, /暂时不理你|你自己去玩/);
  assert.doesNotMatch(supervisor, /暂时不理你|你自己去玩/);
}));

test('memory stays isolated while supervisor receives the authoritative generation presets', () => withRegistry(registry => {
  const memory = registry.compileFor('memory', { stage: 'initial' });
  const supervisor = registry.compileFor('supervisor', { stage: 'initial' });
  assert.match(memory, /原始消息 ID|原话证据/);
  assert.doesNotMatch(memory, /你正在进行中文手机私聊式角色扮演/);
  assert.doesNotMatch(memory, /你可以称自己想占有对方/);
  assert.match(supervisor, /说话者归属|越界知识/);
  assert.match(supervisor, /你正在进行中文手机私聊式角色扮演/);
  assert.match(supervisor, /# 虞栖核心人物预设/);
  assert.doesNotMatch(supervisor, /候选事实抽取格式/);
}));

test('memory schema exposes temporary interaction boundaries and correction evidence', () => {
  const frame = ROLE_OUTPUT_SCHEMAS.memory.properties.conversationFrame;
  const boundaries = frame.properties.explicitBoundaries;
  const correction = frame.properties.recentCorrection;

  assert.equal(boundaries.type, 'array');
  assert.deepEqual(boundaries.items.required, ['type', 'active', 'reason', 'evidenceMessageIds']);
  assert.deepEqual(
    correction.required,
    ['active', 'rejectedInterpretation', 'expiresAfterBatches', 'evidenceMessageIds']
  );
  assert.equal(correction.properties.expiresAfterBatches.type, 'integer');
});

test('memory preset prioritizes whole-interaction evidence without writing dialogue for Yuqi', () => withRegistry(registry => {
  const memory = registry.compileFor('memory', { stage: 'familiar' });

  assert.match(memory, /整段互动.*字面|字面.*整段互动/s);
  assert.match(memory, /冲突|冷却|开放话题/);
  assert.match(memory, /明确纠正.*临时|临时.*明确纠正/s);
  assert.match(memory, /不得.*台词|不.*替.*写.*回复/s);
  assert.doesNotMatch(memory, /“你干嘛”|“\\？”|厨房/);
}));

test('brain and supervisor presets define an executable closed rewrite handshake', () => withRegistry(registry => {
  const brain = registry.compileFor('brain', { stage: 'initial' });
  const supervisor = registry.compileFor('supervisor', { stage: 'initial' });

  assert.match(brain, /rewriteContract/);
  assert.match(brain, /rewriteResolution/);
  assert.match(brain, /formedCharacterFacts/);
  assert.match(supervisor, /mustPreserve/);
  assert.match(supervisor, /allowedStrategies/);
  assert.match(supervisor, /acceptanceCriteria/);
  assert.match(supervisor, /不得.*新增.*软性问题|软性问题.*不得.*新增/s);
  assert.match(supervisor, /直接私聊.*必须.*可发送|可发送.*直接私聊/s);
}));

test('brain treats the interaction contract as behavior constraints instead of dialogue material', () => withRegistry(registry => {
  const brain = registry.compileFor('brain', { stage: 'familiar' });

  assert.match(brain, /interactionContract|互动契约/);
  assert.match(brain, /不能忽略|必须遵守|权威/s);
  assert.match(brain, /preserveAmbiguity|保留歧义/);
  assert.match(brain, /不得.*逐项.*解释|不得.*复述.*契约/s);
  assert.doesNotMatch(brain, /conversationFrame.*最终仍以原始聊天为准/);
}));

test('supervisor checks contract action and report-like narration before style', () => withRegistry(registry => {
  const supervisor = registry.compileFor('supervisor', { stage: 'familiar' });

  assert.match(supervisor, /互动动作.*语气|先.*互动.*再.*语气/s);
  assert.match(supervisor, /INTERACTION_CONTRACT_MISS/);
  assert.match(supervisor, /REPEATED_REJECTED_INTERPRETATION/);
  assert.match(supervisor, /DIALOGUE_META_NARRATION/);
  assert.match(supervisor, /身处.*对话.*复盘|复盘.*对话.*身处/s);
  assert.match(supervisor, /mustPreserve.*mustChange.*allowedStrategies.*acceptanceCriteria/s);
}));

test('publishes an annotation as a child version and can roll back immutably', () => withRegistry((registry, store) => {
  const proposal = registry.proposeAnnotation({
    annotationId: 'ann_1',
    turnId: 'turn_9',
    sourceMessageId: 'msg_9',
    targetModule: 'brain',
    instruction: '撒娇试探时先轻轻追问态度，不立刻上升为关系结论。'
  });
  assert.equal(proposal.status, 'proposed');

  const published = registry.publishVersion(proposal.proposalId);
  assert.equal(published.version, '1.9.3');
  assert.equal(published.parentVersion, '1.9.2');
  assert.deepEqual(published.annotationIds, ['ann_1']);
  assert.match(registry.compileFor('brain', { stage: 'familiar' }), /撒娇试探时先轻轻追问态度/);
  assert.equal(store.listPresetVersions().length, 6);

  const rollback = registry.rollback('1.9.1');
  assert.equal(rollback.version, '1.9.4');
  assert.equal(rollback.parentVersion, '1.9.3');
  assert.equal(rollback.rollbackOf, '1.9.1');
  assert.doesNotMatch(registry.compileFor('brain', { stage: 'familiar' }), /撒娇试探时先轻轻追问态度/);
  assert.equal(store.listPresetVersions().length, 7);
}));

test('rejects annotations that try to inject hidden biography as known fact', () => withRegistry(registry => {
  assert.throws(() => registry.proposeAnnotation({
    annotationId: 'ann_bad',
    turnId: 'turn_10',
    targetModule: 'brain',
    instruction: '虞栖知道用户过去和许弥闹掰，所以一上来就安抚他的焦虑依恋。'
  }), /hidden biography|未透露|许弥/i);
}));
