# A.L. Session Summarizer v0.1 Design

## Goal and boundary

Automatically turn one closed, visible A.L. conversation session into one grounded `session_summary` entity in the existing Persona Evolution Repository.

This version does not create memories, experience interpretations, change proposals, personality changes, proactive messages, or expression changes. Summary failures never block or alter chat delivery.

## Chosen architecture

The implementation uses the existing PC runtime authority and the existing file-backed Persona repository. It does not add a second session database.

1. `YuqiStore` exposes a read-only, paginated projection of canonical visible messages and committed visible actions.
2. `session-boundary.mjs` filters and orders that projection, splits it by a configurable idle timeout, and derives a stable session ID from `roleId`, logical conversation ID, and first message ID.
3. `session-summary-generator.mjs` owns the closed model input/output contract. Production calls an isolated one-shot Codex thread; tests inject a fake generator.
4. `session-summarizer.mjs` computes the source digest, chunks long sessions without dropping messages, invokes the generator, and performs one idempotent repository upsert.
5. `session-summary-worker.mjs` performs a 60-second sweep, startup recovery, and a non-blocking new-visible-message observation path.

## Authority and input contract

The source is only persisted visible conversation data:

- user-visible user messages;
- final visible assistant messages backed by committed canonical authority or the existing legacy visible path;
- committed visible structured actions converted by a closed deterministic formatter.

Suppressed, redacted, cancelled, diagnostic, prompt, reasoning, tool, SQL, configuration, and secret data are excluded. Data is paginated until exhaustion; the existing 5,000-message convenience limit is not used.

Each normalized source item has exactly:

```json
{
  "id": "msg_or_action_id",
  "speaker": "user|assistant|system_event",
  "createdAt": "ISO-8601 UTC",
  "content": "visible text"
}
```

The source digest is SHA-256 over the canonical ordered tuples of ID, speaker, content, and timestamp.

## Session boundary

The default idle timeout is 30 minutes and is configured once under `sessionSummary.idleTimeoutMs`. Consecutive visible items for the same `roleId + conversationId` belong to one session until the gap reaches the timeout. A session ID is a stable `ses_` hash derived from role, conversation, and the first visible item ID.

Two triggers share the same `finalizeSession` path:

- a periodic sweep closes sessions whose last item is idle;
- observation of a new visible message first closes the prior session when the preceding gap crossed the boundary.

Startup runs the same discovery against persisted messages and existing `sourceSessionId` values, so a missed timer is recoverable.

## Generator isolation and contracts

The generator receives a closed JSON object containing session identity, role, times, and ordered visible messages. Its output must contain exactly:

```json
{
  "keyEvents": [],
  "emotionalSummary": {
    "user": null,
    "al": null,
    "interaction": null
  },
  "importantDecisions": []
}
```

All arrays contain bounded non-empty strings. Emotion fields are bounded strings or `null`. Unknown fields, including `topic`, are rejected. The prompt requires grounded reporting, cautious emotion attribution, strict decisions, no advice, no evaluation, no personality interpretation, and no hidden reasoning.

Production generation starts a fresh read-only Codex thread and never stores it in the cognition session table. Long sessions are split by an approximate JSON-byte budget. Every source item appears in exactly one chunk; chunk results are merged through the same closed contract and are never persisted.

## Storage and idempotency

The existing `session_summary` entity is extended in place with the automatic-summary fields:

- `sourceSessionId`, `startedAt`, `endedAt`;
- ordered `sourceMessageIds`, `sourceDigest`;
- `keyEvents`, `emotionalSummary`, `importantDecisions`;
- `generation: { summarizerVersion, promptVersion, model }`.

Legacy v0.1 repository summaries remain readable. Automatic summaries use `roleId + sourceSessionId` as a logical unique key.

- missing summary: create revision 1;
- same digest: no model call and return `unchanged`;
- changed digest: update the same ID and increment revision;
- concurrent same-session triggers: one in-process keyed operation; repository uniqueness remains fail-closed.

No historical duplicate is created.

## Failures and observability

Generator errors, invalid output, repository conflicts, and source authority failures produce no partial summary and do not propagate into chat acceptance. They remain retryable on the next sweep.

Structured log events are `started`, `completed`, `skipped_existing`, `regenerated`, and `failed`, carrying only role ID, session ID, message count, duration, and stable error category. Conversation and summary bodies are never logged.

## Verification

Focused tests cover the 17 cases in the task: 29/31-minute boundaries, message-arrival split, normal/no-decision/null-emotion output, unknown-field rejection, duplicate triggers, digest no-op/update, generator and schema failure atomicity, role isolation, visible-only filtering, chunk/merge completeness, restart recovery, and proof that no memory/interpretation/proposal/personality/message is created.

The final gates are the two focused test files followed by `npm test`. A real-model smoke test is optional, synthetic-only, and is not a correctness dependency.
