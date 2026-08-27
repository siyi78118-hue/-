# A.L. Experience Interpreter v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one cautious first-person Experience Interpretation for each automatic Session Summary without modifying personality, memory, proposals, summaries, or chat behavior.

**Architecture:** Extend the existing interpretation entity in place, add deterministic retrieval/context/generator/interpreter modules, and attach a disabled-by-default background recovery worker to the shared Persona repository. Production model calls use the existing isolated Codex turn API.

**Tech Stack:** Node.js ESM, file-backed Persona repository, `node:test`, Codex app-server isolated turn API.

## Global Constraints

- Reuse the existing `experience_interpretation`, Personality State, Memory, and Session Summary facts; create no parallel system.
- Read no raw chat transcript in Stage 3.
- Keep legacy schema-version-1 interpretations readable; do not migrate absent data.
- Default Memory limit is 8; only active Memory is eligible; no embeddings or external service.
- Never create a proposal or Memory, mutate Personality or Summary, or block chat.
- Disable production Stage 3 by default and stop after Stage 3.

---

### Task 1: Closed schema and repository upsert

**Files:**
- Modify: `yuqi-runtime/src/persona-evolution/schemas.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/validation.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/repository.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/file-repository.mjs`
- Modify: `yuqi-runtime/test/persona-evolution-file-repository.test.mjs`

**Interfaces:**
- Produces: `getExperienceInterpretationBySessionSummary(roleId, sessionSummaryId)` and `putExperienceInterpretationForSessionSummary(roleId, input)`.

- [ ] Write failing tests for automatic payload validation, legacy-read compatibility, unique lookup, create/no-op/update same ID, revision CAS behavior, and concurrent same-summary calls.
- [ ] Run `node --test yuqi-runtime/test/persona-evolution-file-repository.test.mjs`; verify failures name missing schema/repository behavior.
- [ ] Add the automatic payload key set and strict nested validators; discriminate persisted automatic rows by `inputDigest` while retaining legacy validation.
- [ ] Add keyed repository serialization and create/no-op/update behavior using atomic file replacement.
- [ ] Re-run the repository test and commit only after green.

### Task 2: Deterministic Memory retrieval and minimal context

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/experience-memory-retriever.mjs`
- Create: `yuqi-runtime/src/persona-evolution/experience-context-builder.mjs`
- Create: `yuqi-runtime/test/experience-memory-retriever.test.mjs`

**Interfaces:**
- Produces: `ExperienceMemoryRetriever.retrieve({ roleId, sessionSummary, memories, limit })` and `buildExperienceContext({ sessionSummary, personalityState, relevantMemories })`.

- [ ] Write failing tests for Chinese/Latin lexical relevance, explicit source relation, only-active filtering, zero results, configured limit, stable ranking, low-confidence preservation, conflicts retained, and exact context keys.
- [ ] Run the focused retrieval test and verify missing-module failures.
- [ ] Implement NFKC tokenization with Latin/digit tokens and CJK bigram/trigram sets, then deterministic scoring and strict minimal projection.
- [ ] Re-run until all retrieval/context cases pass.

### Task 3: Isolated generator and prompt contract

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/experience-interpretation-prompt.mjs`
- Create: `yuqi-runtime/src/persona-evolution/experience-interpretation-generator.mjs`
- Create: `yuqi-runtime/test/experience-interpreter.test.mjs`

**Interfaces:**
- Produces: `validateExperienceInterpretationOutput(value)`, abstract `ExperienceInterpretationGenerator`, and `CodexExperienceInterpretationGenerator.generate(context)`.

- [ ] Write failing output-contract tests for exact keys, 0–5 hypotheses, confidence, four impact levels, native next-stage boolean, independent impact/recommendation pairs, and `memoryRefsUsed` closure.
- [ ] Verify the test fails because the module is absent.
- [ ] Implement the centralized prompt, strict JSON schema/parser, and one-shot `runIsolatedTurn` adapter.
- [ ] Re-run focused generator tests to green.

### Task 4: Interpreter orchestration and hard mutation guarantees

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/experience-interpreter.mjs`
- Modify: `yuqi-runtime/test/experience-interpreter.test.mjs`

**Interfaces:**
- Produces: `ExperienceInterpreter.interpretSession({ roleId, sessionSummaryId, force? })` returning status, ID, revision, impact level, and recommendation.

- [ ] Write failing integration tests for base creation, null Personality, zero Memory, role isolation, Memory-reference rejection, generator failure atomicity, duplicate triggers, digest no-op, revised Summary update, later Personality no-op, and strict no-write snapshots for Personality/Memory/Summary/Proposal.
- [ ] Verify the red failures are caused by the missing interpreter.
- [ ] Implement read-only context assembly, historical no-op gate, stable digest, generator invocation, provenance conversion, and one repository upsert.
- [ ] Re-run focused tests and refactor only while green.

### Task 5: Non-blocking trigger and restart recovery

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/experience-interpretation-worker.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/session-summary-worker.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Modify: `yuqi-runtime/config.example.json`
- Modify: `yuqi-runtime/test/session-summarizer.test.mjs`
- Modify: `yuqi-runtime/test/experience-interpreter.test.mjs`

**Interfaces:**
- Produces: `ExperienceInterpretationWorker.start/stop/recover/observeSummary/idle`.

- [ ] Write failing tests for async summary notification, failure not changing Stage 2 result, startup recovery of missing interpretations, existing interpretation skip, and later Personality changes not causing recovery regeneration.
- [ ] Verify the trigger/recovery tests fail before production wiring.
- [ ] Share one Persona repository in runtime composition, attach a non-blocking summary observer, add periodic recovery, and configure Stage 3 disabled by default with memory limit 8.
- [ ] Re-run Stage 2 and Stage 3 focused tests.

### Task 6: Gates, synthetic smoke, documentation, and commit

**Files:**
- Modify: `docs/AL_PROJECT_COGNITION.md`
- Test: all Stage 1–3 test files

**Interfaces:**
- Produces: verified Stage 3 implementation commit; no Stage 4 artifact.

- [ ] Run `node --test yuqi-runtime/test/experience-memory-retriever.test.mjs yuqi-runtime/test/experience-interpreter.test.mjs yuqi-runtime/test/persona-evolution-file-repository.test.mjs yuqi-runtime/test/session-boundary.test.mjs yuqi-runtime/test/session-summarizer.test.mjs`.
- [ ] Run `npm test`; classify any failure without skipping existing contracts.
- [ ] Run four isolated synthetic real-model cases and record manual quality observations; never use their output as production data.
- [ ] Update only verified Stage 3 state in `docs/AL_PROJECT_COGNITION.md`.
- [ ] Run `git diff --check`, stage only listed files, commit `feat: add experience interpreter v0.1`, push `codex/al-tdd`, verify remote SHA, and stop before Stage 4.
