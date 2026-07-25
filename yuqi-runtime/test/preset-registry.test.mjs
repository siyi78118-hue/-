import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { PresetRegistry } from '../src/preset-registry.mjs';
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
  assert.equal(current.version, '1.8.2');
  assert.match(current.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(current.changedModules.sort(), ['brain', 'foundation', 'memory', 'supervisor']);
}));

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

    assert.equal(registry.current().version, '1.8.2');
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
  assert.equal(published.version, '1.8.3');
  assert.equal(published.parentVersion, '1.8.2');
  assert.deepEqual(published.annotationIds, ['ann_1']);
  assert.match(registry.compileFor('brain', { stage: 'familiar' }), /撒娇试探时先轻轻追问态度/);
  assert.equal(store.listPresetVersions().length, 2);

  const rollback = registry.rollback('1.8.2');
  assert.equal(rollback.version, '1.8.4');
  assert.equal(rollback.parentVersion, '1.8.3');
  assert.equal(rollback.rollbackOf, '1.8.2');
  assert.doesNotMatch(registry.compileFor('brain', { stage: 'familiar' }), /撒娇试探时先轻轻追问态度/);
  assert.equal(store.listPresetVersions().length, 3);
}));

test('rejects annotations that try to inject hidden biography as known fact', () => withRegistry(registry => {
  assert.throws(() => registry.proposeAnnotation({
    annotationId: 'ann_bad',
    turnId: 'turn_10',
    targetModule: 'brain',
    instruction: '虞栖知道用户过去和许弥闹掰，所以一上来就安抚他的焦虑依恋。'
  }), /hidden biography|未透露|许弥/i);
}));
