# Yuqi Three-Judge Blind Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a bounded two-question stable/candidate blind pilot, preserve a human scoring package, and combine two AI judges with a 50%-weighted human judge after the user scores it.

**Architecture:** Extend the existing production quality bridge rather than creating a second conversation simulator. A non-network preparer creates a clean detached candidate, an isolated v15 seed with a legacy stable release and v3 candidate release, closed four-lane client materials, and a stage-specific authority. The existing SQLite four-phase runner performs stable, candidate, and two evaluator phases; a separate exporter derives the blind human package and sealed mapping from finalized ledger rows.

**Tech Stack:** Node.js ESM, `node:sqlite`, existing Yuqi runtime/release adapters, Codex app-server bridge, Node test runner.

## Global Constraints

- Stage 1 final keys are exactly `sentinel:first_red_packet_as_social_action:0` and `sentinel:fourth_coquetry_test_or_pressure:0`.
- Candidate profile is exactly `gpt-5.6-sol/medium`, `gpt-5.6-sol/xhigh`, `gpt-5.6-sol/medium`, `gpt-5.6-sol/medium` for fast/deep/expression/supervisor compatibility.
- Evaluator weights are primary `0.25`, secondary `0.25`, human `0.50`.
- No external arrangement API, production DB, Android Room, cloud relay, rollout, message, action, or memory mutation.
- No automatic replacement request after a failed or uncertain call.
- Pilot and later bulk work use separate immutable run authorities and ledgers.
- Preserve unrelated worktree dirt; never reset, checkout, clean, or stage it.

---

### Task 1: Close GPT-5.6 effort and release-profile validation

**Files:**
- Modify: `yuqi-runtime/src/quality-replay-production-bridge.mjs:1689-1709`
- Test: `yuqi-runtime/test/quality-replay-production-bridge.test.mjs`

**Interfaces:**
- Consumes: persisted release `modelProfile` values in `model/effort` form.
- Produces: `releaseExecutionProfileFromRelease(release)` and `requestProfileFromRelease(release,lane)` accepting the official GPT-5.6 effort set without coercion.

- [ ] **Step 1: Add red tests**

Add a candidate release whose deep profile is `gpt-5.6-sol/xhigh`; assert the resolved request is still exactly `xhigh`. Add rejection tests for `ultra`, an empty effort, non-string values, and whitespace-mutated values.

- [ ] **Step 2: Run the focused test and observe the red failure**

Run: `node --test yuqi-runtime/test/quality-replay-production-bridge.test.mjs`

Expected: the `xhigh` case fails with `release model profile cognitionDeep effort conflict`.

- [ ] **Step 3: Implement the closed effort set**

Replace the three-value check with one frozen set containing `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Keep the persisted value byte-for-byte; do not map `xhigh` to `high`.

- [ ] **Step 4: Run the focused test**

Run: `node --test yuqi-runtime/test/quality-replay-production-bridge.test.mjs`

Expected: PASS.

### Task 2: Prepare an isolated Stage 1 authority and model lanes

**Files:**
- Create: `scripts/prepare-yuqi-three-judge-pilot.mjs`
- Create: `tests/yuqi-three-judge-pilot-readiness.test.mjs`
- Modify: `scripts/yuqi-quality-production-execution-config.mjs`
- Modify: `yuqi-runtime/src/quality-replay-production-bridge.mjs`
- Modify: `yuqi-runtime/src/quality-replay-ledger.mjs`
- Test: `yuqi-runtime/test/quality-production-config.test.mjs`
- Test: `yuqi-runtime/test/quality-replay-ledger.test.mjs`

**Interfaces:**
- Produces: `prepareThreeJudgePilot({repoRoot,stage,codexCommand,now}) -> {candidateRoot,authorityPath,planPath,materialsPath,ledgerPath,questionKeys,owner}`.
- Produces: immutable header fields `pilotLimits` and `pilotLimitsChecksum`.

- [ ] **Step 1: Add red readiness tests**

Cover: dirty/attached/shared source rejection; source identity before clone differing from candidate after clone; wrong/duplicate final keys; any attempt to widen Stage 1; candidate deep effort not `xhigh`; aliased lane store/session; non-private output; model client construction before all checks; and resume with changed limits.

- [ ] **Step 2: Run red tests**

Run: `node --test tests/yuqi-three-judge-pilot-readiness.test.mjs yuqi-runtime/test/quality-production-config.test.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs`

Expected: FAIL because the preparer and immutable limit fields do not exist.

- [ ] **Step 3: Implement the minimal preparer**

The preparer must:

1. read the committed source identity before cloning;
2. create a random detached clone outside the shared repository and verify its identity again after clone;
3. compile and verify the tracked 246-item plan and publish canonical bytes privately;
4. create a fresh v15 seed, insert a legacy `1.9.2` stable release and a `2.1.0` v3 candidate release with the exact profiles from the design;
5. create four distinct Codex app-server lanes with approval `never`, sandbox `read-only`, `maxRoleTurns=16`, and separate stores/namespaces;
6. persist exact Stage 1 limits `{allowedFinalKeys,maxModelCallsPerFinal:32,maxModelCallOrdinalPerPhase:15,maxTotalModelCalls:64,maxWallClockMs:2700000,usageStatus:'unobservable'}`;
7. publish private files atomically without overwriting existing evidence.

Do not add a repair-call counter: the current ledger does not persist a repair role. Per-phase ordinal, per-final call, run call, and wall-clock limits are the enforceable authority.

- [ ] **Step 4: Enforce limits in the ledger CAS path**

Before every new model-call row, verify the final key, next phase ordinal, per-final total, run total, and wall-clock elapsed value against the immutable header. A breach writes one durable blocked reason and creates no replacement request. Resume must compare the complete limits object and checksum before writable open.

- [ ] **Step 5: Run focused gates**

Run:

```powershell
node --test tests/yuqi-three-judge-pilot-readiness.test.mjs
node --test yuqi-runtime/test/quality-production-config.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/quality-replay.test.mjs
node --check scripts/prepare-yuqi-three-judge-pilot.mjs
node --check scripts/yuqi-quality-production-execution-config.mjs
node --check scripts/run-yuqi-lived-quality-replay.mjs
node --check yuqi-runtime/src/quality-replay-production-bridge.mjs
node --check yuqi-runtime/src/quality-replay-ledger.mjs
git diff --check
```

Expected: PASS with zero real app-server/model starts in the readiness test.

### Task 3: Export the sealed mapping and human review package

**Files:**
- Create: `scripts/export-yuqi-three-judge-review.mjs`
- Create: `yuqi-runtime/src/three-judge-review.mjs`
- Create: `yuqi-runtime/test/three-judge-review.test.mjs`

**Interfaces:**
- Produces: `exportThreeJudgeReview({ledgerPath,runId,outputDir,stage})`.
- Produces: blind Markdown, score-template JSON, sealed mapping JSON, and AI-only provisional report.
- Consumes later: `importHumanJudgment({packagePath,scoresPath,mappingPath})`.

- [ ] **Step 1: Add red package tests**

Use finalized fixture rows and assert: question transcripts and A/B replies survive byte-for-byte; no stable/candidate/release/model/phase/session/checksum label occurs in the human file; the mapping is separate; changing one answer or question breaks the package checksum; malformed human scores do not reveal the mapping.

- [ ] **Step 2: Run red tests**

Run: `node --test yuqi-runtime/test/three-judge-review.test.mjs`

Expected: FAIL because the review exporter does not exist.

- [ ] **Step 3: Implement deterministic blind export**

Derive the A/B order from `contentHash({runId,finalKey,'human-blind-v1'})`; write the mapping only to the sealed JSON. The Markdown contains the six 1–5 dimensions, preference choice, and comment field for each question. AI outputs and mapping remain outside it.

- [ ] **Step 4: Implement weighted import**

Validate human scores as native integers 1..5 and preference `A|B|tie|unresolved`. Join the exact package checksum and mapping, then compute `0.25/0.25/0.50` weighted dimension and preference results. An unresolved human score, human score 1, or critical regression blocks a winner.

- [ ] **Step 5: Run focused tests and syntax checks**

Run:

```powershell
node --test yuqi-runtime/test/three-judge-review.test.mjs
node --check scripts/export-yuqi-three-judge-review.mjs
node --check yuqi-runtime/src/three-judge-review.mjs
git diff --check
```

Expected: PASS.

### Task 4: Run the two-question real pilot

**Files:**
- Evidence only: `artifacts/yuqi-lived-agency-v3/private/three-judge-pilot/**`

**Interfaces:**
- Consumes: Task 2 candidate/authority and Task 3 exporter.
- Produces: Stage 1 AI-only provisional result and the user-facing blind review package.

- [ ] **Step 1: Run all non-model gates**

Run the Task 2 and Task 3 focused commands. Stop if any test, source identity, release profile, lane isolation, or side-effect snapshot fails.

- [ ] **Step 2: Execute exactly the first final**

Run the existing production replay command with `--only-final-key sentinel:first_red_packet_as_social_action:0`. Record the run ID, call count, latency, and four phase states. Do not auto-retry failed or uncertain calls.

- [ ] **Step 3: Resume exactly the second final**

Use the same Stage 1 ledger and run ID with `--only-final-key sentinel:fourth_coquetry_test_or_pressure:0`. Recheck the immutable limits before starting.

- [ ] **Step 4: Verify and export**

Require both finals and all four phases per final succeeded, zero uncertain calls, no source/release/side-effect drift, and no third evaluator. Export the sealed mapping and human package.

- [ ] **Step 5: Stop for human review**

Deliver the blind Markdown and JSON score template without revealing A/B identities. Report AI-only results only as provisional and do not decide stable versus candidate until human scores are imported.

## Self-Review

- Spec coverage: exact model roles, all 12 questions, stage isolation, two AI judges, 50% human weight, and mapping secrecy each map to a task.
- Completeness scan: every production interface and stop condition is explicit.
- Type consistency: `pilotLimits`, review package fields, score dimensions, preference values, and weights are named consistently across tasks.
- Scope: only Stage 1 is authorized for paid execution; Stage 2 and Stage 3 remain separate future approvals.
