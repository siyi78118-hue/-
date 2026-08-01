const TERMINAL_STATES = new Set(['committed', 'delivered', 'completed', 'fallback', 'failed']);
const TERMINAL_RECOVERY_STATUSES = new Set([
  'committed', 'redacted', 'quarantined', 'cancelled', 'failed'
]);

function failureClassFor(error) {
  return /timeout|rate.?limit|capacity|temporar|unavailable|network|reset/i.test(
    `${error?.name || ''} ${error?.message || ''}`
  ) ? 'transient' : 'deterministic';
}

export class TurnDispatcher {
  constructor({ orchestrator, store }) {
    if (!orchestrator || !store) throw new Error('orchestrator and store are required');
    this.orchestrator = orchestrator;
    this.store = store;
    this.inflight = new Map();
  }

  accept(envelope) {
    const turn = this.orchestrator.accept(envelope);
    this.schedule(turn.turnId);
    return turn;
  }

  schedule(turnId, { recovery = false } = {}) {
    const existing = this.inflight.get(turnId);
    if (existing) return existing;
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new Error('turn not found');
    if (!recovery && TERMINAL_STATES.has(turn.state)) return Promise.resolve(turn);
    const task = Promise.resolve()
      .then(async () => {
        if (recovery) {
          const outcome = await this.orchestrator.recover(turnId);
          if (TERMINAL_RECOVERY_STATUSES.has(String(outcome?.status || ''))) return outcome;
        }
        try {
          return await this.orchestrator.run(turnId);
        } catch (error) {
          let current = this.store.getTurn(turnId);
          if (Number(current?.resultAuthorityVersion || 0) === 1) {
            const failureClass = failureClassFor(error);
            if (current.state !== 'failed' && this.store.recordCanonicalTurnFailureInternal) {
              current = this.store.recordCanonicalTurnFailureInternal({
                turnId,
                expectedState: current.state,
                expectedTurnRevision: current.turnRevision,
                failure: {
                  name: String(error?.name || 'Error'),
                  message: String(error?.message || error),
                  failureClass
                }
              });
            }
            if (failureClass !== 'transient' || current?.state !== 'failed') throw error;
            this.store.requeueCanonicalFailedTurnInternal({
              turnId,
              expectedTurnRevision: current.turnRevision,
              allowedFailureClass: 'transient'
            });
          } else {
            const legacyRecovery = this.store.requeueTransientFailedTurn?.(turnId);
            if (!legacyRecovery?.requeued) throw error;
          }
          return this.orchestrator.run(turnId);
        }
      })
      .finally(() => this.inflight.delete(turnId));
    task.catch(() => {});
    this.inflight.set(turnId, task);
    return task;
  }

  recover() {
    const turns = this.store.listRecoverableTurns();
    for (const turn of turns) this.schedule(turn.turnId, { recovery: true });
    return turns.length;
  }

  async idle() {
    await Promise.allSettled([...this.inflight.values()]);
  }
}
