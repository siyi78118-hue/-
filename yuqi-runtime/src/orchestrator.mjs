import { commitVerifiedFacts } from './evidence-memory.mjs';
import { contentHash } from './protocol.mjs';
import { buildEvidencePack } from './retrieval.mjs';
import { ROLE_OUTPUT_SCHEMAS } from './role-schemas.mjs';
import { DEFAULT_PROFILES, roleExecutionProfile, selectTurnRoute } from './route-policy.mjs';
import { resolveRelationshipStage, sceneFromEnvelope } from './relationship-stage.mjs';
import { buildAuthoritativeInteractionState } from './interaction-state.mjs';
import { buildGenerationWindow } from './conversation-context.mjs';

function parseRoleJson(text, role) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(source); } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${role} returned invalid object`);
  return value;
}

export function hardValidateReply(reply) {
  const issues = [];
  const text = String(reply || '').trim();
  if (!text) issues.push({ code: 'EMPTY_REPLY', message: 'reply is empty' });
  if (text.length > 20_000) issues.push({ code: 'REPLY_TOO_LARGE', message: 'reply is too large' });
  return { ok: issues.length === 0, issues };
}

export function normalizeBrainDraft(draft) {
  const paymentAction = ['received', 'refused', 'pending'].includes(draft?.paymentAction)
    ? draft.paymentAction
    : null;
  const normalized = {
    ...(draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {}),
    action: draft?.action === 'skip' ? 'skip' : 'send',
    reply: String(draft?.reply || '').trim(),
    paymentAction,
    momentAction: draft?.momentAction && typeof draft.momentAction === 'object' && !Array.isArray(draft.momentAction)
      ? {
          momentId: String(draft.momentAction.momentId || ''),
          like: draft.momentAction.like === true,
          comment: String(draft.momentAction.comment || '').trim().slice(0, 1000),
          replyToCommentId: draft.momentAction.replyToCommentId ? String(draft.momentAction.replyToCommentId) : null
        }
      : null,
    usedFactIds: Array.isArray(draft?.usedFactIds) ? draft.usedFactIds.map(String) : []
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

export function isAutomaticKind(kind) {
  return [
    'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE',
    'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY'
  ].includes(kind);
}

function normalizeSupervisorResult(reviewed) {
  const legacyDecision = reviewed?.approved === true ? 'approve' : reviewed?.approved === false ? 'rewrite' : null;
  const decision = ['approve', 'rewrite', 'skip', 'reject'].includes(reviewed?.decision)
    ? reviewed.decision
    : legacyDecision || 'reject';
  return { ...reviewed, decision, approved: decision === 'approve' };
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
      : '等你有空再聊。';
  }
  return text.length > 20_000 ? text.slice(0, 20_000) : text;
}

export class YuqiOrchestrator {
  constructor({
    store, presets, codex, workerId = 'yuqi-worker', clock = Date.now, contextLimit = 200,
    generationContextLimit = 24, roleProfiles = DEFAULT_PROFILES
  }) {
    if (!store || !presets || !codex) throw new Error('store, presets, and codex are required');
    this.store = store;
    this.presets = presets;
    this.codex = codex;
    this.workerId = workerId;
    this.clock = clock;
    this.contextLimit = Math.max(1, Math.min(5000, Number(contextLimit) || 200));
    this.generationContextLimit = Math.max(1, Math.min(200, Number(generationContextLimit) || 24));
    this.roleProfiles = roleProfiles;
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

  async process(envelope) {
    const submitted = this.accept(envelope);
    return this.run(submitted.turnId);
  }

  async run(turnId) {
    let current = this.store.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state === 'committed' && current.replyJson) return JSON.parse(current.replyJson);
    if (['delivered', 'completed'].includes(current.state) && current.replyJson) return JSON.parse(current.replyJson);
    if (['failed', 'fallback'].includes(current.state)) throw new Error(`turn is already ${current.state}`);
    const envelope = JSON.parse(current.envelopeJson);

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
          if (draft.action === 'skip') {
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
    }
  }

  async completeMemory(envelope) {
    const recentMessages = this.store.listMessages(envelope.characterId, this.contextLimit);
    const scene = sceneFromEnvelope(envelope);
    const interactionState = buildAuthoritativeInteractionState({
      envelope, messages: recentMessages, currentStage: scene.relationshipStage, now: this.clock()
    });
    const memoryRequest = {
      task: envelope.message ? 'retrieve_and_extract_evidence' : 'retrieve_context_for_trigger',
      preset: this.presets.compileFor('memory', { scene: { ...scene, kind: envelope.kind } }),
      scene,
      ...(envelope.message
        ? { currentMessageId: envelope.message.messageId }
        : { currentTrigger: envelope.trigger, triggerIsNotUserEvidence: true }),
      recentMessages,
      interactionState
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
    const committedFacts = commitVerifiedFacts(this.store, candidates, recentMessages);
    const relationship = resolveRelationshipStage(
      scene, memoryResult.relationshipStageReview, recentMessages, this.clock()
    );
    const memoryPacket = {
      query: String(memoryResult.query || envelope.message?.content || envelope.trigger?.triggerType || ''),
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
      effectiveRelationshipStage: relationship.stage,
      relationshipStageAction: relationship.action
    };
    this.store.advanceTurn(envelope.turnId, 'memory_running', 'memory_done', {
      memoryPacketJson: JSON.stringify(memoryPacket)
    });
  }

  async completeBrain(envelope, current) {
    const stateMessages = this.store.listMessages(envelope.characterId, this.contextLimit);
    const recentMessages = buildGenerationWindow(stateMessages, {
      currentMessageId: envelope.message?.messageId,
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
      ? normalizeSupervisorResult(parseRoleJson(current.supervisorJson, 'supervisor'))
      : null;
    const previousDraft = current.brainDraftJson ? parseRoleJson(current.brainDraftJson, 'brain') : null;
    const brainRequest = {
      task: previousSupervisor?.decision === 'rewrite' ? 'rewrite_as_yuqi' : 'reply_as_yuqi',
      preset: this.presets.compileFor('brain', {
        scene: { ...scene, kind: envelope.kind },
        revealedFactIds: evidencePack.facts.map(fact => fact.factId)
      }),
      scene,
      ...(envelope.message ? { currentUserMessage: envelope.message } : { currentTrigger: envelope.trigger }),
      ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
      recentMessages,
      interactionState,
      evidencePack,
      conversationFrame: normalizeConversationFrame(memoryPacket.conversationFrame),
      ...(previousSupervisor?.decision === 'rewrite' ? {
        rejectedDraft: previousDraft,
        supervisorIssues: Array.isArray(previousSupervisor.issues) ? previousSupervisor.issues : []
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
    const draft = parseRoleJson(current.brainDraftJson, 'brain');
    const stateMessages = this.store.listMessages(envelope.characterId, this.contextLimit);
    const recentMessages = buildGenerationWindow(stateMessages, {
      currentMessageId: envelope.message?.messageId,
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
    const previous = current.supervisorJson ? parseRoleJson(current.supervisorJson, 'supervisor') : null;
    const attempt = Number(previous?.attempt || 0) + 1;
    const supervisorRequest = {
      task: 'review_yuqi_reply',
      preset: this.presets.compileFor('supervisor', { scene: { ...scene, kind: envelope.kind } }),
      scene,
      ...(envelope.message ? { currentUserMessage: envelope.message } : { currentTrigger: envelope.trigger }),
      ...(envelope.context?.payment ? { currentPayment: envelope.context.payment } : {}),
      recentMessages,
      interactionState,
      evidencePack,
      conversationFrame: normalizeConversationFrame(memoryPacket.conversationFrame),
      draft
    };
    const reviewed = await this.runStructuredRole(
      'supervisor', supervisorRequest, `${envelope.turnId}_supervisor_${attempt}`,
      roleExecutionProfile('deep', 'supervisor', this.roleProfiles),
      `supervisor_${attempt}`
    );
    const supervisorResult = { ...normalizeSupervisorResult(reviewed), attempt };
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
      if (isAutomaticKind(envelope.kind)) {
        this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'approved', {
          supervisorJson: JSON.stringify({ ...supervisorResult, vetoed: true }),
          brainDraftJson: JSON.stringify({ ...draft, action: 'skip', reply: '' })
        });
        return;
      }
      throw new Error('supervisor rejected the reply after three rewrites');
    }
    this.store.advanceTurn(envelope.turnId, 'supervisor_running', 'brain_running', {
      supervisorJson: JSON.stringify(supervisorResult)
    });
  }

  commitApproved(envelope, current) {
    const draft = normalizeBrainDraft(parseRoleJson(current.brainDraftJson, 'brain'));
    const memoryPacket = parseRoleJson(current.memoryPacketJson, 'memory');
    if (draft.action === 'skip' && isAutomaticKind(envelope.kind)) {
      const result = {
        turnId: envelope.turnId,
        presetVersion: this.presets.current().version,
        action: 'skip',
        paymentAction: null,
        reply: null,
        usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : [],
        relationshipStageAction: memoryPacket.relationshipStageAction || null,
        momentAction: null
      };
      this.store.advanceTurn(envelope.turnId, 'approved', 'committed', { replyJson: JSON.stringify(result) });
      return result;
    }
    if (isMomentKind(envelope.kind)) {
      const result = {
        turnId: envelope.turnId,
        presetVersion: this.presets.current().version,
        action: 'send',
        paymentAction: null,
        relationshipStageAction: memoryPacket.relationshipStageAction || null,
        momentAction: draft.momentAction,
        reply: null,
        usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds : []
      };
      this.store.advanceTurn(envelope.turnId, 'approved', 'committed', { replyJson: JSON.stringify(result) });
      return result;
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
    const savedReply = this.store.putMessage(reply);
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
      momentAction: null
    };
    this.store.advanceTurn(envelope.turnId, 'approved', 'committed', {
      replyJson: JSON.stringify(result)
    });
    return result;
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
    const result = await this.runStructuredRole(
      'brain', request, `${turnId}_brain_${attempt}`,
      roleExecutionProfile(route, 'brain', this.roleProfiles),
      `brain_${attempt}`
    );
    if (typeof result.reply !== 'string') throw new Error('brain reply is missing');
    return normalizeBrainDraft(result);
  }

  async runStructuredRole(role, request, clientUserMessageId, profile, stage = role) {
    if (!profile?.model || !profile?.effort) throw new Error(`missing execution profile for ${role}`);
    const turnId = clientUserMessageId.replace(/_(memory(?:_deep)?|brain_\d+|supervisor_\d+)$/, '');
    this.store.beginStage(turnId, stage, profile.model, profile.effort, this.clock());
    let invalidOutput = '';
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
        const response = await this.codex.runTurn(role, JSON.stringify(payload), {
        clientUserMessageId: attempt === 1 ? clientUserMessageId : `${clientUserMessageId}_protocol_${attempt}`,
        outputSchema: ROLE_OUTPUT_SCHEMAS[role],
          model: profile.model,
          effort: profile.effort
        });
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
