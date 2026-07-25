# Yuqi Supervisor Rewrite Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make supervisor feedback actionable and stateful, and guarantee that a direct Yuqi reply is never lost merely because the supervisor exhausted its rewrite budget.

**Architecture:** Add a focused rewrite-contract module between the orchestrator and the two existing model roles. It normalizes issue severity, assigns stable IDs, carries executable acceptance criteria into the next brain call, tracks which issues were resolved, and converts exhausted direct-message reviews into a diagnosed best-draft fallback instead of a failed turn. Existing fast/deep routing, automatic-message silence, bridge transport, payments, moments, life planning, and relationship stages remain unchanged.

**Tech Stack:** Node.js ESM, `node:test`, JSON Schema, SQLite-backed Yuqi runtime, Android/Capacitor release build.

## Global Constraints

- Build on current `1.0.93` source (`8bd7582`) and preserve all later work already present in that baseline.
- Do not add a fourth model role or Codex window.
- Direct chat must not end with an empty reply or failed turn because of supervisor disagreement.
- Automatic private-message and moment tasks may still choose `skip`.
- Low-risk facts about Yuqi's own daily life may be naturally formed; user facts, commitment attribution, relationship history, and major life facts may not be invented.
- Existing payment, moment, quote, deletion, role-plan, life-plan, relationship-stage, deduplication, cloud relay, and retry behavior must remain covered by the full test suite.
- Target Android release after implementation: `1.0.94` (`versionCode 94`).

---

### Task 1: Define the Rewrite Contract Boundary

**Files:**
- Create: `yuqi-runtime/src/rewrite-contract.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Create: `yuqi-runtime/test/rewrite-contract.test.mjs`

**Interfaces:**
- Produces: `normalizeSupervisorResult(reviewed, options) -> SupervisorResult`
- Produces: `rewriteContractForBrain(supervisorResult) -> RewriteContract`
- Produces: `normalizeRewriteResolution(value) -> RewriteResolution`
- Produces: `characterFactCandidatesForReply(resolution, reply) -> FactCandidate[]`
- Produces: `hasHighPriorityIssues(supervisorResult) -> boolean`
- Consumes: raw supervisor JSON, previous normalized supervisor JSON, and current attempt number.

- [ ] **Step 1: Write failing contract normalization tests**

Add tests that require:

```js
const first = normalizeSupervisorResult({
  decision: 'rewrite',
  issues: [{
    code: 'CURRENT_INTERACTION_MISS',
    severity: 'soft',
    message: '没有正面承接追问',
    mustPreserve: ['不编造用户事实'],
    mustChange: ['给出正面回应'],
    allowedStrategies: ['补全虞栖自己的低风险生活细节'],
    acceptanceCriteria: ['正文回应当前追问']
  }]
}, { attempt: 1, previous: null });

assert.equal(first.issues[0].issueId, 'CURRENT_INTERACTION_MISS:1');
assert.deepEqual(
  rewriteContractForBrain(first).issues[0].allowedStrategies,
  ['补全虞栖自己的低风险生活细节']
);
```

Add a second-round test proving that an issue with the same code retains its `issueId`, resolved IDs are preserved, and a newly introduced soft-only issue is ignored after the first review. Add a legacy test proving `{code,message}` records are normalized into an executable default contract instead of crashing recovered turns.

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/rewrite-contract.test.mjs
```

Expected: FAIL because `rewrite-contract.mjs` and the exported functions do not exist.

- [ ] **Step 3: Implement the focused rewrite-contract module**

Implement stable issue IDs from `code` plus occurrence index, normalize `severity` to `hard|soft`, synthesize executable defaults for legacy records, preserve old issue IDs by code/position, and suppress new soft goalposts after attempt one.

`rewriteContractForBrain()` must return only internal rewrite guidance:

```js
{
  attempt,
  rejectedDraft,
  issues: [{
    issueId,
    code,
    severity,
    mustPreserve,
    mustChange,
    allowedStrategies,
    acceptanceCriteria
  }]
}
```

`normalizeRewriteResolution()` must accept:

```js
{
  resolvedIssueIds: ['CURRENT_INTERACTION_MISS:1'],
  resolutionNotes: [{
    issueId: 'CURRENT_INTERACTION_MISS:1',
    strategy: '补全虞栖自己的低风险生活细节',
    result: '正文已经正面回答'
  }],
  formedCharacterFacts: [{
    predicate: 'currently_reading',
    summary: '虞栖正在读一本具体的悬疑小说',
    detailsJson: '{"title":"示例书名"}',
    evidenceQuote: '我在看《示例书名》'
  }]
}
```

and return empty arrays for legacy drafts.

`characterFactCandidatesForReply()` must bind every formed daily fact to the newly saved Yuqi message ID, Yuqi as speaker and subject, and an exact substring of the visible reply. A missing or non-matching `evidenceQuote` must not produce a candidate.

- [ ] **Step 4: Extend strict role output schemas**

Add a required nullable `rewriteResolution` object to the brain schema, including `formedCharacterFacts`, and extend each supervisor issue with required contract fields. Add required `reviewedIssueIds` and `resolvedIssueIds` arrays to the supervisor schema. Runtime normalization must remain backward compatible with older stored JSON and current fixture outputs.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test yuqi-runtime/test/rewrite-contract.test.mjs
```

Expected: all rewrite-contract tests pass.

- [ ] **Step 6: Commit the boundary**

```powershell
git add yuqi-runtime/src/rewrite-contract.mjs yuqi-runtime/src/role-schemas.mjs yuqi-runtime/test/rewrite-contract.test.mjs
git commit -m "feat: define yuqi rewrite contracts"
```

---

### Task 2: Close the Brain–Supervisor Feedback Loop

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: Task 1's normalized supervisor result and rewrite contract.
- Produces: brain calls containing `rewriteContract`, supervisor calls containing `previousReview` and `draft.rewriteResolution`, and diagnosed fallback approval for exhausted direct turns.

- [ ] **Step 1: Add failing orchestrator tests**

Add tests for all of the following:

1. A rewrite call receives stable issue IDs, allowed strategies, acceptance criteria, the rejected draft, and the previous draft's resolution receipt.
2. The next supervisor call receives the previous review and can explicitly close its issue.
3. A third soft rejection on `DIRECT_REPLY` commits the final complete draft and records `SOFT_ISSUE_FALLBACK_SELECTED`.
4. A direct supervisor `reject` becomes a high-priority rewrite contract rather than an immediate failed turn.
5. A third high-priority rejection runs one final repair; if review still disagrees, it commits the complete lowest-risk draft and records `HARD_REPAIR_FALLBACK_SELECTED`.
6. A third rejection on an automatic task still produces a deliberate `skip`.
7. An approved low-risk Yuqi daily detail becomes a verified fact backed by the saved character reply, while malformed evidence and user/commitment claims are not committed through this path.

The direct fallback assertion must be explicit:

```js
assert.equal(result.reply.content, '最后一版完整回复');
assert.equal(store.getTurn(result.turnId).state, 'committed');
assert.ok(
  store.db.prepare('SELECT stage FROM diagnostics WHERE turn_id = ?')
    .all(result.turnId)
    .some(item => item.stage === 'SOFT_ISSUE_FALLBACK_SELECTED')
);
```

- [ ] **Step 2: Run orchestrator tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs
```

Expected: new tests fail because the current orchestrator throws after three rewrites and does not pass a structured contract.

- [ ] **Step 3: Pass structured feedback into brain rewrites**

In `completeBrain()`:

- normalize the previous supervisor result with its previous issue state;
- pass `rejectedDraft`;
- pass `rewriteContract`;
- keep `supervisorIssues` for backward diagnostic compatibility;
- preserve `rewriteResolution` in normalized brain drafts.

- [ ] **Step 4: Make supervisor reviews stateful**

In `completeSupervisor()`:

- pass `previousReview` and the brain's `rewriteResolution`;
- normalize the returned review against the previous issue set;
- require old issues to be reviewed before accepting new soft concerns;
- persist the normalized result with attempt number and issue closure state.

- [ ] **Step 5: Replace terminal direct rejection with bounded recovery**

For direct turns:

- convert `reject` to a high-priority rewrite contract;
- after the normal rewrite budget, run at most one hard-repair brain call when high-priority issues remain;
- never throw `supervisor rejected the reply after three rewrites`;
- advance the safest complete draft to `approved`;
- write either `SOFT_ISSUE_FALLBACK_SELECTED` or `HARD_REPAIR_FALLBACK_SELECTED` diagnostics.

For automatic turns, keep the current third-rejection `skip` behavior and preserve all automatic cadence rules.

- [ ] **Step 6: Commit approved low-risk character facts**

After `putMessageInternal(reply)` returns the authoritative saved reply, call `characterFactCandidatesForReply()` and pass the result through the existing `commitVerifiedFacts()` validator. This makes the exact visible Yuqi reply—not rewrite metadata—the evidence source.

- [ ] **Step 7: Run orchestrator tests and verify GREEN**

Run:

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs
```

Expected: all orchestrator tests pass, including existing life-plan, payment, moment, relationship, and automatic-silence tests.

- [ ] **Step 8: Commit orchestration**

```powershell
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "fix: close yuqi supervisor rewrite loop"
```

---

### Task 3: Teach Both Roles the Same Achievable Rules

**Files:**
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: Task 1 schema fields.
- Produces: preset version `1.8.3`, executable supervisor contracts, rewrite receipts, and an explicit boundary between Yuqi-owned low-risk details and protected external facts.

- [ ] **Step 1: Add failing preset contract assertions**

Require compiled brain and supervisor presets to mention:

- stable issue IDs;
- must-preserve, must-change, allowed-strategy, and acceptance criteria;
- per-issue rewrite resolution;
- low-risk Yuqi daily details may be formed and then remain consistent;
- user facts, commitment attribution, relationship history, and major life events cannot be invented;
- direct chat cannot be silently discarded after review disagreement.

Require manifest version `1.8.3`.

- [ ] **Step 2: Run preset tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/preset-registry.test.mjs
```

Expected: new assertions fail against preset `1.8.2`.

- [ ] **Step 3: Update brain and supervisor instructions**

Brain instructions must require `rewriteResolution` on every structured output (`null` on first draft), and must treat the contract as executable internal work rather than user-visible explanation.

Supervisor instructions must:

- provide at least one achievable strategy for every rewrite issue;
- keep issue IDs stable;
- review prior issue IDs before introducing new concerns;
- classify service tone, meta explanation, weak interaction, and stylistic continuity as soft;
- classify attribution, protected knowledge, commitments, identity, and structured-action contradictions as high priority;
- never use disagreement alone to erase a direct chat.

- [ ] **Step 4: Bump and verify preset version**

Set `currentVersion` to `1.8.3`. Run:

```powershell
node --test yuqi-runtime/test/preset-registry.test.mjs
```

Expected: all preset tests pass.

- [ ] **Step 5: Commit presets**

```powershell
git add yuqi-runtime/presets/yuqi-core.md yuqi-runtime/presets/supervisor.md yuqi-runtime/presets/manifest.json yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: align yuqi brain and supervisor contracts"
```

---

### Task 4: Regression, Release Contract, and APK

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `tests/android-unsigned-release-contract.test.mjs`
- Create: `artifacts/AL-1.0.94-supervisor-rewrite-unsigned.apk`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: verified source, synchronized Android assets, and an unsigned `1.0.94` APK ready for the existing formal signing workflow.

- [ ] **Step 1: Run the complete Node test suite**

Run:

```powershell
npm.cmd test
```

Expected: all root and `yuqi-runtime` tests pass with no regression.

- [ ] **Step 2: Update the Android release contract**

Set default `versionCode` to `94` and `versionName` to `1.0.94`; update only the version assertions in `tests/android-unsigned-release-contract.test.mjs`.

- [ ] **Step 3: Synchronize Android assets**

Run:

```powershell
npm.cmd run android:sync
```

Expected: Capacitor copies the current web assets without changing unrelated source files.

- [ ] **Step 4: Run Android unit tests**

Run:

```powershell
.\gradlew.bat :app:testDebugUnitTest --no-daemon
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Build the release APK**

Run:

```powershell
$env:AL_VERSION_CODE='94'
$env:AL_VERSION_NAME='1.0.94'
.\gradlew.bat :app:assembleRelease --no-daemon
```

Copy only the generated unsigned release to:

```text
artifacts/AL-1.0.94-supervisor-rewrite-unsigned.apk
```

- [ ] **Step 6: Verify package metadata and checksum**

Run `aapt dump badging` and verify:

```text
package='com.siyi.al'
versionCode='94'
versionName='1.0.94'
```

Compute SHA-256 and report it with the artifact link. Do not claim that the unsigned APK can overwrite the formally signed installation.

- [ ] **Step 7: Commit the release contract**

```powershell
git add android/app/build.gradle tests/android-unsigned-release-contract.test.mjs
git commit -m "chore: prepare AL 1.0.94"
```
