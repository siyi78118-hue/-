# Yuqi General Conversation Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add general per-turn pragmatic understanding, deduplicated short generation context, risk-based supervision, and bounded role-thread history without case-specific reply rules.

**Architecture:** The existing memory role emits an ephemeral `conversationFrame` beside evidence and relationship review. The orchestrator keeps the 200-message evidence window, builds a 24-message deduplicated generation window, and upgrades only nuanced turns to the existing supervisor. Codex role sessions remain isolated and persistent but rotate after 24 turns.

**Tech Stack:** Node.js ESM, `node:test`, SQLite via `node:sqlite`, Codex App Server JSON-RPC, Markdown prompt modules, Android/Capacitor Gradle release build.

## Global Constraints

- Baseline is commit `7e9e681`; preserve its relationship-stage, moment, payment, and scene-continuity behavior.
- Do not add a fourth role or model call.
- Do not commit `conversationFrame` candidates to facts, vector memory, or the user profile.
- Raw messages remain authoritative; pragmatic hypotheses are advisory and evidence-linked.
- Memory evidence window remains 200 messages; brain and supervisor generation window defaults to 24 messages.
- Current user message appears exactly once in brain and supervisor input.
- Fast turns remain fast unless the frame requests nuance review.
- No production rule may mention the reproduced “废话” text or prescribe one exact reply.

---

### Task 1: Ephemeral Conversation Frame Contract

**Files:**
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/presets/memory-manager.md`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Test: `yuqi-runtime/test/codex-client.test.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Produces: `memoryResult.conversationFrame` and `memoryPacket.conversationFrame`.
- Consumes: original message IDs already present in `recentMessages`.

- [ ] **Step 1: Write failing schema and propagation tests**

Add assertions that the strict memory schema requires `conversationFrame`, with evidence-linked hypotheses, initiative, ambiguity, risk, and `needsNuanceReview`. Add an orchestrator test whose fake memory output includes a general frame and assert the exact frame reaches the brain request but does not appear in `store.listFacts()`.

```js
assert.ok(started.params.outputSchema.required.includes('conversationFrame'));
assert.deepEqual(brain.conversationFrame, memoryFrame);
assert.equal(store.listFacts('yuqi').some(fact => fact.predicate === 'possibleIntent'), false);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/test/orchestrator.test.mjs`  
Expected: FAIL because `conversationFrame` is absent from the schema and brain request.

- [ ] **Step 3: Add the strict frame schema and prompt boundary**

Define a strict nested schema equivalent to:

```js
const conversationFrameSchema = objectSchema({
  surfaceAct: { type: 'string' },
  intentHypotheses: { type: 'array', items: objectSchema({
    intent: { type: 'string' }, confidence: { type: 'number' }, evidenceMessageIds: stringArray()
  }, ['intent', 'confidence', 'evidenceMessageIds']) },
  interactionMode: { type: 'string' },
  emotionalTone: { type: 'string' },
  relationshipMove: { type: 'string' },
  initiative: objectSchema({
    topicIntroducedBy: { type: 'string' }, suggestedNextCarrier: { type: 'string' }, reason: { type: 'string' }
  }, ['topicIntroducedBy', 'suggestedNextCarrier', 'reason']),
  activeHooks: stringArray(), ambiguities: stringArray(), responseRisks: stringArray(),
  needsNuanceReview: { type: 'boolean' }
}, [/* every key above */]);
```

The memory prompt must state that this is a current-turn hypothesis, not durable evidence, and must cite raw message IDs. Copy the normalized object into `memoryPacket` and then brain/supervisor input; never pass it to `commitVerifiedFacts`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the two tests above. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/role-schemas.mjs yuqi-runtime/presets/memory-manager.md yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: add ephemeral conversation frames"
```

### Task 2: Deduplicated Generation Window

**Files:**
- Create: `yuqi-runtime/src/conversation-context.mjs`
- Create: `yuqi-runtime/test/conversation-context.test.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Produces: `buildGenerationWindow(messages, { currentMessageId, limit = 24 })`.
- Consumes: ordered message objects from `YuqiStore.listMessages`.

- [ ] **Step 1: Write failing window tests**

```js
const window = buildGenerationWindow(messages, { currentMessageId: 'msg_current', limit: 24 });
assert.equal(window.length, 24);
assert.equal(window.some(item => item.messageId === 'msg_current'), false);
assert.deepEqual(window.map(item => item.sentAt), [...window.map(item => item.sentAt)].sort((a, b) => a - b));
```

Add an orchestrator test proving memory receives 200 records while brain and supervisor receive 24 and exclude `currentUserMessage.messageId`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/conversation-context.test.mjs yuqi-runtime/test/orchestrator.test.mjs`  
Expected: FAIL because the helper and split limits do not exist.

- [ ] **Step 3: Implement the pure helper and split limits**

```js
export function buildGenerationWindow(messages, { currentMessageId = '', limit = 24 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 24));
  return [...messages]
    .filter(message => message?.messageId && message.messageId !== currentMessageId)
    .sort((a, b) => Number(a.sentAt || 0) - Number(b.sentAt || 0))
    .slice(-safeLimit);
}
```

Keep `memoryContextLimit = 200`, add `generationContextLimit = 24`, and use the short window only in brain/supervisor requests. Build authoritative interaction state from the wider stored history so time and unanswered-count logic remain intact.

- [ ] **Step 4: Run tests and verify GREEN**

Run the two tests above. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/conversation-context.mjs yuqi-runtime/test/conversation-context.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/main.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: bound yuqi generation context"
```

### Task 3: Semantic Risk Upgrade Without Repeating Memory

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: `memoryPacket.conversationFrame.needsNuanceReview` and evidence-linked risk fields.
- Produces: route `fast_to_deep` with reason `conversation_nuance`, using the existing supervisor path.

- [ ] **Step 1: Write failing risk-route tests**

Create two generic cases: one frame with `needsNuanceReview: false` that calls memory and brain only; one with `true` that calls memory, brain, supervisor without a second memory call. Assert no test or prompt contains a reproduced user phrase.

```js
assert.deepEqual(codex.calls.map(call => call.role), ['memory', 'brain', 'supervisor']);
assert.equal(codex.calls.filter(call => call.role === 'memory').length, 1);
assert.equal(store.getTurn(turnId).route, 'fast_to_deep');
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/preset-registry.test.mjs`  
Expected: FAIL because conversation nuance does not upgrade the route.

- [ ] **Step 3: Implement risk-based upgrade and high-priority generation guidance**

After memory normalization, call `setTurnRoute(turnId, 'fast_to_deep', ['conversation_nuance'])` when the frame requests review and the current route is fast. Do not rerun memory. Put a short general instruction at the end of the brain and supervisor prompt modules: infer interaction from raw evidence, preserve ambiguity, and reject drafts that merely classify, score, paraphrase, or transfer an initiative obligation when the frame indicates another conversational move. Do not add lexical blacklists or exact target text.

- [ ] **Step 4: Run tests and verify GREEN**

Run the two tests above. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/presets/supervisor.md yuqi-runtime/presets/yuqi-core.md yuqi-runtime/presets/manifest.json yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: supervise nuanced yuqi turns"
```

### Task 4: Bounded Dedicated Role Threads

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`
- Test: `yuqi-runtime/test/codex-client.test.mjs`

**Interfaces:**
- Produces: `getSessionState(role)`, `incrementSessionTurnCount(role)`, persisted `sessions.turn_count`.
- Consumes: `CodexAppServerClient({ maxRoleTurns: 24 })`.

- [ ] **Step 1: Write failing persistence and rotation tests**

Test that `setSession` resets count, increment persists across reopening, and a client with `maxRoleTurns: 2` uses one thread for two turns then starts a new same-role thread for the third. Assert memory, brain, and supervisor remain isolated.

```js
assert.deepEqual(store.getSessionState('brain'), { threadId: 'thr_brain', turnCount: 2 });
assert.notEqual(third.threadId, first.threadId);
assert.equal(store.getSession('brain'), third.threadId);
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/codex-client.test.mjs`  
Expected: FAIL because session counts and rotation do not exist.

- [ ] **Step 3: Add migration and serialized rotation**

Add `turn_count INTEGER NOT NULL DEFAULT 0` to new and existing databases. `setSession` must reset it to zero. Immediately after a successful `turn/start`, increment the count. Before ensuring a thread, rotate when persisted count is at least `maxRoleTurns`. Existing per-role promise/queue serialization prevents concurrent rotation races. If starting the replacement fails, retain the stored session and propagate the existing protocol error.

- [ ] **Step 4: Run tests and verify GREEN**

Run the two tests above. Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/store.mjs yuqi-runtime/src/codex-client.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/codex-client.test.mjs
git commit -m "feat: rotate bounded yuqi role threads"
```

### Task 5: Regression, Runtime Deployment, and APK

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `scripts/verify-yuqi-runtime.mjs`
- Create: `artifacts/AL-1.0.87-yuqi-conversation-understanding-unsigned.apk`
- Create when signing material is available: `artifacts/AL-1.0.87-yuqi-conversation-understanding-formal-signed.apk`

**Interfaces:**
- Consumes: all commits from Tasks 1–4.
- Produces: tested runtime code and an installable APK artifact.

- [ ] **Step 1: Run focused and full tests**

Run:

```powershell
node --test yuqi-runtime/test/*.test.mjs
npm test
```

Expected: all tests PASS; no new runtime or contract failures.

- [ ] **Step 2: Restart the PC runtime and verify health**

Run the existing stop/start scripts, then verify `/v1/health` reports `ok: true`, all three role threads available, cloud relay connected, and no startup error. Do not requeue or alter unrelated historical turns.

- [ ] **Step 3: Run real-model cross-scenario sampling**

Use generic fixtures covering literal/nonliteral ambiguity, correction, emotional disclosure, ordinary question, initiative continuity, and uncertain intent. Verify the stored frame is evidence-linked and ephemeral, risk turns reach supervisor, ordinary turns remain fast, and no test depends on one exact reply.

- [ ] **Step 4: Build Android artifact**

Set Android `versionCode 87` and `versionName 1.0.87`, update the matching verification contract, and use the project Gradle wrapper. Copy the resulting APK into `artifacts/` with the exact descriptive name above. If the formal PKCS12 key is unavailable locally, keep the unsigned APK and use the configured GitHub Actions signing workflow only after explicit push authorization.

- [ ] **Step 5: Verify APK identity**

Use Android build tools to verify package `com.siyi.al`, version code/name, v2/v3 signature when signed, and SHA-256 signer certificate `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.

- [ ] **Step 6: Commit implementation and report artifact**

Stage only intended tracked source, test, preset, and version files. Do not stage unrelated deleted `zhaxian-workbench` files or untracked user assets. Report the absolute APK path and whether it supports direct overwrite installation.
