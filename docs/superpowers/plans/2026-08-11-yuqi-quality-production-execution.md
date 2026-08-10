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

**Produces:** `finalizeBlindJudgments(primary, secondary)`, ledger-driven `runQualityReplayPlan()`, module-branded phase-client slots, and a single-side production execution API.

The four-file JSON-ledger implementation attempted before this amendment is not acceptable evidence. Task 5 uses the Task 4 SQLite ledger as its sole state authority and the Task 3 branded stores/runtimes as its sole execution authority. Do not preserve or add a second JSON phase/final state machine.

- [ ] **Step 1: Write judgment-closure red tests**

Reject release-side preference labels and native-type coercions. Persist both complete normalized judgments with evaluator identity/version and input/output checksums. Mark manual review for any score, preference, unresolved, or normalized-finding difference. Add turn/life A/B permutation tests proving release identity, phase order, side, model, session, prompt, and attestation are absent. LIFE uses the closed `life_plan` output/rubric and never the turn comparison path.

- [ ] **Step 2: Write CLI/run-identity red tests**

Implement and test:

- `--ledger <path>`;
- first-run generated UUID `runId` printed and persisted;
- `--resume-run <runId>` required for continuation;
- `--only-final-key <finalKey>` selects exactly one member of the full bound plan;
- missing, duplicate, unknown, or valueless options reject; production `--max-items` is forbidden;
- missing, duplicate, changed-plan, changed-source, changed-release, changed-attestation, changed-artifact, and finalized/blocked run resumes reject as applicable;
- removing the selector resumes all remaining finals in the same run.

The immutable SQLite header has exact native keys `{version,runId,finalKeys,planChecksum,sourceHead,stableRelease,candidateRelease,attestation,attestationChecksum,artifactPaths,createdAt}`. `version` is the exact supported integer, `runId` is a UUID string, `finalKeys` is the ordered 246-key unique array, checksums are lowercase SHA-256 strings, and `createdAt` is a non-negative safe integer.

Each release snapshot has exact keys `{releaseId,pipelineVersion,presetVersion,cognitionSchemaVersion,expressionSchemaVersion,evaluatorVersion,modelProfile,componentManifest,releaseChecksum,createdAt,retiredAt}` with the same native types as the persisted release row. The ledger re-reads the exact row, validates its registry/manifest checksum, and requires canonical byte equality with the header.

`attestation` has exact keys `{version,sourceHead,stableRuntime,candidateRuntime,evaluatorPrimary,evaluatorSecondary}`. Each runtime entry is the exact closed value returned by `assertProductionRuntimeAttestation()`. Each evaluator entry has exact keys `{evaluatorId,evaluatorVersion,modelProfileChecksum,clientConfigChecksum,sessionNamespaceChecksum}`; evaluator identities and namespace checksums must differ. `attestationChecksum === contentHash(attestation)` is recomputed on every open. `artifactPaths` has exact keys `{plan,ledger,raw}`; values are distinct project-root-relative forward-slash paths with no drive, leading slash, backslash, empty segment, `.` or `..`, and their resolved locations must stay under the fixed ignored private artifact root. The database header checksum is canonical `contentHash(header)` and every nested checksum is rederived, never trusted from a caller.

A pilot selector never changes that header. Header drift rejects before temporary runtime or model-client creation.

- [ ] **Step 3: Write phase-resume red tests**

Interrupt in `prepared`, `starting`, and `running`, immediately before and after the awaited `onTurnStarted`, and immediately before and after call/phase completion. Restart with the same SQLite ledger and prove completed phases/subcalls do not increase app-server counters. A persisted `starting`/`running` call accepts only the one exact completed new remote turn; zero, active, multiple, changed-input, changed-client-ID, or conflicting candidates become `uncertain`. `uncertain` is never auto-reissued and atomically blocks the final and whole run.

Add an additive Task 3 interface:

```js
executeQualitySubjectSide(context, subject, {
  side: 'stable' | 'candidate',
  phaseClientSlot
})
```

`prepareQualitySubject()` still creates the common seed and independent byte clones, but stable and candidate execution are separate phase calls. The runner must never call combined `executeQualitySubject()` as production evidence. Each runtime is composed initially with its own module-branded, unbound phase-client slot supplied through the existing runtime factory boundary. After the matching ledger phase reaches `running`, the slot binds exactly once to `LedgerBackedModelClient.forPhase()`. Before binding, after conflicting rebinding, or when shared across side/final/phase it rejects. The runtime's store, release, authority snapshot, source head, adapter registry, release executor, client identity, and attestation are revalidated immediately before and after the selected side executes. No public runtime/client field is mutated.

The exact construction order is: create two distinct module-private unbound slots before `prepareQualitySubject()`; pass the matching slot as an immutable input to `composeYuqiExecutionRuntime()`; store its identity only in module-private runtime metadata/WeakMap; build and freeze the runtime; atomically advance the SQLite phase to `running`; bind that one slot to the exact `(runId,finalKey,side phase,inputChecksum)`; execute once. `runtime-composition.mjs` exposes a narrow identity assertion for the bridge, not the slot or mutable setter. Bind-before-running, run-before-bind, duplicate/conflicting bind, and cross-side/final/phase reuse reject.

The production CLI cannot accept caller `stableRuntime`, `candidateRuntime`, `runtimeFactory`, `runtimeInput`, store, executor, or slot objects. Only the later module-branded `createQualityReplayExecutionConfig()` may supply the fixed composition factory and four clients. Tests use a separate explicitly test-only factory that is always `evidenceEligible:false` and cannot satisfy a production run header/attestation.

Task 4's ledger client gains a module-private branded phase slot and preserves the exact production `deadlineMs`/`outerDeadlineMs` to `turnTimeoutMs` calculation in `runRole()`. `forPhase()` is executable only for a persisted `running` phase; nested calls keep deterministic ordinals starting at zero per phase and never call an underlying `runRole()` bypass.

- [ ] **Step 4: Verify red**

```powershell
node --test yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/quality-replay-ledger.test.mjs yuqi-runtime/test/quality-replay-production-bridge.test.mjs
```

- [ ] **Step 5: Implement sequential persisted phases**

```text
stable_execution -> candidate_execution -> evaluator_primary -> evaluator_secondary -> final
```

Each phase uses its own `LedgerBackedModelClient`. Export artifacts only from ledger rows; never append partial duplicate records.

For every selected final:

1. compile and prepare the exact frozen subject;
2. derive phase identity from the closed subject checksum and prepared authority input checksum;
3. `preparePhase()` and reuse an exact `succeeded` output locally, otherwise atomically advance `prepared -> starting -> running`;
4. bind the matching phase slot/client and execute only that phase;
5. persist the complete phase output before any later phase starts;
6. stop after failure and block after uncertainty;
7. after both evaluator phases, call `finalizeBlindJudgments()` and persist one closed final object containing the two complete judgment records, their checksums, differences, manual-review/unresolved state, and stable/candidate/blind-input authority checksums.

`quality_finals.value_json` has exact keys `{version,finalKey,subjectType,subjectChecksum,stablePhase,candidatePhase,blindInputChecksum,primary,secondary,comparison}`. `subjectType` is exactly `turn|life_planning`; each execution phase has exact `{inputChecksum,outputChecksum}`. Each judgment record has exact `{evaluatorId,evaluatorVersion,inputChecksum,output,outputChecksum}`. `output` is the exact normalized blind object `{version,scores,preference,findings,unresolved}`: scores have every fixed dimension exactly once with native integers 1..5; preference is exactly `A|B|tie|unresolved`; unresolved is a native boolean; each finding is exact `{code,severity,owner,summary,critical}` with the existing native closed enums/types. Judgment metadata and evaluator input/output may not contain release, side, phase, model, session, prompt, client, thread, or attestation fields.

`comparison` has exact keys `{version,differences,manualReview,unresolved,agreedCriticalFindings}`. Differences are unique, canonical-order members of `scores|preference|unresolved|findings`; `manualReview` equals whether a difference exists or either judgment is unresolved; `unresolved` is the boolean OR of the judgments; agreed critical findings are the canonical intersection of identical normalized critical findings. Every `inputChecksum`, `outputChecksum`, phase checksum, blind-input checksum, difference, and intersection is rederived from persisted phase outputs. Missing/unknown keys, native-type coercion, missing secondary judgment, release-side labels, and raw or self-consistent checksum mutation reject in `finalize()` and on reopen. An evaluator `unresolved` result is preserved as a finalized manual-review record; only ledger/model-call `uncertain` blocks finalization and the run. A finalized final is read only from SQLite and never reconstructed from caller JSON.

Phase/client mapping is fixed: `stable_execution` uses only the stable runtime/slot; `candidate_execution` uses only the candidate runtime/slot; `evaluator_primary` and `evaluator_secondary` use two other independent ledger-backed evaluator clients, session namespaces, and threads and never a release runtime. Turn evaluator input uses only the closed `turn_output` union. LIFE evaluator input uses only `life_plan`, the planning window, LIFE rubric, and closed transcript summary; it excludes episode IDs, release/side/phase/model/session/prompt/attestation and never enters turn comparison/action logic.

A `failed` phase is terminal for that run and is never implicitly reissued by `--resume-run`; later phases for that final do not start. Continuing it requires an explicitly new `runId` after the underlying cause is fixed. An `uncertain` call/phase additionally changes the current run to blocked. Exact succeeded phases replay locally.

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
- Modify: `yuqi-runtime/src/quality-replay.mjs`
- Test: `yuqi-runtime/test/quality-report.test.mjs`
- Test: `tests/yuqi-v3-readiness.test.mjs`
- Test: `tests/yuqi-lived-quality-contract.test.mjs`

**Produces:** version-2 raw replay schema, reporter joins, manual-review input, and readiness validation.

- [ ] **Step 1: Write v2 schema red tests**

Require exactly 246 execution records, 984 phase records, 492 evaluator judgment records, 246 finals/checksums, and a variable non-zero model-call set. Every model row has exact `(finalKey, phase, ordinal)`, role, call ID, request/output checksum, thread/turn identities, and succeeded state.

Reject missing/duplicate phases, phase-owner mismatch, ordinal gaps, model calls without phases, phase completion without owned calls, uncertain/running/failed calls, changed output checksums, evaluator judgment mismatch, and source/release/attestation drift.

- [ ] **Step 2: Preserve protocol-only legacy readability**

If old structural replay artifacts remain supported, keep that parser isolated and explicitly ineligible for production quality readiness. Do not weaken the v2 production evidence gate.

- [ ] **Step 3: Verify red**

```powershell
node --test yuqi-runtime/test/quality-report.test.mjs tests/yuqi-v3-readiness.test.mjs tests/yuqi-lived-quality-contract.test.mjs
```

- [ ] **Step 4: Implement ledger export and rederived joins**

The reporter must compute its provenance checksum from exported rows rather than trusting a caller summary. Manual-review records bind both complete evaluator judgments and the final execution checksum.

- [ ] **Step 5: Run and commit**

```powershell
node --test yuqi-runtime/test/quality-report.test.mjs tests/yuqi-v3-readiness.test.mjs tests/yuqi-lived-quality-contract.test.mjs
git add scripts/report-yuqi-lived-quality.mjs yuqi-runtime/src/quality-replay.mjs yuqi-runtime/test/quality-report.test.mjs tests/yuqi-v3-readiness.test.mjs tests/yuqi-lived-quality-contract.test.mjs
git commit -m "fix: verify variable Yuqi quality model evidence"
```

---

### Task 7: Build the real four-client execution configuration

**Files:**
- Create: `scripts/yuqi-quality-production-execution-config.mjs`
- Create: `yuqi-runtime/test/quality-production-config.test.mjs`
- Modify: `.gitignore`

**Produces:** `createQualityReplayExecutionConfig({rootDir, ledgerPath, runId})`.

- [ ] **Step 1: Write configuration and clean-source red tests**

Require four distinct `CodexAppServerClient` objects, independent session stores/namespaces, exact release profiles, unforgeable runtime attestation, closed evaluator schemas, read-only sandbox, approval `never`, and ignored private output paths.

In a clean detached fixture checkout require empty working-tree diff, empty staged diff, and zero non-ignored untracked files. Bind exact Git head plus input plan SHA/checksum. Ignored artifacts are never source; their paths and checksums live in the run header. Dirty tracked or non-ignored source fails before client startup.

- [ ] **Step 2: Verify red**

```powershell
node --test yuqi-runtime/test/quality-production-config.test.mjs
```

- [ ] **Step 3: Implement four independent ledger-backed lanes**

Stable/candidate use release model profiles. Evaluators use independent profiles and the closed blind schema. Reset session scope per final key while preserving persisted thread identities for recovery. Revalidate attestation and release rows before every phase.

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
node scripts/run-yuqi-lived-quality-replay.mjs --execute --ledger artifacts/yuqi-lived-agency-v3/private/quality-replay-state.sqlite --only-final-key sentinel:fourth_coquetry_test_or_pressure:0 --execution-config scripts/yuqi-quality-production-execution-config.mjs --plan artifacts/yuqi-lived-agency-v3/quality-replay-plan.json
```

Capture the printed `runId`. Verify four succeeded phases, variable succeeded model-call rows, distinct lane/session identities, two complete judgments, exact no-call resume, and zero production mutation.

- [ ] **Step 3: Resume the same run with one life final**

```powershell
node scripts/run-yuqi-lived-quality-replay.mjs --execute --ledger artifacts/yuqi-lived-agency-v3/private/quality-replay-state.sqlite --resume-run RUN_ID --only-final-key coverage:fourth_coquetry_test_or_pressure__feature:0 --execution-config scripts/yuqi-quality-production-execution-config.mjs --plan artifacts/yuqi-lived-agency-v3/quality-replay-plan.json
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
