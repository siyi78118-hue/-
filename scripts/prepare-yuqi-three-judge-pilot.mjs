// Non-model preparation entrypoint for the three-judge Yuqi pilot.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { YuqiStore } from '../yuqi-runtime/src/store.mjs';
import { PresetRegistry } from '../yuqi-runtime/src/preset-registry.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { assertVerifiedQualityReplayPlan } from '../yuqi-runtime/src/quality-replay.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';

const PRIVATE_ROOT = 'artifacts/yuqi-lived-agency-v3/private/three-judge';
const SOURCE_HEAD = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const THREE_JUDGE_STAGE_KEYS = Object.freeze({
  1: Object.freeze([
    'sentinel:first_red_packet_as_social_action:0',
    'sentinel:fourth_coquetry_test_or_pressure:0',
  ]),
  2: Object.freeze([
    'sentinel:first_scolded_by_manager:0',
    'sentinel:fourth_rejecting_insincere_comfort:0',
    'sentinel:fourth_push_away_and_want_pursuit:0',
    'coverage:second_interruption_changes_with_time__surface:0',
  ]),
  3: Object.freeze([
    'sentinel:first_initial_stage_not_fixed_coldness:0',
    'coverage:second_one_day_no_contact__delayed:0',
    'coverage:second_proactive_before_presentation__delayed:0',
    'coverage:fourth_topic_shift_meaning_split__delayed:0',
    'coverage:first_red_packet_as_social_action__feature:0',
    'coverage:fourth_coquetry_test_or_pressure__feature:0',
  ]),
});

export const STABLE_THREE_JUDGE_PROFILE = Object.freeze({
  cognitionFast: 'gpt-5.6-terra/medium',
  cognitionDeep: 'gpt-5.6-sol/medium',
  expression: 'gpt-5.6-sol/medium',
  supervisor: 'gpt-5.6-terra/medium',
});

export const CANDIDATE_THREE_JUDGE_PROFILE = Object.freeze({
  cognitionFast: 'gpt-5.6-sol/medium',
  cognitionDeep: 'gpt-5.6-sol/xhigh',
  expression: 'gpt-5.6-sol/medium',
  supervisor: 'gpt-5.6-sol/medium',
});

export function pilotLimitsForStage(stage) {
  const allowedFinalKeys = THREE_JUDGE_STAGE_KEYS[stage];
  if (!allowedFinalKeys) throw new Error('three-judge stage conflict');
  return Object.freeze({
    allowedFinalKeys: [...allowedFinalKeys],
    maxModelCallsPerFinal: 32,
    maxModelCallOrdinalPerPhase: 15,
    maxTotalModelCalls: allowedFinalKeys.length * 32,
    maxWallClockMs: 2_700_000,
    usageStatus: 'unobservable',
  });
}

export function assertStageSelection(stage, finalKeys) {
  const expected = THREE_JUDGE_STAGE_KEYS[stage];
  if (!expected || !Array.isArray(finalKeys)
    || finalKeys.length !== expected.length
    || finalKeys.some((key, index) => key !== expected[index])) {
    throw new Error('three-judge stage selection conflict');
  }
  return true;
}

export function buildThreeJudgeLaneDefinitions({ rootDir, codexCommand }) {
  if (typeof rootDir !== 'string' || !rootDir || typeof codexCommand !== 'string' || !codexCommand) {
    throw new Error('three-judge lane input conflict');
  }
  const lane = (name, modelProfile, kind) => Object.freeze({
    version: 1,
    lane: name,
    command: codexCommand,
    args: ['app-server'],
    cwd: rootDir,
    env: {},
    clientInfo: { protocol: 'codex-app-server-v1' },
    requestTimeoutMs: 30_000,
    turnTimeoutMs: 300_000,
    maxRoleTurns: 8,
    sessionStorePath: `artifacts/yuqi-lived-agency-v3/private/three-judge/sessions/${name}.sqlite`,
    sessionNamespace: `quality/three-judge/stage-1/${name}`,
    modelProfile,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    schema: { version: 1, kind },
  });
  return Object.freeze({
    stable_execution: lane('stable_execution', STABLE_THREE_JUDGE_PROFILE, 'production_execution'),
    candidate_execution: lane('candidate_execution', CANDIDATE_THREE_JUDGE_PROFILE, 'production_execution'),
    evaluator_primary: lane('evaluator_primary', 'gpt-5.6-sol/medium', 'blind_evaluation'),
    evaluator_secondary: lane('evaluator_secondary', 'gpt-5.6-terra/high', 'blind_evaluation'),
  });
}

export function buildPilotMaterialManifest({
  rootDir, codexCommand, sourceHead, stableRelease, candidateRelease, seedDatabaseSha256,
}) {
  if (!SOURCE_HEAD.test(sourceHead) || !SHA256.test(seedDatabaseSha256)
    || !stableRelease?.releaseId || !candidateRelease?.releaseId
    || stableRelease.releaseId === candidateRelease.releaseId) {
    throw new Error('three-judge material identity conflict');
  }
  const adapterIds = {
    turn: ['legacy-v1', 'cognition-v2', 'cognition-v3'],
    life: ['legacy-v1', 'cognition-v2', 'cognition-v3'],
  };
  return Object.freeze({
    version: 1,
    sourceHead,
    runtimeConfig: {
      version: 1,
      presetDir: join(rootDir, 'yuqi-runtime', 'presets'),
      clock: 'runtime-clock-v1',
    },
    stableRelease: structuredClone(stableRelease),
    candidateRelease: structuredClone(candidateRelease),
    lanes: buildThreeJudgeLaneDefinitions({ rootDir, codexCommand }),
    stableRuntime: {
      version: 1, attestationVersion: 1, sourceHead, adapterIds,
      stableReleaseId: stableRelease.releaseId, candidateReleaseId: null,
    },
    candidateRuntime: {
      version: 1, attestationVersion: 1, sourceHead, adapterIds,
      stableReleaseId: stableRelease.releaseId, candidateReleaseId: candidateRelease.releaseId,
    },
    seedDatabasePath: `${PRIVATE_ROOT}/seed.sqlite`,
    stableDatabasePath: `${PRIVATE_ROOT}/stable.sqlite`,
    candidateDatabasePath: `${PRIVATE_ROOT}/candidate.sqlite`,
    seedDatabaseSha256,
  });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseChecksum(body) {
  return contentHash({
    pipelineVersion: body.pipelineVersion,
    presetVersion: body.presetVersion,
    cognitionSchemaVersion: body.cognitionSchemaVersion,
    expressionSchemaVersion: body.expressionSchemaVersion,
    evaluatorVersion: body.evaluatorVersion,
    modelProfile: body.modelProfile,
    componentManifest: body.componentManifest,
    createdAt: body.createdAt,
  });
}

function releaseSnapshot(row) {
  return {
    releaseId: row.releaseId,
    pipelineVersion: row.pipelineVersion,
    presetVersion: row.presetVersion,
    cognitionSchemaVersion: row.cognitionSchemaVersion,
    expressionSchemaVersion: row.expressionSchemaVersion,
    evaluatorVersion: row.evaluatorVersion,
    modelProfile: structuredClone(row.modelProfile),
    componentManifest: structuredClone(row.componentManifest),
    releaseChecksum: row.releaseChecksum,
    createdAt: row.createdAt,
    retiredAt: row.retiredAt,
  };
}

function removeDatabaseSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
}

export function prepareThreeJudgePilotMaterials({ rootDir, planSourcePath, codexCommand }) {
  const root = resolve(rootDir);
  const sourceHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  }).trim().toLowerCase();
  if (!SOURCE_HEAD.test(sourceHead)) throw new Error('three-judge source HEAD conflict');
  try {
    execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    throw new Error('three-judge source checkout must be detached');
  } catch (error) {
    if (error?.message === 'three-judge source checkout must be detached' || error?.status !== 1) throw error;
  }
  const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (status.trim()) throw new Error('three-judge source checkout must be clean before preparation');

  const privateRoot = join(root, ...PRIVATE_ROOT.split('/'));
  mkdirSync(privateRoot, { recursive: true });
  const planPath = join(privateRoot, 'quality-replay-plan.json');
  copyFileSync(resolve(planSourcePath), planPath);
  const plan = assertVerifiedQualityReplayPlan(JSON.parse(readFileSync(planPath, 'utf8')));
  assertStageSelection(1, THREE_JUDGE_STAGE_KEYS[1]);
  for (const key of THREE_JUDGE_STAGE_KEYS[1]) {
    if (!plan.items.some(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}` === key)) {
      throw new Error('three-judge selected question missing from verified plan');
    }
  }

  const seedPath = join(privateRoot, 'seed.sqlite');
  const stablePath = join(privateRoot, 'stable.sqlite');
  const candidatePath = join(privateRoot, 'candidate.sqlite');
  for (const path of [seedPath, stablePath, candidatePath]) {
    rmSync(path, { force: true });
    removeDatabaseSidecars(path);
  }

  const store = new YuqiStore(seedPath);
  let stableRelease;
  let candidateRelease;
  try {
    const presets = new PresetRegistry({
      presetDir: join(root, 'yuqi-runtime', 'presets'), store, clock: () => 1,
    });
    const promotion = new PromotionController({ store, presetRegistry: presets, clock: () => 1 });
    promotion.initialize();
    const baseline = store.listPipelineReleases()
      .find(row => row.pipelineVersion === 'stable-visible-baseline-2026-07-30');
    if (!baseline) throw new Error('three-judge stable baseline unavailable');

    const stableManifest = presets.pipelineReleaseManifest('1.9.2', baseline.releaseId, {
      modelProfile: STABLE_THREE_JUDGE_PROFILE,
      cognitionSchemaVersion: 1,
      expressionSchemaVersion: 1,
      evaluatorVersion: 'legacy-supervisor-v1',
    });
    const stableBody = {
      pipelineVersion: 'stable-visible-baseline-2026-07-30',
      presetVersion: '1.9.2',
      cognitionSchemaVersion: 1,
      expressionSchemaVersion: 1,
      evaluatorVersion: 'legacy-supervisor-v1',
      modelProfile: STABLE_THREE_JUDGE_PROFILE,
      componentManifest: stableManifest.components,
      createdAt: baseline.createdAt + 1,
      retiredAt: null,
    };
    const stableChecksum = releaseChecksum(stableBody);
    stableRelease = releaseSnapshot(store.putPipelineReleaseInternal({
      ...stableBody,
      releaseId: `quality_stable_${stableChecksum.slice(0, 16)}`,
      releaseChecksum: stableChecksum,
    }));

    store.setCurrentPresetVersion('2.1.0');
    const candidateManifest = presets.pipelineReleaseManifest('2.1.0', stableRelease.releaseId, {
      modelProfile: CANDIDATE_THREE_JUDGE_PROFILE,
      cognitionSchemaVersion: 3,
      expressionSchemaVersion: 3,
      evaluatorVersion: 'lived-quality-supervisor-v3',
    });
    const candidateBody = {
      pipelineVersion: 'yuqi-lived-agency-v3',
      presetVersion: '2.1.0',
      cognitionSchemaVersion: 3,
      expressionSchemaVersion: 3,
      evaluatorVersion: 'lived-quality-supervisor-v3',
      modelProfile: CANDIDATE_THREE_JUDGE_PROFILE,
      componentManifest: candidateManifest.components,
      createdAt: stableBody.createdAt + 1,
      retiredAt: null,
    };
    const candidateChecksum = releaseChecksum(candidateBody);
    candidateRelease = releaseSnapshot(store.putPipelineReleaseInternal({
      ...candidateBody,
      releaseId: `quality_candidate_${candidateChecksum.slice(0, 16)}`,
      releaseChecksum: candidateChecksum,
    }));

    const rollout = promotion.getStatus('DIRECT_REPLY');
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET stable_release_id=?, candidate_release_id=?, current_mode='active', candidate_phase='none',
          pipeline_checksum=?, preset_version=?
      WHERE rollout_key='DIRECT_REPLY' AND revision=?
    `).run(
      stableRelease.releaseId,
      candidateRelease.releaseId,
      presets.evidenceManifest('DIRECT_REPLY').checksum,
      candidateRelease.presetVersion,
      rollout.revision,
    );
  } finally {
    store.close();
  }
  copyFileSync(seedPath, stablePath);
  copyFileSync(seedPath, candidatePath);
  for (const path of [seedPath, stablePath, candidatePath]) removeDatabaseSidecars(path);

  const manifest = buildPilotMaterialManifest({
    rootDir: root,
    codexCommand: resolve(codexCommand),
    sourceHead,
    stableRelease,
    candidateRelease,
    seedDatabaseSha256: sha256(readFileSync(seedPath)),
  });
  const materialPath = join(privateRoot, 'quality-production-config.json');
  writeFileSync(materialPath, JSON.stringify(manifest));
  return Object.freeze({
    sourceHead,
    planChecksum: plan.planChecksum,
    stage: 1,
    finalKeys: [...THREE_JUDGE_STAGE_KEYS[1]],
    planPath,
    materialPath,
    ledgerPath: join(privateRoot, 'quality-replay-state.sqlite'),
    limits: pilotLimitsForStage(1),
  });
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--root', '--plan-source', '--codex-command'].includes(key) || !value) {
      throw new Error('three-judge preparer arguments conflict');
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) throw new Error('three-judge preparer arguments required');
  return values;
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const cli = parseCli(process.argv.slice(2));
    const result = prepareThreeJudgePilotMaterials({
      rootDir: cli['--root'],
      planSourcePath: cli['--plan-source'],
      codexCommand: cli['--codex-command'],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  }
}
