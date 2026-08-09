import { canonicalJson, contentHash } from './protocol.mjs';
import { assertVerifiedExpectedFinalKeys } from './quality-replay.mjs';
import { COMPARISON_CRITICAL_CODES } from './comparison-evaluator.mjs';

export const QUALITY_DIMENSIONS = Object.freeze([
  'socialUnderstanding',
  'agency',
  'relationshipParticipation',
  'stateContinuityFlexibility',
  'livedExpression',
  'actionFactIntegrity'
]);

const TERMINAL_DISPOSITIONS = new Set(['visible', 'action_only', 'skip']);
const SCENE_ANNOTATION_KEYS = new Set([
  'sceneId', 'severity', 'focus', 'turns', 'requiredChecks', 'allowedVariation'
]);
const OUTPUT_KEYS = new Set(['terminalDisposition', 'replyParts', 'actions']);
const REPLY_PART_KEYS = new Set(['ordinal', 'type', 'text', 'content']);
const ACTION_KEYS = new Set(['ordinal', 'kind', 'payload']);
const SCORE_KEYS = new Set(QUALITY_DIMENSIONS);
const SCENE_TURN_KEYS = new Set(['at', 'speaker', 'batch', 'event']);
const SCENE_BATCH_KEYS = new Set([
  'messageId', 'type', 'text', 'amount', 'currency', 'feature', 'featureText', 'attachments'
]);
const SCENE_ATTACHMENT_KEYS = new Set(['kind', 'name', 'bytes', 'width', 'height']);
const ACTION_PAYLOAD_KEYS = new Set([
  'actionId', 'targetKey', 'targetRevision', 'messageId', 'characterId', 'roleId', 'sceneId',
  'content', 'text', 'amount', 'currency', 'reason', 'stage', 'kind', 'value', 'ordinal'
]);
const FINDING_KEYS = new Set(['code', 'severity', 'owner', 'summary', 'critical']);
const FINAL_EVIDENCE_KEYS = new Set([
  'layer', 'sceneId', 'repeatIndex', 'finalized', 'scores', 'preference', 'regression',
  'severe', 'tie', 'unresolved', 'structuralRegression', 'protocolFailure', 'findings', 'attempts',
  'executionChecksum', 'latencyMs', 'evaluatorVersion'
]);
const ATTEMPT_KEYS = new Set([
  'attemptIndex', 'evaluatorId', 'accepted', 'unresolved',
  'executionChecksum', 'latencyMs', 'evaluatorVersion'
]);

function assertPlainObject(value, message) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message);
  }
}

function assertClosedKeys(value, allowed, message) {
  assertPlainObject(value, message);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${message}: unknown key ${key}`);
  }
}

function assertNativeSafeInteger(value, message, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(message);
}

function projectClosedValue(value, allowedKeys, message) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${message}: non-finite number`);
    return value;
  }
  if (Array.isArray(value)) return value.map(item => projectClosedValue(item, allowedKeys, message));
  assertClosedKeys(value, allowedKeys, message);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    projectClosedValue(nested, allowedKeys, message)
  ]));
}

function identityFreeReplyPart(value) {
  assertClosedKeys(value, REPLY_PART_KEYS, 'blind reply part shape');
  assertNativeSafeInteger(value.ordinal, 'blind reply part ordinal');
  if (typeof value.type !== 'string' || typeof value.text !== 'string') {
    throw new Error('blind reply part type/text');
  }
  return { ordinal: value.ordinal, type: value.type, text: value.text };
}

function identityFreeAction(value) {
  assertClosedKeys(value, ACTION_KEYS, 'blind action shape');
  assertNativeSafeInteger(value.ordinal, 'blind action ordinal');
  if (typeof value.kind !== 'string') throw new Error('blind action kind');
  if (value.payload === undefined) throw new Error('blind action payload');
  return {
    ordinal: value.ordinal,
    kind: value.kind,
    payload: projectClosedValue(value.payload, ACTION_PAYLOAD_KEYS, 'blind action payload')
  };
}

function identityFreeOutput(value) {
  assertClosedKeys(value, OUTPUT_KEYS, 'blind output shape');
  if (typeof value.terminalDisposition !== 'string'
    || !TERMINAL_DISPOSITIONS.has(value.terminalDisposition)) {
    throw new Error('blind output terminal disposition');
  }
  if (!Array.isArray(value.replyParts) || !Array.isArray(value.actions)) {
    throw new Error('blind output parts/actions');
  }
  return {
    terminalDisposition: value.terminalDisposition,
    replyParts: value.replyParts.map(identityFreeReplyPart),
    actions: value.actions.map(identityFreeAction)
  };
}

function normalizeBlindFinding(value) {
  assertClosedKeys(value, FINDING_KEYS, 'blind finding shape');
  if (typeof value.code !== 'string' || !value.code
    || typeof value.severity !== 'string' || !['critical', 'warning', 'info'].includes(value.severity)
    || typeof value.owner !== 'string' || !value.owner
    || typeof value.summary !== 'string'
    || typeof value.critical !== 'boolean') {
    throw new Error('blind finding native shape');
  }
  return {
    code: value.code,
    severity: value.severity,
    owner: value.owner,
    summary: value.summary,
    critical: value.critical
  };
}

function deterministicSwap({ sceneId, repeatIndex, evaluationSeed }) {
  const digest = contentHash({ sceneId, repeatIndex, evaluationSeed });
  return Number.parseInt(digest.slice(-2), 16) % 2 === 0;
}

function projectSceneAnnotation(value) {
  assertClosedKeys(value, SCENE_ANNOTATION_KEYS, 'blind scene annotation');
  if (typeof value.sceneId !== 'string' || !value.sceneId) throw new Error('blind scene id');
  if (!['critical', 'high', 'medium'].includes(value.severity)) {
    throw new Error('blind scene severity');
  }
  if (typeof value.focus !== 'string') throw new Error('blind scene focus');
  if (!Array.isArray(value.turns)) throw new Error('blind scene turns');
  const turns = value.turns.map((turn, turnIndex) => {
    assertClosedKeys(turn, SCENE_TURN_KEYS, `blind scene turn ${turnIndex}`);
    const projected = {};
    if (turn.at !== undefined) {
      if (typeof turn.at !== 'string') throw new Error(`blind scene turn ${turnIndex} at`);
      projected.at = turn.at;
    }
    if (turn.speaker !== undefined) {
      if (typeof turn.speaker !== 'string') throw new Error(`blind scene turn ${turnIndex} speaker`);
      projected.speaker = turn.speaker;
    }
    if (turn.event !== undefined) {
      if (typeof turn.event !== 'string') throw new Error(`blind scene turn ${turnIndex} event`);
      projected.event = turn.event;
    }
    if (turn.batch !== undefined) {
      if (!Array.isArray(turn.batch)) throw new Error(`blind scene turn ${turnIndex} batch`);
      projected.batch = turn.batch.map((item, itemIndex) => {
        assertClosedKeys(item, SCENE_BATCH_KEYS, `blind scene batch ${turnIndex}:${itemIndex}`);
        const batch = {};
        for (const key of ['type', 'text', 'currency', 'feature', 'featureText']) {
          if (item[key] !== undefined) {
            if (typeof item[key] !== 'string') throw new Error(`blind scene batch ${key}`);
            batch[key] = item[key];
          }
        }
        if (item.amount !== undefined) {
          if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) {
            throw new Error('blind scene batch amount');
          }
          batch.amount = item.amount;
        }
        if (item.attachments !== undefined) {
          if (!Array.isArray(item.attachments)) throw new Error('blind scene batch attachments');
          batch.attachments = item.attachments.map((attachment, attachmentIndex) => {
            assertClosedKeys(attachment, SCENE_ATTACHMENT_KEYS,
              `blind scene attachment ${turnIndex}:${itemIndex}:${attachmentIndex}`);
            const output = {};
            for (const key of ['kind', 'name']) {
              if (attachment[key] !== undefined) {
                if (typeof attachment[key] !== 'string') throw new Error('blind scene attachment text');
                output[key] = attachment[key];
              }
            }
            for (const key of ['bytes', 'width', 'height']) {
              if (attachment[key] !== undefined) assertNativeSafeInteger(
                attachment[key], 'blind scene attachment integer'
              );
            }
            return output;
          });
        }
        return batch;
      });
    }
    return projected;
  });
  const projectChecks = (items, name) => {
    if (!Array.isArray(items)) throw new Error(`blind scene ${name}`);
    return items.map((item, index) => {
      if (typeof item === 'string') return item;
      assertClosedKeys(item, new Set(['code', 'description']), `blind scene ${name} ${index}`);
      if (typeof item.code !== 'string' || typeof item.description !== 'string') {
        throw new Error(`blind scene ${name} ${index}`);
      }
      return { code: item.code, description: item.description };
    });
  };
  return {
    sceneId: value.sceneId,
    severity: value.severity,
    focus: value.focus,
    turns,
    requiredChecks: projectChecks(value.requiredChecks === undefined ? [] : value.requiredChecks, 'required checks'),
    allowedVariation: projectChecks(value.allowedVariation === undefined ? [] : value.allowedVariation, 'allowed variation')
  };
}

/** Normalize a blinded evaluator response without introducing release identity. */
export function normalizeBlindEvaluation(value) {
  assertClosedKeys(value, new Set(['version', 'scores', 'preference', 'findings', 'unresolved']),
    'blind evaluation shape');
  if (value.version !== 1) throw new Error('blind evaluation version');
  assertClosedKeys(value.scores, SCORE_KEYS, 'blind evaluation scores');
  const scores = {};
  for (const dimension of QUALITY_DIMENSIONS) {
    const score = value.scores[dimension];
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new Error(`blind evaluation score ${dimension}`);
    }
    scores[dimension] = score;
  }
  if (!['A', 'B', 'candidate', 'stable', 'tie', 'unresolved'].includes(value.preference)) {
    throw new Error('blind evaluation preference');
  }
  if (!Array.isArray(value.findings) || typeof value.unresolved !== 'boolean') {
    throw new Error('blind evaluation finding shape');
  }
  return {
    version: 1,
    scores,
    preference: value.preference,
    findings: value.findings.map(normalizeBlindFinding),
    unresolved: value.unresolved
  };
}

/**
 * Build the only model-facing blind input. Release IDs/checksums and execution
 * metadata remain outside this closed projection.
 */
export function projectBlindEvaluationInput(pair, { seed }) {
  assertClosedKeys(pair, new Set([
    'sceneId', 'repeatIndex', 'evaluationSeed', 'sceneAnnotation', 'stable', 'candidate'
  ]), 'blind evaluation input shape');
  if (typeof pair.sceneId !== 'string' || !pair.sceneId) throw new Error('blind scene id');
  assertNativeSafeInteger(pair.repeatIndex, 'blind repeat index');
  assertNativeSafeInteger(seed, 'blind evaluation seed');
  if (pair.sceneAnnotation?.sceneId !== pair.sceneId) throw new Error('blind scene id mismatch');
  const sceneAnnotation = projectSceneAnnotation(pair.sceneAnnotation);
  const sides = [
    { label: 'A', value: pair.stable?.output },
    { label: 'B', value: pair.candidate?.output }
  ];
  if (!pair.stable || !pair.candidate) throw new Error('blind pair releases');
  const projected = sides.map(side => ({
    label: side.label,
    ...identityFreeOutput(side.value)
  }));
  if (!Number.isSafeInteger(pair.evaluationSeed) || pair.evaluationSeed < 0) {
    throw new Error('blind evaluation seed');
  }
  if (deterministicSwap({
    sceneId: pair.sceneId,
    repeatIndex: pair.repeatIndex,
    evaluationSeed: pair.evaluationSeed
  })) projected.reverse();
  return {
    version: 1,
    sceneAnnotation,
    dimensions: [...QUALITY_DIMENSIONS],
    outputs: projected
  };
}

/** Compile a Task 21 scene into the single ReleaseExecutor input shape. */
export function compileSceneExecutionInput(scene) {
  assertPlainObject(scene, 'quality scene input');
  if (typeof scene.sceneId !== 'string' || !scene.sceneId || !Array.isArray(scene.turns)) {
    throw new Error('quality scene input shape');
  }
  if (typeof scene.rolloutKey !== 'string' || !scene.rolloutKey) {
    throw new Error('quality scene rollout key');
  }
  const execution = {
    version: 1,
    sceneId: scene.sceneId,
    turnKind: scene.rolloutKey,
    turns: scene.turns,
    context: scene.context || {},
    stateCheckpoint: scene.initialState || {},
    structuredActionTargets: scene.requiredActionIntegrity || {}
  };
  return JSON.parse(canonicalJson(execution));
}

/** Execute stable and candidate through the same dry-run ReleaseExecutor. */
export async function runScenePair(execution, pair) {
  assertPlainObject(execution, 'quality execution input');
  if (!pair?.executor || typeof pair.executor.executeTurn !== 'function') {
    throw new Error('quality release executor required');
  }
  if (!pair.stable?.releaseId || !pair.candidate?.releaseId) {
    throw new Error('quality release pair required');
  }
  const executionChecksum = contentHash(execution);
  const capabilities = Object.freeze({ visible: false, actions: false });
  const [stableRaw, candidateRaw] = await Promise.all([
    pair.executor.executeTurn({
      releaseId: pair.stable.releaseId,
      releaseChecksum: pair.stable.releaseChecksum,
      execution,
      dryRun: true,
      capabilities
    }),
    pair.executor.executeTurn({
      releaseId: pair.candidate.releaseId,
      releaseChecksum: pair.candidate.releaseChecksum,
      execution,
      dryRun: true,
      capabilities
    })
  ]);
  const stable = {
    dryRun: true,
    releaseId: pair.stable.releaseId,
    releaseChecksum: pair.stable.releaseChecksum,
    draft: stableRaw?.draft ?? stableRaw
  };
  const candidate = {
    dryRun: true,
    releaseId: pair.candidate.releaseId,
    releaseChecksum: pair.candidate.releaseChecksum,
    draft: candidateRaw?.draft ?? candidateRaw
  };
  return {
    execution,
    executionChecksum,
    stableInputChecksum: executionChecksum,
    candidateInputChecksum: executionChecksum,
    stable,
    candidate
  };
}

function evidenceKey(row) {
  return `${row.layer}:${row.sceneId}:${row.repeatIndex}`;
}

function validateFinalEvidence(rows, layer, expectedCount, seen, expectedSceneIds, expectedFinalKeys) {
  if (!Array.isArray(rows) || rows.length !== expectedCount) return false;
  if (expectedSceneIds !== undefined) {
    if (!Array.isArray(expectedSceneIds) || expectedSceneIds.length !== expectedCount) return false;
    const expected = [...expectedSceneIds].sort();
    const actual = rows.map(row => row?.sceneId).sort();
    if (expected.some((sceneId, index) => sceneId !== actual[index])) return false;
  }
  if (expectedFinalKeys !== undefined) {
    if (!Array.isArray(expectedFinalKeys) || expectedFinalKeys.length !== expectedCount) return false;
    const expected = [...expectedFinalKeys].sort();
    const actual = rows.map(evidenceKey).sort();
    if (expected.some((key, index) => key !== actual[index])) return false;
  }
  for (const row of rows) {
    if (!row || row.layer !== layer || typeof row.sceneId !== 'string' || !row.sceneId
      || !Number.isSafeInteger(row.repeatIndex) || row.repeatIndex < 0 || row.finalized !== true) {
      return false;
    }
    if (Object.keys(row).some(key => !FINAL_EVIDENCE_KEYS.has(key))) return false;
    const key = evidenceKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      assertClosedKeys(row.scores, SCORE_KEYS, 'quality evidence scores');
      for (const dimension of QUALITY_DIMENSIONS) {
        const score = row.scores[dimension];
        if (!Number.isInteger(score) || score < 1 || score > 5) return false;
      }
    } catch {
      return false;
    }
    if (row.findings !== undefined) {
      if (!Array.isArray(row.findings)) return false;
      try {
        row.findings.map(normalizeBlindFinding);
      } catch {
        return false;
      }
    }
    if (row.unresolved === true) return false;
    if (!Array.isArray(row.attempts) || row.attempts.length === 0) return false;
    {
      const indexes = row.attempts.map(attempt => attempt?.attemptIndex);
      if (indexes.some(index => !Number.isSafeInteger(index) || index < 0)
        || new Set(indexes).size !== indexes.length
        || indexes.some((index, position) => index !== position)) return false;
      let acceptedCount = 0;
      for (const attempt of row.attempts) {
        if (!attempt || Object.keys(attempt).some(key => !ATTEMPT_KEYS.has(key))
          || typeof attempt.evaluatorId !== 'string' || !attempt.evaluatorId
          || typeof attempt.accepted !== 'boolean' || typeof attempt.unresolved !== 'boolean'
          || (attempt.accepted && attempt.unresolved)) return false;
        if (attempt.accepted) acceptedCount += 1;
        if (!attempt.accepted && !attempt.unresolved) return false;
        if (attempt.executionChecksum !== undefined && !/^[0-9a-f]{64}$/.test(attempt.executionChecksum)) return false;
        if (attempt.latencyMs !== undefined && (!Number.isSafeInteger(attempt.latencyMs) || attempt.latencyMs < 0)) return false;
        if (attempt.evaluatorVersion !== undefined
          && (typeof attempt.evaluatorVersion !== 'string' || !attempt.evaluatorVersion)) return false;
      }
      if (acceptedCount !== 1) return false;
    }
    if (row.executionChecksum !== undefined && !/^[0-9a-f]{64}$/.test(row.executionChecksum)) return false;
    if (row.latencyMs !== undefined && (!Number.isSafeInteger(row.latencyMs) || row.latencyMs < 0)) return false;
    if (row.evaluatorVersion !== undefined
      && (typeof row.evaluatorVersion !== 'string' || !row.evaluatorVersion)) return false;
  }
  return true;
}

export function validateExactEvidenceSet(evidence, expected = null) {
  if (!expected || !Array.isArray(expected.sentinelFinalKeys)
    || !Array.isArray(expected.coverageFinalKeys)
    || !Array.isArray(expected.historyFinalKeys)) {
    return { ok: false, count: 0 };
  }
  const seen = new Set();
  const ok = validateFinalEvidence(
    evidence?.sentinelRuns,
    'sentinel',
    expected.sentinelFinalKeys?.length ?? expected.sentinelSceneIds?.length ?? expected.sentinelRuns,
    seen,
    expected.sentinelSceneIds,
    expected.sentinelFinalKeys
  )
    && validateFinalEvidence(
      evidence?.coverageRuns,
      'coverage',
      expected.coverageFinalKeys?.length ?? expected.coverageSceneIds?.length ?? expected.coverageRuns,
    seen,
      expected.coverageSceneIds,
      expected.coverageFinalKeys
    )
    && validateFinalEvidence(
      evidence?.historyRuns,
      'history',
      expected.historyFinalKeys?.length ?? expected.historySceneIds?.length ?? expected.historyRuns,
    seen,
      expected.historySceneIds,
      expected.historyFinalKeys
    );
  return { ok, count: seen.size };
}

function allEvidence(evidence) {
  return [
    ...(evidence?.sentinelRuns || []),
    ...(evidence?.coverageRuns || []),
    ...(evidence?.historyRuns || [])
  ];
}

function preferenceKind(row) {
  if (row.preference === 'candidate' || row.preference === 'B') return 'candidate';
  if (row.preference === 'stable' || row.preference === 'A') return 'stable';
  return row.preference === 'tie' ? 'tie' : 'unresolved';
}

export function summarizeEvidence(evidence) {
  const rows = allEvidence(evidence);
  const hasCriticalFinding = row => (row.findings || []).some(finding =>
    finding?.critical === true || finding?.severity === 'critical');
  const hasScoreOne = row => Object.values(row.scores || {}).some(score => score === 1);
  const hasProtocolFinding = row => (row.findings || [])
    .some(finding => COMPARISON_CRITICAL_CODES.includes(finding?.code));
  const dimensionAverages = QUALITY_DIMENSIONS.map(dimension => {
    const values = rows.map(row => row.scores?.[dimension]).filter(Number.isInteger);
    return {
      dimension,
      average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN
    };
  });
  const candidateWins = rows.filter(row => preferenceKind(row) === 'candidate').length;
  const stableWins = rows.filter(row => preferenceKind(row) === 'stable').length;
  const ties = rows.filter(row => preferenceKind(row) === 'tie').length;
  const unresolved = rows.filter(row => preferenceKind(row) === 'unresolved' || row.unresolved === true).length;
  const completedPairs = candidateWins + stableWins;
  return {
    protocolFailures: rows.filter(hasProtocolFinding).length,
    sentinelSevereFailureCount: (evidence?.sentinelRuns || [])
      .filter(row => hasCriticalFinding(row) || hasScoreOne(row)).length,
    dimensionAverages,
    scoreOneCount: rows.reduce((count, row) => count + QUALITY_DIMENSIONS
      .filter(dimension => row.scores?.[dimension] === 1).length, 0),
    candidatePreferredRate: completedPairs ? candidateWins / completedPairs : 0,
    regressionRate: rows.length ? stableWins / rows.length : 1,
    tieOrUnresolvedRate: rows.length ? (ties + unresolved) / rows.length : 1,
    structuralRegressionCount: rows.filter(row => row.structuralRegression === true).length,
    candidateWins,
    stableWins,
    tieCount: ties,
    unresolvedCount: unresolved,
    completedPairs
  };
}

export function aggregateQualityGate(evidence, expected = null) {
  const projection = assertVerifiedExpectedFinalKeys(expected);
  const completeness = validateExactEvidenceSet(evidence, projection.finalKeys);
  const summary = summarizeEvidence(evidence);
  const failedGates = [
    !completeness.ok && 'INCOMPLETE_QUALITY_EVIDENCE',
    summary.protocolFailures > 0 && 'PROTOCOL_REGRESSION',
    summary.sentinelSevereFailureCount > 0 && 'SENTINEL_SEVERE_FAILURE',
    summary.dimensionAverages.some(item => !Number.isFinite(item.average) || item.average < 4)
      && 'DIMENSION_BELOW_FOUR',
    summary.scoreOneCount > 0 && 'SEVERE_SCORE_ONE',
    summary.candidatePreferredRate < 0.60 && 'PREFERENCE_BELOW_SIXTY_PERCENT',
    summary.regressionRate > 0.10 && 'REGRESSION_ABOVE_TEN_PERCENT',
    summary.tieOrUnresolvedRate > 0.20 && 'TOO_MANY_UNRESOLVED_PAIRS',
    summary.structuralRegressionCount > 0 && 'STRUCTURAL_REGRESSION'
  ].filter(Boolean);
  return { ...summary, evidenceCount: completeness.count, failedGates, eligible: failedGates.length === 0 };
}

export function buildBlindEvaluation(pair, { seed }) {
  const input = projectBlindEvaluationInput({
    sceneId: pair.sceneId || 'quality-scene',
    repeatIndex: pair.repeatIndex || 0,
    evaluationSeed: seed,
    sceneAnnotation: pair.sceneAnnotation || {
      sceneId: pair.sceneId || 'quality-scene',
      severity: 'high',
      focus: 'quality evaluation',
      turns: []
    },
    stable: pair.stable,
    candidate: pair.candidate
  }, { seed });
  return { ...input, labels: input.outputs.map(output => output.label) };
}
