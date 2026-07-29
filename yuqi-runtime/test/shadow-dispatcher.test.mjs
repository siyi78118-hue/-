import assert from 'node:assert/strict';
import test from 'node:test';

import { ShadowDispatcher } from '../src/shadow-dispatcher.mjs';

function fixture({ busy = false, failure = null, attemptCount = 1 } = {}) {
  const events = [];
  let available = true;
  const store = {
    claimDueConsolidationJob() {
      if (!available) return null;
      available = false;
      return {
        jobId: 'job_1',
        turnId: 'turn_1',
        attemptCount,
        payload: { turn: { turnId: 'turn_1' } }
      };
    },
    completeConsolidationJob(input) {
      events.push({ type: 'complete', input });
    },
    failConsolidationJob(input) {
      events.push({ type: 'fail', input });
    },
    putDiagnostic(input) {
      events.push({ type: 'diagnostic', input });
    }
  };
  const dispatcher = new ShadowDispatcher({
    store,
    foregroundActivity: { isBusy: () => busy },
    cognitivePipeline: {
      async runShadow() {
        if (failure) throw failure;
        return { draft: { action: 'send', draftChecksum: 'draft' } };
      }
    },
    clock: () => 1_000,
    workerId: 'shadow'
  });
  return { dispatcher, events };
}

test('shadow work never competes with visible foreground work', async () => {
  const { dispatcher, events } = fixture({ busy: true });
  assert.equal(await dispatcher.runOnce(), null);
  assert.deepEqual(events, []);
});

test('shadow work completes durably without changing a visible turn', async () => {
  const { dispatcher, events } = fixture();
  const result = await dispatcher.runOnce();
  assert.equal(result.draft.action, 'send');
  assert.equal(events.filter(event => event.type === 'complete').length, 1);
  assert.equal(events.some(event => event.type === 'diagnostic'), true);
});

test('shadow failures use two delays and fail permanently on the third attempt', async () => {
  for (const [attemptCount, expectedDueAt] of [[1, 301_000], [2, 1_801_000], [3, 1_000]]) {
    const { dispatcher, events } = fixture({
      failure: new Error('shadow failed'),
      attemptCount
    });
    assert.equal(await dispatcher.runOnce(), null);
    assert.equal(events[0].type, 'fail');
    assert.equal(events[0].input.nextDueAt, expectedDueAt);
  }
});
