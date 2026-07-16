# Android Execution Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the Android-native execution path so direct replies, proactive chats, and proactive moments continue without restarting AL, use the correct cloud-job snapshot, and expose stage failures in diagnostics.

**Architecture:** Keep Room and `AlExecutionService` authoritative on Android. Make safe checkpoint states claimable during the ordinary drain loop, close the service lost-wakeup window, key proactive snapshots by `jobId`, and apply native state before foreground proactive catch-up. Add redacted native diagnostics without changing the Cloudflare singleton/KV behavior introduced by `5f555dc`.

**Tech Stack:** Java, Android SDK 24-36, Room 2.8.4, Android Foreground Service, Firebase Messaging, Capacitor 8, vanilla JavaScript, JUnit 4, Node `node:test`.

## Global Constraints

- Baseline is commit `5f555dc` and web build `2026-07-16.86`; do not revert its singleton scheduling, KV cleanup, moment dice policy, or Worker version checks.
- Android remains single-writer for model generation; do not race a WebView model call against a native Turn.
- Never auto-repeat an unknown `CHAT_RUNNING` request.
- Preserve chats, memories, API settings, device binding, existing Room rows, and automatic-task cleanup behavior.
- Never expose API keys, authorization headers, full prompts, or full private messages in diagnostics.

---

### Task 1: Resume Safe Room Checkpoints During Every Drain

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`

**Interfaces:**
- Produces: `AlExecutionDao.nextRunnableTurn()` selecting `QUEUED`, `MEMORY_DONE`, and `CHAT_DONE`.
- Produces: `RoomExecutionStore.claimNext(long now)` returning the active Attempt for the selected safe checkpoint without replacing it.

- [ ] **Step 1: Write failing engine tests for safe checkpoints**

Add tests that call `engine.runNext()` rather than `recoverInterruptedWork()`:

```java
@Test
public void ordinaryDrainResumesMemoryDoneAtChatStage() throws Exception {
    FakeStore store = new FakeStore(turn("MEMORY_DONE", null), attempt("MEMORY_DONE", null));
    store.attempt.memoryResult = "已筛选记忆";
    RecordingGateway gateway = new RecordingGateway();
    assertTrue(engine(store, gateway).runNext());
    assertEquals(Collections.singletonList("chat"), gateway.calls);
    assertEquals(TurnState.COMPLETED.name(), store.turn.state);
}

@Test
public void ordinaryDrainCommitsChatDoneWithoutCallingModel() throws Exception {
    FakeStore store = new FakeStore(turn("CHAT_DONE", "已生成"), attempt("CHAT_DONE", "已生成"));
    RecordingGateway gateway = new RecordingGateway();
    assertTrue(engine(store, gateway).runNext());
    assertEquals(0, gateway.calls.size());
    assertEquals(TurnState.COMPLETED.name(), store.turn.state);
}
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.ExecutionEngineTest --no-daemon`

Expected: both new tests fail because `claimNext()` only returns `QUEUED`.

- [ ] **Step 3: Make safe checkpoints claimable**

Replace `nextQueuedTurn()` with:

```java
@Query("SELECT * FROM chat_turns WHERE state IN ('QUEUED','MEMORY_DONE','CHAT_DONE') AND deletedAt IS NULL "
    + "ORDER BY CASE kind WHEN 'DIRECT_REPLY' THEN 0 WHEN 'PROACTIVE_CHAT' THEN 1 ELSE 2 END, createdAt ASC LIMIT 1")
ChatTurnEntity nextRunnableTurn();
```

Update `RoomExecutionStore.claimNext(long now)` to read `nextRunnableTurn()`. Create a new Attempt only for `QUEUED` rows without an active Attempt; for `MEMORY_DONE` and `CHAT_DONE`, return the existing Turn and active Attempt unchanged.

- [ ] **Step 4: Verify GREEN**

Run the focused test command again. Expected: all `ExecutionEngineTest` tests pass.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java
git commit -m "fix: resume native execution checkpoints"
```

### Task 2: Close Service Recovery and Wakeup Gaps

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/ExecutionDrainGate.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/ExecutionDrainGateTest.java`

**Interfaces:**
- Produces: `ExecutionDrainGate.request(): boolean`, `ExecutionDrainGate.finishCycle(): boolean`, and `ExecutionDrainGate.close()`.
- `request()` returns true only when the caller must start a drain; requests arriving during a drain set a pending flag.
- `finishCycle()` returns true when another drain cycle is required before sleeping.

- [ ] **Step 1: Write failing gate tests**

```java
@Test public void requestDuringDrainForcesAnotherCycle() {
    ExecutionDrainGate gate = new ExecutionDrainGate();
    assertTrue(gate.request());
    assertFalse(gate.request());
    assertTrue(gate.finishCycle());
    assertFalse(gate.finishCycle());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.ExecutionDrainGateTest --no-daemon`

Expected: compilation fails because `ExecutionDrainGate` does not exist.

- [ ] **Step 3: Implement the gate and service loop**

Use synchronized state rather than a single `AtomicBoolean`:

```java
final class ExecutionDrainGate {
    private boolean draining;
    private boolean pending;
    synchronized boolean request() {
        if (draining) { pending = true; return false; }
        draining = true;
        return true;
    }
    synchronized boolean finishCycle() {
        if (pending) { pending = false; return true; }
        draining = false;
        return false;
    }
    synchronized void close() { draining = false; pending = false; }
}
```

In `AlExecutionService.kick()`, call `engine.recoverInterruptedWork()` on every accepted drain, repeatedly drain `runNext()`, then use `finishCycle()` to decide whether to scan again. Preserve the `CHAT_RUNNING -> INTERRUPTED` rule and close the gate in `finally` on unexpected exceptions.

- [ ] **Step 4: Verify service tests GREEN**

Run all Android JVM tests. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java android/app/src/main/java/com/siyi/al/execution/ExecutionDrainGate.java android/app/src/test/java/com/siyi/al/execution/ExecutionDrainGateTest.java
git commit -m "fix: keep native execution drains live"
```

### Task 3: Bind FCM Delivery to a Job-Specific Snapshot

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java`
- Modify: `test-basic.mjs`

**Interfaces:**
- Produces: snapshot ID `${charId}:${kind}:${jobId}` for scheduled cloud jobs.
- Produces: `AlFirebaseMessagingService.snapshotId(characterId, kind, jobId)`.

- [ ] **Step 1: Write failing Java and Node tests**

```java
@Test public void cloudJobUsesJobSpecificSnapshotId() {
    assertEquals("char-1:chat:pro-123", AlFirebaseMessagingService.snapshotId("char-1", "chat", "pro-123"));
}
```

Add a Node assertion that `syncNativeProactiveSnapshot()` persists both `${charId}:${kind}` and `${charId}:${kind}:${job.jobId}` when a job ID exists.

- [ ] **Step 2: Run focused tests and verify RED**

Run the Java focused test and `node test-basic.mjs`. Expected: missing helper/job-specific save assertions fail.

- [ ] **Step 3: Implement job-specific lookup**

In Java:

```java
static String snapshotId(String characterId, String kind, String jobId) {
    return characterId + ":" + kind + ":" + jobId;
}
```

FCM must read the job-specific row first. It may read the stable alias only for legacy data and only when `matchesSnapshotJob()` succeeds. In JavaScript, save the same snapshot payload under both IDs after API configs are saved.

- [ ] **Step 4: Verify GREEN and existing cloud tests**

Run Android JVM tests and `npm test`. Expected: all pass, including the `5f555dc` singleton/KV tests.

- [ ] **Step 5: Commit**

```powershell
git add tavern-app/index.html test-basic.mjs android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java
git commit -m "fix: bind native pushes to cloud jobs"
```

### Task 4: Expose Redacted Native Diagnostics and Block Foreground Substitution

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`

**Interfaces:**
- Produces: `AlExecution.nativeDiagnostics({ limit }) -> { diagnostics: [...] }`.
- Produces: JavaScript `hasPendingDirectReply(charId)` and `nativeDiagnosticLabel(row)`.

- [ ] **Step 1: Write failing UI guards and diagnostic contract tests**

Add Node assertions:

```js
assert.equal(hasPendingDirectReply('char-pending'), true);
assert.equal(hasPendingDirectReply('char-idle'), false);
assert.match(nativeDiagnosticLabel({ type: 'CHAT_STARTED', kind: 'DIRECT_REPLY' }), /手动原生回复/);
```

Assert `triggerProactiveMessage()` returns false before model calls when `hasPendingDirectReply(charId)` is true.

- [ ] **Step 2: Verify RED**

Run: `node test-basic.mjs`

Expected: missing helper exports/assertions fail.

- [ ] **Step 3: Implement diagnostics and ordering**

Add a DAO query limited by newest diagnostic rows. Expose only timestamp, type, stage, redacted identifiers, code, and compact detail. Add diagnostic inserts at FCM receipt/rejection, Turn submission, memory/chat checkpoints, failures, and ack outcomes.

Change foreground lifecycle order to:

```js
await syncFromServiceWorkerState({ checkProactive: false });
resumePendingAssistantTurns();
await checkProactiveMessages();
```

Guard both `checkProactiveMessages()` and `triggerProactiveMessage()` against an unfinished direct reply for the same character.

- [ ] **Step 4: Verify GREEN**

Run `npm test` and Android JVM tests. Expected: PASS with no secret values in diagnostic fixtures.

- [ ] **Step 5: Commit**

```powershell
git add tavern-app/index.html test-basic.mjs android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java
git commit -m "fix: surface native execution state"
```

### Task 5: Regression, Versioning, and In-App Update Artifact

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `android-update.json`
- Modify: release/update-channel artifacts required by the existing publication scripts

**Interfaces:**
- Produces: one signed APK with a versionCode greater than every existing published build.
- Produces: matching `android-update.json` fields `latestBuild`, `version`, and `releaseUrl`.

- [ ] **Step 1: Run full regression suites**

Run: `npm test`

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest lintDebug --no-daemon`

Expected: all tests and lint pass.

- [ ] **Step 2: Build the signed release without overwriting prior artifacts**

Use the existing signing environment and a new build number. Expected: `app-release.apk` is signed by the same certificate as the installed app so coverage installation preserves data.

- [ ] **Step 3: Verify artifact identity**

Check APK package `com.siyi.al`, versionCode/versionName, signing certificate, and SHA-256. Confirm the release build includes web build later than `2026-07-16.86`.

- [ ] **Step 4: Publish through the existing update channel**

Create the new GitHub release and update `android-update.json` so the in-app checker discovers exactly that APK. Do not deploy or rewrite `cloud-timer-worker.js` unless a test proves a Worker change is required.

- [ ] **Step 5: Commit release metadata**

```powershell
git add tavern-app/index.html android-update.json
git commit -m "build: publish Android execution recovery"
```
