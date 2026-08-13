import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  COGNITION_ROLLOUT_KEYS,
  PromotionController
} from '../src/promotion-controller.mjs';
import { contentHash } from '../src/protocol.mjs';
import { RolloutRevisionConflictError, YuqiStore } from '../src/store.mjs';

const OWNER_PROFILE = Object.freeze({
  cognitionFast: 'gpt-5.6-sol/medium',
  cognitionDeep: 'gpt-5.6-sol/xhigh',
  expression: 'gpt-5.6-sol/medium',
  supervisor: 'gpt-5.6-sol/medium'
});

function registry() {
  return {
    evidenceManifest(rolloutKey) {
      return {
        manifest: { rolloutKey, presetVersion: '2.1.1' },
        checksum: contentHash({ rolloutKey, presetVersion: '2.1.1' }),
        presetVersion: '2.1.1'
      };
    }
  };
}

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-'));
  const store = new YuqiStore(join(directory, 'runtime.sqlite'));
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function releaseChecksum(release) {
  return contentHash({
    pipelineVersion: release.pipelineVersion,
    presetVersion: release.presetVersion,
    cognitionSchemaVersion: release.cognitionSchemaVersion,
    expressionSchemaVersion: release.expressionSchemaVersion,
    evaluatorVersion: release.evaluatorVersion,
    modelProfile: release.modelProfile,
    componentManifest: release.componentManifest,
    createdAt: release.createdAt
  });
}

function ownerCandidate() {
  const body = {
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: '2.1.1',
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3,
    evaluatorVersion: 'lived-quality-supervisor-v3',
    modelProfile: OWNER_PROFILE,
    componentManifest: { preset: '2.1.1', behavior: 'implicit-understanding-v1' },
    createdAt: 20_000,
    retiredAt: null
  };
  const releaseChecksumValue = releaseChecksum(body);
  return {
    ...body,
    releaseId: `quality_candidate_${releaseChecksumValue.slice(0, 16)}`,
    releaseChecksum: releaseChecksumValue
  };
}

function materializeOwnerReport(store, candidate = ownerCandidate(), overrides = {}) {
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const stable = store.getPipelineRelease(rollout.stableReleaseId);
  const summary = {
    eligible: true,
    evidenceClass: 'owner_preview_v1',
    internalPreview: true,
    authorizedBy: 'owner',
    authorizationId: 'owner-preview-2026-08-13-v1',
    authorizedAt: 30_000,
    sourceHead: 'a'.repeat(40),
    rolloutScope: ['DIRECT_REPLY'],
    stableBaselineReleaseId: stable.releaseId,
    stableBaselineReleaseChecksum: stable.releaseChecksum,
    candidateRelease: candidate,
    evaluatorVersion: candidate.evaluatorVersion,
    suiteChecksum: contentHash({ source: 'real-chat-human-review-round-2' }),
    presetVersion: '2.1.1',
    modelProfile: OWNER_PROFILE,
    ...overrides
  };
  const report = store.putEvaluationReportInternal({
    reportId: `owner_preview_${contentHash(summary).slice(0, 24)}`,
    reportType: 'promotion',
    rolloutKey: 'DIRECT_REPLY',
    sourceType: 'promotion_snapshot',
    sourceRef: 'owner-preview-2026-08-13',
    artifactPath: 'artifacts/owner-preview/report.json',
    summary,
    createdAt: 30_001
  });
  store.markEvaluationReportMaterialized({
    reportId: report.reportId,
    expectedChecksum: report.artifactChecksum,
    now: 30_002
  });
  return store.getEvaluationReport(report.reportId);
}

function setup(store) {
  const promotion = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 40_000
  });
  promotion.initialize();
  const report = materializeOwnerReport(store);
  const direct = promotion.getStatus('DIRECT_REPLY');
  const shadow = promotion.registerCandidate({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: direct.revision,
    releaseId: report.summary.candidateRelease.releaseId,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  });
  return { promotion, report, shadow };
}

test('owner preview activates only DIRECT_REPLY with candidate visible and stable compare', () => withStore((store) => {
  const { promotion, report, shadow } = setup(store);
  const before = new Map(promotion.listStatus().map(row => [row.rolloutKey, structuredClone(row)]));

  const active = promotion.startOwnerPreview({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: shadow.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum,
    authorizationId: report.summary.authorizationId,
    sourceHead: report.summary.sourceHead
  });

  assert.equal(active.currentMode, 'active');
  assert.equal(active.candidatePhase, 'canary');
  assert.equal(active.lastReasonCode, 'owner_preview_started');
  assert.deepEqual(promotion.resolvePipelinePair(active), {
    visibleReleaseId: report.summary.candidateRelease.releaseId,
    comparisonReleaseId: active.stableReleaseId,
    comparisonDirection: 'candidate_authoritative_stable_compare',
    candidatePhase: 'canary'
  });
  for (const key of COGNITION_ROLLOUT_KEYS.filter(key => key !== 'DIRECT_REPLY')) {
    assert.deepEqual(promotion.getStatus(key), before.get(key));
  }
}));

test('owner preview evidence cannot satisfy the formal promotion gate', () => withStore((store) => {
  const { promotion, report, shadow } = setup(store);
  assert.throws(() => promotion.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: shadow.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  }), /owner preview evidence cannot satisfy formal promotion/);
  assert.deepEqual(promotion.getStatus('DIRECT_REPLY'), shadow);
}));

test('owner preview evidence cannot graduate into the formal stable release', () => withStore((store) => {
  const { promotion, report, shadow } = setup(store);
  const active = promotion.startOwnerPreview({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: shadow.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum,
    authorizationId: report.summary.authorizationId,
    sourceHead: report.summary.sourceHead
  });
  store.db.prepare(`
    UPDATE cognition_kind_rollouts
    SET canary_completed_count=canary_target_count, canary_observe_until=0
    WHERE rollout_key='DIRECT_REPLY'
  `).run();
  assert.throws(() => promotion.graduateCandidate({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: active.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  }), /owner preview evidence cannot satisfy formal graduation/);
  assert.equal(promotion.getStatus('DIRECT_REPLY').stableReleaseId, active.stableReleaseId);
}));

test('owner preview is direct-only, exact-replay idempotent, and stale-conflict safe', () => withStore((store) => {
  const { promotion, report, shadow } = setup(store);
  assert.throws(() => promotion.startOwnerPreview({
    rolloutKey: 'PROACTIVE_CHAT',
    expectedRevision: promotion.getStatus('PROACTIVE_CHAT').revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum,
    authorizationId: report.summary.authorizationId,
    sourceHead: report.summary.sourceHead
  }), /owner preview supports DIRECT_REPLY only/);

  const request = {
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: shadow.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum,
    authorizationId: report.summary.authorizationId,
    sourceHead: report.summary.sourceHead
  };
  const first = promotion.startOwnerPreview(request);
  const replay = promotion.startOwnerPreview(request);
  assert.deepEqual(replay, first);

  assert.throws(() => promotion.startOwnerPreview({
    ...request,
    authorizationId: 'changed-authorization'
  }), /owner preview authorization conflict/);
  assert.throws(() => promotion.startOwnerPreview({
    ...request,
    expectedRevision: shadow.revision - 1
  }), RolloutRevisionConflictError);
  assert.deepEqual(promotion.getStatus('DIRECT_REPLY'), first);
}));

test('owner preview rejects a changed approved profile before rollout mutation', () => withStore((store) => {
  const { promotion, report, shadow } = setup(store);
  store.db.prepare('UPDATE cognition_evaluation_reports SET summary_json = ? WHERE report_id = ?').run(
    JSON.stringify({
      ...report.summary,
      modelProfile: { ...report.summary.modelProfile, cognitionDeep: 'gpt-5.6-sol/medium' }
    }),
    report.reportId
  );
  assert.throws(() => promotion.startOwnerPreview({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: shadow.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum,
    authorizationId: report.summary.authorizationId,
    sourceHead: report.summary.sourceHead
  }), /owner preview|checksum|profile/);
  assert.deepEqual(promotion.getStatus('DIRECT_REPLY'), shadow);
}));
