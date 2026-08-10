import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ANDROID_EXPORT_PATH = 'private/visible-path-android.jsonl';
const PC_EXPORT_PATH = 'private/visible-path-pc.jsonl';
const KINDS = Object.freeze([
  'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION', 'MOMENT_REPLY'
]);
const ANDROID_METADATA_KEYS = Object.freeze([
  'candidateReleaseId', 'completedAt', 'deviceSerial', 'recordType', 'runId',
  'schemaVersion', 'startedAt', 'producerAttestation'
]);
const PC_METADATA_KEYS = Object.freeze([
  'candidateReleaseChecksum', 'candidateReleaseId', 'completedAt', 'recordType', 'runId',
  'schemaVersion', 'sourceHead', 'startedAt', 'producerAttestation'
]);
const ANDROID_ATTESTATION_KEYS = Object.freeze([
  'attestationChecksum', 'candidateReleaseId', 'completedAt', 'databaseUserVersion',
  'deviceSerial', 'producer', 'rowCount', 'runId', 'selectionChecksum', 'startedAt'
]);
const PC_ATTESTATION_KEYS = Object.freeze([
  'attestationChecksum', 'candidateReleaseChecksum', 'candidateReleaseId', 'completedAt',
  'databaseUserVersion', 'producer', 'readOnly', 'rowCount', 'runId',
  'selectionChecksum', 'sourceDatabaseSha256', 'sourceHead', 'startedAt'
]);
const ANDROID_ROW_KEYS = Object.freeze([
  'authorityLineageKeySha256', 'createdAt', 'elapsedMs', 'kind',
  'pipelineReleaseId', 'terminalDisposition', 'turnIdSha256', 'uiAppliedAt', 'visibleGroupIdSha256'
]);
const PC_ROW_KEYS = Object.freeze([
  'authorityLineageKeySha256', 'authorityMode', 'kind', 'pipelineReleaseId',
  'turnIdSha256', 'visibleGroupIdSha256'
]);
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value : Buffer.from(typeof value === 'string' ? value : canonical(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  throw new Error(`visible path metrics: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail(`${label} keys`);
}

function safeTime(value, now) {
  return Number.isSafeInteger(value) && value >= 0 && value <= now;
}

function hashId(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} checksum`);
}

function validateMetadata(metadata, keys, label) {
  exactKeys(metadata, keys, `${label} metadata`);
  if (metadata.recordType !== 'metadata' || typeof metadata.schemaVersion !== 'string') fail(`${label} metadata identity`);
}

function parseJsonl(file, label) {
  if (!existsSync(file)) fail(`${label} missing`);
  const bytes = readFileSync(file);
  if (bytes.length === 0) fail(`${label} empty`);
  const lines = bytes.toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.some(line => line.length === 0)) fail(`${label} blank line`);
  try {
    return { bytes, records: lines.map(line => JSON.parse(line)) };
  } catch {
    fail(`${label} JSON`);
  }
}

function exportRoot(androidFile, pcFile, outPath) {
  if (basename(androidFile) !== 'visible-path-android.jsonl'
    || basename(pcFile) !== 'visible-path-pc.jsonl') fail('fixed export filenames');
  const androidPrivate = resolve(dirname(androidFile));
  const pcPrivate = resolve(dirname(pcFile));
  const root = resolve(dirname(androidPrivate));
  if (basename(androidPrivate) !== 'private' || pcPrivate !== androidPrivate
    || resolve(dirname(outPath)) !== root) fail('fixed export/output location');
  return root;
}

function validateAndroidRows(rows, metadata, now) {
  if (metadata.schemaVersion !== 'yuqi-v3-visible-path-android-v1'
    || typeof metadata.deviceSerial !== 'string' || metadata.deviceSerial.length === 0
    || !UUID.test(metadata.runId || '')
    || typeof metadata.candidateReleaseId !== 'string' || metadata.candidateReleaseId.length === 0
    || !safeTime(metadata.startedAt, now) || !safeTime(metadata.completedAt, now)
    || metadata.completedAt < metadata.startedAt) fail('android metadata values');
  if (rows.length === 0) fail('android rows empty');
  return rows.map(row => {
    exactKeys(row, ANDROID_ROW_KEYS, 'android row');
    if (!/^[a-f0-9]{64}$/.test(row.turnIdSha256 || '')
      || !/^[a-f0-9]{64}$/.test(row.authorityLineageKeySha256 || '')
      || !/^[a-f0-9]{64}$/.test(row.visibleGroupIdSha256 || '')
      || row.pipelineReleaseId !== metadata.candidateReleaseId
      || !KINDS.includes(row.kind)
      || row.terminalDisposition !== 'visible'
      || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.uiAppliedAt)
      || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0
      || row.uiAppliedAt < row.createdAt || row.elapsedMs !== row.uiAppliedAt - row.createdAt
      || row.createdAt < metadata.startedAt || row.uiAppliedAt > metadata.completedAt) {
      fail('android row values');
    }
    return { ...row };
  });
}

function joinKey(row) {
  return canonical({
    authorityLineageKeySha256: row.authorityLineageKeySha256,
    turnIdSha256: row.turnIdSha256,
    visibleGroupIdSha256: row.visibleGroupIdSha256
  });
}

function validatePcRows(rows, metadata, candidateReleaseId, now) {
  if (metadata.schemaVersion !== 'yuqi-v3-visible-path-pc-v1'
    || typeof metadata.candidateReleaseId !== 'string'
    || metadata.candidateReleaseId !== candidateReleaseId
    || !UUID.test(metadata.runId || '')
    || !/^[a-f0-9]{64}$/.test(metadata.candidateReleaseChecksum || '')
    || !/^[a-f0-9]{40}$/.test(metadata.sourceHead || '')
    || !safeTime(metadata.startedAt, now) || !safeTime(metadata.completedAt, now)
    || metadata.completedAt < metadata.startedAt) fail('pc metadata values');
  if (rows.length === 0) fail('pc rows empty');
  const seen = new Set();
  for (const row of rows) {
    exactKeys(row, PC_ROW_KEYS, 'pc row');
    hashId(row.turnIdSha256, 'pc turn');
    hashId(row.authorityLineageKeySha256, 'pc lineage');
    hashId(row.visibleGroupIdSha256, 'pc group');
    if (row.pipelineReleaseId !== candidateReleaseId
      || !KINDS.includes(row.kind) || !['active_canary', 'live_shadow'].includes(row.authorityMode)) {
      fail('pc row values');
    }
    const key = joinKey(row);
    if (seen.has(key)) fail('pc duplicate tuple');
    seen.add(key);
  }
  return rows;
}

export function validateVisiblePathProducerAttestations({
  androidMetadata, androidRows, pcMetadata, pcRows
} = {}) {
  exactKeys(androidMetadata?.producerAttestation, ANDROID_ATTESTATION_KEYS, 'android producer attestation');
  exactKeys(pcMetadata?.producerAttestation, PC_ATTESTATION_KEYS, 'pc producer attestation');
  const android = androidMetadata.producerAttestation;
  const pc = pcMetadata.producerAttestation;
  const androidSelectionChecksum = sha256({ producer: 'room_authority_export_v1', rows: androidRows });
  const pcSelectionChecksum = sha256({ producer: 'pc_authority_readonly_export_v1', rows: pcRows });
  const { attestationChecksum: androidAttestationChecksum, ...androidBase } = android;
  const { attestationChecksum: pcAttestationChecksum, ...pcBase } = pc;
  if (android.producer !== 'room_authority_export_v1'
    || android.candidateReleaseId !== androidMetadata.candidateReleaseId
    || android.deviceSerial !== androidMetadata.deviceSerial
    || android.runId !== androidMetadata.runId
    || android.startedAt !== androidMetadata.startedAt
    || android.completedAt !== androidMetadata.completedAt
    || android.databaseUserVersion !== 15
    || android.rowCount !== androidRows.length
    || android.rowCount <= 0
    || android.selectionChecksum !== androidSelectionChecksum
    || androidAttestationChecksum !== sha256(androidBase)) {
    fail('android producer attestation values');
  }
  if (pc.producer !== 'pc_authority_readonly_export_v1'
    || pc.candidateReleaseId !== pcMetadata.candidateReleaseId
    || pc.candidateReleaseChecksum !== pcMetadata.candidateReleaseChecksum
    || pc.sourceHead !== pcMetadata.sourceHead
    || pc.runId !== pcMetadata.runId
    || pc.startedAt !== pcMetadata.startedAt
    || pc.completedAt !== pcMetadata.completedAt
    || pc.databaseUserVersion !== 15
    || pc.readOnly !== true
    || pc.rowCount !== pcRows.length
    || pc.rowCount <= 0
    || !/^[a-f0-9]{64}$/.test(pc.sourceDatabaseSha256 || '')
    || pc.selectionChecksum !== pcSelectionChecksum
    || pcAttestationChecksum !== sha256(pcBase)) {
    fail('pc producer attestation values');
  }
  return { android, pc, checksum: sha256({ android, pc }) };
}

export function validateCollectionAttestation(value, {
  androidMetadata, pcMetadata, androidExportSha256, pcExportSha256
}) {
  if (value == null) return null;
  exactKeys(value, [
    'android', 'candidateReleaseChecksum', 'candidateReleaseId', 'checksum', 'completedAt',
    'deviceSerial', 'pc', 'runId', 'schemaVersion', 'sourceHead', 'startedAt'
  ], 'collection attestation');
  exactKeys(value.android, [
    'commandChecksum', 'commandDescriptor', 'deviceSerial', 'exitCode', 'instrumentationLaunchedAt',
    'outputSha256', 'producer', 'pullCommandChecksum', 'pullCommandDescriptor', 'pullExitCode',
    'startControlChecksum', 'testXmlSha256', 'testXmlSourceMtimeMs', 'testXmlSourcePath'
  ], 'collection attestation android');
  exactKeys(value.pc, [
    'commandChecksum', 'commandDescriptor', 'exitCode', 'outputSha256', 'producer', 'readOnly',
    'sourceDatabaseSha256'
  ], 'collection attestation pc');
  const commandKeys = [
    'args', 'candidateReleaseId', 'command', 'deviceSerial', 'environment', 'kind', 'runId', 'sourceHead'
  ];
  exactKeys(value.android.commandDescriptor, commandKeys, 'collection attestation android command');
  exactKeys(value.android.pullCommandDescriptor, commandKeys,
    'collection attestation Android pull command');
  exactKeys(value.pc.commandDescriptor, commandKeys, 'collection attestation pc command');
  const { checksum, ...base } = value;
  if (value.schemaVersion !== 'yuqi-v3-visible-path-collection-v1'
    || value.runId !== androidMetadata.runId || value.runId !== pcMetadata.runId
    || value.sourceHead !== pcMetadata.sourceHead
    || value.candidateReleaseId !== androidMetadata.candidateReleaseId
    || value.candidateReleaseId !== pcMetadata.candidateReleaseId
    || value.candidateReleaseChecksum !== pcMetadata.candidateReleaseChecksum
    || value.deviceSerial !== androidMetadata.deviceSerial
    || value.startedAt !== androidMetadata.startedAt || value.startedAt !== pcMetadata.startedAt
    || value.completedAt !== androidMetadata.completedAt || value.completedAt !== pcMetadata.completedAt
    || value.android.producer !== 'android_instrumentation_export_v1'
    || value.android.deviceSerial !== value.deviceSerial || value.android.exitCode !== 0
    || value.android.outputSha256 !== androidExportSha256
    || value.pc.producer !== 'pc_readonly_export_command_v1' || value.pc.exitCode !== 0
    || value.pc.readOnly !== true || value.pc.outputSha256 !== pcExportSha256
    || value.pc.sourceDatabaseSha256 !== pcMetadata.producerAttestation.sourceDatabaseSha256
    || value.android.commandDescriptor.kind !== 'android-instrumentation'
    || value.android.pullCommandDescriptor.kind !== 'android-pull'
    || value.pc.commandDescriptor.kind !== 'pc-export'
    || value.android.commandDescriptor.runId !== value.runId
    || value.android.pullCommandDescriptor.runId !== value.runId
    || value.pc.commandDescriptor.runId !== value.runId
    || value.android.commandDescriptor.candidateReleaseId !== value.candidateReleaseId
    || value.android.pullCommandDescriptor.candidateReleaseId !== value.candidateReleaseId
    || value.pc.commandDescriptor.candidateReleaseId !== value.candidateReleaseId
    || value.android.commandDescriptor.deviceSerial !== value.deviceSerial
    || value.android.pullCommandDescriptor.deviceSerial !== value.deviceSerial
    || value.pc.commandDescriptor.deviceSerial !== value.deviceSerial
    || value.android.commandDescriptor.sourceHead !== value.sourceHead
    || value.android.pullCommandDescriptor.sourceHead !== value.sourceHead
    || value.pc.commandDescriptor.sourceHead !== value.sourceHead
    || !Array.isArray(value.android.commandDescriptor.args)
    || !Array.isArray(value.android.pullCommandDescriptor.args)
    || !Array.isArray(value.pc.commandDescriptor.args)
    || canonical(value.android.commandDescriptor.environment) !== canonical({ ANDROID_SERIAL: value.deviceSerial })
    || canonical(value.android.pullCommandDescriptor.environment) !== canonical({})
    || canonical(value.pc.commandDescriptor.environment) !== canonical({})
    || typeof value.android.commandDescriptor.command !== 'string'
    || typeof value.android.pullCommandDescriptor.command !== 'string'
    || typeof value.pc.commandDescriptor.command !== 'string'
    || value.android.commandChecksum !== sha256(value.android.commandDescriptor)
    || value.android.pullCommandChecksum !== sha256(value.android.pullCommandDescriptor)
    || value.android.pullExitCode !== 0
    || value.pc.commandChecksum !== sha256(value.pc.commandDescriptor)
    || !/^[a-f0-9]{64}$/.test(value.android.commandChecksum || '')
    || !/^[a-f0-9]{64}$/.test(value.android.pullCommandChecksum || '')
    || !/^[a-f0-9]{64}$/.test(value.android.startControlChecksum || '')
    || !/^[a-f0-9]{64}$/.test(value.android.testXmlSha256 || '')
    || !Number.isSafeInteger(value.android.instrumentationLaunchedAt)
    || !Number.isSafeInteger(value.android.testXmlSourceMtimeMs)
    || value.android.instrumentationLaunchedAt < value.completedAt
    || value.android.testXmlSourceMtimeMs < value.android.instrumentationLaunchedAt
    || typeof value.android.testXmlSourcePath !== 'string'
    || !/^android\/app\/build\/outputs\/androidTest-results\/connected\/debug\/(?:[^/]+\/)*TEST-[^/]+\.xml$/i
      .test(value.android.testXmlSourcePath)
    || value.android.testXmlSourcePath.split('/').includes('..')
    || !/^[a-f0-9]{64}$/.test(value.pc.commandChecksum || '')
    || checksum !== sha256(base)) fail('collection attestation values');
  return value;
}

function deriveReport({ android, pc, androidBytes, pcBytes, collectionAttestation = null }) {
  const [androidMetadata, ...androidRows] = android.records;
  const [pcMetadata, ...pcRows] = pc.records;
  const now = Date.now();
  validateMetadata(androidMetadata, ANDROID_METADATA_KEYS, 'android');
  validateMetadata(pcMetadata, PC_METADATA_KEYS, 'pc');
  const androidSamples = validateAndroidRows(androidRows, androidMetadata, now);
  const validatedPcRows = validatePcRows(pcRows, pcMetadata, androidMetadata.candidateReleaseId, now);
  const producerAttestations = validateVisiblePathProducerAttestations({
    androidMetadata, androidRows, pcMetadata, pcRows: validatedPcRows
  });
  if (pcMetadata.candidateReleaseId !== androidMetadata.candidateReleaseId) fail('candidate release id mismatch');
  if (pcMetadata.runId !== androidMetadata.runId) fail('run id mismatch');
  if (pcMetadata.startedAt !== androidMetadata.startedAt
    || pcMetadata.completedAt !== androidMetadata.completedAt) fail('run timestamp mismatch');
  const pcByTuple = new Map(validatedPcRows.map(row => [joinKey(row), row]));
  const samples = androidSamples.map(androidSample => {
    const sample = { ...androidSample };
    const pcRow = pcByTuple.get(joinKey(sample));
    if (!pcRow) fail('android/pc authority join');
    sample.authorityMode = pcRow.authorityMode;
    sample.sampleId = sha256(sample);
    return sample;
  });
  for (const sample of samples) {
    const pcRow = pcByTuple.get(joinKey(sample));
    if (!pcRow || pcRow.kind !== sample.kind || pcRow.pipelineReleaseId !== sample.pipelineReleaseId
      || pcRow.authorityMode !== sample.authorityMode) fail('android/pc authority join');
  }
  if (pcByTuple.size !== samples.length) fail('android/pc row count');
  const activeSamples = samples.filter(sample => sample.authorityMode === 'active_canary');
  const direct = activeSamples.filter(sample => sample.kind === 'DIRECT_REPLY');
  if (direct.length < 20 || KINDS.some(kind => kind !== 'DIRECT_REPLY'
    && !activeSamples.some(sample => sample.kind === kind))) fail('sample coverage');
  const sampleSetChecksum = sha256(samples);
  const androidExportSha256 = sha256(androidBytes);
  const pcExportSha256 = sha256(pcBytes);
  const verifiedCollectionAttestation = validateCollectionAttestation(collectionAttestation, {
    androidMetadata, pcMetadata, androidExportSha256, pcExportSha256
  });
  const androidExportPath = ANDROID_EXPORT_PATH;
  const pcExportPath = PC_EXPORT_PATH;
  const metadataSha256 = sha256({
    androidExportPath, androidExportSha256,
    candidateReleaseChecksum: pcMetadata.candidateReleaseChecksum,
    candidateReleaseId: androidMetadata.candidateReleaseId,
    deviceSerial: androidMetadata.deviceSerial,
    pcExportPath, pcExportSha256, runId: androidMetadata.runId,
    sampleSetChecksum, sourceHead: pcMetadata.sourceHead
  });
  const elapsed = direct.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(elapsed.length / 2);
  const metrics = {
    directReplyMedianMs: elapsed.length % 2 === 1
      ? elapsed[middle] : (elapsed[middle - 1] + elapsed[middle]) / 2,
    directReplyP95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1],
    maximumVisibleMs: Math.max(...samples.map(sample => sample.elapsedMs)),
    shadowBlockedVisibleCount: samples.filter(sample => sample.authorityMode === 'live_shadow').length
  };
  const report = {
    schemaVersion: 'yuqi-v3-visible-path-metrics-v1',
    candidateReleaseId: androidMetadata.candidateReleaseId,
    candidateReleaseChecksum: pcMetadata.candidateReleaseChecksum,
    sourceHead: pcMetadata.sourceHead,
    deviceSerial: androidMetadata.deviceSerial,
    runId: androidMetadata.runId,
    startedAt: androidMetadata.startedAt,
    completedAt: androidMetadata.completedAt,
    productionReleaseMutation: false,
    androidExportPath, androidExportSha256, pcExportPath, pcExportSha256,
    sampleSetChecksum, metadataSha256,
    producerAttestationChecksum: producerAttestations.checksum,
    collectionAttestation: verifiedCollectionAttestation,
    samples, metrics
  };
  return { ...report, reportChecksum: sha256(report) };
}

export function generateVisiblePathMetrics(options = {}) {
  const allowed = new Set(['androidExportPath', 'pcExportPath', 'outPath', 'collectionAttestation']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) fail(`unknown option ${key}`);
  const androidExportPath = resolve(options.androidExportPath || '');
  const pcExportPath = resolve(options.pcExportPath || '');
  const outPath = resolve(options.outPath || '');
  if (!options.androidExportPath || !options.pcExportPath || !options.outPath) fail('android/pc/out paths required');
  const root = exportRoot(androidExportPath, pcExportPath, outPath);
  const android = parseJsonl(androidExportPath, 'android export');
  const pc = parseJsonl(pcExportPath, 'pc export');
  const report = deriveReport({
    android, pc, androidBytes: android.bytes, pcBytes: pc.bytes,
    collectionAttestation: options.collectionAttestation ?? null
  });
  const temp = `${outPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    renameSync(temp, outPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return report;
}

function parseCli(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = arg === '--android-export' ? 'androidExportPath'
      : arg === '--pc-export' ? 'pcExportPath' : arg === '--out' ? 'outPath' : null;
    if (!key || !argv[index + 1]) fail(`unknown CLI argument ${arg}`);
    result[key] = argv[++index];
  }
  return result;
}

if (process.argv[1] && /generate-yuqi-visible-path-metrics\.mjs$/i.test(process.argv[1])) {
  try {
    const report = generateVisiblePathMetrics(parseCli(process.argv.slice(2)));
    console.log(JSON.stringify({ reportChecksum: report.reportChecksum, out: resolve(process.argv[process.argv.indexOf('--out') + 1]) }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
