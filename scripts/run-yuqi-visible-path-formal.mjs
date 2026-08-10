import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import {
  canonical, generateVisiblePathMetrics, sha256
} from './generate-yuqi-visible-path-metrics.mjs';
import { validateQualityArtifactBundle } from './report-yuqi-lived-quality.mjs';

const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const START_RELATIVE = 'private/visible-path-collection-start.json';
const FAILURE_RELATIVE = 'private/visible-path-collection-failed.json';
const ANDROID_XML_RELATIVE = 'private/visible-path-android-test.xml';
const ANDROID_RELATIVE = 'private/visible-path-android.jsonl';
const PC_RELATIVE = 'private/visible-path-pc.jsonl';
const METRICS_RELATIVE = 'visible-path-metrics.json';
const EXPORT_TEST = 'com.siyi.al.execution.YuqiVisiblePathExportTest#exportCurrentDeviceVisiblePathArtifact';

function fail(message) {
  throw new Error(`visible path formal collection: ${message}`);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) fail(`${label} keys`);
}

function nowValue(options) {
  const value = Number((options.now || Date.now)());
  if (!Number.isSafeInteger(value) || value < 0 || value > Date.now() + 86_400_000) fail('clock');
  return value;
}

function pathsFor(options) {
  if (typeof options.evidenceDir !== 'string' || !options.evidenceDir) fail('evidence directory');
  const repoRoot = resolve(options.repoRoot || join(import.meta.dirname, '..'));
  const root = resolve(options.evidenceDir);
  const scope = assertEvidenceDirectoryScope(repoRoot, root);
  return {
    root, scope,
    start: join(root, START_RELATIVE),
    failure: join(root, FAILURE_RELATIVE),
    androidXml: join(root, ANDROID_XML_RELATIVE),
    android: join(root, ANDROID_RELATIVE),
    pc: join(root, PC_RELATIVE),
    metrics: join(root, METRICS_RELATIVE)
  };
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function commandDescriptor(request) {
  return {
    args: request.args || [], command: request.command || null, kind: request.kind,
    runId: request.runId, candidateReleaseId: request.candidateReleaseId,
    deviceSerial: request.deviceSerial, environment: request.environment || {},
    sourceHead: request.sourceHead
  };
}

async function execText(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd, encoding: options.encoding === undefined ? 'utf8' : options.encoding,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true
    });
    return { exitCode: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout || '', stderr: error?.stderr || error?.message || String(error)
    };
  }
}

function containedRelative(root, target, label) {
  const value = relative(resolve(root), resolve(target));
  if (!value || value === '..' || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(value)) fail(label);
  return value;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertUnlinkedContainedPath(root, target, { allowMissing = false } = {}) {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const relativeTarget = containedRelative(resolvedRoot, resolvedTarget,
    'Android instrumentation XML source authority');
  const rootStats = lstatOrNull(resolvedRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    fail('Android instrumentation XML source authority');
  }
  const realRoot = realpathSync(resolvedRoot);
  let current = resolvedRoot;
  for (const part of relativeTarget.split(/[\\/]+/)) {
    current = join(current, part);
    const stats = lstatOrNull(current);
    if (!stats) {
      if (allowMissing) return null;
      fail('Android instrumentation XML source authority');
    }
    if (stats.isSymbolicLink()) fail('Android instrumentation XML source authority');
    const realCurrent = realpathSync(current);
    const realRelative = relative(realRoot, realCurrent);
    if (realRelative === '..' || realRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      || isAbsolute(realRelative)) fail('Android instrumentation XML source authority');
  }
  return { resolvedTarget, realTarget: realpathSync(resolvedTarget) };
}

function readUnlinkedInstrumentationFile(repoRoot, resultRoot, sourceFile) {
  containedRelative(resultRoot, sourceFile, 'Android instrumentation XML source authority');
  assertUnlinkedContainedPath(repoRoot, sourceFile);
  const beforePath = lstatSync(sourceFile);
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    fail('Android instrumentation XML source authority');
  }
  const beforeReal = realpathSync(sourceFile);
  const descriptor = openSync(sourceFile, 'r');
  try {
    const beforeHandle = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const afterHandle = fstatSync(descriptor);
    assertUnlinkedContainedPath(repoRoot, sourceFile);
    const afterPath = lstatSync(sourceFile);
    const afterReal = realpathSync(sourceFile);
    if (!beforeHandle.isFile() || !afterHandle.isFile() || afterPath.isSymbolicLink()
      || !afterPath.isFile() || beforeReal !== afterReal
      || beforeHandle.dev !== afterHandle.dev || beforeHandle.ino !== afterHandle.ino
      || beforeHandle.dev !== afterPath.dev || beforeHandle.ino !== afterPath.ino
      || beforeHandle.size !== afterHandle.size
      || Math.trunc(beforeHandle.mtimeMs) !== Math.trunc(afterHandle.mtimeMs)) {
      fail('Android instrumentation XML source authority');
    }
    return { bytes, stats: afterHandle };
  } finally {
    closeSync(descriptor);
  }
}

export function instrumentationXmlSnapshots(root) {
  const resultRoot = join(root, 'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'debug');
  const files = new Map();
  if (!assertUnlinkedContainedPath(root, resultRoot, { allowMissing: true })) return files;
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) fail('Android instrumentation XML source authority');
      if (stats.isDirectory()) visit(path);
      else if (name.endsWith('.xml')) {
        const verified = readUnlinkedInstrumentationFile(root, resultRoot, path);
        files.set(path, {
          mtimeMs: Math.trunc(verified.stats.mtimeMs), size: verified.stats.size,
          sha256: sha256Bytes(verified.bytes)
        });
      }
    }
  };
  visit(resultRoot);
  return files;
}

export function androidOutputDirectory(appOutput) {
  const normalized = String(appOutput || '').replaceAll('\\', '/');
  const boundary = normalized.lastIndexOf('/');
  if (!normalized.startsWith('/') || boundary <= 0 || boundary === normalized.length - 1) {
    fail('Android output path');
  }
  return normalized.slice(0, boundary);
}

function defaultRunner(repoRoot, adbExecutable) {
  return {
    async run(request) {
      if (request.kind === 'android-instrumentation') {
        const outputDirectory = androidOutputDirectory(request.appOutput);
        const prior = await execText(adbExecutable, [
          '-s', request.deviceSerial, 'shell', 'run-as', 'com.siyi.al', 'ls', outputDirectory
        ], { cwd: repoRoot });
        if (prior.exitCode === 0) {
          return { exitCode: 1, stdout: '', stderr: 'run-specific Android output already exists' };
        }
        const prepared = await execText(adbExecutable, [
          '-s', request.deviceSerial, 'shell', 'run-as', 'com.siyi.al', 'mkdir', '-p', outputDirectory
        ], { cwd: repoRoot });
        if (prepared.exitCode !== 0) return prepared;
        const beforeXml = instrumentationXmlSnapshots(repoRoot);
        const launchedAt = Date.now();
        const executed = await execText(request.command, request.args, {
          cwd: repoRoot, env: request.environment
        });
        const afterXml = instrumentationXmlSnapshots(repoRoot);
        const xmlFiles = [...afterXml.entries()].filter(([path, snapshot]) => {
          const priorSnapshot = beforeXml.get(path);
          return snapshot.mtimeMs >= launchedAt && (!priorSnapshot
            || priorSnapshot.mtimeMs !== snapshot.mtimeMs
            || priorSnapshot.size !== snapshot.size
            || priorSnapshot.sha256 !== snapshot.sha256);
        });
        const xmlPath = xmlFiles.length === 1 ? xmlFiles[0][0] : null;
        const xml = xmlPath ? readFileSync(xmlPath, 'utf8') : '';
        return {
          ...executed, launchedAt, xml, xmlFileCount: xmlFiles.length,
          xmlSourceMtimeMs: xmlPath ? xmlFiles[0][1].mtimeMs : null,
          xmlSourcePath: xmlPath ? relative(repoRoot, xmlPath).replaceAll('\\', '/') : null,
          outputSha256: sha256Bytes(Buffer.from(xml))
        };
      }
      if (request.kind === 'android-pull') {
        const executed = await execText(request.command, request.args, { cwd: repoRoot, encoding: null });
        return { ...executed, bytes: Buffer.from(executed.stdout || []) };
      }
      if (request.kind === 'pc-export') {
        const executed = await execText(request.command, request.args, { cwd: repoRoot });
        const bytes = executed.exitCode === 0 && existsSync(request.outputPath)
          ? readFileSync(request.outputPath) : null;
        let sourceDatabaseSha256 = null;
        if (bytes) {
          try {
            sourceDatabaseSha256 = JSON.parse(Buffer.from(bytes).toString('utf8').split(/\r?\n/, 1)[0])
              ?.producerAttestation?.sourceDatabaseSha256 ?? null;
          } catch {
            sourceDatabaseSha256 = null;
          }
        }
        return {
          ...executed,
          bytes,
          sourceDatabaseSha256,
          wroteOutput: executed.exitCode === 0
        };
      }
      fail(`unknown runner kind ${request.kind}`);
    }
  };
}

async function gitValue(repoRoot, args) {
  const result = await execText('git', args, { cwd: repoRoot });
  if (result.exitCode !== 0) fail(`git ${args.join(' ')} failed`);
  return String(result.stdout).trim();
}

function insidePath(parent, candidate, allowSame = false) {
  const rel = relative(parent, candidate);
  return (allowSame && rel === '') || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
}

export function assertEvidenceDirectoryScope(repoRoot, evidenceDir) {
  const resolvedRepo = resolve(repoRoot);
  const resolvedEvidence = resolve(evidenceDir);
  const relativeEvidence = relative(resolve(repoRoot), resolve(evidenceDir)).replaceAll('\\', '/');
  const evidenceRoot = 'artifacts/yuqi-lived-agency-v3';
  if (!relativeEvidence || relativeEvidence === '..' || relativeEvidence.startsWith('../')
    || isAbsolute(relativeEvidence)
    || (relativeEvidence !== evidenceRoot && !relativeEvidence.startsWith(`${evidenceRoot}/`))) {
    fail('evidence directory scope');
  }
  if (!existsSync(resolvedRepo) || lstatSync(resolvedRepo).isSymbolicLink()) {
    fail('evidence directory scope');
  }
  const realRepo = realpathSync(resolvedRepo);
  let cursor = resolvedRepo;
  for (const segment of relativeEvidence.split('/')) {
    cursor = join(cursor, segment);
    if (existsSync(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) fail('evidence directory scope');
      const realCursor = realpathSync(cursor);
      if (!insidePath(realRepo, realCursor, true)) fail('evidence directory scope');
    }
  }
  const realEvidence = existsSync(resolvedEvidence) ? realpathSync(resolvedEvidence) : null;
  if (realEvidence && (!statSync(resolvedEvidence).isDirectory()
    || !insidePath(realRepo, realEvidence))) fail('evidence directory scope');
  return { relativeEvidence, resolvedEvidence, resolvedRepo, realRepo, realEvidence };
}

export function assertEvidencePath(scope, target, { allowMissing = true } = {}) {
  if (!scope || typeof scope !== 'object') fail('evidence path scope');
  const root = resolve(scope.resolvedEvidence);
  const file = resolve(target);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('evidence path scope');
  let cursor = root;
  for (const segment of rel.split(/[\\/]/)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) fail('evidence path scope');
    const realCursor = realpathSync(cursor);
    const realRoot = existsSync(root) ? realpathSync(root) : scope.realRepo;
    if (!insidePath(realRoot, realCursor, true)) fail('evidence path scope');
  }
  if (!allowMissing && !existsSync(file)) fail('evidence path missing');
  return file;
}

export function gitStatusArgsForEvidence(repoRoot, evidenceDir) {
  const { relativeEvidence } = assertEvidenceDirectoryScope(repoRoot, evidenceDir);
  return [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.',
    `:(exclude)${relativeEvidence}/**`
  ];
}

export function assertRuntimeDatabaseSnapshotReady(databasePath) {
  const resolved = resolve(databasePath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) fail('runtime database snapshot missing');
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = `${resolved}${suffix}`;
    if (existsSync(sidecar) && statSync(sidecar).size > 0) {
      fail(`runtime database snapshot has non-empty ${suffix.slice(1)} sidecar`);
    }
  }
  return resolved;
}

export function resolveFormalAdbExecutable(repoRoot, environment = process.env) {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => resolve(value, 'platform-tools', executable));
  const properties = resolve(repoRoot, 'android', 'local.properties');
  if (existsSync(properties)) {
    const match = readFileSync(properties, 'utf8').match(/^sdk\.dir=(.+)$/m);
    if (match) {
      const sdkRoot = match[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
      candidates.push(resolve(sdkRoot, 'platform-tools', executable));
    }
  }
  const selected = candidates.find(candidate => isAbsolute(candidate) && existsSync(candidate));
  if (!selected) fail('absolute adb executable required');
  return selected;
}

async function defaultDeviceSerial(repoRoot, adbExecutable) {
  const result = await execText(adbExecutable, ['devices'], { cwd: repoRoot });
  if (result.exitCode !== 0) fail('adb devices failed');
  const devices = String(result.stdout).split(/\r?\n/).slice(1)
    .map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === 'device').map(parts => parts[0]);
  if (devices.length !== 1) fail('exactly one Android device required');
  return devices[0];
}

async function defaultAppFilesRoot(repoRoot, serial, adbExecutable) {
  const result = await execText(adbExecutable, [
    '-s', serial, 'shell', 'run-as', 'com.siyi.al', 'pwd'
  ], { cwd: repoRoot });
  const appRoot = String(result.stdout || '').trim().replaceAll('\\', '/');
  if (result.exitCode !== 0 || !appRoot.startsWith('/') || !appRoot.endsWith('/com.siyi.al')) {
    fail('Android app files root unavailable');
  }
  return `${appRoot}/files`;
}

function dependencies(options) {
  const repoRoot = resolve(options.repoRoot || join(import.meta.dirname, '..'));
  const adbExecutable = options.adbExecutable || resolveFormalAdbExecutable(repoRoot);
  if (!isAbsolute(adbExecutable)) fail('absolute adb executable required');
  const fsApi = options.fs || { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync };
  const source = options.source || {
    getHead: () => gitValue(repoRoot, ['rev-parse', 'HEAD']),
    getStatus: () => gitValue(repoRoot, gitStatusArgsForEvidence(repoRoot, options.evidenceDir))
  };
  const candidate = options.candidate || {
    getReleaseIdentity: async () => ({
      candidateReleaseId: options.candidateReleaseId,
      candidateReleaseChecksum: options.candidateReleaseChecksum
    })
  };
  const device = options.device || {
    getSerial: () => defaultDeviceSerial(repoRoot, adbExecutable),
    getFilesRoot: serial => defaultAppFilesRoot(repoRoot, serial, adbExecutable)
  };
  const runtimeDatabase = options.runtimeDatabase || {
    getPathHash: async () => sha256(resolve(options.runtimeDatabasePath)),
    getSha256: async () => sha256Bytes(readFileSync(resolve(options.runtimeDatabasePath)))
  };
  return {
    repoRoot, fsApi, source, candidate, device, runtimeDatabase, adbExecutable,
    runner: options.runner || defaultRunner(repoRoot, adbExecutable)
  };
}

async function currentIdentity(options, deps) {
  const release = await deps.candidate.getReleaseIdentity();
  const sourceHead = String(await deps.source.getHead()).trim();
  const status = String(await deps.source.getStatus());
  const deviceSerial = String(await deps.device.getSerial());
  const runtimeDatabasePathHash = String(await deps.runtimeDatabase.getPathHash());
  const candidateReleaseId = String(release?.candidateReleaseId ?? release?.id ?? '');
  const candidateReleaseChecksum = String(release?.candidateReleaseChecksum ?? release?.checksum ?? '');
  if (!HEX40.test(sourceHead) || status.trim() !== '') fail('source identity is dirty or invalid');
  if (!candidateReleaseId || !HEX64.test(candidateReleaseChecksum)) fail('candidate identity');
  if (!deviceSerial) fail('device identity');
  if (!HEX64.test(runtimeDatabasePathHash)) fail('runtime database identity');
  if (typeof options.runtimeDatabasePath !== 'string' || !options.runtimeDatabasePath) fail('runtime database path');
  if (options.expectedSourceHead != null && sourceHead !== options.expectedSourceHead) fail('quality source identity');
  return {
    sourceHead, candidateReleaseId, candidateReleaseChecksum, deviceSerial,
    runtimeDatabasePath: resolve(options.runtimeDatabasePath), runtimeDatabasePathHash
  };
}

function assertOutputsAbsent(paths, fsApi, includeStart = true) {
  const selected = includeStart
    ? [paths.start, paths.failure, paths.androidXml, paths.android, paths.pc, paths.metrics]
    : [paths.failure, paths.androidXml, paths.android, paths.pc, paths.metrics];
  for (const path of selected) assertEvidencePath(paths.scope, path);
  if (selected.some(path => fsApi.existsSync(path))) fail('pre-existing immutable output');
}

function writeExclusive(path, bytes, fsApi, scope) {
  assertEvidencePath(scope, path);
  if (fsApi.existsSync(path)) fail('pre-existing immutable output');
  fsApi.mkdirSync(dirname(path), { recursive: true });
  assertEvidenceDirectoryScope(scope.resolvedRepo, scope.resolvedEvidence);
  assertEvidencePath(scope, path);
  fsApi.writeFileSync(path, bytes, { flag: 'wx' });
  assertEvidencePath(scope, path, { allowMissing: false });
}

export function validateVisiblePathStartControl(value) {
  exactKeys(value, [
    'candidateReleaseChecksum', 'candidateReleaseId', 'checksum', 'deviceSerial', 'runId',
    'runtimeDatabasePath', 'runtimeDatabasePathHash', 'schemaVersion', 'sourceHead', 'startedAt'
  ], 'start control');
  const { checksum, ...base } = value;
  if (value.schemaVersion !== 'yuqi-v3-visible-path-collection-start-v1'
    || !UUID.test(value.runId || '') || !HEX40.test(value.sourceHead || '')
    || typeof value.candidateReleaseId !== 'string' || !value.candidateReleaseId
    || !HEX64.test(value.candidateReleaseChecksum || '')
    || typeof value.runtimeDatabasePath !== 'string' || !value.runtimeDatabasePath
    || !HEX64.test(value.runtimeDatabasePathHash || '') || typeof value.deviceSerial !== 'string'
    || !value.deviceSerial || !Number.isSafeInteger(value.startedAt) || value.startedAt < 0
    || checksum !== sha256(base)) fail('start control authority');
  return value;
}

function parseFirstJsonl(bytes, label) {
  try {
    const first = Buffer.from(bytes).toString('utf8').split(/\r?\n/, 1)[0];
    if (!first) fail(`${label} empty`);
    return JSON.parse(first);
  } catch (error) {
    if (String(error?.message || '').startsWith('visible path formal collection:')) throw error;
    fail(`${label} pull is not valid JSONL`);
  }
}

function assertProducerMetadata(metadata, start, completedAt, label) {
  if (!metadata || metadata.recordType !== 'metadata' || metadata.runId !== start.runId
    || metadata.candidateReleaseId !== start.candidateReleaseId
    || metadata.startedAt !== start.startedAt || metadata.completedAt !== completedAt) {
    fail(`${label} pull identity mismatch`);
  }
}

function readVerifiedInstrumentationXmlSource(repoRoot, sourcePath, expectedMtimeMs, expectedSha256) {
  const normalized = String(sourcePath || '').replaceAll('\\', '/');
  const sourceFile = resolve(repoRoot, ...normalized.split('/'));
  const resultRoot = resolve(repoRoot,
    'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'debug');
  const relativeSource = relative(resolve(repoRoot), sourceFile).replaceAll('\\', '/');
  if (relativeSource !== normalized || relativeSource.startsWith('../') || isAbsolute(relativeSource)
    || normalized.split('/').includes('..') || !existsSync(sourceFile)) {
    fail('Android instrumentation XML source authority');
  }
  const verified = readUnlinkedInstrumentationFile(repoRoot, resultRoot, sourceFile);
  if (Math.trunc(verified.stats.mtimeMs) !== expectedMtimeMs
    || sha256Bytes(verified.bytes) !== expectedSha256) {
    fail('Android instrumentation XML source authority');
  }
  return verified.bytes;
}

export async function beginVisiblePathCollection(options = {}) {
  const paths = pathsFor(options);
  const deps = dependencies(options);
  assertOutputsAbsent(paths, deps.fsApi, true);
  const identity = await currentIdentity(options, deps);
  const base = {
    schemaVersion: 'yuqi-v3-visible-path-collection-start-v1',
    runId: randomUUID(), ...identity, startedAt: nowValue(options)
  };
  const start = { ...base, checksum: sha256(base) };
  writeExclusive(paths.start, `${JSON.stringify(start, null, 2)}\n`, deps.fsApi, paths.scope);
  return start;
}

async function finalizeVisiblePathCollectionInternal(options, paths, deps) {
  if (!deps.fsApi.existsSync(paths.start)) fail('start control missing');
  assertOutputsAbsent(paths, deps.fsApi, false);
  const start = validateVisiblePathStartControl(JSON.parse(deps.fsApi.readFileSync(paths.start, 'utf8')));
  const current = await currentIdentity(options, deps);
  for (const key of [
    'sourceHead', 'candidateReleaseId', 'candidateReleaseChecksum', 'deviceSerial',
    'runtimeDatabasePath', 'runtimeDatabasePathHash'
  ]) if (current[key] !== start[key]) fail(`${key} identity drift`);
  const completedAt = nowValue(options);
  if (completedAt < start.startedAt) fail('completion timestamp');
  const appFilesRoot = deps.device.getFilesRoot
    ? String(await deps.device.getFilesRoot(start.deviceSerial)).replaceAll('\\', '/').replace(/\/$/, '')
    : '/data/user/0/com.siyi.al/files';
  if (!appFilesRoot.startsWith('/')) fail('Android app files root identity');
  const appOutput = `${appFilesRoot}/visible-path/${start.runId}/visible-path-android.jsonl`;
  const androidRequest = {
    kind: 'android-instrumentation', runId: start.runId,
    candidateReleaseId: start.candidateReleaseId, deviceSerial: start.deviceSerial,
    sourceHead: start.sourceHead, appOutput,
    command: join(deps.repoRoot, 'android', 'gradlew.bat'),
    environment: { ANDROID_SERIAL: start.deviceSerial },
    args: [
      ':app:connectedDebugAndroidTest', '--no-daemon', '--no-problems-report',
      `-Pandroid.testInstrumentationRunnerArguments.class=${EXPORT_TEST}`,
      `-Pandroid.testInstrumentationRunnerArguments.visiblePathOutputPath=${appOutput}`,
      `-Pandroid.testInstrumentationRunnerArguments.candidateReleaseId=${start.candidateReleaseId}`,
      `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=${start.deviceSerial}`,
      `-Pandroid.testInstrumentationRunnerArguments.runId=${start.runId}`,
      `-Pandroid.testInstrumentationRunnerArguments.selectionFrom=${start.startedAt}`,
      `-Pandroid.testInstrumentationRunnerArguments.selectionTo=${completedAt}`
    ]
  };
  const android = await deps.runner.run(androidRequest);
  if (android?.exitCode !== 0) fail('Android instrumentation did not pass');
  const xml = String(android?.xml || '');
  const suite = xml.match(/<testsuite\b([^>]*)>/i)?.[1] || '';
  const cases = [...xml.matchAll(/<testcase\b([^>]*)>/gi)];
  const xmlSourcePath = String(android?.xmlSourcePath || '').replaceAll('\\', '/');
  const instrumentationLaunchedAt = Number(android?.launchedAt);
  const testXmlSourceMtimeMs = Number(android?.xmlSourceMtimeMs);
  if (!/\btests="1"/i.test(suite) || !/\bfailures="0"/i.test(suite)
    || !/\berrors="0"/i.test(suite) || !/\bskipped="0"/i.test(suite)
    || cases.length !== 1
    || !/\bclassname="com\.siyi\.al\.execution\.YuqiVisiblePathExportTest"/i.test(cases[0][1])
    || !/\bname="exportCurrentDeviceVisiblePathArtifact"/i.test(cases[0][1])
    || /<skipped\b|<failure\b|<error\b/i.test(xml)
    || (android.xmlFileCount != null && android.xmlFileCount !== 1)
    || !/^android\/app\/build\/outputs\/androidTest-results\/connected\/debug\/(?:[^/]+\/)*TEST-[^/]+\.xml$/i
      .test(xmlSourcePath)
    || xmlSourcePath.split('/').includes('..')
    || !Number.isSafeInteger(instrumentationLaunchedAt)
    || !Number.isSafeInteger(testXmlSourceMtimeMs)
    || instrumentationLaunchedAt < completedAt
    || testXmlSourceMtimeMs < instrumentationLaunchedAt) {
    fail('Android instrumentation XML is not one fresh passed result');
  }
  const testXmlSha256 = sha256Bytes(Buffer.from(xml, 'utf8'));
  const xmlSourceBytes = readVerifiedInstrumentationXmlSource(
    deps.repoRoot, xmlSourcePath, testXmlSourceMtimeMs, testXmlSha256);
  writeExclusive(paths.androidXml, xmlSourceBytes, deps.fsApi, paths.scope);
  const androidPullRequest = {
    kind: 'android-pull', runId: start.runId, candidateReleaseId: start.candidateReleaseId,
    deviceSerial: start.deviceSerial, sourceHead: start.sourceHead,
    command: deps.adbExecutable,
    args: ['-s', start.deviceSerial, 'exec-out', 'run-as', 'com.siyi.al', 'cat', appOutput]
  };
  const androidPullCommandDescriptor = commandDescriptor(androidPullRequest);
  const pulled = await deps.runner.run(androidPullRequest);
  if (pulled?.exitCode !== 0 || !Buffer.isBuffer(pulled?.bytes)) fail('Android pull failed');
  assertProducerMetadata(parseFirstJsonl(pulled.bytes, 'Android'), start, completedAt, 'Android');
  writeExclusive(paths.android, pulled.bytes, deps.fsApi, paths.scope);

  const runtimeDatabaseSha256BeforePc = String(await deps.runtimeDatabase.getSha256());
  if (!HEX64.test(runtimeDatabaseSha256BeforePc)) fail('PC source database identity');

  const pcRequest = {
    kind: 'pc-export', runId: start.runId, candidateReleaseId: start.candidateReleaseId,
    deviceSerial: start.deviceSerial, sourceHead: start.sourceHead,
    runtimeDatabasePathHash: start.runtimeDatabasePathHash, outputPath: paths.pc,
    command: process.execPath,
    args: [
      join(deps.repoRoot, 'scripts', 'export-yuqi-visible-path-pc.mjs'),
      '--database', resolve(options.runtimeDatabasePath), '--out', paths.pc,
      '--candidate-release-id', start.candidateReleaseId,
      '--candidate-release-checksum', start.candidateReleaseChecksum,
      '--source-head', start.sourceHead, '--run-id', start.runId,
      '--started-at', String(start.startedAt), '--completed-at', String(completedAt)
    ]
  };
  const pc = await deps.runner.run(pcRequest);
  if (pc?.exitCode !== 0) fail('PC exporter failed');
  const pcBytes = Buffer.isBuffer(pc?.bytes) ? pc.bytes
    : deps.fsApi.existsSync(paths.pc) ? Buffer.from(deps.fsApi.readFileSync(paths.pc)) : null;
  if (!pcBytes) fail('PC exporter output missing');
  assertProducerMetadata(parseFirstJsonl(pcBytes, 'PC'), start, completedAt, 'PC');
  if (!deps.fsApi.existsSync(paths.pc)) writeExclusive(paths.pc, pcBytes, deps.fsApi, paths.scope);
  const pcMetadata = parseFirstJsonl(pcBytes, 'PC');
  const rawSourceDatabaseSha256 = String(pcMetadata?.producerAttestation?.sourceDatabaseSha256 || '');
  const runtimeDatabaseSha256AfterPc = String(await deps.runtimeDatabase.getSha256());
  if (!HEX64.test(rawSourceDatabaseSha256)
    || String(pc.sourceDatabaseSha256 || '') !== rawSourceDatabaseSha256
    || runtimeDatabaseSha256BeforePc !== rawSourceDatabaseSha256
    || runtimeDatabaseSha256AfterPc !== rawSourceDatabaseSha256) {
    fail('PC source database identity drift');
  }

  const androidCommandDescriptor = commandDescriptor(androidRequest);
  const pcCommandDescriptor = commandDescriptor(pcRequest);
  const attestationBase = {
    schemaVersion: 'yuqi-v3-visible-path-collection-v1', runId: start.runId,
    sourceHead: start.sourceHead, candidateReleaseId: start.candidateReleaseId,
    candidateReleaseChecksum: start.candidateReleaseChecksum, deviceSerial: start.deviceSerial,
    startedAt: start.startedAt, completedAt,
    android: {
      producer: 'android_instrumentation_export_v1', deviceSerial: start.deviceSerial,
      exitCode: android.exitCode, commandDescriptor: androidCommandDescriptor,
      commandChecksum: sha256(androidCommandDescriptor),
      pullCommandDescriptor: androidPullCommandDescriptor,
      pullCommandChecksum: sha256(androidPullCommandDescriptor), pullExitCode: pulled.exitCode,
      instrumentationLaunchedAt, testXmlSourceMtimeMs, testXmlSourcePath: xmlSourcePath,
      testXmlSha256, outputSha256: sha256Bytes(pulled.bytes),
      startControlChecksum: start.checksum
    },
    pc: {
      producer: 'pc_readonly_export_command_v1', exitCode: pc.exitCode,
      commandDescriptor: pcCommandDescriptor, commandChecksum: sha256(pcCommandDescriptor),
      outputSha256: sha256Bytes(pcBytes), readOnly: true,
      sourceDatabaseSha256: rawSourceDatabaseSha256
    }
  };
  const collectionAttestation = { ...attestationBase, checksum: sha256(attestationBase) };
  const report = generateVisiblePathMetrics({
    androidExportPath: paths.android, pcExportPath: paths.pc, outPath: paths.metrics,
    collectionAttestation
  });
  return report;
}

function materializeCollectionFailure(paths, deps) {
  if (!deps.fsApi.existsSync(paths.start) || deps.fsApi.existsSync(paths.failure)
    || deps.fsApi.existsSync(paths.metrics)) return;
  let start;
  try {
    start = validateVisiblePathStartControl(JSON.parse(deps.fsApi.readFileSync(paths.start, 'utf8')));
  } catch {
    return;
  }
  const fileChecksum = path => deps.fsApi.existsSync(path)
    ? sha256Bytes(Buffer.from(deps.fsApi.readFileSync(path))) : null;
  const base = {
    schemaVersion: 'yuqi-v3-visible-path-collection-failure-v1',
    status: 'blocked', errorCode: 'FORMAL_VISIBLE_PATH_COLLECTION_FAILED',
    runId: start.runId, startControlChecksum: start.checksum,
    failedAt: Date.now(),
    androidTestXmlSha256: fileChecksum(paths.androidXml),
    androidOutputSha256: fileChecksum(paths.android),
    pcOutputSha256: fileChecksum(paths.pc)
  };
  writeExclusive(paths.failure, `${JSON.stringify({ ...base, checksum: sha256(base) }, null, 2)}\n`, deps.fsApi,
    paths.scope);
}

export async function finalizeVisiblePathCollection(options = {}) {
  const paths = pathsFor(options);
  const deps = dependencies(options);
  try {
    return await finalizeVisiblePathCollectionInternal(options, paths, deps);
  } catch (error) {
    materializeCollectionFailure(paths, deps);
    throw error;
  }
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) fail(`${name} required`);
  return process.argv[index + 1];
}

export function loadVisiblePathProductionInputs({ evidenceDir, runtimeConfig, repoRoot }) {
  const configPath = resolve(runtimeConfig);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const runtimeRoot = join(repoRoot, 'yuqi-runtime');
  if (typeof config.databasePath !== 'string' || !config.databasePath.trim()) fail('runtime config databasePath required');
  const runtimeDatabasePath = /^[A-Za-z]:[\\/]|^\//.test(config.databasePath)
    ? resolve(config.databasePath) : resolve(runtimeRoot, config.databasePath);
  assertRuntimeDatabaseSnapshotReady(runtimeDatabasePath);
  const qualityPath = join(resolve(evidenceDir), 'quality-report.json');
  const quality = JSON.parse(readFileSync(qualityPath, 'utf8'));
  const planPath = join(resolve(evidenceDir), 'quality-replay-plan.json');
  const replayPath = join(resolve(evidenceDir), 'quality-replay.jsonl');
  const manualPath = join(resolve(evidenceDir), 'quality-manual-review.jsonl');
  const candidateReleaseId = quality?.candidateRelease?.releaseId;
  const candidateReleaseChecksum = quality?.candidateRelease?.releaseChecksum;
  if (quality?.eligible !== true || typeof candidateReleaseId !== 'string' || !candidateReleaseId
    || !HEX64.test(candidateReleaseChecksum || '')) fail('validated quality candidate required');
  const planBytes = readFileSync(planPath);
  const replayBytes = readFileSync(replayPath);
  const manualBytes = readFileSync(manualPath);
  try {
    validateQualityArtifactBundle({
      plan: JSON.parse(planBytes.toString('utf8')),
      replayBytes, manualReviewBytes: manualBytes,
      candidateRelease: quality.candidateRelease,
      qualityReport: quality
    });
  } catch (error) {
    fail(`validated quality bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (quality.qualityPlanSha256 !== sha256Bytes(planBytes)
    || quality.qualityReplaySha256 !== sha256Bytes(replayBytes)
    || quality.qualityManualReviewSha256 !== sha256Bytes(manualBytes)) {
    fail('validated quality bundle checksum');
  }
  const database = new DatabaseSync(runtimeDatabasePath, { readOnly: true });
  try {
    if (Number(database.prepare('PRAGMA user_version').get()?.user_version) !== 15) fail('runtime database v15 required');
    const release = database.prepare(`
      SELECT release_checksum AS releaseChecksum
      FROM pipeline_releases
      WHERE release_id = ? AND retired_at IS NULL
    `).get(candidateReleaseId);
    if (!release || release.releaseChecksum !== candidateReleaseChecksum) fail('candidate release is not registered in runtime');
  } finally {
    database.close();
  }
  if (!HEX40.test(quality.sourceHead || '')) fail('quality source identity');
  return {
    runtimeDatabasePath, candidateReleaseId, candidateReleaseChecksum,
    expectedSourceHead: quality.sourceHead
  };
}

if (process.argv[1] && /run-yuqi-visible-path-formal\.mjs$/i.test(process.argv[1])) {
  const evidenceDir = requiredArgument('--evidence-dir');
  const runtimeConfig = requiredArgument('--runtime-config');
  const repoRoot = resolve(import.meta.dirname, '..');
  Promise.resolve().then(async () => {
    const production = loadVisiblePathProductionInputs({ evidenceDir, runtimeConfig, repoRoot });
    const options = { evidenceDir, runtimeConfig, repoRoot, ...production };
    const result = process.argv.includes('--begin')
      ? await beginVisiblePathCollection(options)
      : await finalizeVisiblePathCollection(options);
    console.log(JSON.stringify({
      phase: process.argv.includes('--begin') ? 'begin' : 'finalize',
      runId: result.runId, candidateReleaseId: result.candidateReleaseId
    }));
  }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
