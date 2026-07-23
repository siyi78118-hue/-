# Yuqi Lived Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicate Android reply landing, calculate real pre-turn conversation gaps, simulate Yuqi's persistent offline life, and make the dual-axis relationship state automatically advance and regress from verified evidence.

**Architecture:** Android carries an explicit current-message batch boundary into each durable envelope. The runtime computes interaction state from messages before that batch, persists approved life episodes in SQLite, and passes one authoritative time/life/relationship packet through memory, brain, and supervisor. The WebView applies completed turns through a single-flight reconciler and deterministic bubble IDs.

**Tech Stack:** Node.js ESM, `node:test`, Node SQLite, Android Java/Room bridge code, Capacitor WebView JavaScript, Markdown preset registry.

## Global Constraints

- Keep the existing memory, brain, and supervisor roles; do not add a fourth Codex role.
- Raw messages remain authoritative evidence.
- Life simulation may create ordinary low-risk daily events but must not create major accidents, illness, job loss, identifiable new relationships, or identity changes.
- Relationship changes require verified message IDs; life simulation alone cannot advance or regress the relationship.
- Direct reply text, life adjustment, and relationship action commit atomically.
- Preserve unrelated dirty-worktree files and all recovery/requeue behavior already committed.
- Write and observe a failing test before each production change.

---

### Task 1: Idempotent Android reply landing

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: native completed-turn objects containing `turnId` and stable `replyPartId`.
- Produces: `withNativeTurnApplyLock(turnId, operation)`, a single shared reconcile promise, and deterministic IDs from `nativeReplyBubbleId(turnId, replyPartId, chunkIndex)`.

- [ ] **Step 1: Write the failing concurrent landing contract**

Add a VM-backed test that starts two `applyNativeExecutionTurn(result)` calls whose `applyNativePlanParts` awaits the same barrier, then releases both and asserts that only two expected text bubbles exist rather than four. Also assert that each inserted ID matches the stable native ID format.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test tests/yuqi-ui-contract.test.mjs
```

Expected: FAIL because concurrent applications append duplicate random-ID bubbles.

- [ ] **Step 3: Implement deterministic and serialized landing**

Add module-level state:

```js
let nativeExecutionReconcilePromise = null;
const nativeTurnApplyPromises = new Map();
```

Wrap per-turn application:

```js
function withNativeTurnApplyLock(turnId, operation) {
  const key = String(turnId || '');
  const previous = nativeTurnApplyPromises.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  nativeTurnApplyPromises.set(key, current);
  return current.finally(() => {
    if (nativeTurnApplyPromises.get(key) === current) nativeTurnApplyPromises.delete(key);
  });
}
```

Generate each text bubble ID from turn, reply part, and chunk index. Before insertion, compare the stable ID and preserve the first landed content on a content conflict.

Make `reconcileNativeExecutionTurns()` return its existing in-flight promise instead of starting a second inbox/change/pending traversal.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test tests/yuqi-ui-contract.test.mjs
```

Expected: PASS, including concurrent and replay landing cases.

- [ ] **Step 5: Commit**

```powershell
git add -- tavern-app/index.html tests/yuqi-ui-contract.test.mjs
git commit -m "fix: make native reply landing idempotent"
```

### Task 2: Explicit current batch and real conversation gap

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Modify: `yuqi-runtime/src/interaction-state.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Create: `yuqi-runtime/test/interaction-state.test.mjs`

**Interfaces:**
- Consumes: `input.options.batchId`, `input.options.batchMessageIds`, submission timestamps, and stored messages.
- Produces: envelope `context.currentBatch` and interaction fields `conversationGapMs`, `conversationGapText`, `conversationGapClass`, `previousMessageId`, and `currentBatchMessageIds`.

- [ ] **Step 1: Write failing Android and runtime tests**

Android assertion:

```java
assertEquals("batch_1", envelope.getJSONObject("context").getJSONObject("currentBatch").getString("batchId"));
assertEquals(2, envelope.getJSONObject("context").getJSONObject("currentBatch").getJSONArray("messageIds").length());
```

Runtime assertion:

```js
assert.equal(state.processingDelayMs, 40_000);
assert.equal(state.conversationGapMs, 20 * 60_000);
assert.equal(state.previousMessageId, 'msg_before_batch');
assert.equal(state.conversationGapClass, 'interrupted');
```

The stored list must include the current two-message batch so the test proves they are excluded.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/interaction-state.test.mjs yuqi-runtime/test/orchestrator.test.mjs
cd android
.\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.bridge.BridgeClientTest --no-problems-report
```

Expected: Java context lacks `currentBatch`; runtime reports processing delay as the conversation gap.

- [ ] **Step 3: Implement the envelope boundary and state calculation**

For a direct submission, copy batch metadata into `context.currentBatch`, falling back to the current source message ID for a single message.

Change the state builder signature to accept batch IDs:

```js
export function buildAuthoritativeInteractionState({
  envelope,
  messages = [],
  currentStage = null,
  previousAutomaticResult = null,
  now = Date.now()
})
```

Build a set from `envelope.context?.currentBatch?.messageIds` plus `envelope.message?.messageId`, filter those messages before selecting the previous message, and calculate conversation gap from the batch start to that previous message. Keep `processingDelayMs` based on `now - sourceOccurredAt`.

Pass the same interaction state to memory, brain, and supervisor.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the commands from Step 2.

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java yuqi-runtime/src/interaction-state.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/interaction-state.test.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "fix: calculate pre-turn conversation gaps"
```

### Task 3: Open-topic interruption assessment and human quality gate

**Files:**
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/conversation-context.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/presets/memory-manager.md`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `tavern-app/lib/yuqi-core-preset.js`
- Modify: `yuqi-runtime/test/conversation-context.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: real conversation gap, previous-message evidence, and current batch.
- Produces: `conversationFrame.priorTopic` and `conversationFrame.interruption`, plus supervisor issue guidance for `TEMPORAL_FREEZE`, `META_EXPLANATION`, and `REASSURANCE_LOOP`.

- [ ] **Step 1: Write failing schema, propagation, and preset tests**

Use a frame containing:

```js
priorTopic: {
  status: 'open',
  summary: 'Yuqi was waiting for an answer',
  waitingOn: 'user',
  evidenceMessageIds: ['msg_before_batch'],
  reason: 'the previous question remained unanswered'
},
interruption: {
  requiresReaction: true,
  reactionReason: 'the open topic was interrupted for 20 minutes'
}
```

Assert it survives normalization and reaches brain/supervisor. Assert preset text names the three generic issue codes and says a closed topic does not require mechanical time wording.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/conversation-context.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/preset-registry.test.mjs
```

Expected: schema rejects the new frame fields and preset contract assertions fail.

- [ ] **Step 3: Implement schema, normalization, and prompts**

Add strict object schemas for `priorTopic` and `interruption`. Normalize missing legacy fields to safe `uncertain`/`false` values.

Memory must classify the previous topic from raw evidence; brain must react from the current time only when the topic remains open; supervisor must request rewrite for temporal freeze, unnecessary word-analysis, or repeated reassurance.

Increment the preset manifest version and run the canonical preset sync script.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 and:

```powershell
npm run presets:check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/conversation-context.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/presets/memory-manager.md yuqi-runtime/presets/yuqi-core.md yuqi-runtime/presets/supervisor.md yuqi-runtime/presets/manifest.json tavern-app/lib/yuqi-core-preset.js yuqi-runtime/test/conversation-context.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: make interruptions part of conversation state"
```

### Task 4: Persistent offline life timeline

**Files:**
- Create: `yuqi-runtime/src/life-simulation.mjs`
- Create: `yuqi-runtime/test/life-simulation.test.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Produces: `LifeSimulationCoordinator.ensureHorizon(characterId, now)`, `advanceTo(characterId, now)`, `contextFor(characterId, now)`, and `applyAdjustment(characterId, adjustment, turnId, now)`.
- Store methods: `listLifeEpisodes`, `putLifePlan`, `getCharacterLifeState`, `advanceLifeState`, and `applyLifeAdjustment`.

- [ ] **Step 1: Write failing store and simulation tests**

Cover:

```js
const first = coordinator.advanceTo('yuqi', at('2026-07-23T14:00:00+08:00'));
const afterRestart = restarted.advanceTo('yuqi', at('2026-07-23T17:00:00+08:00'));
assert.equal(afterRestart.current.kind, 'commute');
assert.equal(overlappingEpisodes(afterRestart.recent).length, 0);
```

Also test stable seeded planning, rejected major-event kinds, no duplicate episodes after replay, open-interaction carry, and `PLAN_REPLY_MISMATCH`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/protocol-store.test.mjs
```

Expected: module and SQLite tables do not exist.

- [ ] **Step 3: Add SQLite life tables**

Create `life_episodes` with unique `episode_id`, character/time indexes, canonical payload/checksum, status, and source turn. Create `character_life_state` with one canonical state per character and monotonic revision.

All plan and adjustment writes must run in store transactions. On an ID/checksum replay, return the authoritative first record; on overlap or content conflict, reject and record a diagnostic.

- [ ] **Step 4: Implement deterministic advancement**

The coordinator:

- activates and closes approved episodes at their boundaries;
- catches up after restart without model calls for already planned time;
- derives a stable plan key from character, local date, plan version, and prior state;
- requests `plan_yuqi_life` only when the approved horizon is below six hours;
- exposes only current plus three recent episodes to generation;
- rejects forbidden major-event categories and overlapping plans.

- [ ] **Step 5: Integrate structured life planning and adjustments**

Extend brain output with nullable `lifePlan` for `plan_yuqi_life` and nullable `lifeAdjustment` for normal turns. The supervisor sees the proposed plan/adjustment and existing timeline. Apply it only when the reply reaches `approved` and commit it in the same orchestrator completion transaction as the reply result.

Run the coordinator before memory for direct, proactive, moment, and role-plan turns. Start a low-cost boundary timer in `main.mjs`; processing a turn always performs lazy catch-up first.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/orchestrator.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- yuqi-runtime/src/life-simulation.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/main.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: persist yuqi offline life simulation"
```

### Task 5: Dual-axis automatic relationship state

**Files:**
- Modify: `yuqi-runtime/src/relationship-stage.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/presets/memory-manager.md`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/test/relationship-stage.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java`
- Modify: `tavern-app/index.html`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: `relationshipReview.base` and `relationshipReview.phase` with verified message IDs.
- Produces: combined state `{ base, phase }` and reply action `{ baseAction, phaseAction }`.

- [ ] **Step 1: Write failing runtime, Android, and UI tests**

Runtime cases:

- verified `new → acquainted`;
- one friendly message remains `new`;
- sustained distancing permits adjacent base regression;
- `familiar · normal → familiar · conflict`;
- one disagreement does not enter conflict;
- conflict cannot become normal only because time passed.

Android must parse a relationship marker containing only nested `baseAction`/`phaseAction`. UI must atomically apply both, display `熟悉 · 闹矛盾期`, preserve history, and accept a legacy top-level `from/to`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/orchestrator.test.mjs tests/yuqi-ui-contract.test.mjs
cd android
.\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.api.ReplyParserTest --no-problems-report
```

Expected: schema/resolver/UI support only the single base axis.

- [ ] **Step 3: Implement dual-axis resolver and evidence rules**

Normalize legacy state to:

```js
{
  base: { id: 'new', label: '初识', ... },
  phase: { id: 'normal', label: '正常相处', ... }
}
```

Validate both reviews independently. Base changes require at least two available evidence IDs, adjacent movement unless explicit mutual change, and confidence at least `0.82`. Phase changes require at least two evidence IDs except explicit acknowledged conflict/repair, and must not use elapsed time alone.

Update memory instructions with concrete upgrade, regression, conflict, cooling, and repair evidence rules.

- [ ] **Step 4: Implement Android and UI writeback**

Allow `ReplyParser` to emit `RELATIONSHIP_STAGE` when top-level `to`, `baseAction`, or `phaseAction` is present.

Extend stage-persona config with phase catalog/current phase, migrate old state to `normal`, apply nested actions atomically, display the combined label, and keep manual edit/history/undo support.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the commands from Step 2.

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- yuqi-runtime/src/relationship-stage.mjs yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/presets/memory-manager.md yuqi-runtime/presets/yuqi-core.md yuqi-runtime/presets/supervisor.md yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/orchestrator.test.mjs android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java tavern-app/index.html tests/yuqi-ui-contract.test.mjs
git commit -m "feat: automate dual-axis relationship stages"
```

### Task 6: Full verification and runtime handoff

**Files:**
- Modify if versioning requires: `android/app/build.gradle`
- Create: `artifacts/qa/yuqi-lived-continuity-verification.json`

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: a clean test report and a runtime preset/version that the background service can load.

- [ ] **Step 1: Run all JavaScript tests**

```powershell
npm test
```

Expected: PASS with no failed tests.

- [ ] **Step 2: Run Android unit tests and debug build**

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebug --no-problems-report
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Verify the actual service configuration**

Restart the Yuqi background service only after the code and synced preset version are committed. Verify `/health` reports the new preset and use a controlled test turn to inspect:

- distinct processing delay and conversation gap;
- life timeline current/recent episodes;
- one confirmed delivery and one set of phone bubbles;
- current base/phase relationship state.

- [ ] **Step 4: Save the QA artifact and commit**

Write exact test counts, build output path, runtime health version, controlled turn ID, and any remaining non-blocking limitations to `artifacts/qa/yuqi-lived-continuity-verification.json`.

```powershell
git add -- android/app/build.gradle artifacts/qa/yuqi-lived-continuity-verification.json
git commit -m "test: verify yuqi lived continuity release"
```
