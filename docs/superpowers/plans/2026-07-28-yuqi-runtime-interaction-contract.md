# Yuqi Runtime Interaction Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dedicated `yuqi-runtime` chain convert memory analysis into an authoritative, evidence-backed interaction contract so chat and supervisor stop repeating literal misreads, respect structural silence, and reject report-like dialogue.

**Architecture:** Add a pure `interaction-contract.mjs` domain module between memory and brain. Memory still returns multiple hypotheses, while the compiler validates evidence IDs, preserves ambiguity, adds conflict/correction constraints, and decides structural silence for proactive turns. Brain and supervisor receive the compact contract; the supervisor enforces action consistency and natural dialogue through executable rewrite contracts.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema role outputs, SQLite-backed runtime store, existing Codex role orchestrator.

## Global Constraints

- Modify only `yuqi-runtime`, its tests, and its dedicated presets.
- Do not modify `tavern-app`, Android UI/execution, moments, payments, Cloudflare, or cloud timer behavior.
- Do not add another model call or raise model/effort defaults.
- Keep memory context at 200 evidence messages and brain/supervisor context at 20 complete send batches.
- Structural silence must not consume or be overridden by the ordinary one-skip-per-four-proactive-turn budget.
- A temporary intent hypothesis or correction must never become a durable user fact.
- Use complete multi-turn scenarios; do not implement phrase-specific keyword rules.

---

### Task 1: Pure Interaction Contract Compiler

**Files:**
- Create: `yuqi-runtime/src/interaction-contract.mjs`
- Create: `yuqi-runtime/test/interaction-contract.test.mjs`

**Interfaces:**
- Consumes: `compileInteractionContract({ envelope, scene, interactionState, conversationFrame, recentMessages })`
- Produces: a normalized `interactionContract` with `schemaVersion`, `shouldRespond`, `structuralSilenceReason`, `primaryIntent`, `primaryIntentConfidence`, `alternativeIntent`, `preserveAmbiguity`, `activeIssue`, `initiativeOwner`, `explicitBoundaries`, `mustAddress`, `forbiddenMoves`, `recentCorrection`, and `evidenceMessageIds`.

- [ ] **Step 1: Write failing normalization and ambiguity tests**

```js
test('compiles a compact contract and preserves plausible ambiguity', () => {
  const result = compileInteractionContract({
    envelope: directEnvelope('你干嘛？'),
    scene: conflictScene(),
    interactionState: { unansweredOutgoingCount: 3 },
    recentMessages: conflictHistory(),
    conversationFrame: frame({
      intentHypotheses: [
        hypothesis('询问虞栖此刻在做什么', 0.70, ['u_now']),
        hypothesis('质问虞栖为何无视未解决争执继续闲聊', 0.42, ['u_pause', 'u_now'])
      ],
      priorTopic: openTopic('user', ['u_pause']),
      ambiguities: ['字面询问与互动质问同时可能']
    })
  });
  assert.equal(result.preserveAmbiguity, true);
  assert.equal(result.activeIssue, '双方争执仍未解决');
  assert.ok(result.mustAddress.includes('回应仍然开放的争执或其造成的互动张力'));
  assert.ok(result.evidenceMessageIds.every(id => conflictHistory().some(message => message.messageId === id)));
});
```

- [ ] **Step 2: Write failing structural silence test**

```js
test('an unresolved pause creates structural silence before proactive generation', () => {
  const result = compileInteractionContract({
    envelope: proactiveEnvelope(),
    scene: conflictScene(),
    interactionState: { unansweredOutgoingCount: 3, waitingForUserReply: true },
    recentMessages: conflictHistory(),
    conversationFrame: frame({
      initiative: { suggestedNextCarrier: 'user' },
      priorTopic: openTopic('user', ['u_pause'])
    })
  });
  assert.equal(result.shouldRespond, false);
  assert.equal(result.structuralSilenceReason, 'open_conflict_waiting_for_user');
});
```

- [ ] **Step 3: Run tests and verify missing-module failure**

Run: `node --test yuqi-runtime/test/interaction-contract.test.mjs`

Expected: FAIL because `interaction-contract.mjs` does not exist.

- [ ] **Step 4: Implement the compiler**

Implementation requirements:

```js
export function compileInteractionContract(input) {
  const validIds = new Set(input.recentMessages.map(message => String(message.messageId)));
  const frame = normalizeFrame(input.conversationFrame, validIds);
  const conflictOpen = frame.priorTopic.status === 'open'
    && ['user', 'either'].includes(frame.priorTopic.waitingOn);
  const initiativeOwner = normalizeInitiative(frame.initiative.suggestedNextCarrier);
  const structuralSilence = input.envelope.kind === 'PROACTIVE_CHAT'
    && conflictOpen
    && initiativeOwner === 'user'
    && Number(input.interactionState.unansweredOutgoingCount || 0) > 0;

  return freezeContract({
    schemaVersion: 1,
    shouldRespond: !structuralSilence,
    structuralSilenceReason: structuralSilence ? 'open_conflict_waiting_for_user' : '',
    primaryIntent: frame.intentHypotheses[0]?.intent || frame.surfaceAct,
    primaryIntentConfidence: frame.intentHypotheses[0]?.confidence || 0,
    alternativeIntent: frame.intentHypotheses[1]?.intent || '',
    preserveAmbiguity: shouldPreserveAmbiguity(frame),
    activeIssue: conflictOpen ? frame.priorTopic.summary : '',
    initiativeOwner,
    explicitBoundaries: frame.explicitBoundaries,
    mustAddress: deriveMustAddress(frame, input.scene),
    forbiddenMoves: deriveForbiddenMoves(frame),
    recentCorrection: frame.recentCorrection,
    evidenceMessageIds: collectValidEvidence(frame, validIds)
  });
}
```

No text matching against “？”, “你干嘛”, or any fixed user phrase is allowed.

- [ ] **Step 5: Run compiler tests**

Run: `node --test yuqi-runtime/test/interaction-contract.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- yuqi-runtime/src/interaction-contract.mjs yuqi-runtime/test/interaction-contract.test.mjs
git commit -m "feat: compile authoritative interaction contracts"
```

### Task 2: Memory Contract Fields and Preset Guidance

**Files:**
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `yuqi-runtime/presets/memory-manager.md`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: memory role JSON.
- Produces: optional `conversationFrame.explicitBoundaries` and `conversationFrame.recentCorrection` fields that remain ephemeral.

- [ ] **Step 1: Write failing schema/preset tests**

Add assertions that the memory schema accepts:

```js
explicitBoundaries: [{
  type: 'pause_requested',
  active: true,
  reason: '用户明确要求在条件满足前暂停讨论',
  evidenceMessageIds: ['u_pause']
}],
recentCorrection: {
  active: true,
  rejectedInterpretation: '用户只是在询问虞栖的当前活动',
  expiresAfterBatches: 2,
  evidenceMessageIds: ['u_correction']
}
```

Assert the compiled memory preset states:

- intent ordering must consider the whole interaction rather than surface syntax;
- conflict/cooling/open-topic evidence outranks an isolated literal reading when both are supported;
- corrections are temporary and evidence-backed;
- analysis fields must not contain sendable dialogue.

- [ ] **Step 2: Run focused tests**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: FAIL on the new schema or preset assertions.

- [ ] **Step 3: Extend schema and memory preset**

Add optional fields to `conversationFrameSchema` without making them required for old checkpoints:

```js
explicitBoundaries: {
  type: 'array',
  items: objectSchema({
    type: { type: 'string' },
    active: { type: 'boolean' },
    reason: { type: 'string' },
    evidenceMessageIds: stringArray()
  }, ['type', 'active', 'reason', 'evidenceMessageIds'])
},
recentCorrection: objectSchema({
  active: { type: 'boolean' },
  rejectedInterpretation: { type: 'string' },
  expiresAfterBatches: { type: 'integer' },
  evidenceMessageIds: stringArray()
}, ['active', 'rejectedInterpretation', 'expiresAfterBatches', 'evidenceMessageIds'])
```

Update the memory preset with general evidence-priority rules rather than example phrases.
Raise the packaged immutable preset version from `1.9.0` to `1.9.1` so an existing production database promotes the new memory, brain, and supervisor modules instead of reopening the old stored `1.9.0` snapshot.

- [ ] **Step 4: Run focused tests**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- yuqi-runtime/src/role-schemas.mjs yuqi-runtime/presets/manifest.json yuqi-runtime/presets/memory-manager.md yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: capture interaction boundaries and corrections"
```

### Task 3: Wire the Contract into the Dedicated Runtime

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `compileInteractionContract(...)` from Task 1.
- Produces: `memoryPacket.interactionContract`, `brainRequest.interactionContract`, and `supervisorRequest.interactionContract`.

- [ ] **Step 1: Write failing propagation test**

```js
test('dedicated runtime sends the same authoritative contract to brain and supervisor', async () => {
  await withConflictFixture(async ({ codex, orchestrator }) => {
    await orchestrator.process(directEnvelope('你干嘛？'));
    const brain = codex.calls.find(call => call.role === 'brain').input;
    const supervisor = codex.calls.find(call => call.role === 'supervisor').input;
    assert.deepEqual(supervisor.interactionContract, brain.interactionContract);
    assert.equal(brain.interactionContract.activeIssue, '双方争执仍未解决');
    assert.equal(brain.interactionContract.preserveAmbiguity, true);
  });
});
```

- [ ] **Step 2: Write failing structural-silence orchestration test**

```js
test('structural silence commits without calling brain and does not consume ordinary skip budget', async () => {
  await withConflictFixture(async ({ store, codex, orchestrator }) => {
    const before = store.getProactiveChatDeliveryPolicy('yuqi');
    const result = await orchestrator.process(proactiveEnvelope());
    const after = store.getProactiveChatDeliveryPolicy('yuqi');
    assert.equal(result.action, 'skip');
    assert.deepEqual(codex.calls.map(call => call.role), ['memory']);
    assert.equal(after.usedSkips, before.usedSkips);
    assert.ok(store.listDiagnostics(result.turnId).some(item =>
      item.detail.action === 'structural_silence'
    ));
  });
});
```

- [ ] **Step 3: Run focused orchestrator tests**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`

Expected: FAIL because the runtime does not compile, propagate, or short-circuit on the contract.

- [ ] **Step 4: Compile and store the contract after memory**

In `completeMemory()`:

```js
const interactionContract = compileInteractionContract({
  envelope,
  scene: { ...scene, relationshipStage: relationship.stage },
  interactionState,
  conversationFrame,
  recentMessages
});

const memoryPacket = {
  ...existingFields,
  conversationFrame,
  interactionContract
};
```

- [ ] **Step 5: Apply structural silence before brain**

When state is `memory_done`, parse `memoryPacket.interactionContract`. For `PROACTIVE_CHAT` with `shouldRespond === false`, advance directly to `approved` using a normalized skip draft and a `structural_silence` diagnostic. Do not call `deliveryPolicyFor()` and do not write a normal skip-budget record.

- [ ] **Step 6: Propagate the contract**

Pass the exact normalized contract to brain and supervisor. Keep `conversationFrame` available to supervisor for evidence audit, but remove it from the brain request so analytical labels do not leak into dialogue.

- [ ] **Step 7: Run focused tests**

Run: `node --test yuqi-runtime/test/interaction-contract.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add -- yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: enforce interaction contracts in yuqi runtime"
```

### Task 4: Contract-Aware Brain and Supervisor

**Files:**
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `interactionContract`.
- Produces: executable `DIALOGUE_META_NARRATION`, `INTERACTION_CONTRACT_MISS`, and `REPEATED_REJECTED_INTERPRETATION` rewrite issues.

- [ ] **Step 1: Write failing preset and rewrite tests**

Assert the brain preset says:

- contract facts are authoritative while intent remains evidence-bounded;
- `preserveAmbiguity` requires a reply robust to the primary and alternative interpretation;
- internal fields are not a checklist and must never be paraphrased.

Assert the supervisor preset says:

- action consistency is checked before style;
- repeating a rejected interpretation returns `REPEATED_REJECTED_INTERPRETATION`;
- narrating the complete interaction analysis returns `DIALOGUE_META_NARRATION`;
- each issue includes concrete `mustPreserve`, `mustChange`, `allowedStrategies`, and `acceptanceCriteria`.

- [ ] **Step 2: Run focused tests**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: FAIL on the new contract requirements.

- [ ] **Step 3: Update brain and supervisor presets**

Brain guidance must distinguish:

```text
互动契约规定“本轮不能忽略什么”，不规定“必须说哪句话”。
先在世界内产生虞栖此刻的真实反应，再写可见正文。
不得逐项解释 primaryIntent、activeIssue、mustAddress 或 forbiddenMoves。
```

Supervisor guidance must apply the real-person counterfactual:

```text
判断这段话是身处对话的人会直接发出的，还是只有复盘对话的人才会这样概括。
若属于后者，使用 DIALOGUE_META_NARRATION，并要求删除分析过程、保留真实态度。
```

- [ ] **Step 4: Add executable rewrite regression**

Simulate a supervisor returning:

```json
{
  "decision": "rewrite",
  "issues": [{
    "issueId": "DIALOGUE_META_NARRATION:1",
    "code": "DIALOGUE_META_NARRATION",
    "severity": "soft",
    "message": "草稿在总结自己的互动行为，而不是身处争执作出反应",
    "mustPreserve": ["仍然在意并想继续联系"],
    "mustChange": ["删除对自己回复策略和外在观感的完整因果总结"],
    "allowedStrategies": ["只留下当下承认、停顿、心虚或仍未解决的态度"],
    "acceptanceCriteria": ["正文不再概括自己为什么这样说以及看起来像什么"]
  }]
}
```

Assert the next brain call receives the stable rewrite contract and the second supervisor reviews its resolution.

- [ ] **Step 5: Run focused tests**

Run: `node --test yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add -- yuqi-runtime/presets/yuqi-core.md yuqi-runtime/presets/supervisor.md yuqi-runtime/test/preset-registry.test.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "fix: keep interaction analysis out of yuqi dialogue"
```

### Task 5: Full Regression, Runtime Restart, and Delivery Verification

**Files:**
- Modify only if a failing test reveals an in-scope defect.
- Verify: `yuqi-runtime/package.json`, project root `package.json`, runtime launch documentation.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: passing runtime and project regression evidence plus a restarted dedicated service.

- [ ] **Step 1: Run the dedicated runtime suite**

Run: `npm test` from `yuqi-runtime`.

Expected: all tests PASS with no skipped interaction-contract tests.

- [ ] **Step 2: Run root contract tests**

Run: `npm test` from the project root.

Expected: all existing Web, Service Worker, Android contract, preset, and UI tests PASS.

- [ ] **Step 3: Replay the production failure shape**

Run the focused scenario test containing:

1. unresolved disagreement;
2. explicit request to pause;
3. multiple proactive triggers;
4. ambiguous short user challenge;
5. explicit correction;
6. supervisor rewrite of report-like dialogue.

Expected: structural silence before the user returns, contract ambiguity on the short challenge, correction lock after explicit correction, and no report-style approved draft.

- [ ] **Step 4: Restart the dedicated runtime service**

Use the existing project launcher or service command identified from project documentation. Confirm the health endpoint reports the new preset/runtime version and the process is listening on the configured bridge port.

- [ ] **Step 5: Determine whether an APK rebuild is technically required**

If no Android/Web packaged file changed, do not publish a meaningless APK version; document that the behavior update is server-side and becomes active after runtime restart. If a regression fix necessarily changes packaged files, increment the Android version and follow `docs/AL-android-signing-runbook.md`, then verify package name, version, v2 signature validity, certificate SHA-256 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`, previous-certificate consistency, and file SHA-256.

- [ ] **Step 6: Commit any final in-scope fixes**

```powershell
git status --short
git add -- <only-files-modified-by-this-plan>
git commit -m "test: cover yuqi interaction contract scenarios"
```
