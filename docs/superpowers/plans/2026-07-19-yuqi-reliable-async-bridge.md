# Yuqi Reliable Async Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct chat, proactive messages, role-plan messages, recovery, and fallback use one idempotent asynchronous Yuqi bridge that is fully verified before APK delivery.

**Architecture:** Protocol v2 separates real user messages from automatic triggers. The PC accepts and persists a turn immediately, processes the three Codex roles in a resumable background dispatcher, and exposes signed status polling; Cloud delivery uses a durable result outbox. Android keeps the same Room turn across network and process changes, polls the same remote turn, and only invokes the legacy fallback after an explicit final failure or the fixed 20-minute deadline.

**Tech Stack:** Node.js 24 (`node:test`, `node:sqlite`, HTTP), Codex App Server JSON-RPC, Android Java, Room, WorkManager, `HttpURLConnection`, Cloudflare encrypted relay, Gradle/JUnit/AndroidX instrumentation.

## Global Constraints

- New bridge requests use protocol version 2; v1 exists only for recovery of already-failed tasks.
- Codex roles remain `gpt-5.6-sol` with reasoning effort `high`.
- Direct turns contain one real user message; automatic turns contain a trigger and no user message.
- Default remote-turn deadline is exactly `1_200_000` ms (20 minutes) from the original turn creation time.
- LAN/Cloud changes retain the same `turnId`; retries never extend the original deadline.
- A transient timeout, DNS failure, socket interruption, process death, or route change must not invoke fallback.
- Fallback is permitted only for a remote `failed_final` result that allows fallback or an exhausted 20-minute deadline.
- `origin=codex` and `origin=fallback` remain internally auditable while technical labels stay out of immersive chat copy.
- No secret, complete preset, or hidden reasoning text may be written to diagnostics.
- No APK is delivered until all automated tests, real emulator scenarios, Room/SQLite evidence checks, and backup checks pass.

---

### Task 1: Protocol v2 Direct Messages and Automatic Triggers

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Consumes: raw v2 envelope from LAN or decrypted Cloud relay.
- Produces: `validateEnvelope(value) -> { protocolVersion, turnId, characterId, deviceId, deviceSeq, createdAt, kind, message?, trigger? }`.
- Produces: `YuqiStore.submitTurn(envelope)` that writes a message only for direct turns and stays idempotent for triggers.

- [ ] **Step 1: Write failing protocol tests**

```js
test('v2 direct turn requires the exact user speaker', () => {
  const saved = validateEnvelope({
    protocolVersion: 2, turnId: 'turn_direct_1', characterId: 'yuqi',
    deviceId: 'phone_a', deviceSeq: 1, createdAt: 1784400000000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_direct_1', speakerId: 'user', speakerType: 'user',
      recipientId: 'yuqi', content: '你好', sentAt: 1784400000000
    }
  });
  assert.equal(saved.message.content, '你好');
  assert.equal(saved.trigger, undefined);
});

test('v2 automatic turn accepts a trigger without creating a user message', () => {
  const store = fixtureStore();
  const turn = store.submitTurn({
    protocolVersion: 2, turnId: 'turn_proactive_1', characterId: 'yuqi',
    deviceId: 'phone_a', deviceSeq: 2, createdAt: 1784400001000,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: 'trigger_proactive_1', triggerType: 'proactive_chat',
      scheduledFor: 1784400000000, executedAt: 1784400001000
    }
  });
  assert.equal(turn.sourceMessageId, 'trigger_proactive_1');
  assert.equal(store.listMessages('yuqi').length, 0);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`
Expected: FAIL because protocol version 2 and trigger-only envelopes are rejected.

- [ ] **Step 3: Implement the minimal v2 validator and conditional message write**

```js
const DIRECT_KINDS = new Set(['DIRECT_REPLY']);
const AUTOMATIC_KINDS = new Set([
  'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE'
]);

export function validateEnvelope(value) {
  if (!value || value.protocolVersion !== 2) throw new Error('invalid protocolVersion');
  const envelope = {
    protocolVersion: 2,
    turnId: requireId(value.turnId, 'turnId', 'turn_'),
    characterId: requireId(value.characterId, 'characterId'),
    deviceId: requireId(value.deviceId, 'deviceId'),
    deviceSeq: Number(value.deviceSeq),
    createdAt: requireTimestamp(value.createdAt, 'createdAt'),
    kind: String(value.kind || '')
  };
  if (DIRECT_KINDS.has(envelope.kind)) envelope.message = validateUserMessage(value.message, envelope);
  else if (AUTOMATIC_KINDS.has(envelope.kind)) envelope.trigger = validateTrigger(value.trigger);
  else throw new Error('invalid turn kind');
  return envelope;
}
```

In `submitTurn`, derive `sourceMessageId` from `message.messageId` or `trigger.triggerId`, and call `putMessageInternal` only when `envelope.message` exists.

- [ ] **Step 4: Run protocol/store tests and verify GREEN**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`
Expected: PASS, including checksum conflict and duplicate sequence tests.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/protocol.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/protocol-store.test.mjs
git commit -m "feat: add Yuqi bridge protocol v2"
```

### Task 2: Codex Role Output Schemas and Fixed Model Settings

**Files:**
- Create: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Modify: `yuqi-runtime/test/fixtures/fake-app-server.mjs`
- Test: `yuqi-runtime/test/codex-client.test.mjs`

**Interfaces:**
- Produces: `ROLE_OUTPUT_SCHEMAS.memory`, `.brain`, `.supervisor`.
- Extends: `CodexAppServerClient.runTurn(role, input, { clientUserMessageId, outputSchema, model, effort })`.

- [ ] **Step 1: Write a failing App Server request test**

```js
test('turn start pins model, effort and role output schema', async () => fixture(async ({ client, logFile }) => {
  await client.runTurn('brain', 'draft', {
    outputSchema: ROLE_OUTPUT_SCHEMAS.brain,
    model: 'gpt-5.6-sol', effort: 'high'
  });
  const request = protocolLines(logFile).find(item => item.method === 'turn/start');
  assert.equal(request.params.model, 'gpt-5.6-sol');
  assert.equal(request.params.effort, 'high');
  assert.deepEqual(request.params.outputSchema, ROLE_OUTPUT_SCHEMAS.brain);
}));
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test yuqi-runtime/test/codex-client.test.mjs`
Expected: FAIL because `turn/start` does not include model, effort, or outputSchema.

- [ ] **Step 3: Add strict role schemas and request fields**

```js
export const ROLE_OUTPUT_SCHEMAS = Object.freeze({
  memory: objectSchema({
    query: { type: 'string' }, keywords: stringArray(), candidates: { type: 'array', items: { type: 'object' } }
  }, ['query', 'keywords', 'candidates']),
  brain: objectSchema({ reply: { type: 'string', minLength: 1 }, usedFactIds: stringArray() }, ['reply', 'usedFactIds']),
  supervisor: objectSchema({
    approved: { type: 'boolean' },
    issues: { type: 'array', items: objectSchema({ code: { type: 'string' }, message: { type: 'string' } }, ['code', 'message']) }
  }, ['approved', 'issues'])
});
```

Add these exact fields to `turn/start`:

```js
model: options.model || 'gpt-5.6-sol',
effort: options.effort || 'high',
outputSchema: options.outputSchema || undefined
```

- [ ] **Step 4: Run Codex client tests and verify GREEN**

Run: `node --test yuqi-runtime/test/codex-client.test.mjs`
Expected: PASS with three isolated persistent role threads.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/codex-client.mjs yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/test/fixtures/fake-app-server.mjs
git commit -m "feat: constrain Yuqi role outputs"
```

### Task 3: Resumable Three-Role Orchestration

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Produces: `orchestrator.accept(envelope) -> persisted turn`.
- Produces: `orchestrator.run(turnId) -> committed result` that resumes from stored checkpoints.
- Uses: `ROLE_OUTPUT_SCHEMAS` and stable role IDs `${turnId}_${role}_${attempt}`.

- [ ] **Step 1: Write failing resume, schema-repair, and trigger tests**

```js
test('resumes at brain when memory checkpoint already exists', async () => {
  const fixture = resumeFixture('memory_done');
  await fixture.orchestrator.run('turn_phone_1');
  assert.deepEqual(fixture.codex.calls.map(call => call.role), ['brain', 'supervisor']);
});

test('retries one invalid structured role result with the same role schema', async () => {
  const outputs = normalOutputs();
  outputs.brain = ['plain text', '{"reply":"你好呀","usedFactIds":[]}'];
  await withFixture(outputs, async ({ codex, orchestrator }) => {
    await orchestrator.run((await orchestrator.accept(envelope())).turnId);
    assert.equal(codex.calls.filter(call => call.role === 'brain').length, 2);
    assert.ok(codex.calls.filter(call => call.role === 'brain').every(call => call.options.outputSchema));
  });
});

test('automatic trigger is context, never user evidence', async () => {
  await withFixture(normalOutputs(), async ({ codex, orchestrator, store }) => {
    const turn = await orchestrator.accept(triggerEnvelope());
    await orchestrator.run(turn.turnId);
    const memory = codex.calls.find(call => call.role === 'memory').input;
    const brain = codex.calls.find(call => call.role === 'brain').input;
    assert.equal(memory.currentMessageId, undefined);
    assert.equal(memory.currentTrigger.triggerId, 'trigger_1');
    assert.equal(brain.currentUserMessage, undefined);
    assert.equal(store.listMessages('yuqi').filter(row => row.speakerType === 'user').length, 0);
  });
});
```

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`
Expected: FAIL because orchestration only starts queued direct-message turns and does not pass schemas.

- [ ] **Step 3: Split accept from run and resume by persisted state**

Implement `accept()` as an idempotent store submission. Implement `run()` as a state loop:

```js
async run(turnId) {
  let turn = this.store.getTurn(turnId);
  if (!turn) throw new Error('turn not found');
  if (turn.state === 'committed') return JSON.parse(turn.replyJson);
  if (turn.state === 'queued') turn = this.store.claimTurnById(turnId, this.workerId);
  if (turn.state === 'memory_running') await this.completeMemory(turn);
  turn = this.store.getTurn(turnId);
  if (turn.state === 'memory_done' || turn.state === 'brain_running') await this.completeBrain(turn);
  turn = this.store.getTurn(turnId);
  if (turn.state === 'brain_done' || turn.state === 'supervisor_running') await this.completeSupervisor(turn);
  return JSON.parse(this.store.getTurn(turnId).replyJson);
}
```

Every role call uses `runStructuredRole()` with its schema and exactly one protocol-repair retry. Automatic memory requests receive `currentTrigger` and may retrieve facts but must pass `candidates: []` into evidence commitment.

- [ ] **Step 4: Run orchestrator, evidence-memory, and store tests**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/protocol-store.test.mjs`
Expected: PASS; no automatic trigger appears as a user message or fact source.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: resume Yuqi role pipeline"
```

### Task 4: Asynchronous LAN Acceptance and Signed Polling

**Files:**
- Create: `yuqi-runtime/src/turn-dispatcher.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Test: `yuqi-runtime/test/turn-dispatcher.test.mjs`
- Test: `yuqi-runtime/test/local-server.test.mjs`

**Interfaces:**
- Produces: `TurnDispatcher.accept(envelope)`, `schedule(turnId)`, `recover()`.
- Produces: `POST /v2/turns -> 202` and `GET /v2/turns/{turnId} -> public status/result`.

- [ ] **Step 1: Write failing async HTTP tests**

```js
test('POST returns 202 before a slow role finishes and GET later returns one result', async () => {
  const gate = deferred();
  const dispatcher = fakeDispatcher({ run: () => gate.promise });
  const submitted = await signedCall('POST', '/v2/turns', directEnvelope());
  assert.equal(submitted.status, 202);
  assert.equal(submitted.body.state, 'queued');
  const pending = await signedCall('GET', `/v2/turns/${submitted.body.turnId}`);
  assert.equal(pending.body.terminal, false);
  gate.resolve(committedResult());
  await dispatcher.idle();
  const complete = await signedCall('GET', `/v2/turns/${submitted.body.turnId}`);
  assert.equal(complete.body.reply.content, '收到');
});

test('duplicate checksum schedules only one background run', async () => {
  await signedCall('POST', '/v2/turns', directEnvelope(), 'nonce-a');
  await signedCall('POST', '/v2/turns', directEnvelope(), 'nonce-b');
  assert.equal(dispatcher.runCount('turn_direct_1'), 1);
});
```

- [ ] **Step 2: Run server tests and verify RED**

Run: `node --test yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs`
Expected: FAIL because the current POST waits for all roles and has no dispatcher.

- [ ] **Step 3: Implement dispatcher and public status projection**

```js
export class TurnDispatcher {
  constructor({ orchestrator, store }) { this.orchestrator = orchestrator; this.store = store; this.inflight = new Map(); }
  accept(envelope) {
    const turn = this.orchestrator.accept(envelope);
    this.schedule(turn.turnId);
    return turn;
  }
  schedule(turnId) {
    if (this.inflight.has(turnId)) return this.inflight.get(turnId);
    const task = this.orchestrator.run(turnId).finally(() => this.inflight.delete(turnId));
    task.catch(() => {});
    this.inflight.set(turnId, task);
    return task;
  }
  recover() { for (const turn of this.store.listRecoverableTurns()) this.schedule(turn.turnId); }
}
```

The GET response exposes only `turnId`, normalized state, `terminal`, `allowFallback`, `reply`, `errorCode`, `origin`, and `updatedAt`.

- [ ] **Step 4: Run local server and dispatcher tests**

Run: `node --test yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs`
Expected: PASS, including signed GET, nonce replay rejection, checksum conflict, and restart recovery.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/turn-dispatcher.mjs yuqi-runtime/src/local-server.mjs yuqi-runtime/src/main.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/local-server.test.mjs
git commit -m "feat: process Yuqi turns asynchronously"
```

### Task 5: Durable Cloud Result Outbox

**Files:**
- Create: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Test: `yuqi-runtime/test/result-outbox.test.mjs`
- Test: `yuqi-runtime/test/cloud-relay-pump.test.mjs`

**Interfaces:**
- Produces: `registerCloudDelivery(turnId, peerId)` and `enqueueTerminalResult(turnId)`.
- Produces: durable `result_outbox(turn_id, peer_id, checksum, payload_json, state, attempts, updated_at)` rows.

- [ ] **Step 1: Write failing cross-route delivery tests**

```js
test('cloud registration during a LAN turn publishes the eventual same result once', async () => {
  const turn = store.submitTurn(directEnvelope());
  store.registerCloudDelivery(turn.turnId, 'phone_a');
  store.commitTestReply(turn.turnId, committedResult());
  outbox.captureTerminal(turn.turnId);
  await outbox.flushOnce();
  await outbox.flushOnce();
  assert.equal(relay.enqueued.length, 1);
  assert.equal(relay.enqueued[0].turnId, turn.turnId);
});

test('restart flushes an unacknowledged outbox row', async () => {
  seedPendingOutbox(store);
  const restarted = new ResultOutbox({ store, relay });
  await restarted.flushOnce();
  assert.equal(store.pendingOutbox().length, 0);
});
```

- [ ] **Step 2: Run outbox/relay tests and verify RED**

Run: `node --test yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs`
Expected: FAIL because Cloud replies currently exist only inside the inbound pump call.

- [ ] **Step 3: Implement the SQLite outbox and decouple Cloud ingress from result delivery**

Cloud ingress decrypts and validates the v2 envelope, registers `peerId`, calls `dispatcher.accept()`, acknowledges the inbound mailbox item, and returns without waiting. The outbox watches terminal turns and encrypts a public result using the existing AES-GCM format. A relay enqueue is idempotent on `reply_${sha256(turnId + checksum)}`.

- [ ] **Step 4: Run outbox, relay, reconciliation, and store tests**

Run: `node --test yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/protocol-store.test.mjs`
Expected: PASS; repeated registration and pump restarts produce one reply item.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/result-outbox.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/src/main.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs
git commit -m "feat: persist Yuqi cloud results"
```

### Task 6: Android v2 Envelope Builder and Remote Polling

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeConfig.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/secure/AlSecretStore.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`

**Interfaces:**
- Produces: `BridgeInput.envelope(TurnSubmission, BridgeConfig) -> JSONObject`.
- Produces: LAN submit/poll and Cloud register/poll using the same turn ID and original deadline.

- [ ] **Step 1: Write failing direct, trigger, and polling tests**

```java
@Test public void proactiveEnvelopeContainsTriggerAndNoMessage() throws Exception {
    TurnSubmission turn = proactiveSubmission("{}");
    JSONObject wire = BridgeInput.envelope(turn, config());
    assertEquals(2, wire.getInt("protocolVersion"));
    assertFalse(wire.has("message"));
    assertEquals(turn.sourceMessageId, wire.getJSONObject("trigger").getString("triggerId"));
}

@Test public void lanAcceptedTurnPollsUntilCommittedWithoutFallback() throws Exception {
    server.enqueue(202, "{\"turnId\":\"turn-1\",\"state\":\"queued\",\"terminal\":false}");
    server.enqueue(200, "{\"turnId\":\"turn-1\",\"state\":\"brain_running\",\"terminal\":false}");
    server.enqueue(200, committedJson("turn-1", "你好呀"));
    BridgeResult result = client.sendLan(directSubmission());
    assertEquals("你好呀", result.replyText);
    assertEquals(3, server.requestCount());
}
```

- [ ] **Step 2: Run Android unit tests and verify RED**

Run: `gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.bridge.BridgeClientTest" --no-problems-report`
Expected: FAIL because proactive turns still fabricate an empty user message and LAN expects one synchronous 201 reply.

- [ ] **Step 3: Implement v2 envelope and bounded poll loop**

`BridgeConfig` gains `turnDeadlineMs`, clamped to `60_000..3_600_000` with default `1_200_000`. `BridgeInput.envelope` uses the real message only for `DIRECT_REPLY`; all automatic kinds build a trigger from `inputJson`, `snapshotJson`, `sourceMessageId`, and `createdAt`. Every poll signs the exact GET path with a fresh nonce.

```java
long deadline = submission.createdAt + config.turnDeadlineMs;
submitIdempotently(submission);
while (clock.now() < deadline) {
    BridgeTurnStatus status = poll(submission.turnId);
    if (status.committed()) return status.toResult(routeName);
    if (status.failedFinal()) throw new BridgeFinalException(status.errorCode, status.allowFallback);
    sleeper.sleep(status.retryAfterMs());
}
throw new BridgeDeadlineException(submission.turnId);
```

- [ ] **Step 4: Run BridgeClient, status probe, and secret-store tests**

Run: `gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.bridge.*" --no-problems-report`
Expected: PASS with fresh signatures, one turn ID, trigger-only automatic turns, and a fixed original deadline.

- [ ] **Step 5: Commit**

```powershell
git add -- android/app/src/main/java/com/siyi/al/execution/bridge android/app/src/main/java/com/siyi/al/execution/secure/AlSecretStore.java android/app/src/test/java/com/siyi/al/execution/bridge
git commit -m "feat: poll Yuqi bridge turns on Android"
```

### Task 7: Android Route Decisions and Process-Death Recovery

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgePendingException.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeFinalException.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeDeadlineException.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RetryPolicy.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/RetryPolicyTest.java`

**Interfaces:**
- Produces: route failure categories that distinguish pending/unreachable from final/fallback-allowed.
- Ensures: `MEMORY_RUNNING` bridged attempts resume the bridge instead of calling legacy model stages.

- [ ] **Step 1: Write failing no-premature-fallback and recovery tests**

```java
@Test public void transientLanAndCloudFailuresDoNotInvokeFallbackBeforeDeadline() throws Exception {
    router = routerThrowing(new BridgePendingException("network"), new BridgePendingException("cloud"));
    assertThrows(BridgePendingException.class, () -> router.execute(directSubmission()));
    assertEquals(0, fallback.calls);
}

@Test public void recoveredMemoryRunningBridgeUsesSameRemoteTurnAndNeverLegacyCall() {
    FakeStore store = bridgeStore("MEMORY_RUNNING");
    BridgedGateway gateway = new BridgedGateway();
    engine(store, gateway).recoverInterruptedWork();
    assertEquals(1, gateway.bridgeCalls);
    assertEquals(0, gateway.legacyCalls);
    assertEquals(TurnState.COMPLETED.name(), store.turn.state);
}
```

- [ ] **Step 2: Run router/engine/retry tests and verify RED**

Run: `gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.ExecutionEngineTest" --tests "com.siyi.al.execution.RetryPolicyTest" --tests "com.siyi.al.execution.bridge.BridgeRouterTest" --no-problems-report`
Expected: FAIL because any route exception currently falls through to fallback and recovered `MEMORY_RUNNING` calls the legacy model.

- [ ] **Step 3: Implement explicit terminal decisions and bridged recovery**

In `BridgeRouter`, collect pending route errors and rethrow them when no route returns a terminal result. Invoke fallback only for `BridgeFinalException.allowFallback()` or `BridgeDeadlineException`. In `ExecutionEngine.process`, select bridge processing whenever the gateway is bridged and the state is `QUEUED` or `MEMORY_RUNNING`; only mark `MEMORY_RUNNING` when starting from `QUEUED`.

- [ ] **Step 4: Run all Android JVM tests**

Run: `gradlew.bat :app:testDebugUnitTest --no-problems-report`
Expected: PASS; transient network failures remain retryable and no recovered bridge attempt calls legacy memory/chat stages.

- [ ] **Step 5: Commit**

```powershell
git add -- android/app/src/main/java/com/siyi/al/execution/bridge android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java android/app/src/main/java/com/siyi/al/execution/RetryPolicy.java android/app/src/test/java/com/siyi/al/execution
git commit -m "fix: recover Yuqi bridge turns without fallback"
```

### Task 8: Legacy Failed-Turn Upgrade and Provenance Integrity

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/FallbackJournal.java`
- Test: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRecoveryTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java`

**Interfaces:**
- Consumes: retry call with canonical current `inputJson` and `snapshotJson`.
- Ensures: v1 `{}` failures are upgraded to v2 without reassigning speaker or duplicating raw messages.

- [ ] **Step 1: Add failing legacy retry and attribution tests**

```java
@Test public void retryReplacesLegacyEmptyPayloadAndPreservesOneUserMessage() throws Exception {
    seedLegacyFailedTurn("{}");
    store.startRetry("turn-old", now, canonicalInput("msg-old", "你好"), snapshot);
    assertEquals("你好", new JSONObject(store.turn("turn-old").inputJson)
        .getJSONObject("message").getString("content"));
    assertEquals(1, dao.rawMessagesForTurn("turn-old", "user").size());
}

@Test public void fallbackRecoveryKeepsSpeakersAndSuppressesCompetingReply() {
    RecoveryResult result = reconcile(fallbackPacket());
    assertEquals("user", result.userMessage.speakerId);
    assertEquals("yuqi", result.characterMessage.speakerId);
    assertTrue(result.deliverReplies.isEmpty());
}
```

- [ ] **Step 2: Run targeted Room/recovery tests and verify RED**

Run: `gradlew.bat :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.siyi.al.execution.RoomExecutionStoreTest --no-problems-report` and `gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.bridge.BridgeRecoveryTest" --tests "com.siyi.al.execution.bridge.FallbackJournalTest" --no-problems-report`
Expected: FAIL on at least the v2 upgrade/provenance assertion before implementation.

- [ ] **Step 3: Implement canonical retry upgrade and immutable raw speaker fields**

The plugin must require both current input and snapshot when retrying a legacy bridge failure. `RoomBridgeMirror` inserts direct user raw text once, inserts automatic replies without any user row, and always records `origin` from `BridgeResult`. `FallbackJournal` exports exact immutable speaker fields and a monotonic sequence.

- [ ] **Step 4: Run Room and recovery tests**

Run the same two Gradle commands from Step 2.
Expected: PASS; one user row, one character reply, correct origins, no competing recovered reply.

- [ ] **Step 5: Commit**

```powershell
git add -- android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/execution/bridge android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java android/app/src/test/java/com/siyi/al/execution/bridge
git commit -m "fix: upgrade legacy Yuqi retries safely"
```

### Task 9: Automated Full-Suite Verification

**Files:**
- Modify: `scripts/verify-yuqi-runtime.mjs`
- Modify: `package.json`
- Test: all Node and Android JVM suites.

**Interfaces:**
- Produces: one deterministic verification command that fails on any protocol, bridge, relay, recovery, or provenance regression.

- [ ] **Step 1: Extend the verifier contract and watch it fail before all suites are wired**

The verifier must execute:

```json
{
  "checks": [
    "node-runtime-tests", "relay-tests", "android-jvm-tests",
    "protocol-v2-contract", "no-empty-user-trigger", "version-contract"
  ]
}
```

Run: `npm run yuqi:verify`
Expected: FAIL until every named check is implemented and all prior tasks are green.

- [ ] **Step 2: Wire exact test commands and version contract**

`yuqi:verify` runs Node runtime tests, relay/deployment tests, Android JVM tests with JDK 21, and static searches that reject `protocolVersion: 1` for new submissions and reject automatic use of `userMessage()`.

- [ ] **Step 3: Run the complete automated suite**

Run: `npm test`
Run: `npm run yuqi:verify`
Run: `gradlew.bat :app:testDebugUnitTest --no-problems-report`
Expected: all PASS with no test failures or uncaught warnings from project code.

- [ ] **Step 4: Commit**

```powershell
git add -- scripts/verify-yuqi-runtime.mjs package.json
git commit -m "test: verify the complete Yuqi bridge"
```

### Task 10: Real Android End-to-End Matrix and APK Delivery

**Files:**
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/YuqiLanRoundTripTest.java`
- Create: `android/app/src/androidTest/java/com/siyi/al/execution/YuqiAutomaticTriggerTest.java`
- Create: `android/app/src/androidTest/java/com/siyi/al/execution/YuqiProcessRecoveryTest.java`
- Create: `artifacts/verification/yuqi-bridge-verification.json`
- Produce: `artifacts/AL-1.0.72-yuqi-async-verified.apk`

**Interfaces:**
- Uses: isolated PC SQLite database, isolated 127.0.0.1 runtime, Android API 35 emulator, ADB reverse, and controlled relay/fallback fixtures.
- Produces: authoritative evidence for each delivery gate in the confirmed specification.

- [ ] **Step 1: Write instrumentation scenarios before the final production run**

Tests must assert:

```java
assertEquals("codex", direct.replyOrigin());
assertEquals(1, phoneDb.userRows(direct.turnId).size());
assertEquals(1, phoneDb.characterRows(direct.turnId).size());
assertEquals(0, phoneDb.userRows(proactive.turnId).size());
assertEquals(originalTurnId, recovered.turnId);
assertEquals(1, phoneDb.replyParts(recovered.turnId).size());
assertTrue(reconciled.deliverReplies.isEmpty());
```

- [ ] **Step 2: Run the isolated runtime under the real Windows user and install the debug APK**

Run the runtime on `127.0.0.1:17892` with a test-only pairing secret and database under `artifacts/e2e/`. Establish `adb reverse tcp:17892 tcp:17892`. Install the freshly built debug APK and verify its version code.

- [ ] **Step 3: Run direct, old-retry, proactive, and process-death tests**

Run: `gradlew.bat :app:connectedDebugAndroidTest --no-problems-report -Pandroid.testInstrumentationRunnerArguments.yuqiE2e=true`
Expected: PASS for direct LAN Codex origin, upgraded legacy retry, trigger-only proactive reply, and same-turn process recovery.

- [ ] **Step 4: Run LAN-to-Cloud and fallback-reconciliation scenarios**

Interrupt LAN polling after acceptance, register the same turn through the controlled Cloud relay, and assert the same reply checksum. Force a remote `failed_final` result, assert fallback origin, restart the dedicated runtime, reconcile the journal, and assert memory import with no second visible reply.

- [ ] **Step 5: Inspect authoritative phone and PC data**

Export only test databases. Assert exact `turnId`, `speakerId`, `speakerType`, `origin`, message content, timestamps, outbox ack, and recovery ack. Write the results and command exit codes to `artifacts/verification/yuqi-bridge-verification.json`; do not include secrets or hidden reasoning.

- [ ] **Step 6: Verify backup and build the release candidate**

Run: `npm run yuqi:backup` against the test configuration, restore into a new temporary database, and compare message/fact/turn counts and checksums. Build with `AL_VERSION_CODE=72` and `AL_VERSION_NAME=1.0.72`, then copy the signed APK to `artifacts/AL-1.0.72-yuqi-async-verified.apk`.

- [ ] **Step 7: Re-run smoke tests against the exact delivery APK**

Install the artifact APK, repeat one direct turn and one proactive trigger, and assert both results in phone Room and PC SQLite. Delivery is prohibited if the exact artifact differs from the tested APK checksum.

- [ ] **Step 8: Commit durable tests and verification tooling**

```powershell
git add -- android/app/src/androidTest/java/com/siyi/al/execution scripts package.json
git commit -m "test: prove Yuqi bridge end to end"
```

## Plan Self-Review Result

- Spec coverage: protocol v2, direct/trigger separation, async LAN, resumable roles, fixed model/effort, structured output, Cloud outbox, Android process recovery, fallback gates, legacy retry, provenance, reconciliation, backup, emulator verification, and exact APK smoke test are each mapped to a task.
- Placeholder scan: no deferred implementation markers remain.
- Type consistency: `turnId`, `origin`, `allowFallback`, `outputSchema`, `turnDeadlineMs`, `trigger`, and result outbox names are consistent across Node, Android, relay, and tests.
