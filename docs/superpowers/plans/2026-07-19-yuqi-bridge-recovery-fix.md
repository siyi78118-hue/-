# Yuqi Bridge Recovery Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make direct replies, proactive replies, and retries reliably use the Yuqi bridge while preserving whether a completed reply came from Codex or the legacy fallback.

**Architecture:** The bridge router mirrors a raw user submission only for direct user turns; automatic turns still mirror their generated replies. Native retries atomically replace the failed turn's input and snapshot before starting a new attempt. The native plugin exposes the bridge checkpoint, and the web UI stores that provenance as internal message metadata without changing the immersive bubble rendering.

**Tech Stack:** Java 21, Android Room, Capacitor, vanilla JavaScript, JUnit 4, Node contract tests, Gradle.

## Global Constraints

- Direct user turns must reject an empty canonical user message.
- Proactive and role-plan turns must not create a fake user message.
- Retry payload replacement is permitted only while a turn is retryable and has no committed reply parts.
- Fallback remains available, but its origin must be durable and recoverable without adding an AI label to the visible chat bubble.
- APK version becomes `1.0.71` with `versionCode 71` and retains the existing signing identity.

---

### Task 1: Automatic-turn bridge routing

**Files:**
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`

**Interfaces:**
- Consumes: `TurnSubmission.kind` and `TurnKind.DIRECT_REPLY`.
- Produces: `BridgeRouter.execute(TurnSubmission)` that mirrors raw input only for direct replies and always mirrors successful generated replies.

- [ ] **Step 1: Write the failing test**

Add a proactive submission using `inputJson = "{}"` and a mirror whose `persistSubmission` fails if called; assert LAN still runs and `persistReply` runs.

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew testDebugUnitTest --tests com.siyi.al.execution.bridge.BridgeRouterTest`
Expected: FAIL because `BridgeRouter.execute` calls `persistSubmission` for `PROACTIVE_CHAT`.

- [ ] **Step 3: Write minimal implementation**

Guard the submission mirror with `submission.kind == TurnKind.DIRECT_REPLY`.

- [ ] **Step 4: Run test to verify it passes**

Run the same Gradle test and expect PASS, including the existing direct-message durability assertion.

### Task 2: Repair failed turn input during retry

**Files:**
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Consumes: optional `inputJson` and `snapshotJson` supplied to Capacitor `retryTurn`.
- Produces: `startRetry(String turnId, long now, String inputJson, String snapshotJson)` that replaces payloads in the same Room transaction before activating the new attempt.

- [ ] **Step 1: Write the failing tests**

Add a Room store test that fails a turn with `{}` input, retries with a canonical user message, and asserts the stored turn contains the replacement payload. Add a JavaScript contract assertion that `retryFailedReply` rebuilds and passes both payloads.

- [ ] **Step 2: Run tests to verify they fail**

Run the focused Android/Node tests. Expected: FAIL because retry currently accepts only `turnId` and preserves the corrupt payload.

- [ ] **Step 3: Write minimal implementation**

Add a guarded Room update query, overload `startRetry`, accept optional payloads in the plugin, and rebuild the canonical payload and snapshot in the web retry path.

- [ ] **Step 4: Run tests to verify they pass**

Run the focused Android/Node tests and expect PASS.

### Task 3: Durable reply provenance

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Consumes: the JSON checkpoint stored in `ExecutionAttemptEntity.memoryResult` by `ExecutionEngine`.
- Produces: native turn result fields `origin`, `fallback`, and `attemptedRoutes`; stored chat-message fields `replyOrigin`, `replyFallback`, and `replyAttemptedRoutes`.

- [ ] **Step 1: Write the failing contract test**

Assert the plugin returns provenance from the checkpoint and the UI attaches it to native text and payment messages.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/yuqi-ui-contract.test.mjs`
Expected: FAIL because provenance is neither exposed nor stored.

- [ ] **Step 3: Write minimal implementation**

Parse only the known checkpoint fields in `turnResult`, build a shared UI metadata object, and merge it into native reply messages without rendering it.

- [ ] **Step 4: Run test to verify it passes**

Run the same Node test and expect PASS.

### Task 4: Regression verification and APK

**Files:**
- Modify: `android/app/build.gradle`

**Interfaces:**
- Produces: installable `app-debug.apk` version `1.0.71`.

- [ ] **Step 1: Update the Android version**

Set `versionCode 71` and `versionName "1.0.71"`.

- [ ] **Step 2: Run all project tests**

Run the Node test suite and Android unit tests; expect all tests to pass.

- [ ] **Step 3: Build and inspect the APK**

Run `./gradlew assembleDebug`, inspect version/signing metadata, and copy no files outside the project.

- [ ] **Step 4: Commit only relevant files**

Stage the plan, tests, implementation, and version file; commit with a scoped bug-fix message while preserving unrelated user changes.
