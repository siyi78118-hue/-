# Role Plan Format Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every role-plan producer and consumer use one strict canonical operation format so a legacy-shaped model result is rejected and repaired before it can reach visible-result commit.

**Architecture:** Add one pure role-plan operation contract for model-facing validation and normalization, then call it from cognition-v2, cognition-v3, legacy release draft parsing, and canonical action construction. Inject the same code-owned contract into every producer/supervisor request without mutating checksum-pinned preset seeds. Keep store and Android authority validation strict as downstream defenses and verify the whole path with the real overnight failure shape.

**Tech Stack:** Node.js ESM, `node:test`, SQLite-backed Yuqi runtime tests, Markdown preset bundles, Android Java/JUnit/Gradle.

## Global Constraints

- A genuinely invalid role-plan operation rejects the entire result; never drop the action and send a reply that may falsely claim the plan was committed.
- `timeConfidence` is a native string with exactly two values: `explicit` and `inferred`.
- Vague expressions such as “明早” and “待会” use `inferred`; a user-specified concrete time uses `explicit`.
- No store, wire, bridge, or Android layer may guess or coerce a missing/legacy value.
- Protocol v1/v2 authority-v0 wire and recovery behavior remains byte-compatible.
- Existing unrelated worktree changes, deleted `zhaxian-workbench` files, APK artifacts, and user files must not be staged or modified.

---

### Task 1: Shared role-plan operation contract

**Files:**
- Create: `yuqi-runtime/src/role-plan-operation-contract.mjs`
- Create: `yuqi-runtime/test/role-plan-operation-contract.test.mjs`

**Interfaces:**
- Consumes: JSON string or array from a model-facing role-plan field; optional `{ allowedPlanIds, validMessageIds }` authority sets.
- Produces: `normalizeRolePlanOperationList(value, options)` returning a deep-cloned canonical array or throwing a stable `role plan operation contract conflict: <detail>` error.
- Produces: `rolePlanOperationHasTimeChange(operation)` for create and schedule-bearing update decisions.
- Produces: `rolePlanModelContractV1()` returning a fresh closed JSON instruction object for model/supervisor requests.

- [ ] **Step 1: Write the failing closed-contract tests**

Cover a valid `create` with `explicit`, a valid vague-time `create` with `inferred`, all five schedule kinds, all six operations, update target/evidence validation, and deep-clone isolation. Add table-driven failures for missing/array/object/number `timeConfidence`, aliases (`implicit`, `approximate`, `INFERRED`), unknown top-level/patch/schedule fields, coerced numbers, duplicate/foreign evidence IDs, foreign plan IDs, and more than twelve operations.

```js
assert.deepEqual(normalizeRolePlanOperationList(JSON.stringify([{
  op: 'create', type: 'private_message', source: 'spoken',
  title: '早安', intent: '明早问候',
  sourceQuote: '但是明天的早安不要忘了',
  evidenceMessageIds: ['msg_1'],
  schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' },
  timeConfidence: 'inferred'
}]), { validMessageIds: ['msg_1'] })[0].timeConfidence, 'inferred');

assert.throws(() => normalizeRolePlanOperationList(JSON.stringify([{
  op: 'create', type: 'private_message', source: 'spoken',
  title: '早安', intent: '明早问候',
  schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' }
}])), /time confidence/);
```

- [ ] **Step 2: Run the new unit test and verify the red state**

Run: `node --test yuqi-runtime/test/role-plan-operation-contract.test.mjs`

Expected: FAIL because `role-plan-operation-contract.mjs` does not exist.

- [ ] **Step 3: Implement the pure contract**

Use exact key sets matching the persisted canonical payload:

```js
const CREATE_ALLOWED = new Set([
  'op', 'planId', 'type', 'source', 'title', 'intent', 'schedule',
  'timeConfidence', 'durationMs', 'origin', 'sourceQuote', 'evidenceMessageIds'
]);
const CREATE_REQUIRED = new Set([
  'op', 'type', 'source', 'title', 'intent', 'schedule', 'timeConfidence'
]);
const UPDATE_ALLOWED = new Set(['op', 'planId', 'patch', 'reason']);
const TERMINAL_ALLOWED = new Set(['op', 'planId', 'reason']);

export function rolePlanOperationHasTimeChange(operation) {
  return operation?.op === 'create'
    || (operation?.op === 'update'
      && Object.prototype.hasOwnProperty.call(operation?.patch || {}, 'schedule'));
}

export function normalizeRolePlanOperationList(value, {
  allowedPlanIds = null,
  validMessageIds = null
} = {}) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length > 12) conflict('list is invalid');
  const operations = structuredClone(parsed);
  operations.forEach((operation, index) => validateOperation(
    operation, index, allowedPlanIds, validMessageIds
  ));
  return operations;
}
```

`rolePlanModelContractV1()` must return this semantic contract without sharing a mutable object:

```js
{
  version: 1,
  container: 'JSON array string',
  timeConfidence: {
    requiredFor: ['create', 'update_with_schedule'],
    allowed: ['explicit', 'inferred'],
    explicit: 'the user supplied a concrete execution time',
    inferred: 'the user used a vague natural time and Yuqi selected the concrete execution time'
  },
  rejectMissingOrAliases: true
}
```

Schedule validators must require native safe integers, exact key sets, `intervalMs >= 300000`, weekdays `0..6` without duplicates, day `1..31`, `HH:mm`, and non-empty ISO timestamp strings. The contract must not perform string/number/boolean coercion.

- [ ] **Step 4: Run the new tests**

Run: `node --test yuqi-runtime/test/role-plan-operation-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 1 only**

```bash
git add yuqi-runtime/src/role-plan-operation-contract.mjs yuqi-runtime/test/role-plan-operation-contract.test.mjs
git commit -m "fix: define canonical role plan operation contract"
```

---

### Task 2: Align cognition-v2 and cognition-v3 before expression

**Files:**
- Modify: `yuqi-runtime/src/cognition-contract.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-contract.mjs`
- Modify: `yuqi-runtime/test/cognition-contract.test.mjs`
- Modify: `yuqi-runtime/test/cognition-v3-contract.test.mjs`

**Interfaces:**
- Consumes: `normalizeRolePlanOperationList` from Task 1.
- Produces: cognition results whose embedded `rolePlanOperationsJson` / `rolePlan.operationsJson` has already passed the complete canonical contract before an expression prompt is compiled.

- [ ] **Step 1: Add failing early-rejection tests**

For both cognition versions, construct an otherwise valid cognition result containing a time-bearing create without `timeConfidence`. Assert normalization throws `role plan operation contract conflict` before packet/draft construction. Add positive explicit/inferred cases and assert the original JSON string remains byte-identical after validation.

```js
const broken = validCognitionV3();
broken.actionIntent.rolePlan = { operationsJson: JSON.stringify([{
  op: 'create', type: 'private_message', source: 'spoken',
  title: '早安', intent: '明早问候',
  schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' }
}]) };
assert.throws(
  () => normalizeCognitionV3Result(broken, context),
  /role plan operation contract conflict: time confidence/
);
```

- [ ] **Step 2: Run the cognition contract tests and verify red**

Run: `node --test yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs`

Expected: the missing/invalid time-confidence fixtures are accepted by current partial validators.

- [ ] **Step 3: Replace duplicate partial parsers with the shared contract**

Import Task 1 and pass exact authority sets:

```js
normalizeRolePlanOperationList(normalized.actionIntent.rolePlanOperationsJson, {
  allowedPlanIds: allowedActionTargets?.rolePlanIds,
  validMessageIds: validIds
});
```

For v3 use `normalized.actionIntent.rolePlan.operationsJson` when non-null. Preserve the original string in the normalized cognition object so packet checksums do not silently change representation.

- [ ] **Step 4: Run Task 1 and cognition tests**

Run: `node --test yuqi-runtime/test/role-plan-operation-contract.test.mjs yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 2 only**

```bash
git add yuqi-runtime/src/cognition-contract.mjs yuqi-runtime/src/cognition-v3-contract.mjs yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs
git commit -m "fix: validate role plans before expression"
```

---

### Task 3: Repair producer output before canonical commit

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline.test.mjs`

**Interfaces:**
- Consumes: Task 1 canonical operation list and stable error prefix.
- Produces: `normalizeBrainDraft` / `normalizeCanonicalV3RolePlanOperations` results containing only canonical operations.
- Produces: bounded protocol repair for legacy brain output; no action-dropping fallback.
- Produces: identical `rolePlanOutputContract` request data for legacy brain/supervisor and v2/v3 cognition/supervisor calls.

- [ ] **Step 1: Add the overnight failure-shape red test**

Create a release-executor fixture whose first brain response contains a valid direct reply plus the exact missing-field operation from the incident. The second brain response must contain the same operation with `timeConfidence: "inferred"`. Assert the first response is rejected before supervisor/commit, the second is accepted, one visible reply and one role-plan action are committed, and the failure writer is never called.

Also add a fixture where both bounded responses remain invalid and assert the entire turn fails with zero visible groups/actions/deliveries.

```js
const brokenOperation = {
  op: 'create', type: 'private_message', source: 'spoken',
  title: '早安', intent: '明早问候',
  sourceQuote: '但是明天的早安不要忘了，虽然你很大概率还是会忘',
  evidenceMessageIds: [input.message.messageId],
  schedule: { kind: 'once', at: '2026-08-15T08:00:00+08:00' }
};
```

- [ ] **Step 2: Run focused orchestrator/preset tests and verify red**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs`

Expected: the first draft reaches late confirmation and fails instead of using the bounded protocol repair.

- [ ] **Step 3: Route brain inner-contract errors through existing bounded repair**

Extend `runStructuredRoleDraftOnly` with a brain-only parsed-result validator. It must validate before returning and retain a stable error detail for the second request:

```js
const parsed = parseRoleJson(invalidOutput, role);
if (role === 'brain' && Object.hasOwn(parsed, 'rolePlanOperationsJson')) {
  normalizeRolePlanOperationList(parsed.rolePlanOperationsJson);
}
return parsed;
```

On the second request, set the existing `protocolRepair.rule` to include the exact canonical requirement without inventing a new retry loop:

```js
rule: role === 'brain'
  ? 'Return the exact output schema. Every time-bearing role-plan create/update must include timeConfidence as explicit or inferred.'
  : 'Return exactly one JSON object that matches the supplied output schema.'
```

Update `normalizeRolePlanOperations` and `normalizeCanonicalV3RolePlanOperations` to delegate to the shared contract so recovery and normal execution cannot diverge.

- [ ] **Step 4: Inject the immutable model contract into every producer and supervisor request**

Add a fresh `rolePlanOutputContract: rolePlanModelContractV1()` beside the task content in legacy brain/supervisor requests and cognition-v2/v3 cognition/supervisor requests. Assert the captured request contract is deep-equal across all routes and mutating one captured request cannot change a later request.

```js
const request = {
  ...existingRequest,
  rolePlanOutputContract: rolePlanModelContractV1()
};
```

Do not edit `yuqi-core.md`, `cognition-core.md`, versioned preset files, or `manifest.json`: those are checksum-pinned seed assets. Their next semantic change requires a new preset version, not an in-place rewrite.

- [ ] **Step 5: Run focused tests**

Run: `node --test yuqi-runtime/test/role-plan-operation-contract.test.mjs yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs`

Expected: PASS, including the real failure shape and bounded double-invalid rejection.

- [ ] **Step 6: Commit Task 3 only**

```bash
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs
git commit -m "fix: align role plan producers with v3 authority"
```

---

### Task 4: Residual compatibility audit and cross-stack gates

**Files:**
- Modify only if a red test proves drift: `yuqi-runtime/src/store.mjs`
- Modify only if a red test proves drift: `yuqi-runtime/src/bridge-result-projector.mjs`
- Modify only if a red test proves drift: `android/app/src/main/java/com/siyi/al/execution/LocalFallbackActionAuthority.java`
- Test: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Test: `yuqi-runtime/test/bridge-authority-v3.test.mjs`
- Test: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`
- Test: `android/app/src/test/java/com/siyi/al/execution/LocalFallbackActionAuthorityTest.java`

**Interfaces:**
- Consumes: canonical action payload emitted by Task 3.
- Produces: proof that persistence, restart, retry, bridge projection, and Android local validation agree on exact keys/types and reject all old aliases.

- [ ] **Step 1: Add cross-boundary contract tests**

Use the same explicit/inferred create/update fixtures at commit, bridge projection, and Android validation. For each boundary mutate one field at a time: remove `timeConfidence`, replace it with a number/array/alias, add an extra field, or change a schedule field type. Assert zero commit/Room write for invalid cases.

Add authority-v0 v1/v2 snapshot assertions proving old wire projection and recovery payloads are unchanged.

- [ ] **Step 2: Run cross-boundary tests and retain any genuine red state**

Run:

```bash
node --test yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
cd android && .\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.LocalFallbackActionAuthorityTest --no-daemon --no-problems-report
```

Expected: canonical fixtures pass; every mutation is rejected. If existing downstream code accepts a mutation, fix only that proven boundary and rerun the same test.

- [ ] **Step 3: Search for residual producer/consumer drift**

Run:

```bash
rg -n "rolePlanOperations(Json)?|operationsJson|timeConfidence|role_plan_" yuqi-runtime android tavern-app tests
```

Classify every match as one of: canonical producer, shared-contract caller, strict persisted/bridge/Android consumer, or explicitly authority-v0 compatibility. Any authority-v1 path parsing operation JSON without Task 1 or independently coercing a value must be converted and covered by a red test.

- [ ] **Step 4: Run the complete regression gates**

Run:

```bash
npm.cmd test
cd android && .\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-daemon --no-problems-report
git diff --check
```

Expected: all Node tests pass; Android JVM tests and instrumentation APK compilation pass; diff check is clean. If `adb devices -l` has no device, record `connectedDebugAndroidTest` as an unmet release gate rather than calling it passed.

- [ ] **Step 5: Commit only proven Task 4 changes**

```bash
git add yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs android/app/src/test/java/com/siyi/al/execution/LocalFallbackActionAuthorityTest.java
git commit -m "test: lock role plan format across runtime and Android"
```

If a production boundary required a red-test-driven correction, add only its exact source file to this commit. Never stage unrelated worktree files.

## Execution Handoff

The user requested continuous implementation in the current task, so use **Inline Execution** with TDD and the review gates above. Do not create new user-visible tasks or delegate overlapping files.
