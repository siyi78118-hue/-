import assert from 'node:assert/strict';
import test from 'node:test';

import { TurnDispatcher } from '../src/turn-dispatcher.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('accept returns before background completion and duplicate accepts run once', async () => {
  const gate = deferred();
  let runs = 0;
  const turn = { turnId: 'turn_async_1', state: 'queued' };
  const store = {
    getTurn: () => turn,
    listRecoverableTurns: () => []
  };
  const orchestrator = {
    accept: () => turn,
    async run() { runs += 1; await gate.promise; return { turnId: turn.turnId }; }
  };
  const dispatcher = new TurnDispatcher({ store, orchestrator });

  assert.equal(dispatcher.accept({ turnId: turn.turnId }), turn);
  assert.equal(dispatcher.accept({ turnId: turn.turnId }), turn);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);

  gate.resolve();
  await dispatcher.idle();
  assert.equal(runs, 1);
});

test('recover schedules every persisted nonterminal turn', async () => {
  const turns = [
    { turnId: 'turn_recover_1', state: 'memory_running' },
    { turnId: 'turn_recover_2', state: 'brain_done' }
  ];
  const byId = new Map(turns.map(turn => [turn.turnId, turn]));
  const runs = [];
  const dispatcher = new TurnDispatcher({
    store: {
      getTurn: turnId => byId.get(turnId),
      listRecoverableTurns: () => turns
    },
    orchestrator: {
      accept: () => { throw new Error('not used'); },
      async run(turnId) { runs.push(turnId); }
    }
  });

  assert.equal(dispatcher.recover(), 2);
  await dispatcher.idle();
  assert.deepEqual(runs.sort(), ['turn_recover_1', 'turn_recover_2']);
});
