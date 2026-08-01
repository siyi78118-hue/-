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

test('version-one turn comparison loads canonical authority and uses the shared release executor dry-run', async () => {
  const calls = [];
  let available = true;
  let recorded = null;
  const authority = {
    status: 'ready',
    authorityVersion: 1,
    subjectType: 'turn',
    subjectId: 'lineage_1',
    comparisonReleaseId: 'candidate-r3',
    comparisonReleaseChecksum: 'c'.repeat(64),
    comparisonDirection: 'stable_authoritative_candidate_compare',
    authoritativeResult: { terminalDisposition: 'visible', replyParts: ['权威结果'], actions: [] },
    execution: {
      turn: { turnId: 'turn_1', rolloutKey: 'DIRECT_REPLY' },
      envelope: { kind: 'DIRECT_REPLY', characterId: 'yuqi' },
      currentBatch: { messageIds: ['msg_1'] },
      scene: {},
      allowedActionTargets: ['yuqi', 'user']
    }
  };
  const dispatcher = new ShadowDispatcher({
    store: {
      claimDueConsolidationJob() {
        if (!available) return null;
        available = false;
        return { jobId: 'job_1', jobType: 'shadow_cognition', attemptCount: 1 };
      },
      loadComparisonExecutionAuthorityInternal(input) {
        calls.push(['load', input]);
        return authority;
      },
      getTurn() {
        throw new Error('turn.replyJson is not canonical comparison authority');
      },
      putDiagnostic() {}
    },
    releaseExecutor: {
      async executeTurn(input) {
        calls.push(['executeTurn', input]);
        return { draft: { action: 'send', reply: '对照草稿', usedMessageIds: ['msg_1'] } };
      },
      async executeLife() {
        throw new Error('wrong release execution kind');
      }
    },
    cognitivePipeline: {
      async runShadow() { throw new Error('version-one comparison used legacy shadow'); },
      async runLegacyShadow() { throw new Error('version-one comparison used legacy shadow'); }
    },
    promotionController: {
      recordComparisonOutcome(input) {
        recorded = input;
        return { status: 'completed' };
      }
    },
    clock: () => 1_000
  });

  const result = await dispatcher.runOnce();

  assert.equal(result.draft.reply, '对照草稿');
  assert.deepEqual(calls[0], ['load', { jobId: 'job_1', workerId: 'yuqi-shadow' }]);
  assert.equal(calls[1][0], 'executeTurn');
  assert.equal(calls[1][1].releaseId, 'candidate-r3');
  assert.equal(calls[1][1].releaseChecksum, 'c'.repeat(64));
  assert.equal(calls[1][1].dryRun, true);
  assert.equal(recorded.jobId, 'job_1');
});

test('version-one life comparison uses planning authority and executeLife without a chat turn', async () => {
  let executed = null;
  let recorded = null;
  const dispatcher = new ShadowDispatcher({
    store: {
      claimDueConsolidationJob: (() => {
        let available = true;
        return () => {
          if (!available) return null;
          available = false;
          return { jobId: 'job_life', jobType: 'active_canary_compare', attemptCount: 1 };
        };
      })(),
      loadComparisonExecutionAuthorityInternal() {
        return {
          status: 'ready',
          authorityVersion: 1,
          subjectType: 'life_planning',
          subjectId: 'planning_1',
          comparisonReleaseId: 'stable-r2',
          comparisonReleaseChecksum: 'b'.repeat(64),
          comparisonDirection: 'candidate_authoritative_stable_compare',
          authoritativeResult: { episodes: [{ episodeId: 'episode_1' }] },
          execution: { attempt: { planningId: 'planning_1' }, inputSnapshot: { horizon: 'today' } }
        };
      },
      getTurn() {
        throw new Error('life comparison must not load a chat turn');
      },
      putDiagnostic() {}
    },
    releaseExecutor: {
      async executeTurn() { throw new Error('wrong release execution kind'); },
      async executeLife(input) {
        executed = input;
        return { draft: { episodes: [{ episodeId: 'candidate_episode' }] } };
      }
    },
    promotionController: {
      recordComparisonOutcome(input) {
        recorded = input;
        return { status: 'completed' };
      }
    },
    comparisonEvaluator: () => ({
      metrics: { schemaValid: true },
      warnings: [],
      criticalFindings: []
    }),
    clock: () => 2_000
  });

  await dispatcher.runOnce();

  assert.equal(executed.releaseId, 'stable-r2');
  assert.equal(executed.dryRun, true);
  assert.equal(recorded.jobId, 'job_life');
});

test('redacted version-one comparison cancels without loading content or invoking a model', async () => {
  let recorded = null;
  const dispatcher = new ShadowDispatcher({
    store: {
      claimDueConsolidationJob: (() => {
        let available = true;
        return () => {
          if (!available) return null;
          available = false;
          return { jobId: 'job_redacted', jobType: 'active_canary_compare', attemptCount: 1 };
        };
      })(),
      loadComparisonExecutionAuthorityInternal() {
        return {
          status: 'cancelled_redacted',
          authorityVersion: 1,
          subjectType: 'turn',
          subjectId: 'lineage_redacted'
        };
      },
      putDiagnostic() {}
    },
    releaseExecutor: {
      async executeTurn() { throw new Error('redacted comparison invoked a model'); },
      async executeLife() { throw new Error('redacted comparison invoked a model'); }
    },
    promotionController: {
      recordComparisonOutcome(input) {
        recorded = input;
        return { status: 'cancelled_redacted' };
      }
    },
    comparisonEvaluator() {
      throw new Error('redacted comparison invoked evaluator');
    },
    clock: () => 3_000
  });

  const result = await dispatcher.runOnce();

  assert.equal(result.status, 'cancelled_redacted');
  assert.equal(recorded.terminalCancellation, 'cancelled_redacted');
});

test('persisted version-zero comparison uses only the explicit legacy executor', async () => {
  let available = true;
  let legacyExecution = null;
  let recorded = null;
  const authority = {
    status: 'ready',
    authorityVersion: 0,
    subjectType: 'turn',
    subjectId: 'turn_v0',
    authoritativeResult: { reply: { content: '旧权威结果' } },
    execution: {
      envelope: { kind: 'DIRECT_REPLY', characterId: 'yuqi' },
      currentBatch: { messageIds: ['msg_v0'] },
      scene: {},
      allowedActionTargets: ['yuqi', 'user']
    }
  };
  const dispatcher = new ShadowDispatcher({
    store: {
      claimDueConsolidationJob() {
        if (!available) return null;
        available = false;
        return { jobId: 'job_v0', jobType: 'shadow_cognition', attemptCount: 1 };
      },
      loadComparisonExecutionAuthorityInternal() {
        return authority;
      },
      failConsolidationJob() {
        throw new Error('version-zero comparison was rejected');
      },
      putDiagnostic() {}
    },
    releaseExecutor: {
      async executeTurn() { throw new Error('version-zero comparison used release executor'); },
      async executeLife() { throw new Error('version-zero comparison used release executor'); }
    },
    legacyVersionZeroComparisonExecutor: async execution => {
      legacyExecution = execution;
      return { draft: { action: 'send', reply: '旧版对照草稿', usedMessageIds: ['msg_v0'] } };
    },
    promotionController: {
      recordComparisonOutcome(input) {
        recorded = input;
        return { status: 'completed' };
      }
    },
    comparisonEvaluator: () => ({
      metrics: { schemaValid: true },
      warnings: [],
      criticalFindings: []
    }),
    clock: () => 4_000
  });

  const result = await dispatcher.runOnce();

  assert.equal(result.draft.reply, '旧版对照草稿');
  assert.equal(legacyExecution, authority.execution);
  assert.equal(recorded.jobId, 'job_v0');
  assert.equal(recorded.run.metrics.schemaValid, true);
});

test('redaction after comparison load discards the draft before evaluation and records cancellation', async () => {
  let available = true;
  let loadCount = 0;
  let recorded = null;
  const dispatcher = new ShadowDispatcher({
    store: {
      claimDueConsolidationJob() {
        if (!available) return null;
        available = false;
        return { jobId: 'job_race', jobType: 'active_canary_compare', attemptCount: 1 };
      },
      loadComparisonExecutionAuthorityInternal() {
        loadCount += 1;
        if (loadCount === 1) {
          return {
            status: 'ready',
            authorityVersion: 1,
            subjectType: 'turn',
            subjectId: 'lineage_race',
            comparisonReleaseId: 'stable-r2',
            comparisonReleaseChecksum: 'b'.repeat(64),
            authoritativeResult: { terminalDisposition: 'visible', replyParts: ['权威结果'] },
            execution: {
              envelope: { kind: 'DIRECT_REPLY', characterId: 'yuqi' },
              currentBatch: { messageIds: ['msg_race'] }
            }
          };
        }
        return {
          status: 'cancelled_redacted',
          authorityVersion: 1,
          subjectType: 'turn',
          subjectId: 'lineage_race'
        };
      },
      putDiagnostic() {}
    },
    releaseExecutor: {
      async executeTurn() {
        return { draft: { action: 'send', reply: '必须丢弃的草稿' } };
      },
      async executeLife() { throw new Error('wrong release execution kind'); }
    },
    promotionController: {
      recordComparisonOutcome(input) {
        recorded = input;
        return { status: 'cancelled_redacted' };
      }
    },
    comparisonEvaluator() {
      throw new Error('redacted draft reached evaluator');
    },
    clock: () => 5_000
  });

  const result = await dispatcher.runOnce();

  assert.equal(loadCount, 2);
  assert.equal(result.status, 'cancelled_redacted');
  assert.equal(recorded.terminalCancellation, 'cancelled_redacted');
  assert.equal(recorded.run, undefined);
});

test('permanent release comparison failures remain delegated to the consolidation store', async () => {
  let failure = null;
  const dispatcher = new ShadowDispatcher({
    store: {
      claimDueConsolidationJob: (() => {
        let available = true;
        return () => {
          if (!available) return null;
          available = false;
          return { jobId: 'job_failed', jobType: 'shadow_cognition', attemptCount: 3 };
        };
      })(),
      loadComparisonExecutionAuthorityInternal() {
        return {
          status: 'ready',
          authorityVersion: 1,
          subjectType: 'turn',
          subjectId: 'lineage_failed',
          comparisonReleaseId: 'candidate-r3',
          comparisonReleaseChecksum: 'c'.repeat(64),
          authoritativeResult: {},
          execution: { envelope: {}, currentBatch: null }
        };
      },
      failConsolidationJob(input) {
        failure = input;
      }
    },
    releaseExecutor: {
      async executeTurn() {
        const error = new Error('candidate unavailable');
        error.code = 'PINNED_PIPELINE_UNAVAILABLE';
        throw error;
      },
      async executeLife() { throw new Error('wrong release execution kind'); }
    },
    clock: () => 6_000
  });

  assert.equal(await dispatcher.runOnce(), null);
  assert.equal(failure.jobId, 'job_failed');
  assert.equal(failure.errorCode, 'PINNED_PIPELINE_UNAVAILABLE');
  assert.equal(failure.nextDueAt, 6_000);
});
