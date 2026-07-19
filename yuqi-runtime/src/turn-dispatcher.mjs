const TERMINAL_STATES = new Set(['committed', 'delivered', 'completed', 'fallback', 'failed']);

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

  schedule(turnId) {
    const existing = this.inflight.get(turnId);
    if (existing) return existing;
    const turn = this.store.getTurn(turnId);
    if (!turn) throw new Error('turn not found');
    if (TERMINAL_STATES.has(turn.state)) return Promise.resolve(turn);
    const task = Promise.resolve()
      .then(() => this.orchestrator.run(turnId))
      .finally(() => this.inflight.delete(turnId));
    task.catch(() => {});
    this.inflight.set(turnId, task);
    return task;
  }

  recover() {
    const turns = this.store.listRecoverableTurns();
    for (const turn of turns) this.schedule(turn.turnId);
    return turns.length;
  }

  async idle() {
    await Promise.allSettled([...this.inflight.values()]);
  }
}
