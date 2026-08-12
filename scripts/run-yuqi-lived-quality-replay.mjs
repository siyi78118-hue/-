import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync,
  lstatSync, realpathSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

import { compileQualitySuite } from './compile-yuqi-lived-quality-scenes.mjs';
import {
  loadVerifiedPresetHistoryArtifacts,
  presetHistoryArtifactPaths
} from './compile-yuqi-preset-history-scenes.mjs';
import {
  buildVerifiedQualityReplayPlan,
  assertVerifiedQualityReplayPlan,
  appendQualityAttempt,
  writeQualityReplayPlanArtifact,
  loadQualityReplayPlanArtifact,
  validateQualityReplayV2Rows,
  canonicalQualityReplayV2Jsonl
} from '../yuqi-runtime/src/quality-replay.mjs';
import {
  compileSceneExecutionInput,
  finalizeBlindJudgments,
  normalizeBlindEvaluation,
  projectBlindEvaluationInput
} from '../yuqi-runtime/src/quality-evaluator.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import {
  assertQualityProductionExecutionConfig,
  assertCleanQualitySourceIdentity,
  assertQualityRunAuthority,
  assertQualityProductionPreflight,
  qualityRunAuthorityProductionConfig,
  prepareQualityProductionSubject,
  qualityProductionSubjectAuthorityInputChecksum,
  bindQualityProductionPhase,
  executeQualitySubjectSide as executeBridgedQualitySubjectSide,
  executeQualityEvaluatorSide as executeBridgedQualityEvaluatorSide,
  assertPrivateNoFollowPath,
  awaitQualityPublishedStoreSidecarsGone,
} from '../yuqi-runtime/src/quality-replay-production-bridge.mjs';
import {
  QualityReplayLedger,
  LedgerBackedModelClient,
  openProductionQualityReplayLedger
} from '../yuqi-runtime/src/quality-replay-ledger.mjs';

const EVALUATOR_TRANSPORT_KEYS = Object.freeze([
  'error', 'status', 'text', 'threadId', 'turnId'
]);

export function normalizeBlindEvaluatorPhaseOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('blind evaluator phase output shape');
  }
  if (!Object.hasOwn(value, 'text')) return normalizeBlindEvaluation(value);
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...EVALUATOR_TRANSPORT_KEYS].sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('blind evaluator transport shape');
  }
  if (value.status !== 'completed' || value.error !== null
    || typeof value.threadId !== 'string' || !value.threadId
    || typeof value.turnId !== 'string' || !value.turnId
    || typeof value.text !== 'string' || !value.text.trim()) {
    throw new Error('blind evaluator transport value');
  }
  let parsed;
  try { parsed = JSON.parse(value.text); }
  catch { throw new Error('blind evaluator transport text'); }
  return normalizeBlindEvaluation(parsed);
}

function directReplyDraftFromPhase(output, side) {
  const sideResult = output?.[side];
  const draft = sideResult?.draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || !['send', 'skip'].includes(draft.action)) {
    throw new Error('blind evaluator direct-reply draft shape');
  }
  const actionValues = [
    draft.paymentAction, draft.momentAction, draft.lifePlan, draft.lifeAdjustment,
    draft.relationshipStageAction,
    ...(Array.isArray(draft.rolePlanOperations) ? draft.rolePlanOperations : []),
    ...(draft.actionIntent && typeof draft.actionIntent === 'object'
      ? Object.values(draft.actionIntent) : []),
  ];
  if (actionValues.some(value => value !== undefined && value !== null)) {
    throw new Error('blind evaluator stage-one action output conflict');
  }
  const reply = String(draft.reply || '');
  if (draft.action === 'send' && !reply.trim()) {
    throw new Error('blind evaluator visible reply required');
  }
  return {
    terminalDisposition: draft.action === 'skip' ? 'skip' : 'visible',
    replyParts: draft.action === 'skip'
      ? [] : [{ ordinal: 0, type: 'text', text: reply }],
    actions: [],
  };
}

export function buildAnonymousBlindEvaluatorInput({ item, subjectType, phaseOutputs } = {}) {
  if (!item?.scene || subjectType !== 'turn') {
    throw new Error('blind evaluator stage-one subject conflict');
  }
  const evaluationSeed = Number.parseInt(contentHash({
    sceneId: item.sceneId, repeatIndex: item.repeatIndex
  }).slice(0, 12), 16);
  return projectBlindEvaluationInput({
    subjectType,
    sceneId: item.sceneId,
    repeatIndex: item.repeatIndex,
    evaluationSeed,
    sceneAnnotation: {
      sceneId: item.sceneId,
      severity: item.scene.severity,
      focus: item.scene.focus || '',
      turns: item.scene.turns,
      requiredChecks: item.scene.mustNotice || [],
      allowedVariation: item.scene.allowedPersonalityVariation || [],
    },
    stable: { output: directReplyDraftFromPhase(phaseOutputs?.stable_execution, 'stable') },
    candidate: { output: directReplyDraftFromPhase(phaseOutputs?.candidate_execution, 'candidate') },
  }, { seed: evaluationSeed });
}

export function qualityFinalKeyFromItem(item) {
  if (!item || typeof item.layer !== 'string' || !item.layer
    || typeof item.sceneId !== 'string' || !item.sceneId
    || !Number.isSafeInteger(item.repeatIndex) || item.repeatIndex < 0) {
    throw new Error('quality item identity conflict');
  }
  return `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
}

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIXTURE_REPLAY_RESULT_BRAND = new WeakSet();
const PRODUCTION_REPLAY_RESULT_BRAND = new WeakSet();
const PRODUCTION_RUN_TOKEN = Symbol('quality-production-run');

export function createQualityRunHeader({
  runId = randomUUID(), finalKeys, planChecksum, sourceHead,
  stableRelease, candidateRelease, attestation, artifactPaths,
  inputArtifactChecksums = {
    plan: contentHash({ artifact: artifactPaths?.plan || 'quality-replay-plan.json' }),
    materials: contentHash({ artifact: 'quality-production-materials' }),
    seedDatabase: contentHash({ artifact: 'quality-seed-database' }),
  },
  createdAt = Date.now()
} = {}) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('quality run identity required');
  if (!Array.isArray(finalKeys) || finalKeys.length !== 246) {
    throw new Error('quality run requires exactly 246 final keys');
  }
  if (typeof planChecksum !== 'string' || typeof sourceHead !== 'string') {
    throw new Error('quality run source identity required');
  }
  const header = {
    version: 1,
    runId,
    finalKeys: [...finalKeys],
    planChecksum,
    sourceHead,
    stableRelease: structuredClone(stableRelease),
    candidateRelease: structuredClone(candidateRelease),
    attestation: structuredClone(attestation),
    attestationChecksum: contentHash(attestation),
    artifactPaths: structuredClone(artifactPaths || {
      plan: 'quality-replay-plan.json', ledger: 'quality-replay.sqlite', raw: 'quality-replay.jsonl'
    }),
    inputArtifactChecksums: structuredClone(inputArtifactChecksums),
    createdAt
  };
  return header;
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}


function releasePairChecksum(pair) {
  return contentHash({
    stable: pair?.stable || null,
    candidate: pair?.candidate || null,
    attestation: pair?.attestation || null
  });
}

export function createQualityReplayPlan({ rootDir = process.cwd(), historyScenes, historyManifest } = {}) {
  const resolvedHistoryScenes = historyScenes || loadLocalHistoryScenes({ rootDir });
  const resolvedHistoryManifest = historyManifest || loadLocalHistoryManifest({ rootDir });
  if (!Array.isArray(resolvedHistoryScenes) || resolvedHistoryScenes.length !== 30) {
    throw new Error('quality replay requires exactly 30 human annotation scenes');
  }
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  return buildVerifiedQualityReplayPlan({
    compiledSuite: suite,
    historyScenes: resolvedHistoryScenes,
    historyManifest: resolvedHistoryManifest
  });
}

export function loadLocalHistoryScenes({ rootDir = process.cwd(), path } = {}) {
  const historyPath = path || presetHistoryArtifactPaths(rootDir).scenesPath;
  if (!existsSync(historyPath)) throw new Error(`human annotation scenes not found: ${historyPath}`);
  const raw = readFileSync(historyPath, 'utf8');
  const scenes = raw.trimStart().startsWith('[') ? JSON.parse(raw) : readJsonLines(historyPath);
  if (scenes.length !== 30) throw new Error('human annotation scene count must be 30');
  if (!path) {
    return loadVerifiedPresetHistoryArtifacts({ rootDir }).scenes;
  }
  return scenes;
}

export function loadLocalHistoryManifest({ rootDir = process.cwd(), path } = {}) {
  const manifestPath = path || presetHistoryArtifactPaths(rootDir).manifestPath;
  if (!existsSync(manifestPath)) throw new Error(`human annotation manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!path) {
    return loadVerifiedPresetHistoryArtifacts({ rootDir }).manifest;
  }
  return manifest;
}

function replaySubjectChecksum(subject) {
  const semantic = subject?.semanticInputChecksum;
  if (typeof semantic === 'string' && /^[a-f0-9]{64}$/.test(semantic)) {
    if (subject.semanticInput !== undefined && contentHash(subject.semanticInput) !== semantic) {
      throw new Error('quality subject semantic checksum conflict');
    }
    return semantic;
  }
  return contentHash(subject);
}

function qualityPhaseInput({ runId, finalKey, phase, subject, authorityInputChecksum, now }) {
  const subjectChecksum = replaySubjectChecksum(subject);
  return {
    runId, finalKey, phase, subjectChecksum,
    authorityInputChecksum,
    input: { finalKey, subjectChecksum, authorityInputChecksum },
    now
  };
}

/**
 * SQLite-authoritative four-phase runner.  The callback surface is deliberately
 * narrow: production supplies compiled subjects and the Task3 bridge; tests may
 * supply evidence-ineligible callbacks, but cannot replace the ledger itself.
 */
export async function runQualityReplayPlanSqlite({
  plan, ledgerPath, header, resumeRun = null, onlyFinalKey = null,
  subjectFactory, executeQualitySubjectSide, evaluator, evaluatorSecondary,
  now = () => Date.now(), onPhase = () => {}, phaseClientFactory = null,
  bindProductionPhase = null,
  evidenceClass = 'fixture',
  productionToken = null,
  productionAuthority = null,
  sourceRootDir = process.cwd(),
  allowAuthorityFallback = false,
  evaluatorVersions = { primary: 'blind-evaluator-v1', secondary: 'blind-evaluator-v1b' },
  evaluatorIds = { primary: 'evaluator-primary', secondary: 'evaluator-secondary' }
} = {}) {
  if (typeof ledgerPath !== 'string' || !ledgerPath) throw new Error('SQLite quality ledger required');
  if (evidenceClass !== 'fixture'
    && (evidenceClass !== 'production' || productionToken !== PRODUCTION_RUN_TOKEN)) {
    throw new Error('production ledger authority is private');
  }
  if (evidenceClass === 'production' && allowAuthorityFallback) {
    throw new Error('production quality authority fallback is forbidden');
  }
  if (typeof subjectFactory !== 'function' || typeof executeQualitySubjectSide !== 'function'
    || typeof evaluator !== 'function' || typeof evaluatorSecondary !== 'function') {
    throw new Error('quality four-phase callbacks required');
  }
  const verifiedPlan = assertVerifiedQualityReplayPlan(plan);
  if (!header) throw new Error('SQLite quality run header required');
  const runHeader = header;
  const ledger = evidenceClass === 'production'
    ? openProductionQualityReplayLedger({ filename: ledgerPath, runAuthority: productionAuthority,
      sourceRootDir })
    : new QualityReplayLedger(ledgerPath, { evidenceClass });
  try {
    const runId = runHeader.runId;
    if (resumeRun !== null && resumeRun !== runId) throw new Error('quality run resume identity conflict');
    if (resumeRun === null && ledger.getRun?.({ runId })) {
      throw new Error('existing quality ledger requires --resume-run');
    }
    ledger.createOrOpenRun(runHeader);
    const openedRun = ledger.getRun({ runId });
    if (resumeRun !== null && ['finalized', 'blocked'].includes(openedRun?.state)) {
      throw new Error('quality run is not resumable');
    }
    const selected = onlyFinalKey === null
      ? verifiedPlan.items
      : verifiedPlan.items.filter(item =>
        `${item.layer}:${item.sceneId}:${item.repeatIndex}` === onlyFinalKey);
    if (onlyFinalKey !== null && selected.length !== 1) {
      throw new Error('only-final-key must select one bound plan item');
    }
    const results = [];
    for (const item of selected) {
      const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
      const existingFinal = ledger.getFinal?.({ runId, finalKey });
      if (existingFinal) {
        // Re-derive/validate the persisted final against all four phase rows
        // on resume; an existing row is not proof by itself.
        for (const phase of ['stable_execution', 'candidate_execution',
          'evaluator_primary', 'evaluator_secondary']) {
          const persistedPhase = ledger.getPhase({ runId, finalKey, phase });
          const calls = ledger.listModelCalls({ runId, finalKey, phase });
          if (!persistedPhase || persistedPhase.state !== 'succeeded'
            || calls.length === 0 || calls.some(call => call.state !== 'succeeded')) {
            throw new Error('quality finalized phase ownership conflict');
          }
        }
        const verifiedFinal = ledger.finalize({
          runId, finalKey, value: existingFinal.value, now: now()
        });
        results.push({
          finalKey,
          final: verifiedFinal,
          phases: Object.fromEntries(['stable_execution', 'candidate_execution',
            'evaluator_primary', 'evaluator_secondary'].map(phase => [phase,
            ledger.getPhase({ runId, finalKey, phase })?.output || {}])),
        });
        continue;
      }
      const subjectResult = await subjectFactory(item, { ledger, runId, finalKey });
      const wrappedSubject = subjectResult && typeof subjectResult === 'object'
        && Object.hasOwn(subjectResult, 'qualitySubject');
      if (wrappedSubject && Object.keys(subjectResult).sort().join(',')
        !== 'executionAuthorityInputChecksum,qualitySubject') {
        throw new Error('quality subject authority wrapper conflict');
      }
      const subject = wrappedSubject ? subjectResult.qualitySubject : subjectResult;
      if (!subject || typeof subject !== 'object') throw new Error('compiled quality subject required');
      const subjectChecksum = replaySubjectChecksum(subject);
      const authorityInputChecksum = wrappedSubject
        ? subjectResult.executionAuthorityInputChecksum
        : subject.executionAuthorityInputChecksum;
      if (typeof authorityInputChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(authorityInputChecksum)) {
        if (!allowAuthorityFallback) throw new Error('quality authority input checksum is required');
      }
      const effectiveAuthorityInputChecksum = authorityInputChecksum
        || subject.semanticInputChecksum
        || (allowAuthorityFallback ? contentHash(subject.semanticInput || subject) : null);
      const phaseOutputs = {};
      const subjectType = subject.subjectType
        || (subject.semanticInput?.turnKind === 'LIFE_PLANNING' ? 'life_planning' : 'turn');
      for (const phase of ['stable_execution', 'candidate_execution',
        'evaluator_primary', 'evaluator_secondary']) {
        const phaseInput = qualityPhaseInput({
          runId, finalKey, phase, subject,
          authorityInputChecksum: effectiveAuthorityInputChecksum, now: now()
        });
        const existingPhase = ledger.getPhase(phaseInput);
        if (existingPhase?.state === 'succeeded') {
          phaseOutputs[phase] = existingPhase.output || {};
          continue;
        }
        if (existingPhase?.state === 'failed') {
          throw new Error('quality phase is terminally failed');
        }
        if (existingPhase?.state === 'uncertain') {
          throw new Error('quality phase is uncertain');
        }
        if (existingPhase?.state === 'running') {
          const recoveredCalls = ledger.listModelCalls({ runId, finalKey, phase });
          if (recoveredCalls.length === 0) {
            ledger.markPhaseUncertain(phaseInput, {
              reason: { code: 'QUALITY_ORPHAN_RUNNING_NO_CALL' }, now: now()
            });
            throw new Error('quality phase orphan running uncertain');
          }
          if (recoveredCalls.some(call => call.state === 'failed')) {
            throw new Error('quality phase is terminally failed');
          }
        }
        let phaseRow = ledger.preparePhase(phaseInput);
        if (phaseRow.state === 'starting') {
          const calls = ledger.listModelCalls(phaseInput);
          if (calls.length === 0) {
            phaseRow = ledger.resetStartingPhase(phaseInput, { now: now() });
          } else if (calls.some(call => call.state === 'failed')) {
            throw new Error('quality phase is terminally failed');
          } else {
            phaseRow = ledger.markPhaseRunning(phaseInput, { now: now() });
          }
        }
        if (phaseRow.state === 'prepared') {
          phaseRow = ledger.startPhase(phaseInput, { now: now() });
          phaseRow = ledger.markPhaseRunning(phaseInput, { now: now() });
        } else if (phaseRow.state !== 'running') {
          throw new Error('quality phase recovery state conflict');
        }
        onPhase({ runId, finalKey, phase, state: 'running' });
        try {
          let phaseClient = null;
          if (phaseClientFactory !== null) {
            if (typeof phaseClientFactory !== 'function') {
              throw new Error('quality phase client factory conflict');
            }
            phaseClient = await phaseClientFactory({
              ledger, runId, finalKey, phase, subject, phaseInput, now
            });
            if (!phaseClient || typeof phaseClient.runTurn !== 'function') {
              throw new Error('quality phase client required');
            }
          }
          let output;
          if (phase === 'stable_execution' || phase === 'candidate_execution') {
            if (typeof bindProductionPhase === 'function') {
              await bindProductionPhase({ item, subject, phase, phaseInput });
            }
            output = await executeQualitySubjectSide({
              item, subject, side: phase === 'stable_execution' ? 'stable' : 'candidate',
              runId, finalKey, phase, phaseClient
            });
          } else {
            const blind = phase === 'evaluator_primary'
              ? evaluator : evaluatorSecondary;
            const blindInput = buildAnonymousBlindEvaluatorInput({
              item, subjectType, phaseOutputs,
            });
            output = await blind({ item, subject, finalKey, runId, phase,
              phaseClient, blindInput, phaseInput, ledger });
          }
          const ownedCalls = ledger.listModelCalls({ runId, finalKey, phase });
          if (ownedCalls.length === 0 || ownedCalls.some(call => call.state !== 'succeeded')) {
            throw new Error('quality phase model call ownership conflict');
          }
          phaseOutputs[phase] = output || {};
          ledger.succeedPhase(phaseInput, { output: output || {}, now: now() });
          onPhase({ runId, finalKey, phase, state: 'succeeded' });
        } catch (error) {
          const currentCalls = ledger.listModelCalls({ runId, finalKey, phase });
          for (const current of currentCalls.filter(call => ['starting', 'running'].includes(call.state))) {
            ledger.markModelCallUncertain({
              runId, finalKey, phase, ordinal: current.ordinal,
              role: current.role, threadId: current.threadId, baseline: current.baseline,
              request: current.request, now: now()
            }, { reason: { code: 'QUALITY_PHASE_UNCERTAIN' }, now: now() });
          }
          const phaseRow = ledger.getPhase(phaseInput);
          if (phaseRow?.state === 'running') {
            const hasUncertain = currentCalls.some(call => call.state === 'uncertain');
            const allFailed = currentCalls.length > 0
              && currentCalls.every(call => call.state === 'failed');
            if (currentCalls.length === 0 || (allFailed && !hasUncertain)) {
              ledger.failPhase(phaseInput, {
                error: { code: 'QUALITY_PHASE_FAILED' }, now: now()
              });
            } else {
              ledger.markPhaseUncertain(phaseInput, {
                reason: { code: 'QUALITY_PHASE_UNCERTAIN' }, now: now()
              });
            }
          }
          throw error;
        }
      }
      const primary = normalizeBlindEvaluatorPhaseOutput(phaseOutputs.evaluator_primary);
      const secondary = normalizeBlindEvaluatorPhaseOutput(phaseOutputs.evaluator_secondary);
      const blindInput = {
        version: 1, finalKey, subjectType, subjectChecksum,
        stable: phaseOutputs.stable_execution || {},
        candidate: phaseOutputs.candidate_execution || {},
      };
      const judgmentInputChecksum = contentHash(blindInput);
      const closedJudgments = finalizeBlindJudgments(primary, secondary);
      const judgment = (id, output) => ({
        evaluatorId: id === 'evaluator_primary' ? evaluatorIds.primary : evaluatorIds.secondary,
        evaluatorVersion: id === 'evaluator_primary' ? evaluatorVersions.primary : evaluatorVersions.secondary,
        inputChecksum: judgmentInputChecksum,
        output,
        outputChecksum: contentHash(output),
      });
      const agreedCriticalFindings = primary.findings.filter(primaryFinding =>
        primaryFinding.critical && secondary.findings.some(secondaryFinding =>
          contentHash(primaryFinding) === contentHash(secondaryFinding)));
      const finalValue = {
        version: 1, finalKey, subjectType, subjectChecksum,
        stablePhase: {
          inputChecksum: contentHash({ subjectChecksum, authorityInputChecksum: effectiveAuthorityInputChecksum,
            input: { finalKey, subjectChecksum, authorityInputChecksum: effectiveAuthorityInputChecksum } }),
          outputChecksum: contentHash(phaseOutputs.stable_execution || {}),
        },
        candidatePhase: {
          inputChecksum: contentHash({ subjectChecksum, authorityInputChecksum: effectiveAuthorityInputChecksum,
            input: { finalKey, subjectChecksum, authorityInputChecksum: effectiveAuthorityInputChecksum } }),
          outputChecksum: contentHash(phaseOutputs.candidate_execution || {}),
        },
        blindInputChecksum: judgmentInputChecksum,
        primary: judgment('evaluator_primary', primary),
        secondary: judgment('evaluator_secondary', secondary),
        comparison: {
          version: 1,
          differences: closedJudgments.differences,
          manualReview: closedJudgments.manualReview,
          unresolved: primary.unresolved || secondary.unresolved,
          agreedCriticalFindings,
        },
      };
      const final = ledger.finalize({ runId, finalKey, value: finalValue, now: now() });
      results.push({ finalKey, final, phases: phaseOutputs });
    }
    if (onlyFinalKey === null && selected.length === 246) {
      ledger.finalizeRun({ runId, now: now() });
    }
    const replayResult = { runId, results, ledgerPath, run: ledger.getRun({ runId }),
      evidenceClass, evidenceEligible: evidenceClass === 'production' };
    (evidenceClass === 'production' ? PRODUCTION_REPLAY_RESULT_BRAND : FIXTURE_REPLAY_RESULT_BRAND).add(replayResult);
    return replayResult;
  } catch (error) {
    ledger.close();
    throw error;
  } finally {
    ledger.close();
  }
}

export function captureCleanSourceHead({ rootDir = process.cwd() } = {}) {
  return assertCleanQualitySourceIdentity({ sourceRootDir: rootDir });
}

function releaseHeaderSnapshot(release, side) {
  const source = release && typeof release === 'object' ? release : {};
  const releaseId = typeof source.releaseId === 'string' && source.releaseId
    ? source.releaseId : `quality-${side}`;
  const releaseChecksum = /^[a-f0-9]{64}$/i.test(String(source.releaseChecksum || ''))
    ? String(source.releaseChecksum).toLowerCase() : contentHash({ side, release: source });
  return {
    releaseId, pipelineVersion: String(source.pipelineVersion || 'v3'),
    presetVersion: String(source.presetVersion || 'quality'),
    cognitionSchemaVersion: Number.isSafeInteger(source.cognitionSchemaVersion)
      ? source.cognitionSchemaVersion : 3,
    expressionSchemaVersion: Number.isSafeInteger(source.expressionSchemaVersion)
      ? source.expressionSchemaVersion : 3,
    evaluatorVersion: String(source.evaluatorVersion || 'quality-evaluator-v1'),
    modelProfile: structuredClone(source.modelProfile || { side }),
    componentManifest: structuredClone(source.componentManifest || source.manifest || { side }),
    releaseChecksum, createdAt: Number.isSafeInteger(source.createdAt) ? source.createdAt : 0,
    retiredAt: source.retiredAt == null ? null : source.retiredAt,
  };
}

function runHeaderForCompatibility({ verifiedPlan, runId, sourceHead, releasePair,
  evaluatorVersion, secondaryEvaluatorVersion, createdAt }) {
  const evaluator = (id, version, index) => ({
    evaluatorId: id, evaluatorVersion: version,
    modelProfileChecksum: contentHash({ id, version, index, kind: 'model' }),
    clientConfigChecksum: contentHash({ id, version, index, kind: 'client' }),
    sessionNamespaceChecksum: contentHash({ id, version, index, kind: 'session' }),
  });
  const attestation = {
    version: 1, sourceHead,
    stableRuntime: { sourceHead }, candidateRuntime: { sourceHead },
    evaluatorPrimary: evaluator('primary', evaluatorVersion, 0),
    evaluatorSecondary: evaluator('secondary', secondaryEvaluatorVersion, 1),
  };
  return createQualityRunHeader({
    runId, finalKeys: verifiedPlan.items.map(item =>
      `${item.layer}:${item.sceneId}:${item.repeatIndex}`),
    planChecksum: verifiedPlan.planChecksum, sourceHead,
    stableRelease: releaseHeaderSnapshot(releasePair?.stable, 'stable'),
    candidateRelease: releaseHeaderSnapshot(releasePair?.candidate, 'candidate'),
    attestation,
    artifactPaths: { plan: 'quality-replay-plan.json', ledger: 'quality-replay.sqlite', raw: 'quality-replay.jsonl' },
    createdAt,
  });
}

export async function runQualityReplayFixture({
  plan, releasePair, executor, evaluator, evaluatorSecondary = null,
  evaluatorVersion = 'blind-evaluator-v1', secondaryEvaluatorVersion = 'blind-evaluator-v1b',
  maxItems = null, onSideEffect = () => {}, now = () => Date.now(),
  sourceRootDir = process.cwd(), ledger: ledgerPath = null, resumeRun = null,
  onlyFinalKey = null, runHeader = null, subjectFactory = null, phaseExecutor = null,
  evidenceEligible = false
} = {}) {
  return (async () => {
    if (evidenceEligible !== false) throw new Error('quality replay callbacks are not evidence eligible');
    if (!ledgerPath || String(ledgerPath).toLowerCase().endsWith('.json')) {
      throw new Error('SQLite quality ledger is required');
    }
    if (maxItems !== null) throw new Error('--max-items is forbidden in production quality replay');
    if (typeof evaluator !== 'function' || typeof evaluatorSecondary !== 'function') {
      throw new Error('two independent blind evaluators required');
    }
    const verifiedPlan = assertVerifiedQualityReplayPlan(plan);
    const sourceHead = captureCleanSourceHead({ rootDir: sourceRootDir });
    const header = runHeader || runHeaderForCompatibility({
      verifiedPlan, runId: resumeRun || randomUUID(), sourceHead, releasePair,
      evaluatorVersion, secondaryEvaluatorVersion, createdAt: now(),
    });
    const outputsByKey = new Map();
    const selectedKey = onlyFinalKey || null;
    const subjectBuilder = subjectFactory || (async item => compileSceneExecutionInput(item.scene));
    const sideExecutor = phaseExecutor || (async ({ side, item, phaseClient }) => {
      if (!phaseClient) throw new Error('fixture phase client required');
      await phaseClient.runTurn('brain', JSON.stringify({ side, finalKey: `${item.layer}:${item.sceneId}:${item.repeatIndex}` }), {
        model: 'quality-controlled-v1', effort: 'high', outputSchema: { type: 'object' }
      });
      if (!executor || typeof executor.executeTurn !== 'function') {
        throw new Error('quality release executor required');
      }
      const value = await executor.executeTurn({
        item, dryRun: true, capabilities: { visible: false, actions: false }, side,
      });
      const key = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
      const pair = outputsByKey.get(key) || {};
      outputsByKey.set(key, { ...pair, [side]: value });
      return value;
    });
    const blind = async ({ item, finalKey, phase, phaseClient, blindInput }) => {
      if (!phaseClient) throw new Error('fixture phase client required');
      const pair = outputsByKey.get(finalKey) || {};
      const evaluationSeed = Number.parseInt(contentHash({
        sceneId: item.sceneId, repeatIndex: item.repeatIndex
      }).slice(0, 12), 16);
      const sceneAnnotation = {
        sceneId: item.sceneId, severity: item.scene.severity, focus: item.scene.focus,
        turns: item.scene.turns, requiredChecks: item.scene.mustNotice || [],
        allowedVariation: item.scene.allowedPersonalityVariation || []
      };
      const input = projectBlindEvaluationInput({
        sceneId: item.sceneId, repeatIndex: item.repeatIndex, evaluationSeed,
        sceneAnnotation,
        stable: { output: pair.stable?.draft?.output || pair.stable?.draft || pair.stable || {} },
        candidate: { output: pair.candidate?.draft?.output || pair.candidate?.draft || pair.candidate || {} },
      }, { seed: evaluationSeed });
      await phaseClient.runTurn('brain', JSON.stringify(blindInput), {
        model: phase === 'evaluator_primary' ? evaluatorVersion : secondaryEvaluatorVersion,
        effort: 'high', outputSchema: { type: 'object' }
      });
      return phase === 'evaluator_primary' ? evaluator(input) : evaluatorSecondary(input);
    };
    const result = await runQualityReplayPlanSqlite({
      plan: verifiedPlan, ledgerPath, header, resumeRun, onlyFinalKey: selectedKey,
      subjectFactory: subjectBuilder, executeQualitySubjectSide: sideExecutor,
      evaluator: blind, evaluatorSecondary: blind, now, onPhase: onSideEffect,
      allowAuthorityFallback: true,
      evaluatorVersions: { primary: evaluatorVersion, secondary: secondaryEvaluatorVersion },
      phaseClientFactory: async ({ ledger, runId, finalKey, phase, phaseInput, now: clock }) => {
        const underlying = {
          turnTimeoutMs: 180_000,
          async ensureThread() { return `quality-fixture-thread-${runId}`; },
          async readThread(threadId) { return { id: threadId, turns: [] }; },
          async runTurn(role, input, options = {}) {
            await options.onTurnStarted?.({ turnId: `quality-fixture-turn-${contentHash({ runId, role, input }).slice(0, 24)}` });
            return { status: 'completed', role, input };
          },
        };
        const owner = new LedgerBackedModelClient({ ledger, underlying, runId, now: clock });
        return owner.forPhase(phaseInput);
      },
    });
    const endingSourceHead = captureCleanSourceHead({ rootDir: sourceRootDir });
    if (endingSourceHead !== sourceHead) throw new Error('quality source identity changed during replay');
    const finalized = result.results.map(row => {
      const identity = row.finalKey.split(':');
      const value = row.final?.value || {};
      const executionChecksum = contentHash(row.phases || {});
      const attempt = {
        layer: identity[0], sceneId: identity[1], repeatIndex: Number(identity[2]),
        attemptIndex: 0, evaluatorId: evaluatorVersion, evaluatorVersion,
        executionChecksum, latencyMs: 0,
        accepted: !(value.comparison?.unresolved || value.comparison?.manualReview),
        unresolved: Boolean(value.comparison?.unresolved || value.comparison?.manualReview),
      };
      return { layer: identity[0], sceneId: identity[1], repeatIndex: Number(identity[2]),
        finalized: true, ...value,
        unresolved: Boolean(value.comparison?.unresolved || value.comparison?.manualReview),
        executionChecksum, attempts: [attempt] };
    });
    const attempts = finalized.map(row => ({
      layer: row.layer, sceneId: row.sceneId, repeatIndex: row.repeatIndex,
      attemptIndex: 0, evaluatorId: evaluatorVersion, evaluatorVersion,
      executionChecksum: contentHash(row), latencyMs: 0, accepted: row.unresolved !== true,
      unresolved: row.unresolved === true,
    }));
    const replayProvenance = {
      runId: result.runId, sourceHead, executionPairs: [],
      modelRuns: finalized.flatMap(row => [
        { finalKey: `${row.layer}:${row.sceneId}:${row.repeatIndex}`, attemptIndex: 0,
          evaluatorId: evaluatorVersion, inputChecksum: contentHash(row), completed: true },
        { finalKey: `${row.layer}:${row.sceneId}:${row.repeatIndex}`, attemptIndex: 1,
          evaluatorId: secondaryEvaluatorVersion, inputChecksum: contentHash(row), completed: true },
      ]),
    };
    const replayResult = { runId: result.runId, finalized, attempts, pairRecords: [],
      replayProvenance: { ...replayProvenance, provenanceChecksum: contentHash(replayProvenance) },
      sentinelRuns: finalized.filter(row => row.layer === 'sentinel'),
      coverageRuns: finalized.filter(row => row.layer === 'coverage'),
      historyRuns: finalized.filter(row => row.layer === 'history'),
      evidenceClass: 'fixture', evidenceEligible: false };
    FIXTURE_REPLAY_RESULT_BRAND.add(replayResult);
    return replayResult;
  })();
}

export async function runQualityReplayPlan(options = {}) {
  const allowed = new Set(['plan', 'ledgerPath', 'runAuthority', 'selector', 'resumeRun', 'sourceRootDir']);
  if (Object.keys(options).some(key => !allowed.has(key))) {
    throw new Error('production quality replay option conflict');
  }
  if (!options.plan || !options.ledgerPath || !options.runAuthority) {
    throw new Error('production quality replay authority required');
  }
  assertQualityRunAuthority(options.runAuthority);
  const config = qualityRunAuthorityProductionConfig(options.runAuthority);
  assertQualityProductionExecutionConfig(config);
  if (!options.selector || !Object.hasOwn(options.selector, 'onlyFinalKey')
    || Object.keys(options.selector).length !== 1) {
    throw new Error('production quality replay selector required');
  }
  const onlyFinalKey = options.selector.onlyFinalKey;
  if (onlyFinalKey !== null && typeof onlyFinalKey !== 'string') {
    throw new Error('production quality replay selector conflict');
  }
  const sourceRootDir = options.sourceRootDir || process.cwd();
  // A resume begins with a read-only ledger authority check.  No source
  // material, runtime, client, or writable ledger may be opened until the
  // persisted header has been proven to be this exact run.
  assertProductionResumeLedgerState({
    ledgerPath: options.ledgerPath,
    runAuthority: options.runAuthority,
    resumeRun: options.resumeRun,
    sourceRootDir,
  });
  const preflightHead = captureCleanSourceHead({ rootDir: sourceRootDir });
  if (preflightHead !== config.sourceHead) throw new Error('production source head drift');
  // The branded bridge owns composition, phase slots, and evaluator clients.
  // Runner orchestration only advances the SQLite phases and never supplies
  // executor/client callbacks or writes model-call rows itself.
  const verifiedPlan = assertVerifiedQualityReplayPlan(options.plan);
  const verifiedFinalKeys = verifiedPlan.items.map(item =>
    `${item.layer}:${item.sceneId}:${item.repeatIndex}`);
  if (contentHash(verifiedFinalKeys) !== contentHash(options.runAuthority.finalKeys)
    || verifiedPlan.planChecksum !== options.runAuthority.planChecksum) {
    throw new Error('production run authority plan identity conflict');
  }
  // All source/release/runtime/material checks happen before the writable
  // quality ledger is opened.  A drift therefore leaves zero ledger/meta rows.
  assertQualityProductionPreflight({
    productionConfig: config,
    runAuthority: options.runAuthority,
    sourceRootDir,
    ledgerPath: options.ledgerPath,
    planChecksum: verifiedPlan.planChecksum,
    finalKeys: verifiedFinalKeys,
  });
  const postPreflightHead = captureCleanSourceHead({ rootDir: sourceRootDir });
  if (postPreflightHead !== preflightHead || postPreflightHead !== config.sourceHead) {
    throw new Error('production source identity changed during preflight');
  }
  const configDescriptor = config;
  const artifactPaths = options.runAuthority.artifactPaths;
  assertProductionArtifactPaths(sourceRootDir, artifactPaths);
  if (resolve(sourceRootDir, options.ledgerPath) !== resolve(sourceRootDir, artifactPaths.ledger)) {
    throw new Error('production quality ledger artifact path conflict');
  }
  const expectedHeader = createQualityRunHeader({
    runId: options.resumeRun || options.runAuthority.runId,
    finalKeys: verifiedFinalKeys,
    planChecksum: verifiedPlan.planChecksum,
    sourceHead: configDescriptor.sourceHead,
    stableRelease: configDescriptor.stableRelease,
    candidateRelease: configDescriptor.candidateRelease,
    attestation: configDescriptor.attestation,
    artifactPaths,
    inputArtifactChecksums: configDescriptor.inputArtifactChecksums,
    createdAt: options.runAuthority.createdAt,
  });
  if (options.header && contentHash(options.header) !== contentHash(expectedHeader)) {
    throw new Error('production quality run header drift');
  }
  const header = expectedHeader;
  const state = {
    context: null,
    preparedByKey: new Map(),
  };
  const waitForPublishedStoreBarrier = async () => {
    const paths = [...state.preparedByKey.values()]
      .flatMap(context => context.config?.publishedStorePaths || []);
    if (paths.length) await awaitQualityPublishedStoreSidecarsGone(paths);
  };
  let result;
  try {
    result = await runQualityReplayPlanSqlite({
    ledgerPath: options.ledgerPath,
    plan: verifiedPlan,
    header,
    resumeRun: options.resumeRun,
    onlyFinalKey,
    subjectFactory: async (item, execution) => {
      const context = await prepareQualityProductionSubject(config, {
        item,
        runId: header.runId,
        finalKey: `${item.layer}:${item.sceneId}:${item.repeatIndex}`,
        ordinal: item.ordinal ?? item.repeatIndex,
        ledger: execution.ledger,
      });
      state.context = context;
      const subject = context.subject || item.subject;
      if (!subject) throw new Error('branded quality context subject unavailable');
      state.preparedByKey.set(`${item.layer}:${item.sceneId}:${item.repeatIndex}`, context);
      return {
        qualitySubject: subject,
        executionAuthorityInputChecksum: qualityProductionSubjectAuthorityInputChecksum(context),
      };
    },
    executeQualitySubjectSide: async ({ item, subject, side, phase }) => {
      const key = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
      const context = state.preparedByKey.get(key);
      if (!context) throw new Error('branded quality context missing');
      return executeBridgedQualitySubjectSide(context, subject, {
        side, phaseClientSlot: side === 'stable'
          ? context.config?.stablePhaseClientSlot : context.config?.candidatePhaseClientSlot,
      });
    },
    evaluator: async ({ item, blindInput, phaseInput, ledger }) => {
      const context = state.preparedByKey.get(qualityFinalKeyFromItem(item));
      if (!context?.evaluatorStores?.primary) throw new Error('primary evaluator store unavailable');
      return executeBridgedQualityEvaluatorSide(config, {
        side: 'primary', role: 'brain', input: JSON.stringify(blindInput), phaseInput, ledger,
        evaluatorStore: context.evaluatorStores.primary,
        storeManifestAuthority: context.expectedStoreManifests,
        storeManifestStores: context.openStoreManifestStores,
      });
    },
    evaluatorSecondary: async ({ item, blindInput, phaseInput, ledger }) => {
      const context = state.preparedByKey.get(qualityFinalKeyFromItem(item));
      if (!context?.evaluatorStores?.secondary) throw new Error('secondary evaluator store unavailable');
      return executeBridgedQualityEvaluatorSide(config, {
        side: 'secondary', role: 'brain', input: JSON.stringify(blindInput), phaseInput, ledger,
        evaluatorStore: context.evaluatorStores.secondary,
        storeManifestAuthority: context.expectedStoreManifests,
        storeManifestStores: context.openStoreManifestStores,
      });
    },
      evaluatorVersions: {
        primary: config.attestation.evaluatorPrimary.evaluatorVersion,
        secondary: config.attestation.evaluatorSecondary.evaluatorVersion,
      },
      evaluatorIds: {
        primary: config.attestation.evaluatorPrimary.evaluatorId,
        secondary: config.attestation.evaluatorSecondary.evaluatorId,
      },
    onPhase: ({ finalKey, phase, state: phaseState }) => {
      if (phase === 'evaluator_secondary' && phaseState === 'succeeded') {
        const context = state.preparedByKey.get(finalKey);
        if (context) context.evaluatorComplete = true;
      }
    },
    bindProductionPhase: async ({ item, phase, phaseInput }) => {
      const key = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
      const context = state.preparedByKey.get(key);
      if (!context) throw new Error('branded quality context missing');
      bindQualityProductionPhase(context, phaseInput);
    },
      evidenceClass: 'production',
      productionToken: PRODUCTION_RUN_TOKEN,
      productionAuthority: options.runAuthority,
      sourceRootDir,
    });
    if (result.run?.state === 'finalized') {
      for (const context of state.preparedByKey.values()) {
        context.persistProductionStores = true;
        if (typeof context.closeAsync === 'function') await context.closeAsync();
        else context.close?.();
      }
      await waitForPublishedStoreBarrier();
      state.preparedByKey.clear();
    } else {
      for (const context of state.preparedByKey.values()) {
        if (typeof context.closeAsync === 'function') await context.closeAsync();
        else context.close?.();
      }
      await waitForPublishedStoreBarrier();
      state.preparedByKey.clear();
    }
  } catch (error) {
    for (const context of state.preparedByKey.values()) {
      try {
        if (typeof context.closeAsync === 'function') await context.closeAsync();
        else context.close?.();
      }
      catch (cleanupError) {
        error.message = `${error.message}; quality cleanup failed: ${cleanupError?.message || String(cleanupError)}`;
        error.cleanupError = cleanupError;
      }
    }
    try { await waitForPublishedStoreBarrier(); }
    catch (barrierError) {
      error.message = `${error.message}; quality published-store barrier failed: ${barrierError?.message || String(barrierError)}`;
      error.publishedStoreBarrierError = barrierError;
    }
    state.preparedByKey.clear();
    throw error;
  }
  const postflightHead = captureCleanSourceHead({ rootDir: sourceRootDir });
  if (postflightHead !== preflightHead) throw new Error('production source identity changed during replay');
  return result;
}

function assertProductionResumeLedgerState({ ledgerPath, runAuthority, resumeRun, sourceRootDir }) {
  const absolute = resolve(sourceRootDir, ledgerPath);
  if (resumeRun == null) {
    if (existsSync(absolute)) throw new Error('existing quality ledger requires --resume-run');
    return;
  }
  if (!existsSync(absolute)) throw new Error('quality resume ledger unavailable');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority, readOnly: true, sourceRootDir,
  });
  try {
    const persisted = ledger.getRun({ runId: resumeRun });
    const meta = ledger.getMeta?.();
    if (!persisted || persisted.runId !== runAuthority.runId
      || persisted.createdAt !== runAuthority.createdAt
      || persisted.planChecksum !== runAuthority.planChecksum
      || persisted.sourceHead !== runAuthority.sourceHead
      || contentHash(persisted.finalKeys) !== contentHash(runAuthority.finalKeys)
      || contentHash(persisted.stableRelease) !== contentHash(runAuthority.stableRelease)
      || contentHash(persisted.candidateRelease) !== contentHash(runAuthority.candidateRelease)
      || contentHash(persisted.attestation) !== contentHash(runAuthority.attestation)
      || contentHash(persisted.artifactPaths) !== contentHash(runAuthority.artifactPaths)
      || contentHash(persisted.inputArtifactChecksums)
        !== contentHash(runAuthority.inputArtifactChecksums)
      || meta?.schemaVersion !== 1
      || meta?.evidenceClass !== 'production'
      || persisted.evidenceClass !== undefined && persisted.evidenceClass !== 'production') {
      throw new Error('quality resume ledger header authority conflict');
    }
    if (['finalized', 'blocked'].includes(persisted.state)) {
      throw new Error('quality run is not resumable');
    }
  } finally {
    ledger.close();
  }
}

function assertProductionArtifactPaths(rootDir, artifactPaths) {
  if (!artifactPaths || typeof artifactPaths !== 'object') {
    throw new Error('production quality artifact paths required');
  }
  const privateRoot = resolve(rootDir, 'artifacts/yuqi-lived-agency-v3/private');
  const paths = Object.values(artifactPaths);
  if (new Set(paths).size !== paths.length) throw new Error('production quality artifact paths must be distinct');
  for (const value of paths) {
    if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
      throw new Error('production quality artifact path shape conflict');
    }
    const segments = value.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('production quality artifact path shape conflict');
    }
    const absolute = resolve(rootDir, value);
    const rel = relative(privateRoot, absolute);
    if (rel.startsWith('..') || rel.includes(':') || rel === '') {
      throw new Error('production quality artifact path containment conflict');
    }
    assertProductionArtifactPath(rootDir, value);
  }
}

function assertProductionArtifactPath(rootDir, artifactPath) {
  assertPrivateNoFollowPath(rootDir, artifactPath, 'production quality artifact');
  const privateRoot = resolve(rootDir, 'artifacts/yuqi-lived-agency-v3/private');
  const rel = relative(privateRoot, resolve(rootDir, artifactPath));
  if (rel.startsWith('..') || rel.includes(':') || rel === '') {
    throw new Error('production quality artifact path containment conflict');
  }
  let cursor = privateRoot;
  for (const part of rel.split(/[\\/]/)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error('production quality artifact symlink conflict');
    }
  }
  const nearest = (() => {
    let current = cursor;
    while (!existsSync(current)) {
      const parent = dirname(current);
      if (parent === current) throw new Error('production quality artifact parent missing');
      current = parent;
    }
    return current;
  })();
  if (existsSync(privateRoot) && realpathSync(privateRoot) !== privateRoot) {
    throw new Error('production quality artifact root symlink conflict');
  }
  const actual = realpathSync(nearest);
  const privateReal = realpathSync(privateRoot);
  const escaped = relative(privateReal, actual);
  if (escaped.startsWith('..') || escaped.includes(':')) {
    throw new Error('production quality artifact realpath conflict');
  }
}

function writeAtomicText(artifactPath, text) {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const tempPath = `${artifactPath}.tmp-${randomUUID()}`;
  let fd = null;
  try {
    fd = openSync(tempPath, 'w');
    writeFileSync(fd, text, 'utf8');
    try { fsyncSync(fd); } catch (error) {
      // Windows can reject fsync for a freshly-created text handle; atomic
      // replace remains the durable boundary on that platform.
      if (error?.code !== 'EPERM' && error?.code !== 'EINVAL') throw error;
    }
    closeSync(fd); fd = null;
    renameSync(tempPath, artifactPath);
    const parentFd = openSync(dirname(artifactPath), 'r');
    try {
      try { fsyncSync(parentFd); } catch (error) {
        if (error?.code !== 'EPERM' && error?.code !== 'EINVAL') throw error;
      }
    } finally { closeSync(parentFd); }
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tempPath); } catch {}
    throw error;
  }
}

function buildQualityReplayV2RowsFromLedger({ ledger, runId, finalKeys }) {
  const run = ledger.getRun({ runId });
  if (!run || run.state !== 'finalized') throw new Error('quality replay v2 export requires finalized run');
  const keys = [...finalKeys];
  const rows = [{ schemaVersion: 2, recordType: 'run', runId,
    header: Object.fromEntries(Object.entries(run).filter(([key]) => !['headerChecksum', 'state', 'finalizedAt'].includes(key))),
    headerChecksum: run.headerChecksum, state: run.state, createdAt: run.createdAt,
    finalizedAt: run.finalizedAt }];
  const executions = [];
  const phases = [];
  const calls = [];
  const judgments = [];
  const finals = [];
  for (const finalKey of keys) {
    const final = ledger.getFinal({ runId, finalKey });
    if (!final) throw new Error('quality replay v2 final row missing');
    const phaseMap = Object.fromEntries(['stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary']
      .map(phase => [phase, ledger.getPhase({ runId, finalKey, phase })]));
    if (Object.values(phaseMap).some(phase => !phase || phase.state !== 'succeeded')) throw new Error('quality replay v2 phase row missing');
    const value = final.value;
    const execution = {
      schemaVersion: 2, recordType: 'execution', runId, finalKey,
      subjectType: value.subjectType, subjectChecksum: value.subjectChecksum,
      stablePhase: { inputChecksum: phaseMap.stable_execution.inputChecksum, outputChecksum: phaseMap.stable_execution.outputChecksum },
      candidatePhase: { inputChecksum: phaseMap.candidate_execution.inputChecksum, outputChecksum: phaseMap.candidate_execution.outputChecksum },
    };
    execution.executionChecksum = contentHash({ finalKey, subjectType: execution.subjectType,
      subjectChecksum: execution.subjectChecksum, stablePhase: execution.stablePhase,
      candidatePhase: execution.candidatePhase });
    executions.push(execution);
    for (const phase of ['stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary']) {
      const phaseRow = phaseMap[phase];
      phases.push({ schemaVersion: 2, recordType: 'phase', runId, finalKey, phase,
        state: 'succeeded', subjectChecksum: phaseRow.subjectChecksum,
        authorityInputChecksum: phaseRow.authorityInputChecksum, input: phaseRow.input,
        inputChecksum: phaseRow.inputChecksum, output: phaseRow.output,
        outputChecksum: phaseRow.outputChecksum, createdAt: phaseRow.createdAt,
        startingAt: phaseRow.startingAt, runningAt: phaseRow.runningAt, updatedAt: phaseRow.updatedAt });
      for (const call of ledger.listModelCalls({ runId, finalKey, phase })) {
        if (call.state !== 'succeeded') throw new Error('quality replay v2 model call incomplete');
        calls.push({ schemaVersion: 2, recordType: 'model_call', runId, finalKey, phase,
          ordinal: call.ordinal, state: 'succeeded', role: call.role, callId: call.callId,
          clientUserMessageId: call.clientUserMessageId, threadId: call.threadId, turnId: call.turnId,
          baseline: call.baseline, baselineChecksum: call.baselineChecksum, request: call.request,
          requestChecksum: call.requestChecksum, model: call.model, effort: call.effort,
          schemaChecksum: call.schemaChecksum, output: call.output, outputChecksum: call.outputChecksum,
          runningAt: call.runningAt, createdAt: call.createdAt, updatedAt: call.updatedAt });
      }
    }
    for (const phase of ['evaluator_primary', 'evaluator_secondary']) {
      const judgment = value[phase === 'evaluator_primary' ? 'primary' : 'secondary'];
      const row = { schemaVersion: 2, recordType: 'judgment', runId, finalKey, phase,
        evaluatorId: judgment.evaluatorId, evaluatorVersion: judgment.evaluatorVersion,
        inputChecksum: judgment.inputChecksum, output: judgment.output,
        outputChecksum: judgment.outputChecksum };
      row.judgmentChecksum = contentHash({ finalKey, phase, evaluatorId: row.evaluatorId,
        evaluatorVersion: row.evaluatorVersion, inputChecksum: row.inputChecksum,
        output: row.output, outputChecksum: row.outputChecksum });
      judgments.push(row);
    }
    const finalRow = { schemaVersion: 2, recordType: 'final', runId, finalKey,
      value, valueChecksum: final.checksum, executionChecksum: execution.executionChecksum,
      finalizedAt: final.finalizedAt };
    finals.push(finalRow);
  }
  rows.push(...executions, ...phases, ...calls, ...judgments, ...finals);
  const recordCounts = {
    run: 1, execution: executions.length, phase: phases.length,
    modelCall: calls.length, judgment: judgments.length, final: finals.length
  };
  const recordsChecksum = contentHash(rows);
  rows.push({ schemaVersion: 2, recordType: 'provenance', runId, recordCounts,
    recordsChecksum, provenanceChecksum: contentHash({ runId, headerChecksum: run.headerChecksum,
      recordCounts, recordsChecksum }) });
  return rows;
}

export function exportQualityReplayV2(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['sourceRootDir', 'ledgerPath', 'runAuthority', 'runId', 'artifactPath'].includes(key))) {
    throw new Error('quality replay v2 exporter option conflict');
  }
  const { ledgerPath, runId, artifactPath, runAuthority,
    sourceRootDir = process.cwd() } = options;
  if (!runAuthority) throw new Error('quality replay v2 branded run authority required');
  assertQualityRunAuthority(runAuthority);
  const productionConfig = qualityRunAuthorityProductionConfig(runAuthority);
  const requestedLedgerPath = typeof ledgerPath === 'string' && ledgerPath
    ? resolve(sourceRootDir, ledgerPath) : null;
  const authorityLedgerPath = typeof productionConfig.ledgerPath === 'string'
    ? resolve(sourceRootDir, productionConfig.ledgerPath) : null;
  const canonicalLedgerPath = value => {
    if (!value) return null;
    const absolute = resolve(value);
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  };
  if (!requestedLedgerPath || canonicalLedgerPath(requestedLedgerPath)
    !== canonicalLedgerPath(authorityLedgerPath)
    || runId !== productionConfig.runId) {
    throw new Error('quality replay v2 ledger authority conflict');
  }
  if (typeof artifactPath !== 'string' || !artifactPath) throw new Error('quality replay v2 artifact path required');
  assertProductionArtifactPath(sourceRootDir, artifactPath);
  const ledger = openProductionQualityReplayLedger({ filename: ledgerPath, runAuthority,
    readOnly: true, sourceRootDir });
  try {
    const rows = buildQualityReplayV2RowsFromLedger({ ledger, runId, finalKeys: productionConfig.finalKeys });
    const validated = validateQualityReplayV2Rows({ rows, plan: { finalKeys: productionConfig.finalKeys }, expectedHeader: rows[0].header });
    const text = canonicalQualityReplayV2Jsonl({ rows: validated.rows, plan: { finalKeys: productionConfig.finalKeys } });
    writeAtomicText(artifactPath, text);
    return { artifactPath, evidenceClass: 'production', evidenceEligible: true,
      run: validated.run, provenance: validated.provenance, executions: validated.executions,
      phases: validated.phases, modelCalls: validated.modelCalls, judgments: validated.judgments,
      finals: validated.finals };
  } finally { ledger.close(); }
}

// Compatibility name now resolves only to the branded v2 production exporter.
export function exportQualityReplayArtifact(options = {}) {
  return exportQualityReplayV2(options);
}

export function appendQualityReplayArtifact({ artifactPath, result } = {}) {
  if (typeof artifactPath !== 'string' || !artifactPath) throw new Error('replay artifact path required');
  if (!result || !FIXTURE_REPLAY_RESULT_BRAND.has(result) || result.evidenceClass !== 'fixture'
    || !Array.isArray(result.attempts) || !Array.isArray(result.finalized)
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
  writeAtomicText(artifactPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return { artifactPath, evidenceClass: 'legacy_structural', evidenceEligible: false };
}

const CLI_VALUE_OPTIONS = new Map([
  ['--root', 'root'],
  ['--stable-from', 'stableFrom'],
  ['--candidate-preset', 'candidatePreset'],
  ['--history', 'history'],
  ['--history-manifest', 'historyManifest'],
  ['--plan', 'plan'],
  ['--plan-out', 'planOut'],
  ['--execution-config', 'executionConfig'],
  ['--ledger', 'ledger'],
  ['--resume-run', 'resumeRun'],
  ['--only-final-key', 'onlyFinalKey'],
  ['--replay-out', 'replayOut']
]);

/** Parse the production CLI as a closed, duplicate-free option set. */
export function parseQualityReplayCliArgs(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv)) throw new Error('quality replay CLI arguments required');
  const result = { execute: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new Error(`unknown quality replay argument: ${String(token)}`);
    }
    if (seen.has(token)) throw new Error(`duplicate quality replay option: ${token}`);
    seen.add(token);
    if (token === '--execute') {
      result.execute = true;
      continue;
    }
    if (token === '--max-items') {
      throw new Error('--max-items is forbidden in production quality replay');
    }
    const key = CLI_VALUE_OPTIONS.get(token);
    if (!key) throw new Error(`unknown quality replay option: ${token}`);
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`${token} requires a value`);
    }
    result[key] = value;
    index += 1;
  }
  if (result.resumeRun && !result.ledger) throw new Error('--resume-run requires --ledger');
  if (result.onlyFinalKey && !result.ledger) throw new Error('--only-final-key requires --ledger');
  if (result.execute && !result.ledger) throw new Error('--execute requires --ledger');
  return result;
}

/**
 * Production execution may keep the historical offline flags in the global
 * parser, but none of those inputs may be read alongside the branded
 * authority path.  Call this immediately after parsing, before loading a
 * plan/history or touching any ledger/artifact path.
 */
export function assertProductionExecuteCliArgs(cli) {
  if (!cli || cli.execute !== true) return true;
  for (const key of ['stableFrom', 'candidatePreset', 'history', 'historyManifest', 'planOut']) {
    if (cli[key] !== undefined) throw new Error(`production --execute forbids legacy option: ${key}`);
  }
  if (typeof cli.plan !== 'string' || !cli.plan
    || typeof cli.executionConfig !== 'string' || !cli.executionConfig
    || typeof cli.ledger !== 'string' || !cli.ledger) {
    throw new Error('production --execute requires existing --plan, --execution-config and --ledger');
  }
  return true;
}

export function productionLedgerAuthorityPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')
    || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('production quality ledger path conflict');
  }
  return value;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  (async () => {
    let executing = false;
    try {
      const cli = parseQualityReplayCliArgs();
      executing = cli.execute;
      assertProductionExecuteCliArgs(cli);
      const rootDir = cli.root || process.cwd();
      const stableFrom = cli.stableFrom;
      const candidatePreset = cli.candidatePreset;
      const execute = cli.execute;
      const historyScenes = loadLocalHistoryScenes({ rootDir, path: cli.history });
      const historyManifest = loadLocalHistoryManifest({ rootDir, path: cli.historyManifest });
      const plan = cli.plan
        ? loadQualityReplayPlanArtifact({
          artifactPath: resolve(rootDir, cli.plan),
          rootDir,
          historyScenes,
          historyManifest
        })
        : createQualityReplayPlan({ rootDir, historyScenes, historyManifest });
      const planPath = resolve(rootDir, cli.planOut
        || 'artifacts/yuqi-lived-agency-v3/private/quality-replay-plan.json');
      assertProductionArtifactPath(rootDir, planPath);
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
      if (!cli.plan) throw new Error('--execute requires an existing --plan artifact');
      if (!cli.executionConfig) throw new Error('--execution-config is required for execution');
      const authorityModule = await import(pathToFileURL(resolve(rootDir, cli.executionConfig)).href);
      const authorityFactory = authorityModule.createQualityReplayRunAuthority;
      if (typeof authorityFactory !== 'function') {
        throw new Error('createQualityReplayRunAuthority export required');
      }
      const runAuthority = await authorityFactory({ rootDir, plan,
        ledgerPath: productionLedgerAuthorityPath(cli.ledger),
        artifactPaths: {
          plan: cli.plan,
          ledger: cli.ledger,
          raw: cli.replayOut || 'artifacts/yuqi-lived-agency-v3/private/quality-replay.jsonl',
        },
        resumeRun: cli.resumeRun || null,
      });
      const result = await runQualityReplayPlan({
        plan,
        sourceRootDir: rootDir,
        ledgerPath: productionLedgerAuthorityPath(cli.ledger),
        runAuthority,
        selector: { onlyFinalKey: cli.onlyFinalKey || null },
        resumeRun: cli.resumeRun || null,
      });
      if (result.run?.state !== 'finalized') {
        process.stdout.write(`${JSON.stringify({
          version: 1, runId: result.runId, state: result.run?.state || 'open',
          eligible: false, productionReleaseMutation: false,
        }, null, 2)}\n`);
        return;
      }
      writeQualityReplayPlanArtifact(plan, planPath);
      const replayPath = resolve(rootDir, cli.replayOut
        || 'artifacts/yuqi-lived-agency-v3/private/quality-replay.jsonl');
      assertProductionArtifactPath(rootDir, replayPath);
      exportQualityReplayV2({ artifactPath: replayPath,
        ledgerPath: resolve(rootDir, cli.ledger), runId: result.runId,
        runAuthority,
        sourceRootDir: rootDir });
      process.stdout.write(`${JSON.stringify({
        version: 1,
        executed: true,
        runId: result.runId,
        planChecksum: plan.planChecksum,
        sourceHead: result.run.sourceHead,
        provenanceChecksum: contentHash({
          runId: result.run.runId,
          sourceHead: result.run.sourceHead,
          headerChecksum: result.run.headerChecksum,
        }),
        replayArtifact: replayPath,
        total: result.results.length,
        productionReleaseMutation: false,
        eligible: false,
        failedGates: ['MANUAL_REVIEW_REQUIRED']
      }, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        version: 1,
        eligible: false,
        productionReleaseMutation: false,
        failedGates: [executing ? 'QUALITY_REPLAY_EXECUTION_UNAVAILABLE' : 'ANNOTATION_EVIDENCE_OR_PLAN_UNAVAILABLE'],
        blockingReason: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`);
      process.exitCode = 2;
    }
  })();
}
