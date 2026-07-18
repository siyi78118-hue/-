# Yuqi Dedicated AL Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-shaped Yuqi-specific AL path in which a durable PC bridge coordinates memory, brain, and supervisor Codex threads, the phone uses LAN/cloud routing with fallback, and all remembered facts retain verifiable speaker evidence in phone and PC backups.

**Architecture:** Add a focused Node 24 PC runtime using Codex App Server JSON-RPC over stdio, a SQLite authority store, and a local HTTP API. Extend the existing Cloudflare D1 worker with a separate encrypted relay surface and the Android native execution layer with a bridge-first gateway that falls back to the existing model gateway. Keep the existing WebView UI and automatic-task behavior, but move Yuqi-specific orchestration into isolated modules and versioned presets.

**Tech Stack:** Node.js 24 (`node:http`, `node:crypto`, `node:sqlite`, `node:test`), Codex App Server v2 JSON-RPC, Android Java/Room/WorkManager, Cloudflare Worker/D1/Durable Object WebSockets, existing Capacitor WebView.

## Global Constraints

- Yuqi starts at first acquaintance and receives no Xu Mi legacy memories.
- The runtime uses three durable logical sessions: `memory`, `brain`, and `supervisor`; this maintenance task is not a runtime dependency.
- Raw messages and structured evidence are authoritative; summaries and vectors are retrieval aids only.
- Every formal fact stores stable source message IDs and speaker IDs; ambiguous attribution remains provisional.
- Normal recent context is 200 raw messages, with event-boundary expansion when needed.
- LAN direct transport is preferred in `auto`; cloud relay is used off-LAN; existing chat/memory AI is the fallback.
- Phone and PC each retain a complete recoverable copy; recovery is sequence- and checksum-based.
- Cloud payloads are encrypted before upload; Cloudflare never receives plaintext prompts, messages, or memory.
- Existing unrelated working-tree changes are preserved.

---

### Task 1: PC runtime protocol and durable task store

**Files:**
- Create: `yuqi-runtime/src/protocol.mjs`
- Create: `yuqi-runtime/src/store.mjs`
- Create: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `validateEnvelope(value)`, `canonicalJson(value)`, `contentHash(value)`, `YuqiStore`.
- `YuqiStore` exposes `open()`, `close()`, `submitTurn(envelope)`, `claimTurn(workerId)`, `advanceTurn(turnId, expectedState, nextState, patch)`, `putMessage(message)`, `putFact(fact)`, `listMessages(characterId, limit)`, and `getSyncDelta(afterSeq, limit)`.

- [ ] **Step 1: Write failing protocol and persistence tests**

```js
test('rejects an envelope whose speaker conflicts with its message', () => {
  assert.throws(() => validateEnvelope({
    protocolVersion: 1,
    turnId: 'turn_1',
    characterId: 'yuqi',
    message: { messageId: 'msg_1', speakerId: 'yuqi', speakerType: 'user', content: 'hi', sentAt: 1 }
  }), /speaker/i);
});

test('submitTurn is idempotent and survives reopen', () => {
  const first = store.submitTurn(validEnvelope);
  const second = store.submitTurn(validEnvelope);
  assert.equal(first.turnId, second.turnId);
  assert.equal(reopened.getTurn(first.turnId).state, 'queued');
});
```

- [ ] **Step 2: Run the test and verify missing modules fail**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the protocol and SQLite schema**

```js
export const TURN_STATES = Object.freeze([
  'queued', 'memory_running', 'memory_done', 'brain_running',
  'brain_done', 'supervisor_running', 'approved', 'committed',
  'delivered', 'completed', 'fallback', 'failed'
]);

export function validateEnvelope(value) {
  if (!value || value.protocolVersion !== 1) throw new Error('protocolVersion');
  if (!/^turn_[A-Za-z0-9_-]+$/.test(value.turnId || '')) throw new Error('turnId');
  const message = value.message || {};
  if (message.speakerType === 'user' && message.speakerId !== 'user') throw new Error('speaker mismatch');
  if (message.speakerType === 'character' && message.speakerId !== value.characterId) throw new Error('speaker mismatch');
  return structuredClone(value);
}
```

Create SQLite tables `turns`, `messages`, `facts`, `sync_log`, `sessions`, `preset_versions`, `annotations`, and `diagnostics`. Add unique constraints for `turn_id`, `message_id`, and `(device_id, device_seq)` and store canonical SHA-256 checksums.

- [ ] **Step 4: Run protocol/store tests**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add .gitignore yuqi-runtime/src/protocol.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/protocol-store.test.mjs
git commit -m "feat: add durable Yuqi runtime store"
```

### Task 2: Codex App Server client and three durable sessions

**Files:**
- Create: `yuqi-runtime/src/codex-client.mjs`
- Create: `yuqi-runtime/test/fixtures/fake-app-server.mjs`
- Create: `yuqi-runtime/test/codex-client.test.mjs`

**Interfaces:**
- Consumes: `YuqiStore` session records.
- Produces: `CodexAppServerClient.start()`, `ensureThread(role)`, `runTurn(role, input, options)`, `interrupt(role)`.

- [ ] **Step 1: Write failing JSON-RPC lifecycle tests**

```js
test('initializes once and resumes the stored role thread', async () => {
  const client = await fakeClient({ storedThread: 'thr_memory' });
  const result = await client.runTurn('memory', 'find evidence');
  assert.deepEqual(client.methods(), ['initialize', 'thread/resume', 'turn/start']);
  assert.equal(result.text, '{"query":"promise"}');
});
```

- [ ] **Step 2: Verify the lifecycle test fails**

Run: `node --test yuqi-runtime/test/codex-client.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement newline-delimited JSON-RPC**

Spawn `codex app-server`, send `initialize`, then `initialized`. Use `thread/start` when a role has no stored thread ID and `thread/resume` otherwise. Send user inputs through `turn/start`, collect `item/agentMessage/delta` and `item/completed`, and resolve only on the matching `turn/completed`. Reject failed and interrupted turns with typed errors. Never send shell/file permissions to role threads; start them with `approvalPolicy: "never"` and a read-only runtime context directory.

- [ ] **Step 4: Run the client tests**

Run: `node --test yuqi-runtime/test/codex-client.test.mjs`

Expected: PASS, including process restart and out-of-order notification tests.

- [ ] **Step 5: Commit Task 2**

```powershell
git add yuqi-runtime/src/codex-client.mjs yuqi-runtime/test/fixtures/fake-app-server.mjs yuqi-runtime/test/codex-client.test.mjs
git commit -m "feat: manage Yuqi Codex role threads"
```

### Task 3: Evidence-first memory and retrieval packs

**Files:**
- Create: `yuqi-runtime/src/evidence-memory.mjs`
- Create: `yuqi-runtime/src/retrieval.mjs`
- Create: `yuqi-runtime/test/evidence-memory.test.mjs`

**Interfaces:**
- Consumes: raw messages from `YuqiStore` and candidate JSON from the memory thread.
- Produces: `validateFactCandidate(candidate, messages)`, `commitVerifiedFacts(store, candidates)`, and `buildEvidencePack(store, request)`.

- [ ] **Step 1: Write failing attribution tests**

```js
test('never promotes a character promise as a user promise', () => {
  const messages = [{ messageId: 'm1', speakerId: 'yuqi', content: '我答应你会回来' }];
  const candidate = { type: 'commitment', promisedBy: 'user', promisedTo: 'yuqi', sourceMessageIds: ['m1'] };
  assert.equal(validateFactCandidate(candidate, messages).status, 'provisional');
});

test('a reported promise is not direct evidence', () => {
  const messages = [{ messageId: 'm2', speakerId: 'user', content: '你之前答应过我' }];
  const result = validateFactCandidate({ type: 'commitment', promisedBy: 'yuqi', evidenceMode: 'direct', sourceMessageIds: ['m2'] }, messages);
  assert.equal(result.status, 'provisional');
});
```

- [ ] **Step 2: Verify the attribution tests fail**

Run: `node --test yuqi-runtime/test/evidence-memory.test.mjs`

Expected: FAIL with missing export.

- [ ] **Step 3: Implement evidence validation and hybrid retrieval**

Require every candidate to include `subjectId`, `predicate`, `object`, `evidenceMode`, `sourceMessageIds`, and exact quote hashes. Accept direct first-person commitments only when `promisedBy` equals the source speaker; accept acknowledged commitments only when an explicit acceptance source from `promisedBy` is present. Search mandatory open commitments and boundaries first, then exact terms, structured fields, and vector candidates. Return source speaker, exact quote, timestamp, and two neighboring messages.

- [ ] **Step 4: Run evidence tests**

Run: `node --test yuqi-runtime/test/evidence-memory.test.mjs`

Expected: PASS for direct, reported, quoted, joking, corrected, withdrawn, and same-word-by-both-sides fixtures.

- [ ] **Step 5: Commit Task 3**

```powershell
git add yuqi-runtime/src/evidence-memory.mjs yuqi-runtime/src/retrieval.mjs yuqi-runtime/test/evidence-memory.test.mjs
git commit -m "feat: verify Yuqi memory evidence"
```

### Task 4: Versioned Yuqi preset and annotation registry

**Files:**
- Create: `yuqi-runtime/presets/manifest.json`
- Create: `yuqi-runtime/presets/yuqi-core.md`
- Create: `yuqi-runtime/presets/memory-manager.md`
- Create: `yuqi-runtime/presets/supervisor.md`
- Create: `yuqi-runtime/src/preset-registry.mjs`
- Create: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Produces: `PresetRegistry.current()`, `compileFor(role, scene)`, `proposeAnnotation(annotation)`, `publishVersion(proposalId)`, and `rollback(version)`.

- [ ] **Step 1: Write failing separation/version tests**

```js
test('hidden user formulation is never compiled as in-world knowledge', () => {
  const prompt = registry.compileFor('brain', { stage: 'initial', revealedFactIds: [] });
  assert.doesNotMatch(prompt, /用户曾经在许弥关系中/);
  assert.match(prompt, /不得声称知道尚未亲口透露的经历/);
});
```

- [ ] **Step 2: Verify the preset tests fail**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement immutable preset versions**

Store a content hash, parent version, changed modules, annotation IDs, published timestamp, and rollback pointer. Compile only role-relevant modules. The core preset must encode Yuqi as a living woman in a parallel world, equal mutual possession, exclusivity without hierarchy, rational inner judgment expressed through emotionally genuine language, and no performative flirting she secretly considers childish.

- [ ] **Step 4: Run preset tests**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs tests/rp-preset-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```powershell
git add yuqi-runtime/presets yuqi-runtime/src/preset-registry.mjs yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: version Yuqi persona presets"
```

### Task 5: Orchestrator and local LAN API

**Files:**
- Create: `yuqi-runtime/src/orchestrator.mjs`
- Create: `yuqi-runtime/src/local-server.mjs`
- Create: `yuqi-runtime/src/main.mjs`
- Create: `yuqi-runtime/config.example.json`
- Create: `yuqi-runtime/start-yuqi.cmd`
- Create: `yuqi-runtime/test/orchestrator.test.mjs`
- Create: `yuqi-runtime/test/local-server.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces authenticated endpoints `GET /v1/health`, `POST /v1/turns`, `GET /v1/turns/:id`, `POST /v1/turns/:id/cancel`, `GET /v1/sync`, and `POST /v1/sync/ack`.

- [ ] **Step 1: Write failing end-to-end orchestration tests**

```js
test('runs memory, brain, hard check, supervisor and commits one reply', async () => {
  const result = await orchestrator.process(validUserTurn);
  assert.deepEqual(fakeCodex.roles(), ['memory', 'brain', 'supervisor']);
  assert.equal(result.reply.speakerId, 'yuqi');
  assert.equal(store.listReplyParts(result.turnId).length, 1);
});
```

- [ ] **Step 2: Verify orchestration tests fail**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/local-server.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement state transitions and HTTP authentication**

Advance the turn through `queued -> memory_running -> memory_done -> brain_running -> brain_done -> supervisor_running -> approved -> committed`. Use HMAC request signatures, timestamp skew checks, nonce replay protection, body size limits, loopback/LAN binding configuration, and constant-time signature comparison. Send the reply before asynchronous fact extraction/indexing finishes.

- [ ] **Step 4: Run all PC runtime tests**

Run: `node --test yuqi-runtime/test/*.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```powershell
git add yuqi-runtime/src yuqi-runtime/test yuqi-runtime/config.example.json yuqi-runtime/start-yuqi.cmd
git commit -m "feat: orchestrate Yuqi LAN replies"
```

### Task 6: Encrypted Cloudflare relay and quota telemetry

**Files:**
- Create: `migrations/0002_yuqi_relay.sql`
- Create: `yuqi-relay-worker.js`
- Create: `tests/yuqi-relay-worker.test.mjs`
- Modify: `wrangler.toml`
- Modify: `package.json`

**Interfaces:**
- Produces: `POST /bridge/register`, `POST /bridge/enqueue`, `GET /bridge/poll`, `POST /bridge/ack`, WebSocket `/bridge/socket`, and `GET /bridge/quota`.

- [ ] **Step 1: Write failing relay tests**

Test ciphertext-only persistence, device ownership, idempotency keys, ack deletion, hibernating WebSocket wakeup, expiration, and 50/75/90 percent quota warnings.

- [ ] **Step 2: Verify relay tests fail**

Run: `node --test tests/yuqi-relay-worker.test.mjs`

Expected: FAIL because `yuqi-relay-worker.js` does not exist.

- [ ] **Step 3: Implement relay without plaintext access**

Store only `device_id`, `message_id`, `direction`, `ciphertext`, `nonce`, `created_at`, `expires_at`, `acked_at`, and byte counts. The Durable Object forwards opaque frames and hibernates when idle. D1 is the durable mailbox; no vector, prompt, role, or memory data enters Cloudflare.

- [ ] **Step 4: Run worker tests and current cloud regression**

Run: `node --test tests/yuqi-relay-worker.test.mjs tests/cloud-timer-d1.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add migrations/0002_yuqi_relay.sql yuqi-relay-worker.js tests/yuqi-relay-worker.test.mjs wrangler.toml package.json
git commit -m "feat: add encrypted Yuqi cloud relay"
```

### Task 7: Android bridge-first routing and phone mirror

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeMode.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeConfig.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/RawMessageEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/EvidenceFactEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/SyncCursorEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRecoveryTest.java`

**Interfaces:**
- Produces: `BridgeRouter.execute(TurnSubmission)` with `AUTO`, `LAN`, and `CLOUD` routes and an explicit `FallbackResult`.

- [ ] **Step 1: Write failing routing and sync tests**

```java
@Test public void autoPrefersLanAndFallsBackToCloud() {
  BridgeRouter router = fixture().lanFails(false).cloudSucceeds();
  assertEquals(Arrays.asList("lan", "cloud"), router.execute(submission).attemptedRoutes());
}
```

- [ ] **Step 2: Verify Android tests fail with JDK 21**

Run: `android\gradlew.bat testDebugUnitTest`

Expected: compilation failure for missing bridge classes.

- [ ] **Step 3: Implement bridge routing and Room migration**

Persist the raw user message before transport. In `AUTO`, try the configured LAN URL with a short connect timeout, then the encrypted cloud relay. Poll or receive push until the committed reply is available. Mirror raw messages, verified facts, preset version, origin (`codex` or `fallback`), and sync sequence. Never overwrite newer rows with an older snapshot.

- [ ] **Step 4: Run Android and JavaScript regressions**

Run: `android\gradlew.bat testDebugUnitTest`

Run: `npm.cmd test`

Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```powershell
git add android/app/src/main/java/com/siyi/al/execution android/app/src/test/java/com/siyi/al/execution
git commit -m "feat: route Yuqi turns through PC bridge"
```

### Task 8: Fallback journal and Codex recovery reconciliation

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/FallbackJournal.java`
- Create: `yuqi-runtime/src/reconcile.mjs`
- Create: `yuqi-runtime/test/reconcile.test.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java`

**Interfaces:**
- Produces provisional fallback records and `reconcileFrom(lastCommonSeq)`.

- [ ] **Step 1: Write failing recovery tests**

Cover PC sleep, memory-role failure, supervisor failure, duplicate cloud delivery, and recovery after a fallback reply was already shown.

- [ ] **Step 2: Verify recovery tests fail**

Run: `node --test yuqi-runtime/test/reconcile.test.mjs`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement provisional journaling and replay**

Fallback replies are delivered normally but their extracted facts remain provisional. On PC recovery, replay from the last common sync sequence, run the memory thread over exact raw messages, validate evidence, promote accepted facts, and mark the replay range reconciled. Never regenerate or resend an already delivered reply.

- [ ] **Step 4: Run recovery and Android tests**

Run: `node --test yuqi-runtime/test/reconcile.test.mjs`

Run: `android\gradlew.bat testDebugUnitTest`

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```powershell
git add android/app/src/main/java/com/siyi/al/execution yuqi-runtime/src/reconcile.mjs yuqi-runtime/test/reconcile.test.mjs
git commit -m "feat: reconcile Yuqi fallback memories"
```

### Task 9: AL settings, status, annotations, and 200-message context

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`
- Create: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Exposes settings for Yuqi runtime enablement, `AUTO/LAN/CLOUD`, LAN address, pairing secret, bridge health, quota warnings, thread health, sync status, and annotation submission.

- [ ] **Step 1: Write failing UI contract tests**

Assert the current context constant is 200, a first-acquaintance Yuqi profile exists, connection modes are present, and no Xu Mi memory migration action exists.

- [ ] **Step 2: Verify UI tests fail**

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: FAIL on missing Yuqi controls.

- [ ] **Step 3: Implement focused UI integration**

Add a Yuqi runtime settings section and status cards without rewriting unrelated screens. Annotation submission records the source turn, selected message, user correction, current preset version, and desired behavior; publication remains a maintenance-workbench operation. Raise normal raw context to 200 while preserving event expansion.

- [ ] **Step 4: Run all web tests**

Run: `npm.cmd test`

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 9**

```powershell
git add tavern-app/index.html test-basic.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: add Yuqi runtime controls"
```

### Task 10: Packaging, deployment, and completion audit

**Files:**
- Create: `YUQI_RUNTIME.md`
- Create: `scripts/verify-yuqi-runtime.mjs`
- Modify: `package.json`
- Modify: `CLOUD_TIMER_DEPLOY.md`
- Modify: `android-update.json`

**Interfaces:**
- Produces `npm run yuqi:verify`, `npm run yuqi:start`, Android debug APK, and deployment instructions.

- [ ] **Step 1: Add a failing completion verifier**

The verifier must check PC runtime health, all three role threads using a fake app server, evidence attribution fixtures, encrypted relay tests, current web tests, Android unit tests, and APK existence.

- [ ] **Step 2: Run the verifier and confirm incomplete artifacts fail**

Run: `node scripts/verify-yuqi-runtime.mjs`

Expected: FAIL until all required artifacts and tests exist.

- [ ] **Step 3: Package and document operations**

Document first pairing, automatic startup, LAN/cloud switching, PC memory-vault path, recovery, preset publication, quota warning meanings, diagnostics export, and safe shutdown. Build the Android app with `npm.cmd run android:debug` and deploy the relay only after local Worker tests pass and Cloudflare account binding is verified.

- [ ] **Step 4: Run the full completion audit**

Run: `npm.cmd run yuqi:verify`

Expected: PASS with a report that names every requirement and its evidence.

- [ ] **Step 5: Commit Task 10**

```powershell
git add YUQI_RUNTIME.md scripts/verify-yuqi-runtime.mjs package.json CLOUD_TIMER_DEPLOY.md android-update.json
git commit -m "docs: package and verify Yuqi runtime"
```
