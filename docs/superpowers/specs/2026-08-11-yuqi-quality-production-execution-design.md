# Yuqi Quality Production Execution Design

**Date:** 2026-08-11  
**Status:** approved for implementation after independent review  
**Source candidate:** Git `49f24612` until the reviewed Task25G implementation replaces it  
**Input plan checksum:** `dc704d836d1b0224f0202b5771f38334292df90eaedd7c8f8880c7c3bb89243c`

## Goal

Run the 246-item lived-quality plan through the real stable and candidate production release adapters, obtain two independent blind judgments for every item, and preserve restart-safe evidence without mutating production data or pretending that mocks are promotion evidence.

## Why the Existing Runner Is Not Executable Evidence

The current quality runner has six authority gaps:

1. `compileSceneExecutionInput()` produces an abstract scene, while the production adapters require a persisted `turn/envelope/currentBatch` or a persisted life-planning attempt.
2. `runScenePair()` calls `executeTurn()` for every kind, including `LIFE_PLANNING`, which must call `executeLife()`.
3. The eight planned `LIFE_PLANNING` finals contain feature-coupled conversation scenes, not a valid life-planning context, and the current blind projector cannot represent a life-plan result.
4. Results are written only after the whole loop finishes, so a shutdown can lose completed calls and cause repeated billing.
5. The second evaluator's complete judgment is not retained and evaluator disagreement is not closed over all scores, preference, findings, and unresolved state.
6. The reporter assumes one or two evaluator calls per final and cannot prove a variable number of nested production model calls.

Executing the current runner would either fail immediately or generate evidence that does not prove real product behavior.

## Chosen Architecture

### 1. Closed, kind-aware quality subjects

Create a closed subject union:

```js
compileQualitySubject(item) -> {
  version: 1,
  subjectType: 'turn' | 'life_planning',
  finalKey,
  turnKind,
  semanticInput,
  semanticInputChecksum,
  blindAnnotation
}
```

All nine interaction kinds use `executeTurn()`. `LIFE_PLANNING` uses `executeLife()` only. Unknown kinds, subject/method mismatches, and unsupported scene fields fail before any model call.

The frozen 246-item plan has no binary attachments. The runner proves this during plan preflight and rejects an attachment-bearing plan instead of silently omitting image preparation. Normal application image preparation remains unchanged and outside this evidence run.

### 2. Production-faithful life-planning fixture

The plan contains eight `LIFE_PLANNING` finals: four feature-coupled scenes repeated twice. Their feature records include calendar, quote, and moment data, so they must not be coerced into fake calendar entries.

For each such subject, the bridge deterministically creates one recent, quality-only context episode through the public `putLifePlan()` API in a common immutable subject seed database:

- `anchorAt` is the parsed `candidate_response` timestamp;
- the context episode starts one minute before the feature turn and ends at the feature turn;
- its title is the exact feature text;
- its payload is closed to `fixtureVersion`, `sourceType`, `sourceMessageId`, and a transcript summary derived byte-for-byte from the scene turns;
- its ID and checksum derive from the semantic input and exclude stable/candidate side;
- no annotation rule, release identity, or evaluator hint enters the model input.

The bridge then obtains a normal `LifeSimulationCoordinator.contextFor(roleId, anchorAt)` result. Before stable/candidate execution, the closed seed database is byte-cloned into two independent writable stores. This gives both sides identical persisted lifecycle timestamps and semantic rows without sharing a mutable database.

New life attempts use `contextAuthorityVersion: 2`. Its `contextChecksum` covers `cognitiveState`, `allowedActions`, and canonical semantic projections of `current`, `recent`, and `upcoming` episodes (including episode checksum and payload, excluding lifecycle-only `createdAt`/`updatedAt`). Existing attempts without the marker continue to validate with the legacy checksum rule; only new controller-created attempts use v2. Changing feature text, transcript payload, or episode identity must change the context checksum, request base key, attempt input checksum, and ledger phase input checksum.

The cloned stores independently pass the unchanged context to `PromotionController.createLifePlanningAttempt()`. Thus the model sees a legitimate persisted recent context and planning window, while the evaluator—not the model—receives the human annotation. The test remains synthetic quality evidence; it is never represented as a real user fact.

The canonical life execution output retains its episode IDs in raw evidence. The blinded projection is a separate closed type and removes those IDs just as the turn projector removes message/action identities:

```js
{
  subjectType: 'life_planning',
  episodes: [{ ordinal, kind, title, startAt, endAt }]
}
```

It is not disguised as reply bubbles or visible actions. The life rubric interprets the existing six dimensions for background life behavior: do not hard-code one reading of an ambiguous conversation, preserve a coherent independent routine, avoid unearned service promises or invented history, keep temporal continuity, avoid template-like planning, and maintain episode integrity. Silence is mandatory.

### 3. Shared production execution input builder

The ordinary runtime and quality bridge must not maintain two copies of the turn execution shape. Add:

```js
buildCanonicalReleaseExecution(turnId, {
  localImagePaths = [],
  localImageReceipt = null
}) -> {
  turn,
  envelope,
  scene,
  currentBatch,
  localImagePaths,
  agencyView,
  routeDecision
}
```

The existing canonical runtime path calls this method before `ReleaseExecutor.executeTurn()`. The quality bridge calls the same method. The quality bridge requires the frozen plan's verified zero-attachment property and supplies empty image inputs; it cannot emulate image preparation.

After `orchestrator.accept()`, the bridge re-reads the persisted turn and proves that the authoritative stable release ID/checksum match the isolated store. Before candidate dry-run execution it proves that the candidate release row exists and exactly matches the frozen candidate manifest. Any mismatch stops before the model client.

### 4. Isolation

Every final is materialized once through production APIs in a closed common seed database, then byte-cloned into separate temporary v15 stores and separate runtime compositions. The two sides share immutable initial bytes, subject, and release manifests, but never a mutable SQLite file, lane, attempt, checkpoint, session, cache, client object, thread ID, or evaluator state.

Stable and candidate derive byte-identical authority IDs from `(runId, finalKey, semantic ordinal)`; side is deliberately excluded and appears only in the temporary database and session namespace. This proves the two releases receive the same authority input.

Each final has four independent high-level phases:

1. stable execution;
2. candidate execution;
3. evaluator A;
4. evaluator B.

The stable and candidate executions are not one combined function call. `prepareQualitySubject()` may prepare both isolated stores and immutable execution inputs, but the evidence runner executes them through two single-side calls. Before preparation it creates two distinct module-branded, initially unbound ledger phase-client slots. Each slot is an immutable input to `composeYuqiExecutionRuntime()` and is retained only in module-private runtime metadata. After the corresponding SQLite phase is atomically `running`, the slot binds exactly once to that phase's `LedgerBackedModelClient`; before binding it fails closed. Bind-before-running, repeated/conflicting binding, and cross-side/final/phase reuse reject. The runner never mutates an already composed runtime's public `codex` or `cognitivePipeline.codexClient` field.

This additive phase interface preserves the existing production runtime brand. The isolated store, release row, source head, authority snapshot, release executor, adapter registry, runtime object, model client, and session namespace are all revalidated before the one selected side executes. The legacy combined helper remains test compatibility only and is forbidden as production evidence.

### 5. Unforgeable production adapter attestation

An object that merely implements `executeTurn()` is not evidence. `runtime-composition.mjs` owns a module-private `WeakSet` brand. Only an object created by `composeYuqiExecutionRuntime()` can pass `assertProductionRuntimeAttestation(runtime)`.

The attestation is recalculated from actual composition data, not caller claims:

- fixed composition and adapter-registry versions;
- exact production turn/life adapter ID sets;
- stable and candidate release rows read from the isolated store;
- release component/model-profile checksums;
- `PresetRegistry.pipelineReleaseManifest()` output for the candidate;
- source head supplied by the runner and independently checked against the clean Git checkout.

The runner validates the brand and checksum at run creation, before each phase, and at finalization. No stub, fake executor, prompt-only emulation, or copied attestation can set `evidenceEligible: true`.

### 6. Restart-safe phase and model-call ledger

Use an ignored SQLite artifact at `artifacts/yuqi-lived-agency-v3/private/quality-replay-state.sqlite`.

The ledger contains:

- one immutable run header bound to the full 246-item plan, source head, release manifests, adapter attestation, and artifact paths;
- one phase row for every `(finalKey, phase)` where phase is `stable_execution`, `candidate_execution`, `evaluator_primary`, or `evaluator_secondary`;
- one model-call row for every underlying `CodexAppServerClient.runTurn()` made inside a phase, keyed by `(runId, finalKey, phase, ordinal)`;
- raw canonical inputs/outputs and checksums;
- deterministic `callId` and `clientUserMessageId`;
- app-server thread baseline, thread ID, turn ID when known, model, effort, schema checksum, and output checksum;
- `prepared`, `starting`, `running`, `succeeded`, `failed`, or `uncertain` state;
- one finalized row after all phases and deterministic judgment comparison complete.

The immutable run header stores the complete ordered 246-key plan identity, the exact full stable and candidate release snapshots/manifests, the full closed stable/candidate runtime and primary/secondary evaluator attestations plus their recomputed checksum, source head, and canonical project-root-relative private artifact paths. Header and nested objects use exact keys/native types; current release rows and registry manifests are re-read and compared canonically on every open. A one-item pilot changes only the selected work for that invocation; it never changes the run header. Reopening with a changed plan, source, release, attestation, or artifact identity fails before runtime or model-client construction.

`LedgerBackedModelClient` wraps both `runTurn()` and `runRole()`, resets a deterministic ordinal counter at phase entry, and replays completed nested memory, brain, supervisor, cognition, expression, repair, capacity-fallback, and evaluator calls.

`forPhase()` is executable only after the matching persisted phase is `running`. `runRole()` preserves the production `deadlineMs`/`outerDeadlineMs` calculation when it maps to `runTurn()`; the ledger wrapper must not silently change timeout behavior. A module-private brand protects the unbound/bound phase slot so a plain object cannot be inserted into an attested runtime.

Before `turn/start`, the wrapper persists the role thread ID, a `thread/read(includeTurns=true)` baseline, exact request checksum, deterministic call ID, and `starting` state. After `turn/start` returns, the client invokes an awaited `onTurnStarted` hook so the ledger persists the remote turn ID before waiting for completion.

On restart:

- a succeeded row exact-replays locally;
- a running/starting row uses `thread/read(includeTurns=true)` and accepts only one completed turn that is provably new relative to the persisted baseline and matches the exact request/client identity;
- zero, multiple, active, conflicting, or unprovable candidates become `uncertain`;
- `uncertain` is never automatically reissued.

The runner itself never maintains a second JSON state machine. SQLite `quality_runs`, `quality_phases`, `quality_model_calls`, and `quality_finals` are the only resume authority. Phase outputs and exported evidence are read back from those rows. A failed phase is terminal for that run, is never implicitly reissued, and stops later phases for that final; an uncertain call or phase atomically blocks the whole run. An evaluator's valid `unresolved` judgment is different: it is finalized as a manual-review record so the evidence is preserved.

The deterministic IDs are provenance, not a claim of provider billing idempotency. The system promises no automatic duplicate paid call after uncertainty; it does not promise that a process crash can make the remote platform exactly-once.

### 7. Blind evaluation

Both evaluators receive only a deterministic A/B projection and return a closed object. The input includes `subjectType` and the corresponding closed output union (`turn_output` or `life_plan`). Turn outputs contain only disposition plus anonymized ordered reply/action projections. LIFE outputs contain only the planning window, LIFE rubric, transcript summary, and anonymized ordered episodes; they never enter turn comparison or action logic. Release IDs/checksums, side names, phase names, prompts, model/client/session/thread identities, execution order, and attestation data are excluded.

Formal preference values are `A`, `B`, `tie`, or `unresolved`; release-side labels are rejected. The raw artifact retains both complete judgments, evaluator identity/version, input/output checksums, and latency. Any difference in a score, preference, unresolved flag, or normalized finding marks the final for manual review. Critical findings count only after independent agreement; disagreement itself is preserved as a blocking finding.

### 8. Versioned reporting and readiness evidence

The exported evidence schema is version 2 and separates:

- exactly 984 high-level phase records;
- a variable number of model-call records with `(finalKey, phase, ordinal)` identity;
- 246 execution-pair records;
- 492 complete evaluator judgment records;
- 246 finalized records and checksums.

The reporter rederives every join and checksum from the ledger export. It rejects missing/duplicate phases, model calls not owned by a phase, ordinal gaps, non-succeeded/uncertain calls, missing evaluator judgments, or run/source/release/attestation drift. Legacy structural replay artifacts may remain readable for protocol regression, but the readiness gate accepts only the version-2 production evidence schema.

### 9. CLI and bounded rollout

The CLI has exact run identity:

- first execution creates and prints `runId` and stores it in the ledger header;
- `--ledger <path>` selects the single state file;
- `--resume-run <runId>` is mandatory for every continuation;
- `--only-final-key <finalKey>` runs exactly one full-plan member and rejects missing or duplicate matches;
- the ledger header always binds all 246 final keys, including during pilots;
- removing `--only-final-key` resumes remaining finals in the same run.

No bulk model run begins until all non-model gates pass. Then run one ordinary final, inspect it, resume the same run for one life final, report the observed underlying-request multiplier and projected cost, and require an explicit bulk-cost go-ahead before the remaining 244 finals.

There are exactly 984 high-level phases. They are not equivalent to 984 model requests. Current production control flow permits a code-bound range of roughly 1,226 to 11,390 underlying requests; the pilot, not an optimistic estimate, supplies the operational multiplier. Recovery may add a request only after explicit resolution of an uncertain row, and such evidence remains blocked until the earlier remote result is proved absent.

## Data and Source Safety

- Execution occurs only in a clean detached candidate checkout.
- `git diff`, `git diff --cached`, and non-ignored untracked-file checks must be empty.
- Ignored private artifacts are not source inputs; each input plan, ledger, raw export, and report is separately checksummed in the run header.
- Only temporary v15 stores are writable.
- Production databases, live shadow counters, rollout state, cloud relay, Android Room, visible messages, and actions are never mutated.
- Dry-run capabilities remain `{ visible: false, actions: false }`.
- The candidate release definition is installed only in each temporary store; it is never registered, promoted, or activated.
- Raw artifacts live under the ignored private evidence directory.

## Acceptance Criteria

The bridge is ready for the one-item pilot only when:

- all nine interaction kinds and `LIFE_PLANNING` dispatch to the correct production method;
- all eight life finals compile through the deterministic recent-context fixture and closed life output;
- v2 life-context authority binds current/recent/upcoming semantics while legacy persisted attempts remain readable;
- turn execution uses the shared orchestrator input builder;
- the frozen plan proves zero binary attachments and attachment-bearing inputs fail closed;
- persisted stable pins and candidate release rows are revalidated before model calls;
- stable/candidate stores, model clients, and session identities are demonstrably isolated;
- fake, copied, or unattested executors fail closed;
- completed, half-completed, crash, exact-resume, changed-resume, and uncertain-call cases are tested;
- both evaluator judgments are closed, blinded, persisted, and disagreement-aware;
- version-2 reporting supports variable model calls and passes readiness joins;
- source head, plan checksum, release pins, adapter manifest, and raw store checksums are stable before and after the run;
- the project test suite remains green.
