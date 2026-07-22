# Yuqi Delayed Reply and Payment Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delayed replies originate from the actual processing time and make payment acceptance/refusal update the real payment card state.

**Architecture:** Extend protocol-v2 direct envelopes with validated payment context, extend structured brain output and bridge results with a payment action, and use the runtime clock for temporal state. Preserve the existing UI payment settlement path by emitting a `PAYMENT_STATUS` reply part on Android.

**Tech Stack:** Node.js ESM and `node:test`, Java/Android Room bridge code, Gradle JVM tests, Markdown versioned presets.

## Global Constraints

- AL combined RP and Yuqi core remain mandatory generation presets.
- Non-payment direct replies and automatic `skip` behavior remain compatible.
- No payment card may change state from unstructured prose alone when explicit structured state is available.
- Use TDD: each production behavior must first be demonstrated by a failing test.

---

### Task 1: Real processing-time interaction state

**Files:**
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: `YuqiOrchestrator({ clock })`, protocol envelope timestamps and stored recent messages.
- Produces: `buildInteractionState(envelope, messages, computedAt)` with `sourceOccurredAt`, `processingDelayMs`, `processingDelayText`, and delay classification.

- [ ] Add a test whose message was sent 2h39m before the injected runtime clock and assert that the brain receives the actual clock time and full delay.
- [ ] Run `node --test yuqi-runtime/test/orchestrator.test.mjs` and confirm the old `envelope.createdAt` behavior fails.
- [ ] Pass `this.clock()` into interaction-state construction for both brain and supervisor, add the delay fields, and add present-time continuity rules to the core preset.
- [ ] Bump the packaged preset version and update preset-registry expectations.
- [ ] Re-run the two runtime test files and confirm they pass.

### Task 2: Preserve structured payment input

**Files:**
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`

**Interfaces:**
- Consumes: `inputJson.options.payment` and `inputJson.options.paymentMessageId`.
- Produces: direct envelope `context.payment = { kind, amount, note, messageId, status }`.

- [ ] Add Java and Node tests proving a pending red packet survives bridge creation and protocol normalization.
- [ ] Run the targeted Java/Node tests and confirm both fail because direct context is currently dropped.
- [ ] Copy only validated payment fields into the envelope and normalize them in `validateEnvelope`.
- [ ] Re-run the targeted tests and confirm they pass.

### Task 3: Carry payment decision through runtime and Android

**Files:**
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`

**Interfaces:**
- Consumes: brain `paymentAction` and committed runtime result `paymentAction`.
- Produces: Android `BridgeResult.paymentStatus` and a `PAYMENT_STATUS` reply part committed with the visible reply.

- [ ] Add runtime tests for `received`, `pending`, and non-payment `null`, plus an Android test that a received result produces a payment-status part.
- [ ] Run the targeted tests and confirm failure because the schemas and bridge result omit payment action.
- [ ] Extend schemas, normalization, committed results and Android result parsing with the payment action.
- [ ] Add deterministic text/action consistency handling and preserve existing visible reply parsing.
- [ ] Re-run targeted tests and confirm they pass.

### Task 4: Full verification, APK and runtime activation

**Files:**
- Modify only if required by version contract: `android/app/build.gradle`
- Produce: `artifacts/AL-<version>-unsigned.apk`

**Interfaces:**
- Consumes: completed source and tests.
- Produces: verified unsigned APK and live runtime health on the new preset version.

- [ ] Run `node scripts/verify-yuqi-runtime.mjs` and require every check to pass.
- [ ] Build the release APK with the next version and copy it into `artifacts/` without overwriting older installers.
- [ ] Stop and restart the formal Yuqi runtime using the project scripts.
- [ ] Verify `/v1/health` reports the new preset, all three role sessions and connected cloud relay.
- [ ] Query one safe test fixture or persisted turn contract to verify delayed-time and payment-action fields without sending an unsolicited user-visible message.
