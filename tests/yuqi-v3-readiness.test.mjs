import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  CONNECTED_DEVICE_RACE_NAMES,
  CONNECTED_DEVICE_RACE_TEST_CLASS,
  READINESS_ARTIFACT_NAMES,
  connectedXmlWasRewritten,
  loadReadinessManifest,
  materializeReadinessReport,
  materializeBlockedReadinessReport,
  parseNodeTestSummary,
  preflightFixedReadinessInputs,
  preflightSourceTree,
  resolveNpmExecutable,
  resolveAdbExecutable,
  sha256,
  verifyReadiness,
  verifyReadinessFromDirectory,
  writeReadinessReportExclusive
} from '../scripts/verify-yuqi-v3-readiness.mjs';
import { reportChecksum } from '../scripts/generate-yuqi-v3-readiness-inputs.mjs';
import { createQualityReplayPlan } from '../scripts/run-yuqi-lived-quality-replay.mjs';
import { deriveManualReviewRequirements, evidenceBoundaryChecksum } from '../scripts/report-yuqi-lived-quality.mjs';
import { aggregateQualityGate, compileSceneExecutionInput } from '../yuqi-runtime/src/quality-evaluator.mjs';
import { expectedFinalKeysProjection } from '../yuqi-runtime/src/quality-replay.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';

const ARTIFACT_NAMES = [
  'baseline', 'migration', 'migrationClone', 'protocol', 'quality', 'races',
  'qualityPlan', 'qualityReplay', 'qualityManualReview',
  'androidFallback', 'rolloutStatus', 'visiblePathMetrics', 'nodeTests', 'androidTests',
  'connectedDeviceRaces'
];
const SOURCE_HEAD = 'a'.repeat(40);
const CANDIDATE_CHECKSUM = 'b'.repeat(64);
const VISIBLE_PATH_START_FILE = 'private/visible-path-collection-start.json';
const VISIBLE_PATH_XML_FILE = 'private/visible-path-android-test.xml';
const VISIBLE_PATH_PC_SOURCE_DATABASE_SHA = '6'.repeat(64);

test('readiness is a fifteen-artifact bundle and blocked reports carry all keys', () => {
  assert.equal(READINESS_ARTIFACT_NAMES.length, 15);
  const blocked = materializeBlockedReadinessReport({ failedGate: 'QUALITY_BUNDLE_UNAVAILABLE' });
  assert.deepEqual(Object.keys(blocked.artifactChecksums).sort(), [...READINESS_ARTIFACT_NAMES].sort());
});

function closedProtocol(candidateReleaseId, sourceHead = SOURCE_HEAD) {
  const report = {
    schemaVersion: 'yuqi-v3-protocol-report-v1', candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM, suitePurpose: 'protocol_regression',
    sourceHead,
    caseCount: 270, passed: 270, failed: 0, skipped: 0, critical: 0,
    liveShadowCountBefore: 0, liveShadowCountAfter: 0, qualityEvidenceEligible: false,
    productionReleaseMutation: false, status: 'passed',
    byKind: Object.fromEntries([
      'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
      'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
      'MOMENT_INTERACTION', 'MOMENT_REPLY'
    ].map(key => [key, 30])),
    manifestSha256: 'c'.repeat(64), casesSha256: 'd'.repeat(64),
    command: { execution: 'in_process', module: 'yuqi-runtime/src/replay-runner.mjs', export: 'ReplayRunner.runFixtureBatch', args: [] },
    commandOutputSha256: 'e'.repeat(64), startedAt: Date.now() - 10, completedAt: Date.now()
  };
  return { ...report, reportChecksum: reportChecksum(report) };
}

function closedFallback(candidateReleaseId, sourceHead = SOURCE_HEAD) {
  const report = {
    schemaVersion: 'yuqi-v3-android-fallback-report-v1', candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    sourceHead,
    testPath: 'yuqi-runtime/test/android-fallback-authority.test.mjs',
    fixturePath: 'tests/fixtures/android-fallback-authority-v2.json',
    sourceSha256: 'f'.repeat(64), fixtureSha256: '1'.repeat(64), command: [process.execPath, '--test', 'yuqi-runtime/test/android-fallback-authority.test.mjs'],
    commandOutputSha256: '2'.repeat(64), exitCode: 0, tests: 25, passed: 25, failed: 0, skipped: 0,
    executionStatus: 'passed', status: 'passed', reason: null, productionReleaseMutation: false,
    startedAt: Date.now() - 10, completedAt: Date.now()
  };
  return { ...report, reportChecksum: reportChecksum(report) };
}

function closedRollout(candidateReleaseId, sourceHead = SOURCE_HEAD) {
  const kinds = ['DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
    'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION',
    'MOMENT_REPLY', 'LIFE_PLANNING'].map(rolloutKey => ({
      rolloutKey, currentMode: 'active', rolloutPhase: 'stable', candidatePhase: 'stable',
      revision: 2, evidenceEpoch: 2, shadowEpoch: 2, stableReleaseId: candidateReleaseId,
      candidateReleaseId, stableReleaseChecksum: CANDIDATE_CHECKSUM,
      candidateReleaseChecksum: CANDIDATE_CHECKSUM
    }));
  const report = {
    schemaVersion: 'yuqi-v3-rollout-status-v1', candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM, status: 'available', reason: null,
    sourceHead,
    configPath: 'config.json', databasePath: 'runtime.sqlite', databaseSha256: '3'.repeat(64),
    semanticFingerprint: '4'.repeat(64), userVersion: 15, kinds,
    productionReleaseMutation: false, startedAt: Date.now() - 10, completedAt: Date.now()
  };
  return { ...report, reportChecksum: reportChecksum(report) };
}

function closedMigration() {
  const counts = {
    messages: 0, facts: 0, relationship_states: null, relationship_history: null,
    role_plans: null, life_episodes: 0, turns: 0, result_outbox: null,
    turn_authority_lineages: 0, visible_result_groups: 0, visible_result_items: 0,
    visible_result_actions: 0, visible_result_manifests: 0, visible_commit_receipts: 0,
    cloud_deliveries: 0
  };
  return {
    schemaVersion: 1, roleId: 'yuqi', cognitiveRevision: null, boundaryCount: 0,
    insertedCount: 0, decisionChecksum: '1'.repeat(64), decisions: [],
    beforeCounts: counts, afterCounts: counts, sourceUserVersion: 14,
    workingUserVersion: 15, sourceDatabaseSha256: 'a'.repeat(64),
    sourceDatabaseSha256After: 'a'.repeat(64), sourceTableCounts: counts,
    workingDatabaseSha256: 'b'.repeat(64), applied: false,
    v14InvariantSummary: {
      userVersion: 15,
      semantic: { userVersion: 15, canonicalTurnCount: 0,
        lineageCount: 0, receiptCount: 0, checksum: '2'.repeat(64),
        tableCounts: { ...counts, conversation_clear_controls: 0 } },
      indexes: [], rolloutCanary: [], checksum: '3'.repeat(64)
    }
  };
}

function closedQuality(candidateReleaseId) {
  const candidateRelease = {
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2',
    evaluatorVersion: 'quality-evaluator-v1', modelProfile: 'blind-fixed',
    componentManifest: {}, createdAt: Date.now() - 10,
    releaseId: candidateReleaseId, releaseChecksum: CANDIDATE_CHECKSUM
  };
  const qualityGate = {
    protocolFailures: 0, sentinelSevereFailureCount: 0,
    dimensionAverages: [], scoreOneCount: 0, candidatePreferredRate: 1,
    regressionRate: 0, tieOrUnresolvedRate: 0, structuralRegressionCount: 0,
    candidateWins: 1, stableWins: 0, tieCount: 0, unresolvedCount: 0,
    completedPairs: 1, evidenceCount: 1, failedGates: [], eligible: true
  };
  const executionPair = {
    finalKey: 'sentinel:quality-fixture:0',
    sourceHead: SOURCE_HEAD,
    stableReleaseId: 'stable-fixture',
    stableReleaseChecksum: 'd'.repeat(64),
    candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    executionChecksum: 'e'.repeat(64),
    stableInputChecksum: 'e'.repeat(64),
    candidateInputChecksum: 'e'.repeat(64),
    dryRun: true,
    capabilities: { visible: false, actions: false }
  };
  const modelRun = {
    finalKey: executionPair.finalKey, attemptIndex: 0,
    evaluatorId: 'blind-fixture', inputChecksum: 'f'.repeat(64), completed: true
  };
  const replayBase = {
    sourceHead: SOURCE_HEAD,
    executionPairs: [executionPair],
    modelRuns: [modelRun]
  };
  const evidenceBoundary = {
    version: 1, inputMode: 'preset_default', sourceClass: 'tracked_human_annotations',
    offlineModelEvaluation: true, realHistoryEvidence: false, liveShadowEvidence: false
  };
  const replayProvenance = {
    ...replayBase,
    provenanceChecksum: sha256(replayBase)
  };
  return {
    version: 1, productionReleaseMutation: false, candidateRelease,
    evidenceBoundary,
    planChecksum: 'c'.repeat(64), replayProvenance,
    qualityGate, manualReview: {
      eligible: true, failedGates: [], unresolvedCount: 0, requiredCount: 0,
      requirements: [], queue: []
    }, eligible: true, failedGates: [], sourceHead: SOURCE_HEAD,
    evidenceBoundaryChecksum: evidenceBoundaryChecksum({
      evidenceBoundary, planChecksum: 'c'.repeat(64), sourceHead: SOURCE_HEAD,
      provenanceChecksum: replayProvenance.provenanceChecksum
    })
  };
}

function closedVisiblePathMetrics(candidateReleaseId, evidenceRoot, sourceRoot = evidenceRoot) {
  const runId = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();
  const startedAt = now - 100_000;
  const completedAt = now - 1_000;
  const kinds = [
    ...Array.from({ length: 20 }, () => 'DIRECT_REPLY'),
    'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
    'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
    'MOMENT_INTERACTION', 'MOMENT_REPLY'
  ];
  const samples = kinds.map((kind, index) => {
    const createdAt = startedAt + 10_000 + index * 1_000;
    const sample = {
      turnIdSha256: sha256(`turn-${index}`), kind, pipelineReleaseId: candidateReleaseId,
      authorityLineageKeySha256: sha256(`lineage-${index}`), visibleGroupIdSha256: sha256(`group-${index}`),
      createdAt, uiAppliedAt: createdAt + index + 1, elapsedMs: index + 1,
      terminalDisposition: 'visible', authorityMode: 'active_canary'
    };
    return { sampleId: sha256(sample), ...sample };
  });
  const androidRows = samples.map(sample => {
    const { sampleId, authorityMode: _authorityMode, ...row } = sample;
    return row;
  });
  const pcRows = samples.map(sample => ({
    authorityLineageKeySha256: sample.authorityLineageKeySha256,
    authorityMode: sample.authorityMode,
    kind: sample.kind,
    pipelineReleaseId: sample.pipelineReleaseId,
    turnIdSha256: sample.turnIdSha256,
    visibleGroupIdSha256: sample.visibleGroupIdSha256
  }));
  const androidMetadata = {
    recordType: 'metadata', schemaVersion: 'yuqi-v3-visible-path-android-v1',
    deviceSerial: 'emulator-5554', runId, candidateReleaseId,
    startedAt, completedAt,
    producerAttestation: {
      producer: 'room_authority_export_v1', databaseUserVersion: 15,
      selectionChecksum: sha256({ producer: 'room_authority_export_v1', rows: androidRows }),
      rowCount: androidRows.length, runId,
      deviceSerial: 'emulator-5554', candidateReleaseId, startedAt, completedAt
    }
  };
  const pcMetadata = {
    recordType: 'metadata', schemaVersion: 'yuqi-v3-visible-path-pc-v1',
    candidateReleaseId, candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    sourceHead: SOURCE_HEAD, runId, startedAt, completedAt,
    producerAttestation: {
      producer: 'pc_authority_readonly_export_v1', sourceDatabaseSha256: '6'.repeat(64),
      readOnly: true, databaseUserVersion: 15,
      selectionChecksum: sha256({ producer: 'pc_authority_readonly_export_v1', rows: pcRows }),
      rowCount: pcRows.length, sourceHead: SOURCE_HEAD,
      runId, candidateReleaseId,
      candidateReleaseChecksum: CANDIDATE_CHECKSUM, startedAt, completedAt
    }
  };
  androidMetadata.producerAttestation.attestationChecksum = sha256(androidMetadata.producerAttestation);
  pcMetadata.producerAttestation.attestationChecksum = sha256(pcMetadata.producerAttestation);
  const androidBytes = Buffer.from(`${[androidMetadata, ...androidRows].map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const pcBytes = Buffer.from(`${[pcMetadata, ...pcRows].map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  const runtimeDatabasePath = join(evidenceRoot, 'runtime.sqlite');
  const startBase = {
    schemaVersion: 'yuqi-v3-visible-path-collection-start-v1',
    runId,
    sourceHead: SOURCE_HEAD,
    candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    deviceSerial: 'emulator-5554',
    runtimeDatabasePath,
    runtimeDatabasePathHash: sha256(runtimeDatabasePath),
    startedAt
  };
  const startControl = { ...startBase, checksum: sha256(startBase) };
  const startBytes = Buffer.from(`${JSON.stringify(startControl)}\n`, 'utf8');
  const testXmlBytes = Buffer.from(
    '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.siyi.al.execution.YuqiVisiblePathExportTest" name="exportCurrentDeviceVisiblePathArtifact"/></testsuite>\n',
    'utf8'
  );
  mkdirSync(join(evidenceRoot, 'private'), { recursive: true });
  writeFileSync(join(evidenceRoot, VISIBLE_PATH_START_FILE), startBytes);
  writeFileSync(join(evidenceRoot, VISIBLE_PATH_XML_FILE), testXmlBytes);
  writeFileSync(join(evidenceRoot, 'private/visible-path-android.jsonl'), androidBytes);
  writeFileSync(join(evidenceRoot, 'private/visible-path-pc.jsonl'), pcBytes);
  const testXmlSourcePath =
    'android/app/build/outputs/androidTest-results/connected/debug/TEST-YuqiTask25Api35(AVD) - 15-_app-.xml';
  const testXmlSourceFile = join(sourceRoot, ...testXmlSourcePath.split('/'));
  mkdirSync(join(testXmlSourceFile, '..'), { recursive: true });
  writeFileSync(testXmlSourceFile, testXmlBytes);
  utimesSync(testXmlSourceFile, new Date(completedAt + 2), new Date(completedAt + 2));
  const sampleSetChecksum = sha256(samples);
  const metadata = {
    androidExportPath: 'private/visible-path-android.jsonl',
    androidExportSha256: sha256(androidBytes), candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    candidateReleaseId, deviceSerial: 'emulator-5554', pcExportSha256: '9'.repeat(64),
    pcExportPath: 'private/visible-path-pc.jsonl', runId, sampleSetChecksum, sourceHead: SOURCE_HEAD
  };
  const directElapsed = samples.slice(0, 20).map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const androidCommandDescriptor = {
    args: [
      ':app:connectedDebugAndroidTest', '--no-daemon', '--no-problems-report',
      '-Pandroid.testInstrumentationRunnerArguments.class=com.siyi.al.execution.YuqiVisiblePathExportTest#exportCurrentDeviceVisiblePathArtifact',
      `-Pandroid.testInstrumentationRunnerArguments.visiblePathOutputPath=/data/user/0/com.siyi.al/files/visible-path/${runId}/visible-path-android.jsonl`,
      `-Pandroid.testInstrumentationRunnerArguments.candidateReleaseId=${candidateReleaseId}`,
      '-Pandroid.testInstrumentationRunnerArguments.deviceSerial=emulator-5554',
      `-Pandroid.testInstrumentationRunnerArguments.runId=${runId}`,
      `-Pandroid.testInstrumentationRunnerArguments.selectionFrom=${startedAt}`,
      `-Pandroid.testInstrumentationRunnerArguments.selectionTo=${completedAt}`
    ],
    command: join(sourceRoot, 'android', 'gradlew.bat'),
    kind: 'android-instrumentation', runId, candidateReleaseId,
    deviceSerial: 'emulator-5554', environment: { ANDROID_SERIAL: 'emulator-5554' },
    sourceHead: SOURCE_HEAD
  };
  const androidPullCommandDescriptor = {
    args: [
      '-s', 'emulator-5554', 'exec-out', 'run-as', 'com.siyi.al', 'cat',
      `/data/user/0/com.siyi.al/files/visible-path/${runId}/visible-path-android.jsonl`
    ],
    command: join(sourceRoot, 'sdk', 'platform-tools', 'adb.exe'),
    kind: 'android-pull', runId, candidateReleaseId,
    deviceSerial: 'emulator-5554', environment: {}, sourceHead: SOURCE_HEAD
  };
  const pcCommandDescriptor = {
    args: [
      join(evidenceRoot, 'scripts', 'export-yuqi-visible-path-pc.mjs'),
      '--database', runtimeDatabasePath, '--out', join(evidenceRoot, 'private/visible-path-pc.jsonl'),
      '--candidate-release-id', candidateReleaseId, '--candidate-release-checksum', CANDIDATE_CHECKSUM,
      '--source-head', SOURCE_HEAD, '--run-id', runId,
      '--started-at', String(startedAt), '--completed-at', String(completedAt)
    ],
    command: process.execPath, kind: 'pc-export', runId, candidateReleaseId,
    deviceSerial: 'emulator-5554', environment: {}, sourceHead: SOURCE_HEAD
  };
  const collectionAttestationBase = {
    schemaVersion: 'yuqi-v3-visible-path-collection-v1',
    runId,
    sourceHead: SOURCE_HEAD,
    candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    deviceSerial: 'emulator-5554',
    startedAt,
    completedAt,
    android: {
      producer: 'android_instrumentation_export_v1',
      deviceSerial: 'emulator-5554',
      exitCode: 0,
      commandDescriptor: androidCommandDescriptor,
      commandChecksum: sha256(androidCommandDescriptor),
      pullCommandDescriptor: androidPullCommandDescriptor,
      pullCommandChecksum: sha256(androidPullCommandDescriptor),
      pullExitCode: 0,
      instrumentationLaunchedAt: completedAt + 1,
      testXmlSha256: sha256(testXmlBytes),
      testXmlSourceMtimeMs: completedAt + 2,
      testXmlSourcePath,
      outputSha256: sha256(androidBytes),
      startControlChecksum: startControl.checksum
    },
    pc: {
      producer: 'pc_readonly_export_command_v1',
      exitCode: 0,
      commandDescriptor: pcCommandDescriptor,
      commandChecksum: sha256(pcCommandDescriptor),
      outputSha256: sha256(pcBytes),
      readOnly: true,
      sourceDatabaseSha256: VISIBLE_PATH_PC_SOURCE_DATABASE_SHA
    }
  };
  const collectionAttestation = {
    ...collectionAttestationBase,
    checksum: sha256(collectionAttestationBase)
  };
  const report = {
    schemaVersion: 'yuqi-v3-visible-path-metrics-v1', candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM, sourceHead: SOURCE_HEAD,
    deviceSerial: 'emulator-5554', runId, startedAt, completedAt,
    productionReleaseMutation: false, androidExportPath: metadata.androidExportPath,
    androidExportSha256: metadata.androidExportSha256, pcExportPath: metadata.pcExportPath,
    pcExportSha256: sha256(pcBytes), sampleSetChecksum, metadataSha256: sha256({
      ...metadata, pcExportSha256: sha256(pcBytes)
    }),
    producerAttestationChecksum: sha256({
      android: androidMetadata.producerAttestation,
      pc: pcMetadata.producerAttestation
    }),
    collectionAttestation,
    samples,
    metrics: {
      directReplyMedianMs: (directElapsed[directElapsed.length / 2 - 1] + directElapsed[directElapsed.length / 2]) / 2,
      directReplyP95Ms: directElapsed[Math.ceil(directElapsed.length * 0.95) - 1],
      maximumVisibleMs: Math.max(...samples.map(sample => sample.elapsedMs)), shadowBlockedVisibleCount: 0
    }
  };
  return { ...report, reportChecksum: sha256(report) };
}

function closedRace(candidateReleaseId) {
  const pcCases = [
    'proactive_generating_then_user_batch', 'proactive_outbox_then_user_batch',
    'runtime_restart_before_visible_commit', 'runtime_restart_after_visible_commit',
    'original_retry_and_sibling_retry_compete', 'populated_v15_migrates_and_restarts',
    'canary_rollback_while_turn_in_flight', 'same_fingerprint_adjacent_revisions',
    'cloud_waiting_does_not_block_next_local_turn', 'pc_android_receipt_conflict_is_quarantined',
    'conversation_clear_after_outbox_snapshot', 'redacted_group_stale_outbox_snapshot_does_not_send'
  ].map(id => ({ id, status: 'passed', passed: 1, failed: 0, skipped: 0 }));
  return {
    schemaVersion: 'yuqi-v3-race-report-v1', candidateReleaseId,
    registryChecksum: 'b'.repeat(64), overallChecksum: 'c'.repeat(64),
    releaseEligible: false,
    pcCases,
    connectedAndroidCases: CONNECTED_DEVICE_RACE_NAMES.map(id => ({
      id, status: 'pending_connected_android', passed: 0, failed: 0, skipped: 0
    }))
  };
}

function qualityFixturePlan() {
  return createQualityReplayPlan({ rootDir: process.cwd() });
}

function buildQualityBundleFixture(root, candidateReleaseId) {
  const plan = qualityFixturePlan();
  const runId = '11111111-1111-4111-8111-111111111111';
  const executionPairs = plan.items.map(item => ({
    ...(() => { const executionChecksum = contentHash(compileSceneExecutionInput(item.scene)); return { executionChecksum }; })(),
    finalKey: `${item.layer}:${item.sceneId}:${item.repeatIndex}`,
    sourceHead: SOURCE_HEAD, stableReleaseId: 'stable-fixture', stableReleaseChecksum: 'd'.repeat(64),
    candidateReleaseId, candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    stableInputChecksum: contentHash(compileSceneExecutionInput(item.scene)), candidateInputChecksum: contentHash(compileSceneExecutionInput(item.scene)),
    dryRun: true, capabilities: { visible: false, actions: false }
  }));
  const modelRuns = executionPairs.map(pair => ({
    finalKey: pair.finalKey, attemptIndex: 0, evaluatorId: 'blind-fixture', inputChecksum: 'f'.repeat(64), completed: true
  }));
  const finals = plan.items.map(item => {
    const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
    const attempt = {
      attemptIndex: 0,
      evaluatorId: 'blind-fixture', evaluatorVersion: 'blind-fixture', executionChecksum: contentHash(compileSceneExecutionInput(item.scene)),
      latencyMs: 1, accepted: true, unresolved: false
    };
    return {
      layer: item.layer, sceneId: item.sceneId, repeatIndex: item.repeatIndex, finalized: true,
      scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
        'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
      preference: 'candidate', findings: [], regression: false, severe: false, tie: false, unresolved: false,
      structuralRegression: false, protocolFailure: false, executionChecksum: contentHash(compileSceneExecutionInput(item.scene)), latencyMs: 1,
      evaluatorVersion: 'blind-fixture', attempts: [attempt]
    };
  });
  const provenanceBase = { runId, sourceHead: SOURCE_HEAD, executionPairs, modelRuns };
  const provenance = { ...provenanceBase, provenanceChecksum: sha256(provenanceBase) };
  const replayRows = [
    ...finals.flatMap(row => row.attempts.map(attempt => ({ recordType: 'attempt', runId,
      layer: row.layer, sceneId: row.sceneId, repeatIndex: row.repeatIndex, ...attempt }))),
    ...finals.map(row => ({ recordType: 'final', runId, ...row })),
    { recordType: 'provenance', runId, sourceHead: SOURCE_HEAD, provenanceChecksum: provenance.provenanceChecksum },
    ...executionPairs.map(row => ({ recordType: 'execution', runId, ...row })),
    ...modelRuns.map(row => ({ recordType: 'model', runId, ...row })),
    ...finals.map(row => ({ recordType: 'final-checksum', runId,
      finalKey: `${row.layer}:${row.sceneId}:${row.repeatIndex}`, executionChecksum: row.executionChecksum,
      latencyMs: row.latencyMs, evaluatorVersion: row.evaluatorVersion }))
  ];
  const expected = expectedFinalKeysProjection(plan);
  const evidence = {
    sentinelRuns: finals.filter(row => row.layer === 'sentinel'),
    coverageRuns: finals.filter(row => row.layer === 'coverage'),
    historyRuns: finals.filter(row => row.layer === 'history')
  };
  const requirements = deriveManualReviewRequirements(evidence, plan, { includePassingSample: true });
  const manualRows = [
    { recordType: 'metadata', runId, sourceHead: SOURCE_HEAD, candidateReleaseId,
      candidateReleaseChecksum: CANDIDATE_CHECKSUM, planChecksum: plan.planChecksum },
    ...requirements.map((requirement, index) => ({
      recordType: 'review', runId, reviewId: `review-${index}`, evalRunId: runId,
      sceneId: requirement.sceneId, repeatIndex: requirement.repeatIndex,
      evidenceFindingIds: requirement.evidenceFindingIds, decision: 'confirm', reason: 'fixture',
      reviewer: 'central_window', createdAt: 1
    }))
  ];
  const replayBytes = Buffer.from(`${replayRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const manualBytes = Buffer.from(`${manualRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const qualityGate = aggregateQualityGate(evidence, expected);
  const manualReview = {
    eligible: true, failedGates: [], unresolvedCount: 0, requiredCount: requirements.length,
    requirements, queue: manualRows.slice(1).map(({ recordType: _recordType, runId: _runId, ...row }) => row)
  };
  const candidateRelease = {
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0', cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2',
    evaluatorVersion: 'quality-evaluator-v1', modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 1,
    releaseId: candidateReleaseId, releaseChecksum: CANDIDATE_CHECKSUM
  };
  const evidenceBoundary = {
    version: 1, inputMode: 'preset_default', sourceClass: 'tracked_human_annotations',
    offlineModelEvaluation: true, realHistoryEvidence: false, liveShadowEvidence: false
  };
  const quality = {
    version: 1, productionReleaseMutation: false, candidateRelease, planChecksum: plan.planChecksum,
    evidenceBoundary,
    replayProvenance: provenance, replayRunId: runId,
    qualityPlanSha256: sha256(Buffer.from(`${JSON.stringify(plan)}\n`)),
    qualityReplaySha256: sha256(replayBytes), qualityManualReviewSha256: sha256(manualBytes),
    qualityGate, manualReview, eligible: qualityGate.eligible && manualReview.eligible,
    failedGates: [...qualityGate.failedGates, ...manualReview.failedGates], sourceHead: SOURCE_HEAD,
    evidenceBoundaryChecksum: evidenceBoundaryChecksum({
      evidenceBoundary, planChecksum: plan.planChecksum, sourceHead: SOURCE_HEAD,
      provenanceChecksum: provenance.provenanceChecksum
    })
  };
  return { plan, replayBytes, manualBytes, quality };
}

function writeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-readiness-v1-'));
  const run = join(root, 'run');
  mkdirSync(run, { recursive: true });
  const candidateReleaseId = 'quality_candidate_1';
  const deviceSerial = 'emulator-5554';
  const startedAt = Date.now() - 1000;
  const xml = `<testsuite>${CONNECTED_DEVICE_RACE_NAMES.map(name =>
    `<testcase classname="${CONNECTED_DEVICE_RACE_TEST_CLASS}" name="${name}"/>`).join('')}</testsuite>`;
  writeFileSync(join(run, 'connected.xml'), xml);
  const sourceRace = closedRace(candidateReleaseId);
  const clonePath = join(root, 'run', 'migrationClone.sqlite');
  const clone = new DatabaseSync(clonePath);
  try {
    clone.exec('PRAGMA user_version=15');
    for (const table of ['messages','facts','life_episodes','turns','cloud_deliveries','conversation_clear_controls',
      'turn_authority_lineages','visible_result_groups','visible_result_items','visible_result_actions',
      'visible_result_manifests','visible_commit_receipts']) {
      clone.exec(`CREATE TABLE ${table}(id INTEGER)`);
    }
  } finally { clone.close(); }
  const migration = closedMigration();
  migration.workingDatabaseSha256 = sha256(readFileSync(clonePath));
  const migrationSemantic = { ...migration.v14InvariantSummary.semantic };
  delete migrationSemantic.checksum;
  migration.v14InvariantSummary.semantic.checksum = sha256(migrationSemantic);
  const sourceRaceBytes = Buffer.from(`${JSON.stringify(sourceRace)}\n`, 'utf8');
  const qualityBundle = buildQualityBundleFixture(root, candidateReleaseId);
  const connected = {
    schemaVersion: 'yuqi-v3-connected-device-report-v1',
    candidateReleaseId, candidateReleaseChecksum: CANDIDATE_CHECKSUM, sourceHead: SOURCE_HEAD,
    deviceSerial, testClass: CONNECTED_DEVICE_RACE_TEST_CLASS,
    startedAt, completedAt: startedAt + 10, xmlPath: 'run/connected.xml',
    xmlSha256: sha256(Buffer.from(xml)),
    sourceRaceReportSha256: sha256(sourceRaceBytes),
    sourceRaceOverallChecksum: sourceRace.overallChecksum,
    sourceRegistryChecksum: sourceRace.registryChecksum,
    replacements: [...CONNECTED_DEVICE_RACE_NAMES],
    results: Object.fromEntries(CONNECTED_DEVICE_RACE_NAMES.map(name => [name,
      { name, status: 'passed', passed: 1, failed: 0, skipped: 0,
        checksum: sha256({ name, status: 'passed', passed: 1, failed: 0, skipped: 0 }) }]))
  };
  const values = {
    baseline: { gitHead: '5'.repeat(40), database: { sha256: 'a'.repeat(64), sourceChangedDuringAudit: false } },
    migration,
    protocol: closedProtocol(candidateReleaseId),
    quality: qualityBundle.quality,
    qualityPlan: qualityBundle.plan,
    qualityReplay: qualityBundle.replayBytes,
    qualityManualReview: qualityBundle.manualBytes,
    races: sourceRace,
    androidFallback: closedFallback(candidateReleaseId),
    rolloutStatus: closedRollout(candidateReleaseId),
    visiblePathMetrics: closedVisiblePathMetrics(candidateReleaseId, root),
    nodeTests: {
      candidateReleaseId, candidateReleaseChecksum: CANDIDATE_CHECKSUM, sourceHead: SOURCE_HEAD,
      exitCode: 0, tests: 1200, passed: 1200, failed: 0, skipped: 0,
      outputSha256: 'f'.repeat(64),
      sentinel: {
        path: 'yuqi-runtime/test/android-fallback-authority.test.mjs',
        exitCode: 0, tests: 5, passed: 5, failed: 0, skipped: 0, outputSha256: 'c'.repeat(64)
      }
    },
    androidTests: {
      candidateReleaseId, candidateReleaseChecksum: CANDIDATE_CHECKSUM, sourceHead: SOURCE_HEAD,
      exitCode: 0, passed: CONNECTED_DEVICE_RACE_NAMES.length,
      failed: 0, skipped: 0, deviceSerial,
      outputSha256: 'd'.repeat(64), webAssetChecksums: { 'index.html': 'e'.repeat(64) }
    },
    connectedDeviceRaces: connected
  };
  const artifacts = {};
  for (const key of ARTIFACT_NAMES) {
    const relative = key === 'migrationClone' ? 'run/migrationClone.sqlite'
      : key === 'qualityPlan' ? 'run/quality-replay-plan.json'
        : key === 'qualityReplay' ? 'run/quality-replay.jsonl'
          : key === 'qualityManualReview' ? 'run/quality-manual-review.jsonl' : `run/${key}.json`;
    if (key === 'migrationClone') {
      artifacts[key] = { path: relative, sha256: sha256(readFileSync(join(root, relative))) };
      continue;
    }
    const bytes = Buffer.isBuffer(values[key])
      ? values[key] : Buffer.from(`${JSON.stringify(values[key])}\n`, 'utf8');
    writeFileSync(join(root, relative), bytes);
    artifacts[key] = { path: relative, sha256: sha256(bytes) };
  }
  const input = {
    schemaVersion: 'yuqi-v3-readiness-input-v1', candidateReleaseId,
    sourceHead: SOURCE_HEAD, createdAt: startedAt + 5, deviceSerial,
    artifacts
  };
  const manifestPath = join(root, 'readiness-input.json');
  writeFileSync(manifestPath, `${JSON.stringify(input, null, 2)}\n`);
  return { root, manifestPath, input, values };
}

function rewriteVisiblePathMetrics(fixture, mutate) {
  const file = join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  mutate(report);
  delete report.reportChecksum;
  report.reportChecksum = sha256(report);
  writeFileSync(file, `${JSON.stringify(report)}\n`);
  fixture.input.artifacts.visiblePathMetrics.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
}

function writeRunFixedInputsWithoutVisibleMetrics(evidence, fixture) {
  mkdirSync(evidence, { recursive: true });
  mkdirSync(join(evidence, 'private'), { recursive: true });
  if (!existsSync(join(evidence, VISIBLE_PATH_START_FILE))) {
    writeFileSync(join(evidence, VISIBLE_PATH_START_FILE),
      readFileSync(join(fixture.root, VISIBLE_PATH_START_FILE)), { flag: 'wx' });
  }
  const fixedFiles = {
    baseline: 'baseline.json',
    migration: 'history-source-v15-migration-report.json',
    migrationClone: 'history-source-v15.sqlite',
    protocol: 'protocol-report.json',
    quality: 'quality-report.json',
    qualityPlan: 'quality-replay-plan.json',
    qualityReplay: 'quality-replay.jsonl',
    qualityManualReview: 'quality-manual-review.jsonl',
    races: 'race-report.json',
    androidFallback: 'android-fallback-report.json',
    rolloutStatus: 'rollout-status.json'
  };
  for (const [key, filename] of Object.entries(fixedFiles)) {
    const value = key === 'migrationClone'
      ? readFileSync(join(fixture.root, 'run/migrationClone.sqlite'))
      : fixture.values[key];
    const bytes = Buffer.isBuffer(value)
      ? value : Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    writeFileSync(join(evidence, filename), bytes);
  }
  assert.equal(existsSync(join(evidence, 'visible-path-metrics.json')), false);
  return { candidateReleaseId: fixture.input.candidateReleaseId };
}

function makeFormalRunFixture() {
  const fixture = writeFixture();
  const evidence = join(fixture.root, 'artifacts', 'yuqi-lived-agency-v3', 'formal-evidence');
  fixture.values.visiblePathMetrics = closedVisiblePathMetrics(
    fixture.input.candidateReleaseId, evidence, fixture.root);
  const formalOutputBytes = Object.fromEntries([
    VISIBLE_PATH_XML_FILE, 'private/visible-path-android.jsonl', 'private/visible-path-pc.jsonl'
  ].map(relative => [relative, readFileSync(join(evidence, relative))]));
  for (const relative of [
    VISIBLE_PATH_XML_FILE, 'private/visible-path-android.jsonl', 'private/visible-path-pc.jsonl'
  ]) rmSync(join(evidence, relative));
  writeRunFixedInputsWithoutVisibleMetrics(evidence, fixture);
  mkdirSync(join(fixture.root, 'tavern-app'), { recursive: true });
  mkdirSync(join(fixture.root, 'android', 'app', 'src', 'main', 'assets', 'public'), { recursive: true });
  const webAsset = '<script>acknowledgeNativeUiAppliedOnce</script>';
  writeFileSync(join(fixture.root, 'tavern-app', 'index.html'), webAsset);
  writeFileSync(join(fixture.root, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html'), webAsset);
  const xmlRoot = join(fixture.root, 'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'emulator-5554');
  mkdirSync(xmlRoot, { recursive: true });
  const xml = `<testsuite>${CONNECTED_DEVICE_RACE_NAMES.map(name =>
    `<testcase classname="${CONNECTED_DEVICE_RACE_TEST_CLASS}" name="${name}"/>`).join('')}</testsuite>`;
  const xmlFile = join(xmlRoot, 'TEST-YuqiV3ConnectedRaceTest.xml');
  writeFileSync(xmlFile, xml);
  utimesSync(xmlFile, new Date(0), new Date(0));
  return {
    ...fixture,
    evidence,
    webAsset,
    xmlRoot,
    xmlFile,
    xml,
    formalOutputBytes,
    cleanup: () => rmSync(fixture.root, { recursive: true, force: true })
  };
}

test('readiness loads only a real disk manifest and validates every raw artifact/XML byte', () => {
  const fixture = writeFixture();
  const metrics = fixture.values.visiblePathMetrics;
  const start = JSON.parse(readFileSync(join(fixture.root, VISIBLE_PATH_START_FILE), 'utf8'));
  assert.ok(existsSync(join(fixture.root, VISIBLE_PATH_XML_FILE)));
  assert.equal(metrics.collectionAttestation.android.startControlChecksum, start.checksum);
  assert.equal(
    metrics.collectionAttestation.android.testXmlSha256,
    sha256(readFileSync(join(fixture.root, VISIBLE_PATH_XML_FILE)))
  );
  assert.equal(metrics.collectionAttestation.android.outputSha256, metrics.androidExportSha256);
  assert.equal(metrics.collectionAttestation.pc.outputSha256, metrics.pcExportSha256);
  assert.equal(
    metrics.collectionAttestation.pc.sourceDatabaseSha256,
    JSON.parse(readFileSync(join(fixture.root, 'private/visible-path-pc.jsonl'), 'utf8').split(/\r?\n/, 1)[0])
      .producerAttestation.sourceDatabaseSha256
  );
  const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
  const result = verifyReadiness(evidence);
  assert.equal(result.ready, true);
  assert.equal(Object.keys(result.checksums).length, 15);
  const rawManifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
  rawManifest.artifacts.quality.sha256 = '0'.repeat(64);
  writeFileSync(fixture.manifestPath, `${JSON.stringify(rawManifest)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /readiness evidence/);
});

test('readiness rejects missing/extra/path-escape/serial/sentinel/XML and stale evidence', () => {
  for (const mutation of [
    fixture => delete fixture.input.artifacts.protocol,
    fixture => { fixture.input.extra = true; },
    fixture => { fixture.input.artifacts.quality.path = '../outside.json'; },
    fixture => { fixture.input.deviceSerial = 'other-device'; },
    fixture => { fixture.values.nodeTests.sentinel.skipped = 1; },
    fixture => { fixture.values.connectedDeviceRaces.results[CONNECTED_DEVICE_RACE_NAMES[0]].failed = 1; },
    fixture => { fixture.values.connectedDeviceRaces.replacements[0] = 'wrong-connected-case'; }
  ]) {
    const fixture = writeFixture();
    mutation(fixture);
    if (fixture.input.extra || fixture.input.artifacts.protocol === undefined
      || fixture.input.artifacts.quality.path.startsWith('..')) {
      writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
    } else {
      for (const key of ['nodeTests', 'connectedDeviceRaces']) {
        const bytes = Buffer.from(`${JSON.stringify(fixture.values[key])}\n`);
        writeFileSync(join(fixture.root, fixture.input.artifacts[key].path), bytes);
        fixture.input.artifacts[key].sha256 = sha256(bytes);
      }
      if (fixture.input.deviceSerial !== 'emulator-5554') writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
    }
    assert.throws(() => {
      const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
      assert.equal(verifyReadiness(evidence).ready, false);
    }, /readiness evidence/);
  }
});

test('readiness accepts only the populated v14-to-v15 history migration report', async () => {
  const fixture = writeFixture();
  const fixedNames = {
    baseline: 'baseline.json', migration: 'history-source-v15-migration-report.json', migrationClone: 'history-source-v15.sqlite', protocol: 'protocol-report.json',
    quality: 'quality-report.json', races: 'race-report.json', androidFallback: 'android-fallback-report.json',
    rolloutStatus: 'rollout-status.json'
  };
  for (const [key, filename] of Object.entries(fixedNames)) {
    if (key === 'migrationClone') writeFileSync(join(fixture.root, filename), readFileSync(join(fixture.root, 'run/migrationClone.sqlite')));
    else writeFileSync(join(fixture.root, filename), `${JSON.stringify(fixture.values[key])}\n`);
  }
  const oldPath = join(fixture.root, 'migration-report.json');
  writeFileSync(oldPath, `${JSON.stringify(fixture.values.migration)}\n`);
  const result = preflightFixedReadinessInputs(fixture.root);
  assert.equal(result.failedGates.includes('MISSING_FIXED_MIGRATION'), false);
  rmSync(oldPath, { force: true });
  rmSync(join(fixture.root, 'history-source-v15-migration-report.json'), { force: true });
  const blocked = preflightFixedReadinessInputs(fixture.root);
  assert.ok(blocked.failedGates.includes('MISSING_FIXED_MIGRATION'));
});

test('migration authority corruption is rejected even when hashes are well formed', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.migration.path);
  const mutated = { ...fixture.values.migration, sourceUserVersion: 10 };
  writeFileSync(file, `${JSON.stringify(mutated)}\n`);
  fixture.input.artifacts.migration.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /migration/);
});

test('migration clone reopens read-only and rejects non-empty WAL sidecars', () => {
  const fixture = writeFixture();
  const sidecar = `${fixture.root}/${fixture.input.artifacts.migrationClone.path}-wal`;
  writeFileSync(sidecar, Buffer.from('unbound wal bytes'));
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /migration clone/);
});

test('blocked readiness report keeps unknown identities and all fifteen checksums null', () => {
  const report = materializeBlockedReadinessReport({ failedGate: 'METRICS_EVIDENCE_UNAVAILABLE' });
  assert.equal(report.ready, false);
  assert.equal(report.candidateReleaseId, null);
  assert.equal(report.sourceHead, null);
  assert.equal(report.deviceSerial, null);
  assert.equal(report.inputSha256, null);
  assert.deepEqual(Object.keys(report.artifactChecksums).sort(), [...ARTIFACT_NAMES].sort());
  assert.ok(Object.values(report.artifactChecksums).every(value => value === null));
});

test('a blocked readiness report is immutable and cannot be overwritten by a later result', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'yuqi-readiness-report-'));
  const evidence = join(repoRoot, 'artifacts', 'yuqi-lived-agency-v3', 'run-1');
  mkdirSync(evidence, { recursive: true });
  const outPath = join(evidence, 'readiness-report.json');
  const blocked = materializeBlockedReadinessReport({ failedGate: 'BLOCKED_ONCE' });
  const replacement = materializeBlockedReadinessReport({ failedGate: 'DIFFERENT_RESULT' });
  try {
    await writeReadinessReportExclusive({ outPath, evidenceDirectory: evidence, repoRoot, report: blocked });
    const before = readFileSync(outPath);
    await assert.rejects(() => writeReadinessReportExclusive({
      outPath, evidenceDirectory: evidence, repoRoot, report: replacement
    }), /already exists|immutable/i);
    assert.deepEqual(readFileSync(outPath), before);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('eligible quality without visible-path metrics is blocked by stable metrics gate', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path);
  const mutated = { ...fixture.values.visiblePathMetrics };
  delete mutated.metrics;
  writeFileSync(file, `${JSON.stringify(mutated)}\n`);
  fixture.input.artifacts.visiblePathMetrics.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /visible path metrics/);
});

test('aggregate-only visible path metrics are rejected until raw sample provenance is closed', () => {
  const fixture = writeFixture();
  const aggregateOnly = {
    schemaVersion: 'yuqi-v3-visible-path-metrics-v1',
    candidateReleaseId: fixture.input.candidateReleaseId,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    sourceHead: SOURCE_HEAD,
    metrics: { directReplyMedianMs: 0, directReplyP95Ms: 0, maximumVisibleMs: 0, shadowBlockedVisibleCount: 0 },
    productionReleaseMutation: false, startedAt: Date.now() - 10, completedAt: Date.now(), reportChecksum: 'a'.repeat(64)
  };
  const file = join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path);
  writeFileSync(file, `${JSON.stringify(aggregateOnly)}\n`);
  fixture.input.artifacts.visiblePathMetrics.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /visible path metrics keys/);
});

test('visible path metrics bind raw Android/PC JSONL bytes and closed sample joins', () => {
  const refresh = fixture => {
    const file = join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path);
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const androidExport = join(fixture.root, report.androidExportPath);
    const pcExport = join(fixture.root, report.pcExportPath);
    const androidRecords = readFileSync(androidExport, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
    const pcRecords = readFileSync(pcExport, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
    androidRecords[0].producerAttestation.selectionChecksum = sha256({
      producer: 'room_authority_export_v1', rows: androidRecords.slice(1)
    });
    pcRecords[0].producerAttestation.selectionChecksum = sha256({
      producer: 'pc_authority_readonly_export_v1', rows: pcRecords.slice(1)
    });
    writeFileSync(androidExport, `${androidRecords.map(row => JSON.stringify(row)).join('\n')}\n`);
    writeFileSync(pcExport, `${pcRecords.map(row => JSON.stringify(row)).join('\n')}\n`);
    report.androidExportSha256 = sha256(readFileSync(join(fixture.root, report.androidExportPath)));
    report.pcExportSha256 = sha256(readFileSync(join(fixture.root, report.pcExportPath)));
    report.producerAttestationChecksum = sha256({
      android: androidRecords[0].producerAttestation,
      pc: pcRecords[0].producerAttestation
    });
    report.metadataSha256 = sha256({
      androidExportPath: report.androidExportPath,
      androidExportSha256: report.androidExportSha256,
      candidateReleaseChecksum: report.candidateReleaseChecksum,
      candidateReleaseId: report.candidateReleaseId,
      deviceSerial: report.deviceSerial,
      pcExportPath: report.pcExportPath,
      pcExportSha256: report.pcExportSha256,
      runId: report.runId,
      sampleSetChecksum: report.sampleSetChecksum,
      sourceHead: report.sourceHead
    });
    delete report.reportChecksum;
    report.reportChecksum = sha256(report);
    writeFileSync(file, `${JSON.stringify(report)}\n`);
    fixture.input.artifacts.visiblePathMetrics.sha256 = sha256(readFileSync(file));
    writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  };
  const independent = writeFixture();
  const independentPc = join(independent.root, 'private/visible-path-pc.jsonl');
  const independentRows = readFileSync(independentPc, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
  assert.ok(independentRows.slice(1).every(row => !('sampleId' in row) && !('createdAt' in row)));
  writeFileSync(independentPc, `${independentRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  refresh(independent);
  assert.doesNotThrow(() => loadReadinessManifest({
    manifestPath: independent.manifestPath, evidenceDirectory: independent.root
  }));
  const cases = [
    fixture => {
      const report = JSON.parse(readFileSync(join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path), 'utf8'));
      report.androidExportPath = '../outside.jsonl';
      delete report.reportChecksum;
      report.reportChecksum = sha256(report);
      const file = join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path);
      writeFileSync(file, `${JSON.stringify(report)}\n`);
      fixture.input.artifacts.visiblePathMetrics.sha256 = sha256(readFileSync(file));
      writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
    },
    fixture => rmSync(join(fixture.root, 'private/visible-path-pc.jsonl')),
    fixture => {
      const file = join(fixture.root, 'private/visible-path-android.jsonl');
      const rows = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
      rows[1].extra = 'unknown';
      writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
      refresh(fixture);
    },
    fixture => {
      const file = join(fixture.root, 'private/visible-path-pc.jsonl');
      const rows = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
      rows[1].pipelineReleaseId = 'foreign-release';
      writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
      refresh(fixture);
    },
    fixture => {
      const file = join(fixture.root, 'private/visible-path-pc.jsonl');
      const rows = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
      rows[1].createdAt = 123;
      writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
      refresh(fixture);
    },
    fixture => {
      const file = join(fixture.root, 'private/visible-path-pc.jsonl');
      const raw = readFileSync(file, 'utf8');
      writeFileSync(file, raw.replace(/\n/, '\n\n'));
    }
  ];
  for (const mutate of cases) {
    const fixture = writeFixture();
    mutate(fixture);
    assert.throws(() => loadReadinessManifest({
      manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root
    }), /visible path metrics/);
  }
});

test('readiness rejects a visible-path report with null collection attestation', () => {
  const fixture = writeFixture();
  rewriteVisiblePathMetrics(fixture, report => { report.collectionAttestation = null; });
  assert.throws(() => {
    const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
    verifyReadiness(evidence);
  }, /collection attestation/i);
});

test('readiness rejects missing or tampered collection start control before accepting metrics', () => {
  for (const mutate of [
    fixture => rmSync(join(fixture.root, VISIBLE_PATH_START_FILE)),
    fixture => {
      const file = join(fixture.root, VISIBLE_PATH_START_FILE);
      const start = JSON.parse(readFileSync(file, 'utf8'));
      start.candidateReleaseId = 'foreign-candidate';
      writeFileSync(file, `${JSON.stringify(start)}\n`);
    }
  ]) {
    const fixture = writeFixture();
    mutate(fixture);
    assert.throws(() => {
      const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
      verifyReadiness(evidence);
    }, /start control|collection attestation/i);
  }
});

test('readiness rejects missing or hash-tampered instrumentation XML', () => {
  for (const mutate of [
    fixture => rmSync(join(fixture.root, VISIBLE_PATH_XML_FILE)),
    fixture => {
      const file = join(fixture.root, VISIBLE_PATH_XML_FILE);
      writeFileSync(file, '<testsuite><testcase name="tampered"/></testsuite>\n');
    }
  ]) {
    const fixture = writeFixture();
    mutate(fixture);
    assert.throws(() => {
      const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
      verifyReadiness(evidence);
    }, /XML|collection attestation|test XML/i);
  }
});

test('readiness rejects a self-consistent replay through a second fresh instrumentation XML path', () => {
  const fixture = writeFixture();
  const originalReport = fixture.values.visiblePathMetrics;
  const sourcePath = originalReport.collectionAttestation.android.testXmlSourcePath;
  const sourceBytes = readFileSync(join(fixture.root, ...sourcePath.split('/')));
  const replayPath =
    'android/app/build/outputs/androidTest-results/connected/debug/replayed/TEST-replayed.xml';
  const replayFile = join(fixture.root, ...replayPath.split('/'));
  mkdirSync(join(replayFile, '..'), { recursive: true });
  writeFileSync(replayFile, sourceBytes);
  const replayMtime = originalReport.collectionAttestation.android.testXmlSourceMtimeMs + 1;
  utimesSync(replayFile, new Date(replayMtime), new Date(replayMtime));
  rewriteVisiblePathMetrics(fixture, report => {
    report.collectionAttestation.android.testXmlSourcePath = replayPath;
    report.collectionAttestation.android.testXmlSourceMtimeMs = replayMtime;
    const { checksum: _checksum, ...base } = report.collectionAttestation;
    report.collectionAttestation = { ...report.collectionAttestation, checksum: sha256(base) };
  });
  assert.throws(() => loadReadinessManifest({
    manifestPath: fixture.manifestPath,
    evidenceDirectory: fixture.root
  }), /instrumentation XML source|XML authority/i);
});

test('readiness rejects linked Gradle result roots and linked replay subtrees without writing a report', () => {
  for (const profile of ['linked-root', 'linked-replay-subtree']) {
    const fixture = writeFixture();
    const external = mkdtempSync(join(tmpdir(), 'yuqi-readiness-linked-xml-'));
    try {
      const report = fixture.values.visiblePathMetrics;
      const sourcePath = report.collectionAttestation.android.testXmlSourcePath;
      const sourceFile = join(fixture.root, ...sourcePath.split('/'));
      const resultRoot = join(fixture.root,
        'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'debug');
      const replayFile = join(external, sourcePath.split('/').at(-1));
      writeFileSync(replayFile, readFileSync(sourceFile));
      const sourceMtime = report.collectionAttestation.android.testXmlSourceMtimeMs;
      utimesSync(replayFile, new Date(sourceMtime), new Date(sourceMtime));
      if (profile === 'linked-root') {
        rmSync(resultRoot, { recursive: true, force: true });
        symlinkSync(external, resultRoot, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        symlinkSync(external, join(resultRoot, 'linked-replay'),
          process.platform === 'win32' ? 'junction' : 'dir');
      }
      assert.throws(() => loadReadinessManifest({
        manifestPath: fixture.manifestPath,
        evidenceDirectory: fixture.root
      }), /instrumentation XML source|XML authority/i, profile);
      assert.equal(existsSync(join(fixture.root, 'readiness-report.json')), false, profile);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  }
});

test('readiness rejects collection command and PC source provenance tampering', () => {
  for (const mutate of [
    report => { report.collectionAttestation.android.commandChecksum = '0'.repeat(64); },
    report => {
      report.collectionAttestation.android.pullCommandDescriptor.args = [
        ...report.collectionAttestation.android.pullCommandDescriptor.args.slice(0, -1),
        '/data/user/0/com.siyi.al/files/visible-path/forged/output.jsonl'
      ];
      report.collectionAttestation.android.pullCommandChecksum =
        sha256(report.collectionAttestation.android.pullCommandDescriptor);
    },
    report => {
      report.collectionAttestation.android.pullCommandDescriptor.command =
        join(process.cwd(), 'fake', 'not-adb.exe');
      report.collectionAttestation.android.pullCommandChecksum =
        sha256(report.collectionAttestation.android.pullCommandDescriptor);
    },
    report => { report.collectionAttestation.pc.sourceDatabaseSha256 = '0'.repeat(64); },
    report => { report.collectionAttestation.android.testXmlSourcePath =
      'android/app/build/outputs/androidTest-results/connected/reused/TEST-old.xml'; },
    report => { report.collectionAttestation.android.testXmlSourceMtimeMs = report.completedAt; }
  ]) {
    const fixture = writeFixture();
    rewriteVisiblePathMetrics(fixture, report => {
      mutate(report);
      const { checksum: _checksum, ...base } = report.collectionAttestation;
      report.collectionAttestation = { ...report.collectionAttestation, checksum: sha256(base) };
    });
    assert.throws(() => {
      const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
      verifyReadiness(evidence);
    }, /collection attestation|command|PC source|database provenance/i);
  }
});

test('visible path metrics reject caller JSONL without Android Room and PC authority attestations', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.visiblePathMetrics.path);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  for (const exportPath of [report.androidExportPath, report.pcExportPath]) {
    const exportFile = join(fixture.root, exportPath);
    const rows = readFileSync(exportFile, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
    delete rows[0].producerAttestation;
    writeFileSync(exportFile, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  }
  report.androidExportSha256 = sha256(readFileSync(join(fixture.root, report.androidExportPath)));
  report.pcExportSha256 = sha256(readFileSync(join(fixture.root, report.pcExportPath)));
  delete report.reportChecksum;
  report.reportChecksum = sha256(report);
  writeFileSync(file, `${JSON.stringify(report)}\n`);
  fixture.input.artifacts.visiblePathMetrics.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({
    manifestPath: fixture.manifestPath,
    evidenceDirectory: fixture.root
  }), /producer|attestation|visible path metrics/i);
});

test('quality report rejects legacy top-level metrics instead of treating them as evidence', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.quality.path);
  const mutated = { ...fixture.values.quality, metrics: { directReplyMedianMs: 1, directReplyP95Ms: 1, maximumVisibleMs: 1, shadowBlockedVisibleCount: 0 } };
  writeFileSync(file, `${JSON.stringify(mutated)}\n`);
  fixture.input.artifacts.quality.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /quality report keys/);
});

test('readiness rejects an explicit history override as tracked annotation evidence', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.quality.path);
  const quality = JSON.parse(readFileSync(file, 'utf8'));
  quality.evidenceBoundary = {
    ...quality.evidenceBoundary,
    inputMode: 'explicit_override',
    sourceClass: 'explicit_history_override'
  };
  writeFileSync(file, `${JSON.stringify(quality)}\n`);
  fixture.input.artifacts.quality.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({
    manifestPath: fixture.manifestPath,
    evidenceDirectory: fixture.root
  }), /quality evidence boundary/i);
});

test('readiness manifest rejects legacy top-level metrics; metrics live only in the bound artifact', () => {
  const fixture = writeFixture();
  fixture.input.metrics = { directReplyMedianMs: 1 };
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /manifest keys/);
});

test('ready candidate identity requires a common release checksum', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.protocol.path);
  const mutated = { ...fixture.values.protocol, candidateReleaseChecksum: 'c'.repeat(64) };
  mutated.reportChecksum = reportChecksum(mutated);
  writeFileSync(file, `${JSON.stringify(mutated)}\n`);
  fixture.input.artifacts.protocol.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({
    manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root
  }), /quality candidate checksum binding/);
});

test('candidate-bound fixed reports require the manifest sourceHead, not just candidate id/checksum', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.protocol.path);
  const mutated = { ...fixture.values.protocol, sourceHead: 'f'.repeat(40) };
  mutated.reportChecksum = reportChecksum(mutated);
  writeFileSync(file, `${JSON.stringify(mutated)}\n`);
  fixture.input.artifacts.protocol.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /protocol sourceHead/);
});

test('quality report candidate id and checksum are bound to the manifest', () => {
  for (const mutation of [
    quality => { quality.candidateRelease.releaseId = 'quality_candidate_other'; },
    quality => { quality.candidateRelease.releaseChecksum = 'd'.repeat(64); },
    quality => { quality.sourceHead = 'f'.repeat(40); },
    quality => { delete quality.sourceHead; }
  ]) {
    const fixture = writeFixture();
    const quality = structuredClone(fixture.values.quality);
    mutation(quality);
    const file = join(fixture.root, fixture.input.artifacts.quality.path);
    writeFileSync(file, `${JSON.stringify(quality)}\n`);
    fixture.input.artifacts.quality.sha256 = sha256(readFileSync(file));
    writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
    assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /quality/);
  }
});

test('readiness rejects a self-consistent alternate quality plan and report', () => {
  const fixture = writeFixture();
  const planPath = join(fixture.root, fixture.input.artifacts.qualityPlan.path);
  const qualityPath = join(fixture.root, fixture.input.artifacts.quality.path);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  plan.historyManifest = { ...plan.historyManifest, scenesChecksum: 'f'.repeat(64) };
  plan.commitments = { ...plan.commitments, historyScenesChecksum: 'f'.repeat(64) };
  plan.planChecksum = contentHash({
    version: 1,
    planType: plan.planType,
    finalKeys: plan.finalKeys,
    commitments: plan.commitments,
    historyManifest: plan.historyManifest
  });
  writeFileSync(planPath, `${JSON.stringify(plan)}\n`);
  const quality = JSON.parse(readFileSync(qualityPath, 'utf8'));
  quality.planChecksum = plan.planChecksum;
  quality.qualityPlanSha256 = sha256(Buffer.from(`${JSON.stringify(plan)}\n`));
  quality.evidenceBoundaryChecksum = evidenceBoundaryChecksum({
    evidenceBoundary: quality.evidenceBoundary,
    planChecksum: quality.planChecksum,
    sourceHead: quality.sourceHead,
    provenanceChecksum: quality.replayProvenance.provenanceChecksum
  });
  writeFileSync(qualityPath, `${JSON.stringify(quality)}\n`);
  fixture.input.artifacts.qualityPlan.sha256 = sha256(readFileSync(planPath));
  fixture.input.artifacts.quality.sha256 = sha256(readFileSync(qualityPath));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  let failure;
  try {
    loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /quality tracked plan checksum/i);
});

test('readiness tracked quality source is explicit and independent of process cwd', () => {
  const fixture = writeFixture();
  const previous = process.cwd();
  const elsewhere = mkdtempSync(join(tmpdir(), 'yuqi-readiness-cwd-'));
  try {
    process.chdir(elsewhere);
    assert.doesNotThrow(() => loadReadinessManifest({
      manifestPath: fixture.manifestPath,
      evidenceDirectory: fixture.root,
      qualitySourceDirectory: previous
    }));
  } finally {
    process.chdir(previous);
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('readiness rejects a self-consistent eligible quality report with empty replay provenance', () => {
  const fixture = writeFixture();
  const file = join(fixture.root, fixture.input.artifacts.quality.path);
  const quality = JSON.parse(readFileSync(file, 'utf8'));
  quality.replayProvenance = { executionPairs: [], modelRuns: [], provenanceChecksum: sha256({
    sourceHead: SOURCE_HEAD, executionPairs: [], modelRuns: []
  }), sourceHead: SOURCE_HEAD };
  writeFileSync(file, `${JSON.stringify(quality)}\n`);
  fixture.input.artifacts.quality.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({
    manifestPath: fixture.manifestPath,
    evidenceDirectory: fixture.root
  }), /replay|provenance|quality/i);
});

test('blocked quality report is a closed schema and rejects extra fields', () => {
  const fixture = writeFixture();
  const blocked = {
    version: 1, productionReleaseMutation: false, eligible: false,
    failedGates: ['QUALITY_REPORT_INPUT_UNAVAILABLE'],
    blockingReason: 'history unavailable', extra: true
  };
  const file = join(fixture.root, fixture.input.artifacts.quality.path);
  writeFileSync(file, `${JSON.stringify(blocked)}\n`);
  fixture.input.artifacts.quality.sha256 = sha256(readFileSync(file));
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root }), /quality blocked/);
});

test('blocked readiness cannot publish caller-supplied unverified identities', () => {
  const report = materializeBlockedReadinessReport({
    failedGate: 'SOURCE_TREE_NOT_IMMUTABLE',
    candidateReleaseId: 'forged-candidate',
    sourceHead: 'not-a-git-head',
    deviceSerial: 7
  });
  assert.equal(report.candidateReleaseId, null);
  assert.equal(report.sourceHead, null);
  assert.equal(report.deviceSerial, null);
  assert.equal(report.inputSha256, null);
  assert.ok(Object.values(report.artifactChecksums).every(value => value === null));
});

test('dirty source tree is a blocked evidence input, never a ready candidate', async () => {
  const result = await preflightSourceTree('C:/repo', async (command, args) => ({
    command, args, exitCode: 0,
    output: args[0] === 'rev-parse' ? SOURCE_HEAD : ' M scripts/changed.mjs\n'
  }));
  assert.ok(result.failedGates.includes('SOURCE_TREE_NOT_IMMUTABLE'));
  assert.equal(result.sourceHead, SOURCE_HEAD);
});

test('source preflight allows only the selected evidence directory and rejects path escape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-source-preflight-'));
  const evidence = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'run-1');
  mkdirSync(evidence, { recursive: true });
  const calls = [];
  const allowed = await preflightSourceTree(root, async (command, args) => {
    calls.push({ command, args });
    return {
    command, args, exitCode: 0,
    output: args[0] === 'rev-parse' ? SOURCE_HEAD : ''
    };
  }, evidence);
  assert.deepEqual(allowed.failedGates, []);
  assert.ok(calls.find(call => call.args[0] === 'status').args.some(arg =>
    String(arg).includes(':(exclude)artifacts/yuqi-lived-agency-v3/run-1/**')));
  await assert.rejects(() => preflightSourceTree(root, async (command, args) => ({
    command, args, exitCode: 0,
    output: args[0] === 'rev-parse' ? SOURCE_HEAD : ''
  }), join(root, 'src', 'not-evidence')), /evidence directory scope/i);
  rmSync(root, { recursive: true, force: true });
});

test('npm resolver returns an absolute PATH executable rather than repoRoot/npm.cmd', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-npm-resolver-'));
  const npm = join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  writeFileSync(npm, '');
  assert.equal(resolveNpmExecutable({ PATH: root, ProgramFiles: root }), npm);
});

test('verifyReadiness rejects a raw in-memory manifest rather than bypassing the loader', () => {
  const fixture = writeFixture();
  assert.throws(() => verifyReadiness(fixture.input), /readiness evidence/);
});

test('readiness command evidence requires closed Node counters and an absolute adb executable', () => {
  assert.deepEqual(parseNodeTestSummary(
    'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n'),
  { tests: 2, passed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(parseNodeTestSummary(
    'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n'
      + 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\n'),
  { tests: 5, passed: 5, failed: 0, skipped: 0 });
  assert.throws(() => parseNodeTestSummary(
    'ℹ pass 2\nℹ fail 0\nℹ skipped 0\n'), /node test counters/);
  assert.throws(() => parseNodeTestSummary(
    'ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ skipped 0\n'), /node test counters/);
  const root = mkdtempSync(join(tmpdir(), 'yuqi-readiness-no-sdk-'));
  assert.throws(() => resolveAdbExecutable(root, {}), /ANDROID_ADB_UNAVAILABLE/);
  const staleFutureXml = { mtimeMs: Date.now() + 60_000, sha256: 'a'.repeat(64) };
  assert.equal(connectedXmlWasRewritten(staleFutureXml, { ...staleFutureXml }), false);
  assert.equal(connectedXmlWasRewritten(staleFutureXml,
    { ...staleFutureXml, mtimeMs: staleFutureXml.mtimeMs + 1 }), true);
  assert.equal(connectedXmlWasRewritten(undefined, staleFutureXml), true);
});

test('readiness refuses an Android report that does not prove all eleven connected cases', () => {
  const fixture = writeFixture();
  fixture.values.androidTests.passed = 1;
  const descriptor = fixture.input.artifacts.androidTests;
  const bytes = Buffer.from(`${JSON.stringify(fixture.values.androidTests)}\n`, 'utf8');
  writeFileSync(join(fixture.root, descriptor.path), bytes);
  descriptor.sha256 = sha256(bytes);
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.input)}\n`);
  assert.throws(() => loadReadinessManifest({
    manifestPath: fixture.manifestPath,
    evidenceDirectory: fixture.root
  }), /android test outcome/);
});

test('readiness report is a closed checksum-bound output with no invented connected pass', () => {
  const fixture = writeFixture();
  const evidence = loadReadinessManifest({ manifestPath: fixture.manifestPath, evidenceDirectory: fixture.root });
  const report = materializeReadinessReport(evidence, { startedAt: evidence.createdAt, completedAt: evidence.createdAt + 1 });
  assert.deepEqual(Object.keys(report).sort(), [
    'artifactChecksums', 'candidateReleaseId', 'completedAt', 'deviceSerial',
    'failedGates', 'inputSha256', 'ready', 'reportChecksum', 'schemaVersion',
    'sourceHead', 'startedAt'
  ].sort());
  assert.equal(report.ready, true);
  const { reportChecksum, ...withoutChecksum } = report;
  assert.equal(reportChecksum, sha256(withoutChecksum));
});

test('run mode invokes formal visible-path finalizer before npm/Gradle and continues with its metrics', async () => {
  const fixture = makeFormalRunFixture();
  const calls = [];
  const formalCalls = [];
  const events = [];
  const runtimeConfig = { path: 'config.json', checksum: '9'.repeat(64) };
  const materializeFormalOutputs = () => {
    mkdirSync(join(fixture.evidence, 'private'), { recursive: true });
    for (const relative of [VISIBLE_PATH_XML_FILE,
      'private/visible-path-android.jsonl', 'private/visible-path-pc.jsonl']) {
      writeFileSync(join(fixture.evidence, relative), fixture.formalOutputBytes[relative], { flag: 'wx' });
    }
    const metricsBytes = Buffer.from(`${JSON.stringify(fixture.values.visiblePathMetrics)}\n`, 'utf8');
    writeFileSync(join(fixture.evidence, 'visible-path-metrics.json'), metricsBytes, { flag: 'wx' });
  };
  const formalFinalizer = async options => {
    events.push('formal');
    formalCalls.push(options);
    assert.equal(options.evidenceDir, fixture.evidence);
    assert.equal(options.runtimeConfig, runtimeConfig);
    assert.equal(options.repoRoot, fixture.root);
    assert.equal(options.candidateReleaseId, fixture.input.candidateReleaseId);
    assert.equal(options.candidateReleaseChecksum, CANDIDATE_CHECKSUM);
    materializeFormalOutputs();
    return fixture.values.visiblePathMetrics;
  };
  const commandRunner = async (command, args, cwd, env) => {
    events.push(`command:${command}`);
    calls.push({ command, args, cwd, env });
    if (command === 'git' && args[0] === 'rev-parse') {
      return { command, args, output: `${SOURCE_HEAD}\n`, exitCode: 0, outputSha256: sha256(SOURCE_HEAD) };
    }
    if (command === 'git' && args[0] === 'status') {
      return { command, args, output: '', exitCode: 0, outputSha256: sha256('') };
    }
    if (/adb(?:\.exe)?$/i.test(command)) {
      return { command, args, output: 'List of devices attached\nemulator-5554 device product:sdk\n', exitCode: 0, outputSha256: sha256('adb') };
    }
    if (command.endsWith('gradlew.bat')) {
      writeFileSync(fixture.xmlFile, fixture.xml);
      return { command, args, output: 'BUILD SUCCESSFUL\n', exitCode: 0, outputSha256: sha256('gradle') };
    }
    return { command, args, output: 'ℹ tests 5\nℹ pass 5\nℹ fail 0\nℹ skipped 0\n', exitCode: 0, outputSha256: sha256('node') };
  };
  try {
    const result = await verifyReadinessFromDirectory({
      evidenceDir: fixture.evidence,
      repoRoot: fixture.root,
      qualitySourceDirectory: process.cwd(),
      runtimeConfig,
      productionInputsLoader: () => {
        events.push('runtime');
        return {};
      },
      formalFinalizer,
      run: true,
      commandRunner
    });
    assert.equal(formalCalls.length, 1);
    assert.deepEqual(events.slice(0, 6), [
      'command:git', 'command:git', 'runtime', 'command:git', 'command:git', 'formal'
    ]);
    assert.equal(existsSync(join(fixture.evidence, 'visible-path-metrics.json')), true);
    assert.equal(result.ready, true);
    assert.ok(calls.length > 0);
  } finally {
    fixture.cleanup();
  }
});

test('run mode formal finalizer failure or missing metrics blocks before npm/Gradle', async () => {
  for (const mode of ['throw', 'no-write']) {
    const fixture = makeFormalRunFixture();
    const calls = [];
    const formalCalls = [];
    const formalFinalizer = async options => {
      formalCalls.push(options);
      if (mode === 'throw') throw new Error('FORMAL_VISIBLE_PATH_COLLECTION_FAILED');
      return undefined;
    };
    const commandRunner = async (command, args, cwd, env) => {
      calls.push({ command, args, cwd, env });
      if (command === 'git' && args[0] === 'rev-parse') {
        return { command, args, output: `${SOURCE_HEAD}\n`, exitCode: 0, outputSha256: sha256(SOURCE_HEAD) };
      }
      if (command === 'git' && args[0] === 'status') {
        return { command, args, output: '', exitCode: 0, outputSha256: sha256('') };
      }
      return { command, args, output: '', exitCode: 0, outputSha256: sha256('') };
    };
    try {
      let outcome;
      try {
        outcome = await verifyReadinessFromDirectory({
          evidenceDir: fixture.evidence,
          repoRoot: fixture.root,
          runtimeConfig: { path: 'config.json', checksum: '9'.repeat(64) },
          productionInputsLoader: () => ({}),
          formalFinalizer,
          run: true,
          commandRunner
        });
      } catch (error) {
        outcome = error;
      }
      assert.equal(formalCalls.length, 1);
      assert.deepEqual(calls.map(call => `${call.command}:${call.args[0]}`), [
        'git:rev-parse', 'git:status', 'git:rev-parse', 'git:status'
      ]);
      if (outcome instanceof Error) {
        assert.match(String(outcome), /FORMAL_VISIBLE_PATH_COLLECTION_FAILED|visible path formal/i);
      } else {
        assert.equal(outcome.ready, false);
        assert.ok(outcome.failedGates.some(gate => /FORMAL_VISIBLE_PATH_COLLECTION_FAILED|VISIBLE_PATH_FORMAL|METRICS/i.test(gate)));
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test('custom formal finalizers cannot bypass production runtime preflight', async () => {
  const fixture = makeFormalRunFixture();
  let formalCalls = 0;
  let runtimeCalls = 0;
  try {
    const result = await verifyReadinessFromDirectory({
      evidenceDir: fixture.evidence,
      repoRoot: fixture.root,
      run: true,
      productionInputsLoader: () => {
        runtimeCalls += 1;
        throw new Error('invalid v15 runtime');
      },
      formalFinalizer: async () => { formalCalls += 1; },
      commandRunner: async (command, args) => ({
        command, args, exitCode: 0,
        output: args[0] === 'rev-parse' ? `${SOURCE_HEAD}\n` : '', outputSha256: sha256('')
      })
    });
    assert.equal(runtimeCalls, 1);
    assert.equal(formalCalls, 0);
    assert.equal(result.ready, false);
    assert.ok(result.failedGates.includes('FORMAL_RUNTIME_PREFLIGHT_FAILED'));
  } finally {
    fixture.cleanup();
  }
});

test('source authority changing after runtime preflight blocks before formal collection', async () => {
  const fixture = makeFormalRunFixture();
  let statusCalls = 0;
  let formalCalls = 0;
  try {
    const result = await verifyReadinessFromDirectory({
      evidenceDir: fixture.evidence,
      repoRoot: fixture.root,
      run: true,
      productionInputsLoader: () => ({}),
      formalFinalizer: async () => { formalCalls += 1; },
      commandRunner: async (command, args) => {
        if (args[0] === 'rev-parse') {
          return { command, args, exitCode: 0, output: `${SOURCE_HEAD}\n`, outputSha256: sha256('') };
        }
        statusCalls += 1;
        return {
          command, args, exitCode: 0,
          output: statusCalls === 1 ? '' : ' M scripts/changed-after-preflight.mjs\0',
          outputSha256: sha256('')
        };
      }
    });
    assert.equal(formalCalls, 0);
    assert.equal(result.ready, false);
    assert.ok(result.failedGates.includes('SOURCE_TREE_NOT_IMMUTABLE'));
    assert.ok(result.failedGates.includes('SOURCE_AUTHORITY_CHANGED'));
  } finally {
    fixture.cleanup();
  }
});

test('run mode rejects non-evidence roots before mkdir or commands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-readiness-scope-'));
  let calls = 0;
  try {
    for (const evidenceDir of [root, join(root, 'src', 'hidden-evidence')]) {
      await assert.rejects(() => verifyReadinessFromDirectory({
        evidenceDir, repoRoot: root, run: true,
        commandRunner: async () => { calls += 1; return { exitCode: 0, output: '' }; }
      }), /evidence directory scope/i);
    }
    assert.equal(calls, 0);
    assert.equal(existsSync(join(root, 'src')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run mode performs fixed/source preflight before npm or Gradle and blocks incomplete evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-readiness-run-'));
  const evidence = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'missing-inputs');
  const calls = [];
  const result = await verifyReadinessFromDirectory({
      evidenceDir: evidence,
      repoRoot: root,
      run: true,
      commandRunner: async (command, args) => {
        calls.push({ command, args });
        return { command, args, exitCode: 0, output: 'List of devices attached\n', outputSha256: sha256('') };
      }
    });
  assert.equal(result.ready, false);
  assert.ok(result.failedGates.includes('MISSING_FIXED_PROTOCOL'));
  assert.ok(result.failedGates.includes('METRICS_EVIDENCE_UNAVAILABLE'));
  assert.equal(calls.length, 0);
});

test('run mode uses one selected device, absolute npm/Gradle commands, exact class filter, and a unique run directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-readiness-real-run-'));
  const evidence = join(root, 'artifacts', 'yuqi-lived-agency-v3', 'evidence');
  mkdirSync(join(root, 'tavern-app'), { recursive: true });
  mkdirSync(join(root, 'android', 'app', 'src', 'main', 'assets', 'public'), { recursive: true });
  writeFileSync(join(root, 'tavern-app', 'index.html'), '<script>acknowledgeNativeUiAppliedOnce</script>');
  writeFileSync(join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'index.html'),
    '<script>acknowledgeNativeUiAppliedOnce</script>');
  const xmlRoot = join(root, 'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'emulator-5554');
  mkdirSync(xmlRoot, { recursive: true });
  const xml = `<testsuite>${CONNECTED_DEVICE_RACE_NAMES.map(name =>
    `<testcase classname="${CONNECTED_DEVICE_RACE_TEST_CLASS}" name="${name}"/>`).join('')}</testsuite>`;
  const xmlFile = join(xmlRoot, 'TEST-YuqiV3ConnectedRaceTest.xml');
  writeFileSync(xmlFile, xml);
  utimesSync(xmlFile, new Date(0), new Date(0));
  const candidateReleaseId = 'quality_candidate_run';
  mkdirSync(evidence, { recursive: true });
  const fixed = {
    baseline: { gitHead: '5'.repeat(40), database: { sha256: 'a'.repeat(64), sourceChangedDuringAudit: false } },
    migration: closedMigration(),
    protocol: closedProtocol(candidateReleaseId),
    quality: null,
    races: closedRace(candidateReleaseId),
    androidFallback: closedFallback(candidateReleaseId),
    rolloutStatus: closedRollout(candidateReleaseId),
    visiblePathMetrics: closedVisiblePathMetrics(candidateReleaseId, evidence, root)
  };
  const qualityBundle = buildQualityBundleFixture(evidence, candidateReleaseId);
  fixed.quality = qualityBundle.quality;
  fixed.qualityPlan = qualityBundle.plan;
  fixed.qualityReplay = qualityBundle.replayBytes;
  fixed.qualityManualReview = qualityBundle.manualBytes;
  const runClonePath = join(evidence, 'history-source-v15.sqlite');
  const runClone = new DatabaseSync(runClonePath);
  try {
    runClone.exec('PRAGMA user_version=15');
    for (const table of ['messages','facts','life_episodes','turns','cloud_deliveries','conversation_clear_controls',
      'turn_authority_lineages','visible_result_groups','visible_result_items','visible_result_actions',
      'visible_result_manifests','visible_commit_receipts']) runClone.exec(`CREATE TABLE ${table}(id INTEGER)`);
  } finally { runClone.close(); }
  fixed.migration.workingDatabaseSha256 = sha256(readFileSync(runClonePath));
  const runSemantic = { ...fixed.migration.v14InvariantSummary.semantic };
  delete runSemantic.checksum;
  fixed.migration.v14InvariantSummary.semantic.checksum = sha256(runSemantic);
  const fixedFiles = {
    baseline: 'baseline.json', migration: 'history-source-v15-migration-report.json', migrationClone: 'history-source-v15.sqlite', protocol: 'protocol-report.json',
    quality: 'quality-report.json', qualityPlan: 'quality-replay-plan.json',
    qualityReplay: 'quality-replay.jsonl', qualityManualReview: 'quality-manual-review.jsonl', races: 'race-report.json',
    androidFallback: 'android-fallback-report.json', rolloutStatus: 'rollout-status.json', visiblePathMetrics: 'visible-path-metrics.json'
  };
  for (const [name, value] of Object.entries(fixed)) {
    writeFileSync(join(evidence, fixedFiles[name]), Buffer.isBuffer(value)
      ? value : `${JSON.stringify(value)}\n`);
  }
  const calls = [];
  const result = await verifyReadinessFromDirectory({
    evidenceDir: evidence,
    repoRoot: root,
    qualitySourceDirectory: process.cwd(),
    run: true,
    productionInputsLoader: () => ({}),
    formalFinalizer: async () => fixed.visiblePathMetrics,
    commandRunner: async (command, args, cwd, env) => {
      calls.push({ command, args, cwd, env });
      if (command === 'git' && args[0] === 'rev-parse') {
        return { command, args, output: `${SOURCE_HEAD}\n`, exitCode: 0, outputSha256: sha256(SOURCE_HEAD) };
      }
      if (command === 'git' && args[0] === 'status') {
        return { command, args, output: '', exitCode: 0, outputSha256: sha256('') };
      }
      if (command === 'adb' || /adb(?:\.exe)?$/i.test(command)) {
        return { command, args, output: 'List of devices attached\nemulator-5554 device product:sdk\n', exitCode: 0, outputSha256: sha256('adb') };
      }
      if (command.endsWith('gradlew.bat')) {
        writeFileSync(xmlFile, xml);
        return { command, args, output: 'BUILD SUCCESSFUL in 42s\n365 actionable tasks: 11 executed\n', exitCode: 0, outputSha256: sha256('gradle') };
      }
      return { command, args, output: 'ℹ tests 10\nℹ pass 10\nℹ fail 0\nℹ skipped 0\n', exitCode: 0, outputSha256: sha256('node') };
    }
  });
  assert.equal(result.ready, true);
  assert.equal(calls.length, 10);
  assert.equal(calls[0].command, 'git');
  assert.equal(calls[1].command, 'git');
  assert.equal(calls[2].command, 'git');
  assert.equal(calls[3].command, 'git');
  assert.match(calls[6].command, /adb(?:\.exe)?$/i);
  assert.equal(calls[7].command.endsWith('npm.cmd'), true);
  assert.deepEqual(calls[7].args, ['test']);
  assert.equal(calls[9].command.endsWith('gradlew.bat'), true);
  assert.equal(calls[9].cwd, join(root, 'android'));
  assert.equal(calls[9].env.ANDROID_SERIAL, 'emulator-5554');
  assert.ok(calls[9].args.some(arg => arg.includes(CONNECTED_DEVICE_RACE_TEST_CLASS)));
  assert.ok(calls[9].args.includes('--rerun-tasks'));
  const runDirectories = readdirSync(evidence).filter(name => name.startsWith('run-'));
  assert.equal(runDirectories.length, 1);
  const androidReport = JSON.parse(readFileSync(join(evidence, runDirectories[0], 'android-test-report.json'), 'utf8'));
  assert.equal(androidReport.passed, CONNECTED_DEVICE_RACE_NAMES.length);
  assert.equal(androidReport.failed, 0);
  assert.equal(androidReport.skipped, 0);
  assert.equal(androidReport.outputSha256, sha256('gradle'));
  assert.deepEqual(androidReport.webAssetChecksums, {
    'index.html': sha256(Buffer.from('<script>acknowledgeNativeUiAppliedOnce</script>'))
  });
  const nodeReport = JSON.parse(readFileSync(join(evidence, runDirectories[0], 'node-test-report.json'), 'utf8'));
  assert.equal(nodeReport.outputSha256, sha256('node'));
  assert.ok(existsSync(join(evidence, 'readiness-input.json')));
});
