import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { PresetRegistry } from '../yuqi-runtime/src/preset-registry.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const modulePath = resolve('scripts/activate-yuqi-owner-preview.mjs');
assert.equal(existsSync(modulePath), true, 'owner-preview activation module must exist');
const {
  activateOwnerPreview,
  inspectOwnerPreviewDatabase
} = await import('../scripts/activate-yuqi-owner-preview.mjs');

const SOURCE_HEAD = 'a'.repeat(40);

function seedDatabase(path) {
  const store = new YuqiStore(path);
  try {
    const presets = new PresetRegistry({
      presetDir: resolve('yuqi-runtime/presets'),
      store,
      clock: () => 1_000
    });
    const promotion = new PromotionController({ store, presetRegistry: presets, clock: () => 1_000 });
    promotion.initialize();
    store.putMessage({
      messageId: 'msg_owner_preview_history',
      turnId: 'turn_owner_preview_history',
      characterId: 'yuqi',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '以前的聊天还在。',
      sentAt: 100,
      origin: 'legacy'
    });
    store.putFact({
      factId: 'fact_owner_preview_history',
      characterId: 'yuqi',
      subjectId: 'user',
      predicate: 'prefers_continuity',
      object: { value: true },
      evidenceMode: 'uncertain',
      sourceMessageIds: ['msg_owner_preview_history'],
      exactQuotes: [],
      status: 'provisional',
      confidence: 0.8,
      origin: 'memory',
      createdAt: 101
    });
  } finally {
    store.close();
  }
}

function options(directory, databasePath, overrides = {}) {
  return {
    projectRoot: resolve('.'),
    databasePath,
    presetDir: resolve('yuqi-runtime/presets'),
    backupDir: join(directory, 'backups'),
    receiptDir: join(directory, 'receipts'),
    authorizationId: 'owner-preview-test-2026-08-13',
    authorizedAt: 50_000,
    sourceHead: SOURCE_HEAD,
    suiteChecksum: 'b'.repeat(64),
    runtimeProbe: async () => true,
    sourceHeadReader: () => SOURCE_HEAD,
    ...overrides
  };
}

test('owner preview dry-run proves the clone without mutating the source database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-dry-'));
  const databasePath = join(directory, 'runtime.sqlite');
  try {
    seedDatabase(databasePath);
    const before = inspectOwnerPreviewDatabase({ databasePath });
    const result = await activateOwnerPreview(options(directory, databasePath, { dryRun: true }));
    const after = inspectOwnerPreviewDatabase({ databasePath });

    assert.equal(result.dryRun, true);
    assert.equal(existsSync(result.backupPath), true);
    assert.equal(existsSync(result.receiptPath), true);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.facts, before.facts);
    assert.deepEqual(after.rollouts, before.rollouts);
    assert.equal(result.clone.messages.checksum, before.messages.checksum);
    assert.equal(result.clone.facts.checksum, before.facts.checksum);
    assert.equal(result.clone.direct.currentMode, 'active');
    assert.equal(result.clone.direct.candidatePhase, 'canary');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('formal owner preview activation preserves memory and changes only DIRECT_REPLY', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-live-'));
  const databasePath = join(directory, 'runtime.sqlite');
  try {
    seedDatabase(databasePath);
    const before = inspectOwnerPreviewDatabase({ databasePath });
    const result = await activateOwnerPreview(options(directory, databasePath));
    const after = inspectOwnerPreviewDatabase({ databasePath });

    assert.equal(result.dryRun, false);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.facts, before.facts);
    assert.equal(after.direct.currentMode, 'active');
    assert.equal(after.direct.candidatePhase, 'canary');
    assert.equal(after.direct.lastReasonCode, 'owner_preview_started');
    for (const [key, row] of Object.entries(before.rollouts)) {
      if (key !== 'DIRECT_REPLY') assert.deepEqual(after.rollouts[key], row);
    }
    assert.equal(after.currentPresetVersion, '1.9.2');
    assert.equal(after.candidate.presetVersion, '2.1.1');
    assert.deepEqual(after.candidate.modelProfile, {
      cognitionFast: 'gpt-5.6-sol/medium',
      cognitionDeep: 'gpt-5.6-sol/xhigh',
      expression: 'gpt-5.6-sol/medium',
      supervisor: 'gpt-5.6-sol/medium'
    });

    const replay = await activateOwnerPreview(options(directory, databasePath));
    assert.equal(replay.direct.revision, after.direct.revision);
    assert.deepEqual(inspectOwnerPreviewDatabase({ databasePath }).messages, before.messages);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('owner preview refuses to touch the database while runtime is active', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-running-'));
  const databasePath = join(directory, 'runtime.sqlite');
  try {
    seedDatabase(databasePath);
    const before = inspectOwnerPreviewDatabase({ databasePath });
    await assert.rejects(() => activateOwnerPreview(options(directory, databasePath, {
      runtimeProbe: async () => false
    })), /runtime must be stopped/);
    assert.deepEqual(inspectOwnerPreviewDatabase({ databasePath }), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a post-activation receipt failure restores the verified pre-activation snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-restore-'));
  const databasePath = join(directory, 'runtime.sqlite');
  const blockedReceiptDirectory = join(directory, 'receipt-path-is-a-file');
  try {
    seedDatabase(databasePath);
    const before = inspectOwnerPreviewDatabase({ databasePath });
    writeFileSync(blockedReceiptDirectory, 'not a directory', 'utf8');
    await assert.rejects(() => activateOwnerPreview(options(directory, databasePath, {
      receiptDir: blockedReceiptDirectory
    })), /EEXIST|ENOTDIR|directory/i);
    const restored = inspectOwnerPreviewDatabase({ databasePath });
    assert.deepEqual(restored.messages, before.messages);
    assert.deepEqual(restored.facts, before.facts);
    assert.deepEqual(restored.rollouts, before.rollouts);
    assert.equal(restored.userVersion, before.userVersion);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a source change during clone verification aborts without applying preview rollout state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-race-'));
  const databasePath = join(directory, 'runtime.sqlite');
  try {
    seedDatabase(databasePath);
    const before = inspectOwnerPreviewDatabase({ databasePath });
    let reads = 0;
    await assert.rejects(() => activateOwnerPreview(options(directory, databasePath, {
      sourceHeadReader() {
        reads += 1;
        if (reads === 2) {
          const store = new YuqiStore(databasePath);
          try {
            store.putMessage({
              messageId: 'msg_external_race', turnId: 'turn_external_race', characterId: 'yuqi',
              speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
              content: '这是激活期间真实到达的新消息。', sentAt: 200, origin: 'legacy'
            });
          } finally {
            store.close();
          }
        }
        return SOURCE_HEAD;
      }
    })), /source changed after clone verification/);
    const after = inspectOwnerPreviewDatabase({ databasePath });
    assert.deepEqual(after.rollouts, before.rollouts);
    assert.equal(after.messages.count, before.messages.count + 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
