# Yuqi Adaptive Routing and Proactive Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a signed Android build in which direct and proactive Yuqi conversations use an adaptive dedicated-Codex bridge, legacy fallback bubbles reconcile into memory with correct provenance, and both immersive and technical progress are observable.

**Architecture:** A deterministic runtime route policy selects fast or deep execution before any role call; a structured memory escalation can promote a fast turn through a second memory call. Android, foreground JavaScript, and Service Worker proactive triggers converge on the native execution queue. A separate idempotent reconciliation protocol uploads phone-only visible messages to the PC store and runs memory ingestion without generating a reply.

**Tech Stack:** Node.js ESM, `node:sqlite`, Codex App Server, Capacitor 8, Android Java/Room/WorkManager, vanilla JavaScript Service Worker, Gradle, Node test runner, JUnit.

## Global Constraints

- Fast route is memory `gpt-5.6-terra / medium`, brain `gpt-5.6-sol / medium`, deterministic hard validation, and no supervisor by default.
- Deep route is memory `gpt-5.6-sol / medium`, brain `gpt-5.6-sol / medium`, deterministic hard validation, and supervisor `gpt-5.6-terra / medium`.
- Proactive tasks default to deep and never create a fake user message.
- A memory escalation finishes the Terra call and starts a new Sol call inside the same `turnId` before brain execution.
- Immersive UI never exposes model names, prompts, role names, internal reasoning, or synchronization details.
- Reconciled fallback messages use `origin = legacy_fallback`, preserve speaker and time, update memory, and never generate a visible reply.
- Existing Yuqi persona and annotation presets remain authoritative and unchanged.
- Android package remains `com.siyi.al`; release uses version code `74`, version name `1.0.74`, and the existing formal signing identity.
- Existing user files and unrelated dirty-worktree changes remain untouched.

---

### Task 1: Deterministic Route Policy

**Files:**
- Create: `yuqi-runtime/src/route-policy.mjs`
- Create: `yuqi-runtime/test/route-policy.test.mjs`
- Modify: `yuqi-runtime/config.example.json`
- Modify: `yuqi-runtime/config.json`

**Interfaces:**
- Consumes: validated v2 envelope and recent raw messages.
- Produces: `selectTurnRoute({ envelope, recentMessages }): { route, reasons }` and `roleExecutionProfile(route, role)`.

- [ ] **Step 1: Write the failing route-policy tests**

```js
test('ordinary greeting selects fast', () => {
  assert.equal(selectTurnRoute({ envelope: direct('今天吃什么呀'), recentMessages: [] }).route, 'fast');
});
test('short promise reminder selects deep', () => {
  assert.equal(selectTurnRoute({ envelope: direct('你答应过的呢'), recentMessages: [] }).route, 'deep');
});
test('proactive tasks select deep', () => {
  assert.equal(selectTurnRoute({ envelope: proactive(), recentMessages: [] }).route, 'deep');
});
test('profiles use the approved model matrix', () => {
  assert.deepEqual(roleExecutionProfile('fast', 'memory'), { model: 'gpt-5.6-terra', effort: 'medium' });
  assert.deepEqual(roleExecutionProfile('deep', 'supervisor'), { model: 'gpt-5.6-terra', effort: 'medium' });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test yuqi-runtime/test/route-policy.test.mjs`  
Expected: FAIL because `route-policy.mjs` does not exist.

- [ ] **Step 3: Implement the exact route result and configurable profiles**

```js
export function selectTurnRoute({ envelope, recentMessages = [] }) {
  if (envelope.kind !== 'DIRECT_REPLY') return { route: 'deep', reasons: ['automatic_task'] };
  const text = envelope.message.content.trim();
  const reasons = collectDeepReasons(text, recentMessages);
  return { route: reasons.length ? 'deep' : 'fast', reasons };
}

export function roleExecutionProfile(route, role, config = DEFAULT_PROFILES) {
  const profile = config?.[route]?.[role];
  if (!profile?.model || profile.effort !== 'medium') throw new Error('invalid role execution profile');
  return { model: profile.model, effort: profile.effort };
}
```

- [ ] **Step 4: Run route tests and verify GREEN**

Run: `node --test yuqi-runtime/test/route-policy.test.mjs`  
Expected: all route-policy tests PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- yuqi-runtime/src/route-policy.mjs yuqi-runtime/test/route-policy.test.mjs yuqi-runtime/config.example.json yuqi-runtime/config.json
git commit -m "feat: add adaptive Yuqi route policy"
```

### Task 2: Persisted Route, Stage Timing, and Public Status

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/turn-status.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/test/local-server.test.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`

**Interfaces:**
- Produces: `setTurnRoute(turnId, route, reasons)`, `beginStage(turnId, stage, model, effort)`, `finishStage(turnId, stage)`, and public fields `route`, `displayStage`, `technicalStage`, `stageModel`, `stageEffort`, `stageElapsedMs`, `totalElapsedMs`.

- [ ] **Step 1: Write failing store and wire-contract tests**

```js
store.setTurnRoute(turn.turnId, 'fast', ['ordinary_chat']);
store.beginStage(turn.turnId, 'memory', 'gpt-5.6-terra', 'medium', 1000);
store.finishStage(turn.turnId, 'memory', 1450);
assert.deepEqual(store.getTurnStages(turn.turnId)[0], {
  stage: 'memory', model: 'gpt-5.6-terra', effort: 'medium',
  startedAt: 1000, finishedAt: 1450, durationMs: 450
});
assert.equal(toPublicTurn(store.getTurn(turn.turnId), store).displayStage, '正在翻一下我们以前说过的话…');
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/local-server.test.mjs`  
Expected: FAIL because route/stage persistence methods and status fields are missing.

- [ ] **Step 3: Add idempotent SQLite migrations and status mapping**

```sql
ALTER TABLE turns ADD COLUMN route TEXT NOT NULL DEFAULT 'deep';
ALTER TABLE turns ADD COLUMN route_reasons_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS turn_stages (
  turn_id TEXT NOT NULL, stage TEXT NOT NULL, ordinal INTEGER NOT NULL,
  model TEXT, effort TEXT, started_at INTEGER NOT NULL,
  finished_at INTEGER, duration_ms INTEGER,
  PRIMARY KEY(turn_id, stage, ordinal)
);
```

Map internal stages to only three immersive strings and expose technical timing separately in `/v2/turns/{turnId}`.

- [ ] **Step 4: Parse the fields on Android without breaking older servers**

```java
this.route = json.optString("route", "deep");
this.displayStage = json.optString("displayStage", "");
this.technicalStage = json.optString("technicalStage", state);
this.stageElapsedMs = json.optLong("stageElapsedMs", 0L);
this.totalElapsedMs = json.optLong("totalElapsedMs", 0L);
```

- [ ] **Step 5: Run Node and Android unit tests and verify GREEN**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/local-server.test.mjs`  
Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.bridge.BridgeClientTest" --no-problems-report`  
Expected: all focused tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- yuqi-runtime/src/store.mjs yuqi-runtime/src/turn-status.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/local-server.test.mjs android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java
git commit -m "feat: expose Yuqi route stage timing"
```

### Task 3: Adaptive Role Orchestration and Memory Escalation

**Files:**
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: Task 1 route/profile functions and Task 2 stage persistence.
- Produces: fast skip-supervisor path, deep supervisor path, and `fast_to_deep` memory checkpoint.

- [ ] **Step 1: Write failing orchestration tests**

```js
test('fast route calls Terra memory and Sol brain without supervisor', async () => {
  const result = await runGreetingTurn();
  assert.deepEqual(result.calls.map(call => [call.role, call.model, call.effort]), [
    ['memory', 'gpt-5.6-terra', 'medium'],
    ['brain', 'gpt-5.6-sol', 'medium']
  ]);
});

test('fast memory escalation starts a separate Sol memory call', async () => {
  const result = await runEscalatingTurn();
  assert.deepEqual(result.calls.map(call => call.role), ['memory', 'memory', 'brain', 'supervisor']);
  assert.equal(result.turn.route, 'fast_to_deep');
  assert.equal(result.visibleReplies.length, 1);
});
```

- [ ] **Step 2: Run orchestrator tests and verify RED**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`  
Expected: FAIL because all roles are still pinned to Sol/high and supervisor always runs.

- [ ] **Step 3: Extend memory schema with mandatory escalation fields**

```js
required: ['query', 'keywords', 'candidates', 'requiresDeepMemory', 'escalationReasons', 'speakerAmbiguity', 'commitmentRisk']
```

- [ ] **Step 4: Refactor role execution to accept a profile and record timings**

```js
async function runStructuredRole({ role, profile, outputSchema, prompt, turnId, stage }) {
  store.beginStage(turnId, stage, profile.model, profile.effort);
  try {
    return await codex.runRole({ role, model: profile.model, effort: profile.effort, outputSchema, prompt });
  } finally {
    store.finishStage(turnId, stage);
  }
}
```

Fast hard-validation failure promotes to supervisor/deep; deep failure passes concrete issues to one brain rewrite and then final failure.

- [ ] **Step 5: Run orchestrator and recovery tests and verify GREEN**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs`  
Expected: all tests PASS and no call uses `high`.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: execute adaptive Yuqi role chain"
```

### Task 4: Reconciliation Protocol and PC Memory-Only Ingestion

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/reconcile.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/reconcile.test.mjs`
- Modify: `yuqi-runtime/test/local-server.test.mjs`

**Interfaces:**
- Produces: `POST /v2/reconcile/messages`, payload `{ deviceId, batchId, afterAckSeq, messages[] }`, response `{ accepted, batchId, ackSeq, imported, duplicates }`.
- Message shape: `{ messageId, legacyHash, characterId, speakerId, speakerType, recipientId, content, sentAt, origin, localSeq }`.

- [ ] **Step 1: Write failing reconciliation tests**

```js
test('imports phone-only assistant fallback with correct speaker and no reply', async () => {
  const response = await reconcile([legacyYuqiMessage('猜错了也没关系，就是突然好奇', 1784496060000)]);
  assert.equal(response.imported, 1);
  assert.equal(store.getMessage(response.messageIds[0]).speakerId, 'yuqi');
  assert.equal(store.getMessage(response.messageIds[0]).origin, 'legacy_fallback');
  assert.equal(fakeCodex.calls.filter(call => call.role === 'brain').length, 0);
});

test('repeating the batch is idempotent', async () => {
  assert.equal((await reconcile(batch)).imported, 2);
  assert.equal((await reconcile(batch)).duplicates, 2);
});
```

- [ ] **Step 2: Run reconciliation tests and verify RED**

Run: `node --test yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/local-server.test.mjs`  
Expected: FAIL because the reconciliation endpoint and legacy provenance are missing.

- [ ] **Step 3: Validate speaker identity and stable legacy hashes**

```js
export function legacyMessageId(message) {
  return message.messageId || `legacy_${contentHash({
    characterId: message.characterId,
    speakerId: message.speakerId,
    content: message.content,
    sentAt: message.sentAt
  }).slice(0, 32)}`;
}
```

Reject `speakerType=user` unless `speakerId=user`, and reject `speakerType=character` unless `speakerId=characterId`.

- [ ] **Step 4: Implement memory-only ingestion and ACK cursor**

Persist raw messages first, then call only the memory role with a reconciliation prompt. Save `batchId` and monotonically increasing `ackSeq`; never create a turn state that reaches brain or produces `replyJson`.

- [ ] **Step 5: Run reconciliation and full runtime tests and verify GREEN**

Run: `node --test yuqi-runtime/test/*.test.mjs`  
Expected: all runtime tests PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- yuqi-runtime/src/protocol.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/reconcile.mjs yuqi-runtime/src/local-server.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/local-server.test.mjs
git commit -m "feat: reconcile legacy phone messages into Yuqi memory"
```

### Task 5: Android Reconciliation Client and Durable Fallback Journal

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeReconciliationClient.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeReconciliationClientTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/FallbackJournal.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java`

**Interfaces:**
- Produces Capacitor method `reconcileVisibleMessages({ batchId, messages })` and `BridgeReconciliationClient.reconcile(...)`.

- [ ] **Step 1: Write failing Java tests for upload, ACK, and retry**

```java
assertEquals("legacy_fallback", request.messages.get(0).origin);
assertEquals("yuqi", request.messages.get(0).speakerId);
assertEquals(17L, client.reconcile(request).ackSeq);
assertEquals(17L, client.reconcile(request).ackSeq);
```

- [ ] **Step 2: Run focused Android tests and verify RED**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.bridge.*Reconciliation*" --no-problems-report`  
Expected: FAIL because client and plugin method are missing.

- [ ] **Step 3: Implement signed LAN/Cloud reconciliation and secure cursor storage**

Use the existing bridge HMAC/device credentials, short HTTP timeouts, the same LAN-first/AUTO selection, and persistent `SyncCursorEntity(peerId="yuqi_pc")` ACK updates.

- [ ] **Step 4: Journal every explicit old-AI fallback before it becomes visible**

```java
journal.append(new FallbackMessage(
    messageId, characterId, "yuqi", "character", "user",
    content, sentAt, "legacy_fallback"
));
```

- [ ] **Step 5: Run bridge unit tests and verify GREEN**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.bridge.*" --no-problems-report`  
Expected: all bridge tests PASS.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeReconciliationClient.java android/app/src/main/java/com/siyi/al/execution/bridge/FallbackJournal.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeReconciliationClientTest.java android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java
git commit -m "feat: upload phone-only chat history to Yuqi memory"
```

### Task 6: Foreground Proactive Triggers Use the Native Queue

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Produces: `queueAndroidProactiveTurn(charId, job, triggerMode)` and `syncYuqiVisibleHistory(charId)`.

- [ ] **Step 1: Write failing source-contract tests**

```js
assert.match(html, /async function queueAndroidProactiveTurn/);
assert.match(html, /kind:\s*['"]PROACTIVE_CHAT['"]/);
assert.doesNotMatch(extractFunction(html, 'triggerProactiveMessage'), /callAPI\(/);
assert.match(extractFunction(html, 'queueAndroidUserReply'), /await syncYuqiVisibleHistory\(/);
```

- [ ] **Step 2: Run UI contract tests and verify RED**

Run: `node --test tests/yuqi-ui-contract.test.mjs; node test-basic.mjs`  
Expected: FAIL because foreground proactive generation still invokes the legacy API.

- [ ] **Step 3: Implement native proactive submission with stable IDs**

```js
async function queueAndroidProactiveTurn(charId, job, triggerMode = 'planned') {
  await syncYuqiVisibleHistory(charId);
  const triggerId = stableProactiveTriggerId(job, charId);
  return Capacitor.Plugins.AlExecution.submitTurn({
    turnId: `turn_${triggerId}`,
    characterId: charId,
    sourceMessageId: triggerId,
    kind: 'PROACTIVE_CHAT',
    cloudJobId: job.cloudJobId || '',
    inputJson: JSON.stringify({ triggerId, triggerMode }),
    snapshotJson: JSON.stringify(await buildProactiveNativeSnapshot(charId, job))
  });
}
```

On Android, `triggerProactiveMessage` delegates immediately to this function. Browser-only execution retains the existing web path.

- [ ] **Step 4: Scan and upload unsynced visible bubbles before direct/proactive turns**

Build messages from the actual local chat record, preserve original IDs/timestamps, map assistant bubbles to `yuqi/character`, and generate `legacyHash` only when an old row lacks an ID. Store the returned ACK cursor in existing local metadata.

- [ ] **Step 5: Run UI/static tests and verify GREEN**

Run: `node --test tests/yuqi-ui-contract.test.mjs; node test-basic.mjs`  
Expected: all relevant tests PASS.

- [ ] **Step 6: Commit Task 6**

```powershell
git add -- tavern-app/index.html test-basic.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "fix: route foreground proactive chat through native bridge"
```

### Task 7: Android Service Worker Stops Generating Proactive Replies

**Files:**
- Modify: `tavern-app/sw-v11.js`
- Modify: `test-sw-automatic-task-guard.mjs`

**Interfaces:**
- Consumes Android/native environment marker in push payload or registered client metadata.
- Produces a native-deferred notification/event with no `callModel` invocation on Android.

- [ ] **Step 1: Write failing Service Worker guard tests**

```js
assert.equal(await simulateAndroidProactivePush(payload).modelCalls, 0);
assert.equal(await simulateAndroidProactivePush(payload).deferredToNative, true);
assert.equal(await simulateBrowserProactivePush(payload).modelCalls, 1);
```

- [ ] **Step 2: Run Service Worker tests and verify RED**

Run: `node test-sw-automatic-task-guard.mjs`  
Expected: FAIL because Android proactive push can still reach `callModel`.

- [ ] **Step 3: Add the Android native-defer guard before model preparation**

```js
if (isAndroidNativeDelivery(data)) {
  await rememberPendingNativeTrigger(data);
  await notifyVisibleClients({ type: 'AL_NATIVE_PROACTIVE_DUE', trigger: data });
  return { deferredToNative: true };
}
```

- [ ] **Step 4: Run Service Worker tests and verify GREEN**

Run: `node test-sw-automatic-task-guard.mjs`  
Expected: all Service Worker guard tests PASS.

- [ ] **Step 5: Commit Task 7**

```powershell
git add -- tavern-app/sw-v11.js test-sw-automatic-task-guard.mjs
git commit -m "fix: defer Android proactive push to native execution"
```

### Task 8: Immersive Progress and Technical Diagnostics UI

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/warm-modern.css`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes Bridge status fields from Task 2.
- Produces `renderYuqiThinkingStatus(status)` and `renderYuqiTechnicalStatus(status)`.

- [ ] **Step 1: Write failing UI tests**

```js
assert.equal(immersiveText({ technicalStage: 'memory_running' }), '正在翻一下我们以前说过的话…');
assert.equal(immersiveText({ technicalStage: 'brain_running' }), '正在认真想…');
assert.equal(immersiveText({ technicalStage: 'supervisor_running' }), '快好了…');
assert.doesNotMatch(renderedChat, /gpt-|Terra|Sol|小g|提示词|记忆库/i);
assert.match(renderedDiagnostics, /快速通道|gpt-5\.6-terra|medium|\d+\.\d秒/);
```

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --test tests/yuqi-ui-contract.test.mjs; node test-basic.mjs`  
Expected: FAIL because live stage/timing fields are not rendered.

- [ ] **Step 3: Implement non-message status pill and diagnostic rows**

Keep the immersive indicator outside the message list serialization path. Technical rows include route, current stage, model, effort, stage duration, total duration, origin, and escalation/fallback reason.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `node --test tests/yuqi-ui-contract.test.mjs; node test-basic.mjs`  
Expected: all UI tests PASS.

- [ ] **Step 5: Commit Task 8**

```powershell
git add -- tavern-app/index.html tavern-app/warm-modern.css tests/yuqi-ui-contract.test.mjs test-basic.mjs
git commit -m "feat: show Yuqi bridge progress and diagnostics"
```

### Task 9: Full Regression, Runtime Migration, and Live Verification

**Files:**
- Evidence output: `artifacts/verification/yuqi-1.0.74-verification.json`

**Interfaces:**
- Consumes all prior task outputs.
- Produces test evidence and a migrated running PC service.

- [ ] **Step 1: Run the complete repository suite**

Run: `npm test`  
Expected: exit code 0; all Node, runtime, UI, relay, and Service Worker tests PASS.

- [ ] **Step 2: Back up the formal memory database**

Run: `npm run yuqi:backup`  
Expected: a timestamped backup and checksum in `C:\Users\PC\Documents\虞栖AL记忆库备份`.

- [ ] **Step 3: Restart and verify the PC runtime**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\stop-yuqi-background.ps1`  
Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start-yuqi-background.ps1`  
Run: `npm run yuqi:verify`  
Expected: health OK on port 17891, three role threads healthy, adaptive profile present, preset version unchanged.

- [ ] **Step 4: Verify the real legacy-message migration**

Open the app once against the live runtime, wait for reconciliation ACK, then run `node scripts/audit-yuqi-memory.mjs`.  
Expected: the two 02:41 assistant bubbles exist as `speakerId=yuqi`, `speakerType=character`, `origin=legacy_fallback`; no duplicate user attribution and no competing reply.

- [ ] **Step 5: Commit Task 9 evidence**

```powershell
git add -- artifacts/verification/yuqi-1.0.74-verification.json
git commit -m "test: verify Yuqi adaptive bridge migration"
```

### Task 10: Signed APK, Emulator Acceptance, Cleanup, and WeChat Delivery

**Files:**
- Modify: `android/app/build.gradle`
- Create: `artifacts/AL-1.0.74-yuqi-adaptive-formal-signed.apk`
- Create: `artifacts/verification/AL-1.0.74-signature.txt`

**Interfaces:**
- Produces the final user-installable artifact.

- [ ] **Step 1: Set the release version and synchronize web assets**

```gradle
versionCode Integer.parseInt(System.getenv("AL_VERSION_CODE") ?: "74")
versionName System.getenv("AL_VERSION_NAME") ?: "1.0.74"
```

Run: `npm run android:sync`  
Expected: current `tavern-app` assets and native sources are copied into Android without error.

- [ ] **Step 2: Build with the existing formal signing environment**

Run: `cd android; .\gradlew.bat clean assembleRelease --no-problems-report` with the established `ANDROID_KEYSTORE_*` environment.  
Expected: signed release APK exists and `apksigner verify --verbose --print-certs` succeeds.

- [ ] **Step 3: Verify signature continuity and package metadata**

Compare the signer SHA-256 to `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.  
Expected: package `com.siyi.al`, version code `74`, version name `1.0.74`, signer digest exact match.

- [ ] **Step 4: Run emulator end-to-end acceptance**

Install over the previous signed build without clearing app data. Exercise one fast direct turn, one deep commitment turn, one proactive turn, duplicate proactive trigger, one legacy reconciliation batch, and live status rendering. Query PC SQLite and Android diagnostics after each case.  
Expected: every condition in design section 10.2 passes and the APK remains overlay-installable.

- [ ] **Step 5: Close the emulator immediately after acceptance**

Run: `adb -s emulator-5554 emu kill`  
Expected: `Get-Process qemu-system-x86_64-headless -ErrorAction SilentlyContinue` returns no emulator process.

- [ ] **Step 6: Archive and checksum the final APK**

Copy the verified APK to `artifacts/AL-1.0.74-yuqi-adaptive-formal-signed.apk`, generate SHA-256 evidence, and leave no build artifact on the desktop.

- [ ] **Step 7: Send exactly once to WeChat File Transfer Assistant**

Confirm the active WeChat conversation title is `文件传输助手`, attach `C:\Users\PC\Documents\Codex\New project\artifacts\AL-1.0.74-yuqi-adaptive-formal-signed.apk`, and press Send.  
Expected: the file bubble with the exact APK name is visible in that conversation.

- [ ] **Step 8: Commit release metadata and push the authorized branch**

```powershell
git add -- android/app/build.gradle artifacts/verification/AL-1.0.74-signature.txt
git commit -m "release: verify AL 1.0.74 adaptive Yuqi bridge"
git push origin codex/al-tdd
```
