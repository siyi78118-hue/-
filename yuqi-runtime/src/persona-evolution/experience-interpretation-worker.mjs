export const DEFAULT_EXPERIENCE_INTERPRETATION_SWEEP_INTERVAL_MS = 60 * 1000;

function roles(value) {
  if (!Array.isArray(value) || !value.length
    || value.some(roleId => typeof roleId !== 'string' || !roleId.trim())
    || new Set(value).size !== value.length) {
    throw new Error('experience interpretation roleIds must be unique non-empty strings');
  }
  return [...value];
}

export class ExperienceInterpretationWorker {
  constructor({
    repository,
    interpreter,
    roleIds = ['yuqi'],
    sweepIntervalMs = DEFAULT_EXPERIENCE_INTERPRETATION_SWEEP_INTERVAL_MS,
    logger = null
  } = {}) {
    if (!repository?.listSessionSummaries) throw new Error('experience interpretation repository is required');
    if (!interpreter?.interpretSession) throw new Error('experience interpreter is required');
    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
      throw new Error('experience interpretation sweepIntervalMs is invalid');
    }
    this.repository = repository;
    this.interpreter = interpreter;
    this.roleIds = roles(roleIds);
    this.sweepIntervalMs = sweepIntervalMs;
    this.logger = logger;
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

  observeSummary({ roleId, summaryId } = {}) {
    if (!this.roleIds.includes(roleId) || typeof summaryId !== 'string' || !summaryId.trim()) return;
    this.observeTask(this.interpreter.interpretSession({ roleId, sessionSummaryId: summaryId }));
  }

  observeTask(task) {
    const handled = Promise.resolve(task).catch(error => {
      this.logger?.({ event: 'experience_interpretation_failed', error: error?.name || 'Error' });
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
      let summaries;
      try {
        summaries = (await this.repository.listSessionSummaries(roleId)).filter(
          summary => Object.hasOwn(summary, 'sourceDigest')
        );
      } catch (error) {
        counts.failed += 1;
        this.logger?.({ event: 'experience_interpretation_failed', roleId, error: error?.name || 'Error' });
        continue;
      }
      for (const summary of summaries) {
        try {
          const result = await this.interpreter.interpretSession({
            roleId,
            sessionSummaryId: summary.id
          });
          counts[result.status] += 1;
        } catch (error) {
          counts.failed += 1;
          this.logger?.({
            event: 'experience_interpretation_failed',
            roleId,
            summaryId: summary.id,
            error: error?.name || 'Error'
          });
        }
      }
    }
    return counts;
  }
}
