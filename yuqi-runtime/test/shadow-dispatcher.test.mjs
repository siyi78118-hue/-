import assert from 'node:assert/strict';
import test from 'node:test';

import { ShadowDispatcher } from '../src/shadow-dispatcher.mjs';
import { contentHash } from '../src/protocol.mjs';

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

for (const scenario of [
  {
    name: 'shadow runs cognition behind a legacy authoritative result',
    jobType: 'shadow_cognition',
    comparisonMode: 'cognition_compare',
    comparisonPipeline: 'cognition',
    direction: 'legacy_authoritative_cognition_compare'
  },
  {
    name: 'active canary runs legacy behind a cognition authoritative result',
    jobType: 'active_canary_compare',
    comparisonMode: 'legacy_compare',
    comparisonPipeline: 'legacy',
    direction: 'cognition_authoritative_legacy_compare'
  }
]) {
  test(scenario.name, async () => {
    const envelope = {
      protocolVersion: 2,
      turnId: 'turn_compare',
      characterId: 'yuqi',
      deviceId: 'phone',
      deviceSeq: 1,
      createdAt: 1,
      kind: 'DIRECT_REPLY',
      message: {
        messageId: 'msg_compare',
        speakerId: 'user',
        speakerType: 'user',
        recipientId: 'yuqi',
        content: '测试',
        sentAt: 1
      }
    };
    const turn = {
      turnId: envelope.turnId,
      envelopeJson: JSON.stringify(envelope),
      replyJson: JSON.stringify({ reply: { content: '权威结果' } }),
      route: 'deep',
      routeReasons: [],
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    };
    const payload = {
      subjectType: 'turn',
      subjectId: turn.turnId,
      turnId: turn.turnId,
      rolloutKey: 'DIRECT_REPLY',
      comparisonDirection: scenario.direction,
      comparisonPipeline: scenario.comparisonPipeline,
      comparisonMode: scenario.comparisonMode,
      authoritativeResultChecksum: contentHash(JSON.parse(turn.replyJson)),
      inputChecksum: contentHash({
        envelope,
        route: turn.route,
        routeReasons: turn.routeReasons,
        presetVersion: turn.presetVersion,
        annotationSnapshot: turn.annotationSnapshot
      })
    };
    let recorded = null;
    const dispatcher = new ShadowDispatcher({
      store: {
        claimDueConsolidationJob() {
          if (recorded) return null;
          return {
            jobId: 'job_compare',
            jobType: scenario.jobType,
            turnId: turn.turnId,
            attemptCount: 1,
            payload
          };
        },
        getTurn: () => turn,
        getCurrentUserBatch: () => ({ messageIds: ['msg_compare'] }),
        putDiagnostic() {}
      },
      cognitivePipeline: {},
      comparisonExecutor: async ({ payload: fixed }) => ({
        reply: { content: `dry ${fixed.comparisonPipeline}` },
        usedMessageIds: ['msg_compare'],
        schemaValid: true
      }),
      promotionController: {
        recordComparisonOutcome(input) { recorded = input; }
      },
      clock: () => 1_000
    });
    await dispatcher.runOnce();
    assert.equal(recorded.criticalFindings.length, 0);
    assert.equal(recorded.run.metrics.schemaValid, true);
  });
}
