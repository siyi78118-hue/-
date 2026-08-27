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

test('visible-message observation is non-blocking and observer failure cannot fail turn acceptance', async () => {
  const turn = { turnId: 'turn_observed_1', characterId: 'role_a', state: 'completed' };
  const observed = [];
  const dispatcher = new TurnDispatcher({
    store: { getTurn: () => turn, listRecoverableTurns: () => [] },
    orchestrator: { accept: () => turn, async run() { return turn; } }
  });
  dispatcher.setVisibleMessageObserver(value => {
    observed.push(value);
    throw new Error('synthetic observer failure');
  });
  assert.equal(dispatcher.accept({ turnId: turn.turnId }), turn);
  assert.deepEqual(observed, [{ roleId: 'role_a', turnId: 'turn_observed_1' }]);
  await dispatcher.idle();
});

test('recover schedules every persisted nonterminal turn', async () => {
  const turns = [
    { turnId: 'turn_recover_1', state: 'memory_running', resultAuthorityVersion: 0 },
    { turnId: 'turn_recover_2', state: 'brain_done', resultAuthorityVersion: 1 }
  ];
  const byId = new Map(turns.map(turn => [turn.turnId, turn]));
  const runs = [];
  const recoveries = [];
  const dispatcher = new TurnDispatcher({
    store: {
      getTurn: turnId => byId.get(turnId),
      listRecoverableTurns: () => turns
    },
    orchestrator: {
      accept: () => { throw new Error('not used'); },
      async recover(turnId) {
        recoveries.push(turnId);
        return Number(byId.get(turnId).resultAuthorityVersion) === 1
          ? { status: 'open', recoveryPath: 'canonical' }
          : { status: 'open', recoveryPath: 'legacy' };
      },
      async run(turnId) { runs.push(turnId); }
    }
  });

  assert.equal(dispatcher.recover(), 2);
  await dispatcher.idle();
  assert.deepEqual(recoveries.sort(), ['turn_recover_1', 'turn_recover_2']);
  assert.deepEqual(runs.sort(), ['turn_recover_1', 'turn_recover_2']);
});

test('canonical recovery returns a committed receipt without running the model', async () => {
  const turn = {
    turnId: 'turn_canonical_receipt',
    state: 'committed',
    resultAuthorityVersion: 1
  };
  let runs = 0;
  const dispatcher = new TurnDispatcher({
    store: {
      getTurn: () => turn,
      listRecoverableTurns: () => [turn]
    },
    orchestrator: {
      accept: () => { throw new Error('not used'); },
      async recover() {
        return { status: 'committed', recoveryPath: 'canonical', receipt: { groupId: 'group_1' } };
      },
      async run() { runs += 1; }
    }
  });

  assert.equal(dispatcher.recover(), 1);
  await dispatcher.idle();
  assert.equal(runs, 0);
});

test('quarantined canonical recovery does not block the next recoverable turn', async () => {
  const turns = [
    { turnId: 'turn_bad_canonical', state: 'queued', resultAuthorityVersion: 1 },
    { turnId: 'turn_good_legacy', state: 'queued', resultAuthorityVersion: 0 }
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
      async recover(turnId) {
        return turnId === 'turn_bad_canonical'
          ? { status: 'quarantined', recoveryPath: 'canonical' }
          : { status: 'open', recoveryPath: 'legacy' };
      },
      async run(turnId) { runs.push(turnId); }
    }
  });

  assert.equal(dispatcher.recover(), 2);
  await dispatcher.idle();
  assert.deepEqual(runs, ['turn_good_legacy']);
});

test('a transient Codex timeout is automatically retried once from its checkpoint', async () => {
  let runs = 0;
  let requeues = 0;
  const turn = { turnId: 'turn_timeout_1', state: 'memory_done' };
  const store = {
    getTurn: () => turn,
    listRecoverableTurns: () => [],
    requeueTransientFailedTurn() {
      requeues += 1;
      turn.state = 'memory_done';
      return { requeued: true, turn: { ...turn } };
    }
  };
  const dispatcher = new TurnDispatcher({
    store,
    orchestrator: {
      accept: () => turn,
      async run() {
        runs += 1;
        if (runs === 1) {
          turn.state = 'failed';
          throw new Error('Codex turn timed out');
        }
        turn.state = 'committed';
        return { turnId: turn.turnId };
      }
    }
  });

  dispatcher.schedule(turn.turnId);
  await dispatcher.idle();

  assert.equal(runs, 2);
  assert.equal(requeues, 1);
  assert.equal(turn.state, 'committed');
});

test('a wire-v3 canonical transient failure is terminalized once with a native retry permission', async () => {
  let runs = 0;
  let canonicalRequeues = 0;
  let legacyRequeues = 0;
  let failureWrite = null;
  const turn = {
    turnId: 'turn_canonical_timeout',
    state: 'queued',
    resultAuthorityVersion: 1,
    turnRevision: 7,
    protocolVersion: 3,
    errorJson: null
  };
  const store = {
    getTurn: () => turn,
    listRecoverableTurns: () => [],
    requeueTransientFailedTurn() {
      legacyRequeues += 1;
      return { requeued: true };
    },
    requeueCanonicalFailedTurnInternal(input) {
      canonicalRequeues += 1;
      assert.deepEqual(input, {
        turnId: turn.turnId,
        expectedTurnRevision: 7,
        allowedFailureClass: 'transient'
      });
      turn.state = 'queued';
      turn.turnRevision += 1;
      return { ...turn };
    },
    recordCanonicalTurnFailureInternal(input) {
      failureWrite = input;
      turn.state = 'failed';
      turn.turnRevision += 1;
      turn.errorJson = JSON.stringify({
        failureClass: input.failure.failureClass,
        retryAllowed: input.failure.retryAllowed
      });
      return { ...turn };
    }
  };
  const dispatcher = new TurnDispatcher({
    store,
    orchestrator: {
      accept: () => turn,
      async run() {
        runs += 1;
        if (runs === 1) {
          throw new Error('provider temporarily unavailable');
        }
        turn.state = 'committed';
        return { turnId: turn.turnId };
      }
    }
  });

  dispatcher.schedule(turn.turnId);
  await dispatcher.idle();
  assert.equal(runs, 1);
  assert.equal(failureWrite.failure.retryAllowed, true);
  assert.equal(failureWrite.failure.failureClass, 'transient');
  assert.equal(canonicalRequeues, 0);
  assert.equal(legacyRequeues, 0);
  assert.equal(turn.state, 'failed');
});
