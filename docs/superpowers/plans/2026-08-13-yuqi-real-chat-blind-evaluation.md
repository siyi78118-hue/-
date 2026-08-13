# Yuqi Real-Chat Blind Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one isolated 12-item human blind-review package from de-identified real chat history, replacing answer pairs that are identical or substantively indistinguishable before review begins.

**Architecture:** Reuse the existing v15 read-only history extractor and production quality bridge. Add a small pure contract module for candidate-pool validation, de-identification, discriminability, selection, sealed A/B mapping, and human-review projection. Extend the SQLite quality runner with an `execution_only` phase mode so stable/candidate outputs can be persisted now and the two AI judges can be resumed only after the human review is returned.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite`, existing Yuqi production quality bridge and SQLite ledger, Codex app-server bridge.

## Global Constraints

- The scored set is exactly 12 ordinary `DIRECT_REPLY` items distributed `3/3/2/2/2` across daily chat, emotional/closeness, disagreement/repair, subtext/coquetry, and interruption/memory/time.
- At least two scored items retain a real same-batch multi-bubble user input.
- The candidate pool is frozen at 24 items before model execution, with category counts `6/6/4/4/4` and an immutable per-category replacement order.
- Exact or substantively indistinguishable A/B pairs are excluded from the scored 12 and reported separately; replacement never depends on which release is better.
- Every technical call has at most three total attempts. Partial or uncertain output is never scored.
- Real source data is read-only, de-identified before model calls, stored only under ignored private artifacts, and never committed.
- Stable/candidate execution uses independent production stores and model sessions. No production chat, Android Room, memory, moment, plan, relay, action, or visible message may be written.
- Human scoring happens before the two AI judges. This plan stops after the human package is produced and verified.
- Preserve all unrelated dirty-worktree files; stage and commit only files named by each task.

---

### Task 1: Pure real-chat evaluation contract

**Files:**
- Create: `yuqi-runtime/src/real-chat-blind-evaluation.mjs`
- Create: `yuqi-runtime/test/real-chat-blind-evaluation.test.mjs`

**Interfaces:**
- Consumes: extracted candidate windows shaped as `{windowId, sourceWindowChecksum, turns}`.
- Produces: `validateRealChatCandidatePool(pool)`, `deidentifyRealChatWindow(window)`, `classifyAnswerPair(pair)`, `selectDiscriminatingPairs(input)`, `buildSealedBlindPair(input)`, and `buildHumanReviewMarkdown(input)`.

- [ ] **Step 1: Write failing contract tests**

Cover exact 24-item category counts, stable replacement order, two multi-bubble minimum, PII substitutions, exact equality after whitespace normalization, substantive-equivalence checklist, retained borderline differences, deterministic A/B sealing, and a plain-language six-question review form.

- [ ] **Step 2: Run the focused test and observe red**

Run: `node --test yuqi-runtime/test/real-chat-blind-evaluation.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the closed pure API**

The discriminability result is exactly:

```js
{
  version: 1,
  outcome: 'keep' | 'replace_exact' | 'replace_substantive',
  checks: { semanticStanceDiffers, concreteContentOrActionDiffers, feltStyleOrEmotionDiffers },
  normalizedAnswerHashes: { A, B }
}
```

Exact matches short-circuit to `replace_exact`; otherwise replacement is allowed only when all three checks are native `false`. No release-side label is accepted by this API.

- [ ] **Step 4: Run focused tests green**

Run: `node --test yuqi-runtime/test/real-chat-blind-evaluation.test.mjs`

Expected: PASS with zero skipped tests.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- yuqi-runtime/src/real-chat-blind-evaluation.mjs yuqi-runtime/test/real-chat-blind-evaluation.test.mjs
git commit -m "feat: add real-chat blind evaluation contract"
```

### Task 2: Execution-only production quality phase

**Files:**
- Modify: `scripts/run-yuqi-lived-quality-replay.mjs`
- Modify: `yuqi-runtime/test/quality-replay.test.mjs`
- Modify: `tests/yuqi-three-judge-pilot-readiness.test.mjs`

**Interfaces:**
- Consumes: existing branded production run authority and selector.
- Produces: `phaseMode: 'all' | 'execution_only'` on `runQualityReplayPlanSqlite` and `runQualityReplayPlan`; CLI flag `--execution-only`.

- [ ] **Step 1: Write red tests for deferred judges**

Assert that execution-only mode runs and persists exactly `stable_execution` and `candidate_execution`, creates no evaluator phase/model-call/final row, leaves the run open, and can later resume through the existing four-phase path without repeating successful execution calls.

- [ ] **Step 2: Run the focused tests red**

Run: `node --test yuqi-runtime/test/quality-replay.test.mjs tests/yuqi-three-judge-pilot-readiness.test.mjs`

Expected: FAIL on the unknown phase mode/CLI flag.

- [ ] **Step 3: Implement the minimal phase-mode split**

Use one closed phase list:

```js
const phases = phaseMode === 'execution_only'
  ? ['stable_execution', 'candidate_execution']
  : ['stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'];
```

Execution-only returns persisted phase outputs but never calls `finalize()` or `finalizeRun()`. Default `all` behavior and byte shape remain unchanged.

- [ ] **Step 4: Run focused tests green**

Run: `node --test yuqi-runtime/test/quality-replay.test.mjs tests/yuqi-three-judge-pilot-readiness.test.mjs`

Expected: PASS with legacy all-phase tests unchanged.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- scripts/run-yuqi-lived-quality-replay.mjs yuqi-runtime/test/quality-replay.test.mjs tests/yuqi-three-judge-pilot-readiness.test.mjs
git commit -m "feat: defer blind evaluators until human review"
```

### Task 3: Private pool preparation and review exporter

**Files:**
- Create: `scripts/prepare-yuqi-real-chat-blind-evaluation.mjs`
- Create: `scripts/build-yuqi-real-chat-human-review.mjs`
- Create: `tests/yuqi-real-chat-blind-evaluation-flow.test.mjs`
- Reuse without modification: `scripts/extract-yuqi-real-history-scenes.mjs`

**Interfaces:**
- Consumes: a read-only v15 source database, its extracted 30 private windows, a private 24-item selection file, the execution-only SQLite ledger, and the frozen quality plan.
- Produces: 30 de-identified history scenes + manifest, a frozen 24-item pool manifest, a discriminability audit, sealed mapping, and `human-review-questions.md`.

- [ ] **Step 1: Write red end-to-end fixture tests**

Use synthetic private fixture windows and an in-memory/temporary SQLite ledger. Assert category quota/order, removal of the final historical assistant reply, insertion of one `candidate_response` system anchor, no raw semantic IDs or PII in model-facing scenes, exact/substantive replacement, fixed 12-item final order, equality-rate reporting, and zero release mapping in the human Markdown.

- [ ] **Step 2: Run flow tests red**

Run: `node --test tests/yuqi-real-chat-blind-evaluation-flow.test.mjs`

Expected: FAIL because both scripts are missing.

- [ ] **Step 3: Implement pool preparation**

The preparation script validates the source checksum before and after extraction, removes each window's final historical assistant answer, appends one system `candidate_response`, applies stable de-identification placeholders, validates the private category selection, and writes canonical JSON/JSONL atomically below `artifacts/yuqi-lived-agency-v3/private/real-chat-blind-evaluation/`.

- [ ] **Step 4: Implement the ledger exporter**

The exporter reads succeeded stable/candidate phase rows read-only, projects visible reply text and actions, runs the blind discriminability contract, follows the frozen same-category replacement order, and writes exactly 12 anonymous items. It records every replaced/failed candidate but never exposes the sealed stable/candidate map in the human Markdown.

- [ ] **Step 5: Run flow and contract tests green**

Run: `node --test yuqi-runtime/test/real-chat-blind-evaluation.test.mjs tests/yuqi-real-chat-blind-evaluation-flow.test.mjs`

Expected: PASS with zero skipped tests.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- scripts/prepare-yuqi-real-chat-blind-evaluation.mjs scripts/build-yuqi-real-chat-human-review.mjs tests/yuqi-real-chat-blind-evaluation-flow.test.mjs
git commit -m "feat: build isolated real-chat blind review packages"
```

### Task 4: Freeze and validate the real private candidate pool

**Files:**
- Create private ignored artifacts only under `artifacts/yuqi-lived-agency-v3/private/real-chat-blind-evaluation/`.

**Interfaces:**
- Consumes: `artifacts/yuqi-lived-agency-v3/history-source-v15.sqlite` plus sidecars, read-only.
- Produces: `real-history-candidates.jsonl`, `selection.json`, `history-scenes.jsonl`, `history-scenes.manifest.json`, `candidate-pool.json`, and `context-preflight.md`.

- [ ] **Step 1: Extract 30 anonymized windows without labels**

Run the existing extractor with `--source-authority legacy_ra0_confirmed` against `C:/Users/PC/Documents/Codex/New project/artifacts/yuqi-lived-agency-v3/history-source-v15.sqlite`. The source is the previously migrated, confirmed historical-chat snapshot; any non-v0 authority row makes the extractor fail closed. Verify the source byte checksum before and after.

- [ ] **Step 2: Inspect all 30 locally and freeze 24**

Assign exactly `6/6/4/4/4`, reject incoherent/truncated/private-risk windows, preserve at least two final multi-bubble batches, and record only window IDs/checksums/categories in `selection.json`.

- [ ] **Step 3: Generate and validate model-facing scenes**

Run: `node scripts/prepare-yuqi-real-chat-blind-evaluation.mjs --root "C:/Users/PC/Documents/Codex/New project" --database "C:/Users/PC/Documents/Codex/New project/artifacts/yuqi-lived-agency-v3/history-source-v15.sqlite" --selection "C:/Users/PC/Documents/Codex/New project/artifacts/yuqi-lived-agency-v3/private/real-chat-blind-evaluation/selection.json"`

Expected: 30 history scenes, frozen 24-item pool, no PII-pattern findings, source checksum unchanged.

- [ ] **Step 4: Build the standard verified quality plan**

Run the existing non-model plan command with the generated history scenes and manifest. Verify the resulting plan contains all 30 history keys and that the 24 pool keys bind to exact scene checksums.

### Task 5: Clean detached production execution

**Files:**
- No tracked source edits.
- Create one temporary detached clone and ignored private runtime artifacts.

**Interfaces:**
- Consumes: committed implementation HEAD, frozen plan/pool/history artifacts, existing Codex executable.
- Produces: one restart-safe execution-only SQLite ledger containing complete stable/candidate outputs for enough candidates to fill 12 discriminating slots.

- [ ] **Step 1: Run all non-model gates in the source tree**

Run the three focused suites, syntax checks for new scripts/modules, and `git diff --check`. Do not include unrelated dirty files.

- [ ] **Step 2: Create a clean detached clone from exact HEAD**

Copy only ignored private evaluation inputs into the clone. Record source HEAD/status before and after clone and require equality. Verify the clone is detached and clean.

- [ ] **Step 3: Prepare isolated stable/candidate materials**

Use `prepare-yuqi-three-judge-pilot.mjs` stage 1 solely to mint DIRECT_REPLY release/store material. Verify distinct stable/candidate DBs, sessions, release IDs, and zero production side effects.

- [ ] **Step 4: Run candidate keys in frozen order**

For each candidate key, call the production runner with `--execute --execution-only --only-final-key`. Reuse the same open run ID with `--resume-run`. On technical failure, retry that call up to three total attempts; after the third failure record it and continue to the same-category replacement.

- [ ] **Step 5: Stop once each category quota has enough discriminating pairs**

Run the exporter after each completed pair. Continue only until the final `3/3/2/2/2` slots are filled or all 24 frozen candidates are exhausted. Do not run either AI evaluator.

### Task 6: Final package and isolation audit

**Files:**
- Private ignored outputs only.

**Interfaces:**
- Consumes: execution ledger, pool manifest, discriminability audit, sealed mapping.
- Produces: final `human-review-questions.md`, `human-review-score-template.json`, `run-summary.json`, and checksum manifest.

- [ ] **Step 1: Verify the package**

Require exactly 12 scored items, category quotas `3/3/2/2/2`, at least two same-batch multi-bubble items, no release/model labels in the human files, sealed map checksum binding, and complete replacement/failure counts.

- [ ] **Step 2: Verify zero production writes**

Compare source database checksums, production side-effect baselines, source worktree identity, and absence of relay/message/action writes. Confirm all mutable evidence remains under the ignored private directory.

- [ ] **Step 3: Deliver the human review**

Copy only the human Markdown to the user-visible Downloads location if permitted; otherwise provide the private project path. Report the number of candidates executed, exact replacements, substantive replacements, technical failures, and why each replacement did not enter the 12-item score.
