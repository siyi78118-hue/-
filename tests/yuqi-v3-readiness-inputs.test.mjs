import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  generateAndroidFallbackReport,
  generateProtocolReport,
  generateRolloutStatusReport,
  generateReadinessInputs,
  validateReadinessInputReport,
  reportChecksum
} from '../scripts/generate-yuqi-v3-readiness-inputs.mjs';

function tempEvidence() {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-readiness-inputs-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('protocol producer runs the public 270-case fixture and emits a closed checksummed report', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateProtocolReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    assert.deepEqual(Object.keys(report).sort(), [
      'byKind', 'candidateReleaseChecksum', 'candidateReleaseId', 'caseCount', 'casesSha256', 'command', 'commandOutputSha256', 'completedAt',
      'critical', 'failed', 'liveShadowCountAfter', 'liveShadowCountBefore',
      'manifestSha256', 'passed', 'productionReleaseMutation', 'qualityEvidenceEligible',
      'reportChecksum', 'schemaVersion', 'skipped', 'sourceHead', 'startedAt', 'status', 'suitePurpose'
    ].sort());
    assert.equal(report.schemaVersion, 'yuqi-v3-protocol-report-v1');
    assert.equal(report.suitePurpose, 'protocol_regression');
    assert.equal(report.caseCount, 270);
    assert.equal(report.passed, 270);
    assert.equal(report.failed, 0);
    assert.equal(report.skipped, 0);
    assert.equal(report.critical, 0);
    assert.equal(report.liveShadowCountBefore, 0);
    assert.equal(report.liveShadowCountAfter, 0);
    assert.equal(report.qualityEvidenceEligible, false);
    assert.equal(report.productionReleaseMutation, false);
    assert.equal(report.status, 'passed');
    assert.equal(report.candidateReleaseId, null);
    assert.match(report.manifestSha256, /^[a-f0-9]{64}$/);
    assert.match(report.casesSha256, /^[a-f0-9]{64}$/);
    assert.match(report.commandOutputSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.reportChecksum, validateReadinessInputReport(report).reportChecksum);
  } finally {
    fixture.cleanup();
  }
});

test('fallback producer parses the exact sentinel result and binds fixture/source checksums', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateAndroidFallbackReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    assert.equal(report.schemaVersion, 'yuqi-v3-android-fallback-report-v1');
    assert.equal(report.testPath, 'yuqi-runtime/test/android-fallback-authority.test.mjs');
    assert.equal(report.fixturePath, 'tests/fixtures/android-fallback-authority-v2.json');
    assert.match(report.fixtureSha256, /^[a-f0-9]{64}$/);
    assert.match(report.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(report.commandOutputSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.exitCode, 0);
    assert.ok(report.tests > 0);
    assert.equal(report.passed, report.tests);
    assert.equal(report.failed, 0);
    assert.equal(report.skipped, 0);
    assert.equal(report.executionStatus, 'passed');
    assert.equal(report.status, 'not_ready');
    assert.equal(report.candidateReleaseId, null);
    assert.equal(report.productionReleaseMutation, false);
    assert.equal(report.reportChecksum, validateReadinessInputReport(report).reportChecksum);
  } finally {
    fixture.cleanup();
  }
});

test('rollout producer is fail-closed without explicit config and never invents stable', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateRolloutStatusReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    assert.deepEqual(Object.keys(report).sort(), [
      'candidateReleaseChecksum', 'candidateReleaseId', 'completedAt', 'configPath',
      'databasePath', 'databaseSha256', 'kinds', 'productionReleaseMutation',
      'reason', 'reportChecksum', 'schemaVersion', 'semanticFingerprint', 'sourceHead', 'startedAt',
      'status', 'userVersion'
    ].sort());
    assert.equal(report.schemaVersion, 'yuqi-v3-rollout-status-v1');
    assert.equal(report.candidateReleaseId, null);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.productionReleaseMutation, false);
    assert.equal(report.userVersion, null);
    assert.ok(Array.isArray(report.kinds));
    assert.ok(report.kinds.length > 0);
    assert.equal(report.kinds.every(kind => kind.candidatePhase === 'none'), true);
    assert.equal(report.reportChecksum, validateReadinessInputReport(report).reportChecksum);
  } finally {
    fixture.cleanup();
  }
});

test('combined producer blocks when the fifteen-artifact quality raw bundle is unavailable', async () => {
  const fixture = tempEvidence();
  try {
    await assert.rejects(
      generateReadinessInputs({ rootDir: process.cwd(), evidenceDir: fixture.root }),
      /QUALITY_BUNDLE_ARTIFACT_UNAVAILABLE/
    );
  } finally {
    fixture.cleanup();
  }
});

test('report validator rejects self-consistent checksum edits with unknown fields or native type changes', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateRolloutStatusReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    assert.throws(() => validateReadinessInputReport({ ...report, extra: true }), /closed|unknown/i);
    assert.throws(() => validateReadinessInputReport({ ...report, status: 0 }), /status|native|checksum/i);
    assert.throws(() => validateReadinessInputReport({ ...report, reportChecksum: '0'.repeat(64) }), /checksum/i);
  } finally {
    fixture.cleanup();
  }
});

test('protocol validator requires the exact nine protocol kinds, not nine arbitrary keys', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateProtocolReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    const byKind = { ...report.byKind };
    delete byKind.DIRECT_REPLY;
    byKind.UNKNOWN_KIND = 30;
    const mutated = { ...report, byKind };
    mutated.reportChecksum = reportChecksum(mutated);
    assert.throws(() => validateReadinessInputReport(mutated), /protocol|kind/i);
  } finally {
    fixture.cleanup();
  }
});

test('fallback validator requires closed arithmetic and passed status', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateAndroidFallbackReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    const mutated = { ...report, passed: report.tests - 1, failed: 0, skipped: 0 };
    mutated.reportChecksum = reportChecksum(mutated);
    assert.throws(() => validateReadinessInputReport(mutated), /fallback|counter|status/i);
  } finally {
    fixture.cleanup();
  }
});

test('rollout validator requires the exact closed kind rows and checksums', async () => {
  const fixture = tempEvidence();
  try {
    const report = await generateRolloutStatusReport({ rootDir: process.cwd(), evidenceDir: fixture.root });
    const mutated = { ...report, kinds: report.kinds.map((row, index) => index === 0
      ? { ...row, candidateReleaseChecksum: 'not-a-checksum' }
      : row) };
    mutated.reportChecksum = reportChecksum(mutated);
    assert.throws(() => validateReadinessInputReport(mutated), /rollout|checksum|kind/i);
  } finally {
    fixture.cleanup();
  }
});

test('rollout producer rejects a pre-v15 source before opening a migrating clone', async () => {
  const fixture = tempEvidence();
  const databasePath = join(fixture.root, 'legacy.sqlite');
  const configPath = join(fixture.root, 'rollout-config.json');
  const db = new DatabaseSync(databasePath);
  try { db.exec('PRAGMA user_version=14'); } finally { db.close(); }
  writeFileSync(configPath, JSON.stringify({ databasePath: 'legacy.sqlite' }));
  try {
    const report = await generateRolloutStatusReport({
      rootDir: fixture.root, evidenceDir: fixture.root, configPath: 'rollout-config.json'
    });
    assert.equal(report.status, 'unavailable');
    assert.equal(report.reason, 'ROLLOUT_SOURCE_SCHEMA_UNSUPPORTED');
    assert.equal(report.candidateReleaseId, null);
    assert.equal(validateReadinessInputReport(report).reason, report.reason);
  } finally {
    fixture.cleanup();
  }
});
