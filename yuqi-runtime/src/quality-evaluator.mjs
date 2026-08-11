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
const QUALITY_TURN_KINDS = new Set([
  'DIRECT_REPLY',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);
const QUALITY_SUBJECT_KEYS = new Set([
  'version', 'subjectType', 'finalKey', 'turnKind', 'semanticInput',
  'semanticInputChecksum', 'blindAnnotation', 'planningWindow'
]);
const TURN_RAW_OUTPUT_KEYS = new Set(['subjectType', 'terminalDisposition', 'replyParts', 'actions']);
const LIFE_RAW_OUTPUT_KEYS = new Set(['subjectType', 'episodes']);
const LIFE_EPISODE_KEYS = new Set(['ordinal', 'episodeId', 'kind', 'title', 'startAt', 'endAt']);
const PLANNING_WINDOW_KEYS = new Set(['startAt', 'targetEndAt']);
const LIFE_PLANNING_WINDOW_MS = 12 * 60 * 60 * 1000;
export const LIFE_DIMENSION_RUBRIC = Object.freeze({
  socialUnderstanding: 'do not hard-code one interpretation of an ambiguous conversation',
  agency: 'preserve a coherent independent routine',
  relationshipParticipation: 'avoid unearned service promises or invented history',
  stateContinuityFlexibility: 'preserve temporal continuity',
  livedExpression: 'avoid template-like planning',
  actionFactIntegrity: 'preserve episode integrity and remain silent when required'
});

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

function assertPlanningWindow(value) {
  assertClosedKeys(value, PLANNING_WINDOW_KEYS, 'life planning window');
  assertNativeSafeInteger(value.startAt, 'life planning window startAt');
  assertNativeSafeInteger(value.targetEndAt, 'life planning window targetEndAt');
  if (value.targetEndAt - value.startAt !== LIFE_PLANNING_WINDOW_MS) {
    throw new Error('life planning window interval');
  }
  return { startAt: value.startAt, targetEndAt: value.targetEndAt };
}

function planningWindowForScene(scene) {
  if (!Array.isArray(scene.turns)) throw new Error('life planning scene turns');
  const anchors = scene.turns.filter(turn =>
    turn?.speaker === 'system' && turn?.event === 'candidate_response'
  );
  if (anchors.length !== 1 || typeof anchors[0].at !== 'string') {
    throw new Error('life planning requires one candidate_response anchor');
  }
  const anchorAt = Date.parse(anchors[0].at);
  if (!Number.isSafeInteger(anchorAt) || anchorAt < 0) {
    throw new Error('life planning candidate_response timestamp');
  }
  return { startAt: anchorAt, targetEndAt: anchorAt + LIFE_PLANNING_WINDOW_MS };
}

function planningWindowForSubject(subject) {
  const window = subject.planningWindow || subject.semanticInput?.planningWindow;
  if (!window) throw new Error('life planning window is required');
  return assertPlanningWindow(window);
}

function assertNoNonEmptyAttachments(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('quality scene contains cyclic input');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoNonEmptyAttachments(item, seen);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'attachments') {
        const empty = nested === null || (Array.isArray(nested) && nested.length === 0);
        if (!empty) throw new Error('quality plan attachment-bearing input is unsupported');
      }
      assertNoNonEmptyAttachments(nested, seen);
    }
  }
  seen.delete(value);
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
    || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    || typeof value.severity !== 'string' || !['critical', 'warning', 'info'].includes(value.severity)
    || typeof value.owner !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.owner)
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
  if (!['A', 'B', 'tie', 'unresolved'].includes(value.preference)) {
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

// The evaluator request schema is exported from the same closed contract used
// by normalizeBlindEvaluation.  Production bridges must pass this exact
// schema to Codex; callers may not invent a second evaluator shape.
export const QUALITY_BLIND_EVALUATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['version', 'scores', 'preference', 'findings', 'unresolved'],
  properties: Object.freeze({
    version: { type: 'integer', const: 1 },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: Object.freeze([...QUALITY_DIMENSIONS]),
      properties: Object.freeze(Object.fromEntries(
        QUALITY_DIMENSIONS.map(dimension => [dimension, { type: 'integer', minimum: 1, maximum: 5 }])
      )),
    },
    preference: { type: 'string', enum: Object.freeze(['A', 'B', 'tie', 'unresolved']) },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'severity', 'owner', 'summary', 'critical'],
        properties: {
          code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
          severity: { type: 'string', enum: Object.freeze(['critical', 'warning', 'info']) },
          owner: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
          summary: { type: 'string' },
          critical: { type: 'boolean' },
        },
      },
    },
    unresolved: { type: 'boolean' },
  }),
});

/**
 * Close the two independent blinded judgments without exposing release-side
 * identity. Both complete normalized judgments are retained; any semantic
 * disagreement requires manual review instead of silently selecting a side.
 */
export function finalizeBlindJudgments(primary, secondary) {
  const first = normalizeBlindEvaluation(primary);
  const second = normalizeBlindEvaluation(secondary);
  const differences = [];
  if (contentHash(first.scores) !== contentHash(second.scores)) differences.push('scores');
  if (first.preference !== second.preference) differences.push('preference');
  if (first.unresolved !== second.unresolved) differences.push('unresolved');
  if (contentHash(first.findings) !== contentHash(second.findings)) differences.push('findings');
  return {
    version: 1,
    judgments: [first, second],
    scores: first.scores,
    preference: first.preference,
    unresolved: first.unresolved || second.unresolved,
    findings: first.findings,
    normalizedFindings: [first.findings, second.findings],
    differences,
    manualReview: differences.length > 0
  };
}

/**
 * Build the only model-facing blind input. Release IDs/checksums and execution
 * metadata remain outside this closed projection.
 */
export function projectBlindEvaluationInput(pair, { seed }) {
  assertClosedKeys(pair, new Set([
    'subjectType', 'planningWindow', 'sceneId', 'repeatIndex', 'evaluationSeed',
    'sceneAnnotation', 'stable', 'candidate'
  ]), 'blind evaluation input shape');
  if (typeof pair.sceneId !== 'string' || !pair.sceneId) throw new Error('blind scene id');
  assertNativeSafeInteger(pair.repeatIndex, 'blind repeat index');
  assertNativeSafeInteger(seed, 'blind evaluation seed');
  const subjectType = pair.subjectType === undefined ? 'turn' : pair.subjectType;
  if (!['turn', 'life_planning'].includes(subjectType)) throw new Error('blind subject type');
  if (pair.sceneAnnotation?.sceneId !== pair.sceneId) throw new Error('blind scene id mismatch');
  const sceneAnnotation = projectSceneAnnotation(pair.sceneAnnotation);
  const sides = [
    { label: 'A', value: pair.stable?.output },
    { label: 'B', value: pair.candidate?.output }
  ];
  if (!pair.stable || !pair.candidate) throw new Error('blind pair releases');
  let projected = sides.map(side => ({
    label: side.label,
    ...(subjectType === 'turn'
      ? (() => {
        const normalized = normalizeQualityExecutionOutput({ subjectType }, side.value);
        return {
          terminalDisposition: normalized.terminalDisposition,
          replyParts: normalized.replyParts,
          actions: normalized.actions
        };
      })()
      : (() => {
        const normalized = normalizeQualityExecutionOutput({
          subjectType,
          planningWindow: pair.planningWindow
        }, side.value);
        return {
          episodes: normalized.episodes.map(({ ordinal, kind, title, startAt, endAt }) => ({
            ordinal, kind, title, startAt, endAt
          }))
        };
      })())
  }));
  if (!Number.isSafeInteger(pair.evaluationSeed) || pair.evaluationSeed < 0) {
    throw new Error('blind evaluation seed');
  }
  if (deterministicSwap({
    sceneId: pair.sceneId,
    repeatIndex: pair.repeatIndex,
    evaluationSeed: pair.evaluationSeed
  })) {
    projected = projected.reverse().map((output, index) => ({
      ...output,
      label: index === 0 ? 'A' : 'B'
    }));
  }
  return {
    version: 1,
    subjectType,
    sceneAnnotation,
    dimensions: [...QUALITY_DIMENSIONS],
    outputs: projected,
    ...(subjectType === 'life_planning'
      ? { dimensionRubric: JSON.parse(canonicalJson(LIFE_DIMENSION_RUBRIC)) }
      : {})
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

/** Map the closed quality subject union to its production execution method. */
export function executionMethodForSubject(subject) {
  assertPlainObject(subject, 'quality subject required');
  if (Object.keys(subject).some(key => !QUALITY_SUBJECT_KEYS.has(key))) {
    throw new Error('quality subject has unknown key');
  }
  if (subject.subjectType === 'turn') {
    if (typeof subject.turnKind !== 'string' || !QUALITY_TURN_KINDS.has(subject.turnKind)) {
      throw new Error('quality subject turn kind unsupported');
    }
    return 'executeTurn';
  }
  if (subject.subjectType === 'life_planning') {
    if (subject.turnKind !== 'LIFE_PLANNING') {
      throw new Error('quality subject life kind mismatch');
    }
    return 'executeLife';
  }
  throw new Error('quality subject type unsupported');
}

function normalizeLifeOutput(raw, planningWindow) {
  const window = assertPlanningWindow(planningWindow);
  assertClosedKeys(raw, LIFE_RAW_OUTPUT_KEYS, 'life planning output shape');
  if (raw.subjectType !== undefined && raw.subjectType !== 'life_planning') {
    throw new Error('life planning output subject type');
  }
  if (!Array.isArray(raw.episodes) || raw.episodes.length === 0) {
    throw new Error('life planning output episodes');
  }
  const episodeIds = new Set();
  const episodes = raw.episodes.map((episode, index) => {
    assertClosedKeys(episode, LIFE_EPISODE_KEYS, `life planning episode ${index}`);
    if (episode.ordinal !== index) throw new Error(`life planning episode ${index} ordinal`);
    if (typeof episode.episodeId !== 'string' || !episode.episodeId
      || typeof episode.kind !== 'string' || !episode.kind
      || typeof episode.title !== 'string' || !episode.title) {
      throw new Error(`life planning episode ${index} identity`);
    }
    if (episodeIds.has(episode.episodeId)) throw new Error('life planning episode identity duplicate');
    episodeIds.add(episode.episodeId);
    assertNativeSafeInteger(episode.startAt, `life planning episode ${index} startAt`);
    assertNativeSafeInteger(episode.endAt, `life planning episode ${index} endAt`);
    if (episode.endAt <= episode.startAt) throw new Error(`life planning episode ${index} interval`);
    if (episode.startAt < window.startAt || episode.endAt > window.targetEndAt) {
      throw new Error(`life planning episode ${index} outside planning window`);
    }
    return {
      ordinal: episode.ordinal,
      episodeId: episode.episodeId,
      kind: episode.kind,
      title: episode.title,
      startAt: episode.startAt,
      endAt: episode.endAt
    };
  });
  for (let index = 1; index < episodes.length; index += 1) {
    if (episodes[index].startAt < episodes[index - 1].endAt) {
      throw new Error('life planning episodes overlap or are unordered');
    }
  }
  return { subjectType: 'life_planning', episodes };
}

function normalizeTurnOutput(raw) {
  assertClosedKeys(raw, TURN_RAW_OUTPUT_KEYS, 'blind turn output shape');
  if (raw.subjectType !== undefined && raw.subjectType !== 'turn') {
    throw new Error('turn output subject type');
  }
  const { subjectType: ignored, ...output } = raw;
  return { subjectType: 'turn', ...identityFreeOutput(output) };
}

/** Normalize a production result into the subject's closed canonical output union. */
export function normalizeQualityExecutionOutput(subject, raw) {
  const method = executionMethodForSubject({
    ...subject,
    turnKind: subject.turnKind ?? (subject.subjectType === 'turn' ? 'DIRECT_REPLY' : 'LIFE_PLANNING')
  });
  const value = raw?.draft?.output ?? raw?.output ?? raw?.draft ?? raw;
  if (method === 'executeTurn') {
    return normalizeTurnOutput(value);
  }
  return normalizeLifeOutput(value, planningWindowForSubject(subject));
}

/** Compile a plan item into a closed, checksummed turn or life-planning subject. */
export function compileQualitySubject(item) {
  assertClosedKeys(item, new Set(['layer', 'sceneId', 'repeatIndex', 'scene']), 'quality subject item');
  if (typeof item.layer !== 'string' || !item.layer
    || typeof item.sceneId !== 'string' || !item.sceneId
    || !Number.isSafeInteger(item.repeatIndex) || item.repeatIndex < 0) {
    throw new Error('quality subject item identity');
  }
  assertPlainObject(item.scene, 'quality subject scene');
  if (item.scene.sceneId !== item.sceneId) throw new Error('quality subject scene id mismatch');
  assertNoNonEmptyAttachments(item.scene);
  const turnKind = item.scene.rolloutKey;
  if (typeof turnKind !== 'string'
    || (!QUALITY_TURN_KINDS.has(turnKind) && turnKind !== 'LIFE_PLANNING')) {
    throw new Error(`unsupported quality rollout kind ${turnKind}`);
  }
  const semanticBase = compileSceneExecutionInput(item.scene);
  const semanticInput = turnKind === 'LIFE_PLANNING'
    ? JSON.parse(canonicalJson({
      ...semanticBase,
      planningWindow: planningWindowForScene(item.scene)
    }))
    : semanticBase;
  const blindAnnotation = projectSceneAnnotation({
    sceneId: item.sceneId,
    severity: item.scene.severity,
    focus: item.scene.focus || '',
    turns: item.scene.turns,
    requiredChecks: item.scene.mustNotice || [],
    allowedVariation: item.scene.allowedPersonalityVariation || []
  });
  const subject = {
    version: 1,
    subjectType: turnKind === 'LIFE_PLANNING' ? 'life_planning' : 'turn',
    finalKey: `${item.layer}:${item.sceneId}:${item.repeatIndex}`,
    turnKind,
    semanticInput,
    semanticInputChecksum: contentHash(semanticInput),
    blindAnnotation
  };
  assertClosedKeys(subject, QUALITY_SUBJECT_KEYS, 'quality subject');
  return JSON.parse(canonicalJson(subject));
}

/** Execute stable and candidate through the same dry-run ReleaseExecutor. */
export async function runScenePair(execution, pair) {
  assertPlainObject(execution, 'quality execution input');
  const subjectAware = execution.subjectType !== undefined;
  const subject = subjectAware ? execution : {
    subjectType: 'turn',
    turnKind: execution.turnKind
  };
  const method = executionMethodForSubject(subject);
  const executionInput = subjectAware ? execution.semanticInput : execution;
  assertPlainObject(executionInput, 'quality semantic execution input');
  if (!pair?.executor || typeof pair.executor[method] !== 'function') {
    throw new Error('quality release executor required');
  }
  if (!pair.stable?.releaseId || !pair.candidate?.releaseId) {
    throw new Error('quality release pair required');
  }
  const executionChecksum = contentHash(executionInput);
  const capabilities = Object.freeze({ visible: false, actions: false });
  const invoke = release => pair.executor[method]({
    releaseId: release.releaseId,
    releaseChecksum: release.releaseChecksum,
    execution: executionInput,
    dryRun: true,
    capabilities
  });
  const stableRaw = await invoke(pair.stable);
  const candidateRaw = await invoke(pair.candidate);
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
    execution: executionInput,
    ...(subjectAware ? { subjectType: subject.subjectType, executionMethod: method } : {}),
    ...(subjectAware && subject.subjectType === 'life_planning'
      ? { planningWindow: executionInput.planningWindow }
      : {}),
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
    ...(pair.subjectType === undefined ? {} : { subjectType: pair.subjectType }),
    ...(pair.planningWindow === undefined ? {} : { planningWindow: pair.planningWindow }),
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
