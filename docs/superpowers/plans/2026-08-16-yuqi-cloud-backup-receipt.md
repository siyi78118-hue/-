# Yuqi Cloud Backup Receipt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Android obtain the same verified PC backup receipt through the encrypted cloud relay when the LAN bridge is unreachable.

**Architecture:** Keep the existing closed `YUQI_BACKUP_REQUEST` and persisted backup receipt as the single authority. Add one request/response message family to the existing encrypted relay; LAN remains first choice and only transport-level LAN failures fall back to cloud.

**Tech Stack:** Java/Android, Node.js ESM, Cloud Relay Worker protocol, AES-256-GCM, node:test, JUnit.

## Global Constraints

- Never fabricate or trust a caller-supplied backup receipt.
- Do not expose the PC local server publicly.
- A timeout or invalid response performs zero restoration-store writes and zero role deletion.
- Preserve existing LAN, v1/v2, v3 turn, lifecycle-control and receipt behavior byte-for-byte.

---

### Task 1: Freeze the cloud backup request/response contract

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/execution/LifecycleControlCodec.java`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`
- Test: `android/app/src/test/java/com/siyi/al/execution/LifecycleControlCodecTest.java`

**Interfaces:**
- Consumes: existing `validateYuqiBackupRequest(raw)` and backup receipt validator.
- Produces: `validateYuqiBackupReceiptResponse(raw)` / Java equivalent for the exact response tuple `{protocolVersion,type,requestChecksum,roleId,peerId,requestedAt,receipt,checksum}`.

- [ ] Write closed-key/type/checksum, Unicode, foreign-peer, changed-request and replay tests.
- [ ] Run focused Node/JUnit tests and record the expected missing-validator red state.
- [ ] Implement the two equivalent validators using canonical UTF-8 JSON SHA-256.
- [ ] Re-run focused tests; expect all pass.

### Task 2: Process backup requests on the PC relay pump

**Files:**
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Test: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Test: `yuqi-runtime/test/local-server.test.mjs`

**Interfaces:**
- Consumes: the Task 1 request validator and existing `createVerifiedYuqiBackup()` callback.
- Produces: an encrypted deterministic `pc_to_phone` response via `/bridge/ack-with-response`.

- [ ] Add a real relay-pump test proving decrypt → validate → persisted receipt → response → request ACK ordering.
- [ ] Add invalid/foreign/changed/replay tests proving zero ACK and idempotent exact replay.
- [ ] Extract the LAN endpoint's backup operation into one injected handler shared with the pump.
- [ ] Add the backup request branch before normal turn validation and derive stable response ids/nonces.
- [ ] Run the focused PC tests; expect all pass and no turn/diagnostic side effects.

### Task 3: Add Android LAN-to-cloud fallback and bounded receipt wait

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Test: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: Task 1 response validator and existing Cloud Relay enqueue/poll/ack endpoints.
- Produces: `requestVerifiedBackup(...)` returning the same receipt for LAN and cloud.

- [ ] Add red tests for LAN network failure → stable cloud enqueue → response poll → exact receipt → ACK.
- [ ] Add timeout, duplicate response, foreign response, concurrent inbox and changed checksum zero-write tests.
- [ ] Implement transport-only fallback, deterministic ids and an explicit bounded poll helper.
- [ ] Translate cloud pending/timeout to a Chinese actionable UI error without changing authority state.
- [ ] Run focused Java/UI tests; expect all pass.

### Task 4: End-to-end verification and release

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `tavern-app/sw-v11.js`
- Modify: `android-update-manifest.json`
- Test: `test-basic.mjs`
- Test: `tests/android-release-deployment-contract.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a formally signed APK that upgrades 1.0.122 without clearing app data.

- [ ] Run the focused PC/Android/UI suites, then `npm.cmd test`.
- [ ] Build `testDebugUnitTest assembleDebugAndroidTest`; record that connected tests require a device.
- [ ] Bump version/cache/manifest together and trigger the official signing workflow.
- [ ] Verify package, versionCode/versionName, signer SHA-256 and APK SHA-256 before delivery.

