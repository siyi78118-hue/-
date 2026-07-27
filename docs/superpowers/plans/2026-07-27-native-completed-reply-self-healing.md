# Native Completed Reply Self-Healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every native reply that reached `COMPLETED` is eventually rendered in the WebView chat, even if its UI-inbox acknowledgement or change cursor advanced before the bubble was durably present.

**Architecture:** Keep the existing unapplied inbox as the fast path, and add a bounded recovery query that returns recent completed Room turns regardless of `uiAppliedAt`. On startup and foreground reconciliation, the WebView replays those turns idempotently using deterministic turn/part/chunk identities and treats only an exact native-turn bubble as a successful landing.

**Tech Stack:** Android Room/Capacitor Java, WebView JavaScript, Node test runner.

## Global Constraints

- Do not alter generation, notification, retry, or RP semantics.
- Recovery is bounded to the latest 50 completed turns.
- Replaying a landed result must not create duplicate bubbles.
- A bubble from another execution turn must not falsely acknowledge this turn.
- Preserve unrelated worktree changes.

---

### Task 1: Lock the recovery contract with failing tests

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: existing native UI inbox and direct-reply landing helpers.
- Produces: contract assertions for `recentCompletedTurns`, exact-turn landing, and recovery sweep invocation.

- [ ] **Step 1: Write failing contract tests**

Add assertions that the DAO and plugin expose recent completed turns independently of `uiAppliedAt`, that recovery calls the native method with `{ limit: 50 }`, and that direct-reply landing requires `sourceTurnId === native:<turnId>`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: FAIL because `recentCompletedTurns` and the recovery sweep do not exist.

### Task 2: Add the native bounded recovery API

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`

**Interfaces:**
- Produces: `List<ChatTurnEntity> recentCompletedTurns(int limit)` and Capacitor result `{ turns: [...] }`.

- [ ] **Step 1: Add a descending completed-turn query with a caller-supplied bounded limit**

The query includes all non-deleted `COMPLETED` rows and deliberately does not filter `uiAppliedAt`.

- [ ] **Step 2: Expose the query through store and plugin**

Clamp the limit to `1..50`; serialize with the existing `turnResult` function.

### Task 3: Make WebView landing exact and self-healing

**Files:**
- Modify: `tavern-app/index.html`

**Interfaces:**
- Consumes: `plugin.recentCompletedTurns({ limit: 50 })`.
- Produces: `replayRecentNativeCompletedTurns(plugin)` returning whether chat state changed.

- [ ] **Step 1: Require exact native provenance for landing**

For direct turns, accept only a message whose `sourceTurnId` equals `native:<turnId>`; do not treat any assistant reply to the same user message as this turn's landing.

- [ ] **Step 2: Add bounded chronological replay**

Fetch recent completed turns, sort oldest-first, skip exact landed turns, apply missing turns, and rely on deterministic bubble IDs to remain idempotent.

- [ ] **Step 3: Invoke recovery during reconciliation**

Run the bounded replay after the unapplied inbox so startup and foreground reconciliation can repair an already-acknowledged missing bubble.

- [ ] **Step 4: Persist and render repaired chat state**

Use the existing apply path, which persists `allChats`; foreground callers render after reconciliation.

### Task 4: Verify and publish an update build

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tests/android-unsigned-release-contract.test.mjs`

**Interfaces:**
- Produces: versionCode `101`, versionName `1.0.101`, formal update-compatible APK.

- [ ] **Step 1: Run focused tests**

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run the full suite**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 3: Bump Android release version**

Set versionCode to `101` and versionName to `1.0.101` in source, workflow, and release contract.

- [ ] **Step 4: Build and verify the formally signed APK**

Follow `docs/AL-android-signing-runbook.md`; verify package, version, signature scheme, official certificate SHA-256, and APK SHA-256 before delivery.
