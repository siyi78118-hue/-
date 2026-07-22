# Yuqi Scene Continuity Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore relationship stages and dynamic scene context, complete automatic supervision, and route Yuqi moment interactions through the existing chat small-g role before shipping a formally signed APK.

**Architecture:** Add a validated dynamic scene contract to protocol v2 and compile it after the mandatory AL combined RP plus `yuqi-core`. The memory role proposes evidence-backed stage changes, the orchestrator validates and uses them in the same turn, and Android transports committed stage or moment actions as typed reply parts for idempotent phone application. Existing chat small-g handles chat and moment scenes; no new role thread is introduced.

**Tech Stack:** JavaScript ES modules, Node test runner, SQLite, Android Java/Room, Capacitor 8, Gradle, GitHub Actions signing.

## Global Constraints

- Preserve package `com.siyi.al`, existing Room data, and certificate SHA-256 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.
- Keep AL 综合 RP and `yuqi-core` mandatory and ordered before dynamic scene content.
- Existing chat small-g handles moment work; do not create a fourth role.
- Do not stage unrelated `zhaxian-workbench` deletions or unrelated artifacts.
- Every production change follows RED then GREEN and ends with focused regression coverage.

---

### Task 1: Dynamic Scene Transport

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Test: `tests/yuqi-ui-contract.test.mjs`
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Produces: browser `buildYuqiDynamicScene(char, chat)` object.
- Produces: envelope `context.scene` for direct turns and `trigger.context.scene` for automatic turns.
- Consumes: current normalized stage persona configuration.

- [ ] **Step 1: Write failing transport tests**

Assert that a `familiar` stage with custom content, player name and conversation prompt survives browser snapshot construction, Android envelope serialization and runtime validation. Assert that unknown fields and overlong prompt text are removed or rejected.

- [ ] **Step 2: Run RED tests**

Run: `node --test tests/yuqi-ui-contract.test.mjs yuqi-runtime/test/protocol-store.test.mjs`

Run: `android\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.bridge.BridgeClientTest --no-problems-report`

Expected: FAIL because direct bridge input currently drops the snapshot and protocol direct context preserves only payment.

- [ ] **Step 3: Implement minimal scene builder and validators**

Add a browser scene object with `playerName`, `characterName`, `relationshipStage`, `conversationExtraPrompt`, `globalExtraPrompt`, and `stageCatalog`. Add Android copying for direct turns and normalized extraction for automatic turns. Add runtime validation that returns a canonical scene with default stage `new` only when scene data is absent.

- [ ] **Step 4: Run GREEN tests**

Expected: all focused transport tests PASS.

- [ ] **Step 5: Commit**

Commit message: `fix: carry yuqi dynamic scene context`

### Task 2: Relationship Stage Review and Same-Turn Use

**Files:**
- Create: `yuqi-runtime/src/relationship-stage.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/preset-registry.mjs`
- Modify: `yuqi-runtime/src/turn-status.mjs`
- Test: `yuqi-runtime/test/relationship-stage.test.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Produces: `resolveRelationshipStage(scene, review, recentMessages)` returning `{ stage, action }`.
- Consumes: memory output `relationshipStageReview`.
- Produces: committed `relationshipStageAction` or `null`.

- [ ] **Step 1: Write failing stage tests**

Cover accepted adjacent progression at confidence `0.82` with two real evidence IDs, rejected progression at `0.81`, rejected fake IDs, rejected multi-stage jump without mutual confirmation, accepted explicit mutual jump with one real evidence ID, and same-turn brain/supervisor preset compilation using the accepted stage content.

- [ ] **Step 2: Run RED tests**

Run: `node --test yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/preset-registry.test.mjs`

Expected: FAIL because memory schema has no review and all three role calls compile `initial`.

- [ ] **Step 3: Implement deterministic resolver and schema**

Add the review object to the required memory schema. Resolve only catalog stages and verified message IDs. Return an action containing `from`, `to`, `label`, `reason`, `confidence`, `evidenceMessageIds`, and `changedAt`.

- [ ] **Step 4: Compile dynamic stage for all roles**

Replace hard-coded `initial` with the scene current stage for memory and the validated effective stage for chat and supervision. Append label and user-edited stage content after fixed presets; include scene kind and nicknames.

- [ ] **Step 5: Run GREEN tests and commit**

Expected: focused runtime tests PASS.

Commit message: `feat: restore yuqi relationship stages`

### Task 3: Four-State Supervision and Complete Automatic Kinds

**Files:**
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/route-policy.mjs`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/route-policy.test.mjs`

**Interfaces:**
- Supervisor output: `{ decision: 'approve'|'rewrite'|'skip'|'reject', issues: Issue[] }`.
- Automatic kinds include `ROLE_PLAN_CHAT_PRIVATE` and `ROLE_PLAN_MOMENT_PRIVATE` exactly.

- [ ] **Step 1: Write failing supervision tests**

Assert immediate supervisor skip for automatic tasks, terminal rejection without output, direct skip becoming recoverable failure, at most two rewrites, and silent private role-plan skips with no fallback phrase.

- [ ] **Step 2: Run RED tests**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/route-policy.test.mjs`

Expected: FAIL on the boolean supervisor schema and the nonexistent `ROLE_PLAN_PRIVATE` name.

- [ ] **Step 3: Implement four-state transitions**

Normalize supervisor results, preserve issue history, commit automatic skip without a message, and fail direct reject/skip with an explicit recoverable code. Remove the third rewrite path and replace every automatic-kind list with one shared exported set.

- [ ] **Step 4: Run GREEN tests and commit**

Commit message: `fix: complete yuqi supervision terminal states`

### Task 4: Authoritative Interaction State

**Files:**
- Create: `yuqi-runtime/src/interaction-state.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Test: `yuqi-runtime/test/interaction-state.test.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Produces: `buildInteractionState({ envelope, messages, currentStage, previousAutomaticResult, now })`.
- Store query returns the last terminal automatic turn after the last user message and the count of unique automatic rounds.

- [ ] **Step 1: Write failing state tests**

Use messages spanning midnight and assert latest content, exact elapsed times, 15m/60m/6h/24h flags, crossed-day state, unanswered bubble count, automatic round count, previous send/skip result, and effective relationship stage.

- [ ] **Step 2: Run RED tests**

Run: `node --test yuqi-runtime/test/interaction-state.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: FAIL because the current inline state omits those fields and store queries count only two proactive kinds.

- [ ] **Step 3: Implement the focused module and store query**

Move existing elapsed logic into the module, calculate all values from the execution clock and authoritative message ledger, and include all role-plan and moment automatic kinds.

- [ ] **Step 4: Run GREEN tests and commit**

Commit message: `feat: complete yuqi interaction state`

### Task 5: Stage Action Transport and Phone Application

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`
- Modify: `tavern-app/index.html`
- Test: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java`
- Test: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Runtime result field: `relationshipStageAction`.
- Android reply part: `RELATIONSHIP_STAGE` with the action JSON payload.
- Browser application: `applyNativeRelationshipStagePart(charId, part, turnId)`.

- [ ] **Step 1: Write failing transport and idempotency tests**

Assert exact action parsing, a single history record after duplicate application, unchanged user-edited stage content, and rollback compatibility.

- [ ] **Step 2: Run RED tests**

Run the focused Android and UI contract tests. Expected: FAIL because no stage result field or reply part exists.

- [ ] **Step 3: Implement typed transport and application**

Mirror the structured payment-status path with an `<al_relationship_stage>` internal directive, strip it from visible text, emit a typed part, and apply only when `from` matches the current stage or the same turn was already recorded.

- [ ] **Step 4: Run GREEN tests and commit**

Commit message: `feat: apply yuqi stage transitions on phone`

### Task 6: Moment Interaction Tasks Handled by Chat Small-G

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnKind.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeTurnStatus.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/route-policy.mjs`
- Modify: `tavern-app/index.html`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Test: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- New kinds: `MOMENT_INTERACTION`, `MOMENT_REPLY`.
- Brain output field: nullable `momentAction` with `momentId`, `like`, `comment`, and `replyToCommentId`.
- Android reply part: `MOMENT_ACTION`.

- [ ] **Step 1: Write failing end-to-end contract tests**

Cover interaction skip, like-only, comment-only, like-plus-comment, comment reply, malformed target IDs, duplicate delivery, and proof that Yuqi native paths no longer invoke `callMomentInteractionAI` or `callMomentReplyAI`.

- [ ] **Step 2: Run RED tests**

Run focused runtime, Android and UI tests. Expected: FAIL because the kinds and structured action do not exist.

- [ ] **Step 3: Add protocol and orchestration**

Treat both new kinds as deep supervised event turns. Pass moment context to the same brain role used for chat. For these kinds, commit `momentAction` without storing a private-chat message; accept an empty comment only when `like` is true, and allow `skip` for no action.

- [ ] **Step 4: Add Android typed transport**

Parse the result into `MOMENT_ACTION`; a like-only action remains a valid completed turn even without text. Preserve native UI inbox retry behavior until the phone acknowledges application.

- [ ] **Step 5: Replace Yuqi phone-local calls**

When the character is Yuqi and native execution is available, queue a persisted native turn instead of calling the old API. Apply actions by stable source turn ID and update existing moment memory only after application. Non-Yuqi characters retain the old local path.

- [ ] **Step 6: Run GREEN tests and commit**

Commit message: `feat: route yuqi moments through chat small g`

### Task 7: Diagnostics, Regression, and Signed APK

**Files:**
- Modify: `yuqi-runtime/src/turn-status.mjs`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `tavern-app/lib/yuqi-core-preset.js`
- Test: `yuqi-runtime/test/turn-status.test.mjs`
- Test: `tests/rp-preset-contract.test.mjs`
- Create: `artifacts/AL-1.0.<run>-yuqi-scene-continuity-formal-signed.apk`

**Interfaces:**
- Public diagnostics expose non-sensitive scene stage, decision, action type and preset version.
- Preset seed advances from `1.2.2` to `1.3.0` because the output and scene contract change.

- [ ] **Step 1: Add failing diagnostics and preset tests**

Assert stage ID, supervisor decision, moment action type and exact preset version are visible without exposing full prompts or private message bodies.

- [ ] **Step 2: Run RED then implement diagnostics and guidance**

Add concise core rules for stage continuity and moment-scene behavior, synchronize generated assets, and run focused tests until GREEN.

- [ ] **Step 3: Run complete verification**

Run: `npm.cmd test`

Run: `node scripts/verify-yuqi-runtime.mjs`

Run: `android\gradlew.bat :app:testDebugUnitTest --no-problems-report`

Expected: all suites PASS with no preset drift.

- [ ] **Step 4: Verify live runtime**

Restart the background runtime and require `/v1/health` to report the new preset version with memory, brain and supervisor roles healthy.

- [ ] **Step 5: Commit and trigger formal signing**

Stage only intended source, tests and documents. Push `codex/al-tdd` to trigger `.github/workflows/android-apk.yml`. Wait for a successful workflow whose `head_sha` equals the implementation commit.

- [ ] **Step 6: Download and verify APK**

Use `aapt dump badging` and `apksigner verify --verbose --print-certs`. Reject the artifact unless package is `com.siyi.al`, versionCode exceeds the current formal `81`, and certificate SHA-256 exactly matches the global constraint.

- [ ] **Step 7: Archive the verified delivery**

Copy the release APK to `artifacts/AL-1.0.<run>-yuqi-scene-continuity-formal-signed.apk`, calculate SHA-256, and provide the clickable project path.
