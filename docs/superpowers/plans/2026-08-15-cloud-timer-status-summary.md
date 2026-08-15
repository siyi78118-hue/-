# Cloud Timer Status Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overloaded settings status block with a four-line user summary while retaining complete scheduler evidence in diagnostics, then ship AL 1.0.118.

**Architecture:** `cloudTimerStatusText()` becomes a pure user-summary projector over settings and current schedule snapshots. A separate `cloudTimerDiagnosticText()` owns the verbose historical projection and is rendered as a diagnostics card. No scheduling or persistence API changes.

**Tech Stack:** Static HTML/JavaScript, Node `vm` contract tests, Capacitor Android release workflow.

## Global Constraints

- The settings summary contains at most four non-empty lines.
- Historical errors, HTML, internal IDs, generations and model-call data never appear in the summary.
- Full evidence remains available in diagnostics.
- No schedule authority, Room, D1, Worker or Alarm mutation is introduced.

---

### Task 1: Split user summary from scheduler diagnostics

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Consumes: existing `settings`, `characters`, `allChats`, `nativeAutomaticScheduleStatuses`.
- Produces: `cloudTimerStatusText(): string` and `cloudTimerDiagnosticText(): string`.

- [ ] **Step 1: Write the failing runtime contract**

Add a VM probe that creates current native chat/moment schedules plus stale HTML failures. Assert the summary has at most four lines, contains current due times, and excludes `jobId`, `任务代数`, `私聊上次失败`, `<!doctype`, `最近调用` and old API status. Assert the verbose diagnostic contains the retained technical evidence.

- [ ] **Step 2: Verify the contract fails**

Run: `node test-basic.mjs`

Expected: FAIL because `cloudTimerStatusText()` currently includes technical and historical rows and no `cloudTimerDiagnosticText()` exists.

- [ ] **Step 3: Implement the split**

Refactor the existing detailed projector into `cloudTimerDiagnosticText()`. Implement a new `cloudTimerStatusText()` which selects only the current effective chat/moment schedules and derives a concise health line. Remove the model-call append from `renderCloudTimerStatus()`. Add a scheduler diagnostics card to `renderDiagnosticsScreen()` before native/model diagnostics, escaping its text.

- [ ] **Step 4: Verify focused and full Web contracts**

Run: `node test-basic.mjs`

Expected: PASS with the new summary/diagnostic assertions and existing UI contracts.

- [ ] **Step 5: Commit**

```bash
git add test-basic.mjs tavern-app/index.html
git commit -m "fix: simplify proactive runtime status"
```

### Task 2: Release AL 1.0.118

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `android-update.json`
- Modify: `tavern-app/sw-v11.js`
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`
- Modify: `tests/android-unsigned-release-contract.test.mjs`
- Create: `artifacts/qa/cloud-timer-status-summary-1.0.118.md`

**Interfaces:**
- Consumes: the Task 1 UI contract and existing signing workflow.
- Produces: signed `artifacts/AL-1.0.118-release.apk` and update-channel build 118.

- [ ] **Step 1: Write release-contract expectations for 118**

Update only test expectations first for versionCode 118, versionName 1.0.118, app build `2026-08-15.118`, cache `rpchat-v118`, release tag `android-v118`, while retaining Worker version `2026-08-15.1`.

- [ ] **Step 2: Verify release tests fail**

Run: `node --test tests/android-unsigned-release-contract.test.mjs && node test-basic.mjs`

Expected: FAIL against the still-117 production files.

- [ ] **Step 3: Update release inputs**

Set the production version fields and update manifest to 118 without changing Worker code/version.

- [ ] **Step 4: Run gates**

Run: `node --test tests/android-unsigned-release-contract.test.mjs`, `node test-basic.mjs`, and `npm.cmd test`.

Expected: all PASS.

- [ ] **Step 5: Publish and verify**

Push `codex/al-tdd`, wait for the official workflow, download the signed APK, and verify package `com.siyi.al`, version 118/1.0.118, v2 signature, signer count 1, and certificate SHA-256 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.

- [ ] **Step 6: Record and commit evidence**

Write the workflow run, APK SHA-256, test results and unchanged device/24-hour limitations to the QA record; commit only that record.

