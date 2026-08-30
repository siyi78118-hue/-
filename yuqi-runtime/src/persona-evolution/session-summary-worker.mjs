import { discoverClosedSessions, DEFAULT_SESSION_IDLE_TIMEOUT_MS } from './session-boundary.mjs';

export const DEFAULT_SESSION_SUMMARY_SWEEP_INTERVAL_MS = 60 * 1000;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function roleList(value) {
  if (!Array.isArray(value) || !value.length
    || value.some(roleId => typeof roleId !== 'string' || !roleId.trim())
    || new Set(value).size !== value.length) throw new Error('roleIds must be unique non-empty strings');
  return [...value];
}

export class SessionSummaryWorker {
  constructor({
    source,
    summarizer,
    roleIds = ['yuqi'],
    idleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    sweepIntervalMs = DEFAULT_SESSION_SUMMARY_SWEEP_INTERVAL_MS,
    now = () => Date.now(),
    logger = null,
    onSummaryFinalized = null
  } = {}) {
    if (!source?.listAll) throw new Error('session summary source is required');
    if (!summarizer?.finalizeSession) throw new Error('session summarizer is required');
    if (typeof now !== 'function') throw new Error('session summary clock is required');
    if (onSummaryFinalized !== null && typeof onSummaryFinalized !== 'function') {
      throw new Error('session summary observer must be a function');
    }
    this.source = source;
    this.summarizer = summarizer;
    this.roleIds = roleList(roleIds);
    this.idleTimeoutMs = positiveInteger(idleTimeoutMs, 'idleTimeoutMs');
    this.sweepIntervalMs = positiveInteger(sweepIntervalMs, 'sweepIntervalMs');
    this.now = now;
    this.logger = logger;
    this.onSummaryFinalized = onSummaryFinalized;
    this.timer = null;
    this.current = null;
    this.background = new Set();
  }

  start() {
    if (this.timer) return;
    this.observeTask(this.recover());
    this.timer = setInterval(() => this.observeTask(this.sweep()), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recover() {
    return this.sweep();
  }

  sweep() {
    if (this.current) return this.current;
    const run = this.runSweep().finally(() => {
      if (this.current === run) this.current = null;
    });
    this.current = run;
    return run;
  }

  observeVisibleMessage({ roleId } = {}) {
    if (typeof roleId !== 'string' || !roleId.trim() || !this.roleIds.includes(roleId)) return;
    this.observeTask(this.sweep());
  }

  observeTask(task) {
    const handled = Promise.resolve(task).catch(error => {
      this.logger?.({ event: 'failed', error: error?.name || 'Error' });
    }).finally(() => this.background.delete(handled));
    this.background.add(handled);
  }

  async idle() {
    if (this.current) await this.current.catch(() => {});
    await Promise.allSettled([...this.background]);
  }

  async runSweep() {
    const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 };
    for (const roleId of this.roleIds) {
      let items;
      try {
        items = await this.source.listAll(roleId);
      } catch (error) {
        counts.failed += 1;
        this.logger?.({ event: 'failed', roleId, error: error?.name || 'Error' });
        continue;
      }
      const groups = new Map();
      for (const item of items) {
        if (item?.roleId !== roleId || typeof item.conversationId !== 'string' || !item.conversationId.trim()) {
          counts.failed += 1;
          continue;
        }
        const group = groups.get(item.conversationId) || [];
        group.push({ id: item.id, speaker: item.speaker, createdAt: item.createdAt, content: item.content });
        groups.set(item.conversationId, group);
      }
      for (const [conversationId, messages] of groups) {
        const sessions = discoverClosedSessions({
          roleId, conversationId, messages,
          now: Number(this.now()), idleTimeoutMs: this.idleTimeoutMs
        });
        for (const session of sessions) {
          try {
            const result = await this.summarizer.finalizeSession(session);
            counts[result.status] += 1;
            if (this.onSummaryFinalized) {
              this.observeTask(Promise.resolve().then(() => this.onSummaryFinalized({
                roleId,
                summaryId: result.summaryId,
                status: result.status
              })));
            }
          } catch (error) {
            counts.failed += 1;
            this.logger?.({
              event: 'failed', roleId, sessionId: session.sessionId,
              messageCount: session.messages.length, error: error?.name || 'Error'
            });
          }
        }
      }
    }
    return counts;
  }
}
