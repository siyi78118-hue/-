# Yuqi Quality Production Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `test-driven-development` for every implementation task and `systematic-debugging` for every unexpected failure. Execution is coordinated by the main window using the existing 中控 and 常务 windows; do not create hidden subagents.

**Goal:** Execute all 246 lived-quality finals through real stable/candidate production adapters and two independent blind evaluators with restart-safe, promotion-auditable evidence.

**Architecture:** A closed subject compiler and production bridge create real persisted turn or life-planning authority in isolated v15 stores. A two-level SQLite ledger persists every high-level phase and every nested app-server model call. A version-2 reporter rederives all execution, judgment, and variable-call joins before any readiness claim.

**Tech Stack:** Node.js ESM, `node:test`, `better-sqlite3`, Yuqi v15 store/runtime composition, Codex app-server JSON-RPC, canonical JSON/SHA-256.

## Global Constraints

- Git `49f24612` and plan checksum `dc704d836d1b0224f0202b5771f38334292df90eaedd7c8f8880c7c3bb89243c` are the reviewed inputs until Task25G commits replace the source head. The 246-item plan content and checksum do not change.
- No production DB, live shadow counter, rollout state, cloud relay, Android Room, visible message, or action may be mutated.
- `LIFE_PLANNING` uses `ReleaseExecutor.executeLife()` only; all other supported rollout kinds use `executeTurn()`.
- The eight life finals use a deterministic recent-context fixture through public store/life APIs; they are never coerced into reply bubbles or fake calendar facts.
- The frozen plan contains zero binary attachments. An attachment-bearing plan fails closed before a model call.
- Stable, candidate, evaluator A, and evaluator B use independent stores/clients/sessions.
- No fake/stub executor result or copied attestation is promotion evidence.
- No bulk real-model calls begin before the ordinary and life pilots pass and the measured request multiplier is reported to the user.
- Preserve unrelated worktree dirt; stage only each task's named files.

---

### Task 1: Freeze the subject and blind-output unions

**Files:**
- Modify: `yuqi-runtime/src/quality-evaluator.mjs`
- Test: `yuqi-runtime/test/quality-evaluator.test.mjs`

**Produces:** `compileQualitySubject(item)`, `executionMethodForSubject(subject)`, `normalizeQualityExecutionOutput(subject, raw)`, and a subject-aware blind projection.

- [ ] **Step 1: Write failing subject-dispatch tests**

Cover all nine interaction kinds plus `LIFE_PLANNING`. Assert exact closed keys, canonical `finalKey`, safe repeat index, stable semantic checksum, `executeTurn` for interaction subjects, `executeLife` for life subjects, and rejection of unsupported kinds.

Load the frozen quality plan and assert exactly 246 finals, exactly eight life finals, and zero binary attachments. Add a synthetic attachment-bearing item and require a pre-model rejection.

- [ ] **Step 2: Write failing output-union tests**

Turn output remains:

```js
{ subjectType: 'turn', terminalDisposition, replyParts, actions }
```

Life output is:

```js
{
  subjectType: 'life_planning',
  episodes: [{ ordinal, episodeId, kind, title, startAt, endAt }]
}
```

Require non-empty, ordered, non-overlapping life episodes; native safe timestamps; no reply/action/side/release fields; and exact plan-window containment. Raw execution evidence retains `episodeId`; the blinded projection strips it and exposes only `{ordinal,kind,title,startAt,endAt}`. The blind input includes `subjectType` and accepts only the matching output type. Add deterministic A/B swap tests for both types.

- [ ] **Step 3: Verify red**

```powershell
node --test yuqi-runtime/test/quality-evaluator.test.mjs
```

- [ ] **Step 4: Implement the closed unions and sequential pair execution**

Replace unconditional `executeTurn` and `Promise.all` with exact method selection and sequential calls so later ledger phases can retain one completed side. Keep release identity outside blind input. Add the life rubric mapping for the existing six quality dimensions without changing the plan annotations.

- [ ] **Step 5: Run and commit**

```powershell
node --test yuqi-runtime/test/quality-evaluator.test.mjs
git add yuqi-runtime/src/quality-evaluator.mjs yuqi-runtime/test/quality-evaluator.test.mjs
git commit -m "fix: close Yuqi quality subject and output kinds"
```

---

### Task 2: Share the production turn execution builder

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`

**Produces:** `YuqiOrchestrator.buildCanonicalReleaseExecution(turnId, options)`.

- [ ] **Step 1: Write parity and fail-closed tests**

Create a real temporary store fixture, accept a canonical three-bubble turn, and assert exact closed authority-derived `turn`, `envelope`, `scene`, `currentBatch`, `agencyView`, and `routeDecision`. Cover missing, foreign, redacted, authority-v0, changed agency checksum, attachment receipt mismatch, and unexpected image paths.

- [ ] **Step 2: Verify red**

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
```

- [ ] **Step 3: Extract the existing canonical runtime construction**

The normal runtime must prepare images exactly as it does today, then call the builder and pass that exact object to `ReleaseExecutor.executeTurn()`. The quality bridge later calls the same builder only after proving its plan has no attachments. Do not change commit, delivery, retry, recovery, or redaction behavior.

- [ ] **Step 4: Prove runtime parity**

Use a spy release executor to deep-compare the normal runtime input with the builder result for the same persisted authority. Assert the extraction adds no extra model call and keeps current image preparation ahead of the builder.

- [ ] **Step 5: Run and commit**

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
git commit -m "refactor: share canonical release execution authority"
```

---

### Task 3: Build isolated production quality contexts and attestation

**Files:**
- Create: `yuqi-runtime/src/quality-replay-production-bridge.mjs`
- Create: `yuqi-runtime/test/quality-replay-production-bridge.test.mjs`
- Create: `yuqi-runtime/src/life-planning-authority.mjs`
- Create: `yuqi-runtime/test/life-planning-authority.test.mjs`
- Modify: `yuqi-runtime/src/runtime-composition.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/promotion-controller.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/runtime-composition.test.mjs`
- Test: `yuqi-runtime/test/promotion-controller.test.mjs`
- Test: `yuqi-runtime/test/life-planning-attempt.test.mjs`
- Test: `yuqi-runtime/test/store-release-authority-v14.test.mjs`

**Produces:** `createQualityProductionContext(config)`, `prepareQualitySubject(context, subject)`, `executeQualitySubject(context, subject)`, and `assertProductionRuntimeAttestation(runtime, expected)`.

- [ ] **Step 1: Write real-store bridge red tests**

Materialize one common subject seed through production APIs, close it, then byte-clone it into independent temporary v15 databases and use real `composeYuqiExecutionRuntime()` on each clone. For turn subjects assert `accept in seed -> clone -> persisted stable pin check -> buildCanonicalReleaseExecution -> executeTurn`. For life subjects assert `putLifePlan in seed -> contextFor in each clone -> createLifePlanningAttempt -> buildLifePlanningReleaseExecution -> executeLife` and zero turn execution.

The turn materializer must consume the exact Task 1 compiled semantic input. It must persist every prior user/assistant message through production store APIs, preserve typed batch items and system events in a closed scene projection, derive the current batch from the final user batch before `candidate_response`, and project `context`, `stateCheckpoint`, and `structuredActionTargets` into the same production scene/trigger/state inputs used by the ordinary runtime. It must not replace them with fixture comments, moments, motives, generic text, or any other synthesized semantic substitute. Deterministic protocol identities may derive from `(runId, finalKey, ordinal)` and the compiled semantic input, but semantic facts and targets may not be invented.

Cover all eight frozen life finals. The deterministic context episode must use the exact feature type/text/message ID and a transcript derived from the scene; it ends before `anchorAt`, contains no annotation/evaluator/release data, and is byte-identical—including lifecycle timestamps—across the two clones.

- [ ] **Step 2: Close life-context authority before building the bridge**

Add pure `life-planning-authority.mjs` with a versioned semantic projection and checksum. New controller-created snapshots include `contextAuthorityVersion: 2`; v2 checksums include `cognitiveState`, `allowedActions`, and canonical semantic projections of `current`, `recent`, and `upcoming`, excluding only `createdAt`/`updatedAt`. Store evidence validation dispatches by the persisted version: absent means legacy v1 compatibility, exact native `2` means the new closed rule, and every other value rejects.

Write red tests proving a feature text/payload/reference mutation changes `contextChecksum`, `requestBaseKey`, `inputChecksum`, and the bridge execution-input checksum; stable/candidate clones produce identical values. Add a persisted legacy attempt close/reopen fixture proving the old checksum remains readable, while every newly created production attempt uses v2. Do not alter schema or rewrite historical rows.

- [ ] **Step 3: Write release-pin and isolation red tests**

Derive authority IDs from `(runId, finalKey, ordinal)` with no side. Assert stable/candidate authority input checksums match while stores, lanes, attempts, sessions, and clients differ. After `accept()`, re-read the turn and require the frozen stable release ID/checksum. Before candidate execution require the exact candidate row installed by `putPipelineReleaseInternal()`. Wrong/missing release, changed plan input, wrong method, attachment, or foreign authority must fail before the model client.

`buildCanonicalReleaseExecution()` must return an explicit closed canonical input checksum covering the persisted turn, envelope, complete current batch, scene, agency/state view, route decision, and release pins. The quality bridge must consume that field directly; it may not fall back to hashing an arbitrary execution object, `turn.contentHash`, or an attempt snapshot. The bridge separately binds its deterministic quality authority ID and compiled semantic-input checksum. Before either side executes, raw and self-consistent mutations of every covered persisted component must be rejected before a model call.

- [ ] **Step 4: Write unforgeable-attestation red tests**

`runtime-composition.mjs` owns a module-private `WeakSet` brand. Require:

- exact fixed production adapter ID sets;
- exact stable/candidate rows read from the runtime store;
- candidate manifest equality with `PresetRegistry.pipelineReleaseManifest()`;
- component/model-profile/adapter checksum recomputation;
- source head equality supplied by the runner.

Plain objects, cloned/frozen attestations, subclassed executors, changed releases, and valid-looking fake methods must reject.

- [ ] **Step 5: Verify red**

```powershell
node --test yuqi-runtime/test/life-planning-authority.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/test/runtime-composition.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs
```

- [ ] **Step 6: Implement bridge and attestation**

Install the frozen candidate definition only in temporary stores. Do not register/promote/activate it. The persisted subject remains stable-authoritative and candidate execution is a dry-run comparison with `{visible:false, actions:false}`.

Validate the subject with native types and exact closed kind sets, and bind the exact frozen plan identity/checksum. For LIFE, require `planningWindow.startAt === candidate_response.at` and the frozen twelve-hour end, and derive the closed transcript field deterministically from the scene turns. For turns, prove in tests that every formal input component is observable in the production execution/model request and that no fixed `quality fixture` semantic value is present. Caller-supplied pre-opened clone stores or aliased database paths must not bypass the close-and-byte-clone origin proof.

- [ ] **Step 7: Run and commit**

```powershell
node --test yuqi-runtime/test/life-planning-authority.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/test/runtime-composition.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs
git add yuqi-runtime/src/life-planning-authority.mjs yuqi-runtime/test/life-planning-authority.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/src/promotion-controller.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/src/quality-replay-production-bridge.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/src/runtime-composition.mjs yuqi-runtime/test/runtime-composition.test.mjs
git commit -m "feat: add isolated Yuqi production quality bridge"
```

---

### Task 4: Add the restart-safe phase and model-call ledger

**Files:**
- Create: `yuqi-runtime/src/quality-replay-ledger.mjs`
- Create: `yuqi-runtime/test/quality-replay-ledger.test.mjs`
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Test: `yuqi-runtime/test/codex-client.test.mjs`
- Test fixture: `yuqi-runtime/test/fixtures/fake-app-server.mjs`

**Produces:** `QualityReplayLedger`, `LedgerBackedModelClient`, `CodexAppServerClient.readThread()`, and an awaited `onTurnStarted` hook.

- [ ] **Step 1: Write SQLite state-machine red tests**

Use a real temporary SQLite file and close/reopen between states. Cover immutable run headers, four phase identities, variable subcall ordinals, create/exact reopen/changed reopen, `prepared -> starting -> running -> succeeded|failed|uncertain`, finalization, source/release/attestation drift, ordinal gaps, and two-process immediate-transaction CAS.

The run header binds the complete 246-final set even when the caller selects one pilot final.
The phase input checksum includes the closed subject checksum and the prepared authority/attempt input checksum. Mutating a v2 life feature/context must therefore change the ledger phase input checksum and reject an existing phase key.

- [ ] **Step 2: Write app-server recovery red tests**

Extend the fake app server for `thread/read(includeTurns=true)`. Before `turn/start`, persist thread ID, the exact baseline turn identity set/checksum, request checksum, model/effort/schema, deterministic `callId`, and deterministic `clientUserMessageId`. After `turn/start`, await `onTurnStarted` before installing the completion waiter.

Test:

- succeeded replay performs no app-server request;
- a completed, exactly one-new-turn result is recovered without `turn/start`;
- zero, active, multiple, changed-input, changed-client-ID, or conflicting results become `uncertain`;
- `uncertain` is never auto-reissued;
- process loss before/after `onTurnStarted` is distinguishable;
- a deterministic client ID is treated only as provenance, not billing idempotency.

- [ ] **Step 3: Write nested `runRole` interception tests**

`LedgerBackedModelClient` must intercept both direct `runTurn` and pipeline `runRole` calls. It maps pipeline roles through the same production role mapping, never calls an underlying `runRole` that bypasses the wrapper, and resets ordinal at phase entry. Test memory, brain, supervisor, cognition, expression, repair, and fallback-like sequences with exact replay after restart.

- [ ] **Step 4: Verify red**

```powershell
node --test yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/codex-client.test.mjs
```

- [ ] **Step 5: Implement schema and recovery**

Create closed `quality_runs`, `quality_phases`, `quality_model_calls`, and `quality_finals` tables. Store canonical JSON/SHA-256 for all inputs/outputs. Never infer a missing remote result and never automatically retry `uncertain`.

- [ ] **Step 6: Run and commit**

```powershell
node --test yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/codex-client.test.mjs
git add yuqi-runtime/src/quality-replay-ledger.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/src/codex-client.mjs yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/test/fixtures/fake-app-server.mjs
git commit -m "feat: persist restart-safe Yuqi quality calls"
```

---

### Task 5: Make the runner resumable and preserve two judgments

**Files:**
- Modify: `yuqi-runtime/src/quality-evaluator.mjs`
- Modify: `scripts/run-yuqi-lived-quality-replay.mjs`
- Test: `yuqi-runtime/test/quality-evaluator.test.mjs`
- Test: `yuqi-runtime/test/quality-replay.test.mjs`
- Modify: `yuqi-runtime/src/quality-replay-production-bridge.mjs`
- Test: `yuqi-runtime/test/quality-replay-production-bridge.test.mjs`
- Modify: `yuqi-runtime/src/quality-replay-ledger.mjs`
- Test: `yuqi-runtime/test/quality-replay-ledger.test.mjs`
- Modify: `yuqi-runtime/src/runtime-composition.mjs`
- Test: `yuqi-runtime/test/runtime-composition.test.mjs`

**Produces:** `finalizeBlindJudgments(primary, secondary)`, a run-level branded production execution authority, ledger-driven `runQualityReplayPlan()`, module-branded phase-client slots, and a single-side production execution API.

The four-file JSON-ledger implementation attempted before this amendment is not acceptable evidence. Task 5 uses the Task 4 SQLite ledger as its sole state authority and the Task 3 branded stores/runtimes as its sole execution authority. Do not preserve or add a second JSON phase/final state machine.

#### Run-level production execution authority (mandatory boundary)

Task 5 owns one immutable run authority, not a caller-supplied collection of per-final callbacks. The authority is created only after source/release/artifact preflight and binds one UUID run to the ordered 246 `finalKeys`, the exact plan checksum, clean source head, complete stable/candidate release snapshots and manifest checksums, runtime/evaluator attestations, private artifact paths, the canonical ledger path, and the expected immutable header identity. The database does not exist yet at this point; immediately after the bridge creates its meta/header rows, it reopens and confirms the actual SQLite identity against the authority. Its public descriptor contains data-only identity fields; its operational state is held in module-private `WeakMap` storage and its object is marked by a module-private `WeakSet`. A copied, frozen, subclassed, proxied, or structurally identical object is invalid.

The production consumer accepts only:

```js
runQualityReplayPlan({
  plan,
  ledgerPath,
  runAuthority,
  selector: { onlyFinalKey: null | finalKey },
  resumeRun: null | runId
})
```

It must reject `callback`, `subjectFactory`, `phaseExecutor`, `evaluator`, `evaluatorSecondary`, `createStore`, `runtimeFactory`, `runtime`, `client`, `executor`, `slot`, and any unknown option before opening the ledger or creating a runtime/client. The runner receives only `runAuthority`, `item`, and the current phase identity; it never receives a generic callback or a mutable runtime field.

Task 7 may pass only local data materials—fixed paths, the reviewed plan/history paths, candidate preset/release input, runtime configuration path, and four closed underlying-client configuration records. The run authority stores only those immutable client authority/config records and their attested checksums, never a `CodexAppServerClient`, `LedgerBackedModelClient`, phase client, or slot instance. The bridge must internally open v15 `YuqiStore` instances, byte-clone the seed, call `composeYuqiExecutionRuntime()`, create the real `ReleaseExecutor`, instantiate the four distinct `CodexAppServerClient` lanes, and, after a phase is persisted as `running`, wrap the matching underlying client in Task 4's `LedgerBackedModelClient` and call `forPhase()`. Task 7 must not construct stores, runtimes, clients, executors, or slots and pass them into production.

For each final, the bridge creates exactly two fresh **unbound runtime slots** before composing the independent stable/candidate runtimes. Those slots have the exact `(runId,finalKey,stable_execution|candidate_execution,side)` identity and the same SQLite ledger identity, and they are passed immutably into the matching runtime at composition. Only after the matching phase row is atomically `running` does the bridge create that phase's `LedgerBackedModelClient` binding and bind the already-composed slot exactly once. The evaluator phases do not use runtime slots: after each evaluator phase becomes `running`, the bridge creates a distinct ledger-backed phase client from its fixed primary/secondary underlying-client authority and calls that phase client directly. The result is two runtime slots but four distinct phase clients/bindings, all on the same ledger/run/final and with distinct phase, session, thread, and client identities. Slot/binding identity, ledger ownership, and phase input checksum are retained only in private `WeakMap`s. There is no setter, swap, try/finally mutation, or public current-client field.

The bridge alone constructs the blind evaluator input from the persisted stable/candidate phase outputs. The exact serialized blind input is sent through the corresponding evaluator phase client/binding; the model-call request checksum, judgment input checksum, final blind-input checksum, and persisted phase-output checksums must be equal by derivation. Turn uses `turn_output`; LIFE uses only the closed `life_plan` projection and rubric. A caller cannot supply evaluator input or evaluator callback.

`only-final-key` is an execution selector only. It never changes the header's 246-key set or plan identity, and a partial run cannot be finalized or exported as production evidence. `runAuthority` creation, ledger header creation, runtime/client creation, and export all fail closed on any identity drift.

The test fixture path is separate. Every Task 5 SQLite database has an immutable one-row `quality_ledger_meta` authority with exact `{schemaVersion,evidenceClass}`; `evidenceClass` is exactly `production|fixture`, is fixed before any run row is inserted, and is validated on every open. Only the branded run-authority path may create `production`; the callback fixture API can create only `fixture` and is additionally branded `evidenceEligible:false`. A fixture database cannot create a production header/attestation, cannot be opened by the production exporter/readiness validator, and cannot share a production ledger path. Changing, deleting, duplicating, or self-consistently recreating the meta row fails reopen. The production exporter accepts no caller `evidenceClass`: it first opens SQLite read-only, reads the unique meta row, and requires `production` before reading any run, phase, call, or final row. JSONL is an atomic export of validated SQLite rows only; it is never a state source, append log, resume source, or substitute ledger.

Task 5's ten files are sufficient for the consumer, brand, and bridge boundary. Task 7 may add only `scripts/yuqi-quality-production-execution-config.mjs`, its test, and the private-artifact ignore rule; it may construct the run authority from data materials but may not add a production callback or injection seam. No extra Task 5 production file is authorized.

- [ ] **Step 1: Write judgment-closure red tests**

Reject release-side preference labels and native-type coercions. Persist both complete normalized judgments with evaluator identity/version and input/output checksums. Mark manual review for any score, preference, unresolved, or normalized-finding difference. Add turn/life A/B permutation tests proving release identity, phase order, side, model, session, prompt, and attestation are absent. LIFE uses the closed `life_plan` output/rubric and never the turn comparison path.

- [ ] **Step 2: Write CLI/run-identity red tests**

Implement and test:

- `--ledger <path>`;
- first-run generated UUID `runId` printed and persisted;
- `--resume-run <runId>` required for continuation;
- `--only-final-key <finalKey>` selects exactly one member of the full bound plan;
- missing, duplicate, unknown, or valueless options reject; production `--max-items` is forbidden;
- production rejects every callback/object injection and accepts only the branded run authority;
- missing, duplicate, changed-plan, changed-source, changed-release, changed-attestation, changed-artifact, and finalized/blocked run resumes reject as applicable;
- removing the selector resumes all remaining finals in the same run.

The red tests must attempt a plain descriptor, a spread/frozen clone, a proxy/subclass, a callback-bearing module, and a test-only fixture marker as `runAuthority`; each must fail before ledger creation, runtime construction, or model-client construction. A valid authority with a changed plan, stale source head, changed release/manifest, changed attestation, duplicate slot identity, or escaped private artifact path must fail at the same preflight boundary.

The immutable SQLite header has exact native keys `{version,runId,finalKeys,planChecksum,sourceHead,stableRelease,candidateRelease,attestation,attestationChecksum,artifactPaths,createdAt}`. `version` is the exact supported integer, `runId` is a UUID string, `finalKeys` is the ordered 246-key unique array, checksums are lowercase SHA-256 strings, and `createdAt` is a non-negative safe integer.

Each release snapshot has exact keys `{releaseId,pipelineVersion,presetVersion,cognitionSchemaVersion,expressionSchemaVersion,evaluatorVersion,modelProfile,componentManifest,releaseChecksum,createdAt,retiredAt}` with the same native types as the persisted release row. The ledger re-reads the exact row, validates its registry/manifest checksum, and requires canonical byte equality with the header.

`attestation` has exact keys `{version,sourceHead,stableRuntime,candidateRuntime,evaluatorPrimary,evaluatorSecondary}`. Each runtime entry is the exact closed value returned by `assertProductionRuntimeAttestation()`. Each evaluator entry has exact keys `{evaluatorId,evaluatorVersion,modelProfileChecksum,clientConfigChecksum,sessionNamespaceChecksum}`; evaluator identities and namespace checksums must differ. `attestationChecksum === contentHash(attestation)` is recomputed on every open. `artifactPaths` has exact keys `{plan,ledger,raw}`; values are distinct project-root-relative forward-slash paths with no drive, leading slash, backslash, empty segment, `.` or `..`, and their resolved locations must stay under the fixed ignored private artifact root. The database header checksum is canonical `contentHash(header)` and every nested checksum is rederived, never trusted from a caller.

A pilot selector never changes that header. Before any ledger write or runtime/client creation, preflight must re-read the clean source head, exact release rows and manifests, attestation inputs, and realpath-checked private artifact paths. Header drift rejects before temporary runtime or model-client creation. The header may not synthesize release rows, manifests, runtime entries, or evaluator checksums from caller data.

- [ ] **Step 3: Write phase-resume red tests**

Interrupt in `prepared`, `starting`, and `running`, immediately before and after the awaited `onTurnStarted`, and immediately before and after call/phase completion. Restart with the same SQLite ledger and prove completed phases/subcalls do not increase app-server counters. A persisted `starting`/`running` call accepts only the one exact completed new remote turn; zero, active, multiple, changed-input, changed-client-ID, or conflicting candidates become `uncertain`. `uncertain` is never auto-reissued and atomically blocks the final and whole run.

The recovery matrix must include: `prepared` with zero calls resumes; `starting` with zero calls is atomically returned to `prepared`; `starting` with a claimed call is resolved through Task 4 recovery; an orphaned `running` phase is never blindly re-entered; deterministic bridge validation is `failed`; remote ambiguity is `uncertain`; and a finalized/blocked run is never reopened for writes. Every case closes and reopens SQLite, checks raw row checksums, and asserts no new app-server request in the succeeded/no-call path.

Add an additive Task 3 interface:

```js
executeQualitySubjectSide(context, subject, {
  side: 'stable' | 'candidate',
  phaseClientSlot
})
```

`prepareQualitySubject()` still creates the common seed and independent byte clones, but stable and candidate execution are separate phase calls. The runner must never call combined `executeQualitySubject()` as production evidence. Each runtime is composed internally by the bridge with its own module-branded, unbound phase-client slot; no caller-supplied `createStore` or `runtimeFactory` is accepted on the production path. After the matching ledger phase reaches `running`, the slot binds exactly once to `LedgerBackedModelClient.forPhase()`. Before binding, after conflicting rebinding, or when shared across side/final/phase it rejects. The runtime's store, release, authority snapshot, source head, adapter registry, release executor, client identity, and attestation are revalidated immediately before and after the selected side executes. No public runtime/client field is mutated.

The exact construction order is: complete source/release/artifact, four underlying-client-configuration, and runtime-configuration preflight without creating a ledger/runtime/client; internally create only the model-free temporary seed/runtime material needed to derive and verify the two real runtime attestations, without creating a ledger row, calling a model, or writing a production database, and close every temporary clone on success or failure; then create the run-level authority containing the canonical ledger path/header identity and data-only client authorities; open/create the `production` SQLite meta row and immutable run header and immediately confirm them against the authority; for each selected final create the two unbound ledger-owned stable/candidate slots; prepare the subject and independent byte clones and compose both runtimes with those slots; atomically move only the current phase to `running`; bridge-internally instantiate/wrap the matching client, create its exact phase binding and, for execution phases, bind the pre-existing slot to `(runId,finalKey,phase,inputChecksum)`; execute once; close/reopen and revalidate. Evaluator phases create no runtime slot and use their direct primary/secondary phase clients only after `running`. `runtime-composition.mjs` exposes a narrow identity assertion for the bridge, not the slot or mutable setter. Bind-before-running, run-before-bind, duplicate/conflicting bind, and cross-side/final/phase reuse reject.

The production CLI cannot accept caller `stableRuntime`, `candidateRuntime`, `runtimeFactory`, `runtimeInput`, store, executor, client, or slot objects. The later Task 7 module-branded factory supplies only data-material paths/configuration and returns the run-level authority; the bridge creates all runtime/client/slot objects internally. Tests use a separate explicitly test-only factory that is always `evidenceEligible:false`, writes only the fixture SQLite marker, and cannot satisfy a production run header/attestation.

Task 4's ledger client gains a module-private branded phase slot and preserves the exact production `deadlineMs`/`outerDeadlineMs` to `turnTimeoutMs` calculation in `runRole()`. `forPhase()` is executable only for a persisted `running` phase; nested calls keep deterministic ordinals starting at zero per phase and never call an underlying `runRole()` bypass.

- [ ] **Step 4: Verify red**

```powershell
node --test yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs
```

- [ ] **Step 5: Implement sequential persisted phases**

```text
stable_execution -> candidate_execution -> evaluator_primary -> evaluator_secondary -> final
```

Each phase uses its own `LedgerBackedModelClient`. The production runner never accepts a generic phase client factory. Export artifacts only from a read-only SQLite row projection after the run is finalized; never append partial duplicate records or export a selected/blocked/open run.

For every selected final:

1. compile and prepare the exact frozen subject;
2. derive phase identity from the closed subject checksum and prepared authority input checksum;
3. `preparePhase()` and reuse an exact `succeeded` output locally, otherwise atomically advance `prepared -> starting -> running`;
4. bind the matching phase slot/client and execute only that phase;
5. persist the complete phase output before any later phase starts;
6. stop after failure and block after uncertainty;
7. after both evaluator phases, call `finalizeBlindJudgments()` and persist one closed final object containing the two complete judgment records, their checksums, differences, manual-review/unresolved state, and stable/candidate/blind-input authority checksums.
8. after all selected work is complete, call `finalizeRun()` only when all 246 final rows, all 984 phase rows, all evaluator judgment rows, and every model-call ownership/ordinal/checksum join are complete. A selector run remains open and is never exported as production evidence.

`quality_finals.value_json` has exact keys `{version,finalKey,subjectType,subjectChecksum,stablePhase,candidatePhase,blindInputChecksum,primary,secondary,comparison}`. `subjectType` is exactly `turn|life_planning`; each execution phase has exact `{inputChecksum,outputChecksum}`. Each judgment record has exact `{evaluatorId,evaluatorVersion,inputChecksum,output,outputChecksum}`. `output` is the exact normalized blind object `{version,scores,preference,findings,unresolved}`: scores have every fixed dimension exactly once with native integers 1..5; preference is exactly `A|B|tie|unresolved`; unresolved is a native boolean; each finding is exact `{code,severity,owner,summary,critical}` with the existing native closed enums/types. Judgment metadata and evaluator input/output may not contain release, side, phase, model, session, prompt, client, thread, or attestation fields.

`comparison` has exact keys `{version,differences,manualReview,unresolved,agreedCriticalFindings}`. Differences are unique, canonical-order members of `scores|preference|unresolved|findings`; `manualReview` equals whether a difference exists or either judgment is unresolved; `unresolved` is the boolean OR of the judgments; agreed critical findings are the canonical intersection of identical normalized critical findings. Every `inputChecksum`, `outputChecksum`, phase checksum, blind-input checksum, difference, and intersection is rederived from persisted phase outputs. Missing/unknown keys, native-type coercion, missing secondary judgment, release-side labels, and raw or self-consistent checksum mutation reject in `finalize()` and on reopen. An evaluator `unresolved` result is preserved as a finalized manual-review record; only ledger/model-call `uncertain` blocks finalization and the run. A finalized final is read only from SQLite and never reconstructed from caller JSON.

Phase/client mapping is fixed: `stable_execution` uses only the stable runtime/slot; `candidate_execution` uses only the candidate runtime/slot; `evaluator_primary` and `evaluator_secondary` use two other independent ledger-backed evaluator clients, session namespaces, and threads and never a release runtime. Turn evaluator input uses only the closed `turn_output` union. LIFE evaluator input uses only `life_plan`, the planning window, LIFE rubric, and closed transcript summary; it excludes episode IDs, release/side/phase/model/session/prompt/attestation and never enters turn comparison/action logic.

A `failed` phase is terminal for that run and is never implicitly reissued by `--resume-run`; later phases for that final do not start. Continuing it requires an explicitly new `runId` after the underlying cause is fixed. An `uncertain` call/phase additionally changes the current run to blocked. Exact succeeded phases replay locally.

Restart recovery is explicit: `prepared` remains call-free; `starting` is rolled back to a retryable prepared boundary only when no remote call was claimed; `running` is resolved through Task 4 thread/read and exact baseline/clientUserMessageId/request matching. Exactly one completed remote turn may be recovered; zero, active, multiple, changed, or conflicting results become `uncertain`, block the run, and are never reissued. A deterministic validation failure becomes `failed`, not `uncertain`; no later phase starts. Every recovery transition is an immediate SQLite transaction and is revalidated on reopen.

### Task 5 stop gate and migration rule

The existing dirty Task 5B implementation is migrated as follows: preserve the Task 4 SQLite schema/CAS, branded `LedgerBackedModelClient`/phase-slot primitives, Task 3 production bridge, LIFE/turn method dispatch, and exact final-value validator; delete or make test-only the public generic callback runner, compatibility header/release synthesis, callback-backed `createQualityProductionContextFactory(callback/createStore)` pseudo-brand, caller `createStore`/`runtimeFactory` path, and any JSON append/resume state. Preserve fixture tests only after they use the separate fixture SQLite marker and prove `evidenceEligible:false`; no fixture row may be accepted by production export/readiness.

Before Task 5 is considered complete, TDD must show: forged run authority rejected; every injection key rejected before ledger/runtime/client creation; stale source/release/attestation/path rejected; exactly two distinct pre-composition runtime slots plus four distinct running-phase clients/bindings per final and no public mutation; evaluator phases create no runtime slot; real bridge-owned blind input/request checksum closure; prepared/starting/running crash recovery; failed versus uncertain semantics; selector header preservation; fixture/production meta-row corruption and cross-open rejection; partial/open/blocked export rejection; finalized 246/984/variable-call joins; and read-only deterministic export. The stop gate is the focused Task 5 suite plus `node --check` for all ten files and `git diff --check`; no real model call, production DB mutation, or Task 7 CLI run is permitted at this step.

- [ ] **Step 6: Run and commit**

```powershell
node --test yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/test/runtime-composition.test.mjs
node --check yuqi-runtime/src/quality-evaluator.mjs
node --check scripts/run-yuqi-lived-quality-replay.mjs
git diff --check
git add yuqi-runtime/src/quality-evaluator.mjs scripts/run-yuqi-lived-quality-replay.mjs yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/src/quality-replay-production-bridge.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/src/quality-replay-ledger.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/src/runtime-composition.mjs yuqi-runtime/test/runtime-composition.test.mjs
git commit -m "feat: resume complete Yuqi blind quality evidence"
```

---

### Task 6: Upgrade reporting and readiness to variable-call evidence

**Files:**
- Modify: `scripts/report-yuqi-lived-quality.mjs`
- Modify: `scripts/run-yuqi-lived-quality-replay.mjs`
- Modify: `scripts/verify-yuqi-v3-readiness.mjs`
- Modify: `yuqi-runtime/src/quality-replay.mjs`
- Test: `yuqi-runtime/test/quality-report.test.mjs`
- Test: `yuqi-runtime/test/quality-replay.test.mjs`
- Test: `yuqi-runtime/test/promotion-controller.test.mjs`
- Test: `tests/cognition-rollout-quality-boundary.test.mjs`
- Test: `tests/yuqi-v3-readiness.test.mjs`
- Test: `tests/yuqi-lived-quality-contract.test.mjs`

**Produces:** version-2 raw replay schema, reporter joins, manual-review input, and readiness validation.

- [ ] **Step 1: Write v2 schema red tests**

The production JSONL artifact is an exact, closed version-2 projection of one finalized production SQLite run. Every row has native `schemaVersion:2`, a closed `recordType`, and the same canonical UUID `runId`. Row order is deterministic: one `run`; 246 `execution` rows in verified plan final-key order; 984 `phase` rows in final-key then fixed phase order; every `model_call` row in final-key, phase, ordinal order; 492 `judgment` rows in final-key and primary/secondary order; 246 `final` rows in final-key order; and one trailing `provenance` row. No caller summary, caller count, or caller-supplied checksum enters the artifact.

Record shapes are exact:

- `run`: `{schemaVersion,recordType,runId,header,headerChecksum,state,createdAt,finalizedAt}`. `state` is exactly `finalized`; the complete header and checksum must equal the reopened production run.
- `execution`: `{schemaVersion,recordType,runId,finalKey,subjectType,subjectChecksum,stablePhase,candidatePhase,executionChecksum}`. Each side phase is exact `{inputChecksum,outputChecksum}` and `executionChecksum=contentHash({finalKey,subjectType,subjectChecksum,stablePhase,candidatePhase})`.
- `phase`: `{schemaVersion,recordType,runId,finalKey,phase,state,subjectChecksum,authorityInputChecksum,input,inputChecksum,output,outputChecksum,createdAt,startingAt,runningAt,updatedAt}`. `phase` is one of the four fixed phases, `state` is exactly `succeeded`, and every JSON/checksum pair is recomputed from the SQLite row.
- `model_call`: `{schemaVersion,recordType,runId,finalKey,phase,ordinal,state,role,callId,clientUserMessageId,threadId,turnId,baseline,baselineChecksum,request,requestChecksum,model,effort,schemaChecksum,output,outputChecksum,runningAt,createdAt,updatedAt}`. Ordinals start at zero and are contiguous per `(finalKey,phase)`; every phase owns at least one succeeded call; the exact baseline, request, output, identities, model profile, and checksums come from SQLite.
- `judgment`: `{schemaVersion,recordType,runId,finalKey,phase,evaluatorId,evaluatorVersion,inputChecksum,output,outputChecksum,judgmentChecksum}`. `phase` is exactly `evaluator_primary|evaluator_secondary`; the other fields equal the matching finalized judgment; `judgmentChecksum=contentHash({finalKey,phase,evaluatorId,evaluatorVersion,inputChecksum,output,outputChecksum})`.
- `final`: `{schemaVersion,recordType,runId,finalKey,value,valueChecksum,executionChecksum,finalizedAt}`. `value` is the complete Task 5 final value, `valueChecksum` is recomputed, and `executionChecksum` equals the matching execution record.
- `provenance`: `{schemaVersion,recordType,runId,recordCounts,recordsChecksum,provenanceChecksum}`. Counts are exact closed `{run,execution,phase,modelCall,judgment,final}`; `recordsChecksum=contentHash(all preceding ordered rows)` and `provenanceChecksum=contentHash({runId,headerChecksum,recordCounts,recordsChecksum})`.

`recordsChecksum` means exactly `contentHash(orderedRowsArray)`, where `orderedRowsArray` is the complete array of row objects before the trailing provenance row; it is not a hash of bytes, concatenated lines, or per-row hashes. JSONL bytes are exactly one `canonicalJson(row)` plus `\n` for every member of `orderedRowsArray`, followed by the same encoding for the provenance row. Export, report, and readiness rederive the same array/checksums independently.

All keys are present exactly once. `schemaVersion` and every ordinal/count/timestamp are native safe integers; `schemaVersion===2`; every checksum is a native lowercase 64-hex string. IDs, final keys, phases, roles, call IDs, client message IDs, thread/turn IDs, model, effort, and schema checksum are native non-empty strings and satisfy their Task 5 identity/domain rules. Production succeeded phase/model-call rows have native `state:'succeeded'`, non-null safe-integer running/completion times, and monotonic `createdAt<=startingAt<=runningAt<=updatedAt` where the persisted fields apply. Phase `input/output`, model-call `baseline/request`, and final `value` are the exact canonical JSON values accepted by the Task 5 invariant; nullable database fields are nullable only in states that are ineligible for production export, so no exported succeeded row contains a missing/null authority input, request, output, identity, or checksum. Booleans, arrays, numbers, strings, empty values, and coercible lookalikes are rejected wherever the closed Task 5 field expects a different native type.

Require exactly 246 execution records, 984 phase records, 492 evaluator judgment records, 246 final records with checksums, and a variable non-zero model-call set that owns every phase. The only production export API is `exportQualityReplayV2({sourceRootDir,ledgerPath,runAuthority,runId,artifactPath})`: it first calls `assertQualityRunAuthority(runAuthority)`, requires the branded authority's production configuration to name the same canonical ledger path/run/header, and opens that ledger only with `openProductionQualityReplayLedger({filename:ledgerPath,runAuthority,readOnly:true,sourceRootDir})`. Path-only descriptors, fixture ledgers, caller evidence classes, caller stores/rows, and reporter/readiness access to SQLite are forbidden. The Task 5 runner is the sole production caller; reporter/readiness consume only the exported JSONL.

The exporter reads deterministically, validates every row and join, writes a same-directory private temporary file, fsyncs and closes it, atomically replaces the target, fsyncs the parent directory where supported, and removes a failed temporary file without altering a prior valid target. It snapshots/rechecks the production source/header/release/attestation and proves the SQLite logical state/checksum unchanged before/after export. The Task 5 runner must call this v2 exporter; its interim `attempt|model|final-checksum` production projection is removed rather than left as a second production format.

The two judgment rows are projections, not new authorities: `evaluator_primary` is exactly `quality_finals.value.primary`, `evaluator_secondary` is exactly `.secondary`, and each evaluator ID/version/input/output/checksum must equal both the finalized value and corresponding succeeded phase. Their judgment checksums are recomputed only from the documented basis. The execution checksum is recomputed only from its matching execution record; each final's `valueChecksum` equals the reopened `quality_finals.value_checksum`, and its execution checksum equals the matching execution row. Any raw SQLite/JSONL mutation—including a self-consistent mutation with locally recomputed child checksums—must be rejected by reopen, export, report, and readiness against the persisted parent/header/plan/release/attestation commitments.

Reject unknown/extra/missing keys, non-native types, record reordering, missing/duplicate phases, phase-owner mismatch, ordinal gaps, model calls without phases, phase completion without owned calls, uncertain/running/failed calls, changed input/output checksums, evaluator judgment mismatch, execution/final mismatch, provenance/count mutation, and source/release/attestation drift. Reopening, exporting twice, and reporting twice must produce byte-identical JSONL and checksums.

The existing execution helper's `allowAuthorityFallback` is forbidden for production and is removed from the production runner: every phase input checksum comes from the explicit branded bridge/ledger authority and never from a caller object or semantic-input fallback. The old `appendQualityReplayArtifact` path is fixture-only, writes an explicit legacy structural marker, and can return only `evidenceClass:'legacy_structural',evidenceEligible:false`; a branded production result is rejected rather than serialized through it.

- [ ] **Step 2: Preserve protocol-only legacy readability**

If old structural replay artifacts remain supported, keep that parser isolated and explicitly return `evidenceClass:'legacy_structural'`, `evidenceEligible:false`, and a stable ineligibility reason. It may be viewed for protocol regression only; it cannot produce manual-review input, candidate release approval, promotion evidence, or readiness success. `validateQualityArtifactBundle` may remain as a compatibility facade, but its production-eligible branch accepts only the exact v2 projection above.

The production manual-review artifact is also a closed version-2 JSONL, never a caller summary and never the old `metadata|review` shape. It is ordered as one `manual_metadata` row, required `review` rows in verified final-key order, then one `manual_provenance` row:

- `manual_metadata`: `{schemaVersion,recordType,runId,sourceHead,candidateReleaseId,candidateReleaseChecksum,planChecksum,replayProvenanceChecksum,requirementsChecksum}`. Each ordered requirement is exact `{finalKey,primaryJudgmentChecksum,secondaryJudgmentChecksum,executionChecksum,finalValueChecksum,evidenceFindingIds}` and `requirementsChecksum=contentHash(orderedRequirements)`; requirements are rederived from v2 finals/judgments/comparisons and the existing deterministic passing-sample rule.
- `review`: `{schemaVersion,recordType,runId,reviewId,finalKey,primaryJudgmentChecksum,secondaryJudgmentChecksum,executionChecksum,finalValueChecksum,evidenceFindingIds,decision,resolvedOutput,reason,reviewer,createdAt}`. `reviewId='qreview_'+contentHash({runId,finalKey,primaryJudgmentChecksum,secondaryJudgmentChecksum,executionChecksum,finalValueChecksum}).slice(0,48)`; all four checksums must equal the v2 replay rows; finding IDs are the exact ordered requirement set; `reviewer` is exactly `central_window`; and `decision` is exactly `accept_primary|accept_secondary|merge|reject_both|unresolved`.
- `manual_provenance`: `{schemaVersion,recordType,runId,recordCounts,recordsChecksum,manualProvenanceChecksum}`. `recordCounts` is exact `{manualMetadata:1,review:N}`; `recordsChecksum=contentHash([manualMetadata,...orderedReviews])`; and `manualProvenanceChecksum=contentHash({runId,requirementsChecksum,recordCounts,recordsChecksum})`.

For `accept_primary|accept_secondary`, `resolvedOutput` must exactly equal the selected complete normalized judgment output. For `merge`, it must itself pass the complete closed blind-output validator. For `reject_both|unresolved`, it is exactly `null` and the quality report remains ineligible. Missing, duplicate, unexpected, changed-basis, legacy, or self-consistently forged reviews reject. A final whose two outputs differ/unresolve, contains a critical finding or score 1, exercises a structured-action critical rule, or is selected by the deterministic passing sample requires exactly one review. When no review is required, the two judgments must be identical and the primary output is the effective output. When review is required, only a bound resolved output becomes the effective output; the reporter never silently chooses one evaluator. If the manual artifact is absent, the reporter may emit the exact ordered requirements and an ineligible report, but readiness can never pass.

- [ ] **Step 3: Verify red**

```powershell
node --test yuqi-runtime/test/quality-report.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/promotion-controller.test.mjs tests/cognition-rollout-quality-boundary.test.mjs tests/yuqi-v3-readiness.test.mjs tests/yuqi-lived-quality-contract.test.mjs
```

- [ ] **Step 4: Implement ledger export and rederived joins**

`quality-replay.mjs` owns the closed v2 row validator, canonical ordering, and checksum derivation and must not import runner, reporter, readiness, or ledger modules. The dependency direction is `runner -> ledger + quality-replay` and `reporter/readiness -> quality-replay`; no new ESM cycle is allowed. `run-yuqi-lived-quality-replay.mjs` owns only the branded read-only ledger export and atomic file replacement. The reporter consumes the v2 rows, rederives all joins and counts, and computes its report/provenance from those rows rather than trusting a caller summary. Manual-review records bind both complete evaluator judgments, the matching final value/value checksum, and the final execution checksum. The report derives exactly 246 decisions and exposes unresolved/difference/manual-review totals from finalized comparisons; it never turns a missing or invalid record into a default score.

`verify-yuqi-v3-readiness.mjs` must call the same v2 validator and require the v2 provenance, exact source head, release/attestation header, 246/984/492/246 joins, every required bound manual review, and zero missing or unresolved review requirements before readiness can pass; resolved review rows are expected and are not themselves blockers. A legacy structural artifact, a v2 artifact with caller-supplied counts, or any alternate parser path is permanently ineligible. Existing callers such as rollout/formal verification may use the compatibility facade, but cannot bypass the v2 eligible branch. Their existing fixtures in `promotion-controller.test.mjs` and `cognition-rollout-quality-boundary.test.mjs` must be migrated to genuine v2 rows or explicitly asserted legacy/ineligible; no old fixture remains an eligible release proof.

- [ ] **Step 5: Run and commit**

```powershell
node --test yuqi-runtime/test/quality-report.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/promotion-controller.test.mjs tests/cognition-rollout-quality-boundary.test.mjs tests/yuqi-v3-readiness.test.mjs tests/yuqi-lived-quality-contract.test.mjs
node --check scripts/report-yuqi-lived-quality.mjs
node --check scripts/run-yuqi-lived-quality-replay.mjs
node --check scripts/verify-yuqi-v3-readiness.mjs
node --check yuqi-runtime/src/quality-replay.mjs
git diff --check
git add scripts/report-yuqi-lived-quality.mjs scripts/run-yuqi-lived-quality-replay.mjs scripts/verify-yuqi-v3-readiness.mjs yuqi-runtime/src/quality-replay.mjs yuqi-runtime/test/quality-report.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/promotion-controller.test.mjs tests/cognition-rollout-quality-boundary.test.mjs tests/yuqi-v3-readiness.test.mjs tests/yuqi-lived-quality-contract.test.mjs
git commit -m "fix: verify variable Yuqi quality model evidence"
```

---

### Task 7: Build the real four-client execution configuration

**Files:**
- Create: `scripts/yuqi-quality-production-execution-config.mjs`
- Create: `yuqi-runtime/test/quality-production-config.test.mjs`
- Modify: `.gitignore`

**Produces:** `createQualityReplayRunAuthority({rootDir, ledgerPath, plan, resumeRun, artifactPaths})` using data-only configuration; it never returns or accepts a runtime/client/store/slot object.

- [ ] **Step 1: Write configuration and clean-source red tests**

Require four distinct closed underlying-client configuration records with independent session-store paths/namespaces, exact release profiles, unforgeable runtime attestation inputs, closed evaluator schemas, read-only sandbox, approval `never`, and ignored private output paths. The bridge, not the Task 7 config module, must instantiate the four `CodexAppServerClient` objects and wrap the matching object only after its persisted phase becomes `running`; tests reject any config module that returns or injects a client object.

In a clean detached fixture checkout require empty working-tree diff, empty staged diff, and zero non-ignored untracked files. Bind exact Git head plus input plan SHA/checksum. Ignored artifacts are never source; their paths and checksums live in the run header. Dirty tracked or non-ignored source fails before client startup.

- [ ] **Step 2: Verify red**

```powershell
node --test yuqi-runtime/test/quality-production-config.test.mjs
```

- [ ] **Step 3: Implement four independent ledger-backed lanes**

Stable/candidate client configurations use release model profiles. Evaluator configurations use independent profiles and the closed blind schema. The bridge derives a distinct session scope per final key while preserving persisted thread identities for recovery, instantiates all client objects internally, and revalidates attestation and release rows before every phase.

- [ ] **Step 4: Run all non-model gates**

```powershell
node --test yuqi-runtime/test/quality-production-config.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/quality-report.test.mjs
npm.cmd test
```

Expected: all tests PASS, zero external model calls, zero production mutations.

- [ ] **Step 5: Commit**

```powershell
git add scripts/yuqi-quality-production-execution-config.mjs yuqi-runtime/test/quality-production-config.test.mjs .gitignore
git commit -m "feat: configure isolated Yuqi quality model lanes"
```

---

### Task 8: Run two bounded real pilots in one durable run

**Files:** evidence only under `artifacts/yuqi-lived-agency-v3/private/`.

- [ ] **Step 1: Freeze final implementation source**

Create/update the clean detached candidate to the reviewed Task25G head. Require clean tracked/non-ignored state. Record source head, full plan checksum/SHA, release rows, adapter attestation, and temp-store seed checksums in the run header.

- [ ] **Step 2: Create the run with one ordinary final**

```powershell
node scripts/run-yuqi-lived-quality-replay.mjs --execute --ledger artifacts/yuqi-lived-agency-v3/private/quality-replay-state.sqlite --only-final-key sentinel:fourth_coquetry_test_or_pressure:0 --execution-config scripts/yuqi-quality-production-execution-config.mjs --plan artifacts/yuqi-lived-agency-v3/private/quality-replay-plan.json
```

Capture the printed `runId`. Verify four succeeded phases, variable succeeded model-call rows, distinct lane/session identities, two complete judgments, exact no-call resume, and zero production mutation.

- [ ] **Step 3: Resume the same run with one life final**

```powershell
node scripts/run-yuqi-lived-quality-replay.mjs --execute --ledger artifacts/yuqi-lived-agency-v3/private/quality-replay-state.sqlite --resume-run RUN_ID --only-final-key coverage:fourth_coquetry_test_or_pressure__feature:0 --execution-config scripts/yuqi-quality-production-execution-config.mjs --plan artifacts/yuqi-lived-agency-v3/private/quality-replay-plan.json
```

Verify `subjectType=life_planning`, the deterministic recent-context episode, `executeLife`, no turn execution, closed life output, and exact resume.

- [ ] **Step 4: Cost and independent review gate**

Report the observed model-call count per phase/final, latency, failures/repairs, and projected remaining calls. Obtain explicit user approval for the measured bulk cost. The 常务 window independently verifies blindness, release pins, production attestation, ledger recovery, life input, and zero side effects.

---

### Task 9: Resume the remaining 244 finals and produce Task25 evidence

**Files:** evidence/report artifacts only.

- [ ] **Step 1: Resume without a selector**

Use the exact same ledger, `runId`, plan, source head, release manifests, and attestation. Completed pilot finals exact-replay with zero new calls.

- [ ] **Step 2: Monitor durable progress**

Report succeeded/failed/starting/running/uncertain phases and model calls. Never auto-retry `uncertain`. Stop on source/release/adapter drift, evaluator schema failure, or side-effect detection.

- [ ] **Step 3: Export v2 evidence and manual review**

Require 246 finalized rows, 984 succeeded phases, 492 complete judgments, variable model-call rows all succeeded with closed ordinals, and zero uncertain calls. Export checksummed JSONL solely from the ledger.

- [ ] **Step 4: Run report/readiness gates**

```powershell
node scripts/report-yuqi-lived-quality.mjs --root .
npm.cmd test
```

The report remains ineligible until required manual review and all pre-existing external Task25 gates—including connected Android evidence and live-shadow requirements—are independently satisfied.

## Self-Review

- Spec coverage: every design requirement maps to Tasks 1-9.
- Life coverage: all eight life finals have a valid production input and output contract.
- Cost honesty: 984 is called a phase count, never a model-request estimate.
- Recovery honesty: deterministic IDs do not claim provider billing idempotency.
- Type consistency: subject, output, bridge, attestation, phase, model call, judgment, and reporter identities align.
- Execution choice: the main window coordinates the existing 中控 and 常务 windows; no hidden subagents.
