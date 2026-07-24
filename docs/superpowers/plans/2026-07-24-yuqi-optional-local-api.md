# Yuqi Optional Local API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Allow Yuqi native Bridge turns to run without ordinary chat or memory AI configuration.

**Architecture:** Convert frontend native API synchronization from mandatory validation into optional save/remove synchronization. Preserve Android's existing Bridge-first routing and use the local OpenAI-compatible configurations only when fallback is actually reached.

**Tech Stack:** Vanilla JavaScript, Capacitor Android Java plugin, Node.js contract tests, Gradle.

## Global Constraints

- LAN/Cloud Bridge remains the primary Yuqi execution path.
- Incomplete or unsupported local API settings must never block Bridge submission.
- Cleared settings must remove native secret-store values.
- Local fallback without a saved configuration must fail explicitly in the Android execution layer.

---

### Task 1: Lock the regression contract

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tests/android-unsigned-release-contract.test.mjs`

**Interfaces:**
- Consumes: inline `saveNativeExecutionApiConfigs()` and `AlExecutionPlugin`.
- Produces: source contracts for optional save/remove synchronization and Android version 1.0.91.

- [x] **Step 1: Write failing tests**

Add assertions that configuration synchronization has no incomplete-configuration throw, saves complete OpenAI-compatible configs, removes unavailable configs, and that the release version is 1.0.91.

- [x] **Step 2: Verify RED**

Run `node --test tests/yuqi-ui-contract.test.mjs tests/android-unsigned-release-contract.test.mjs`.

Expected: FAIL because the frontend still throws and `removeApiConfig`/version 1.0.91 do not exist.

### Task 2: Make local fallback configuration optional

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: `AlSecretStore.removeApiConfig(String configId)`.
- Produces: Capacitor `removeApiConfig({ configId })` and non-blocking `saveNativeExecutionApiConfigs()`.

- [x] **Step 1: Implement minimal behavior**

Expose `removeApiConfig` through the plugin. In the frontend, save a configuration only when its API type is OpenAI-compatible and all required fields are present; otherwise remove it.

- [x] **Step 2: Verify GREEN**

Run `node --test tests/yuqi-ui-contract.test.mjs` and `node test-basic.mjs`.

Expected: PASS.

### Task 3: Release verification

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Generated: `artifacts/AL-1.0.91-optional-local-api-unsigned.apk`

**Interfaces:**
- Produces: installable unsigned Android 1.0.91 artifact ready for formal signing.

- [x] **Step 1: Set version 1.0.91**

Update default and workflow version code/name from `90`/`1.0.90` to `91`/`1.0.91`.

- [x] **Step 2: Run complete verification**

Run `npm.cmd test`, Android debug unit tests with the isolated build initializer, copy web assets, and assemble release.

Expected: all tests pass and `aapt dump badging` reports version code `91` and version name `1.0.91`.

- [x] **Step 3: Review and commit**

Stage only the listed files and create one focused commit. Do not include unrelated deleted or untracked workspace files.
