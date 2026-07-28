import { commitVerifiedFacts } from './evidence-memory.mjs';
import { contentHash } from './protocol.mjs';
import { buildEvidencePack } from './retrieval.mjs';
import { ROLE_OUTPUT_SCHEMAS } from './role-schemas.mjs';
import { DEFAULT_PROFILES, roleExecutionProfile, selectTurnRoute } from './route-policy.mjs';
import { resolveRelationshipStage, sceneFromEnvelope } from './relationship-stage.mjs';
import { buildAuthoritativeInteractionState } from './interaction-state.mjs';
import { compileInteractionContract } from './interaction-contract.mjs';
import { buildGenerationWindow } from './conversation-context.mjs';
import { currentUserBatchForRole, resolveCurrentUserBatch } from './current-user-batch.mjs';
import { LifeSimulationCoordinator } from './life-simulation.mjs';
import { materializeImageAttachments } from './image-attachments.mjs';
import {
  characterFactCandidatesForReply,
  hasHighPriorityIssues,
  normalizeRewriteResolution,
  normalizeSupervisorResult,
  rewriteContractForBrain
} from './rewrite-contract.mjs';

function parseRoleJson(text, role) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(source); } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${role} returned invalid object`);
  return value;
}

function withoutCurrentBatch(messages, batch, limit = null) {
  const currentIds = new Set(batch?.messageIds || []);
  const historical = (Array.isArray(messages) ? messages : [])
    .filter(message => !currentIds.has(String(message?.messageId || '')));
  return limit === null ? historical : historical.slice(-Math.max(1, Number(limit) || 1));
}

function evidenceMessages(messages, batch) {
  const byId = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const messageId = String(message?.messageId || '');
    if (messageId) byId.set(messageId, message);
  }
  for (const message of batch?.messages || []) {
    const messageId = String(message?.messageId || '');
    if (messageId) byId.set(messageId, message);
  }
  return [...byId.values()]
    .sort((left, right) => Number(left?.sentAt || 0) - Number(right?.sentAt || 0));
}

function stripAttachmentData(message) {
  if (!message || !Array.isArray(message.attachments)) return message;
  return {
    ...message,
    attachments: message.attachments.map(({ dataUrl, ...metadata }) => metadata)
  };
}

export function hardValidateReply(reply) {
  const issues = [];
  const text = String(reply || '').trim();
  if (!text) issues.push({ code: 'EMPTY_REPLY', message: 'reply is empty' });
  if (text.length > 20_000) issues.push({ code: 'REPLY_TOO_LARGE', message: 'reply is too large' });
  return { ok: issues.length === 0, issues };
}

function normalizeRolePlanOperations(value) {
  let source = value;
  if (typeof source === 'string') {
    const text = source.trim();
    if (!text || text === '[]') return [];
    try { source = JSON.parse(text); } catch {
      throw new Error('brain returned invalid rolePlanOperationsJson');
    }
  }
  if (!Array.isArray(source)) return [];
  const allowed = new Set(['create', 'update', 'cancel', 'pause', 'resume', 'complete']);
  return source.slice(0, 12).map(operation => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error('brain returned invalid role plan operation');
    }
    const normalized = JSON.parse(JSON.stringify(operation));
    normalized.op = String(normalized.op || '');
    if (!allowed.has(normalized.op)) throw new Error('brain returned unknown role plan operation');
    return normalized;
  });
}

export function normalizeBrainDraft(draft) {
  const paymentAction = ['received', 'refused', 'pending'].includes(draft?.paymentAction)
    ? draft.paymentAction
    : null;
  const normalized = {
    ...(draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {}),
    action: draft?.action === 'skip' ? 'skip' : 'send',
    reply: String(draft?.reply || '').trim(),
    skipReason: String(draft?.skipReason || ''),
    paymentAction,
    momentAction: draft?.momentAction && typeof draft.momentAction === 'object' && !Array.isArray(draft.momentAction)
      ? {
          momentId: String(draft.momentAction.momentId || ''),
          like: draft.momentAction.like === true,
          comment: String(draft.momentAction.comment || '').trim().slice(0, 1000),
          replyToCommentId: draft.momentAction.replyToCommentId ? String(draft.momentAction.replyToCommentId) : null
        }
      : null,
    lifePlan: draft?.lifePlan && typeof draft.lifePlan === 'object' && !Array.isArray(draft.lifePlan)
      ? {
          planKey: String(draft.lifePlan.planKey || ''),
          episodes: Array.isArray(draft.lifePlan.episodes) ? draft.lifePlan.episodes : []
        }
      : null,
    lifeAdjustment: draft?.lifeAdjustment && typeof draft.lifeAdjustment === 'object' && !Array.isArray(draft.lifeAdjustment)
      ? {
          type: String(draft.lifeAdjustment.type || 'none'),
          targetEpisodeId: String(draft.lifeAdjustment.targetEpisodeId || ''),
          startAt: draft.lifeAdjustment.startAt === null ? null : Number(draft.lifeAdjustment.startAt),
          endAt: draft.lifeAdjustment.endAt === null ? null : Number(draft.lifeAdjustment.endAt),
          reason: String(draft.lifeAdjustment.reason || '')
        }
      : null,
    usedFactIds: Array.isArray(draft?.usedFactIds) ? draft.usedFactIds.map(String) : [],
    rewriteResolution: normalizeRewriteResolution(draft?.rewriteResolution),
    rolePlanOperations: normalizeRolePlanOperations(
      draft?.rolePlanOperationsJson ?? draft?.rolePlanOperations
    )
  };
  for (let depth = 0; depth < 3 && normalized.reply.startsWith('{') && normalized.reply.endsWith('}'); depth += 1) {
    let nested;
    try { nested = JSON.parse(normalized.reply); } catch { break; }
    if (!nested || typeof nested !== 'object' || Array.isArray(nested) || typeof nested.reply !== 'string') break;
    normalized.reply = nested.reply.trim();
    if (nested.action === 'skip') normalized.action = 'skip';
    if (['received', 'refused', 'pending'].includes(nested.paymentAction)) {
      normalized.paymentAction = nested.paymentAction;
    }
    if (!normalized.usedFactIds.length && Array.isArray(nested.usedFactIds)) {
      normalized.usedFactIds = nested.usedFactIds.map(String);
    }
  }
  return normalized;
}

function isMomentKind(kind) {
  return kind === 'MOMENT_INTERACTION' || kind === 'MOMENT_REPLY';
}

function isMomentPostKind(kind) {
  return ['PROACTIVE_MOMENT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'].includes(kind);
}

function currentRolePlanExecution(envelope) {
  if (!String(envelope?.kind || '').startsWith('ROLE_PLAN_')) return null;
  const context = envelope.trigger?.context || {};
  const snapshot = context.snapshot && typeof context.snapshot === 'object' ? context.snapshot : {};
  const input = context.input && typeof context.input === 'object' ? context.input : {};
  const plan = snapshot.rolePlan && typeof snapshot.rolePlan === 'object' ? snapshot.rolePlan : null;
  return {
    plan,
    occurrence: {
      planId: String(input.planId || plan?.planId || ''),
      occurrenceId: String(input.occurrenceId || ''),
      scheduledFor: Number(input.scheduledFor || envelope.trigger?.scheduledFor || 0),
      executedAt: Number(input.executedAt || envelope.trigger?.executedAt || 0)
    },
    timingContext: String(snapshot.timingContext || ''),
    delayMs: Math.max(0, Number(snapshot.delayMs) || 0)
  };
}

export function isAutomaticKind(kind) {
  return [
    'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE',
    'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY'
  ].includes(kind);
}

function normalizeConversationFrame(frame) {
  const source = frame && typeof frame === 'object' && !Array.isArray(frame) ? frame : {};
  const initiative = source.initiative && typeof source.initiative === 'object' && !Array.isArray(source.initiative)
    ? source.initiative
    : {};
  const priorTopic = source.priorTopic && typeof source.priorTopic === 'object' && !Array.isArray(source.priorTopic)
    ? source.priorTopic
    : {};
  const interruption = source.interruption && typeof source.interruption === 'object' && !Array.isArray(source.interruption)
    ? source.interruption
    : {};
  const priorTopicStatus = ['closed', 'open', 'uncertain'].includes(priorTopic.status)
    ? priorTopic.status
    : 'uncertain';
  const waitingOn = ['user', 'yuqi', 'either', 'none', 'unclear'].includes(priorTopic.waitingOn)
    ? priorTopic.waitingOn
    : 'unclear';
  return {
    surfaceAct: String(source.surfaceAct || ''),
    intentHypotheses: Array.isArray(source.intentHypotheses)
      ? source.intentHypotheses.map(item => ({
          intent: String(item?.intent || ''),
          confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
          evidenceMessageIds: Array.isArray(item?.evidenceMessageIds) ? item.evidenceMessageIds.map(String) : []
        })).filter(item => item.intent)
      : [],
    interactionMode: String(source.interactionMode || ''),
    emotionalTone: String(source.emotionalTone || ''),
    relationshipMove: String(source.relationshipMove || ''),
    initiative: {
      topicIntroducedBy: String(initiative.topicIntroducedBy || 'unclear'),
      suggestedNextCarrier: String(initiative.suggestedNextCarrier || 'unclear'),
      reason: String(initiative.reason || '')
    },
    priorTopic: {
      status: priorTopicStatus,
      summary: String(priorTopic.summary || ''),
      waitingOn,
      evidenceMessageIds: Array.isArray(priorTopic.evidenceMessageIds)
        ? priorTopic.evidenceMessageIds.map(String)
        : [],
      reason: String(priorTopic.reason || '')
    },
    interruption: {
      requiresReaction: interruption.requiresReaction === true,
      reactionReason: String(interruption.reactionReason || '')
    },
    activeHooks: Array.isArray(source.activeHooks) ? source.activeHooks.map(String) : [],
    ambiguities: Array.isArray(source.ambiguities) ? source.ambiguities.map(String) : [],
    responseRisks: Array.isArray(source.responseRisks) ? source.responseRisks.map(String) : [],
    explicitBoundaries: Array.isArray(source.explicitBoundaries)
      ? source.explicitBoundaries.map(item => ({
          type: String(item?.type || ''),
          active: item?.active === true,
          reason: String(item?.reason || ''),
          evidenceMessageIds: Array.isArray(item?.evidenceMessageIds)
            ? item.evidenceMessageIds.map(String)
            : []
        })).filter(item => item.type && item.reason)
      : [],
    recentCorrection: source.recentCorrection && typeof source.recentCorrection === 'object'
      ? {
          active: source.recentCorrection.active === true,
          rejectedInterpretation: String(source.recentCorrection.rejectedInterpretation || ''),
          expiresAfterBatches: Math.max(
            0,
            Math.min(2, Math.trunc(Number(source.recentCorrection.expiresAfterBatches) || 0))
          ),
          evidenceMessageIds: Array.isArray(source.recentCorrection.evidenceMessageIds)
            ? source.recentCorrection.evidenceMessageIds.map(String)
            : []
        }
      : {
          active: false,
          rejectedInterpretation: '',
          expiresAfterBatches: 0,
          evidenceMessageIds: []
        },
    needsNuanceReview: source.needsNuanceReview === true
  };
}

function elapsedText(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return '不到1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}小时${remainingMinutes ? `${remainingMinutes}分钟` : ''}`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}天${remainingHours ? `${remainingHours}小时` : ''}`;
}

function delayClass(milliseconds) {
  if (milliseconds < 5 * 60_000) return 'immediate';
  if (milliseconds < 60 * 60_000) return 'minutes';
  if (milliseconds < 6 * 60 * 60_000) return 'hours';
  if (milliseconds < 24 * 60 * 60_000) return 'same_day_long_gap';
  return 'day_or_more';
}

export function buildInteractionState(envelope, recentMessages, computedAt = Date.now()) {
  return buildAuthoritativeInteractionState({ envelope, messages: recentMessages, now: computedAt });
  /* istanbul ignore next -- retained temporarily for source-level compatibility */
  const messages = [...recentMessages].sort((left, right) => Number(left.sentAt || 0) - Number(right.sentAt || 0));
  const currentTime = Number(computedAt || Date.now());
  const sourceOccurredAt = Number(
    envelope.message?.sentAt || envelope.trigger?.executedAt || envelope.trigger?.scheduledFor || envelope.createdAt || currentTime
  );
  const processingDelayMs = Math.max(0, currentTime - sourceOccurredAt);
  const lastMessage = messages.at(-1) || null;
  const lastUserMessage = [...messages].reverse().find(message => message.speakerId === 'user') || null;
  const lastYuqiMessage = [...messages].reverse().find(message => message.speakerId === envelope.characterId) || null;
  const unansweredOutgoingCount = lastUserMessage
    ? messages.filter(message => message.speakerId === envelope.characterId && Number(message.sentAt || 0) > Number(lastUserMessage.sentAt || 0)).length
    : messages.filter(message => message.speakerId === envelope.characterId).length;
  const elapsed = message => message ? Math.max(0, currentTime - Number(message.sentAt || currentTime)) : null;
  return {
    computedAt: currentTime,
    computedAtIso: new Date(currentTime).toISOString(),
    sourceOccurredAt,
    sourceOccurredAtIso: new Date(sourceOccurredAt).toISOString(),
    processingDelayMs,
    processingDelayText: elapsedText(processingDelayMs),
    processingDelayClass: delayClass(processingDelayMs),
    replyFromPresent: true,
    lastMessageId: lastMessage?.messageId || null,
    lastSpeakerId: lastMessage?.speakerId || null,
    lastUserMessageId: lastUserMessage?.messageId || null,
    lastYuqiMessageId: lastYuqiMessage?.messageId || null,
    silenceMsSinceLastMessage: elapsed(lastMessage),
    silenceMsSinceLastUserMessage: elapsed(lastUserMessage),
    silenceMsSinceLastYuqiMessage: elapsed(lastYuqiMessage),
    unansweredOutgoingCount,
    waitingForUserReply: unansweredOutgoingCount > 0,
    triggerSnapshotIsAdvisory: Boolean(envelope.trigger?.context?.snapshot)
  };
}

function inferredPaymentAction(text) {
  const value = String(text || '');
  if (/(?:不收|不领|拒收|退给你|还给你|你拿回去)/.test(value)) return 'refused';
  if (/(?:那我就收|我收下|收了|领了|领取了|点开了|拆了)/.test(value)) return 'received';
  return null;
}

function resolvedPaymentAction(envelope, draft) {
  if (!envelope.context?.payment) return null;
  return inferredPaymentAction(draft.reply) || draft.paymentAction || 'pending';
}

function repairReplyForDelivery(reply, kind = 'DIRECT_REPLY') {
  const text = String(reply || '').trim();
  if (!text) {
    return kind === 'DIRECT_REPLY'
      ? '刚才那句话没发出来，你再跟我说一次？'
      : '';
  }
  return text.length > 20_000 ? text.slice(0, 20_000) : text;
}

function hasLifeDecision(draft) {
  return Boolean(
    draft?.lifePlan?.episodes?.length
    || (draft?.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none')
  );
}

function proactiveDeliveryRewrite(previous = null, attempt = 1, originalDecision = 'skip') {
  return normalizeSupervisorResult({
    decision: 'rewrite',
    approved: false,
    originalDecision,
    issues: [{
      code: 'PROACTIVE_DELIVERY_REQUIRED',
      severity: 'soft',
      message: '本轮主动私聊需要形成自然可见正文，不要以沉默结束',
      mustPreserve: ['事实、身份、时间、关系状态和生活连续性'],
      mustChange: ['把空草稿改成虞栖此刻真实想发的一条消息'],
      allowedStrategies: ['分享生活片段', '自然换话题', '轻量试探', '重新开口'],
      acceptanceCriteria: ['reply 是非空可见正文', '不解释系统规则']
    }]
  }, { attempt, previous, direct: false });
}

export class YuqiOrchestrator {
  constructor({
    store, presets, codex, workerId = 'yuqi-worker', clock = Date.now, contextLimit = 200,
    generationContextLimit = 20, roleProfiles = DEFAULT_PROFILES, lifeSimulation = null,
    lifePlanningEnabled = true
  }) {
    if (!store || !presets || !codex) throw new Error('store, presets, and codex are required');
    this.store = store;
    this.presets = presets;
    this.codex = codex;
    this.workerId = workerId;
    this.clock = clock;
    this.contextLimit = Math.max(1, Math.min(5000, Number(contextLimit) || 200));
    this.generationContextLimit = Math.max(1, Math.min(200, Number(generationContextLimit) || 20));
    this.roleProfiles = roleProfiles;
    this.lifeSimulation = lifeSimulation || new LifeSimulationCoordinator({ store });
    this.lifePlanningEnabled = lifePlanningEnabled !== false;
    this.lifePlanningPromises = new Map();
    this.lifePlanningRetryAfter = new Map();
    this.brainRolePromise = null;
    this.turnImagePaths = new Map();
  }

  accept(envelope) {
    let submitted = this.store.submitTurn(envelope);
    if (submitted.state === 'failed') {
      const recovery = this.store.requeueTransientFailedTurn(submitted.turnId);
      if (recovery.requeued) submitted = recovery.turn;
    }
    if (submitted.state === 'queued' && (!submitted.routeReasons || submitted.routeReasons.length === 0)) {
      const decision = selectTurnRoute({
        envelope,
        recentMessages: this.store.listMessages(envelope.characterId, this.contextLimit)
      });
      return this.store.setTurnRoute(submitted.turnId, decision.route, decision.reasons);
    }
    return submitted;
  }

  deliveryPolicyFor(envelope) {
    if (envelope.kind !== 'PROACTIVE_CHAT') return null;
    try {
      return this.store.getProactiveChatDeliveryPolicy(envelope.characterId);
    } catch (error) {
      const fallback = {
        kind: 'proactive_chat',
        windowSize: 4,
        maxSkips: 1,
        usedSkips: 0,
        skipAllowed: true,
        inspectedTurnIds: [],
        resetAfterTurnId: null
      };
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'proactive_delivery_policy',
        level: 'warning',
        detail: {
          action: 'policy_read_failed',
          message: error.message,
          skipAllowed: true
        }
      });
      return fallback;
    }
  }

  async process(envelope) {
    const submitted = this.accept(envelope);
    return this.run(submitted.turnId);
  }

  async withBrainRoleLock(operation) {
    const previous = this.brainRolePromise || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.brainRolePromise = current;
    try {
      return await current;
    } finally {
      if (this.brainRolePromise === current) this.brainRolePromise = null;
    }
  }

  async ensureLifePlan(characterId, at = this.clock()) {
    const now = Number(at);
    const context = this.lifeSimulation.advanceTo(characterId, now);
    if (!this.lifePlanningEnabled) return { planned: false, reason: 'disabled', context };
    if (!context.needsPlan) return { planned: false, reason: 'horizon_sufficient', context };
    if (Number(this.lifePlanningRetryAfter.get(characterId) || 0) > now) {
      return { planned: false, reason: 'retry_cooldown', context };
    }
    if (this.lifePlanningPromises.has(characterId)) return this.lifePlanningPromises.get(characterId);

    const planKey = `life_plan_${contentHash({
      characterId,
      planWindowStartAt: context.planWindowStartAt,
      presetVersion: this.presets.current().version
    }).slice(0, 24)}`;
    const operation = this.withBrainRoleLock(async () => {
      const profile = roleExecutionProfile('deep', 'brain', this.roleProfiles);
      const request = {
        task: 'plan_yuqi_life',
        preset: this.presets.compileFor('brain', { scene: { kind: 'LIFE_PLANNING' } }),
        characterId,
        planKey,
        lifeContext: context,
        planningWindow: {
          startAt: context.planWindowStartAt,
          targetEndAt: context.targetPlanEndAt,
          minimumCoverageMs: 6 * 60 * 60_000,
          maximumCoverageMs: 24 * 60 * 60_000
        }
      };
      try {
        const response = await this.codex.runTurn('brain', JSON.stringify(request), {
          clientUserMessageId: planKey,
          outputSchema: ROLE_OUTPUT_SCHEMAS.brain,
          model: profile.model,
          effort: profile.effort
        });
        const draft = normalizeBrainDraft(parseRoleJson(response.text, 'brain'));
        if (draft.action !== 'skip' || draft.reply || draft.momentAction || draft.lifeAdjustment) {
          throw new Error('chat brain planning task must stay silent');
        }
        const episodes = Array.isArray(draft.lifePlan?.episodes) ? draft.lifePlan.episodes : [];
        const ordered = episodes
          .map(item => ({ ...item, startAt: Number(item.startAt), endAt: Number(item.endAt) }))
          .sort((left, right) => left.startAt - right.startAt);
        if (!ordered.length || ordered.length > 12) throw new Error('chat brain returned an invalid life plan size');
        if (ordered[0].startAt < context.planWindowStartAt) throw new Error('chat brain life plan starts in the past');
        if (ordered[0].startAt - context.planWindowStartAt > 60 * 60_000) {
          throw new Error('chat brain life plan leaves a large initial gap');
        }
        for (let index = 1; index < ordered.length; index += 1) {
          if (ordered[index].startAt < ordered[index - 1].endAt) {
            throw new Error('chat brain life plan overlaps');
          }
        }
        const coverageMs = ordered.at(-1).endAt - ordered[0].startAt;
        if (coverageMs < 6 * 60 * 60_000 || coverageMs > 24 * 60 * 60_000) {
          throw new Error('chat brain life plan coverage is outside the allowed window');
        }
        this.store.putLifePlan(characterId, ordered, { sourceTurnId: planKey });
        this.lifePlanningRetryAfter.delete(characterId);
        return {
          planned: true,
          planKey,
          episodes: this.store.listLifeEpisodes(characterId, { from: context.planWindowStartAt }),
          context: this.lifeSimulation.advanceTo(characterId, now)
        };
      } catch (error) {
        this.lifePlanningRetryAfter.set(characterId, now + 10 * 60_000);
        throw error;
      }
    });
    this.lifePlanningPromises.set(characterId, operation);
    try {
      return await operation;
    } finally {
      if (this.lifePlanningPromises.get(characterId) === operation) {
        this.lifePlanningPromises.delete(characterId);
      }
    }
  }

  async run(turnId) {
    let current = this.store.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
    if (['delivered', 'completed'].includes(current.state) && current.replyJson) return JSON.parse(current.replyJson);
    if (['failed', 'fallback'].includes(current.state)) throw new Error(`turn is already ${current.state}`);
    const envelope = JSON.parse(current.envelopeJson);
    const initialBatch = resolveCurrentUserBatch(envelope);
    const rawAttachments = initialBatch?.messages.flatMap(message =>
      Array.isArray(message?.attachments) ? message.attachments : []
    ) || [];
    const preparedImages = await materializeImageAttachments(rawAttachments, { turnId });
    if (preparedImages.paths.length) {
      this.turnImagePaths.set(turnId, preparedImages.paths);
      envelope.message = stripAttachmentData(envelope.message);
      if (Array.isArray(envelope.context?.currentBatch?.messages)) {
        envelope.context.currentBatch.messages = envelope.context.currentBatch.messages.map(stripAttachmentData);
      }
    }

    try {
      for (let step = 0; step < 16; step += 1) {
        current = this.store.getTurn(turnId);
        if (current.state === 'queued') {
          current = this.store.claimTurnById(turnId, this.workerId);
          if (!current) throw new Error('turn could not be claimed');
          continue;
        }
        if (current.state === 'memory_running') {
          await this.completeMemory(envelope);
          continue;
        }
        if (current.state === 'memory_done') {
          const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
          if (
            envelope.kind === 'PROACTIVE_CHAT'
            && memoryPacket.interactionContract?.shouldRespond === false
          ) {
            const reason = String(
              memoryPacket.interactionContract.structuralSilenceReason
              || 'structural_silence'
            );
            this.store.putDiagnostic({
              turnId,
              stage: 'structural_silence',
              level: 'info',
              detail: {
                action: 'structural_silence',
                reason,
                initiativeOwner: memoryPacket.interactionContract.initiativeOwner,
                activeIssue: memoryPacket.interactionContract.activeIssue
              }
            });
            this.store.advanceTurn(turnId, 'memory_done', 'approved', {
              brainDraftJson: JSON.stringify({
                action: 'skip',
                reply: '',
                skipReason: 'structural_silence',
                usedFactIds: [],
                rolePlanOperationsJson: '[]'
              })
            });
            continue;
          }
          this.store.advanceTurn(turnId, 'memory_done', 'brain_running');
          continue;
        }
        if (current.state === 'brain_running') {
          await this.completeBrain(envelope, current);
          continue;
        }
        if (current.state === 'brain_done') {
          let draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
          if (draft.action === 'skip' && !isAutomaticKind(envelope.kind)) {
            draft = { ...draft, action: 'send', reply: repairReplyForDelivery('', envelope.kind) };
          }
          const deliveryPolicy = this.deliveryPolicyFor(envelope);
          if (draft.action === 'skip' && deliveryPolicy?.skipAllowed === false) {
            const previousRaw = current.supervisorJson
              ? parseRoleJson(current.supervisorJson, 'supervisor')
              : null;
            const previous = previousRaw
              ? normalizeSupervisorResult(previousRaw, {
                  attempt: Number(previousRaw.attempt || 1),
                  direct: false
                })
              : null;
            const review = proactiveDeliveryRewrite(
              previous,
              Number(previous?.attempt || 0) + 1,
              'brain_skip'
            );
            this.store.putDiagnostic({
              turnId,
              stage: 'proactive_skip_rewrite_requested',
              level: 'warning',
              detail: {
                policy: deliveryPolicy,
                modelDecision: 'skip',
                rewriteAttempt: review.attempt
              }
            });
            this.store.advanceTurn(turnId, 'brain_done', 'brain_running', {
              brainDraftJson: JSON.stringify(draft),
              supervisorJson: JSON.stringify(review)
            });
            continue;
          }
          if (draft.action === 'skip') {
            if (current.route !== 'deep' && (hasLifeDecision(draft) || draft.rolePlanOperations.length)) {
              this.store.setTurnRoute(turnId, 'fast_to_deep', [
                ...(Array.isArray(current.routeReasons) ? current.routeReasons : []),
                ...(hasLifeDecision(draft) ? ['life_decision'] : []),
                ...(draft.rolePlanOperations.length ? ['role_plan_decision'] : [])
              ]);
              current = this.store.getTurn(turnId);
            }
            this.store.advanceTurn(
              turnId, 'brain_done', current.route === 'fast' ? 'approved' : 'supervisor_running',
              { brainDraftJson: JSON.stringify(draft) }
            );
            continue;
          }
          const validMomentAction = isMomentKind(envelope.kind)
            && draft.momentAction?.momentId
            && (draft.momentAction.like || draft.momentAction.comment);
          if (isMomentKind(envelope.kind) && !validMomentAction) draft = { ...draft, action: 'skip', reply: '' };
          const hard = validMomentAction ? { ok: true, issues: [] } : hardValidateReply(draft.reply);
          const repairedDraft = hard.ok
            ? draft
            : isAutomaticKind(envelope.kind) && !String(draft.reply || '').trim()
              ? { ...draft, action: 'skip', reply: '' }
              : { ...draft, action: 'send', reply: repairReplyForDelivery(draft.reply, envelope.kind) };
          if (!hard.ok) {
            this.store.putDiagnostic({
              turnId,
              stage: 'brain_done',
              level: 'warning',
              detail: { action: 'reply_repaired_for_delivery', issues: hard.issues.map(issue => issue.code) }
            });
          }
          if (current.route !== 'deep' && (hasLifeDecision(repairedDraft) || repairedDraft.rolePlanOperations.length)) {
            this.store.setTurnRoute(turnId, 'fast_to_deep', [
              ...(Array.isArray(current.routeReasons) ? current.routeReasons : []),
              ...(hasLifeDecision(repairedDraft) ? ['life_decision'] : []),
              ...(repairedDraft.rolePlanOperations.length ? ['role_plan_decision'] : [])
            ]);
            current = this.store.getTurn(turnId);
          }
          this.store.advanceTurn(
            turnId,
            'brain_done',
            current.route === 'fast' ? 'approved' : 'supervisor_running',
            { brainDraftJson: JSON.stringify(repairedDraft) }
          );
          continue;
        }
        if (current.state === 'supervisor_running') {
          await this.completeSupervisor(envelope, current);
          continue;
        }
        if (current.state === 'approved') return this.commitApproved(envelope, current);
        if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
        throw new Error(`turn cannot resume from ${current.state}`);
      }
      throw new Error('turn exceeded orchestration step limit');
    } catch (error) {
      current = this.store.getTurn(turnId);
      if (current && !['committed', 'delivered', 'completed', 'failed'].includes(current.state)) {
        try {
          this.store.advanceTurn(turnId, current.state, 'failed', {
            errorJson: JSON.stringify({ name: error.name, message: error.message })
          });
        } catch {}
      }
      this.store.putDiagnostic({
        turnId,
        stage: current?.state || 'unknown',
        level: 'error',
        detail: { name: error.name, message: error.message }
      });
      throw error;
    } finally {
      this.turnImagePaths.delete(turnId);
      await preparedImages.cleanup();
    }
  }

  async completeMemory(envelope) {
    try {
      await this.ensureLifePlan(envelope.characterId, this.clock());
    } catch (error) {
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'life_planning',
        level: 'warning',
        detail: { name: error.name, message: error.message }
      });
    }
    const lifeContext = this.lifeSimulation.advanceTo(envelope.characterId, this.clock());
    const declaredBatch = resolveCurrentUserBatch(envelope);
    const stateMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds.length || 0))
    );
    const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
    const recentMessages = withoutCurrentBatch(stateMessages, currentBatch, this.contextLimit);
    const evidenceSourceMessages = evidenceMessages(stateMessages, currentBatch);
    const scene = sceneFromEnvelope(envelope);
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: stateMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const memoryRequest = {
      task: envelope.message ? 'retrieve_and_extract_evidence' : 'retrieve_context_for_trigger',
      preset: this.presets.compileFor('memory', { scene: { ...scene, kind: envelope.kind } }),
      scene,
      ...(currentBatch
        ? { currentUserBatch: currentUserBatchForRole(currentBatch) }
        : { currentTrigger: envelope.trigger, triggerIsNotUserEvidence: true }),
      recentMessages,
      interactionState,
      lifeContext
    };
    let current = this.store.getTurn(envelope.turnId);
    const initialRoute = current.route === 'fast' ? 'fast' : 'deep';
    let memoryResult = await this.runStructuredRole(
      'memory', memoryRequest, `${envelope.turnId}_memory`,
      roleExecutionProfile(initialRoute, 'memory', this.roleProfiles),
      initialRoute === 'fast' ? 'memory_fast' : 'memory_deep'
    );
    if (initialRoute === 'fast' && memoryResult.requiresDeepMemory === true) {
      const reasons = Array.isArray(memoryResult.escalationReasons)
        ? memoryResult.escalationReasons.map(String)
        : ['memory_role_requested'];
      this.store.setTurnRoute(envelope.turnId, 'fast_to_deep', reasons.length ? reasons : ['memory_role_requested']);
      memoryResult = await this.runStructuredRole(
        'memory', { ...memoryRequest, task: 'deep_retrieve_and_extract_evidence', fastMemoryReview: memoryResult },
        `${envelope.turnId}_memory_deep`,
        roleExecutionProfile('deep', 'memory', this.roleProfiles),
        'memory_deep'
      );
      current = this.store.getTurn(envelope.turnId);
    }
    const conversationFrame = normalizeConversationFrame(memoryResult.conversationFrame);
    current = this.store.getTurn(envelope.turnId);
    if (current.route === 'fast' && conversationFrame.needsNuanceReview) {
      this.store.setTurnRoute(envelope.turnId, 'fast_to_deep', ['conversation_nuance']);
      current = this.store.getTurn(envelope.turnId);
    }
    const candidates = Array.isArray(memoryResult.candidates) ? memoryResult.candidates : [];
    const committedFacts = commitVerifiedFacts(this.store, candidates, evidenceSourceMessages);
    const relationship = resolveRelationshipStage(
      scene, memoryResult.relationshipStageReview, evidenceSourceMessages, this.clock()
    );
    const interactionContract = compileInteractionContract({
      envelope,
      scene: { ...scene, relationshipStage: relationship.stage },
      interactionState,
      conversationFrame,
      recentMessages: evidenceSourceMessages
    });
    current = this.store.getTurn(envelope.turnId);
    if (
      current.route === 'fast'
      && (
        interactionContract.preserveAmbiguity
        || interactionContract.recentCorrection.active
        || interactionContract.explicitBoundaries.length > 0
      )
    ) {
      this.store.setTurnRoute(envelope.turnId, 'fast_to_deep', ['interaction_contract']);
      current = this.store.getTurn(envelope.turnId);
    }
    const memoryPacket = {
      query: String(memoryResult.query || currentBatch?.combinedText || envelope.trigger?.triggerType || ''),
      keywords: Array.isArray(memoryResult.keywords) ? memoryResult.keywords.map(String) : [],
      committedFacts: {
        verified: committedFacts.verified.map(item => item.fact.factId),
        provisional: committedFacts.provisional.map(item => item.fact.factId),
        rejected: committedFacts.rejected.map(item => item.fact?.factId || null).filter(Boolean)
      },
      requiresDeepMemory: memoryResult.requiresDeepMemory === true,
      escalationReasons: Array.isArray(memoryResult.escalationReasons) ? memoryResult.escalationReasons.map(String) : [],
      speakerAmbiguity: memoryResult.speakerAmbiguity === true,
      commitmentRisk: memoryResult.commitmentRisk === true,
      relationshipStageReview: memoryResult.relationshipStageReview || null,
      conversationFrame,
      interactionContract,
      effectiveRelationshipStage: relationship.stage,
      relationshipStageAction: relationship.action,
      lifeContext
    };
    this.store.advanceTurn(envelope.turnId, 'memory_running', 'memory_done', {
      memoryPacketJson: JSON.stringify(memoryPacket)
    });
  }

  async completeBrain(envelope, current) {
    const declaredBatch = resolveCurrentUserBatch(envelope);
    const stateMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds.length || 0))
    );
    const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
    const recentMessages = buildGenerationWindow(stateMessages, {
      currentMessageIds: currentBatch?.messageIds || [],
      limit: this.generationContextLimit
    });
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    const baseScene = sceneFromEnvelope(envelope);
    const scene = {
      ...baseScene,
      relationshipStage: memoryPacket.effectiveRelationshipStage || baseScene.relationshipStage
    };
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: stateMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const previousSupervisor = current.supervisorJson
      ? normalizeSupervisorResult(parseRoleJson(current.supervisorJson, 'supervisor'), {
          attempt: Number(parseRoleJson(current.supervisorJson, 'supervisor').attempt || 1),
          direct: !isAutomaticKind(envelope.kind)
        })
      : null;
    const previousDraft = current.brainDraftJson ? parseRoleJson(current.brainDraftJson, 'brain') : null;
    const deliveryPolicy = this.deliveryPolicyFor(envelope);
    const brainRequest = {
      task: previousSupervisor?.decision === 'rewrite' ? 'rewrite_as_yuqi' : 'reply_as_yuqi',
      preset: this.presets.compileFor('brain', {
        scene: { ...scene, kind: envelope.kind },
        revealedFactIds: evidencePack.facts.map(fact => fact.factId)
      }),
      scene,
      ...(currentBatch ? { currentUserBatch: currentUserBatchForRole(currentBatch) } : { currentTrigger: envelope.trigger }),
      ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
      ...(currentRolePlanExecution(envelope) ? { currentRolePlanExecution: currentRolePlanExecution(envelope) } : {}),
      recentMessages,
      interactionState,
      lifeContext: this.lifeSimulation.advanceTo(envelope.characterId, this.clock()),
      evidencePack,
      interactionContract: memoryPacket.interactionContract,
      ...(deliveryPolicy ? { deliveryPolicy } : {}),
      ...(previousSupervisor?.decision === 'rewrite' ? {
        rejectedDraft: previousDraft,
        supervisorIssues: Array.isArray(previousSupervisor.issues) ? previousSupervisor.issues : [],
        rewriteContract: rewriteContractForBrain(previousSupervisor)
      } : {})
    };
    const attempt = Number(previousSupervisor?.attempt || 0) + 1;
    const route = current.route === 'fast' ? 'fast' : 'deep';
    const draft = await this.runBrain(envelope.turnId, brainRequest, attempt, route);
    this.store.advanceTurn(envelope.turnId, 'brain_running', 'brain_done', {
      brainDraftJson: JSON.stringify(draft)
    });
  }

  async completeSupervisor(envelope, current) {
    const draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
    const declaredBatch = resolveCurrentUserBatch(envelope);
    const stateMessages = this.store.listMessages(
      envelope.characterId,
      Math.min(5000, this.contextLimit + Number(declaredBatch?.messageIds.length || 0))
    );
    const currentBatch = resolveCurrentUserBatch(envelope, stateMessages);
    const recentMessages = buildGenerationWindow(stateMessages, {
      currentMessageIds: currentBatch?.messageIds || [],
      limit: this.generationContextLimit
    });
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    const baseScene = sceneFromEnvelope(envelope);
    const scene = {
      ...baseScene,
      relationshipStage: memoryPacket.effectiveRelationshipStage || baseScene.relationshipStage
    };
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: stateMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const evidencePack = buildEvidencePack(this.store, {
      characterId: envelope.characterId,
      query: memoryPacket.query,
      keywords: memoryPacket.keywords,
      limit: 12
    });
    const previousRaw = current.supervisorJson ? parseRoleJson(current.supervisorJson, 'supervisor') : null;
    const previous = previousRaw
      ? normalizeSupervisorResult(previousRaw, {
          attempt: Number(previousRaw.attempt || 1),
          direct: !isAutomaticKind(envelope.kind)
        })
      : null;
    const attempt = Number(previous?.attempt || 0) + 1;
    const deliveryPolicy = this.deliveryPolicyFor(envelope);
    const supervisorRequest = {
      task: 'review_yuqi_reply',
      preset: this.presets.compileFor('supervisor', { scene: { ...scene, kind: envelope.kind } }),
      scene,
      ...(currentBatch ? { currentUserBatch: currentUserBatchForRole(currentBatch) } : { currentTrigger: envelope.trigger }),
      ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
      ...(currentRolePlanExecution(envelope) ? { currentRolePlanExecution: currentRolePlanExecution(envelope) } : {}),
      recentMessages,
      interactionState,
      lifeContext: this.lifeSimulation.advanceTo(envelope.characterId, this.clock()),
      evidencePack,
      conversationFrame: normalizeConversationFrame(memoryPacket.conversationFrame),
      interactionContract: memoryPacket.interactionContract,
      ...(deliveryPolicy ? { deliveryPolicy } : {}),
      draft,
      previousReview: previous,
      rewriteResolution: draft.rewriteResolution
    };
    const reviewed = await this.runStructuredRole(
      'supervisor', supervisorRequest, `${envelope.turnId}_supervisor_${attempt}`,
      roleExecutionProfile('deep', 'supervisor', this.roleProfiles),
      `supervisor_${attempt}`
    );
    let supervisorResult = normalizeSupervisorResult(reviewed, {
      attempt,
      previous,
      direct: !isAutomaticKind(envelope.kind)
    });
    if (
      deliveryPolicy?.skipAllowed === false
      && ['skip', 'reject'].includes(supervisorResult.decision)
    ) {
      const originalDecision = supervisorResult.decision;
      supervisorResult = proactiveDeliveryRewrite(previous, attempt, originalDecision);
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'proactive_supervisor_rewrite_requested',
        level: 'warning',
        detail: {
          policy: deliveryPolicy,
          originalDecision,
          rewriteAttempt: attempt
        }
      });
    }
    if (supervisorResult.decision === 'approve') {
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify(supervisorResult)
      });
      return;
    }
    if (supervisorResult.decision === 'skip') {
      if (!isAutomaticKind(envelope.kind)) throw new Error('supervisor cannot skip a direct reply');
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify(supervisorResult),
        brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
      });
      return;
    }
    if (supervisorResult.decision === 'reject') {
      if (isAutomaticKind(envelope.kind)) {
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify(supervisorResult),
          brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
        });
        return;
      }
      throw new Error('supervisor rejected the reply');
    }
    if (attempt >= 3) {
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: 'supervisor_running',
        level: 'warning',
        detail: { action: 'supervisor_veto_after_rewrites', issues: supervisorResult.issues || [] }
      });
      if (deliveryPolicy?.skipAllowed === false) {
        if (hasHighPriorityIssues(supervisorResult) || !String(draft.reply || '').trim()) {
          this.store.putDiagnostic({
            turnId: envelope.turnId,
            stage: 'proactive_delivery_blocked',
            level: 'error',
            detail: {
              policy: deliveryPolicy,
              issueIds: supervisorResult.issues.map(issue => issue.issueId),
              hardIssue: hasHighPriorityIssues(supervisorResult),
              visibleDraft: Boolean(String(draft.reply || '').trim())
            }
          });
          throw new Error('PROACTIVE_DELIVERY_BLOCKED: no safe visible reply after rewrites');
        }
        this.store.putDiagnostic({
          turnId: envelope.turnId,
          stage: 'proactive_soft_fallback_selected',
          level: 'warning',
          detail: {
            policy: deliveryPolicy,
            issueIds: supervisorResult.issues.map(issue => issue.issueId),
            selectedDraft: draft.reply
          }
        });
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify({ ...supervisorResult, fallbackSelected: true })
        });
        return;
      }
      if (isAutomaticKind(envelope.kind)) {
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify({ ...supervisorResult, vetoed: true }),
          brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
        });
        return;
      }
      if (hasHighPriorityIssues(supervisorResult) && attempt === 3) {
        this.store.putDiagnostic({
          turnId: envelope.turnId,
          stage: 'hard_repair_requested',
          level: 'warning',
          detail: {
            attempt,
            issueIds: supervisorResult.issues.map(issue => issue.issueId)
          }
        });
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
          supervisorJson: JSON.stringify({ ...supervisorResult, finalHardRepair: true })
        });
        return;
      }
      const fallbackStage = hasHighPriorityIssues(supervisorResult)
        ? 'hard_repair_fallback_selected'
        : 'soft_issue_fallback_selected';
      this.store.putDiagnostic({
        turnId: envelope.turnId,
        stage: fallbackStage,
        level: 'warning',
        detail: {
          attempt,
          issueIds: supervisorResult.issues.map(issue => issue.issueId),
          selectedDraft: draft.reply
        }
      });
      this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
        supervisorJson: JSON.stringify({ ...supervisorResult, fallbackSelected: true })
      });
      return;
    }
    this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
      supervisorJson: JSON.stringify(supervisorResult)
    });
  }

  commitApproved(envelope, current) {
    const draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    if (draft.action === 'skip' && isAutomaticKind(envelope.kind)) {
      return this.store.transaction(() => {
        if (draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none') {
          throw new Error('PLAN_REPLY_MISMATCH: a silent action cannot change an existing plan');
        }
        if (draft.lifePlan?.episodes?.length) {
          this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
            sourceTurnId: envelope.turnId
          });
        }
        const result = {
          turnId: envelope.turnId,
          presetVersion: this.presets.current().version,
          action: draft.rolePlanOperations.length ? 'send' : 'skip',
          skipReason: draft.skipReason || null,
          paymentAction: null,
          reply: null,
          usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
          relationshipStageAction: memoryPacket.relationshipStageAction || null,
          lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
          lifeAdjustment: null,
          momentAction: null,
          rolePlanOperations: draft.rolePlanOperations
        };
        this.store.advanceTurn(
          envelope.turnId, 'approved', 'committed', { replyJson: JSON.stringify(result) }
        );
        return result;
      });
    }
    if (isMomentKind(envelope.kind)) {
      return this.store.transaction(() => {
        if (draft.lifePlan?.episodes?.length) {
          this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
            sourceTurnId: envelope.turnId
          });
        }
        const lifeAdjustment = draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none'
          ? this.store.applyLifeAdjustment(
              envelope.characterId, draft.lifeAdjustment, envelope.turnId, this.clock()
            )
          : null;
        const result = {
          turnId: envelope.turnId,
          presetVersion: this.presets.current().version,
          action: 'send',
          paymentAction: null,
          relationshipStageAction: memoryPacket.relationshipStageAction || null,
          momentAction: draft.momentAction,
          rolePlanOperations: draft.rolePlanOperations,
          lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
          lifeAdjustment: lifeAdjustment ? {
            type: draft.lifeAdjustment.type,
            episodeId: lifeAdjustment.episodeId
          } : null,
          reply: null,
          usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : []
        };
        this.store.advanceTurn(
          envelope.turnId, 'approved', 'committed', { replyJson: JSON.stringify(result) }
        );
        return result;
      });
    }
    if (isMomentPostKind(envelope.kind)) {
      return this.store.transaction(() => {
        if (draft.lifePlan?.episodes?.length) {
          this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
            sourceTurnId: envelope.turnId
          });
        }
        const lifeAdjustment = draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none'
          ? this.store.applyLifeAdjustment(
              envelope.characterId, draft.lifeAdjustment, envelope.turnId, this.clock()
            )
          : null;
        const result = {
          turnId: envelope.turnId,
          presetVersion: this.presets.current().version,
          action: 'send',
          paymentAction: null,
          reply: {
            messageId: `msg_yuqi_${contentHash(envelope.turnId).slice(0, 24)}`,
            turnId: envelope.turnId,
            characterId: envelope.characterId,
            speakerId: envelope.characterId,
            speakerType: 'character',
            recipientId: 'public_moments',
            content: draft.reply.trim(),
            sentAt: this.clock(),
            origin: 'codex'
          },
          usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
          relationshipStageAction: memoryPacket.relationshipStageAction || null,
          lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
          lifeAdjustment: lifeAdjustment ? {
            type: draft.lifeAdjustment.type,
            episodeId: lifeAdjustment.episodeId
          } : null,
          momentAction: null,
          rolePlanOperations: draft.rolePlanOperations
        };
        this.store.advanceTurn(envelope.turnId, 'approved', 'committed', {
          replyJson: JSON.stringify(result)
        });
        return result;
      });
    }
    const reply = {
      messageId: `msg_yuqi_${contentHash(envelope.turnId).slice(0, 24)}`,
      turnId: envelope.turnId,
      characterId: envelope.characterId,
      speakerId: envelope.characterId,
      speakerType: 'character',
      recipientId: 'user',
      content: draft.reply.trim(),
      sentAt: this.clock(),
      origin: 'codex'
    };
    const committedResult = this.store.transaction(() => {
      if (draft.lifePlan?.episodes?.length) {
        this.store.putLifePlanInternal(envelope.characterId, draft.lifePlan.episodes, {
          sourceTurnId: envelope.turnId
        });
      }
      const lifeAdjustment = draft.lifeAdjustment?.type && draft.lifeAdjustment.type !== 'none'
        ? this.store.applyLifeAdjustment(
            envelope.characterId, draft.lifeAdjustment, envelope.turnId, this.clock()
          )
        : null;
      const savedReply = this.store.putMessageInternal(reply);
      if (['PROACTIVE_CHAT', 'PROACTIVE_MOMENT'].includes(envelope.kind)) {
        this.store.quarantinePendingReply(savedReply.messageId);
      }
      const result = {
        turnId: envelope.turnId,
        presetVersion: this.presets.current().version,
        action: 'send',
        paymentAction: resolvedPaymentAction(envelope, draft),
        reply: savedReply,
        usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
        relationshipStageAction: memoryPacket.relationshipStageAction || null,
        lifePlanApplied: Boolean(draft.lifePlan?.episodes?.length),
        lifeAdjustment: lifeAdjustment ? {
          type: draft.lifeAdjustment.type,
          episodeId: lifeAdjustment.episodeId
        } : null,
        momentAction: null,
        rolePlanOperations: draft.rolePlanOperations
      };
      this.store.advanceTurn(envelope.turnId, 'approved', 'committed', {
        replyJson: JSON.stringify(result)
      });
      return result;
    });
    const formedCharacterFacts = characterFactCandidatesForReply(
      draft.rewriteResolution,
      committedResult.reply
    );
    if (formedCharacterFacts.length) {
      commitVerifiedFacts(this.store, formedCharacterFacts, [committedResult.reply]);
    }
    return committedResult;
  }

  cancel(turnId) {
    const current = this.store.getTurn(turnId);
    if (!current || ['committed', 'delivered', 'completed', 'failed'].includes(current.state)) return false;
    this.store.advanceTurn(turnId, current.state, 'failed', {
      errorJson: JSON.stringify({ name: 'CancelledError', message: 'turn cancelled by device' })
    });
    return true;
  }

  async runBrain(turnId, request, attempt = 1, route = 'deep') {
    const result = await this.withBrainRoleLock(() => this.runStructuredRole(
      'brain', request, `${turnId}_brain_${attempt}`,
      roleExecutionProfile(route, 'brain', this.roleProfiles),
      `brain_${attempt}`
    ));
    if (typeof result.reply !== 'string') throw new Error('brain reply is missing');
    return normalizeBrainDraft(result);
  }

  async runStructuredRole(role, request, clientUserMessageId, profile, stage = role) {
    if (!profile?.model || !profile?.effort) throw new Error(`missing execution profile for ${role}`);
    const turnId = clientUserMessageId.replace(/_(memory(?:_deep)?|brain_\d+|supervisor_\d+)$/, '');
    this.store.beginStage(turnId, stage, profile.model, profile.effort, this.clock());
    let invalidOutput = '';
    let activeProfile = profile;
    let capacityFallbackUsed = false;
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
      const payload = attempt === 1 ? request : {
        ...request,
        protocolRepair: {
          attempt,
          rule: 'Return exactly one JSON object that matches the supplied output schema.',
          invalidOutput: invalidOutput.slice(0, 2_000)
        }
      };
        const baseMessageId = attempt === 1 ? clientUserMessageId : `${clientUserMessageId}_protocol_${attempt}`;
        let response;
        try {
          response = await this.codex.runTurn(role, JSON.stringify(payload), {
            clientUserMessageId: baseMessageId,
            outputSchema: ROLE_OUTPUT_SCHEMAS[role],
            model: activeProfile.model,
            effort: activeProfile.effort,
            localImagePaths: this.turnImagePaths.get(turnId) || []
          });
        } catch (error) {
          const alternate = capacityFallbackUsed ? null : fallbackRoleProfile(activeProfile);
          if (!isModelCapacityError(error) || !alternate) throw error;
          capacityFallbackUsed = true;
          this.store.putDiagnostic({
            turnId,
            stage: 'model_capacity_failover',
            level: 'warn',
            detail: {
              role,
              failedModel: activeProfile.model,
              fallbackModel: alternate.model,
              effort: alternate.effort,
              error: 'model_capacity'
            }
          });
          activeProfile = alternate;
          response = await this.codex.runTurn(role, JSON.stringify(payload), {
            clientUserMessageId: `${baseMessageId}_capacity_fallback`,
            outputSchema: ROLE_OUTPUT_SCHEMAS[role],
            model: activeProfile.model,
            effort: activeProfile.effort,
            localImagePaths: this.turnImagePaths.get(turnId) || []
          });
        }
        invalidOutput = String(response.text || '');
        try {
          return parseRoleJson(invalidOutput, role);
        } catch (error) {
          if (attempt === 2 || !String(error.message).startsWith(`${role} returned invalid`)) throw error;
        }
      }
      throw new Error(`${role} returned invalid structured output twice`);
    } finally {
      this.store.finishStage(turnId, stage, this.clock());
    }
  }
}
export function isModelCapacityError(error) {
  return String(error?.name || '') === 'CodexTurnError'
    && /(?:selected model is at capacity|model.+capacity|capacity.+model)/i.test(String(error?.message || ''));
}

export function fallbackRoleProfile(profile) {
  const model = String(profile?.model || '');
  if (model.includes('gpt-5.6-sol')) return { ...profile, model: 'gpt-5.6-terra' };
  if (model.includes('gpt-5.6-terra')) return { ...profile, model: 'gpt-5.6-sol' };
  return null;
}
