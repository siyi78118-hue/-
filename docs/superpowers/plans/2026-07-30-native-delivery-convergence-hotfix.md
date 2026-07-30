# AL 1.0.107 Native Delivery Convergence Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make native completion, notification display, WebView application, and cloud confirmation independently durable and observable, then ship formal OTA-capable AL 1.0.107.

**Architecture:** Extend the existing Room turn row with two missing stage timestamps, keep completed/unapplied/recent queries as the recovery authority, and make all Web wake sources share a bounded single-flight reconciler. Publish one signed APK and one matching update manifest.

**Tech Stack:** Android Room/Java, Capacitor, WebView JavaScript, Node test runner, GitHub Actions/REST.

## Global Constraints

- Preserve existing RP, payment, role-plan, moments, notification, retry, and cloud routing semantics.
- Never record `uiAppliedAt` until the exact turn landing exists.
- A timeout releases Web locks but never deletes or acknowledges a Room result.
- Version target is exactly `1.0.107 (107)`.
- Official signer SHA-256 remains `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.

---

### Task 1: Red tests for durable delivery stages

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

- [ ] Add failing assertions for Room v10, `notificationShownAt`, `cloudConfirmedAt`, four-stage plugin output, and UI diagnostic labels.
- [ ] Add failing behavior tests for notification-before-WebView and UI ack after landing.
- [ ] Run focused Node tests and Android instrumentation compilation; confirm failures are caused by missing fields/API.

### Task 2: Red tests for six recovery races

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

- [ ] Add a hanging reconcile test that times out and allows a second call.
- [ ] Add event-lost polling recovery, reload recent replay, event/poll concurrency, and duplicate-delivery tests.
- [ ] Confirm each test fails before implementation.

### Task 3: Persist and expose four delivery stages

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/BridgeReceiptCheckpoint.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`

- [ ] Add Room migration 9→10 for nullable notification/cloud timestamps.
- [ ] Mark notification only after `notify()` succeeds; mark cloud confirmation only after receipt succeeds.
- [ ] Serialize four stages and `cloudConfirmationRequired` in `turnResult()` and `nativeDiagnostics()`.
- [ ] Run Android store/unit tests to green.

### Task 4: Bound and unify Web reconciliation

**Files:**
- Modify: `tavern-app/index.html`

- [ ] Give the global reconcile and per-turn apply locks hard timeouts with unconditional `finally` cleanup.
- [ ] Route `executionCompleted` through the same reconciler as polling.
- [ ] Keep the unapplied inbox plus recent completed replay; do not advance ack/cursor on failure.
- [ ] Render the four delivery stages separately.
- [ ] Run focused Node tests to green.

### Task 5: Version, cache, and OTA contracts

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`
- Modify: `android-update.json`
- Modify: `tests/android-unsigned-release-contract.test.mjs`
- Modify: `test-basic.mjs`

- [ ] Set Android version to `107 / 1.0.107`.
- [ ] Set Web build to `2026-07-30.107` and cache to `rpchat-v98`.
- [ ] Set the checked-in update manifest to build 107 and the `android-v107` formal asset.
- [ ] Run release-contract tests to green.

### Task 6: Full verification and formal publication

- [ ] Run `npm.cmd test`.
- [ ] Run Android unit tests and instrumentation APK compilation.
- [ ] Commit only hotfix files, push `codex/al-tdd`, and trigger the fixed signing workflow.
- [ ] Download and verify package/version/signature/certificate/SHA-256.
- [ ] Publish GitHub release `android-v107` and matching `update-channel/android-update.json`.
- [ ] Verify both raw manifest endpoints resolve to build 107 before delivery.

