import { commitVerifiedFacts } from './evidence-memory.mjs';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

function parseObject(text) {
  const source = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const value = JSON.parse(source);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('consolidation returned invalid JSON');
  }
  return value;
}

function messageEvidenceSource(message, turnState) {
  if (message.speakerType !== 'character') return 'user_visible_message';
  return ['delivered', 'completed'].includes(turnState)
    ? 'yuqi_delivered_message'
    : 'fallback_provisional';
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
    const allowedIds = new Set(
      Array.isArray(job.payload?.messageIds) ? job.payload.messageIds.map(String) : []
    );
    const messages = this.store.listMessages(job.roleId, 5000).filter(message => (
      allowedIds.size ? allowedIds.has(message.messageId) : message.turnId === job.turnId
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
        'Every candidate needs sourceMessageIds and exactQuotes copied from the supplied messages.'
      ].join(' '),
      turn: turn ? {
        turnId: turn.turnId,
        kind: turn.kind,
        state: turn.state,
        pipelineMode: turn.pipelineMode,
        presetVersion: turn.presetVersion
      } : null,
      exactVisibleMessages: messages.map(message => ({
        messageId: message.messageId,
        speakerId: message.speakerId,
        speakerType: message.speakerType,
        content: message.content,
        sentAt: message.sentAt,
        evidenceSource: messageEvidenceSource(message, turn?.state)
      }))
    }), {
      clientUserMessageId: `consolidation_${job.jobId}_${job.attemptCount}`,
      model: 'gpt-5.6-terra',
      effort: 'medium'
    });
    const parsed = parseObject(response.text);
    const byId = new Map(messages.map(message => [message.messageId, message]));
    const candidates = (Array.isArray(parsed.candidates) ? parsed.candidates : []).map(candidate => {
      const sources = (candidate.sourceMessageIds || []).map(id => byId.get(String(id))).filter(Boolean);
      const evidenceSource = sources.some(message => (
        messageEvidenceSource(message, turn?.state) === 'fallback_provisional'
      ))
        ? 'fallback_provisional'
        : sources.some(message => message.speakerType === 'character')
          ? 'yuqi_delivered_message'
          : 'user_visible_message';
      return { ...candidate, evidenceSource, origin: 'consolidation' };
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
