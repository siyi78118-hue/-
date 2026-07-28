# Current User Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development and execute this plan
> task-by-task in the current primary task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one user "发送完成" action an authoritative ordered batch across the complete
Android-to-Codex pipeline and deliver a formally signed installable APK.

**Architecture:** The web UI serializes every committed bubble into the Android task. Protocol-v2
validates and preserves a self-contained batch, SQLite stores batch identity separately from raw
message identity, and a single resolver supplies routing, timing, memory, brain, and supervisor.
Legacy single-message and ID-only inputs remain compatible.

**Tech Stack:** HTML/JavaScript Capacitor client, Java Android bridge, Node.js ESM runtime,
node:test, SQLite, JUnit/Gradle, GitHub Actions fixed-certificate signing.

## Global Constraints

- Preserve independent visible chat bubbles and the existing explicit "发送完成" interaction.
- Do not rewrite existing message rows or checksums.
- Do not introduce a fallback actor or non-Codex reply generator.
- Run failing tests before each production change.
- Preserve unrelated dirty-worktree files.
- A formal APK must use package `com.siyi.al` and certificate SHA-256
  `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.

---

### Task 1: Protocol and CurrentUserBatch resolver

**Files:**
- Create: `yuqi-runtime/src/current-user-batch.mjs`
- Create: `yuqi-runtime/test/current-user-batch.test.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Produces: `resolveCurrentUserBatch(envelope, availableMessages)` returning batch identity,
  ordered messages, combined text, completeness, and missing IDs.
- Produces: validated `envelope.context.currentBatch`.

- [ ] **Step 1: Write failing protocol tests**

Add tests proving a self-contained two-bubble batch survives normalization and malformed batches
with duplicate IDs, mismatched final messages, invalid timing, or excessive payload are rejected.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: the preserved-batch assertion fails because `validateDirectContext` currently drops
`currentBatch`.

- [ ] **Step 3: Write failing resolver tests**

Cover self-contained batches, old ID-only batches resolved from stored messages, synthetic
single-message legacy batches, and incomplete ID-only batches.

- [ ] **Step 4: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/current-user-batch.test.mjs`

Expected: module-not-found or missing-export failure.

- [ ] **Step 5: Implement validation and resolver**

Validate known fields only, cap batch count and total text, enforce ordered unique IDs and a final
item matching `envelope.message`, and expose the resolver described above.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/current-user-batch.test.mjs`

Expected: PASS.

### Task 2: Durable batch persistence

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Produces: `YuqiStore.getCurrentUserBatch(turnId)`.
- Produces: `batchId` and `batchSequence` on `listMessages()` results where known.

- [ ] **Step 1: Write failing persistence tests**

Assert ordered batch rows survive store reopen, retry turns can reference the same batch without
rewriting canonical messages, and history reads expose batch grouping.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: missing table/API assertions fail.

- [ ] **Step 3: Add migration, transactional writes, reads, and history join**

Create `current_user_batches` and `current_user_batch_items`, write them in the same transaction as
turn acceptance, and leave `messages.checksum` inputs unchanged.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: PASS.

### Task 3: Route, timing, and context semantics

**Files:**
- Modify: `yuqi-runtime/src/route-policy.mjs`
- Modify: `yuqi-runtime/src/interaction-state.mjs`
- Modify: `yuqi-runtime/src/conversation-context.mjs`
- Modify: `yuqi-runtime/test/route-policy.test.mjs`
- Modify: `yuqi-runtime/test/interaction-state.test.mjs`
- Modify: `yuqi-runtime/test/conversation-context.test.mjs`

**Interfaces:**
- Consumes: `resolveCurrentUserBatch`.
- Produces: batch-wide route decisions, batch-aware gaps, and batch-aware history windows.

- [ ] **Step 1: Write failing semantic tests**

Add the severe-first/mild-last route case, an incomplete-batch deep-route case, a gap test that
excludes all current items, a window test that excludes all current IDs, and a history grouping test.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/route-policy.test.mjs yuqi-runtime/test/interaction-state.test.mjs yuqi-runtime/test/conversation-context.test.mjs`

Expected: route and context assertions fail against last-message behavior.

- [ ] **Step 3: Implement batch-wide semantics**

Use the resolver in route and interaction state; allow `buildGenerationWindow` to exclude an array
of current IDs and group historical user bubbles by `batchId`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: PASS.

### Task 4: Memory, brain, supervisor, and batch images

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `resolveCurrentUserBatch`.
- Produces: one non-duplicated `currentUserBatch` role input.

- [ ] **Step 1: Write failing orchestrator tests**

Assert memory, brain, and supervisor receive all batch messages in order; current IDs are absent
from `recentMessages`; the memory query fallback uses combined text; and an image in a non-final
bubble is materialized and stripped from JSON.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`

Expected: `currentUserBatch` assertions fail.

- [ ] **Step 3: Implement one role-input contract**

Resolve the batch once per stage, merge batch messages only for evidence verification, remove them
from historical windows, and collect bounded image attachments across the batch.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: PASS.

### Task 5: Web and Android bridge serialization

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tests/payment-batch-bridge-contract.test.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`

**Interfaces:**
- Produces: `options.batchMessages` from committed UI messages.
- Produces: `context.currentBatch.messages` in the Android protocol envelope.

- [ ] **Step 1: Write failing JavaScript and Java bridge tests**

Assert every committed bubble is serialized with its own content, ID, timestamp, and attachment;
the source message remains the final item; and Java preserves the full ordered array.

- [ ] **Step 2: Run tests and verify RED**

Run:
- `node --test tests/payment-batch-bridge-contract.test.mjs`
- `android\gradlew.bat testDebugUnitTest --no-problems-report`

Expected: missing `batchMessages` assertions fail.

- [ ] **Step 3: Implement web and Java serialization**

Build canonical batch message objects from committed UI messages, preserve them in pending/retry
state, and normalize wire IDs in `BridgeInput`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same commands. Expected: PASS.

### Task 6: Full regression and release version

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tests/android-unsigned-release-contract.test.mjs`

**Interfaces:**
- Produces: versionCode `104`, versionName `1.0.104`.

- [ ] **Step 1: Update the release-contract test and verify RED**

Run: `node --test tests/android-unsigned-release-contract.test.mjs`

Expected: version assertions fail while source remains at 103.

- [ ] **Step 2: Update all release version declarations**

Set Gradle defaults and workflow values to 104/1.0.104.

- [ ] **Step 3: Run full local checks**

Run:
- `npm.cmd test`
- `android\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-problems-report`
- `npm.cmd run android:copy`
- `android\gradlew.bat assembleRelease --no-problems-report`

Expected: PASS and an unsigned local release APK suitable only for build verification.

### Task 7: Formal signing, download, and verification

**Files:**
- Create: `artifacts/AL-1.0.104-release.apk` from the fixed-certificate workflow output.

**Interfaces:**
- Produces: formally signed, cover-installable APK.

- [ ] **Step 1: Publish only scoped tested files to `codex/al-tdd`**

Use the documented GitHub REST path without force-pushing or including unrelated dirty files.

- [ ] **Step 2: Trigger and supervise `.github/workflows/android-apk.yml`**

Wait for JavaScript checks, Android checks, release build, signature verification, artifact upload,
and `signed-builds` publication to succeed.

- [ ] **Step 3: Download and verify the formal APK**

Check package, versionCode, versionName, v2 signature, single signer, formal certificate SHA-256,
certificate equality with the previous release, and final file SHA-256.

- [ ] **Step 4: Shut down the computer**

After all verification artifacts are safely written, execute the user-authorized system shutdown.
