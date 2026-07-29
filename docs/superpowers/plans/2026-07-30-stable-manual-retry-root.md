# Stable Manual Retry Root Implementation Plan

> **For agentic workers:** Execute these checkbox steps in order with test-driven development.

**Goal:** Make every Android manual retry independently recoverable by anchoring it to the original deterministic message turn.

**Architecture:** Add a small pure helper that derives the canonical retry parent from the user message ID. Use it when constructing every fresh retry envelope while retaining retry history only for UI arbitration.

**Tech Stack:** JavaScript, Node.js `node:test`, Capacitor Android, Gradle.

## Global Constraints

- Every retry must keep a fresh `turnId`.
- Every retry for one user message must share one deterministic `retryOfTurnId`.
- Do not reuse a terminal Room turn.
- Do not weaken PC canonical-message validation.

### Task 1: Stable retry root

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tavern-app/index.html`

- [ ] Add a behavioral test that simulates a failed retry whose latest native
  turn is itself a retry and expects the canonical parent to remain the
  original deterministic turn.
- [ ] Run the focused UI test and verify it fails because the helper is absent.
- [ ] Add `nativeRetryRootTurnId(messageId)` and use it for
  `retryOfTurnId`.
- [ ] Run the focused test and full JavaScript suite.

### Task 2: Android release

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tests/android-unsigned-release-contract.test.mjs`

- [ ] Advance the default version to code 105 and name 1.0.105.
- [ ] Synchronize Capacitor Android assets and run Android unit tests.
- [ ] Build the release APK through the formal signing runbook.
- [ ] Verify package name, version, signature certificate, and SHA-256.
