import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COGNITION_ROLLOUT_KEYS,
  PromotionController
} from '../src/promotion-controller.mjs';
import { RolloutRevisionConflictError, YuqiStore } from '../src/store.mjs';

function registry(checksum = 'evidence-a') {
  return {
    evidenceManifest(rolloutKey) {
      return {
        manifest: { rolloutKey, checksum },
        checksum: `${checksum}:${rolloutKey}`,
        presetVersion: '2.0.0'
      };
    }
  };
}

function envelope(sequence = 1, kind = 'DIRECT_REPLY') {
  return {
    protocolVersion: 2,
    turnId: `turn_rollout_${sequence}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: sequence,
    createdAt: 1_000 + sequence,
    kind,
    message: {
      messageId: `msg_rollout_${sequence}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: `消息 ${sequence}`,
      sentAt: 1_000 + sequence
    }
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-rollout-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    return run(store);
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('initialization creates ten authoritative legacy rollout rows only once', () => withStore(store => {
  const controller = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 10_000
  });
  const first = controller.initialize();
  assert.equal(first.initialized, true);
  assert.deepEqual(controller.listStatus().map(row => row.rolloutKey), [...COGNITION_ROLLOUT_KEYS].sort());
  assert.ok(controller.listStatus().every(row =>
    row.currentMode === 'legacy'
    && row.rolloutPhase === 'stable'
    && row.revision === 1
    && row.evidenceEpoch === 1
    && row.shadowEpoch === 0
    && row.canaryEpoch === 0
  ));
  const historyCount = store.listPromotionHistory().length;
  const second = new PromotionController({
    store,
    presetRegistry: registry(),
    bootstrap: { defaultMode: 'active', defaultPhase: 'canary' },
    clock: () => 11_000
  }).initialize();
  assert.equal(second.initialized, false);
  assert.ok(controller.listStatus().every(row => row.currentMode === 'legacy'));
  assert.equal(store.listPromotionHistory().length, historyCount);
}));

test('turns pin rollout state and later transitions never rewrite old turns', () => withStore(store => {
  const controller = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 10_000
  });
  controller.initialize();
  const legacy = controller.getStatus('DIRECT_REPLY');
  const shadow = controller.transition({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: legacy.revision,
    toMode: 'shadow',
    toPhase: 'collecting',
    actor: 'manual',
    reasonCode: 'collect_live_shadow'
  });
  const turnA = controller.createTurn({ envelope: envelope(1) });
  assert.equal(turnA.pipelineMode, 'shadow');
  assert.equal(turnA.comparisonMode, 'cognition_compare');
  assert.equal(turnA.rolloutRevision, shadow.revision);
  assert.equal(controller.getStatus('DIRECT_REPLY').revision, shadow.revision + 1);

  const afterPin = controller.getStatus('DIRECT_REPLY');
  controller.transition({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: afterPin.revision,
    toMode: 'legacy',
    toPhase: 'stable',
    actor: 'manual',
    reasonCode: 'manual_rollback'
  });
  assert.equal(store.getTurn(turnA.turnId).pipelineMode, 'shadow');
  assert.equal(controller.createTurn({ envelope: envelope(2) }).pipelineMode, 'legacy');
}));

test('revision CAS permits only one competing transition', () => withStore(store => {
  const controller = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 10_000
  });
  controller.initialize();
  const revision = controller.getStatus('PROACTIVE_CHAT').revision;
  controller.transition({
    rolloutKey: 'PROACTIVE_CHAT',
    expectedRevision: revision,
    toMode: 'shadow',
    toPhase: 'collecting',
    actor: 'manual',
    reasonCode: 'first'
  });
  assert.throws(() => controller.transition({
    rolloutKey: 'PROACTIVE_CHAT',
    expectedRevision: revision,
    toMode: 'shadow',
    toPhase: 'collecting',
    actor: 'manual',
    reasonCode: 'second'
  }), RolloutRevisionConflictError);
}));

test('evidence changes atomically begin a new epoch without reacting to unrelated files', () => withStore(store => {
  const first = new PromotionController({
    store,
    presetRegistry: registry('a'),
    clock: () => 10_000
  });
  first.initialize();
  assert.deepEqual(first.refreshEvidenceManifest({ now: 11_000 }).changed, []);
  const second = new PromotionController({
    store,
    presetRegistry: registry('b'),
    clock: () => 12_000
  });
  const result = second.initialize();
  assert.equal(result.changed.length, 10);
  assert.ok(second.listStatus().every(row => row.evidenceEpoch === 2));
}));

