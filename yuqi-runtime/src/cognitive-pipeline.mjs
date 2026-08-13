import {
  compileCognitionPacket,
  materializeBrainDraft,
  normalizeCognitionResult,
  normalizeExpressionResult
} from './cognition-contract.mjs';
import {
  compileCognitionPacketV3,
  compileExpressionBriefV3,
  materializeV3Draft,
  normalizeCognitionV3Result,
  normalizeExpressionV3Result
} from './cognition-v3-contract.mjs';
import { buildCognitionEnvelopeV3 } from './cognition-v3-adapters.mjs';
import { buildCognitionContext, buildCognitionV3Input } from './cognition-context.mjs';
import {
  COGNITION_SCHEMA_V2,
  COGNITION_SCHEMA_V3,
  EXPRESSION_SCHEMA_V2,
  EXPRESSION_SCHEMA_V3
} from './role-schemas.mjs';
import { resolveRelationshipStage } from './relationship-stage.mjs';
import { repairPlanForFinding, superviseLivedTurn } from './lived-quality-supervisor.mjs';

const COGNITION_FAST_ROUTE_SCHEMA_V3 = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['routeDecision', 'cognitionResult'],
  properties: {
    routeDecision: { type: 'string', enum: ['fast', 'deep'] },
    cognitionResult: COGNITION_SCHEMA_V3
  }
});

const RELEASE_DRAFT_CONTRACTS = Object.freeze({
  v2: Object.freeze({
    pipelineVersion: 'cognition-v2-candidate-2026-07-30',
    cognitionSchemaVersion: 2,
    expressionSchemaVersion: 2
  }),
  v3: Object.freeze({
    pipelineVersion: 'yuqi-lived-agency-v3',
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3
  })
});

function assertReleaseDraftContract(release, contract) {
  if (!String(release?.releaseId || '').trim()
    || !String(release?.presetVersion || '').trim()
    || String(release?.pipelineVersion || '') !== contract.pipelineVersion
    || Number(release?.cognitionSchemaVersion) !== contract.cognitionSchemaVersion
    || Number(release?.expressionSchemaVersion) !== contract.expressionSchemaVersion) {
    throw new Error('release draft contract conflict');
  }
}

function assertDryRunCapabilities(dryRun, capabilities) {
  if (dryRun === true
    && capabilities
    && Object.values(capabilities).some(Boolean)) {
    throw new Error('dry-run release capabilities conflict');
  }
}

function parseObject(response, role) {
  const text = String(response?.text ?? response ?? '').trim();
  if (!text) throw new Error(`${role} returned an empty result`);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${role} returned invalid JSON`);
  }
}

function validMessageIds(context) {
  const ids = new Set();
  for (const message of [
    ...(context?.recentMessages || []),
    ...(context?.currentBatch?.messages || [])
  ]) {
    if (message?.messageId) ids.add(String(message.messageId));
    for (const attachment of message?.attachments || []) {
      if (attachment?.messageId) ids.add(String(attachment.messageId));
    }
  }
  if (context?.payment?.messageId) ids.add(String(context.payment.messageId));
  if (context?.trigger?.messageId) ids.add(String(context.trigger.messageId));
  return [...ids];
}

function executionProfile(route, role) {
  if (role === 'cognition') {
    return route === 'fast'
      ? { model: 'gpt-5.6-terra', effort: 'medium' }
      : { model: 'gpt-5.6-sol', effort: 'medium' };
  }
  return { model: 'gpt-5.6-sol', effort: 'medium' };
}

function objectResult(value, role) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.text === undefined) {
    return value;
  }
  return parseObject(value, role);
}

function v3MessageIds(envelope) {
  const ids = new Set([
    ...(envelope?.currentInteraction?.messages || []),
    ...(envelope?.relevantHistory || [])
  ].map((message) => String(message?.messageId || '')).filter(Boolean));
  const feature = envelope?.featureContext || {};
  for (const comment of [
    feature.targetComment,
    ...(feature.thread || []),
    ...(feature.targetMoment?.comments || [])
  ]) {
    const commentId = String(comment?.commentId || '');
    if (commentId) ids.add(commentId);
  }
  return [...ids];
}

function v3AllowedTargets(envelope) {
  const feature = envelope?.featureContext || {};
  const commentIds = new Set([
    feature.targetComment,
    ...(feature.thread || []),
    ...(feature.targetMoment?.comments || [])
  ].map((comment) => String(comment?.commentId || '')).filter(Boolean));
  return {
    momentIds: [String(feature.targetMoment?.momentId || '')].filter(Boolean),
    commentIds: [...commentIds],
    rolePlanIds: [String(feature.rolePlan?.rolePlanId || '')].filter(Boolean),
    lifeEpisodeIds: (Array.isArray(feature.existingEpisodes) ? feature.existingEpisodes : [])
      .map((episode) => String(episode?.episodeId || ''))
      .filter(Boolean)
  };
}

function v3SemanticAllowedActions(actions) {
  const allowed = new Set((actions || []).map(String));
  if ([...allowed].some((action) => ['payment_accept', 'payment_decline'].includes(action))) {
    allowed.add('payment');
  }
  if ([...allowed].some((action) => ['post', 'like', 'comment', 'reply'].includes(action))) {
    allowed.add('moment');
  }
  if ([...allowed].some((action) => ['create', 'update', 'delete'].includes(action))) {
    allowed.add('rolePlan');
  }
  return [...allowed];
}

function checkpointFromStore(store, turnId) {
  return store?.getTurnCheckpoint?.(turnId) || {};
}

function sanitizeRelationshipExpressionView(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    formalFacts: Array.isArray(source.formalFacts) ? structuredClone(source.formalFacts) : [],
    toneTendencies: Array.isArray(source.toneTendencies)
      ? structuredClone(source.toneTendencies)
      : []
  };
}

function relationshipExpressionSource(input, checkpoint, loaded = null) {
  return checkpoint?.relationshipExpression
    || checkpoint?.cognitionPacket?.relationshipExpression
    || input?.relationshipExpression
    || input?.scene?.relationshipExpression
    || loaded?.relationshipExpression
    || loaded?.scene?.relationshipExpression
    || null;
}

function attachRelationshipExpression(packet, relationshipExpression) {
  return {
    ...packet,
    relationshipExpression: sanitizeRelationshipExpressionView(relationshipExpression)
  };
}

function supervisionCognitionPacket(packet, relationshipExpression) {
  const { relationshipBasePhase: _formalRelationship, ...safeEnvelope } = packet.envelope || {};
  return {
    ...packet,
    envelope: safeEnvelope,
    cognitionResult: cognitionResultWithoutRelationshipReview(packet.cognitionResult),
    relationshipExpression: sanitizeRelationshipExpressionView(relationshipExpression)
  };
}

function actionIntentWithoutRelationshipReview(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const { relationshipReview: _relationshipReview, ...projected } = source;
  return projected;
}

function cognitionResultWithoutRelationshipReview(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...source,
    actionIntent: actionIntentWithoutRelationshipReview(source.actionIntent)
  };
}

function supervisionDraft(draft) {
  return {
    ...draft,
    actionIntent: actionIntentWithoutRelationshipReview(draft?.actionIntent)
  };
}

function cognitionProviderPacket(packet) {
  const { relationshipExpression: _expression, ...formalPacket } = packet || {};
  return formalPacket;
}

function persistV3Checkpoint(store, turn, packet, relationshipExpression, dryRun = false) {
  if (dryRun) return;
  const persistedPacket = attachRelationshipExpression(packet, relationshipExpression);
  if (typeof store?.saveCognitionCheckpointInternal === 'function') {
    store.saveCognitionCheckpointInternal(turn.turnId, persistedPacket);
    return;
  }
  const current = store?.getTurn?.(turn.turnId);
  if (!current || current.memoryPacketJson || typeof store?.advanceTurn !== 'function') return;
  let state = current.state;
  if (state === 'queued') {
    store.advanceTurn(turn.turnId, 'queued', 'memory_running');
    state = 'memory_running';
  }
  if (state === 'memory_running') {
    store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', {
      memoryPacketJson: JSON.stringify({
        packetType: 'cognition-v3',
        cognitionEnvelope: persistedPacket.envelope,
        cognitionPacket: persistedPacket
      })
    });
  }
}

function storedV3Checkpoint(store, turn) {
  const direct = checkpointFromStore(store, turn.turnId);
  if (direct?.cognitionPacket?.schemaVersion === 3) return direct;
  const current = store?.getTurn?.(turn.turnId);
  if (!current?.memoryPacketJson) return direct;
  try {
    const parsed = JSON.parse(current.memoryPacketJson);
    return parsed?.packetType === 'cognition-v3' ? parsed : direct;
  } catch {
    return direct;
  }
}

function rolePayload({ turn, system, task, content }) {
  return {
    turnId: turn.turnId,
    authoritativeReleaseId: turn.authoritativeReleaseId || null,
    system,
    task,
    ...content
  };
}

const PUBLIC_MOMENT_KINDS = new Set([
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);

function isPublicMomentTurn(input) {
  const kind = input?.turn?.turnKind || input?.turn?.rolloutKey
    || input?.envelope?.kind || input?.cognitionEnvelope?.turnKind;
  return Number(input?.turn?.protocolVersion ?? input?.envelope?.protocolVersion
    ?? input?.cognitionEnvelope?.protocolVersion) === 3
    && PUBLIC_MOMENT_KINDS.has(String(kind || ''));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function v3ValidationContext(cognitionEnvelope, input) {
  const motiveCandidates = cognitionEnvelope?.featureContext?.motiveCandidates;
  const proactiveMotiveIds = cognitionEnvelope?.turnKind === 'PROACTIVE_CHAT'
    ? (Array.isArray(motiveCandidates)
      ? motiveCandidates.map((candidate) => {
        if (typeof candidate?.motiveId !== 'string' || !candidate.motiveId.trim()) {
          throw new Error('PROACTIVE_CHAT pinned motive authority conflict');
        }
        return candidate.motiveId;
      })
      : [])
    : [];
  return {
    validMessageIds: v3MessageIds(cognitionEnvelope),
    proactiveMotiveIds,
    envelope: {
      ...cognitionEnvelope,
      kind: cognitionEnvelope.turnKind
    },
    relevantStances: cognitionEnvelope.currentStances || [],
    allowedActions: v3SemanticAllowedActions(cognitionEnvelope.allowedActions),
    allowedActionTargets: v3AllowedTargets(cognitionEnvelope),
    scene: isPublicMomentTurn({ ...input, cognitionEnvelope }) ? {} : (input.scene || {})
  };
}

async function runV3Expression(
  input,
  cognitionEnvelope,
  cognitionPacket,
  relationshipExpression,
  repairPlans = []
) {
  const agencyView = {
    hardConstraints: cognitionEnvelope.hardConstraints || [],
    preferences: cognitionEnvelope.preferences || [],
    currentStances: cognitionEnvelope.currentStances || []
  };
  const expressionBrief = compileExpressionBriefV3({
    envelope: cognitionEnvelope,
    agencyView,
    relationship: sanitizeRelationshipExpressionView(relationshipExpression),
    cognitionResult: cognitionResultWithoutRelationshipReview(cognitionPacket.cognitionResult)
  });
  const expressionRaw = objectResult(await input.client.runRole(
    'expression_v3',
    rolePayload({
      turn: input.turn,
      system: input.presetBundles?.expression || '',
      task: repairPlans.length
        ? 'rewrite_expression_for_lived_quality_v3'
        : 'express_authorized_decision_v3',
      content: {
        expressionBrief,
        ...(repairPlans.length ? { repairPlans } : {})
      }
    }),
    {
      deadlineMs: 60_000,
      outerDeadlineMs: Math.max(1, Number(input.outerDeadlineMs) || 300_000),
      outputSchema: EXPRESSION_SCHEMA_V3,
      model: 'gpt-5.6-sol',
      effort: 'medium'
    }
  ), 'expression_v3');
  const expressionResult = normalizeExpressionV3Result(expressionRaw);
  return {
    expressionResult,
    draft: materializeV3Draft({ cognitionPacket, expressionResult })
  };
}

async function reviewV3Draft(input, cognitionPacket, draft, relationshipExpression, final = false) {
  const custom = final ? input.finalSupervise || input.supervise : input.supervise;
  const reviewInput = {
    highRisk: Boolean(input.highRisk),
    cognitionPacket: supervisionCognitionPacket(cognitionPacket, relationshipExpression),
    draft: supervisionDraft(draft),
    relationship: sanitizeRelationshipExpressionView(relationshipExpression),
    currentInteraction: cognitionPacket.envelope.currentInteraction,
    continuity: input.continuity || null,
    applicableChecks: input.applicableChecks || [],
    reviewer: input.reviewer,
    turnSuperseded: input.turnSuperseded,
    actionAuthorized: input.actionAuthorized
  };
  return custom ? custom(reviewInput) : superviseLivedTurn(reviewInput);
}

export async function runCognitionV3Turn(input) {
  const startedAt = input.now?.() ?? Date.now();
  const outerDeadlineMs = Math.max(1, Number(input.outerDeadlineMs) || 300_000);
  const checkpoint = storedV3Checkpoint(input.store, input.turn);
  let loaded = null;
  let relationshipExpression = relationshipExpressionSource(input, checkpoint);
  let cognitionEnvelope = checkpoint.cognitionEnvelope
    || checkpoint.cognitionPacket?.envelope
    || input.cognitionEnvelope
    || null;
  if (!cognitionEnvelope || (isPublicMomentTurn(input) && !checkpoint.cognitionEnvelope)) {
    loaded = input.contextLoader?.load
      ? await input.contextLoader.load(input)
      : await buildCognitionV3Input(input.contextInput || input);
    cognitionEnvelope = buildCognitionEnvelopeV3(loaded);
  }
  relationshipExpression = isPublicMomentTurn({ ...input, cognitionEnvelope })
    ? { formalFacts: [], toneTendencies: [] }
    : sanitizeRelationshipExpressionView(
      relationshipExpressionSource(input, checkpoint, loaded)
    );

  let cognitionPacket = checkpoint.cognitionPacket || null;
  if (!cognitionPacket) {
    const fastResponse = objectResult(await input.client.runRole(
      'cognition_fast',
      rolePayload({
        turn: input.turn,
        system: input.presetBundles?.cognition || '',
        task: 'understand_and_decide_v3',
        content: { cognitionEnvelope }
      }),
      {
        deadlineMs: 45_000,
        outerDeadlineMs,
        outputSchema: COGNITION_FAST_ROUTE_SCHEMA_V3,
        model: 'gpt-5.6-terra',
        effort: 'medium'
      }
    ), 'cognition_fast');
    let cognitionCandidate = fastResponse.cognitionResult || fastResponse;
    if (fastResponse.routeDecision === 'deep' || fastResponse.requiresDeepCognition === true) {
      const deepResponse = objectResult(await input.client.runRole(
        'cognition_deep',
        rolePayload({
          turn: input.turn,
          system: input.presetBundles?.cognition || '',
          task: 'reconsider_and_decide_v3',
          content: {
            cognitionEnvelope,
            priorFastResult: cognitionCandidate
          }
        }),
        {
          deadlineMs: 120_000,
          outerDeadlineMs,
          outputSchema: COGNITION_SCHEMA_V3,
          model: 'gpt-5.6-sol',
          effort: 'medium'
        }
      ), 'cognition_deep');
      cognitionCandidate = deepResponse.cognitionResult || deepResponse;
    }
    const cognitionResult = normalizeCognitionV3Result(
      cognitionCandidate,
      v3ValidationContext(cognitionEnvelope, input)
    );
    cognitionPacket = compileCognitionPacketV3({
      envelope: cognitionEnvelope,
      cognitionResult
    });
    cognitionPacket = attachRelationshipExpression(cognitionPacket, relationshipExpression);
    persistV3Checkpoint(
      input.store,
      input.turn,
      cognitionPacket,
      relationshipExpression,
      input.dryRun === true || input.draftOnly === true
    );
  }

  let { expressionResult, draft } = await runV3Expression(
    input,
    cognitionEnvelope,
    cognitionPacket,
    relationshipExpression
  );
  const attempts = {
    cognitionReconsideration: 0,
    expressionRewrite: 0,
    finalReview: 0
  };
  let supervision = await reviewV3Draft(input, cognitionPacket, draft, relationshipExpression);
  if (!supervision.approved) {
    const actionFindings = supervision.findings.filter((item) => item.owner === 'action');
    if (actionFindings.length) {
      return {
        cognitionPacket,
        expressionResult,
        draft,
        supervision,
        attempts,
        state: 'supervision_failed',
        timings: { startedAt, visibleCompletedAt: input.now?.() ?? Date.now() },
        shadowState: 'none'
      };
    }
    const cognitionFindings = supervision.findings.filter((item) => item.owner === 'cognition');
    const expressionFindings = supervision.findings.filter((item) => item.owner === 'expression');
    if (cognitionFindings.length) {
      attempts.cognitionReconsideration = 1;
      const reconsideredRaw = objectResult(await input.client.runRole(
        'cognition_deep',
        rolePayload({
          turn: input.turn,
          system: input.presetBundles?.cognition || '',
          task: 'reconsider_lived_quality_v3',
          content: {
            cognitionEnvelope,
            cognitionPacket: cognitionProviderPacket(cognitionPacket),
            repairPlans: cognitionFindings.map(repairPlanForFinding)
          }
        }),
        {
          deadlineMs: 120_000,
          outerDeadlineMs,
          outputSchema: COGNITION_SCHEMA_V3,
          model: 'gpt-5.6-sol',
          effort: 'medium'
        }
      ), 'cognition_deep');
      const reconsidered = normalizeCognitionV3Result(
        reconsideredRaw.cognitionResult || reconsideredRaw,
        v3ValidationContext(cognitionEnvelope, input)
      );
      if (!sameJson(reconsidered.actionIntent, cognitionPacket.cognitionResult.actionIntent)) {
        throw new Error('cognition reconsideration changed an authorized action');
      }
      cognitionPacket = compileCognitionPacketV3({
        envelope: cognitionEnvelope,
        cognitionResult: reconsidered
      });
      cognitionPacket = attachRelationshipExpression(cognitionPacket, relationshipExpression);
      if (input.dryRun !== true
        && input.draftOnly !== true
        && typeof input.store?.saveCognitionCheckpointInternal === 'function') {
        input.store.saveCognitionCheckpointInternal(input.turn.turnId, cognitionPacket);
      }
    }
    if (cognitionFindings.length || expressionFindings.length) {
      attempts.expressionRewrite = 1;
      ({ expressionResult, draft } = await runV3Expression(
        input,
        cognitionEnvelope,
        cognitionPacket,
        relationshipExpression,
        [...cognitionFindings, ...expressionFindings].map(repairPlanForFinding)
      ));
    }
    attempts.finalReview = 1;
    supervision = await reviewV3Draft(
      input,
      cognitionPacket,
      draft,
      relationshipExpression,
      true
    );
  }
  const visibleCompletedAt = input.now?.() ?? Date.now();
  const state = supervision.approved ? 'completed' : 'supervision_failed';
  if (state === 'supervision_failed') {
    return {
      cognitionPacket,
      expressionResult,
      draft,
      supervision,
      attempts,
      state,
      timings: { startedAt, visibleCompletedAt },
      shadowState: 'none'
    };
  }
  if (input.dryRun !== true
    && input.draftOnly !== true
    && typeof input.queueShadow === 'function') {
    Promise.resolve(input.queueShadow({
      turn: input.turn,
      cognitionEnvelope,
      cognitionPacket,
      draft
    })).catch((error) => input.onBackgroundError?.(error));
  }
  return {
    cognitionPacket,
    expressionResult,
    draft,
    supervision,
    attempts,
    state,
    checkpoints: {
      cognition: cognitionPacket.packetChecksum,
      expression: draft.draftChecksum
    },
    timings: { startedAt, visibleCompletedAt },
    shadowState: input.dryRun !== true
      && input.draftOnly !== true
      && typeof input.queueShadow === 'function'
      ? 'queued'
      : 'none'
  };
}

export class CognitivePipeline {
  constructor({
    store,
    codexClient,
    presetRegistry,
    routePolicy,
    clock = Date.now,
    diagnostics = null,
    contextBuilder = buildCognitionContext
  }) {
    if (!store || !codexClient || !presetRegistry) {
      throw new Error('store, codexClient, and presetRegistry are required');
    }
    this.store = store;
    this.codexClient = codexClient;
    this.presetRegistry = presetRegistry;
    this.routePolicy = routePolicy;
    this.clock = clock;
    this.diagnostics = diagnostics;
    this.contextBuilder = contextBuilder;
  }

  async runRole({ turn, role, system, payload, schema, profile, suffix }) {
    const sessionRole = role === 'cognition' ? 'memory' : role === 'expression' ? 'brain' : 'supervisor';
    let invalid = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.codexClient.runTurn(sessionRole, JSON.stringify({
        system,
        ...payload,
        ...(attempt === 1 ? {} : {
          protocolRepair: {
            attempt,
            invalidOutput: invalid.slice(0, 2_000),
            rule: 'Return exactly one JSON object matching the supplied schema.'
          }
        })
      }), {
        clientUserMessageId: `${turn.turnId}_${suffix}${attempt === 1 ? '' : `_protocol_${attempt}`}`,
        outputSchema: schema,
        model: profile.model,
        effort: profile.effort,
        turnTimeoutMs: 300_000
      });
      invalid = String(response?.text || '');
      try {
        return parseObject(response, role);
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error(`${role} failed`);
  }

  persistCognitionCheckpoint(turnId, checkpoint) {
    const current = this.store.getTurn?.(turnId);
    if (!current || current.memoryPacketJson) return;
    if (typeof this.store.advanceTurn !== 'function') return;
    let state = current.state;
    if (state === 'queued') {
      this.store.advanceTurn(turnId, 'queued', 'memory_running');
      state = 'memory_running';
    }
    if (state === 'memory_running') {
      this.store.advanceTurn(turnId, 'memory_running', 'memory_done', {
        memoryPacketJson: JSON.stringify({
          packetType: 'cognition-v2',
          ...checkpoint
        })
      });
    }
  }

  async runForeground({
    turn,
    envelope,
    scene,
    currentBatch,
    routeDecision = {},
    persistCheckpoint = true,
    pinnedTurn = null,
    presetBundles = null,
    reuseCheckpoint = true
  }) {
    const pinned = pinnedTurn || this.store.getTurn?.(turn.turnId) || turn;
    if (!['active', 'shadow'].includes(pinned.pipelineMode)) {
      throw new Error('cognition pipeline requires a pinned active or shadow turn');
    }
    const annotations = pinned.annotationSnapshot?.annotations || [];
    const context = await this.contextBuilder({
      store: this.store,
      envelope,
      scene,
      localMemoryHints: routeDecision.localMemoryHints || [],
      currentBatch,
      interactionState: routeDecision.interactionState || {},
      cognitiveState: routeDecision.cognitiveState || this.store.getCognitiveState?.(turn.characterId),
      lifeContext: routeDecision.lifeContext || null,
      catalog: routeDecision.catalog || { schemaVersion: 1, lessons: [] }
    });
    const existing = reuseCheckpoint
      ? this.store.getTurn?.(turn.turnId) || turn
      : turn;
    let packet = null;
    if (existing.memoryPacketJson) {
      const stored = JSON.parse(existing.memoryPacketJson);
      if (stored.packetType === 'cognition-v2') packet = stored.packet;
    }
    if (!packet) {
      const system = presetBundles?.cognition
        || this.presetRegistry.resolvePresetBundle({
          role: 'cognition',
          version: pinned.presetVersion,
          annotations
        });
      const initialRoute = routeDecision.route === 'fast' || pinned.route === 'fast' ? 'fast' : 'deep';
      let raw = await this.runRole({
        turn: pinned,
        role: 'cognition',
        system,
        payload: { task: 'understand_and_decide', context },
        schema: COGNITION_SCHEMA_V2,
        profile: executionProfile(initialRoute, 'cognition'),
        suffix: 'cognition'
      });
      if (initialRoute === 'fast' && raw.requiresDeepCognition) {
        raw = await this.runRole({
          turn: pinned,
          role: 'cognition',
          system,
          payload: {
            task: 'deep_understand_and_decide',
            context,
            fastCognitionReview: raw
          },
          schema: COGNITION_SCHEMA_V2,
          profile: executionProfile('deep', 'cognition'),
          suffix: 'cognition_deep'
        });
      }
      const cognitionResult = normalizeCognitionResult(raw, {
        validMessageIds: validMessageIds(context),
        envelope,
        scene,
        allowedActionTargets: routeDecision.allowedActionTargets || {}
      });
      packet = compileCognitionPacket({
        envelope,
        scene,
        interactionState: routeDecision.interactionState || {},
        effectiveRelationshipStage: scene?.relationshipStage || null,
        cognitiveState: routeDecision.cognitiveState || {},
        cognitionResult
      });
      const evidenceMessages = [
        ...(context.recentMessages || []),
        ...(context.currentBatch?.messages || [])
      ];
      const relationship = resolveRelationshipStage(
        scene,
        cognitionResult.relationshipStageReview,
        evidenceMessages,
        this.clock()
      );
      if (persistCheckpoint) {
        this.persistCognitionCheckpoint(turn.turnId, {
          packet,
          query: cognitionResult.query,
          keywords: cognitionResult.keywords,
          conversationFrame: cognitionResult.conversationFrame,
          effectiveRelationshipStage: relationship.stage,
          relationshipStageAction: relationship.action,
          interactionContract: cognitionResult.decision
        });
      }
    }

    const expressionSystem = presetBundles?.expression
      || this.presetRegistry.resolvePresetBundle({
        role: 'expression',
        version: pinned.presetVersion,
        annotations
      });
    const expression = normalizeExpressionResult(await this.runRole({
      turn: pinned,
      role: 'expression',
      system: expressionSystem,
      payload: {
        task: 'express_authorized_decision',
        context,
        cognitionPacket: packet
      },
      schema: EXPRESSION_SCHEMA_V2,
      profile: executionProfile(routeDecision.route || pinned.route, 'expression'),
      suffix: 'expression'
    }));
    const draft = materializeBrainDraft(packet, expression);
    if (envelope.kind === 'DIRECT_REPLY' && draft.action !== 'send') {
      throw new Error('DIRECT_REPLY cognition pipeline cannot skip');
    }
    return { cognitionPacket: packet, expression, draft, context };
  }

  async runShadow(input) {
    return this.runForeground(input);
  }

  compilePinnedReleaseBundles(release, execution) {
    const storedTurn = this.store.getTurn?.(execution?.turn?.turnId) || execution?.turn || {};
    const annotations = storedTurn.annotationSnapshot?.annotations || [];
    const bundles = Object.fromEntries(['cognition', 'expression'].map((role) => {
      const bundle = this.presetRegistry.resolvePresetBundle({
        role,
        version: release.presetVersion,
        annotations
      });
      if (!String(bundle || '').trim()) throw new Error('pinned preset bundle is empty');
      return [role, bundle];
    }));
    return bundles;
  }

  async runV2ReleaseDraft({ release, execution, dryRun = false, capabilities = null }) {
    assertReleaseDraftContract(release, RELEASE_DRAFT_CONTRACTS.v2);
    assertDryRunCapabilities(dryRun, capabilities);
    const presetBundles = this.compilePinnedReleaseBundles(release, execution);
    const storedTurn = this.store.getTurn?.(execution?.turn?.turnId) || {};
    const pinnedTurn = {
      ...storedTurn,
      ...(execution?.turn || {}),
      presetVersion: release.presetVersion,
      authoritativeReleaseId: release.releaseId
    };
    const result = await this.runForeground({
      ...execution,
      turn: pinnedTurn,
      pinnedTurn,
      presetBundles,
      persistCheckpoint: false,
      reuseCheckpoint: false
    });
    return result.draft;
  }

  async runV3ReleaseDraft({ release, execution, dryRun = false, capabilities = null }) {
    assertReleaseDraftContract(release, RELEASE_DRAFT_CONTRACTS.v3);
    assertDryRunCapabilities(dryRun, capabilities);
    const presetBundles = this.compilePinnedReleaseBundles(release, execution);
    const pinnedTurn = {
      ...(execution?.turn || {}),
      presetVersion: release.presetVersion,
      authoritativeReleaseId: release.releaseId
    };
    const result = await runCognitionV3Turn({
      ...execution,
      turn: pinnedTurn,
      store: this.store,
      client: execution?.client || this.codexClient,
      presetBundles,
      dryRun: Boolean(dryRun),
      draftOnly: true,
      queueShadow: null
    });
    return result.draft;
  }
}
