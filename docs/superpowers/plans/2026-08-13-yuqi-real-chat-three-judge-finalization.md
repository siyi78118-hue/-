# Yuqi Real-Chat Three-Judge Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Import the user's completed 12-item blind review, run two independent Codex judges over the same anonymous A/B package, and reveal a checksum-bound stable/candidate comparison only after all three judgments are durably recorded.

**Architecture:** Add one closed pure contract for parsing the filled Markdown, validating two machine judges, and combining categorical A/B/tie votes with weights `0.50/0.25/0.25`. Add two small private-artifact scripts: one imports and seals the human review before any model mapping is read, and one calls the two already-frozen evaluator lanes once each with at most three total attempts. A finalizer reads the sealed mapping only after the human and both AI artifacts validate, then emits a machine report and a plain-language report with a sensitivity view that excludes user-flagged flawed questions.

**Tech Stack:** Node.js ESM, `node:test`, existing `CodexAppServerClient`, JSON Schema structured output, canonical JSON/SHA-256, ignored private artifacts.

## Global Constraints

- Reuse the existing 12 anonymous A/B pairs byte-for-byte; do not rerun stable or candidate execution.
- The human artifact is written and checksum-bound before either AI judgment and before reading `sealed-mapping.json`.
- Each AI evaluator sees only the blank anonymous questionnaire plus a closed question manifest; it never sees human scores, release names, model profiles, or the sealed mapping.
- Evaluator primary remains the frozen `gpt-5.6-sol/medium` lane; evaluator secondary remains the frozen independent `gpt-5.6-terra/high` lane.
- Each evaluator handles all 12 questions in one structured-output call; a failed call may be retried up to three total attempts and partial output is never scored.
- Comparable fields are exactly `overall`, `humanLike`, `understandsUser`, `characterLike`, and `continueChat`, each `A|B|tie`.
- Final weights are human `0.50`, primary AI `0.25`, secondary AI `0.25`.
- Question 11 is retained in the raw 12-item report and separately flagged `source_question_flaw`; the primary verdict also reports an 11-item sensitivity result without it.
- Preserve unrelated dirty worktree files and keep all personal text/model outputs under ignored private artifacts.

---

### Task 1: Closed review and aggregation contract

**Files:**
- Create: `yuqi-runtime/src/real-chat-three-judge.mjs`
- Create: `yuqi-runtime/test/real-chat-three-judge.test.mjs`

**Interfaces:**
- Consumes: blank review Markdown, filled review Markdown, score template, run summary, AI judgment objects, and sealed mapping.
- Produces: `parseCompletedHumanReview(input)`, `buildRealChatJudgeInput(input)`, `validateRealChatJudgeOutput(input)`, and `combineRealChatThreeJudgeResults(input)`.

- [x] **Step 1: Write failing contract tests**

Cover all 12 questions, the malformed-but-unambiguous Q7 `_差不多___` token, exact preservation of context/A/B answer text, missing/duplicate/unknown choices, the explicit Q11 flag, closed AI output shape and ordering, mapping checksum binding, `0.50/0.25/0.25` vote conversion, raw 12-item aggregation, and 11-item sensitivity aggregation.

- [x] **Step 2: Run the focused test and observe red**

Run: `node --test yuqi-runtime/test/real-chat-three-judge.test.mjs`

Expected: FAIL because `real-chat-three-judge.mjs` does not exist.

- [x] **Step 3: Implement the minimal pure contract**

The human and AI item shape is exactly:

```js
{
  question: 1,
  candidateId: 'real_candidate_00',
  overall: 'A' | 'B' | 'tie',
  humanLike: 'A' | 'B' | 'tie',
  understandsUser: 'A' | 'B' | 'tie',
  characterLike: 'A' | 'B' | 'tie',
  continueChat: 'A' | 'B' | 'tie',
  commentA: '...',
  commentB: '...',
  questionConcern: false
}
```

Reject any changed question context or answer text by comparing a question-content projection of the filled Markdown to the blank source. Convert blinded votes to candidate probability only after validating the sealed mapping: candidate-side vote `1`, opposite-side vote `0`, tie `0.5`. Compute weighted per-item/per-dimension probability and summary means without rounding the stored value.

- [x] **Step 4: Run the focused test green**

Run: `node --test yuqi-runtime/test/real-chat-three-judge.test.mjs`

Expected: PASS with zero skipped tests.

### Task 2: Human import and two independent blind judges

**Files:**
- Create: `scripts/import-yuqi-real-chat-human-review.mjs`
- Create: `scripts/run-yuqi-real-chat-blind-judges.mjs`
- Create: `tests/yuqi-real-chat-three-judge-flow.test.mjs`

**Interfaces:**
- Consumes: private package directory, user-filled Markdown path, frozen production config, and copied Codex executable.
- Produces: `human-judgment.json`, `judge-input.json`, `evaluator-primary.json`, `evaluator-secondary.json`, and `judge-run-summary.json`.

- [x] **Step 1: Write failing flow tests**

Use a synthetic 12-item package and injected fake clients. Assert the human artifact is written first, its checksum is included in both evaluator authorities but its content is absent from prompts, each evaluator receives the same anonymous prompt and closed schema, distinct frozen model/effort lanes are used, successful output is atomic, invalid output retries at most three times, and the sealed mapping file is never opened by either import or judge execution.

- [x] **Step 2: Run the flow test and observe red**

Run: `node --test tests/yuqi-real-chat-three-judge-flow.test.mjs`

Expected: FAIL because both scripts are missing.

- [x] **Step 3: Implement import and judge execution**

`importCompletedHumanReview()` calls the Task 1 parser, records the input file SHA-256, blank package checksum, run/bundle identity, explicit question flags, and an artifact checksum. `runBlindJudges()` requires that artifact, constructs one identical blind input, and creates a fresh read-only app-server client for each evaluator attempt. It passes the frozen lane's exact model and effort plus a 12-item structured-output schema, validates the parsed JSON, and records thread/turn identity and checksums without storing chain-of-thought.

- [x] **Step 4: Run focused flow and contract tests green**

Run: `node --test yuqi-runtime/test/real-chat-three-judge.test.mjs tests/yuqi-real-chat-three-judge-flow.test.mjs`

Expected: PASS with zero skipped tests.

### Task 3: Post-judgment unsealing and report

**Files:**
- Create: `scripts/finalize-yuqi-real-chat-three-judge.mjs`
- Modify: `tests/yuqi-real-chat-three-judge-flow.test.mjs`

**Interfaces:**
- Consumes: validated human/primary/secondary artifacts, run summary, blank package, and sealed mapping.
- Produces: `three-judge-final-report.json` and `three-judge-final-report.md`.

- [x] **Step 1: Add a failing unsealing test**

Assert finalization fails before all three judgment artifacts exist, on any checksum/mapping/question-order change, or when an evaluator saw a different blind input. Assert mapping identities first appear only in final outputs. Verify the raw 12-item and flagged-question-excluded 11-item summaries and the directional threshold: candidate at least `0.625`, stable at most `0.375`, otherwise `no_clear_winner`.

- [x] **Step 2: Run the focused flow test red**

Run: `node --test tests/yuqi-real-chat-three-judge-flow.test.mjs`

Expected: FAIL because the finalizer is missing.

- [x] **Step 3: Implement finalization and plain-language rendering**

Read and validate all non-mapping artifacts first. Only then read the mapping, verify `runSummary.sealedMappingChecksum`, map every A/B vote, compute the weighted summaries, and write both reports atomically. The Markdown names the two compared profiles, shows judge agreement/disagreement, preserves the user's comments, separates source-question flaws from model faults, and does not claim statistical certainty from 12 items.

- [x] **Step 4: Run focused and existing evaluation gates**

Run:

```powershell
node --test yuqi-runtime/test/real-chat-blind-evaluation.test.mjs yuqi-runtime/test/real-chat-three-judge.test.mjs tests/yuqi-real-chat-blind-evaluation-flow.test.mjs tests/yuqi-real-chat-three-judge-flow.test.mjs
node --check scripts/import-yuqi-real-chat-human-review.mjs
node --check scripts/run-yuqi-real-chat-blind-judges.mjs
node --check scripts/finalize-yuqi-real-chat-three-judge.mjs
git diff --check
```

Expected: all tests pass, all syntax checks exit `0`, and no unrelated file appears in the task diff.

### Task 4: Private production execution

**Files:**
- Private ignored artifacts only under `artifacts/yuqi-lived-agency-v3/private/real-chat-blind-evaluation/`.

**Interfaces:**
- Consumes: the user's attached scored Markdown and the frozen package/model materials.
- Produces: two independent AI judgments and final three-judge reports.

- [x] **Step 1: Import the user's completed review**

Run the importer with the attached Markdown and `--question-flaw 11`. Verify 12 complete items, 60 choices, no changed context/answer text, and a stable human artifact checksum.

- [x] **Step 2: Run both AI judges**

Call the frozen primary and secondary lanes. Retry only failed/invalid calls, up to three total attempts per lane. Verify both outputs bind to the same judge-input checksum and that the sealed mapping file checksum and mtime are unchanged.

- [x] **Step 3: Finalize and audit**

After both AI artifacts are durable, run the finalizer. Verify the source DB, stable/candidate outputs, blank questionnaire, run summary, and package checksums are unchanged; only new private judgment/report files may appear.

