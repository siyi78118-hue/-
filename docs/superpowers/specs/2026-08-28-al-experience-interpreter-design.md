# A.L. Experience Interpreter v0.1 Design

## Goal and boundary

Turn one persisted `session_summary` into one first-person, evidence-bounded `experience_interpretation` using the existing Personality State and a small deterministic selection of existing active Memories.

This stage explains what an experience may mean to A.L. It does not summarize raw chat again, mutate Personality State, create or update Memory, create a Change Proposal, alter expression, or affect proactive behavior. Stage 4 is explicitly out of scope.

## Prerequisites and compatibility

The current branch contains the Stage 1 repository and all five entity types, plus the Stage 2 automatic Session Summarizer. `docs/CHATGPT_COLLAB_MEMORY.md` is absent from the working tree and all local Git history; no pending producer is registered. The implementation therefore uses `docs/AL_PROJECT_COGNITION.md`, the approved task contract, and current code as authority.

There are no files in the default `yuqi-runtime/local_data/persona` path. The existing `experience_interpretation` shape remains readable under `schemaVersion = 1`; the automatic Stage 3 shape is discriminated by `inputDigest`, just as automatic and legacy Session Summaries already coexist. No migration or parallel entity type is introduced.

## Chosen architecture

1. `experience-memory-retriever.mjs` ranks only active Memories with deterministic Unicode-aware lexical overlap, explicit source relation, kind affinity, and recency. It returns at most the configured limit and preserves conflicting evidence.
2. `experience-context-builder.mjs` projects exactly the current Session Summary, minimal Personality State fields, and selected Memory fields. It never reads raw messages or exposes repository metadata, prompts, diagnostics, tool state, SQL, or secrets.
3. `experience-interpretation-generator.mjs` owns strict model input/output validation. The production adapter uses the existing isolated Codex turn mechanism; unit tests inject a fake generator.
4. `experience-interpreter.mjs` loads repository state, observes existing interpretation idempotency, computes the stable input digest, invokes the generator, validates referenced Memory IDs, builds provenance/context snapshots, and performs one repository upsert.
5. `experience-interpretation-worker.mjs` receives non-blocking summary-completion notifications and performs periodic/startup recovery for summaries that have no interpretation.

The runtime shares one `FilePersonaEvolutionRepository` between Stage 2 and Stage 3. Stage 3 is disabled by default because it adds a production background model call to the current stable runtime.

## Data contract

The automatic interpretation payload is:

```json
{
  "sessionSummaryId": "sum_xxx",
  "meaning": "我目前认为……",
  "selfImpact": "这没有明显改变……",
  "hypotheses": [{ "statement": "我可能……", "confidence": 0.4 }],
  "impact": { "level": "none|low|medium|high", "rationale": "……" },
  "nextStage": { "recommendProposal": false, "rationale": "……" },
  "sourceRefs": [{ "type": "session_summary", "id": "sum_xxx" }],
  "inputDigest": "lowercase sha256",
  "context": {
    "summaryRevision": 1,
    "summarySourceDigest": "lowercase sha256",
    "personalityRevision": null,
    "memoryRefs": [{ "id": "mem_xxx", "revision": 1 }]
  },
  "generation": {
    "interpreterVersion": "experience-interpreter-v0.1",
    "promptVersion": "experience-interpretation-prompt-v1",
    "model": "model-id"
  }
}
```

The model output contains exactly `meaning`, `selfImpact`, `hypotheses`, `impact`, `nextStage`, and `memoryRefsUsed`. Hypotheses are bounded to 0–5, confidence is 0–1, impact levels are a closed enum, next-stage recommendation is a native boolean, and Memory references must be a unique subset of selected Memories. Impact and recommendation have no hard-coded coupling.

## Retrieval

Only `status = active` Memories are candidates. Query text is derived from Stage 2 `keyEvents`, `emotionalSummary`, and `importantDecisions`; the retriever never reads raw transcript. Unicode NFKC normalization produces Latin/digit tokens plus Chinese character bigrams and trigrams. Ranking is deterministic by source relation, overlap, modest kind affinity, timestamp recency, and stable ID tie-break.

Zero Memories is valid. Low-confidence Memories retain their confidence. Conflicting active Memories remain eligible; the retriever does not decide which is true.

## Idempotency and historical meaning

`roleId + sessionSummaryId` is the logical unique key.

- no existing interpretation: generate and create revision 1;
- existing interpretation for the same Summary revision/source digest: return `unchanged` before rereading current Personality or Memories and without a model call;
- legally revised Summary: regenerate into the same interpretation ID and increment revision;
- later Personality or Memory changes alone: do not reinterpret historical experience;
- explicit developer rerun may opt into rebuilding context, but still updates the same entity.

The input digest binds the Summary ID and revision/source digest, selected Memory IDs/revisions, Personality revision, prompt version, and interpreter version. The persisted context captures the Summary revision/digest plus Personality and Memory references/revisions, never Memory bodies. The stored Summary revision/digest is the authority that prevents later Personality or Memory changes from retroactively rewriting an already interpreted Summary.

## Isolation, failure, and observability

Production generation starts a fresh read-only Codex thread and never touches the primary cognition thread. Strict JSON parsing rejects prose, Markdown, unknown fields, invalid native types, unprovided Memory references, and malformed output.

Retrieval, generation, validation, or persistence failure creates no partial interpretation and never changes the Summary, Personality, Memories, proposals, or chat path. The worker catches failures and retries during later recovery.

Logs use the required `experience_interpretation_*` events and contain only IDs, counts, impact/recommendation values, duration, and error class. Private text is never logged.

## Verification

TDD covers the 26 required cases: base creation, null Personality, zero/active/limited/conflicting Memories, role isolation, closed output validation, Memory-reference closure, mutation prohibitions, atomic failure, concurrent triggers, digest no-op, revised Summary update, later Personality no-op, restart recovery, source projection isolation, `none` impact, and independent impact/recommendation combinations.

The final gates are Stage 3 focused tests, existing Persona/Session tests, and `npm test`. Four real-model synthetic smoke cases run only after deterministic gates and remain quality evidence rather than schema correctness evidence.
