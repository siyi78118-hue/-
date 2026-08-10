import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { compileQualitySuite } from './compile-yuqi-lived-quality-scenes.mjs';
import {
  buildVerifiedQualityReplayPlan,
  assertVerifiedQualityReplayPlan,
  appendQualityAttempt,
  writeQualityReplayPlanArtifact,
  loadQualityReplayPlanArtifact
} from '../yuqi-runtime/src/quality-replay.mjs';
import {
  compileSceneExecutionInput,
  normalizeBlindEvaluation,
  projectBlindEvaluationInput,
  runScenePair
} from '../yuqi-runtime/src/quality-evaluator.mjs';
import { evaluatePipelineComparison } from '../yuqi-runtime/src/comparison-evaluator.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { ReleaseExecutor } from '../yuqi-runtime/src/release-executor.mjs';

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readJsonLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

export function createQualityReplayPlan({ rootDir = process.cwd(), historyScenes, historyManifest } = {}) {
  if (!Array.isArray(historyScenes) || historyScenes.length !== 30) {
    throw new Error('quality replay requires exactly 30 local history scenes');
  }
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  return buildVerifiedQualityReplayPlan({
    compiledSuite: suite,
    historyScenes,
    historyManifest
  });
}

export function loadLocalHistoryScenes({ rootDir = process.cwd(), path } = {}) {
  const historyPath = path || resolve(rootDir, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl');
  if (!existsSync(historyPath)) throw new Error(`local history scenes not found: ${historyPath}`);
  const raw = readFileSync(historyPath, 'utf8');
  const scenes = raw.trimStart().startsWith('[') ? JSON.parse(raw) : readJsonLines(historyPath);
  if (scenes.length !== 30) throw new Error('local history scene count must be 30');
  return scenes;
}

export function loadLocalHistoryManifest({ rootDir = process.cwd(), path } = {}) {
  const manifestPath = path || resolve(
    rootDir,
    'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.manifest.json'
  );
  if (!existsSync(manifestPath)) throw new Error(`local history manifest not found: ${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function captureCleanSourceHead({ rootDir = process.cwd() } = {}) {
  let status;
  let sourceHead;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: rootDir, encoding: 'utf8'
    });
    sourceHead = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: rootDir, encoding: 'utf8'
    }).trim();
  } catch (error) {
    throw new Error(`quality source identity unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status.trim()) throw new Error('quality source tree is dirty');
  if (!/^[0-9a-f]{40}$/.test(sourceHead)) throw new Error('quality source HEAD invalid');
  return sourceHead;
}

export async function runQualityReplayPlan({
  plan,
  releasePair,
  executor,
  evaluator,
  evaluatorSecondary = null,
  evaluatorVersion = 'blind-evaluator-v1',
  secondaryEvaluatorVersion = 'blind-evaluator-v1b',
  maxItems = null,
  onSideEffect = () => {},
  now = () => Date.now(),
  sourceRootDir = process.cwd()
} = {}) {
  const verifiedPlan = assertVerifiedQualityReplayPlan(plan);
  const sourceHead = captureCleanSourceHead({ rootDir: sourceRootDir });
  const runId = randomUUID();
  if (typeof evaluator !== 'function') throw new Error('blind evaluator required');
  const items = maxItems == null ? verifiedPlan.items : verifiedPlan.items.slice(0, maxItems);
  if (!items.length) throw new Error('quality replay plan required');
  const attempts = [];
  const finalized = [];
  const pairRecords = [];
  const executionPairs = [];
  const modelRuns = [];
  for (const item of items) {
    const execution = compileSceneExecutionInput(item.scene);
    const pairRecord = await runScenePair(execution, { ...releasePair, executor });
    pairRecords.push(pairRecord);
    const evaluationSeed = Number.parseInt(contentHash({
      sceneId: item.sceneId,
      repeatIndex: item.repeatIndex
    }).slice(0, 12), 16);
    const sceneAnnotation = {
      sceneId: item.sceneId,
      severity: item.scene.severity,
      focus: item.scene.focus,
      turns: item.scene.turns,
      requiredChecks: item.scene.mustNotice || [],
      allowedVariation: item.scene.allowedPersonalityVariation || []
    };
    const blindInput = projectBlindEvaluationInput({
      sceneId: item.sceneId,
      repeatIndex: item.repeatIndex,
      evaluationSeed,
      sceneAnnotation,
      stable: { output: pairRecord.stable.draft?.output || pairRecord.stable.draft || {} },
      candidate: { output: pairRecord.candidate.draft?.output || pairRecord.candidate.draft || {} }
    }, { seed: evaluationSeed });
    const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
    executionPairs.push({
      finalKey,
      sourceHead,
      stableReleaseId: pairRecord.stable.releaseId,
      stableReleaseChecksum: pairRecord.stable.releaseChecksum,
      candidateReleaseId: pairRecord.candidate.releaseId,
      candidateReleaseChecksum: pairRecord.candidate.releaseChecksum,
      executionChecksum: pairRecord.executionChecksum,
      stableInputChecksum: pairRecord.stableInputChecksum,
      candidateInputChecksum: pairRecord.candidateInputChecksum,
      dryRun: true,
      capabilities: { visible: false, actions: false }
    });
    const evaluationStartedAt = now();
    const [primaryRaw, secondaryRaw] = await Promise.all([
      evaluator(blindInput),
      evaluatorSecondary ? evaluatorSecondary(blindInput) : Promise.resolve(null)
    ]);
    const evaluation = normalizeBlindEvaluation(await primaryRaw);
    const secondaryEvaluation = secondaryRaw === null
      ? null
      : normalizeBlindEvaluation(await secondaryRaw);
    const primaryCritical = new Map(evaluation.findings
      .filter(finding => finding.critical === true || finding.severity === 'critical')
      .map(finding => [`${finding.code}:${finding.severity}`, finding]));
    const secondaryCritical = new Map((secondaryEvaluation?.findings || [])
      .filter(finding => finding.critical === true || finding.severity === 'critical')
      .map(finding => [`${finding.code}:${finding.severity}`, finding]));
    const disagreement = secondaryEvaluation !== null
      && [...new Set([...primaryCritical.keys(), ...secondaryCritical.keys()])]
        .some(key => !primaryCritical.has(key) || !secondaryCritical.has(key));
    const severeWithoutIndependentAgreement = (primaryCritical.size > 0 || secondaryCritical.size > 0)
      && (secondaryEvaluation === null || disagreement);
    const agreedCritical = [...primaryCritical.entries()]
      .filter(([key]) => secondaryCritical.has(key))
      .map(([, finding]) => finding);
    const evaluationFindings = [
      ...evaluation.findings.filter(finding => finding.critical !== true && finding.severity !== 'critical'),
      ...agreedCritical
    ];
    if (severeWithoutIndependentAgreement) {
      evaluationFindings.push({
        code: 'BLIND_EVALUATION_DISAGREEMENT',
        severity: 'critical',
        owner: 'blind-evaluator-v1',
        summary: 'independent blind evaluator disagreement',
        critical: true
      });
    }
    const latencyMs = Math.max(0, now() - evaluationStartedAt);
    modelRuns.push({
      finalKey,
      attemptIndex: 0,
      evaluatorId: evaluatorVersion,
      inputChecksum: contentHash(blindInput),
      completed: true
    });
    if (secondaryEvaluation) {
      modelRuns.push({
        finalKey,
        attemptIndex: 1,
        evaluatorId: secondaryEvaluatorVersion,
        inputChecksum: contentHash(blindInput),
        completed: true
      });
    }
    const stableOutput = pairRecord.stable.draft?.output || pairRecord.stable.draft || {};
    const candidateOutput = pairRecord.candidate.draft?.output || pairRecord.candidate.draft || {};
    const lastUserTurn = [...(item.scene.turns || [])]
      .reverse().find(turn => turn?.speaker === 'user');
    const comparison = evaluatePipelineComparison({
      subjectType: 'turn',
      subject: { kind: item.scene.rolloutKey },
      authoritativeResult: stableOutput,
      comparisonResult: candidateOutput,
      currentBatch: {
        messageIds: (lastUserTurn?.batch || [])
          .map(message => message?.messageId)
          .filter(id => typeof id === 'string' && id)
      },
      scene: {
        allowedStageTransitions: item.scene.expectedStateTransitions?.allow || [],
        privateValues: []
      },
      allowedActionTargets: []
    });
    const comparisonFindings = comparison.criticalFindings.map(finding => ({
      code: finding.code,
      severity: 'critical',
      owner: 'comparison-evaluator-v1',
      summary: finding.code,
      critical: true
    }));
    const findings = [...evaluationFindings, ...comparisonFindings];
    const unresolved = evaluation.unresolved || severeWithoutIndependentAgreement;
    const attempt = {
      layer: item.layer,
      sceneId: item.sceneId,
      repeatIndex: item.repeatIndex,
      attemptIndex: 0,
      evaluatorId: evaluatorVersion,
      evaluatorVersion,
      executionChecksum: pairRecord.executionChecksum,
      latencyMs,
      accepted: unresolved !== true,
      unresolved
    };
    appendQualityAttempt(attempts, attempt);
    finalized.push({
      layer: item.layer,
      sceneId: item.sceneId,
      repeatIndex: item.repeatIndex,
      finalized: unresolved !== true,
      scores: evaluation.scores,
      preference: evaluation.preference,
      findings,
      regression: false,
      severe: comparisonFindings.some(finding => finding.critical),
      tie: evaluation.preference === 'tie',
      unresolved,
      structuralRegression: false,
      protocolFailure: comparisonFindings.length > 0,
      executionChecksum: pairRecord.executionChecksum,
      latencyMs,
      evaluatorVersion,
      attempts: [attempt]
    });
  }
  const endingSourceHead = captureCleanSourceHead({ rootDir: sourceRootDir });
  if (endingSourceHead !== sourceHead) {
    throw new Error('quality source identity changed during replay');
  }
  const replayProvenance = { runId, sourceHead, executionPairs, modelRuns };
  return {
    runId,
    finalized,
    attempts,
    pairRecords,
    replayProvenance: {
      ...replayProvenance,
      provenanceChecksum: contentHash(replayProvenance)
    },
    sentinelRuns: finalized.filter(row => row.layer === 'sentinel'),
    coverageRuns: finalized.filter(row => row.layer === 'coverage'),
    historyRuns: finalized.filter(row => row.layer === 'history')
  };
}

export function appendQualityReplayArtifact({ artifactPath, result } = {}) {
  if (typeof artifactPath !== 'string' || !artifactPath) throw new Error('replay artifact path required');
  if (!result || !Array.isArray(result.attempts) || !Array.isArray(result.finalized)
    || !result.replayProvenance
    || !Array.isArray(result.replayProvenance.executionPairs)
    || !Array.isArray(result.replayProvenance.modelRuns)) throw new Error('replay result required');
  const runId = result.runId || result.replayProvenance.runId;
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)
    || result.replayProvenance.runId !== runId) throw new Error('replay run identity required');
  const assertNoConflictingRunId = (rows, label) => {
    for (const row of rows) {
      if (row && Object.prototype.hasOwnProperty.call(row, 'runId') && row.runId !== runId) {
        throw new Error(`${label} run identity conflict`);
      }
    }
  };
  assertNoConflictingRunId(result.attempts, 'attempt');
  assertNoConflictingRunId(result.finalized, 'final');
  assertNoConflictingRunId(result.replayProvenance.executionPairs, 'execution');
  assertNoConflictingRunId(result.replayProvenance.modelRuns, 'model');
  assertNoConflictingRunId(result.finalized.flatMap(row => row?.attempts || []), 'nested attempt');
  if (existsSync(artifactPath)) {
    const existing = readJsonLines(artifactPath);
    if (existing.some(row => !row || typeof row !== 'object' || row.runId !== runId)) {
      throw new Error('replay artifact run identity conflict');
    }
  }
  const finalizedByKey = new Map(result.finalized.map(row => [
    `${row.layer}:${row.sceneId}:${row.repeatIndex}`, row
  ]));
  const records = [
    ...result.attempts.map(attempt => ({ recordType: 'attempt', runId, ...attempt })),
    ...result.finalized.map(row => ({
      recordType: 'final',
      runId,
      ...row,
      attempts: row.attempts
    })),
    {
      recordType: 'provenance',
      runId,
      sourceHead: result.replayProvenance.sourceHead,
      provenanceChecksum: result.replayProvenance.provenanceChecksum
    },
    ...result.replayProvenance.executionPairs.map(pair => ({ recordType: 'execution', runId, ...pair })),
    ...result.replayProvenance.modelRuns.map(run => ({ recordType: 'model', runId, ...run })),
    ...[...finalizedByKey.values()].map(row => ({
      recordType: 'final-checksum',
      runId,
      finalKey: `${row.layer}:${row.sceneId}:${row.repeatIndex}`,
      executionChecksum: row.executionChecksum,
      latencyMs: row.latencyMs,
      evaluatorVersion: row.evaluatorVersion
    }))
  ];
  appendFileSync(artifactPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return artifactPath;
}

async function loadExecutionConfig({ rootDir, path } = {}) {
  if (!path) throw new Error('quality replay execution config required');
  const moduleUrl = pathToFileURL(resolve(rootDir, path)).href;
  const loaded = await import(moduleUrl);
  const factory = loaded.createQualityReplayExecutionConfig || loaded.default;
  const config = typeof factory === 'function' ? await factory({ rootDir }) : factory;
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).sort().join(',') !== 'evaluator,evaluatorSecondary,evaluatorVersion,executor,releasePair,secondaryEvaluatorVersion'
    || typeof config.evaluator !== 'function'
    || typeof config.evaluatorSecondary !== 'function'
    || typeof config.evaluatorVersion !== 'string' || !config.evaluatorVersion
    || typeof config.secondaryEvaluatorVersion !== 'string' || !config.secondaryEvaluatorVersion
    || !(config.executor instanceof ReleaseExecutor)) {
    throw new Error('closed quality replay execution config required');
  }
  if (!config.releasePair || Object.keys(config.releasePair).sort().join(',') !== 'candidate,stable') {
    throw new Error('quality replay release pair config required');
  }
  for (const side of ['stable', 'candidate']) {
    const release = config.releasePair[side];
    if (!release || Object.keys(release).sort().join(',') !== 'releaseChecksum,releaseId'
      || typeof release.releaseId !== 'string' || !release.releaseId
      || !/^[0-9a-f]{64}$/.test(release.releaseChecksum)) {
      throw new Error('quality replay release pin config required');
    }
  }
  return config;
}

function cliOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  (async () => {
    const rootDir = cliOption('--root') || process.cwd();
    const stableFrom = cliOption('--stable-from');
    const candidatePreset = cliOption('--candidate-preset');
    const execute = process.argv.includes('--execute');
    try {
      const historyScenes = loadLocalHistoryScenes({ rootDir, path: cliOption('--history') });
      const historyManifest = loadLocalHistoryManifest({ rootDir, path: cliOption('--history-manifest') });
      const plan = cliOption('--plan')
        ? loadQualityReplayPlanArtifact({
          artifactPath: resolve(rootDir, cliOption('--plan')),
          rootDir,
          historyScenes,
          historyManifest
        })
        : createQualityReplayPlan({ rootDir, historyScenes, historyManifest });
      const planPath = resolve(rootDir, cliOption('--plan-out')
        || 'artifacts/yuqi-lived-agency-v3/quality-replay-plan.json');
      if (!execute) {
        writeQualityReplayPlanArtifact(plan, planPath);
        process.stdout.write(`${JSON.stringify({
          version: plan.version,
          planChecksum: plan.planChecksum,
          sourceGroundingChecksum: plan.commitments.sourceGroundingChecksum,
          historyManifestChecksum: plan.historyManifest.scenesChecksum,
          stableFrom: stableFrom || null,
          candidatePreset: candidatePreset || null,
          sentinelRuns: plan.items.filter(item => item.layer === 'sentinel').length,
          coverageRuns: plan.items.filter(item => item.layer === 'coverage').length,
          historyRuns: plan.items.filter(item => item.layer === 'history').length,
          total: plan.items.length,
          planArtifact: planPath,
          eligible: false,
          failedGates: ['MODEL_EVALUATION_NOT_RUN'],
          productionReleaseMutation: false
        }, null, 2)}\n`);
        return;
      }
      const config = await loadExecutionConfig({ rootDir, path: cliOption('--execution-config') });
      const result = await runQualityReplayPlan({
        plan,
        releasePair: config.releasePair,
        executor: config.executor,
        evaluator: config.evaluator,
        evaluatorSecondary: config.evaluatorSecondary,
        evaluatorVersion: config.evaluatorVersion,
        secondaryEvaluatorVersion: config.secondaryEvaluatorVersion,
        maxItems: cliOption('--max-items') ? Number(cliOption('--max-items')) : null,
        sourceRootDir: rootDir
      });
      writeQualityReplayPlanArtifact(plan, planPath);
      const replayPath = resolve(rootDir, cliOption('--replay-out')
        || 'artifacts/yuqi-lived-agency-v3/quality-replay.jsonl');
      appendQualityReplayArtifact({ artifactPath: replayPath, result });
      process.stdout.write(`${JSON.stringify({
        version: 1,
        executed: true,
        planChecksum: plan.planChecksum,
        sourceHead: result.replayProvenance.sourceHead,
        provenanceChecksum: result.replayProvenance.provenanceChecksum,
        replayArtifact: replayPath,
        total: result.finalized.length,
        productionReleaseMutation: false,
        eligible: false,
        failedGates: ['MANUAL_REVIEW_REQUIRED']
      }, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        version: 1,
        eligible: false,
        productionReleaseMutation: false,
        failedGates: [execute ? 'QUALITY_REPLAY_EXECUTION_UNAVAILABLE' : 'PRIVATE_HISTORY_OR_PLAN_UNAVAILABLE'],
        blockingReason: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`);
      process.exitCode = 2;
    }
  })();
}
