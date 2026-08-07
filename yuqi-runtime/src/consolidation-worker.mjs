import { commitVerifiedFacts } from './evidence-memory.mjs';
import { canonicalJson, contentHash } from './protocol.mjs';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

function allowedEvidenceIds(payload) {
  const hasMessageIds = Object.prototype.hasOwnProperty.call(payload || {}, 'messageIds');
  const hasActionIds = Object.prototype.hasOwnProperty.call(payload || {}, 'actionIds');
  const validIds = value => Array.isArray(value)
    && value.every(id => typeof id === 'string' && id.trim().length > 0);
  if ((hasMessageIds && !validIds(payload.messageIds))
    || (hasActionIds && !validIds(payload.actionIds))) {
    return { invalid: true, scoped: true, messageIds: new Set(), actionIds: new Set() };
  }
  const scoped = hasMessageIds || hasActionIds;
  return {
    invalid: false,
    scoped,
    messageIds: new Set(hasMessageIds ? payload.messageIds : []),
    actionIds: new Set(hasActionIds ? payload.actionIds : [])
  };
}

function parseObject(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value;
}

function messageEvidenceSource(message, turnState) {
  if (message.speakerType !== 'character') return 'user_visible_message';
  if (message.redacted || message.withdrawn || message.archived || message.superseded || message.suppressed) {
    return 'legacy_provisional';
  }
  return (message.committed === true
    || message.deliveryState === 'confirmed'
    || ['delivered', 'completed', 'committed'].includes(turnState))
    ? 'yuqi_delivered_message'
    : 'legacy_provisional';
}

function nativeString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function authorityMessage(canonical, message, deliveryState) {
  return {
    ...message,
    committed: true,
    authorityVerified: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityGroupId: canonical.visibleGroupId,
    authorityLineageKey: canonical.authorityLineageKey,
    authorityCommitChecksum: canonical.commitChecksum,
    deliveryState,
    redacted: false
  };
}

function authorityAction(canonical, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)
    || !nativeString(canonical?.roleId)
    || !nativeString(action.actionId)
    || !nativeString(action.kind)
    || !nativeString(action.targetKey)
    || !nativeString(action.targetRevision)
    || !action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)
    || !/^[a-f0-9]{64}$/.test(action.actionChecksum || '')) return null;
  return {
    evidenceKind: 'action',
    actionId: action.actionId,
    kind: action.kind,
    targetKey: action.targetKey,
    targetRevision: action.targetRevision,
    payload: action.payload,
    actionChecksum: action.actionChecksum,
    authorityVerified: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityGroupId: canonical.visibleGroupId,
    authorityLineageKey: canonical.authorityLineageKey,
    authorityCommitChecksum: canonical.commitChecksum,
    authorityRoleId: canonical.roleId,
    deliveryState: 'confirmed',
    redacted: false
  };
}

function authorityReplyPart(canonical, part) {
  if (!part || typeof part !== 'object' || Array.isArray(part)
    || !nativeString(canonical?.turnId)
    || !nativeString(canonical?.roleId)
    || !nativeString(part.messageId)
    || !nativeString(part.content)
    || !Number.isSafeInteger(part.sentAt)) return null;
  const speakerId = Object.prototype.hasOwnProperty.call(part, 'speakerId')
    ? part.speakerId
    : canonical.roleId;
  const speakerType = Object.prototype.hasOwnProperty.call(part, 'speakerType')
    ? part.speakerType
    : 'character';
  const recipientId = Object.prototype.hasOwnProperty.call(part, 'recipientId')
    ? part.recipientId
    : 'user';
  if (!nativeString(speakerId)
    || !['user', 'character'].includes(speakerType)
    || !nativeString(recipientId)) return null;
  return authorityMessage(canonical, {
    ...part,
    messageId: part.messageId,
    turnId: canonical.turnId,
    characterId: canonical.roleId,
    speakerId,
    speakerType,
    recipientId,
    content: part.content,
    sentAt: part.sentAt,
    terminalDisposition: canonical.terminalDisposition
  }, 'confirmed');
}

function comparableBatch(batch) {
  return {
    batchId: batch?.batchId,
    characterId: batch?.characterId,
    sourceMessageId: batch?.sourceMessageId,
    messageIds: batch?.messageIds,
    startedAt: batch?.startedAt,
    committedAt: batch?.committedAt,
    checksum: batch?.checksum,
    messages: batch?.messages
  };
}

function currentBatchEvidenceForTurn(store, turn, canonical) {
  if (typeof store.getCurrentUserBatch !== 'function') return { messages: [], invalid: false };
  const hasCanonicalTurnId = Object.prototype.hasOwnProperty.call(canonical || {}, 'turnId');
  const authoritativeTurnId = hasCanonicalTurnId
    ? (nativeString(canonical.turnId) ? canonical.turnId : null)
    : null;
  if (!authoritativeTurnId) return { messages: [], invalid: true };
  if (typeof store.assertCanonicalTurnInputAuthorityInternal === 'function'
    && typeof store.getTurn === 'function') {
    try {
      const persistedTurn = store.getTurn(authoritativeTurnId);
      const persistedEnvelope = persistedTurn?.envelopeJson
        ? JSON.parse(persistedTurn.envelopeJson)
        : null;
      if (!persistedTurn || !persistedEnvelope) return { messages: [], invalid: true };
      store.assertCanonicalTurnInputAuthorityInternal({
        storedTurn: persistedTurn,
        incomingEnvelope: persistedEnvelope,
        mode: 'live_reopen'
      });
    } catch {
      return { messages: [], invalid: true };
    }
  }
  let batch;
  try {
    batch = store.getCurrentUserBatch(authoritativeTurnId);
  } catch {
    return { messages: [], invalid: true };
  }
  if (!batch) return { messages: [], invalid: false };
  if (authoritativeTurnId !== turn.turnId) {
    let originalBatch;
    try {
      originalBatch = store.getCurrentUserBatch(turn.turnId);
    } catch {
      return { messages: [], invalid: true };
    }
    if (!originalBatch
      || canonicalJson(comparableBatch(originalBatch)) !== canonicalJson(comparableBatch(batch))) {
      return { messages: [], invalid: true };
    }
  }
  const messageIds = Array.isArray(batch.messageIds)
    && batch.messageIds.length > 0
    && batch.messageIds.every(messageId => nativeString(messageId))
    ? [...batch.messageIds]
    : [];
  const messages = Array.isArray(batch.messages) ? batch.messages : [];
  if (batch.turnId !== authoritativeTurnId
    || batch.characterId !== (canonical.roleId || turn.characterId)
    || !batch.batchId
    || !batch.sourceMessageId
    || !messageIds.length
    || messageIds.length !== messages.length
    || new Set(messageIds).size !== messageIds.length
    || !nativeString(batch.sourceMessageId)
    || !messageIds.includes(batch.sourceMessageId)
    || typeof batch.startedAt !== 'number'
    || !Number.isSafeInteger(batch.startedAt)
    || typeof batch.committedAt !== 'number'
    || !Number.isSafeInteger(batch.committedAt)
    || !/^[a-f0-9]{64}$/.test(batch.checksum || '')
    || contentHash({
      batchId: batch.batchId,
      sourceMessageId: batch.sourceMessageId,
      messageIds,
      startedAt: batch.startedAt,
      committedAt: batch.committedAt
    }) !== batch.checksum) {
    return { messages: [], invalid: true };
  }
  const byId = new Map(messages
    .filter(message => message && nativeString(message.messageId))
    .map(message => [message.messageId, message]));
  const projected = [];
  for (const messageId of messageIds) {
    const message = byId.get(messageId);
    if (!message
      || message.messageId !== messageId
      || message.speakerType !== 'user'
      || (message.recipientId != null && message.recipientId !== turn.characterId)
      || !nativeString(message.speakerId)
      || !nativeString(message.content)
      || !Number.isSafeInteger(message.sentAt)
      || message.redacted || message.withdrawn || message.archived
      || message.superseded || message.suppressed
      || (message.lifecycleStatus != null
        && (typeof message.lifecycleStatus !== 'string'
          || ['redacted', 'withdrawn', 'archived', 'superseded', 'suppressed']
            .includes(message.lifecycleStatus)))) {
      return { messages: [], invalid: true };
    }
    projected.push(authorityMessage(canonical, message, 'input'));
  }
  return { messages: projected, invalid: false };
}

function canonicalEvidenceForTurn(store, turn, allowed) {
  if (turn?.resultAuthorityVersion !== 1) return null;
  if (typeof store.loadCanonicalBridgeResultInternal !== 'function') return [];
  let canonical;
  try {
    canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
  } catch {
    return [];
  }
  if (!canonical || canonical.status === 'redacted' || canonical.terminalDisposition === 'skip') return [];
  const input = currentBatchEvidenceForTurn(store, turn, canonical);
  if (input.invalid) return [];
  const deliveries = typeof store.outboxForGroup === 'function'
    ? store.outboxForGroup(canonical.visibleGroupId)
    : [];
  const delivered = deliveries.length > 0 && deliveries.every(delivery =>
    delivery.state === 'confirmed' || delivery.confirmedAt != null
  );
  const rawReplyParts = Array.isArray(canonical.replyParts) ? canonical.replyParts : [];
  const rawActions = Array.isArray(canonical.actions) ? canonical.actions : [];
  const resultParts = delivered ? rawReplyParts.map(part => authorityReplyPart(canonical, part)) : [];
  const resultActions = delivered ? rawActions.map(action => authorityAction(canonical, action)) : [];
  if (resultParts.some(part => !part) || resultActions.some(action => !action)) return [];
  if (allowed.scoped
    && ([...allowed.messageIds].some(messageId => !input.messages.some(message => message.messageId === messageId)
      && !resultParts.some(message => message.messageId === messageId))
      || [...allowed.actionIds].some(actionId => !resultActions.some(action => action.actionId === actionId)))) {
    return [];
  }
  const selected = [
    ...input.messages.filter(message => !allowed.scoped || allowed.messageIds.has(message.messageId)),
    ...resultParts.filter(message => !allowed.scoped || allowed.messageIds.has(message.messageId)),
    ...resultActions.filter(action => !allowed.scoped || allowed.actionIds.has(action.actionId))
  ];
  const byId = new Map();
  for (const message of selected) {
    const identity = message.evidenceKind === 'action'
      ? `action:${message.actionId}`
      : `message:${message.messageId}`;
    const previous = byId.get(identity);
    if (previous && canonicalJson(previous) !== canonicalJson(message)) return [];
    byId.set(identity, message);
  }
  return [...byId.values()];
}

export class ConsolidationWorker {
  constructor({
    store,
    codexClient,
    presetRegistry,
    clock = Date.now,
    workerId = 'yuqi-consolidation',
    pollIntervalMs = 5000
  } = {}) {
    if (!store || !codexClient || !presetRegistry) {
      throw new Error('store, codexClient, and presetRegistry are required');
    }
    this.store = store;
    this.codexClient = codexClient;
    this.presetRegistry = presetRegistry;
    this.clock = clock;
    this.workerId = workerId;
    this.pollIntervalMs = Math.max(50, Number(pollIntervalMs) || 5000);
    this.timer = null;
    this.currentRun = null;
    this.stopping = false;
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    const tick = () => {
      if (this.stopping || this.currentRun) return;
      this.currentRun = this.runOnce()
        .catch(error => {
          this.store.putDiagnostic({
            turnId: null,
            stage: 'memory_consolidation_worker',
            level: 'error',
            detail: { name: error.name, message: error.message }
          });
        })
        .finally(() => { this.currentRun = null; });
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref?.();
    tick();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.currentRun) await this.currentRun;
  }

  evidenceForJob(job) {
    const turn = job.turnId ? this.store.getTurn(job.turnId) : null;
    const allowed = allowedEvidenceIds(job.payload);
    if (allowed.invalid) return { turn, messages: [] };
    const canonicalMessages = canonicalEvidenceForTurn(this.store, turn, allowed);
    if (canonicalMessages !== null) return { turn, messages: canonicalMessages };
    const messages = this.store.listMessages(job.roleId, 5000).filter(message => (
      allowed.scoped ? allowed.messageIds.has(message.messageId) : message.turnId === job.turnId
    )).filter(message => (
      message.origin !== 'fallback'
      && String(message.content || '').trim()
      && !message.redacted
      && !message.withdrawn
      && !message.archived
      && !message.superseded
      && !message.suppressed
      && (message.speakerType !== 'character'
        || messageEvidenceSource(message, turn?.state) === 'yuqi_delivered_message')
    ));
    return { turn, messages };
  }

  async processJob(job) {
    const { turn, messages } = this.evidenceForJob(job);
    const presetVersion = turn?.presetVersion || this.presetRegistry.current().version;
    const system = this.presetRegistry.resolvePresetBundle({
      role: 'consolidation',
      version: presetVersion,
      annotations: []
    });
    const response = await this.codexClient.runTurn('memory', JSON.stringify({
      system,
      task: job.jobType,
      rule: [
        'Extract only evidence-backed durable facts from the exact visible messages.',
        'Preserve speaker attribution. Automatic triggers are not user facts.',
        'Return {"candidates":[]} when no durable fact exists.',
        'Every candidate needs sourceMessageIds/exactQuotes and/or sourceActionIds/exactActions copied from the supplied evidence.'
      ].join(' '),
      turn: turn ? {
        turnId: turn.turnId,
        kind: turn.kind,
        state: turn.state,
        pipelineMode: turn.pipelineMode,
        presetVersion: turn.presetVersion
      } : null,
      exactVisibleMessages: messages
        .filter(message => message.evidenceKind !== 'action')
        .map(message => ({
        messageId: message.messageId,
        speakerId: message.speakerId,
        speakerType: message.speakerType,
        content: message.content,
        sentAt: message.sentAt,
        evidenceSource: messageEvidenceSource(message, turn?.state)
        })),
      exactVisibleActions: messages
        .filter(message => message.evidenceKind === 'action')
        .map(action => ({
          actionId: action.actionId,
          kind: action.kind,
          targetKey: action.targetKey,
          targetRevision: action.targetRevision,
          payload: action.payload,
          actionChecksum: action.actionChecksum,
          evidenceSource: 'yuqi_delivered_action'
        }))
    }), {
      clientUserMessageId: `consolidation_${job.jobId}_${job.attemptCount}`,
      model: 'gpt-5.6-terra',
      effort: 'medium'
    });
    const parsed = parseObject(response.text);
    if (!parsed || !Array.isArray(parsed.candidates)) {
      return {
        verified: [],
        provisional: [],
        rejected: [{
          status: 'rejected',
          reasons: ['consolidation model output must contain an array of candidates'],
          fact: null
        }]
      };
    }
    const byMessageId = new Map(messages
      .filter(message => message.evidenceKind !== 'action')
      .map(message => [message.messageId, message]));
    const byActionId = new Map(messages
      .filter(message => message.evidenceKind === 'action')
      .map(action => [action.actionId, action]));
    const forceAuthority = turn?.resultAuthorityVersion === 1;
    const candidates = parsed.candidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        return forceAuthority
          ? {
            type: null,
            origin: 'consolidation',
            authorityContractVersion: 'v3',
            evidenceSource: 'user_visible_message'
          }
          : candidate;
      }
      const sources = Array.isArray(candidate.sourceMessageIds)
        ? candidate.sourceMessageIds
          .filter(id => typeof id === 'string')
          .map(id => byMessageId.get(id))
          .filter(Boolean)
        : [];
      const actionSources = Array.isArray(candidate.sourceActionIds)
        ? candidate.sourceActionIds
          .filter(id => typeof id === 'string')
          .map(id => byActionId.get(id))
          .filter(Boolean)
        : [];
      const allSources = [...sources, ...actionSources];
      const evidenceSource = sources.some(message => (
        messageEvidenceSource(message, turn?.state) === 'legacy_provisional'
      ))
        ? 'legacy_provisional'
        : allSources.some(message => message.evidenceKind === 'action')
          ? 'yuqi_delivered_action'
          : allSources.some(message => message.speakerType === 'character')
            ? 'yuqi_delivered_message'
          : 'user_visible_message';
      return {
        ...candidate,
        evidenceSource,
        authorityContractVersion: forceAuthority
          ? 'v3'
          : (allSources.some(message => message.authorityVerified === true)
            ? 'v3'
            : candidate.authorityContractVersion),
        origin: forceAuthority
          ? 'consolidation'
          : (allSources.some(message => message.authorityVerified === true)
            ? 'consolidation'
            : 'legacy')
      };
    });
    return commitVerifiedFacts(this.store, candidates, messages);
  }

  async claimAndRun(jobTypes) {
    const at = this.clock();
    const job = this.store.claimDueConsolidationJob({
      workerId: this.workerId,
      jobTypes,
      now: at,
      leaseMs: Math.max(60_000, this.pollIntervalMs * 20)
    });
    if (!job) return null;
    try {
      const result = await this.processJob(job);
      this.store.completeConsolidationJob({
        jobId: job.jobId,
        workerId: this.workerId,
        now: this.clock()
      });
      return { jobId: job.jobId, result };
    } catch (error) {
      const failedAt = this.clock();
      const delay = RETRY_DELAYS_MS[job.attemptCount - 1] || 0;
      this.store.failConsolidationJob({
        jobId: job.jobId,
        workerId: this.workerId,
        now: failedAt,
        errorCode: String(error?.code || error?.name || 'CONSOLIDATION_FAILED'),
        nextDueAt: delay ? failedAt + delay : failedAt
      });
      return { jobId: job.jobId, error };
    }
  }

  async runOnce() {
    return this.claimAndRun(['turn_consolidation']);
  }

  async runBackfillOnce({ roleId, maxGroups = 10 } = {}) {
    if (!String(roleId || '') || Number(maxGroups) < 1) return null;
    return this.claimAndRun(['history_backfill']);
  }
}
