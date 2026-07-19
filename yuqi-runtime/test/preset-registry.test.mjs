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
  assert.equal(current.version, '1.0.0');
  assert.match(current.checksum, /^[a-f0-9]{64}$/);
  assert.deepEqual(current.changedModules.sort(), ['brain', 'memory', 'supervisor']);
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

test('brain prompt starts at first acquaintance without hidden user history', () => withRegistry(registry => {
  const prompt = registry.compileFor('brain', { stage: 'initial', revealedFactIds: [] });
  assert.match(prompt, /活生生的人/);
  assert.match(prompt, /神奇的手机/);
  assert.match(prompt, /初次认识/);
  assert.match(prompt, /不得声称知道用户尚未亲口透露的经历/);
  assert.doesNotMatch(prompt, /许弥|焦虑依恋|用户曾经在许弥关系中|隐藏画像/);
}));

test('core preset preserves equality, uniqueness, and emotionally genuine speech', () => withRegistry(registry => {
  const prompt = registry.compileFor('brain', { stage: 'familiar', revealedFactIds: ['fact_1'] });
  assert.match(prompt, /双方首先平等/);
  assert.match(prompt, /唯一性|独一无二/);
  assert.match(prompt, /理性的判断.*感性的方式/s);
  assert.match(prompt, /不能.*迎合.*幼稚/s);
}));

test('each runtime role receives only its relevant module', () => withRegistry(registry => {
  const memory = registry.compileFor('memory', { stage: 'initial' });
  const supervisor = registry.compileFor('supervisor', { stage: 'initial' });
  assert.match(memory, /原始消息 ID|原话证据/);
  assert.doesNotMatch(memory, /你可以称自己想占有对方/);
  assert.match(supervisor, /说话者归属|越界知识/);
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
  assert.equal(published.version, '1.0.1');
  assert.equal(published.parentVersion, '1.0.0');
  assert.deepEqual(published.annotationIds, ['ann_1']);
  assert.match(registry.compileFor('brain', { stage: 'familiar' }), /撒娇试探时先轻轻追问态度/);
  assert.equal(store.listPresetVersions().length, 2);

  const rollback = registry.rollback('1.0.0');
  assert.equal(rollback.version, '1.0.2');
  assert.equal(rollback.parentVersion, '1.0.1');
  assert.equal(rollback.rollbackOf, '1.0.0');
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
