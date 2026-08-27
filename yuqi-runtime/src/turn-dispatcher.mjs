const TERMINAL_STATES = new Set(['committed', 'delivered', 'completed', 'fallback', 'failed']);
const TERMINAL_RECOVERY_STATUSES = new Set([
  'committed', 'redacted', 'quarantined', 'cancelled', 'failed'
]);

function failureClassFor(error) {
  return /timeout|rate.?limit|capacity|temporar|unavailable|network|reset/i.test(
    `${error?.name || ''} ${error?.message || ''}`
  ) ? 'transient' : 'deterministic';
}

function isWireV3(turn) {
  if (Number(turn?.protocolVersion) === 3) return true;
  try {
    return Number(JSON.parse(String(turn?.envelopeJson || '{}')).protocolVersion) === 3;
  } catch {
    return false;
  }
}

export class TurnDispatcher {
  constructor({ orchestrator, store }) {
    if (!orchestrator || !store) throw new Error('orchestrator and store are required');
    this.orchestrator = orchestrator;
    this.store = store;
    this.inflight = new Map();
    this.visibleMessageObserver = null;
  }

  setVisibleMessageObserver(observer) {
    if (observer !== null && typeof observer !== 'function') throw new Error('visible message observer must be a function');
    this.visibleMessageObserver = observer;
  }

  accept(envelope) {
    const turn = this.orchestrator.accept(envelope);
    try {
      this.visibleMessageObserver?.({ roleId: turn.characterId, turnId: turn.turnId });
    } catch {}
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
            const wireV3 = isWireV3(current);
            if (current.state !== 'failed' && this.store.recordCanonicalTurnFailureInternal) {
              const failure = {
                name: String(error?.name || 'Error'),
                message: String(error?.message || error),
                failureClass
              };
              if (wireV3) {
                failure.retryAllowed = failureClass === 'transient';
                failure.code = failureClass === 'transient'
                  ? 'YUQI_TRANSIENT_EXECUTION_FAILURE'
                  : 'YUQI_DETERMINISTIC_EXECUTION_FAILURE';
              }
              current = this.store.recordCanonicalTurnFailureInternal({
                turnId,
                expectedState: current.state,
                expectedTurnRevision: current.turnRevision,
                failure
              });
            }
            if (wireV3 && current?.state === 'failed') return current;
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
