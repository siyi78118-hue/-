import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { sha256 } from '../scripts/generate-yuqi-visible-path-metrics.mjs';

const START_FILE = 'private/visible-path-collection-start.json';
const FAILURE_FILE = 'private/visible-path-collection-failed.json';
const ANDROID_FILE = 'private/visible-path-android.jsonl';
const PC_FILE = 'private/visible-path-pc.jsonl';
const METRICS_FILE = 'visible-path-metrics.json';
const SOURCE_HEAD = 'a'.repeat(40);
const CANDIDATE_ID = 'quality_candidate_1';
const CANDIDATE_CHECKSUM = 'b'.repeat(64);
const DEVICE_SERIAL = 'emulator-5554';
const DATABASE_SHA = 'c'.repeat(64);
const DATABASE_SHA_AFTER = 'f'.repeat(64);
const DATABASE_PATH_HASH = 'd'.repeat(64);
const DATABASE_PATH_HASH_AFTER = 'e'.repeat(64);
const STARTED_AT = 1_786_000_000_000;
const COMPLETED_AT = STARTED_AT + 30_000;
const ANDROID_XML_SOURCE = 'android/app/build/outputs/androidTest-results/connected/debug/TEST-YuqiTask25Api35(AVD) - 15-_app-.xml';
const FORMAL_XML = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase classname="com.siyi.al.execution.YuqiVisiblePathExportTest" name="exportCurrentDeviceVisiblePathArtifact"/></testsuite>';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function loadFormalRunner() {
  try {
    return await import('../scripts/run-yuqi-visible-path-formal.mjs');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('formal runner module missing: scripts/run-yuqi-visible-path-formal.mjs', { cause: error });
    }
    throw error;
  }
}

function makeRawExports(runId, { databaseSha256 = DATABASE_SHA } = {}) {
  const kinds = [
    ...Array.from({ length: 20 }, () => 'DIRECT_REPLY'),
    'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
    'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
    'MOMENT_INTERACTION', 'MOMENT_REPLY'
  ];
  const androidRows = kinds.map((kind, index) => {
    const createdAt = STARTED_AT + 10_000 + index * 100;
    return {
      turnIdSha256: sha256(`turn-${index}`),
      kind,
      pipelineReleaseId: CANDIDATE_ID,
      authorityLineageKeySha256: sha256(`lineage-${index}`),
      visibleGroupIdSha256: sha256(`group-${index}`),
      createdAt,
      uiAppliedAt: createdAt + 10,
      elapsedMs: 10,
      terminalDisposition: 'visible'
    };
  });
  const pcRows = androidRows.map(row => ({
    authorityLineageKeySha256: row.authorityLineageKeySha256,
    authorityMode: 'active_canary',
    kind: row.kind,
    pipelineReleaseId: row.pipelineReleaseId,
    turnIdSha256: row.turnIdSha256,
    visibleGroupIdSha256: row.visibleGroupIdSha256
  }));
  const androidBase = {
    candidateReleaseId: CANDIDATE_ID,
    completedAt: COMPLETED_AT,
    databaseUserVersion: 15,
    deviceSerial: DEVICE_SERIAL,
    producer: 'room_authority_export_v1',
    rowCount: androidRows.length,
    runId,
    selectionChecksum: sha256({ producer: 'room_authority_export_v1', rows: androidRows }),
    startedAt: STARTED_AT
  };
  const pcBase = {
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    candidateReleaseId: CANDIDATE_ID,
    completedAt: COMPLETED_AT,
    databaseUserVersion: 15,
    producer: 'pc_authority_readonly_export_v1',
    readOnly: true,
    rowCount: pcRows.length,
    runId,
    selectionChecksum: sha256({ producer: 'pc_authority_readonly_export_v1', rows: pcRows }),
    sourceDatabaseSha256: databaseSha256,
    sourceHead: SOURCE_HEAD,
    startedAt: STARTED_AT
  };
  const androidMetadata = {
    recordType: 'metadata',
    schemaVersion: 'yuqi-v3-visible-path-android-v1',
    deviceSerial: DEVICE_SERIAL,
    runId,
    candidateReleaseId: CANDIDATE_ID,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    producerAttestation: { ...androidBase, attestationChecksum: sha256(androidBase) }
  };
  const pcMetadata = {
    recordType: 'metadata',
    schemaVersion: 'yuqi-v3-visible-path-pc-v1',
    candidateReleaseId: CANDIDATE_ID,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    sourceHead: SOURCE_HEAD,
    runId,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    producerAttestation: { ...pcBase, attestationChecksum: sha256(pcBase) }
  };
  const jsonl = rows => Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { android: jsonl([androidMetadata, ...androidRows]), pc: jsonl([pcMetadata, ...pcRows]) };
}

function makeFixture({ profile = 'success' } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'yuqi-visible-path-formal-run-'));
  const root = join(repoRoot, 'artifacts', 'yuqi-lived-agency-v3', 'formal-test');
  mkdirSync(join(root, 'private'), { recursive: true });
  const sourceXmlFile = join(repoRoot, ...ANDROID_XML_SOURCE.split('/'));
  mkdirSync(dirname(sourceXmlFile), { recursive: true });
  writeFileSync(sourceXmlFile, FORMAL_XML);
  utimesSync(sourceXmlFile, new Date(COMPLETED_AT + 2), new Date(COMPLETED_AT + 2));
  const runtimeDatabasePath = join(root, 'runtime.sqlite');
  writeFileSync(runtimeDatabasePath, 'read-only database fixture\n');
  const state = {
    head: SOURCE_HEAD,
    clean: true,
    candidateReleaseId: CANDIDATE_ID,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    deviceSerial: DEVICE_SERIAL,
    databasePathHash: DATABASE_PATH_HASH,
    databaseSha256: DATABASE_SHA,
    now: STARTED_AT
  };
  const calls = [];
  const runner = {
    async getGitHead() { return state.head; },
    async getGitStatus() { return state.clean ? '' : ' M dirty.js'; },
    async getDeviceSerial() { return state.deviceSerial; },
    async getRuntimeDatabaseSha256() { return state.databaseSha256; },
    async getRuntimeDatabasePathHash() { return state.databasePathHash; },
    async run(request) {
      calls.push({ ...request, args: Array.isArray(request.args) ? [...request.args] : request.args });
      const runId = request.runId || request.args?.find?.(value => UUID.test(String(value))) || '';
      if (request.kind === 'android-instrumentation') {
        if (profile === 'android-not-run') return { exitCode: 1, stdout: '', stderr: 'not run' };
        if (profile === 'android-skip') return { exitCode: 0, xml: '<testsuite tests="1" failures="0" errors="0" skipped="1"><testcase><skipped/></testcase></testsuite>', outputSha256: sha256('old') };
        if (profile === 'android-old-xml') return { exitCode: 0, xml: '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="old"/></testsuite>', outputSha256: sha256('old') };
        if (profile === 'android-source-replaced') {
          writeFileSync(sourceXmlFile,
            FORMAL_XML.replace('exportCurrentDeviceVisiblePathArtifact', 'differentExporter'));
          utimesSync(sourceXmlFile, new Date(COMPLETED_AT + 2), new Date(COMPLETED_AT + 2));
        }
        if (profile === 'android-source-linked-parent') {
          const linkedSource = join(repoRoot, 'linked-android-xml-source');
          mkdirSync(linkedSource, { recursive: true });
          const linkedXml = join(linkedSource, sourceXmlFile.slice(dirname(sourceXmlFile).length + 1));
          writeFileSync(linkedXml, FORMAL_XML);
          utimesSync(linkedXml, new Date(COMPLETED_AT + 2), new Date(COMPLETED_AT + 2));
          rmSync(dirname(sourceXmlFile), { recursive: true, force: true });
          symlinkSync(linkedSource, dirname(sourceXmlFile), process.platform === 'win32' ? 'junction' : 'dir');
        }
        return {
          exitCode: 0,
          xml: FORMAL_XML,
          outputSha256: sha256('fresh-xml'),
          launchedAt: COMPLETED_AT + 1,
          xmlSourceMtimeMs: COMPLETED_AT + 2,
          xmlSourcePath: ANDROID_XML_SOURCE
        };
      }
      if (request.kind === 'android-pull') {
        if (profile === 'android-pull-mismatch') return { exitCode: 0, bytes: Buffer.from('stale bytes', 'utf8') };
        return { exitCode: 0, bytes: makeRawExports(runId).android };
      }
      if (request.kind === 'pc-export') {
        if (profile === 'pc-failure') return { exitCode: 1, stdout: '', stderr: 'pc exporter failed' };
        const rawDatabaseSha256 = profile === 'pc-source-hash-mismatch'
          ? '0'.repeat(64)
          : state.databaseSha256;
        const result = {
          exitCode: 0,
          bytes: makeRawExports(runId, { databaseSha256: rawDatabaseSha256 }).pc,
          sourceDatabaseSha256: state.databaseSha256
        };
        if (profile === 'pc-database-changed-after') state.databaseSha256 = '1'.repeat(64);
        return result;
      }
      throw new Error(`unexpected runner kind: ${request.kind}`);
    }
  };
  const options = {
    evidenceDir: root,
    repoRoot,
    adbExecutable: join(root, 'sdk', 'platform-tools', 'adb.exe'),
    runtimeDatabasePath,
    candidateReleaseId: CANDIDATE_ID,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    source: { getHead: () => runner.getGitHead(), getStatus: () => runner.getGitStatus() },
    device: { getSerial: () => runner.getDeviceSerial() },
    candidate: {
      getReleaseIdentity: () => ({
        id: state.candidateReleaseId,
        checksum: state.candidateReleaseChecksum
      })
    },
    runtimeDatabase: {
      getPathHash: () => runner.getRuntimeDatabasePathHash(),
      getSha256: () => runner.getRuntimeDatabaseSha256()
    },
    now: () => state.now,
    fs: { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync },
    runner
  };
  return {
    root, repoRoot, state, calls, options,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true })
  };
}

async function begin(fixture) {
  const { beginVisiblePathCollection } = await loadFormalRunner();
  return beginVisiblePathCollection(fixture.options);
}

async function finalize(fixture) {
  const { finalizeVisiblePathCollection } = await loadFormalRunner();
  return finalizeVisiblePathCollection(fixture.options);
}

async function assertBusinessRejects(action, pattern) {
  try {
    await action();
  } catch (error) {
    if (String(error?.message || '').includes('formal runner module missing')) throw error;
    assert.match(String(error), pattern);
    return;
  }
  assert.fail(`expected rejection matching ${pattern}`);
}

test('formal begin rejects every pre-existing start/failure/raw/metrics output without deleting it', async () => {
  for (const relative of [START_FILE, FAILURE_FILE, ANDROID_FILE, PC_FILE, METRICS_FILE]) {
    const fixture = makeFixture();
    try {
      const file = join(fixture.root, relative);
      writeFileSync(file, 'caller sentinel\n');
      await assertBusinessRejects(() => begin(fixture), /pre-existing|output|immutable|already exists/i);
      assert.equal(readFileSync(file, 'utf8'), 'caller sentinel\n');
    } finally {
      fixture.cleanup();
    }
  }
});

test('formal begin freezes a pure UUID and exact source/candidate/device/path identity', async () => {
  const fixture = makeFixture();
  try {
    const result = await begin(fixture);
    assert.match(result.runId, UUID);
    assert.equal(result.sourceHead, SOURCE_HEAD);
    assert.equal(result.candidateReleaseId, CANDIDATE_ID);
    assert.equal(result.candidateReleaseChecksum, CANDIDATE_CHECKSUM);
    assert.equal(result.deviceSerial, DEVICE_SERIAL);
    assert.equal(result.runtimeDatabasePathHash, DATABASE_PATH_HASH);
    assert.equal(result.runtimeDatabaseSha256, undefined);
    assert.equal(result.startedAt, STARTED_AT);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(fixture.root, START_FILE), 'utf8'))).sort(), [
      'candidateReleaseChecksum', 'candidateReleaseId', 'checksum', 'deviceSerial',
      'runId', 'runtimeDatabasePath', 'runtimeDatabasePathHash', 'schemaVersion', 'sourceHead', 'startedAt'
    ].sort());
  } finally {
    fixture.cleanup();
  }
});

test('formal git source preflight excludes only the designated evidence subtree', async () => {
  const {
    androidOutputDirectory, assertEvidenceDirectoryScope, assertEvidencePath,
    assertRuntimeDatabaseSnapshotReady, gitStatusArgsForEvidence
  } = await loadFormalRunner();
  const repoRoot = resolve(import.meta.dirname, '..');
  assert.deepEqual(gitStatusArgsForEvidence(
    repoRoot, join(repoRoot, 'artifacts', 'yuqi-lived-agency-v3', 'formal-run-1')
  ), [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
    ':(exclude)artifacts/yuqi-lived-agency-v3/formal-run-1/**'
  ]);
  assert.throws(() => gitStatusArgsForEvidence(repoRoot, join(fixtureOutsideRepo(), 'evidence')),
    /evidence|scope|artifacts/i);
  assert.throws(() => gitStatusArgsForEvidence(repoRoot, join(repoRoot, 'src', 'hidden-evidence')),
    /evidence|scope|artifacts/i);
  const isolated = mkdtempSync(join(tmpdir(), 'yuqi-evidence-scope-'));
  const external = mkdtempSync(join(tmpdir(), 'yuqi-evidence-external-'));
  const base = join(isolated, 'artifacts', 'yuqi-lived-agency-v3');
  mkdirSync(base, { recursive: true });
  const linkedRoot = join(base, 'linked-run');
  symlinkSync(external, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertEvidenceDirectoryScope(isolated, linkedRoot), /evidence directory scope/i);
  const evidence = join(base, 'real-run');
  mkdirSync(evidence, { recursive: true });
  const scope = assertEvidenceDirectoryScope(isolated, evidence);
  symlinkSync(external, join(evidence, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertEvidencePath(scope, join(evidence, 'private', 'escaped.json')),
    /evidence path scope/i);
  rmSync(isolated, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
  assert.equal(androidOutputDirectory(
    '/data/user/0/com.siyi.al/files/visible-path/run-1/visible-path-android.jsonl'
  ), '/data/user/0/com.siyi.al/files/visible-path/run-1');
  const database = join(fixtureOutsideRepo(), `runtime-${process.pid}.sqlite`);
  mkdirSync(fixtureOutsideRepo(), { recursive: true });
  writeFileSync(database, 'db');
  writeFileSync(`${database}-wal`, 'pending');
  assert.throws(() => assertRuntimeDatabaseSnapshotReady(database), /WAL|sidecar|snapshot/i);
  rmSync(`${database}-wal`);
  writeFileSync(`${database}-journal`, 'pending');
  assert.throws(() => assertRuntimeDatabaseSnapshotReady(database), /journal|sidecar|snapshot/i);
  rmSync(`${database}-journal`);
  writeFileSync(`${database}-wal`, '');
  assert.doesNotThrow(() => assertRuntimeDatabaseSnapshotReady(database));
  rmSync(database);
  rmSync(`${database}-wal`);
});

function fixtureOutsideRepo() {
  return join(tmpdir(), 'yuqi-formal-external');
}

test('formal finalize rejects source/candidate/device/path identity drift before any exporter output', async () => {
  for (const drift of ['head', 'candidateReleaseId', 'candidateReleaseChecksum', 'deviceSerial', 'runtimeDatabasePathHash']) {
    const fixture = makeFixture();
    try {
      await begin(fixture);
      if (drift === 'head') fixture.state.head = 'd'.repeat(40);
      else if (drift === 'candidateReleaseId') fixture.state.candidateReleaseId = 'foreign_candidate';
      else if (drift === 'candidateReleaseChecksum') fixture.state.candidateReleaseChecksum = 'e'.repeat(64);
      else if (drift === 'deviceSerial') fixture.state.deviceSerial = 'foreign-device';
      else fixture.state.databasePathHash = DATABASE_PATH_HASH_AFTER;
      fixture.state.now = COMPLETED_AT;
      await assert.rejects(finalize(fixture), /identity|drift|changed|source|candidate|device|database/i);
      assert.equal(existsSync(join(fixture.root, ANDROID_FILE)), false);
      assert.equal(existsSync(join(fixture.root, PC_FILE)), false);
      assert.equal(existsSync(join(fixture.root, METRICS_FILE)), false);
    } finally {
      fixture.cleanup();
    }
  }
});

test('formal finalize permits runtime DB content hash change and binds the new PC source hash', async () => {
  const fixture = makeFixture();
  try {
    await begin(fixture);
    fixture.state.databaseSha256 = DATABASE_SHA_AFTER;
    fixture.state.now = COMPLETED_AT;
    const result = await finalize(fixture);
    assert.equal(result.collectionAttestation.pc.sourceDatabaseSha256, DATABASE_SHA_AFTER);
    assert.equal(
      result.collectionAttestation.pc.outputSha256,
      sha256(readFileSync(join(fixture.root, PC_FILE)))
    );
  } finally {
    fixture.cleanup();
  }
});

test('formal finalize rejects a PC raw source hash mismatch before materializing metrics', async () => {
  const fixture = makeFixture({ profile: 'pc-source-hash-mismatch' });
  try {
    await begin(fixture);
    fixture.state.now = COMPLETED_AT;
    await assertBusinessRejects(() => finalize(fixture), /pc|source|database|checksum|mismatch|provenance|collection|attestation|values/i);
    assert.equal(existsSync(join(fixture.root, METRICS_FILE)), false);
  } finally {
    fixture.cleanup();
  }
});

test('formal finalize rechecks the runtime database after PC export', async () => {
  const fixture = makeFixture({ profile: 'pc-database-changed-after' });
  try {
    await begin(fixture);
    fixture.state.now = COMPLETED_AT;
    await assert.rejects(finalize(fixture), /database|identity|drift/i);
    assert.equal(existsSync(join(fixture.root, METRICS_FILE)), false);
  } finally {
    fixture.cleanup();
  }
});

test('formal finalize rejects Android not-run, skipped, stale or replaced XML, and stale pull before PC export', async () => {
  for (const profile of [
    'android-not-run', 'android-skip', 'android-old-xml', 'android-source-replaced',
    'android-pull-mismatch'
  ]) {
    const fixture = makeFixture({ profile });
    try {
      await begin(fixture);
      fixture.state.now = COMPLETED_AT;
      await assert.rejects(finalize(fixture), /android|instrumentation|XML|pull|fresh|passed/i);
      assert.equal(fixture.calls.some(call => call.kind === 'pc-export'), false);
      assert.equal(existsSync(join(fixture.root, METRICS_FILE)), false);
    } finally {
      fixture.cleanup();
    }
  }
});

test('instrumentation XML authority rejects linked result roots and a linked source swap before any evidence write', async () => {
  const { instrumentationXmlSnapshots } = await loadFormalRunner();
  const fixture = makeFixture();
  const resultRoot = join(fixture.repoRoot,
    'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'debug');
  const linkedSource = join(fixture.repoRoot, 'prelinked-android-xml-source');
  try {
    mkdirSync(linkedSource, { recursive: true });
    writeFileSync(join(linkedSource, 'TEST-linked.xml'), FORMAL_XML);
    rmSync(resultRoot, { recursive: true, force: true });
    symlinkSync(linkedSource, resultRoot, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => instrumentationXmlSnapshots(fixture.repoRoot),
      /instrumentation XML source authority/i);
  } finally {
    fixture.cleanup();
  }

  const swapped = makeFixture({ profile: 'android-source-linked-parent' });
  try {
    await begin(swapped);
    swapped.state.now = COMPLETED_AT;
    await assert.rejects(finalize(swapped), /instrumentation XML source authority/i);
    for (const relativePath of [
      'private/visible-path-android-test.xml', ANDROID_FILE, PC_FILE, METRICS_FILE
    ]) assert.equal(existsSync(join(swapped.root, relativePath)), false, relativePath);
  } finally {
    swapped.cleanup();
  }
});

test('formal finalize rejects PC exporter failure and never materializes metrics', async () => {
  const fixture = makeFixture({ profile: 'pc-failure' });
  try {
    await begin(fixture);
    fixture.state.now = COMPLETED_AT;
    await assert.rejects(finalize(fixture), /pc|export|exit|failed/i);
    assert.equal(existsSync(join(fixture.root, METRICS_FILE)), false);
    const failure = JSON.parse(readFileSync(join(fixture.root, FAILURE_FILE), 'utf8'));
    const start = JSON.parse(readFileSync(join(fixture.root, START_FILE), 'utf8'));
    assert.deepEqual(Object.keys(failure).sort(), [
      'androidOutputSha256', 'androidTestXmlSha256', 'checksum', 'errorCode', 'failedAt',
      'pcOutputSha256', 'runId', 'schemaVersion', 'startControlChecksum', 'status'
    ].sort());
    assert.equal(failure.schemaVersion, 'yuqi-v3-visible-path-collection-failure-v1');
    assert.equal(failure.status, 'blocked');
    assert.equal(failure.errorCode, 'FORMAL_VISIBLE_PATH_COLLECTION_FAILED');
    assert.equal(failure.runId, start.runId);
    assert.equal(failure.startControlChecksum, start.checksum);
    assert.match(failure.androidTestXmlSha256, /^[a-f0-9]{64}$/);
    assert.match(failure.androidOutputSha256, /^[a-f0-9]{64}$/);
    assert.equal(failure.pcOutputSha256, null);
    const { checksum, ...failureBase } = failure;
    assert.equal(checksum, sha256(failureBase));
    await assert.rejects(finalize(fixture), /pre-existing|failed|blocked|immutable/i);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.root, FAILURE_FILE), 'utf8')), failure);
  } finally {
    fixture.cleanup();
  }
});

test('formal success calls Android instrumentation, pull, and PC exporter in order with one UUID tuple', async () => {
  const fixture = makeFixture();
  try {
    const started = await begin(fixture);
    fixture.state.now = COMPLETED_AT;
    const result = await finalize(fixture);
    const producerCalls = fixture.calls.filter(call => [
      'android-instrumentation', 'android-pull', 'pc-export'
    ].includes(call.kind));
    assert.deepEqual(producerCalls.map(call => call.kind), [
      'android-instrumentation', 'android-pull', 'pc-export'
    ]);
    assert.equal(producerCalls.every(call => call.runId === started.runId), true);
    assert.equal(producerCalls.every(call => call.candidateReleaseId === CANDIDATE_ID), true);
    assert.equal(producerCalls.every(call => call.deviceSerial === DEVICE_SERIAL), true);
    assert.equal(producerCalls.every(call => call.sourceHead === SOURCE_HEAD), true);
    assert.equal(producerCalls.find(call => call.kind === 'android-pull').command,
      fixture.options.adbExecutable);
    assert.equal(result.runId, started.runId);
    assert.match(result.collectionAttestation.checksum, /^[a-f0-9]{64}$/);
    assert.equal(existsSync(join(fixture.root, START_FILE)), true);
    assert.equal(existsSync(join(fixture.root, ANDROID_FILE)), true);
    assert.equal(existsSync(join(fixture.root, PC_FILE)), true);
    assert.equal(existsSync(join(fixture.root, METRICS_FILE)), true);
    assert.equal(readdirSync(fixture.root).includes('visible-path-metrics-manifest.json'), false);
  } finally {
    fixture.cleanup();
  }
});

test('formal collection attestation is closed and binds command/XML/raw/database provenance', async () => {
  const fixture = makeFixture();
  try {
    await begin(fixture);
    fixture.state.now = COMPLETED_AT;
    const result = await finalize(fixture);
    assert.deepEqual(Object.keys(result.collectionAttestation).sort(), [
      'android', 'candidateReleaseChecksum', 'candidateReleaseId', 'checksum', 'completedAt',
      'deviceSerial', 'pc', 'runId', 'schemaVersion', 'sourceHead', 'startedAt'
    ].sort());
    assert.match(result.collectionAttestation.android.startControlChecksum, /^[a-f0-9]{64}$/);
    assert.equal(result.collectionAttestation.android.exitCode, 0);
    assert.equal(result.collectionAttestation.pc.exitCode, 0);
    assert.equal(result.collectionAttestation.android.deviceSerial, DEVICE_SERIAL);
    assert.equal(result.collectionAttestation.android.testXmlSourcePath, ANDROID_XML_SOURCE);
    assert.equal(result.collectionAttestation.android.instrumentationLaunchedAt, COMPLETED_AT + 1);
    assert.equal(result.collectionAttestation.android.testXmlSourceMtimeMs, COMPLETED_AT + 2);
    assert.equal(result.collectionAttestation.android.pullExitCode, 0);
    assert.equal(result.collectionAttestation.android.pullCommandDescriptor.command,
      fixture.options.adbExecutable);
    assert.deepEqual(result.collectionAttestation.android.pullCommandDescriptor.args, [
      '-s', DEVICE_SERIAL, 'exec-out', 'run-as', 'com.siyi.al', 'cat',
      `/data/user/0/com.siyi.al/files/visible-path/${result.runId}/visible-path-android.jsonl`
    ]);
    assert.equal(
      result.collectionAttestation.android.pullCommandChecksum,
      sha256(result.collectionAttestation.android.pullCommandDescriptor)
    );
    assert.equal(result.collectionAttestation.pc.readOnly, true);
    assert.match(result.collectionAttestation.android.outputSha256, /^[a-f0-9]{64}$/);
    assert.match(result.collectionAttestation.pc.outputSha256, /^[a-f0-9]{64}$/);
    assert.match(result.collectionAttestation.pc.sourceDatabaseSha256, /^[a-f0-9]{64}$/);
  } finally {
    fixture.cleanup();
  }
});
