# A.L. Session Summarizer v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically summarize closed, persisted visible A.L. conversation sessions into the existing Persona Evolution Repository without affecting chat execution.

**Architecture:** A read-only store projection feeds pure session-boundary logic. An isolated closed-output generator and an idempotent summarizer write one latest-state summary per session, while a small worker reuses the existing runtime timer pattern for sweep and restart recovery.

**Tech Stack:** Node.js ESM, `node:test`, SQLite via the existing `YuqiStore`, file-backed Persona Evolution Repository, Codex app-server JSON-RPC.

## Global Constraints

- Default idle timeout is exactly `30 * 60 * 1000`; sweep default is `60 * 1000`; both are configurable in one place.
- Source only canonical/committed visible conversation data; never DOM, UI shadow, prompts, reasoning, diagnostics, tools, SQL, configuration, or secrets.
- The generator output has exactly `keyEvents`, `emotionalSummary`, and `importantDecisions`; `topic` is forbidden.
- Generator failure or summary persistence failure never blocks chat.
- Long sessions preserve every ordered source item through chunk and merge.
- Do not create memories, interpretations, proposals, personality changes, proactive messages, connectors, or expression changes.

---

### Task 1: Pure session boundary and source projection contract

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/session-boundary.mjs`
- Create: `yuqi-runtime/test/session-boundary.test.mjs`
- Modify: `yuqi-runtime/src/store.mjs`

**Interfaces:**
- Produces: `deriveSessionId({roleId, conversationId, firstMessageId})`.
- Produces: `splitVisibleSessions({roleId, conversationId, messages, idleTimeoutMs})`.
- Produces: `store.listCanonicalVisibleConversationItems(roleId, {after, limit})` returning ordered closed visible items and a continuation cursor.

- [ ] Write failing tests for 29-minute continuity, 31-minute split, next-message split, stable session ID, role isolation, visible-only filtering, and paginated order.
- [ ] Run `node --test yuqi-runtime/test/session-boundary.test.mjs`; expect failures for missing exports/API.
- [ ] Implement validation, deterministic IDs, boundary splitting, and a store-owned read projection that joins canonical authority and committed actions while excluding suppressed/redacted/cancelled/internal rows.
- [ ] Re-run the focused test; expect all Task 1 cases to pass.

### Task 2: Extend the existing summary entity with idempotent latest-state storage

**Files:**
- Modify: `yuqi-runtime/src/persona-evolution/repository.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/schemas.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/validation.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/file-repository.mjs`
- Modify: `yuqi-runtime/test/persona-evolution-file-repository.test.mjs`
- Create: `yuqi-runtime/test/session-summarizer.test.mjs`

**Interfaces:**
- Produces: `getSessionSummaryBySourceSessionId(roleId, sourceSessionId)`.
- Produces: `putSessionSummaryForSession(roleId, input)` returning `{status, entity}` where status is `created|updated|unchanged`.

- [ ] Write failing repository tests for create, same-digest no-op, changed-digest same-ID revision increment, cross-role isolation, concurrent duplicate rejection, legacy summary readability, and atomic invalid-input failure.
- [ ] Run the focused repository and summarizer tests; expect failures for missing methods/schema.
- [ ] Add a strict automatic-summary variant alongside the legacy payload, plus atomic keyed create/update semantics.
- [ ] Re-run focused tests and confirm no duplicate files or partial writes.

### Task 3: Closed generator, prompt, digest, and chunk/merge orchestration

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/session-summary-prompt.mjs`
- Create: `yuqi-runtime/src/persona-evolution/session-summary-generator.mjs`
- Create: `yuqi-runtime/src/persona-evolution/session-summarizer.mjs`
- Modify: `yuqi-runtime/test/session-summarizer.test.mjs`

**Interfaces:**
- Produces: `validateSessionSummaryOutput(value)`.
- Produces: `SessionSummaryGenerator.generate(input, options)`.
- Produces: `SessionSummarizer.summarizeSession({roleId, conversationId, sessionId, messages, startedAt, endedAt})` returning `{status, summaryId, revision}`.
- Produces: `SessionSummarizer.finalizeSession(session)` as the explicit internal finalization API.

- [ ] Write failing tests for normal summary, no decisions, null emotions, topic/unknown field rejection, stable source digest, unchanged digest no generator call, changed digest update, generator/invalid-output no write and retry, and structured metadata-only logs.
- [ ] Run `node --test yuqi-runtime/test/session-summarizer.test.mjs`; expect contract/orchestrator failures.
- [ ] Implement the closed prompt/output validation, source digest, fake-injectable generator, keyed in-flight dedupe, and repository orchestration.
- [ ] Add failing long-session tests asserting every source ID enters exactly one chunk, merge gets all chunk outputs in order, and chunk summaries are not persisted.
- [ ] Implement approximate canonical JSON byte budgeting and final merge generation; re-run until green.

### Task 4: One-shot Codex isolation

**Files:**
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Modify: `yuqi-runtime/test/codex-client.test.mjs`
- Modify: `yuqi-runtime/src/persona-evolution/session-summary-generator.mjs`
- Modify: `yuqi-runtime/test/session-summarizer.test.mjs`

**Interfaces:**
- Produces: `codexClient.runIsolatedTurn(input, {model, effort, outputSchema, turnTimeoutMs})`.

- [ ] Write a failing transport test proving a new read-only thread is started, one turn uses the supplied schema, no `setSession`/`incrementSessionTurnCount` occurs, and failures propagate to the summarizer only.
- [ ] Run the focused client test and observe the missing method failure.
- [ ] Extract the shared turn-wait primitive and implement the one-shot path without touching role queues or stored role sessions.
- [ ] Re-run client and summarizer tests; confirm cognition role thread IDs remain unchanged.

### Task 5: Automatic sweep, message-arrival backstop, and restart recovery

**Files:**
- Create: `yuqi-runtime/src/persona-evolution/session-summary-worker.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Modify: `yuqi-runtime/src/turn-dispatcher.mjs`
- Modify: `yuqi-runtime/src/config.example.json`
- Modify: `yuqi-runtime/test/session-boundary.test.mjs`
- Modify: `yuqi-runtime/test/session-summarizer.test.mjs`
- Modify: `yuqi-runtime/test/turn-dispatcher.test.mjs`

**Interfaces:**
- Produces: `SessionSummaryWorker.start()`, `stop()`, `sweep()`, `recover()`, and `observeVisibleMessage(message)`.
- Consumes: the Task 1 source projection and Task 3 `finalizeSession`.

- [ ] Write failing tests for idle sweep, new-message backstop, restart recovery, two simultaneous triggers producing one summary, and failure swallowing at the chat boundary.
- [ ] Run the three focused test files and observe missing worker/wiring behavior.
- [ ] Implement one serialized worker, unref'd timer, startup recovery, and a fire-and-forget dispatcher observation hook with metadata-only error logging.
- [ ] Wire `sessionSummary.enabled`, `idleTimeoutMs`, `sweepIntervalMs`, `model`, `effort`, and `maxInputBytes` in `main.mjs` and the example config.
- [ ] Re-run focused tests and prove chat accept succeeds when summary generation throws.

### Task 6: Scope and regression gates

**Files:**
- Test: `yuqi-runtime/test/session-boundary.test.mjs`
- Test: `yuqi-runtime/test/session-summarizer.test.mjs`
- Test: all project tests selected by `npm test`

- [ ] Run `node --test yuqi-runtime/test/session-boundary.test.mjs yuqi-runtime/test/session-summarizer.test.mjs`; expect zero failures/skips.
- [ ] Run the relevant repository/client/dispatcher focused tests; expect zero failures/skips.
- [ ] Run `npm test`; expect the complete project gate to pass.
- [ ] Run `git diff --check` and inspect the staged file list; exclude all pre-existing unrelated dirt.
- [ ] Commit only this feature with `git commit -m "feat: add automatic session summarizer"`.
- [ ] Report files, architecture, trigger/restart behavior, idempotency, chunking, model isolation, exact tests, commit SHA, and explicitly confirm Experience Interpreter was not implemented.
