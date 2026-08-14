import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProactiveAuthorityHarness,
  fixtureTransition
} from '../scripts/verify-proactive-single-authority.mjs';

function assertConverged(harness) {
  const state = harness.snapshot();
  assert.equal(state.authorityCount, 1);
  assert.ok(state.alarmProjectionCount <= 1);
  assert.ok(state.workProjectionCount <= 1);
  assert.equal(state.duplicateOutboxGenerations.length, 0);
  assert.equal(state.staleSemanticOutputs, 0);
}

test('one terminal plus event and poll advances exactly once', async () => {
  const h = await createProactiveAuthorityHarness();
  await h.bootstrap();
  const first = await h.terminal('turn-1', 'visible', 1);
  const replay = await h.terminal('turn-1', 'visible', 1);
  assert.equal(replay.generation, first.generation);
  assert.equal(h.snapshot().terminalAdvancements, 1);
  assertConverged(h);
});

test('visible action-only skip and failed each produce one next authority', async () => {
  const h = await createProactiveAuthorityHarness();
  await h.bootstrap();
  for (const [index, disposition] of ['visible', 'action_only', 'skip', 'failed'].entries()) {
    await h.terminal(`turn-${index + 1}`, disposition, index + 1);
  }
  assert.equal(h.snapshot().terminalAdvancements, 4);
  assertConverged(h);
});

test('stale Web generation A cannot overwrite Android generation B', async () => {
  const h = await createProactiveAuthorityHarness();
  const a = await h.bootstrap();
  await h.flushOutbox();
  await h.terminal('turn-b', 'visible', 1);
  await h.flushOutbox();
  const stale = await h.postTransition({ ...a, owner: 'web-v1' });
  assert.equal(stale.status, 409);
  assert.equal(h.snapshot().generation, 2);
  assertConverged(h);
});

test('stale D1 defer and ACK from A cannot mutate B', async () => {
  const h = await createProactiveAuthorityHarness();
  const a = await h.bootstrap();
  await h.flushOutbox();
  await h.terminal('turn-b', 'visible', 1);
  await h.flushOutbox();
  assert.equal((await h.deliveryDefer(a)).status, 409);
  assert.equal((await h.deliveryAck(a)).status, 409);
  assert.equal(h.snapshot().generation, 2);
  assertConverged(h);
});

test('simultaneous Alarm and FCM callbacks claim one token and emit once', async () => {
  const h = await createProactiveAuthorityHarness();
  const current = await h.bootstrap();
  const outcomes = await Promise.all([
    h.deliveryCallback(current, 'alarm'),
    h.deliveryCallback(current, 'fcm')
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(h.snapshot().semanticOutputs, 1);
  assertConverged(h);
});

test('cloud accepted response loss converges after process restart', async () => {
  const h = await createProactiveAuthorityHarness();
  await h.bootstrap();
  await h.flushOutbox({ loseResponse: true });
  h.restartProcess();
  const replay = await h.flushOutbox();
  assert.equal(replay.idempotent, true);
  assert.equal(h.snapshot().d1WriteGenerations.length, 1);
  assertConverged(h);
});

test('late earlier reply cannot move authority behind the second user message', async () => {
  const h = await createProactiveAuthorityHarness();
  await h.bootstrap();
  h.observeUserMessage(1);
  h.observeUserMessage(2);
  const rejected = await h.terminal('reply-to-1', 'visible', 1);
  assert.equal(rejected.status, 'stale');
  assert.equal(h.snapshot().generation, 1);
  assertConverged(h);
});

test('clear role-delete and disable close the stream against stale callbacks', async () => {
  for (const operation of ['clear', 'role_delete', 'disable']) {
    const h = await createProactiveAuthorityHarness();
    const scheduled = await h.bootstrap();
    await h.close(operation);
    assert.equal(await h.deliveryCallback(scheduled, 'alarm'), false);
    assert.equal(h.snapshot().semanticOutputs, 0);
    assert.equal(h.snapshot().state, 'disabled');
    assertConverged(h);
  }
});

test('ownerless old app-state and Service Worker writes retire after migration', async () => {
  const h = await createProactiveAuthorityHarness();
  const migrated = await h.migrateThreeLegacyCandidates();
  assert.equal(migrated.generation, 1);
  assert.notEqual(migrated.jobId, 'legacy-web');
  assert.notEqual(migrated.jobId, 'legacy-room');
  assert.notEqual(migrated.jobId, 'legacy-d1');
  assert.equal(h.snapshot().legacyProjectionCount, 0);
  assert.equal((await h.postLegacySchedule()).status, 409);
  assert.equal(await h.deliveryCallback({ ...migrated, authorityEpoch: '' }, 'old-sw'), false);
  assertConverged(h);
});

test('repeated status refresh never changes job due generation or storage', async () => {
  const h = await createProactiveAuthorityHarness();
  await h.bootstrap();
  const before = h.snapshot();
  for (let index = 0; index < 60; index += 1) await h.refreshStatus();
  const after = h.snapshot();
  assert.deepEqual(
    [after.jobId, after.dueAt, after.generation],
    [before.jobId, before.dueAt, before.generation]
  );
  assert.equal(after.statusWriteCount, before.statusWriteCount);
  assertConverged(h);
});

test('harness consumes the canonical Android fixture without rewriting it', async () => {
  const transition = await fixtureTransition();
  assert.equal(transition.owner, 'android-v1');
  assert.equal(transition.transitionChecksum, '53fd68a5b14aec79a154b157a6fe9f797be18b892a9ab97fff2f359fa2132ed2');
});
