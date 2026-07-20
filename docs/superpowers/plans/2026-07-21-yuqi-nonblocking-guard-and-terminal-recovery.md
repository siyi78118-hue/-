# Yuqi Nonblocking Guard and Terminal Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never block a deliverable Yuqi reply for immersion wording, reliably close phone pending state for every terminal result, and restore the saved reply for `turn_msg_1784559268075_lvywi5` exactly once.

**Architecture:** Keep runtime validation limited to technical deliverability. Make cloud input and output idempotent around the authoritative stored turn, persist backlog failures on Android, and add a transactional recovery operation for a failed turn with a saved brain draft.

**Tech Stack:** Node.js 24 ESM, `node:test`, SQLite, Java/Android Room, Gradle.

## Global Constraints

- Runtime must not block any reply because it mentions AI, models, prompts, memory, or internal identity.
- Empty, oversized, and structurally invalid outputs remain technical failures.
- Chat UI must never show model names, stack traces, or internal validation codes.
- Recovery must reuse the stored draft and original turn; it must not regenerate or duplicate memory.
- Preserve unrelated dirty workspace files.

---

### Task 1: Remove immersion wording from runtime blocking

**Files:**
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`

**Interfaces:**
- Consumes: `hardValidateReply(reply: string)`
- Produces: validation issues only for `EMPTY_REPLY` and `REPLY_TOO_LARGE`

- [ ] **Step 1: Write failing tests**

Add tests proving both `原来是AI短剧` and `我是一个AI模型` commit successfully, while empty and oversized replies still fail.

- [ ] **Step 2: Verify RED**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`

Expected: AI wording cases fail with `hard validation failed: BACKSTAGE_LEAK`.

- [ ] **Step 3: Implement minimal change**

Remove `BACKSTAGE_LEAK` from `hardValidateReply`; retain empty and size checks unchanged.

- [ ] **Step 4: Verify GREEN**

Run the same test and expect all cases to pass.

### Task 2: Acknowledge repeated cloud inputs without losing terminal delivery

**Files:**
- Modify: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`

**Interfaces:**
- Consumes: `dispatcher.accept(envelope)`, `store.getTurn(turnId)`, `store.registerCloudDelivery(...)`
- Produces: one ACK for every decryptable duplicate envelope and a terminal delivery registration for the authoritative turn

- [ ] **Step 1: Write failing tests**

Add a protocol-v2 case where `dispatcher.accept` throws `turn checksum conflict` but `store.getTurn` returns an existing terminal turn. Assert that the pump registers delivery, acknowledges the relay message, and does not record a repeating error.

Add a nonterminal conflict case asserting the stored turn is kept, the relay message is acknowledged, and a single diagnostic is recorded.

- [ ] **Step 2: Verify RED**

Run: `node --test yuqi-runtime/test/cloud-relay-pump.test.mjs`

Expected: no ACK and `summary.failed === 1` under current behavior.

- [ ] **Step 3: Implement minimal change**

On protocol-v2 accept conflict, look up the existing turn. If found, register its cloud delivery, ACK the duplicate envelope, record a bounded diagnostic only for nonterminal payload conflict, and continue without overwriting the stored envelope.

- [ ] **Step 4: Verify GREEN**

Run the cloud pump tests and expect all cases to pass.

### Task 3: Persist backlog failure terminals on Android

**Files:**
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`

**Interfaces:**
- Consumes: terminal cloud JSON without a `reply`
- Produces: local `FAILED_FINAL` or `FAILED_RETRYABLE` turn state with a safe generic detail and an ACK for the cloud envelope

- [ ] **Step 1: Write failing tests**

Add a drain-inbox test that provides a terminal failed result for an existing direct turn and asserts the consumer is invoked before ACK. Add a Room mirror test asserting the local turn and attempt become failed without storing the remote internal error text.

- [ ] **Step 2: Verify RED**

Run the targeted Gradle unit tests. Expected: current drain path ACKs and discards backlog failures.

- [ ] **Step 3: Implement minimal change**

Route `BACKLOG_FAILED` through the inbox consumer. Extend the mirror to transactionally mark the matched turn/attempt failed with code `REMOTE_REPLY_FAILED` and detail `回复暂时没有送达，请重试`, then ACK the cloud item.

- [ ] **Step 4: Verify GREEN**

Run the targeted tests and the Android unit-test suite.

### Task 4: Recover the saved failed draft exactly once

**Files:**
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Create: `scripts/recover-yuqi-failed-draft.mjs`

**Interfaces:**
- Produces: `store.recoverFailedDraft(turnId, { peerId }) -> { recovered, turn, reply }`

- [ ] **Step 1: Write failing tests**

Create a failed turn containing `brainDraftJson`, call `recoverFailedDraft`, and assert the turn is committed, one character message exists, the delivery is pending, and a second call is idempotent.

- [ ] **Step 2: Verify RED**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: `recoverFailedDraft is not a function`.

- [ ] **Step 3: Implement minimal change**

Implement the transaction with deterministic message identity derived from the turn ID, original `updatedAt` as `sentAt`, committed `replyJson`, cleared `errorJson`, and reset cloud delivery payload/checksum/state so the current terminal result is resent.

Create a CLI that requires `--turn`, `--peer`, and optional `--config`; it prints a dry summary and executes only with `--apply`.

- [ ] **Step 4: Verify GREEN**

Run protocol-store tests, then execute the CLI without `--apply` against the authoritative database and verify it selects only `turn_msg_1784559268075_lvywi5`.

### Task 5: Regression audit, production recovery, and APK

**Files:**
- Build with environment overrides `AL_VERSION_CODE=80` and `AL_VERSION_NAME=1.0.80`; do not change the checked-in defaults in `android/app/build.gradle`
- Create: `artifacts/AL-1.0.80-release.apk`

**Interfaces:**
- Consumes: all repaired runtime and Android components
- Produces: verified APK and one recovered mailbox reply

- [ ] **Step 1: Run regression suites**

Run all `yuqi-runtime/test/*.test.mjs`, relevant root Node tests, and Android unit tests.

- [ ] **Step 2: Audit direct-error paths**

Search runtime, Android, and web UI for `errorDetail`, internal error codes, and validation errors reaching chat rendering. Confirm only safe user-facing text is exposed.

- [ ] **Step 3: Restart the PC bridge**

Stop only the process listening on TCP 17891, start `yuqi-runtime/src/main.mjs` with the existing config, and verify `/health` plus cloud status.

- [ ] **Step 4: Apply the one-time recovery**

Run the recovery CLI with `--apply` for `turn_msg_1784559268075_lvywi5` and the configured phone peer. Verify the delivery becomes mailboxed and later confirmed, with one character message only.

- [ ] **Step 5: Build and verify APK**

Build the release APK with the existing signing configuration, verify package/version/signature, and copy it to `artifacts/AL-1.0.80-release.apk`.

- [ ] **Step 6: Commit scoped changes**

Stage only the files listed in this plan and commit the repair without touching unrelated dirty files.
