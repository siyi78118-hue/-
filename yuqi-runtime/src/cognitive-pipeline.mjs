import {
  compileCognitionPacket,
  materializeBrainDraft,
  normalizeCognitionResult,
  normalizeExpressionResult
} from './cognition-contract.mjs';
import { buildCognitionContext } from './cognition-context.mjs';
import {
  COGNITION_SCHEMA_V2,
  EXPRESSION_SCHEMA_V2
} from './role-schemas.mjs';

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

  persistCognitionCheckpoint(turnId, packet) {
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
          packet
        })
      });
    }
  }

  async runForeground({
    turn,
    envelope,
    scene,
    currentBatch,
    routeDecision = {}
  }) {
    const pinned = this.store.getTurn?.(turn.turnId) || turn;
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
    const existing = this.store.getTurn?.(turn.turnId) || turn;
    let packet = null;
    if (existing.memoryPacketJson) {
      const stored = JSON.parse(existing.memoryPacketJson);
      if (stored.packetType === 'cognition-v2') packet = stored.packet;
    }
    if (!packet) {
      const system = this.presetRegistry.resolvePresetBundle({
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
      this.persistCognitionCheckpoint(turn.turnId, packet);
    }

    const expressionSystem = this.presetRegistry.resolvePresetBundle({
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
}
