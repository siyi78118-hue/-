import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const EXPECTED_ROLLOUT_KEYS = Object.freeze([
  'DIRECT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'LIFE_PLANNING'
]);

const FORMAL_CERTIFICATE_SHA256 =
  '5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return createHash('sha256').update(
    typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)
  ).digest('hex');
}

function fileSha256(filePath) {
  return contentHash(readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function safeStat(filePath) {
  if (!existsSync(filePath)) return null;
  const value = statSync(filePath);
  return {
    size: Number(value.size),
    mtimeMs: Number(value.mtimeMs),
    sha256: fileSha256(filePath)
  };
}

function databaseSourceSnapshot(databasePath) {
  return {
    main: safeStat(databasePath),
    wal: safeStat(`${databasePath}-wal`)
  };
}

function sameDatabaseSource(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function mapRollout(row) {
  return {
    rolloutKey: row.rollout_key,
    currentMode: row.current_mode,
    rolloutPhase: row.rollout_phase,
    revision: Number(row.revision),
    presetVersion: row.preset_version,
    pipelineChecksum: row.pipeline_checksum,
    evidenceEpoch: Number(row.evidence_epoch),
    liveShadowSuccessCount: Number(row.live_shadow_success_count),
    liveShadowFailureCount: Number(row.live_shadow_failure_count),
    canaryStartedCount: Number(row.canary_started_count),
    canaryCompletedCount: Number(row.canary_completed_count),
    canaryFailureCount: Number(row.canary_failure_count)
  };
}

function countStructuralTables(database) {
  const tables = [
    'messages',
    'facts',
    'relationship_states',
    'relationship_history',
    'role_plans',
    'life_episodes',
    'turns',
    'result_outbox'
  ];
  const existing = new Set(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map(row => row.name));
  return Object.fromEntries(tables.map(name => [
    name,
    existing.has(name)
      ? Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count)
      : null
  ]));
}

function inspectRuntimeDatabase(configPath) {
  const config = readJson(configPath);
  const databasePath = resolve(String(config.databasePath || ''));
  if (!databasePath || !existsSync(databasePath)) {
    return {
      pathHash: contentHash(databasePath),
      exists: false,
      sha256: '',
      sourceBundleSha256: '',
      userVersion: 0,
      rollouts: [],
      structuralCounts: {},
      sourceChangedDuringAudit: false
    };
  }

  const before = databaseSourceSnapshot(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let userVersion;
  let rollouts;
  let structuralCounts;
  try {
    userVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
    const hasRollouts = Boolean(database.prepare(`
      SELECT 1 AS value FROM sqlite_master
      WHERE type = 'table' AND name = 'cognition_kind_rollouts'
    `).get());
    rollouts = hasRollouts
      ? database.prepare('SELECT * FROM cognition_kind_rollouts ORDER BY rollout_key').all().map(mapRollout)
      : [];
    structuralCounts = countStructuralTables(database);
  } finally {
    database.close();
  }
  const after = databaseSourceSnapshot(databasePath);
  const sourceBundle = {
    mainSha256: after.main?.sha256 || '',
    walSha256: after.wal?.sha256 || ''
  };
  return {
    pathHash: contentHash(databasePath),
    exists: true,
    sha256: after.main?.sha256 || '',
    sourceBundleSha256: contentHash(sourceBundle),
    userVersion,
    rollouts,
    structuralCounts,
    sourceChangedDuringAudit: !sameDatabaseSource(before, after)
  };
}

function parseGradleVersion(rootDir) {
  const text = readFileSync(join(rootDir, 'android', 'app', 'build.gradle'), 'utf8');
  const code = text.match(/\bversionCode[^\r\n]*["'](\d+)["']/);
  const name = text.match(/\bversionName[^\r\n]*["'](\d+\.\d+\.\d+)["']/);
  if (!code || !name) throw new Error('unable to parse Android Gradle version');
  return { versionCode: Number(code[1]), versionName: name[1] };
}

function parseWorkflowVersion(rootDir) {
  const text = readFileSync(join(rootDir, '.github', 'workflows', 'android-apk.yml'), 'utf8');
  const code = text.match(/AL_RELEASE_VERSION_CODE:\s*(\d+)/);
  const name = text.match(/AL_RELEASE_VERSION_NAME:\s*([0-9.]+)/);
  if (!code || !name) throw new Error('unable to parse Android workflow version');
  return { versionCode: Number(code[1]), versionName: name[1] };
}

function parseCheckedManifestVersion(rootDir) {
  const value = readJson(join(rootDir, 'android-update.json'));
  return {
    versionCode: Number(value.latestBuild),
    versionName: String(value.version || ''),
    releaseUrl: String(value.releaseUrl || '')
  };
}

function findAndroidTool(name) {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdkRoot) return null;
  const buildToolsRoot = join(sdkRoot, 'build-tools');
  if (!existsSync(buildToolsRoot)) return null;
  const versions = readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    for (const suffix of process.platform === 'win32' ? ['.bat', '.exe', ''] : ['']) {
      const candidate = join(buildToolsRoot, version, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function runTool(toolPath, args) {
  const isBatch = process.platform === 'win32' && toolPath.toLowerCase().endsWith('.bat');
  const batchJar = isBatch ? join(dirname(toolPath), 'lib', 'apksigner.jar') : null;
  const command = isBatch && existsSync(batchJar)
    ? (process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java')
    : toolPath;
  const commandArgs = isBatch && existsSync(batchJar) ? ['-jar', batchJar, ...args] : args;
  const result = spawnSync(
    command,
    commandArgs,
    { encoding: 'utf8', windowsHide: true }
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim()
  };
}

function inspectFormalArtifacts(rootDir) {
  const artifactsDir = join(rootDir, 'artifacts');
  const aapt = findAndroidTool('aapt');
  const apksigner = findAndroidTool('apksigner');
  if (!existsSync(artifactsDir) || !aapt || !apksigner) {
    return {
      artifacts: [],
      toolsAvailable: Boolean(aapt && apksigner),
      inspectionErrors: ['ANDROID_ARTIFACT_DIRECTORY_OR_TOOL_MISSING']
    };
  }
  const artifacts = [];
  const inspectionErrors = [];
  for (const name of readdirSync(artifactsDir)
    .filter(value => /^AL-\d+\.\d+\.\d+-release\.apk$/.test(value))
    .sort()) {
    const filePath = join(artifactsDir, name);
    const badging = runTool(aapt, ['dump', 'badging', filePath]);
    const signature = runTool(apksigner, ['verify', '--verbose', '--print-certs', filePath]);
    if (!badging.ok || !signature.ok) {
      inspectionErrors.push(`${name}:${!badging.ok ? 'BADGING_FAILED' : 'SIGNATURE_FAILED'}`);
      continue;
    }
    const packageMatch = badging.output.match(
      /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/
    );
    const certificateMatch = signature.output.match(
      /Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)/i
    );
    const signerMatch = signature.output.match(/Number of signers:\s*(\d+)/i);
    if (!packageMatch || !certificateMatch || !signerMatch) {
      inspectionErrors.push(`${name}:UNPARSEABLE_VERIFICATION`);
      continue;
    }
    if (packageMatch[1] !== 'com.siyi.al'
      || certificateMatch[1].toLowerCase() !== FORMAL_CERTIFICATE_SHA256
      || Number(signerMatch[1]) !== 1) {
      inspectionErrors.push(`${name}:NOT_FORMAL_IDENTITY`);
      continue;
    }
    artifacts.push({
      fileName: name,
      versionCode: Number(packageMatch[2]),
      versionName: packageMatch[3],
      packageName: packageMatch[1],
      certificateSha256: certificateMatch[1].toLowerCase(),
      sha256: fileSha256(filePath)
    });
  }
  return { artifacts, toolsAvailable: true, inspectionErrors };
}

function readSourceVersions(rootDir) {
  const gradle = parseGradleVersion(rootDir);
  const workflow = parseWorkflowVersion(rootDir);
  const checkedManifest = parseCheckedManifestVersion(rootDir);
  return {
    gradle,
    workflow,
    checkedManifest,
    maximumCode: Math.max(gradle.versionCode, workflow.versionCode, checkedManifest.versionCode)
  };
}

function readFeatureMatrix(rootDir, rollouts) {
  const matrixPath = join(rootDir, 'tests', 'fixtures', 'yuqi-cognition-feature-matrix.json');
  const matrix = existsSync(matrixPath) ? readJson(matrixPath) : { turnKinds: {} };
  const rolloutKeys = new Set(rollouts.map(row => row.rolloutKey));
  return Object.fromEntries(EXPECTED_ROLLOUT_KEYS.map(key => [
    key,
    {
      enabled: rolloutKeys.has(key),
      matrixDefined: key === 'LIFE_PLANNING' || Boolean(matrix.turnKinds?.[key]),
      requiredContextCount: Array.isArray(matrix.turnKinds?.[key]?.requiredContext)
        ? matrix.turnKinds[key].requiredContext.length
        : 0
    }
  ]));
}

function resolveVisibleStableEvidence({ rootDir, database, configPath }) {
  const presetManifestPath = join(rootDir, 'yuqi-runtime', 'presets', 'manifest.json');
  const presetManifest = readJson(presetManifestPath);
  const config = readJson(configPath);
  const visibleByKind = database.rollouts.map(row => ({
    rolloutKey: row.rolloutKey,
    visiblePipeline: row.currentMode === 'active' ? 'cognition' : 'legacy',
    presetVersion: row.currentMode === 'active'
      ? row.presetVersion
      : presetManifest.currentVersion,
    rolloutPipelineChecksum: row.pipelineChecksum,
    rolloutRevision: row.revision
  }));
  const releaseManifest = {
    kind: 'synthetic_immutable_visible_baseline',
    presetManifestSha256: fileSha256(presetManifestPath),
    currentPresetVersion: presetManifest.currentVersion,
    candidatePresetVersion: presetManifest.candidateVersion || null,
    modelProfilesChecksum: contentHash(config.roleProfiles || {}),
    visibleByKind
  };
  const pipelineChecksum = contentHash(releaseManifest);
  return {
    releaseId: `release_baseline_${pipelineChecksum.slice(0, 24)}`,
    pipelineChecksum,
    releaseManifest
  };
}

function validateBaseline({
  database,
  stableEvidence,
  sourceVersions,
  formalArtifacts,
  features
}) {
  const reasons = [];
  if (!database.exists) reasons.push('DATABASE_NOT_FOUND');
  if (database.userVersion !== 9) reasons.push(`DATABASE_USER_VERSION_${database.userVersion}_NOT_9`);
  if (database.sourceChangedDuringAudit) reasons.push('DATABASE_CHANGED_DURING_AUDIT');
  const actualKeys = database.rollouts.map(row => row.rolloutKey).sort();
  const expectedKeys = [...EXPECTED_ROLLOUT_KEYS].sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)) {
    reasons.push('ROLLOUT_KEY_SET_INCOMPLETE');
  }
  if (database.rollouts.some(row => !/^[a-f0-9]{64}$/i.test(row.pipelineChecksum))) {
    reasons.push('ROLLOUT_PIPELINE_CHECKSUM_INVALID');
  }
  if (!stableEvidence.releaseId
    || !/^[a-f0-9]{64}$/i.test(stableEvidence.pipelineChecksum)) {
    reasons.push('VISIBLE_STABLE_EVIDENCE_UNRESOLVED');
  }
  const versionPairs = [
    sourceVersions.gradle,
    sourceVersions.workflow,
    sourceVersions.checkedManifest
  ].map(value => `${value.versionCode}:${value.versionName}`);
  if (new Set(versionPairs).size !== 1) reasons.push('ANDROID_SOURCE_VERSION_DISAGREEMENT');
  if (!formalArtifacts.toolsAvailable) reasons.push('ANDROID_ARTIFACT_TOOLS_UNAVAILABLE');
  if (formalArtifacts.artifacts.length === 0) reasons.push('NO_FORMAL_SIGNED_ANDROID_ARTIFACT');
  if (formalArtifacts.artifacts.length
    && !formalArtifacts.artifacts.some(item =>
      item.versionCode === sourceVersions.maximumCode
      && item.versionName === sourceVersions.gradle.versionName)) {
    reasons.push('LATEST_SOURCE_VERSION_HAS_NO_MATCHING_FORMAL_ARTIFACT');
  }
  if (Object.values(features).some(value => !value.enabled || !value.matrixDefined)) {
    reasons.push('FEATURE_MATRIX_OR_ROLLOUT_INCOMPLETE');
  }
  return reasons;
}

function writeJsonAtomically(outPath, value) {
  mkdirSync(dirname(outPath), { recursive: true });
  const temporary = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (existsSync(outPath)) rmSync(outPath);
    renameSync(temporary, outPath);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

export async function auditBaseline({ rootDir, configPath, outPath }) {
  const resolvedRoot = resolve(rootDir);
  const resolvedConfig = resolve(configPath);
  const resolvedOut = resolve(outPath);
  const sourceVersions = readSourceVersions(resolvedRoot);
  const formalArtifactInspection = inspectFormalArtifacts(resolvedRoot);
  const database = inspectRuntimeDatabase(resolvedConfig);
  const stableEvidence = resolveVisibleStableEvidence({
    rootDir: resolvedRoot,
    database,
    configPath: resolvedConfig
  });
  const features = readFeatureMatrix(resolvedRoot, database.rollouts);
  const report = {
    schemaVersion: 1,
    createdAt: Date.now(),
    gitHead: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolvedRoot,
      encoding: 'utf8',
      windowsHide: true
    }).stdout.trim(),
    database,
    stableEvidence,
    versions: {
      ...sourceVersions,
      formalArtifacts: formalArtifactInspection.artifacts,
      artifactInspectionErrors: formalArtifactInspection.inspectionErrors,
      maximumOccupiedCode: Math.max(
        sourceVersions.maximumCode,
        ...formalArtifactInspection.artifacts.map(item => item.versionCode)
      )
    },
    features,
    rollouts: database.rollouts,
    stopReasons: []
  };
  report.stopReasons = validateBaseline({
    database,
    stableEvidence,
    sourceVersions,
    formalArtifacts: formalArtifactInspection,
    features
  });
  writeJsonAtomically(resolvedOut, report);
  return report;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const configPath = resolve(argument('--config', join(rootDir, 'yuqi-runtime', 'config.json')));
  const outPath = resolve(argument('--out', join(
    rootDir,
    'artifacts',
    'yuqi-lived-agency-v3',
    'baseline.json'
  )));
  const report = await auditBaseline({ rootDir, configPath, outPath });
  process.stdout.write(`${JSON.stringify({
    ok: report.stopReasons.length === 0,
    outPath,
    stopReasons: report.stopReasons
  })}\n`);
  if (report.stopReasons.length) process.exitCode = 1;
}
