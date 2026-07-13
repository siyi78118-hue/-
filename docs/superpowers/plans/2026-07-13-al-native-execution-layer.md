# AL Native Execution Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AL's WebView/Background Runner reply pipeline with a native, persistent Android executor that survives normal backgrounding and keeps reply state consistent.

**Architecture:** Room 2.8.4 stores turns, attempts, reply parts, memory records, task snapshots, and diagnostics as the single source of truth. A sticky `specialUse` foreground service owns memory and chat API execution; a Capacitor plugin submits commands and streams lightweight state changes to the WebView. WorkManager, FCM, and boot recovery only wake the same executor and never run a second generation pipeline.

**Tech Stack:** Java, Android SDK 24-36, Room 2.8.4, Android Foreground Service, WorkManager 2.11.0, Firebase Messaging 25.0.1, Capacitor 8.4.1, `HttpURLConnection`, `org.json`, JUnit 4, Node `node:test`.

## Global Constraints

- Every send tap creates exactly one independent `turnId`; consecutive player messages are not merged.
- Every retry keeps the original `turnId` and user bubble but creates a fresh `attemptId`.
- Room is authoritative for task and reply state; WebView caches cannot mark a turn failed.
- Every direct chat call contains the complete RP rules, current staged persona, exactly the latest 30 eligible messages, and memory-AI-selected local memory.
- API keys, prompt snapshots, and local memory remain on device and are excluded from chat-only backups and diagnostics.
- Direct and proactive replies are non-streaming.
- Lock screen, Home, app switching, recent-task swipe, ordinary process reclamation, and reboot are supported; Android Settings "Force stop" is excluded.
- New production behavior is written test-first and each RED failure is observed before implementation.
- Existing unrelated worktree changes are never staged or reverted.

---

### Task 1: Native Turn Domain and Legal State Transitions

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/TurnState.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/TurnKind.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AttemptStage.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/TurnStateMachine.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/TurnStateMachineTest.java`

**Interfaces:**
- Produces: `TurnStateMachine.requireTransition(TurnState from, TurnState to)`, `TurnStateMachine.deriveDisplayState(boolean hasReply, TurnState stored)`.
- Consumes: no Android framework classes, allowing fast JVM tests.

- [ ] **Step 1: Write the failing transition tests**

```java
@Test public void committedReplyAlwaysDisplaysCompleted() {
    assertEquals(TurnState.COMPLETED,
        TurnStateMachine.deriveDisplayState(true, TurnState.FAILED_RETRYABLE));
}

@Test public void staleAttemptCannotMoveCompletedTurnBackToFailed() {
    assertThrows(IllegalStateException.class, () ->
        TurnStateMachine.requireTransition(TurnState.COMPLETED, TurnState.FAILED_RETRYABLE));
}

@Test public void normalPipelineTransitionsAreLegal() {
    TurnStateMachine.requireTransition(TurnState.QUEUED, TurnState.MEMORY_RUNNING);
    TurnStateMachine.requireTransition(TurnState.MEMORY_RUNNING, TurnState.MEMORY_DONE);
    TurnStateMachine.requireTransition(TurnState.MEMORY_DONE, TurnState.CHAT_RUNNING);
    TurnStateMachine.requireTransition(TurnState.CHAT_RUNNING, TurnState.CHAT_DONE);
    TurnStateMachine.requireTransition(TurnState.CHAT_DONE, TurnState.COMMITTED);
    TurnStateMachine.requireTransition(TurnState.COMMITTED, TurnState.NOTIFIED);
    TurnStateMachine.requireTransition(TurnState.NOTIFIED, TurnState.COMPLETED);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.TurnStateMachineTest" --no-daemon`

Expected: compilation fails because the domain classes do not exist.

- [ ] **Step 3: Implement the minimal state machine**

```java
public final class TurnStateMachine {
    private static final EnumMap<TurnState, EnumSet<TurnState>> LEGAL = new EnumMap<>(TurnState.class);
    static {
        LEGAL.put(TurnState.QUEUED, EnumSet.of(TurnState.MEMORY_RUNNING, TurnState.CANCELLED));
        LEGAL.put(TurnState.MEMORY_RUNNING, EnumSet.of(TurnState.MEMORY_DONE, TurnState.FAILED_RETRYABLE, TurnState.FAILED_FINAL, TurnState.CANCELLED));
        LEGAL.put(TurnState.MEMORY_DONE, EnumSet.of(TurnState.CHAT_RUNNING, TurnState.CANCELLED));
        LEGAL.put(TurnState.CHAT_RUNNING, EnumSet.of(TurnState.CHAT_DONE, TurnState.INTERRUPTED, TurnState.FAILED_RETRYABLE, TurnState.FAILED_FINAL, TurnState.CANCELLED));
        LEGAL.put(TurnState.CHAT_DONE, EnumSet.of(TurnState.COMMITTED, TurnState.FAILED_FINAL, TurnState.CANCELLED));
        LEGAL.put(TurnState.COMMITTED, EnumSet.of(TurnState.NOTIFIED, TurnState.COMPLETED));
        LEGAL.put(TurnState.NOTIFIED, EnumSet.of(TurnState.COMPLETED));
        LEGAL.put(TurnState.FAILED_RETRYABLE, EnumSet.of(TurnState.QUEUED, TurnState.CANCELLED));
        LEGAL.put(TurnState.INTERRUPTED, EnumSet.of(TurnState.QUEUED, TurnState.CANCELLED));
    }

    public static void requireTransition(TurnState from, TurnState to) {
        EnumSet<TurnState> allowed = LEGAL.get(from);
        if (allowed == null || !allowed.contains(to)) {
            throw new IllegalStateException("Illegal turn transition: " + from + " -> " + to);
        }
    }

    public static TurnState deriveDisplayState(boolean hasReply, TurnState stored) {
        return hasReply ? TurnState.COMPLETED : stored;
    }
}
```

- [ ] **Step 4: Run the focused and complete JVM tests**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --no-daemon`

Expected: all JVM tests pass.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution android/app/src/test/java/com/siyi/al/execution
git commit -m "feat: define native reply state machine"
```

### Task 2: Room Schema and Atomic Repository

**Files:**
- Modify: `android/variables.gradle`
- Modify: `android/app/build.gradle`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/ExecutionAttemptEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/ReplyPartEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/MemoryRecordEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/CharacterSnapshotEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/DiagnosticEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Create: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Produces: `submitTurn(TurnSubmission)`, `startRetry(String turnId)`, `claimNext()`, `saveMemoryResult(...)`, `saveRawReply(...)`, `commitReply(...)`, `cancelTurn(...)`, and `observeChangedSince(long cursor)`.
- Enforces: unique `sourceMessageId`, unique `(turnId, sequence)` reply parts, one active attempt per turn, and transactional result commit.

- [ ] **Step 1: Add Room dependencies and failing repository tests**

Add `roomVersion = '2.8.4'` to `android/variables.gradle` and:

```groovy
implementation "androidx.room:room-runtime:$roomVersion"
annotationProcessor "androidx.room:room-compiler:$roomVersion"
androidTestImplementation "androidx.room:room-testing:$roomVersion"
```

Test these exact invariants:

```java
@Test public void commitReplyClearsFailureAtomically() {
    store.submitTurn(Fixtures.directTurn("turn-1", "msg-1"));
    String attemptId = store.activeAttempt("turn-1").attemptId;
    store.markFailed("turn-1", attemptId, "timeout", true);
    String retryId = store.startRetry("turn-1").attemptId;
    store.commitReply("turn-1", retryId, List.of(Fixtures.textPart("turn-1", retryId, 0, "收到")));
    assertEquals(TurnState.COMPLETED, store.displayState("turn-1"));
    assertEquals(1, store.replyParts("turn-1").size());
}

@Test public void lateOldAttemptCannotCommit() {
    store.submitTurn(Fixtures.directTurn("turn-2", "msg-2"));
    String oldAttempt = store.activeAttempt("turn-2").attemptId;
    String newAttempt = store.startRetry("turn-2").attemptId;
    assertThrows(StaleAttemptException.class, () ->
        store.commitReply("turn-2", oldAttempt, List.of(Fixtures.textPart("turn-2", oldAttempt, 0, "旧回复"))));
    store.commitReply("turn-2", newAttempt, List.of(Fixtures.textPart("turn-2", newAttempt, 0, "新回复")));
}
```

- [ ] **Step 2: Run the instrumentation test and verify RED**

Run: `Set-Location android; .\gradlew.bat connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.siyi.al.execution.RoomExecutionStoreTest --no-daemon`

Expected: compilation fails because the schema and repository are absent. If no device is connected, first run `assembleDebugAndroidTest` to verify RED compilation and retain the test for CI/emulator execution.

- [ ] **Step 3: Implement schema version 1 and transactions**

Use these primary keys and indexes:

```java
@Entity(tableName = "chat_turns", indices = {
    @Index(value = {"sourceMessageId"}, unique = true),
    @Index(value = {"state", "createdAt"})
})
public final class ChatTurnEntity {
    @PrimaryKey @NonNull public String turnId;
    @NonNull public String characterId;
    @NonNull public String sourceMessageId;
    @NonNull public String kind;
    @NonNull public String state;
    public String activeAttemptId;
    @NonNull public String inputJson;
    @NonNull public String snapshotJson;
    public long createdAt;
    public long updatedAt;
    public Long completedAt;
    public Long cancelledAt;
    public Long deletedAt;
}
```

`commitReply` must verify `activeAttemptId`, insert all parts with `OnConflictStrategy.ABORT`, update the turn to `COMPLETED`, and finish the attempt inside one `@Transaction` method.

- [ ] **Step 4: Verify Room schema and tests GREEN**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest assembleDebug assembleDebugAndroidTest --no-daemon`

Expected: Room schema generation and all available tests pass.

- [ ] **Step 5: Commit**

```powershell
git add android/variables.gradle android/app/build.gradle android/app/src/main/java/com/siyi/al/execution android/app/src/androidTest/java/com/siyi/al/execution
git commit -m "feat: persist AL turns in Room"
```

### Task 3: Encrypted Configuration, API Client, and Reply Parser

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/secure/AlSecretStore.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/api/ApiConfig.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/api/HttpTransport.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/api/UrlConnectionTransport.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/api/OpenAiCompatibleClient.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/api/OpenAiCompatibleClientTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java`

**Interfaces:**
- Produces: `call(ApiConfig config, String system, JSONArray messages, int maxTokens)`, `parse(String raw, String turnId, String attemptId)`.
- Consumes: injectable `HttpTransport`, allowing tests without network.

- [ ] **Step 1: Write failing parser and client tests**

```java
@Test public void parsesEmojiAndPaymentWithoutLeakingDirective() {
    ParsedReply parsed = parser.parse("晚安🙂\n<al_send_payment>{\"type\":\"redpacket\",\"amount\":8.8,\"note\":\"早餐\"}</al_send_payment>", "t1", "a1");
    assertEquals("晚安🙂", parsed.parts.get(0).content);
    assertEquals("REDPACKET", parsed.parts.get(1).type);
    assertFalse(parsed.parts.get(0).content.contains("al_send_payment"));
}

@Test public void rejectsHtmlLoginPageAsApiResponse() {
    transport.reply(200, "text/html", "<!DOCTYPE html><html>login</html>");
    ApiProtocolException error = assertThrows(ApiProtocolException.class, () -> client.call(config, "sys", new JSONArray(), 1000));
    assertEquals("HTML_RESPONSE", error.code());
}

@Test public void readsUnicodeEmojiFromOpenAiContent() {
    transport.reply(200, "application/json", "{\"choices\":[{\"message\":{\"content\":\"好呀😊\"}}]}");
    assertEquals("好呀😊", client.call(config, "sys", new JSONArray(), 1000));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.api.*" --no-daemon`

Expected: missing classes cause compilation failure.

- [ ] **Step 3: Implement deterministic non-stream client**

`UrlConnectionTransport` must set connect and read timeouts to 120000 ms, UTF-8 encode JSON, reject non-JSON content types before parsing, and never log `Authorization`. `OpenAiCompatibleClient` must support `/v1/chat/completions`, normalize a base URL once, send `stream:false`, and parse `choices[0].message.content` plus compatible content arrays.

`AlSecretStore` must encrypt values with an Android Keystore AES/GCM key alias `al.execution.secrets.v1`; only opaque config IDs are stored in Room.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --no-daemon`

Expected: API and parser tests pass, including Chinese and Emoji.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/api android/app/src/main/java/com/siyi/al/execution/secure android/app/src/test/java/com/siyi/al/execution/api
git commit -m "feat: add native model client and reply parser"
```

### Task 4: Execution Engine with Memory-First Pipeline

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/RetryPolicy.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/ExecutionDependencies.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`

**Interfaces:**
- Produces: `runNext()`, `recoverInterruptedWork()`, `retry(String turnId)`, `cancel(String turnId)`.
- Consumes: `ExecutionStore`, memory and chat `OpenAiCompatibleClient` instances, `ReplyParser`, clock, sleeper, and notifier interfaces.

- [ ] **Step 1: Write failing pipeline and crash-boundary tests**

```java
@Test public void directReplyRunsMemoryBeforeChatAndCommitsOnce() {
    engine.runNext();
    assertEquals(List.of("memory", "chat", "commit"), events);
    assertEquals(TurnState.COMPLETED, store.displayState("turn-1"));
}

@Test public void storedChatDoneResultResumesWithoutCallingModelAgain() {
    store.seedChatDone("turn-2", "attempt-2", "已经生成");
    engine.recoverInterruptedWork();
    assertEquals(0, chatClient.calls());
    assertEquals("已经生成", store.replyParts("turn-2").get(0).content);
}

@Test public void processDeathDuringUnknownChatCallBecomesInterrupted() {
    store.seedStage("turn-3", "attempt-3", TurnState.CHAT_RUNNING);
    engine.recoverInterruptedWork();
    assertEquals(TurnState.INTERRUPTED, store.turn("turn-3").state());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.ExecutionEngineTest" --no-daemon`

Expected: missing engine classes.

- [ ] **Step 3: Implement the serial priority executor**

Claim order must be `DIRECT_REPLY`, then `PROACTIVE_CHAT`, then `PROACTIVE_MOMENT`, ordered by `createdAt`. Persist a heartbeat and stage before each external call. Persist raw chat output and `CHAT_DONE` in one transaction before parsing.

Implement exact retries: DNS/connect failures at 15/60/300 seconds; 429 at 30/120 seconds; one 30-second retry for empty 502/503/504; no automatic retry for 401/403, HTML, empty model content, read timeout after request write, or unknown process death.

- [ ] **Step 4: Verify stale attempt and cancellation tests GREEN**

Add tests proving late old attempts, cancelled turns, and deleted source messages cannot commit. Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --no-daemon`.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution android/app/src/test/java/com/siyi/al/execution
git commit -m "feat: execute durable native AI turns"
```

### Task 5: Sticky Foreground Service, Wake Paths, and Notifications

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlBootReceiver.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlNotificationFactory.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/ForegroundServiceContractTest.java`
- Modify: `test-basic.mjs`

**Interfaces:**
- Produces: `AlExecutionService.requestRun(Context)`, sticky service lifecycle, boot rescheduling, and notification channels `al_guard` and `al_messages`.
- Consumes: `ExecutionEngine.runNext()` until no runnable task remains.

- [ ] **Step 1: Add failing manifest and service contract tests**

Assert Manifest contains:

```xml
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SPECIAL_USE" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

and `AlExecutionService` with `android:foregroundServiceType="specialUse"`, the subtype property, plus `AlBootReceiver` for `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.

The JVM contract test must assert `onStartCommand` returns `START_STICKY` through an extracted pure lifecycle policy.

- [ ] **Step 2: Run structural and JVM tests to verify RED**

Run: `node test-basic.mjs; Set-Location android; .\gradlew.bat testDebugUnitTest --no-daemon`

Expected: service and Manifest assertions fail.

- [ ] **Step 3: Implement foreground execution**

Create the low-importance ongoing notification text `AL 后台守护已开启`. The service starts foreground immediately, executes the engine on a single-thread executor, acquires a partial WakeLock only while `runNext()` is active, and releases it in `finally`.

`requestRun` first attempts `ContextCompat.startForegroundService`. Catch `RuntimeException`; on API 31+ use an `@RequiresApi(31)` helper to identify `ForegroundServiceStartNotAllowedException`, then enqueue unique `AlExecutionWakeWorker` work named `al-execution-wake` with `APPEND_OR_REPLACE`; rethrow every other runtime exception.

- [ ] **Step 4: Run tests and build**

Run: `node test-basic.mjs; Set-Location android; .\gradlew.bat testDebugUnitTest assembleDebug --no-daemon`

Expected: all tests pass and debug APK builds.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/siyi/al/execution android/app/src/test/java/com/siyi/al/execution test-basic.mjs
git commit -m "feat: keep AL execution service alive"
```

### Task 6: Capacitor Native Bridge and Command Idempotency

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/MainActivity.java`
- Modify: `test-basic.mjs`
- Create: `android/app/src/test/java/com/siyi/al/execution/ExecutionCommandTest.java`

**Interfaces:**
- Produces plugin methods: `submitTurn`, `retryTurn`, `cancelTurn`, `deleteMessage`, `queryChanges`, `saveSecrets`, `getDiagnostics`, `setGuardEnabled`, `importLegacyBatch`.
- Emits: `executionChanged` with only `cursor`, `turnId`, `state`, and changed reply part IDs.

- [ ] **Step 1: Write failing command tests**

```java
@Test public void duplicateSubmitReturnsExistingTurnWithoutNewAttempt() {
    plugin.submitTurn(submission("turn-1", "msg-1"));
    plugin.submitTurn(submission("turn-1", "msg-1"));
    assertEquals(1, store.attempts("turn-1").size());
}

@Test public void retryAlwaysCreatesFreshAttempt() {
    plugin.submitTurn(submission("turn-2", "msg-2"));
    store.markFailedActive("turn-2");
    String first = store.activeAttempt("turn-2").attemptId;
    String second = plugin.retryTurn("turn-2").attemptId;
    assertNotEquals(first, second);
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.ExecutionCommandTest" --no-daemon`

Expected: plugin command facade is absent.

- [ ] **Step 3: Implement plugin methods and register plugin**

Every mutating method must await its Room transaction before resolving. `retryTurn` must never call the old `AlReplyQueuePlugin`. `queryChanges(cursor)` returns deterministic JSON sorted by database change cursor.

- [ ] **Step 4: Run tests and commit**

Run: `node test-basic.mjs; Set-Location android; .\gradlew.bat testDebugUnitTest assembleDebug --no-daemon`

```powershell
git add android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/MainActivity.java android/app/src/test/java/com/siyi/al/execution/ExecutionCommandTest.java test-basic.mjs
git commit -m "feat: expose native AL execution bridge"
```

### Task 7: WebView Cutover for Send, Retry, Reconciliation, and Delete

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Produces JS methods: `nativeExecutionPlugin()`, `submitNativeTurn(...)`, `applyExecutionChanges(...)`, `retryNativeTurn(...)`, `cancelNativeTurn(...)`.
- Removes Android send dependence on `queueAndroidUserReply`, `pendingReply`, `nativeReplyQueuedIds`, Background Runner state polling, and frontend stale-timeout inference.

- [ ] **Step 1: Add failing frontend behavior tests**

Test with extracted functions that:

```javascript
const completed = deriveTurnView({ state: 'FAILED_RETRYABLE' }, [{ type: 'TEXT', content: '已经回复' }]);
assert.equal(completed.state, 'COMPLETED');

const retried = await retryNativeTurnProbe('turn-a');
assert.equal(retried.userBubbleCountBefore, retried.userBubbleCountAfter);
assert.notEqual(retried.oldAttemptId, retried.newAttemptId);
```

Also assert Android `sendMessage()` calls `AlExecution.submitTurn` and does not call `callAPI`, `AlReplyQueue.enqueue`, or `BackgroundRunner.dispatchEvent`.

- [ ] **Step 2: Run and verify RED**

Run: `node test-basic.mjs`

Expected: Android still uses the legacy reply queue.

- [ ] **Step 3: Implement Room-backed rendering cache**

On send, build the exact 30-message snapshot and complete RP/persona system prompt, call `submitTurn`, then render the accepted turn. Subscribe once to `executionChanged`; on resume call `queryChanges(lastCursor)`. Merge by `turnId` and `replyPartId`, never by timestamp.

Replace failure labels with derived native state. A committed reply must clear `未收到回复` even if a stale cache still contains `replyState:'failed'`.

- [ ] **Step 4: Route retry, withdraw, and delete through native commands**

Retry waits for the returned Attempt before showing running state. Withdraw calls `cancelTurn`; delete calls `deleteMessage`. Browser-only fallback keeps the existing local path.

- [ ] **Step 5: Run Node and Android tests GREEN**

Run: `npm.cmd test; Set-Location android; .\gradlew.bat testDebugUnitTest assembleDebug --no-daemon`

- [ ] **Step 6: Commit**

```powershell
git add test-basic.mjs tavern-app/index.html
git commit -m "feat: render native AL turn state"
```

### Task 8: FCM Proactive Chat and Moments Through the Same Executor

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Modify: `tests/cloud-timer-worker.test.mjs`
- Modify: `test-basic.mjs`

**Interfaces:**
- FCM data payloads create `PROACTIVE_CHAT` or `PROACTIVE_MOMENT` turns keyed by Cloudflare `jobId`.
- Existing cloud ACK and next-schedule requests become post-commit side effects and cannot roll back generated content.

- [ ] **Step 1: Add failing independent-lane tests**

```java
@Test public void chatAndMomentWithSameCharacterBothSurvive() {
    fcm.accept(payload("job-chat", "chat", "char-1"));
    fcm.accept(payload("job-moment", "moment", "char-1"));
    assertEquals(2, store.pendingTurns("char-1").size());
}

@Test public void scheduleFailureDoesNotFailCommittedMessage() {
    store.seedProactive("job-1");
    scheduleClient.fail();
    engine.runNext();
    assertEquals(TurnState.COMPLETED, store.turnByCloudJob("job-1").state());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.ExecutionEngineTest" --no-daemon; Set-Location ..; node --test tests/cloud-timer-worker.test.mjs`

- [ ] **Step 3: Replace RunnerWorker FCM path**

`onMessageReceived` must transactionally insert a Turn by unique `cloudJobId`, then call `AlExecutionService.requestRun`. Remove `pending_push_queue`, `RunnerWorker`, `state_json`, and `APPEND_OR_REPLACE` generation from this service.

- [ ] **Step 4: Verify duplicate FCM and ACK behavior**

Run all focused tests and confirm duplicate `jobId` produces one Turn, while private chat and moment jobs remain independent.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java android/app/src/main/java/com/siyi/al/execution tests/cloud-timer-worker.test.mjs test-basic.mjs
git commit -m "feat: execute proactive jobs natively"
```

### Task 9: Idempotent Legacy Migration and Secret Cutover

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/migration/LegacyImportService.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/migration/LegacyImportServiceTest.java`
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Produces: batched schema-v1 import with `migrationId`, `batchId`, and source row IDs.
- Converts existing answered failures to completed and unresolved `pendingReply` to `INTERRUPTED` without model calls.

- [ ] **Step 1: Write failing migration tests**

```java
@Test public void answeredLegacyFailureImportsCompleted() {
    importer.importBatch(Fixtures.legacyAnsweredFailure());
    assertEquals(TurnState.COMPLETED, store.turn("legacy-msg-1").state());
}

@Test public void repeatedBatchDoesNotDuplicateMessagesOrMemory() {
    LegacyBatch batch = Fixtures.legacyBatch("batch-1");
    importer.importBatch(batch);
    importer.importBatch(batch);
    assertEquals(1, store.replyParts("legacy-turn-1").size());
    assertEquals(1, store.memoryBySource("legacy-memory-1").size());
}
```

- [ ] **Step 2: Run and verify RED**

Run: `Set-Location android; .\gradlew.bat testDebugUnitTest --tests "com.siyi.al.execution.migration.LegacyImportServiceTest" --no-daemon`

- [ ] **Step 3: Implement resumable batches**

Import characters, chats, moments, settings, summaries, events, profiles, vectors, and memory cursors in batches capped at 200 rows or 512 KiB. Store a committed batch ID before acknowledging it. Preserve legacy localStorage/IndexedDB read-only until counts and hashes match.

Move chat and memory API keys into `AlSecretStore`; erase only the migrated plaintext key fields after native readback confirms equality.

- [ ] **Step 4: Add frontend migration bootstrap and verify GREEN**

The WebView sends batches on first native launch, resumes from the native cursor after crash, and sets `al_native_execution_schema=1` only after native completion. Run `npm.cmd test` and Android JVM tests.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/migration android/app/src/test/java/com/siyi/al/execution/migration test-basic.mjs tavern-app/index.html
git commit -m "feat: migrate AL data to native execution"
```

### Task 10: WebView Crash Recovery and Local Diagnostics

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/AlBridgeWebViewClient.java`
- Create: `android/app/src/main/java/com/siyi/al/AlCrashRecorder.java`
- Modify: `android/app/src/main/java/com/siyi/al/MainActivity.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ForegroundServiceContractTest.java`
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Produces: renderer crash recording, controlled Activity recreation, redacted diagnostics, and incremental chat rendering.
- Guarantees: chat failures never launch update URLs or downloads.

- [ ] **Step 1: Add failing crash and redaction tests**

```java
@Test public void diagnosticRedactionRemovesAuthorizationAndApiKeys() {
    String redacted = AlCrashRecorder.redact("Authorization: Bearer secret apiKey=abc123");
    assertFalse(redacted.contains("secret"));
    assertFalse(redacted.contains("abc123"));
}
```

Node assertions must prove model/reconciliation failures cannot call `openUpdateUrl`, and reply change events update only the matching turn container rather than call full `renderMessages()`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node test-basic.mjs; Set-Location android; .\gradlew.bat testDebugUnitTest --no-daemon`

- [ ] **Step 3: Implement renderer recovery and diagnostics**

Override `onRenderProcessGone` through a Capacitor-compatible WebView client, record `didCrash`, renderer priority, current Activity state, and current native task stages, then recreate the Activity once. Three crashes attributable to one Attempt mark it `FAILED_FINAL`.

Register a chained uncaught-exception handler that writes a bounded 64 KiB redacted diagnostic record before delegating to the prior handler.

- [ ] **Step 4: Implement incremental UI updates**

Use `data-turn-id` and `data-reply-part-id` containers. `applyExecutionChanges` modifies only affected nodes and scrolls only when the user is already near the bottom. Remove full rerender calls from native reply polling and response arrival.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd test
Set-Location android
.\gradlew.bat testDebugUnitTest assembleDebug --no-daemon
```

```powershell
git add android/app/src/main/java/com/siyi/al/AlBridgeWebViewClient.java android/app/src/main/java/com/siyi/al/AlCrashRecorder.java android/app/src/main/java/com/siyi/al/MainActivity.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/test/java/com/siyi/al/execution/ForegroundServiceContractTest.java test-basic.mjs tavern-app/index.html
git commit -m "fix: recover AL WebView without duplicate replies"
```

### Task 11: Remove Legacy Generation and Run the Full Release Gate

**Files:**
- Modify: `capacitor.config.json`
- Delete: `android/app/src/main/java/com/siyi/al/AlReplyQueuePlugin.java`
- Delete: `tavern-app/runners/al-background.js`
- Modify: `android/app/src/main/java/com/siyi/al/MainActivity.java`
- Delete: `tests/background-runner.test.mjs`
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`
- Modify: `package.json`

**Interfaces:**
- Leaves one production generation path: `AlExecutionService -> ExecutionEngine -> Room`.
- Browser fallback remains WebView-only and is excluded from Android native execution tests.

- [ ] **Step 1: Add a failing single-executor structural test**

Assert Android production files contain no `RunnerWorker`, `AlReplyQueue`, `pending_user_reply_queue`, `state_json`, `nativeReplyQueuedIds`, or `NATIVE_REPLY_STALE_MS`; assert `BackgroundRunner` is absent from `capacitor.config.json`.

- [ ] **Step 2: Run and verify RED**

Run: `node test-basic.mjs`

Expected: legacy symbols still exist.

- [ ] **Step 3: Remove legacy Android generation path**

Delete only the obsolete Android Background Runner reply/proactive execution and its tests. Keep browser fallback helpers and unrelated app behavior. Remove `@capacitor/background-runner` only after `rg` proves no production references remain.

- [ ] **Step 4: Run complete automated checks**

```powershell
npm.cmd install
npm.cmd test
node --test tests/api-endpoint.test.mjs
node --test tests/cloud-timer-worker.test.mjs
node --check cloud-timer-worker.js
npm.cmd run android:sync
Set-Location android
.\gradlew.bat testDebugUnitTest assembleDebug assembleRelease --no-daemon
```

Expected: all tests pass; debug and release APKs build; no legacy executor references remain.

- [ ] **Step 5: Run Android instrumentation tests on an emulator or connected test device**

Run: `Set-Location android; .\gradlew.bat connectedDebugAndroidTest --no-daemon`

Expected: Room atomicity and migration tests pass.

- [ ] **Step 6: Execute the real-device acceptance matrix**

Verify: immediate lock, Home, app switch, recent-task swipe, Activity kill after commit, process kill during memory, reboot recovery, duplicate FCM, independent chat/moment jobs, immediate retry, old answered-failure migration, Emoji/payment parsing, and no update-page launch on chat failure.

- [ ] **Step 7: Final review**

Run: `git diff origin/main...HEAD --check` and inspect only AL-related files. Export local diagnostics from one successful and one intentionally failed task and verify secrets are absent.

- [ ] **Step 8: Commit the cutover**

```powershell
git add capacitor.config.json android/app/src/main/java/com/siyi/al tavern-app package.json package-lock.json test-basic.mjs tests
git commit -m "feat: cut over AL to native execution"
```

### Task 12: Publish an Updateable APK After All Gates Pass

**Files:**
- Modify: `.github/workflows/android-apk.yml`
- Review after publish: `android-update.json` on branch `update-channel`

**Interfaces:**
- Produces: one signed release APK compatible with the existing update checker and signing identity.

- [ ] **Step 1: Add the native test gate to the existing workflow**

Before `assembleRelease`, run `./gradlew testDebugUnitTest --no-daemon`. Keep the existing version source unchanged: `AL_VERSION_CODE=${{ github.run_number }}` and `AL_VERSION_NAME=1.0.${{ github.run_number }}`. Do not edit the stale local `android-update.json`; the workflow writes the authoritative manifest to the `update-channel` branch. Do not change signing secrets or application ID `com.siyi.al`.

- [ ] **Step 2: Push the implementation branch and inspect CI**

Run:

```powershell
git push origin codex/al-tdd
& 'C:\Users\Administrator\Tools\bin\gh.exe' run list --repo siyi78118-hue/- --limit 5
```

Expected: test and signed APK workflows succeed.

- [ ] **Step 3: Merge/push main and publish the release**

Use the repository's existing signed release workflow. Verify the release and compatibility APKs install over the current signed app and the in-app update manifest returns the new version without authentication errors.

- [ ] **Step 4: Record manual phone results**

Record app version, Android version, battery policy, VPN state, exact background action, notification time, reply time, and final Turn state for every acceptance scenario.
