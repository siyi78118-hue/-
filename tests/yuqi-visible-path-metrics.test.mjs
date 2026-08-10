import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateVisiblePathMetrics, sha256 } from '../scripts/generate-yuqi-visible-path-metrics.mjs';

const CANDIDATE_ID = 'quality_candidate_1';
const CANDIDATE_CHECKSUM = 'b'.repeat(64);
const SOURCE_HEAD = 'a'.repeat(40);
const RUN_ID = '4f12c753-6e8b-4c07-bc20-a30360b95b6b';

function writeRawFixture(root, mutateAndroid = rows => rows, mutatePc = rows => rows, { runId = RUN_ID } = {}) {
  const privateDir = join(root, 'private');
  mkdirSync(privateDir, { recursive: true });
  const startedAt = Date.now() - 100_000;
  const completedAt = Date.now() - 1_000;
  const kinds = [
    ...Array.from({ length: 20 }, () => 'DIRECT_REPLY'), 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
    'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
    'MOMENT_INTERACTION', 'MOMENT_REPLY'
  ];
  const androidRows = kinds.map((kind, index) => {
    const createdAt = startedAt + 10_000 + index * 1_000;
    return {
      turnIdSha256: sha256(`turn-${index}`), kind, pipelineReleaseId: CANDIDATE_ID,
      authorityLineageKeySha256: sha256(`lineage-${index}`),
      visibleGroupIdSha256: sha256(`group-${index}`),
      createdAt, uiAppliedAt: createdAt + index + 1, elapsedMs: index + 1,
      terminalDisposition: 'visible'
    };
  });
  const pcRows = androidRows.map(row => ({
    authorityLineageKeySha256: row.authorityLineageKeySha256,
    authorityMode: 'active_canary', kind: row.kind,
    pipelineReleaseId: row.pipelineReleaseId, turnIdSha256: row.turnIdSha256,
    visibleGroupIdSha256: row.visibleGroupIdSha256
  }));
  const finalAndroidRows = mutateAndroid(androidRows);
  const finalPcRows = mutatePc(pcRows);
  const androidAttestationBase = {
    candidateReleaseId: CANDIDATE_ID, completedAt,
    databaseUserVersion: 15, deviceSerial: 'emulator-5554',
    producer: 'room_authority_export_v1', rowCount: finalAndroidRows.length,
    runId,
    selectionChecksum: sha256({ producer: 'room_authority_export_v1', rows: finalAndroidRows }),
    startedAt
  };
  const pcAttestationBase = {
    candidateReleaseChecksum: CANDIDATE_CHECKSUM, candidateReleaseId: CANDIDATE_ID,
    completedAt, databaseUserVersion: 15, producer: 'pc_authority_readonly_export_v1',
    readOnly: true, rowCount: finalPcRows.length, runId,
    selectionChecksum: sha256({ producer: 'pc_authority_readonly_export_v1', rows: finalPcRows }),
    sourceDatabaseSha256: 'c'.repeat(64), sourceHead: SOURCE_HEAD, startedAt
  };
  const androidMetadata = {
    recordType: 'metadata', schemaVersion: 'yuqi-v3-visible-path-android-v1',
    deviceSerial: 'emulator-5554', runId,
    candidateReleaseId: CANDIDATE_ID, startedAt, completedAt,
    producerAttestation: {
      ...androidAttestationBase,
      attestationChecksum: sha256(androidAttestationBase)
    }
  };
  const pcMetadata = {
    recordType: 'metadata', schemaVersion: 'yuqi-v3-visible-path-pc-v1',
    candidateReleaseId: CANDIDATE_ID, candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    sourceHead: SOURCE_HEAD, runId, startedAt, completedAt,
    producerAttestation: {
      ...pcAttestationBase,
      attestationChecksum: sha256(pcAttestationBase)
    }
  };
  writeFileSync(join(privateDir, 'visible-path-android.jsonl'),
    `${[androidMetadata, ...finalAndroidRows].map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(join(privateDir, 'visible-path-pc.jsonl'),
    `${[pcMetadata, ...finalPcRows].map(row => JSON.stringify(row)).join('\n')}\n`);
  return { androidRows, pcRows };
}

test('producer reads independent metadata-only exports and atomically writes verifier-compatible report', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-path-metrics-'));
  writeRawFixture(root);
  const out = join(root, 'visible-path-metrics.json');
  const report = generateVisiblePathMetrics({
    androidExportPath: join(root, 'private/visible-path-android.jsonl'),
    pcExportPath: join(root, 'private/visible-path-pc.jsonl'), outPath: out
  });
  assert.equal(report.schemaVersion, 'yuqi-v3-visible-path-metrics-v1');
  assert.equal(report.samples.length, 28);
  assert.equal(report.metrics.directReplyMedianMs, 10.5);
  assert.equal(report.metrics.directReplyP95Ms, 19);
  assert.equal(readFileSync(out, 'utf8').endsWith('\n'), true);
});

test('producer rejects identity, row closure, timestamp, coverage, and content mutations', () => {
  const mutations = [
    { android: rows => rows.map(row => ({ ...row, candidateReleaseId: 'foreign' })) },
    { pc: rows => rows.map((row, index) => index === 0 ? { ...row, pipelineReleaseId: 'foreign' } : row) },
    { pc: rows => rows.slice(0, -1) },
    { pc: rows => [...rows, rows[0]] },
    { android: rows => rows.map((row, index) => index === 0 ? { ...row, elapsedMs: 0 } : row) },
    { android: rows => rows.map((row, index) => index === 0 ? { ...row, secretReply: 'PRIVATE' } : row) },
    { android: rows => rows.filter(row => row.kind !== 'DIRECT_REPLY').slice(0, 10) }
  ];
  for (const mutation of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-path-metrics-bad-'));
    writeRawFixture(root, mutation.android, mutation.pc);
    assert.throws(() => generateVisiblePathMetrics({
      androidExportPath: join(root, 'private/visible-path-android.jsonl'),
      pcExportPath: join(root, 'private/visible-path-pc.jsonl'),
      outPath: join(root, 'visible-path-metrics.json')
    }), /visible path metrics/);
  }
});

test('producer rejects caller aggregates and does not invoke devices, models, or databases', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-path-metrics-aggregate-'));
  writeRawFixture(root);
  assert.throws(() => generateVisiblePathMetrics({
    androidExportPath: join(root, 'private/visible-path-android.jsonl'),
    pcExportPath: join(root, 'private/visible-path-pc.jsonl'),
    outPath: join(root, 'visible-path-metrics.json'),
    metrics: { directReplyMedianMs: 0 }
  }), /unknown option|aggregate/);
});

test('producer binds the PC export to the Android run and uses the standard even median', () => {
  for (const mutateMetadata of [
    metadata => { delete metadata.runId; },
    metadata => { metadata.runId = 'different-run'; }
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-path-metrics-run-'));
    writeRawFixture(root);
    const file = join(root, 'private/visible-path-pc.jsonl');
    const records = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
    mutateMetadata(records[0]);
    writeFileSync(file, `${records.map(row => JSON.stringify(row)).join('\n')}\n`);
    assert.throws(() => generateVisiblePathMetrics({
      androidExportPath: join(root, 'private/visible-path-android.jsonl'),
      pcExportPath: file,
      outPath: join(root, 'visible-path-metrics.json')
    }), /visible path metrics/);
  }
});

test('producer rejects a self-consistent non-UUID run identity before deriving metrics', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-path-metrics-run-id-'));
  writeRawFixture(root, rows => rows, rows => rows, { runId: 'run-visible-path-1' });
  assert.throws(() => generateVisiblePathMetrics({
    androidExportPath: join(root, 'private/visible-path-android.jsonl'),
    pcExportPath: join(root, 'private/visible-path-pc.jsonl'),
    outPath: join(root, 'visible-path-metrics.json')
  }), /visible path metrics.*run|metadata values/i);
});
