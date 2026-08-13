# Yuqi Implicit Understanding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cognition use hidden social understanding to choose Yuqi's response without forcing expression to narrate or prove that understanding.

**Architecture:** Add immutable preset version `2.1.1` and a version-gated, machine-readable disclosure policy in the cognition-to-expression boundary. Reuse the existing `DIALOGUE_META_NARRATION` supervisor finding for high-risk semantic review, while preserving `2.1.0` behavior and adding no ordinary-turn model call.

**Tech Stack:** Node.js ESM, `node:test`, Markdown preset modules, JSON preset manifest.

## Global Constraints

- Do not modify any file under `yuqi-runtime/presets/2.1.0/`.
- Do not change cognition/expression schemas, database schema, Android wire protocol, model names, or reasoning effort.
- Do not add a reviewer call to low-risk turns.
- `interactionRead` and `selfResponse` remain private and absent from the expression brief.
- Default disclosure is implicit; explicit interpretation is limited to user request, necessary repair, or safety/consent.
- Preserve unrelated dirty-worktree changes and stage only files named by this plan.

---

### Task 1: Freeze the `2.1.1` behavior preset

**Files:**
- Create: `yuqi-runtime/presets/2.1.1/cognition-core-v3.md`
- Create: `yuqi-runtime/presets/2.1.1/expression-v3.md`
- Create: `yuqi-runtime/presets/2.1.1/supervisor-v3.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: preset manifest schema v2 and `PresetRegistry.initializeSeed()` immutable checksum enforcement.
- Produces: resolvable preset version `2.1.1` with the same six module names as `2.1.0`.

- [ ] **Step 1: Write the failing preset registry test**

Add a test that asserts `2.1.1` is seeded without changing the stored checksum of `2.1.0`, and that its three changed modules contain the following structural requirements:

```js
test('2.1.1 separates private understanding from public dialogue obligations', () =>
  withRegistry((registry, store) => {
    const previous = store.getPresetVersion('2.1.0');
    const preset = store.getPresetVersion('2.1.1');
    assert.ok(previous);
    assert.ok(preset);
    assert.match(preset.modules.cognition, /mustConvey.*公开互动义务.*不是.*心理诊断/s);
    assert.match(preset.modules.expression, /理解.*决定.*回应.*不是.*台词素材/s);
    assert.match(preset.modules.supervisor, /证明.*懂.*DIALOGUE_META_NARRATION/s);
    assert.equal(store.getPresetVersion('2.1.0').checksum, previous.checksum);
  }));
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/preset-registry.test.mjs
```

Expected: FAIL because preset version `2.1.1` is unavailable.

- [ ] **Step 3: Add the immutable preset version**

Register this manifest entry without changing `currentVersion`:

```json
"2.1.1": {
  "modules": {
    "foundation": "2.1.0/foundation.md",
    "cognition": "2.1.1/cognition-core-v3.md",
    "socialExperience": "2.1.0/social-experience-v3.json",
    "expression": "2.1.1/expression-v3.md",
    "consolidation": "2.1.0/consolidation-v3.md",
    "supervisor": "2.1.1/supervisor-v3.md"
  }
}
```

The cognition module must state that `interactionRead`/`selfResponse` are private, and that `mustConvey` contains observable public interaction obligations rather than phrases or diagnoses. The expression module must state that understanding guides response choice but is not dialogue material, and that `mustConvey` is not copied verbatim. The supervisor module must classify cognition-vs-expression ownership using `DIALOGUE_META_NARRATION` and preserve the actual interaction move during repair.

- [ ] **Step 4: Run the preset test and verify GREEN**

Run:

```powershell
node --test yuqi-runtime/test/preset-registry.test.mjs
```

Expected: all tests PASS, including old-version immutability and the new prompt contract.

- [ ] **Step 5: Commit Task 1**

```powershell
git add yuqi-runtime/presets/manifest.json yuqi-runtime/presets/2.1.1 yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: add implicit-understanding preset"
```

---

### Task 2: Carry one disclosure policy through expression and supervision

**Files:**
- Modify: `yuqi-runtime/src/cognition-v3-contract.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/lived-quality-supervisor.mjs`
- Modify: `yuqi-runtime/test/cognition-v3-contract.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`
- Modify: `yuqi-runtime/test/lived-quality-supervisor.test.mjs`

**Interfaces:**
- Consumes: pinned `turn.presetVersion` and the normalized cognition-v3 result.
- Produces: `compileUnderstandingDisclosurePolicyV3(presetVersion): object | null`; optional `expressionBrief.disclosurePolicy`; optional supervisor reviewer `disclosurePolicy`.

- [ ] **Step 1: Write failing contract tests**

Add tests requiring the following exact policy for `2.1.1`:

```js
{
  version: 1,
  defaultMode: 'implicit',
  understandingUse: 'guide_response_not_dialogue',
  mustConveyUse: 'public_interaction_obligations',
  unaskedInterpretationLimit: 0,
  explicitExceptions: [
    'user_requested_interpretation',
    'repair_requires_clarification',
    'safety_or_consent'
  ]
}
```

Assert that a `2.1.0` brief has no `disclosurePolicy`, and that neither brief serializes `primarySocialMeaning`, `alternativeMeaning`, `confidence`, `immediateFeeling`, `desire`, or `resistance`.

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/cognition-v3-contract.test.mjs
```

Expected: FAIL because `compileUnderstandingDisclosurePolicyV3` and `disclosurePolicy` do not exist.

- [ ] **Step 3: Implement the version-gated policy**

In `cognition-v3-contract.mjs`, add a frozen constant and a pure version-floor helper. Return a structured clone only for semantic versions in the `2.1` line whose patch is at least `1`; return `null` for missing, malformed, `2.1.0`, and other major/minor lines. Extend `compileExpressionBriefV3()` with optional `presetVersion`; append `disclosurePolicy` only when the helper returns a policy. Do not add private cognition fields.

- [ ] **Step 4: Verify contract tests GREEN**

Run the same contract command. Expected: all tests PASS.

- [ ] **Step 5: Write failing pipeline and supervisor propagation tests**

Add one pinned `2.1.1` pipeline case asserting:

```js
assert.deepEqual(expressionCall.payload.expressionBrief.disclosurePolicy, expectedPolicy);
assert.deepEqual(reviewInputs[0].disclosurePolicy, expectedPolicy);
```

Add one high-risk supervisor case asserting the reviewer receives the exact policy, and retain the existing low-risk test proving the reviewer is not called.

- [ ] **Step 6: Run the propagation tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/lived-quality-supervisor.test.mjs
```

Expected: FAIL because the policy is not propagated.

- [ ] **Step 7: Implement one shared propagation path**

Pass `input.turn?.presetVersion` into `compileExpressionBriefV3()`. Return the generated `expressionBrief` from `runV3Expression()`, carry the current brief through first expression and rewrite attempts, and pass only its `disclosurePolicy || null` into `reviewV3Draft()`. In `superviseLivedTurn()`, add `disclosurePolicy` to the high-risk reviewer payload. Do not change `highRisk` selection or call counts.

- [ ] **Step 8: Verify propagation and focused regression GREEN**

Run:

```powershell
node --test yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/lived-quality-supervisor.test.mjs yuqi-runtime/test/preset-registry.test.mjs
```

Expected: all focused tests PASS with no skipped tests.

- [ ] **Step 9: Run the runtime regression gate**

Run:

```powershell
npm.cmd test --prefix yuqi-runtime
```

Expected: all `yuqi-runtime` tests PASS. If the package exposes only the repository-level test script, use `npm.cmd test` from the repository root and report the exact suite count.

- [ ] **Step 10: Commit Task 2**

```powershell
git add yuqi-runtime/src/cognition-v3-contract.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/src/lived-quality-supervisor.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/lived-quality-supervisor.test.mjs
git commit -m "feat: keep Yuqi understanding implicit"
```

## Self-Review

- Spec coverage: Task 1 freezes the three role instructions; Task 2 adds the shared machine-readable boundary and carries it to expression and high-risk review.
- Placeholder scan: no TBD/TODO/“similar to” steps remain.
- Type consistency: the policy keys and values are identical in the design, Task 2 contract, expression brief, reviewer payload, and tests.
- Compatibility: `2.1.0` is unchanged, low-risk call count is unchanged, and no schema/database/Android files are touched.

