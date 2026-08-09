# Yuqi Lived Agency v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This project uses one central execution window; do not dispatch overlapping writers for coupled runtime, database, Android, or release files.

**Goal:** Replace Yuqi's rule-accumulating cognition path with a versioned cognition-v3 agency model that understands whole interactions, can revise temporary attitudes, preserves every existing feature, arbitrates concurrent outputs, and ships through a truthful stable/candidate rollout with a formally signed OTA-capable APK.

**Architecture:** Keep one cognition core and provide small TurnKind adapters around it. Separate durable authority into hard constraints, non-binding preferences, and expiring current stances; generate a compact expression brief; validate hard actions deterministically; and commit one cross-retry canonical visible group, structured actions, state patch, memory work, group outbox, receipt, and interaction-lane revision atomically. Treat the current production pipeline as an immutable stable release and v3 as an immutable candidate release, with stable-visible shadow, candidate-visible canary, per-kind rollback, and evidence-bound quality gates.

**Tech Stack:** Node.js 22 ESM, `node:test`, SQLite via the existing runtime store, Markdown/JSON preset assets, Java 21, Android Room, Capacitor 8, WebView JavaScript, GitHub Actions/REST, Android `aapt`/`apksigner`.

**Authoritative design:** `docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md`

## Global Constraints

- The authoritative design above wins over older cognition-v2 plans wherever they conflict.
- Do not add production special cases for red packets, kisses, recharge jokes, or any individual sentence. Fix the general social-state mechanism.
- Preserve direct chat, payments, images, voice, emoji, quotes, multi-bubble batches, proactive chat, proactive moments, moment interaction/reply, role plans, life planning, relationship stages, memory, notifications, recovery, diagnostics, export/import/backup/delete, and Android fallback.
- Preserve the existing Android cloud-queue convergence state machine: `LOCAL_QUEUED → CLOUD_ACCEPTED/BRIDGE_WAITING → PC_ACCEPTED → COMPLETED → UI_APPLIED`. A cloud-accepted turn releases the single drain thread, is completed by inbox recovery, and is never re-enqueued merely because the app restarts.
- For v3, a deadline/lost response/unknown remote outcome never authorizes local fallback because PC may already own the lineage. Only bridge-disabled-before-send or an explicit not-accepted terminal response may grant Android fallback authority. Ambiguity resolves through receipt/replay or ends as retryable at five minutes, never as a second generated reply.
- A user stages multiple bubbles and explicitly submits one complete batch. Never add a timer that waits for more user bubbles after submission.
- Keep ordinary visible replies near one minute; five minutes is the hard user-facing limit. Shadow comparison and consolidation never block the visible path.
- `responseRisks` are current-turn evidence only. They never become `forbiddenMoves`, hard constraints, preferences, or persistent stances.
- Only system/author/user authority may create a hard constraint. Yuqi's ordinary refusal, discomfort, or prior wording is a revisable stance, not a permanent rule.
- Relationship `base/phase` controls formal facts and commitments, not whether ordinary affection is allowed and not visible disclaimer text.
- State writes occur only in the same successful authority transaction as the visible result. Failed, superseded, duplicate, shadow, or uncommitted drafts write no character state or facts.
- Non-Yuqi characters remain on the existing path.
- Existing preset versions remain immutable. Add v3 as a new version; never overwrite `1.9.2` or `2.0.0`.
- Existing old turns resume with their pinned schema and pipeline fields. Only new turns use v3 release IDs and v3 state.
- Wire `protocolVersion` never selects PC `resultAuthorityVersion`. Existing turn-creation APIs remain authority version 0; only the internal `createCanonicalVisibleTurnInternal()` added in Task 10 creates version 1, and Task 11 is its first production caller under the exact eligibility rule defined there.
- The existing 270 fixtures are protocol regression evidence only. They do not count as human-chat quality evidence or live shadow evidence.
- Offline replay rows use replay/quality tables. Only real production comparisons may increment live shadow/canary counters.
- One SQLite row per TurnKind in `cognition_kind_rollouts` remains the current rollout authority. History tables are append-only audit, never current-state authority.
- Stable/candidate release IDs and checksums, not the old words `legacy/cognition`, decide which implementation is visible.
- Low-frequency TurnKinds without genuine live evidence remain shadow and must be reported as such. Do not claim that all kinds are active.
- PC runtime migrations are the already-completed base `user_version 9 → 10` in Task 2 and the mandatory final-result-authority `10 → 11` in Task 10. Android Room independently migrates `10 → 11` in Task 12 and `11 → 12` in Task 13C; equal version numbers in either domain are coincidental and the two version domains must never be conflated. Every path must be transactional, idempotent, and covered by populated-database migration tests.
- Determine the APK version from the maximum version in source, update channel, releases, and local formal artifacts at execution time. It must be greater than `1.0.108`; do not assume a fixed number before Task 26.
- Formal delivery follows `docs/AL-android-signing-runbook.md`. Package `com.siyi.al`, signer SHA-256 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`, version, OTA URL, and final APK SHA-256 must all be independently verified.
- Preserve unrelated dirty-worktree changes. Stage and commit only the files named by the current task.
- Every task starts red, ends green, and gets its own focused commit. Do not combine tasks merely to reduce commit count.
- If a task exposes a structural conflict, stop before proceeding. Report the task, code/data evidence, conflicting design clause, completed/uncompleted state, affected features, safe revision choices, and whether production code was modified.
- A central worker may repair an ordinary implementation defect that stays within this plan. It must stop for missing authority, incompatible data meaning, unverifiable stable baseline, fake/insufficient evidence, version/signing conflict, or a change that would invalidate another feature contract.

---

## File and Responsibility Map

### New PC runtime modules

- `yuqi-runtime/src/agency-state.mjs`: normalize authority records; resolve conflicts; expire or transition current stances; compile compact state views.
- `yuqi-runtime/src/cognition-v3-contract.mjs`: validate cognition-v3 and expression-v3 outputs; compile the expression brief; materialize an authorized draft.
- `yuqi-runtime/src/cognition-v3-adapters.mjs`: build one bounded `CognitionEnvelopeV3` per TurnKind.
- `yuqi-runtime/src/interaction-lanes.mjs`: lane keys, priorities, generation fingerprints, and supersession decisions.
- `yuqi-runtime/src/visible-result-commit.mjs`: one transaction boundary for authority revalidation and visible-result commit.
- `yuqi-runtime/src/production-release-adapters.mjs`: the only production binding from the three immutable pipeline versions to their turn/life draft providers.
- `yuqi-runtime/src/runtime-composition.mjs`: side-effect-free production object-graph factory; creates one complete `ReleaseExecutor` and injects that same instance before any listener/timer starts.
- `yuqi-runtime/src/quality-evaluator.mjs`: deterministic findings, six-dimensional evaluation normalization, blind comparison, and gate aggregation.

### Existing PC runtime modules to evolve

- `yuqi-runtime/src/store.mjs`: v9→v10 base migration, v10→v11 canonical-result migration, v11→v12 semantic-manifest migration, v12→v13 redaction-tombstone migration, release pins, retry lineages, authority records, lanes, quality evidence, atomic commit primitives, backup/export lifecycle.
- `yuqi-runtime/src/role-schemas.mjs`: v3 JSON schemas alongside v2.
- `yuqi-runtime/src/cognition-context.mjs`: bounded history/fact/state retrieval.
- `yuqi-runtime/src/cognitive-pipeline.mjs`: v3 route/checkpoint/reconsideration flow while retaining v2 resume.
- `yuqi-runtime/src/interaction-contract.mjs`: stop elevating response risks into forbidden moves.
- `yuqi-runtime/src/cognitive-state.mjs`: route all new state through v3 stance transitions and real expiry.
- `yuqi-runtime/src/relationship-stage.mjs`: formal-fact-only stage influence.
- `yuqi-runtime/src/comparison-evaluator.mjs`: delegate quality semantics to the new evaluator.
- `yuqi-runtime/src/preset-registry.mjs`: immutable release manifests and stable/candidate checksums.
- `yuqi-runtime/src/promotion-controller.mjs`: release-aware shadow/canary/graduation/rollback authority.
- `yuqi-runtime/src/orchestrator.mjs`, `turn-dispatcher.mjs`, `shadow-dispatcher.mjs`, `life-planning-dispatcher.mjs`: v3 execution, compare direction, failure routing, and fixed release pins.
- `yuqi-runtime/src/result-outbox.mjs`, `reconcile.mjs`, `cloud-relay-pump.mjs`: visible-group and lane-aware delivery/recovery.
- `yuqi-runtime/src/consolidation-worker.mjs`, `evidence-memory.mjs`, `retrieval.mjs`: evidence-only memory writes and v3 retrieval.
- `yuqi-runtime/src/local-server.mjs`, `main.mjs`: rollout/quality/diagnostic commands.

### New immutable preset assets

- `yuqi-runtime/presets/2.1.0/foundation.md`
- `yuqi-runtime/presets/2.1.0/cognition-core-v3.md`
- `yuqi-runtime/presets/2.1.0/expression-v3.md`
- `yuqi-runtime/presets/2.1.0/supervisor-v3.md`
- `yuqi-runtime/presets/2.1.0/consolidation-v3.md`
- `yuqi-runtime/presets/2.1.0/social-experience-v3.json`
- `yuqi-runtime/presets/manifest.json`

### Android and Web

- `android/app/src/main/java/com/siyi/al/execution/db/ConversationCursorEntity.java`: durable native/UI visibility cursor by character.
- `android/app/src/main/java/com/siyi/al/execution/FallbackCognitionPacketCodec.java`: v1/v2/v3 snapshot compatibility.
- Existing Room, plugin, store, bridge, gateway, engine, and service files: cursor persistence, v3 fallback, exactly-once visible groups, diagnostics.
- `tavern-app/index.html`: v3 snapshot builder, cursor handoff, event/poll reconciliation, diagnostics.
- Current service worker file and its registration tests: increment cache/build identity without changing automatic-task guards.

### Evidence, scripts, and reports

- `scripts/audit-yuqi-lived-v3-baseline.mjs`: immutable baseline/version/feature inventory.
- `scripts/migrate-yuqi-agency-state.mjs`: dry-run/apply/report state migration.
- `scripts/compile-yuqi-lived-quality-scenes.mjs`: validate and compile source-grounded multi-turn quality scenes.
- `scripts/extract-yuqi-real-history-scenes.mjs`: local-only redacted history extraction.
- `scripts/run-yuqi-lived-quality-replay.mjs`: repeated stable/candidate replay.
- `scripts/report-yuqi-lived-quality.mjs`: materialized, checksummed quality gate report.
- `scripts/cognition-rollout.mjs`: status/check/promote/rollback commands around the one controller.
- `tests/fixtures/yuqi-lived-quality-v1/`: committed sentinel seeds, deterministic surface variants, source map, and manifest.
- `artifacts/yuqi-lived-agency-v3/`: generated baseline, migration, replay, race, rollout, and release evidence.

## Cross-Task Interface Contract

Use these exact public names throughout the plan. Later tasks must not silently rename fields.

```js
// agency-state.mjs
normalizeHardConstraint(value, evidenceIndex) -> HardConstraint
transitionHardConstraint({ constraint, operation, authorityEvidence, now }) -> HardConstraint
normalizePreference(value) -> Preference
preferenceFromStableFact(fact) -> Preference
normalizeCurrentStance(value, now) -> CurrentStance
applyStanceTransitions({ stances, transitions, relevantBatch, evidenceIndex, now }) -> {
  activeStances, changedRecords, auditRecords
}
compileAgencyView({ constraints, preferences, stances, featureContext, limits }) -> {
  hardConstraints, preferences, currentStances
}
validateStatePatchAgainstAgency({
  patch, turn, cognitiveState, activeStances, currentBatch, evidenceIndex, effectiveAt
}) -> { semanticPatch, nextState, stanceRevisionRows }

// cognition-v3-contract.mjs
normalizeCognitionV3Result(value, validationContext) -> CognitionV3Result
compileCognitionPacketV3({ envelope, cognitionResult }) -> CognitionPacketV3
compileExpressionBriefV3({ envelope, agencyView, relationship, cognitionResult }) -> ExpressionBriefV3
normalizeExpressionV3Result(value) -> ExpressionV3Result
materializeV3Draft({ cognitionPacket, expressionResult }) -> AuthorizedDraftV3

// cognition-v3-adapters.mjs
buildCognitionEnvelopeV3(input) -> CognitionEnvelopeV3
adapterForTurnKind(kind) -> { buildFeatureContext(input), allowedActions(input) }

// interaction-lanes.mjs
laneKeyForEnvelope(envelope) -> string
priorityForEnvelope(envelope) -> 100 | 200 | 300
generationFingerprint(input) -> string
decideLaneAdmission({ lane, incoming, now }) -> LaneAdmission

// visible-result-commit.mjs
commitVisibleResult({ store, turnId, authorityLineageKey, laneKey,
  expectedTurnRevision, expectedLineageRevision, expectedLaneRevision,
  expectedCognitiveStateRevision, expectedLatestUserBatchId, inputVisibilitySequence,
  inputClearEpoch,
  agencySnapshotChecksum, authoritativeReleaseId, comparisonReleaseId,
  comparisonDirection, visibleGroup, actionSet,
  statePatch, memoryJobs, comparisonJob, generationFingerprint, now
}) -> CommitVisibleResult

// store.mjs result-authority creation boundary
readAgencyAuthoritySnapshotInternal({ roleId, at }) -> {
  version, roleId, constraints, preferenceFacts, stances,
  cognitiveState: { revision, checksum }, checksum
}
createCanonicalVisibleTurnInternal({
  envelope, rolloutKey, expectedRolloutRevision, authoritativeReleaseId,
  comparisonReleaseId, comparisonDirection, laneKey, expectedLaneRevision,
  inputUserBatchId, inputVisibilitySequence, inputClearEpoch, agencySnapshotChecksum,
  annotationSnapshot
}) -> { status: 'created', turn, agencySnapshot }
   | { status: 'already_committed', receipt }
   | { status: 'redacted', receipt: receipt | null, lineage }

// release-pair.mjs
resolvePipelinePair(rollout) -> {
  visibleReleaseId, comparisonReleaseId, comparisonDirection, candidatePhase
}

// comparison-contract.mjs
comparisonContractForDirection(comparisonDirection) -> {
  comparisonMode, comparisonDirection, jobType
}
comparisonContractForMode(comparisonMode) -> {
  comparisonMode, comparisonDirection, jobType
}

// release-executor.mjs
supportsPipelineVersion(pipelineVersion) -> boolean
ReleaseExecutor.adapterIds() -> { turn: AdapterId[], life: AdapterId[] }
ReleaseExecutor.executeTurn({ releaseId, releaseChecksum, execution, dryRun }) -> {
  adapterId, releaseId, releaseChecksum, draft: TurnDraft, dryRun, capabilities
}
ReleaseExecutor.executeLife({ releaseId, releaseChecksum, execution, dryRun }) -> {
  adapterId, releaseId, releaseChecksum, draft: LifeDraft, dryRun, capabilities
}

// production-release-adapters.mjs
createProductionReleaseAdapters({ orchestrator, cognitivePipeline }) -> {
  turnAdapters: Map<AdapterId, TurnAdapter>,
  lifeAdapters: Map<AdapterId, LifeAdapter>
}

// runtime-composition.mjs
composeYuqiExecutionRuntime({
  store, presets, codex, cognitivePipeline, promotionController,
  contextLimit, generationContextLimit, roleProfiles
}) -> {
  releaseExecutor, orchestrator, turnDispatcher,
  lifePlanningDispatcher, shadowDispatcher
}

// promotion-controller.mjs
PromotionController.resolvePipelinePair(rollout) -> ReleasePair
selectPipelinePairForFreshSubject(rolloutKey, { now }) -> {
  rollout, pair: {
    visibleReleaseId, comparisonReleaseId, comparisonDirection, candidatePhase
  }
}
registerCandidate({ rolloutKey, expectedRevision, releaseId, reportId, reportChecksum })
promoteToCanary({ rolloutKey, expectedRevision, reportId, reportChecksum })
graduateCandidate({ rolloutKey, expectedRevision, reportId, reportChecksum })
rollbackCandidate({ rolloutKey, expectedRevision, reasonCode, findingIds })
```

The persisted release semantics are:

| `candidate_phase` | visible | background comparison |
|---|---|---|
| `none` | stable release | none |
| `shadow` | stable release | candidate release |
| `canary` | candidate release | stable release for comparison slots 1–10; none after target |
| `rolled_back` | stable release | none |

Graduation is one transaction: the candidate becomes `stable_release_id`, `candidate_release_id` becomes null, and `candidate_phase` becomes `none`. The old `current_mode`, `rollout_phase`, `preset_version`, and `pipeline_checksum` columns are a compatibility projection only; new code reads release IDs.

---

### Task 0: Freeze the Real Baseline and Enforce the Stop Gate

**Files:**
- Create: `scripts/audit-yuqi-lived-v3-baseline.mjs`
- Create: `tests/yuqi-lived-v3-baseline-audit.test.mjs`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/baseline.json`
- Read only: `yuqi-runtime/config.json`
- Read only: `yuqi-runtime/presets/manifest.json`
- Read only: `android/app/build.gradle`
- Read only: `.github/workflows/android-apk.yml`
- Read only: `android-update.json`
- Read only: `artifacts/*.apk`

**Interfaces:**
- Consumes: current files, runtime database, formal APK artifacts.
- Produces: `auditBaseline({ rootDir, configPath, outPath }) -> BaselineAudit`; no production mutation.

- [ ] **Step 1: Write a failing contract test for a complete baseline**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBaseline } from '../scripts/audit-yuqi-lived-v3-baseline.mjs';

test('baseline names the real stable release, rollout rows, versions, and feature counts', async () => {
  const report = await auditBaseline({
    rootDir: fixtureRoot,
    configPath: `${fixtureRoot}/yuqi-runtime/config.json`,
    outPath: `${fixtureRoot}/artifacts/baseline.json`
  });
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.gitHead);
  assert.ok(report.database.sha256);
  assert.equal(report.database.userVersion, 9);
  assert.ok(report.stableEvidence.releaseId);
  assert.ok(report.stableEvidence.pipelineChecksum);
  assert.equal(report.versions.maximumOccupiedCode, 108);
  assert.equal(report.features.DIRECT_REPLY.enabled, true);
  assert.equal(report.rollouts.length, 10);
  assert.deepEqual(report.stopReasons, []);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing module is the only failure**

Run: `node --test tests/yuqi-lived-v3-baseline-audit.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/audit-yuqi-lived-v3-baseline.mjs`.

- [ ] **Step 3: Implement the baseline audit without guessing stable identity**

```js
export async function auditBaseline({ rootDir, configPath, outPath }) {
  const sourceVersions = await readSourceVersions(rootDir);
  const artifactVersions = await inspectFormalArtifacts(rootDir);
  const database = await inspectRuntimeDatabase(configPath);
  const stableEvidence = await resolveVisibleStableEvidence({ rootDir, database });
  const report = {
    schemaVersion: 1,
    createdAt: Date.now(),
    gitHead: await readGitHead(rootDir),
    database,
    stableEvidence,
    versions: {
      ...sourceVersions,
      formalArtifacts: artifactVersions,
      maximumOccupiedCode: Math.max(sourceVersions.maximumCode, ...artifactVersions.map(x => x.versionCode))
    },
    features: await readFeatureMatrix(rootDir),
    rollouts: database.rollouts,
    stopReasons: validateBaseline({ database, stableEvidence, sourceVersions, artifactVersions })
  };
  await writeJsonAtomically(outPath, report);
  return report;
}
```

`validateBaseline()` must emit a stop reason when the visible stable pipeline cannot be identified by immutable preset/schema/model/checksum evidence, when the database is not v9, when any of the ten rollout keys is missing, or when package/version sources disagree. It must not “repair” these conditions.

- [ ] **Step 4: Run the audit and inspect the materialized evidence**

Run:

```powershell
node --test tests/yuqi-lived-v3-baseline-audit.test.mjs
node scripts/audit-yuqi-lived-v3-baseline.mjs --config yuqi-runtime/config.json --out artifacts/yuqi-lived-agency-v3/baseline.json
```

Expected: test PASS; command exits 0 only when `stopReasons` is empty. If it exits non-zero, invoke the Global Constraints stop report before Task 1.

- [ ] **Step 5: Commit only the audit code and test**

```powershell
git add scripts/audit-yuqi-lived-v3-baseline.mjs tests/yuqi-lived-v3-baseline-audit.test.mjs
git commit -m "test: freeze Yuqi v3 implementation baseline"
```

### Task 1: Implement Authority-Separated Agency State

**Files:**
- Create: `yuqi-runtime/src/agency-state.mjs`
- Create: `yuqi-runtime/test/agency-state.test.mjs`

**Interfaces:**
- Consumes: the Cross-Task Interface Contract and message evidence `{messageId, speakerType, createdAt, content}`.
- Produces: `normalizeHardConstraint`, `normalizePreference`, `normalizeCurrentStance`, `applyStanceTransitions`, `compileAgencyView`.

- [ ] **Step 1: Write red tests for authority, flexibility, expiry, and bounded views**

```js
test('Yuqi-authored ordinary refusal cannot become a hard constraint', () => {
  assert.throws(
    () => normalizeHardConstraint({
      constraintId: 'c1', authority: 'yuqi', kind: 'consent',
      sourceMessageIds: ['a1'], status: 'active', revision: 1
    }, new Map([['a1', { speakerType: 'assistant' }]])),
    /authority/
  );
});

test('a relevant user batch decrements a stance and expires it at zero', () => {
  const result = applyStanceTransitions({
    stances: [stance({ remainingRelevantUserBatches: 1 })],
    transitions: [{ stanceId: 's1', operation: 'maintain', evidenceMessageIds: ['u2'] }],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    now: 2000
  });
  assert.equal(result.activeStances.length, 0);
  assert.equal(result.changedRecords[0].status, 'expired');
});

test('a user constraint is released only by matching user authority evidence', () => {
  const current = userConstraint({ revision: 1, releaseCondition: '用户明确解除' });
  assert.throws(() => transitionHardConstraint({
    constraint: current, operation: 'release',
    authorityEvidence: [{ messageId: 'a2', speakerType: 'assistant', content: '那就算了' }],
    now: 2000
  }), /matching authority/);
  const released = transitionHardConstraint({
    constraint: current, operation: 'release',
    authorityEvidence: [{ messageId: 'u2', speakerType: 'user', content: '这个限制可以取消了' }],
    now: 2000
  });
  assert.equal(released.status, 'released');
  assert.equal(released.revision, 2);
});

test('soften and reverse create revisions rather than mutating history', () => {
  const result = applyStanceTransitions({
    stances: [stance({ strength: 0.8, flexibility: 0.7 })],
    transitions: [{ stanceId: 's1', operation: 'reverse', position: 'accept playful affection',
      reason: 'the new bid changed her mind', evidenceMessageIds: ['u2'] }],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    now: 2000
  });
  assert.equal(result.changedRecords[0].status, 'active');
  assert.equal(result.changedRecords[0].stanceId, 's1');
  assert.equal(result.activeStances[0].supersedes, 's1@1');
  assert.equal(result.activeStances[0].revision, 2);
});

test('agency view returns at most 5 constraints, 2 stances, and relevant preferences', () => {
  const view = compileAgencyView({ constraints, preferences, stances, featureContext, limits: {
    hardConstraints: 5, currentStances: 2, preferences: 4
  }});
  assert.ok(view.hardConstraints.length <= 5);
  assert.ok(view.currentStances.length <= 2);
  assert.ok(view.preferences.every(x => x.binding === false));
});
```

- [ ] **Step 2: Run the state tests red**

Run: `node --test yuqi-runtime/test/agency-state.test.mjs`

Expected: FAIL because `agency-state.mjs` does not exist.

- [ ] **Step 3: Implement strict normalizers and append-only stance transitions**

```js
const HARD_AUTHORITIES = new Set(['system', 'author', 'user']);
const STANCE_OPS = new Set(['maintain', 'strengthen', 'soften', 'reverse', 'expire', 'create']);

export function normalizeHardConstraint(value, evidenceIndex = new Map()) {
  if (!HARD_AUTHORITIES.has(value?.authority)) throw new Error('hard constraint authority is invalid');
  if (value.authority === 'user') {
    const evidence = (value.sourceMessageIds || []).map(id => evidenceIndex.get(String(id)));
    if (!evidence.length || evidence.some(item => item?.speakerType !== 'user')) {
      throw new Error('user hard constraint requires user message evidence');
    }
  }
  return freezeConstraint(value);
}

export function normalizePreference(value) {
  return Object.freeze({ ...structuredClone(value), binding: false });
}

export function transitionHardConstraint({ constraint, operation, authorityEvidence, now }) {
  assertMatchingReleaseAuthority(constraint, authorityEvidence);
  if (!['release', 'archive'].includes(operation)) throw new Error('invalid constraint transition');
  return {
    ...structuredClone(constraint),
    revision: Number(constraint.revision) + 1,
    status: operation === 'release' ? 'released' : 'archived',
    supersedes: constraint.constraintId,
    sourceMessageIds: authorityEvidence.map(item => item.messageId),
    updatedAt: now
  };
}

export function normalizeCurrentStance(value, now = Date.now()) {
  const remaining = Math.min(3, Math.max(0, Number(value?.remainingRelevantUserBatches ?? 3)));
  return {
    ...structuredClone(value),
    strength: clamp01(value?.strength),
    flexibility: clamp01(value?.flexibility),
    remainingRelevantUserBatches: remaining,
    status: value?.expiresAt && Number(value.expiresAt) <= now ? 'expired' : value?.status || 'active'
  };
}

export function applyStanceTransitions({
  stances, transitions, relevantBatch, evidenceIndex, now
}) {
  validateTransitionCoverage(stances, transitions, relevantBatch);
  return reduceTransitionsAppendOnly({
    stances, transitions, relevantBatch, evidenceIndex, now
  });
}

export function compileAgencyView({ constraints, preferences, stances, featureContext, limits }) {
  return rankAndLimitAgencyRecords({ constraints, preferences, stances, featureContext, limits });
}
```

The implementation must reject missing transition coverage for every relevant
active stance, reject `maintain` without fresh evidence, expire by time before
ranking, decrement only when the submitted batch is relevant, cap extensions at
three new relevant batches, and preserve every prior revision for audit.
Non-create transitions retain the stable `stanceId`; their append-only head uses
`supersedes: '<stanceId>@<previousRevision>'`. `changedRecords` contains the
actual rows that can be inserted, never a rewritten copy of an already-persisted
primary key.

- [ ] **Step 4: Run state tests green**

Run: `node --test yuqi-runtime/test/agency-state.test.mjs`

Expected: PASS, including create/maintain/strengthen/soften/reverse/expire, irrelevant-batch non-decrement, time expiry, authority rejection, and deterministic ranking.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/agency-state.mjs yuqi-runtime/test/agency-state.test.mjs
git commit -m "feat: separate Yuqi constraints preferences and stances"
```

### Task 2: Add the PC v10 Persistence and Release Authority

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/test/store-cognition-migration.test.mjs`
- Create: `yuqi-runtime/test/store-agency-v10.test.mjs`

**Interfaces:**
- Consumes: Task 1 records and the stable/candidate semantics table.
- Produces: PC schema v10 base authority; store methods named in the implementation block below. It intentionally does not yet provide canonical visible-result authority; Task 10 upgrades this exact schema to v11 before any v3 visible result can commit.

- [ ] **Step 1: Add migration tests from clean v9 and populated v9**

```js
test('v9 to v10 is non-destructive and idempotent', () => {
  const db = createPopulatedV9Database();
  const before = countStructuralRows(db);
  const store = new YuqiStore(db);
  assert.equal(store.userVersion(), 10);
  assert.deepEqual(countStructuralRows(db), before);
  store.migrate();
  assert.equal(store.userVersion(), 10);
  assert.equal(store.listPipelineReleases().length, 2);
});

test('new turns pin release pair and lane revision while old turns remain readable', () => {
  const store = migratedStore();
  const oldTurn = store.getTurn('turn_v2');
  assert.equal(oldTurn.authoritativeReleaseId, null);
  const created = store.createTurnWithReleasePinInternal({
    envelope: directEnvelope('turn_v3'), rolloutKey: 'DIRECT_REPLY',
    laneKey: 'private_chat', expectedLaneRevision: 0
  });
  assert.ok(created.authoritativeReleaseId);
  assert.equal(created.laneKey, 'private_chat');
});

test('v2 cognitive snapshot separates slow medium and fast state', () => {
  store.putCognitiveStateInternal('yuqi', cognitiveSnapshotV2());
  const state = store.getCognitiveState('yuqi');
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.state).sort(), ['fastState', 'mediumState', 'slowState']);
  assert.equal(state.state.slowState.longTermRelationshipBase, 'familiar');
  assert.equal(state.state.fastState.mood, 'annoyed');
});
```

- [ ] **Step 2: Run migration tests red**

Run: `node --test yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs`

Expected: FAIL on expected user version 10 and missing v10 tables/methods.

- [ ] **Step 3: Implement the exact v10 schema**

```sql
CREATE TABLE IF NOT EXISTS pipeline_releases (
  release_id TEXT PRIMARY KEY,
  pipeline_version TEXT NOT NULL,
  preset_version TEXT NOT NULL,
  cognition_schema_version INTEGER NOT NULL,
  expression_schema_version INTEGER NOT NULL,
  evaluator_version TEXT NOT NULL,
  model_profile_json TEXT NOT NULL,
  component_manifest_json TEXT NOT NULL,
  release_checksum TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  retired_at INTEGER
);

CREATE TABLE IF NOT EXISTS constraint_records (
  constraint_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  authority TEXT NOT NULL CHECK(authority IN ('system','author','user')),
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  rule_text TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,
  source_config_ref TEXT,
  release_condition TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','released','archived')),
  supersedes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(constraint_id, revision)
);

CREATE TABLE IF NOT EXISTS stance_records (
  stance_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  role_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  position_text TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  strength REAL NOT NULL,
  flexibility REAL NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  expires_at INTEGER,
  remaining_relevant_user_batches INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','expired','superseded')),
  supersedes TEXT,
  PRIMARY KEY(stance_id, revision)
);

CREATE TABLE IF NOT EXISTS interaction_lanes (
  role_id TEXT NOT NULL,
  lane_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  generating_turn_id TEXT,
  latest_user_batch_id TEXT,
  latest_authoritative_group_id TEXT,
  native_completed_group_id TEXT,
  native_completed_sequence INTEGER NOT NULL DEFAULT 0,
  ui_applied_group_id TEXT,
  ui_applied_sequence INTEGER NOT NULL DEFAULT 0,
  local_sequence INTEGER NOT NULL DEFAULT 0,
  last_commit_checksum TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(role_id, lane_key)
);

CREATE TABLE IF NOT EXISTS quality_eval_runs (
  eval_run_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  baseline_release_id TEXT NOT NULL,
  suite_version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  state TEXT NOT NULL,
  manifest_checksum TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS quality_findings (
  finding_id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL,
  rollout_key TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  code TEXT NOT NULL,
  owner TEXT NOT NULL,
  severity TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state_migration_audit (
  audit_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  target_id TEXT,
  reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(role_id, source_type, source_id)
);
```

Alter `cognition_kind_rollouts` with `stable_release_id`, `candidate_release_id`, and `candidate_phase`; alter `turns` and `cognition_life_planning_attempts` with `authoritative_release_id`, `comparison_release_id`, `authoritative_pipeline_checksum`, `comparison_pipeline_checksum`, `lane_key`, `lane_revision`, `input_visibility_sequence`, and `generation_fingerprint`. Register two immutable synthetic release rows for the baseline audit's actual stable and existing v2 candidate; do not infer them from mode names.

New `cognitive_states.schema_version=2` snapshots use this exact time-scale shape:

```json
{
  "slowState": {
    "preferenceFactIds": [],
    "formalCommitmentFactIds": [],
    "longTermRelationshipBase": "familiar"
  },
  "mediumState": {
    "relationshipPhase": "normal",
    "unresolvedConflictIds": [],
    "activeRolePlanIds": [],
    "activeLifeEpisodeIds": []
  },
  "fastState": {
    "mood": "",
    "body": "",
    "attention": "",
    "openThreadIds": []
  }
}
```

Stable preferences remain evidence-backed `facts`/memory records of type `stable_preference`; the snapshot stores IDs, not a second preference authority. Hard constraints and current stances live in their append-only v10 tables. This prevents one transient mood or affectionate line from mutating the long-term relationship base.

Add these exact store methods:

```js
putPipelineReleaseInternal(release)
getPipelineRelease(releaseId)
listPipelineReleases()
putConstraintRevisionInternal(record)
listActiveConstraints(roleId)
putStanceRevisionInternal(record)
listActiveStances(roleId, now)
getInteractionLane(roleId, laneKey)
claimInteractionLaneInternal(input)
putQualityEvalRunInternal(run)
putQualityFindingInternal(finding)
putStateMigrationAuditInternal(audit)
createTurnWithReleasePinInternal(input)
```

Read `PRAGMA user_version` before migration: versions below 9 first follow the existing historical migrations, version 9 runs the new transaction, version 10 performs invariant checks without rewriting data, and versions above 10 stop as unsupported. Remove the current unconditional assignment back to 9. Set `PRAGMA user_version = 10` only after all DDL, backfill, and invariant queries succeed in one transaction. `cognitive_states` remains the one snapshot table; new snapshots use `schema_version = 2`, satisfying the design's `cognitive_state_v2` without creating a competing snapshot authority.

Task 2's version-10 assertion is the historical completion boundary for this task, not the final application schema. After Task 10, the same migration entrypoint must accept populated v10, apply v11 once, and assert v11 on later opens. Do not retroactively pretend Task 2 created the visible group tables, and do not use `reply_json`, `turn_id`, or `updated_at` as a temporary replacement for them. `createTurnWithReleasePinInternal()` remains a version-0 compatibility API even after v11; Task 10 adds a separate internal canonical-authority creator rather than silently changing this method's meaning.

- [ ] **Step 4: Run migration and store tests green**

Run: `node --test yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs`

Expected: PASS; row counts for messages, facts, relationship state/history, role plans, life episodes, turns, and outbox are unchanged.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/store.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs
git commit -m "feat: add Yuqi agency and release persistence"
```

### Task 3: Migrate Legacy Boundaries Without Inventing Authority

**Files:**
- Create: `scripts/migrate-yuqi-agency-state.mjs`
- Create: `tests/yuqi-agency-state-migration.test.mjs`
- Modify: `scripts/backup-yuqi-memory.mjs`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/migration-report.json`

**Interfaces:**
- Consumes: v9 `cognitive_states.activeBoundaries`, raw message evidence, Task 2 v10 tables.
- Produces: `classifyLegacyBoundary(input) -> hard_constraint | current_stance | archive`; `migrateAgencyState({ store, apply, now })`.

- [ ] **Step 1: Write red classification and idempotency tests**

```js
test('only explicit user evidence can migrate to a user hard constraint', () => {
  assert.equal(classifyLegacyBoundary({
    boundary: { sourceMessageIds: ['u1'], text: '不要再提我的公司' },
    messages: [{ messageId: 'u1', speakerType: 'user', content: '不要再提我的公司' }],
    now: 1000
  }).classification, 'hard_constraint');
});

test('Yuqi temporary attitude becomes a short stance, not a hard constraint', () => {
  const result = classifyLegacyBoundary({
    boundary: { sourceTurnId: 't1', sourceMessageIds: ['a1'], text: '今天不想收第二次' },
    messages: [{ messageId: 'a1', speakerType: 'assistant', content: '今天不想收第二次' }],
    now: 1000
  });
  assert.equal(result.classification, 'current_stance');
  assert.ok(result.record.remainingRelevantUserBatches <= 3);
});

test('uncertain or expired legacy material is archived and migration is idempotent', () => {
  const first = migrateAgencyState({ store, apply: true, now: 1000 });
  const second = migrateAgencyState({ store, apply: true, now: 1000 });
  assert.equal(second.insertedCount, 0);
  assert.equal(first.beforeCounts.messages, first.afterCounts.messages);
});
```

- [ ] **Step 2: Run migration tests red**

Run: `node --test tests/yuqi-agency-state-migration.test.mjs`

Expected: FAIL on missing migration exports.

- [ ] **Step 3: Implement dry-run-first migration**

```js
export function classifyLegacyBoundary({ boundary, messages, now }) {
  const evidence = resolveExactEvidence(boundary.sourceMessageIds, messages);
  if (boundary.authority === 'system' || boundary.authority === 'author') {
    return buildHardConstraintClassification(boundary, evidence, now);
  }
  if (evidence.length > 0 && evidence.every(message => message.speakerType === 'user')
      && isExplicitBoundaryEvidence(boundary, evidence)) {
    return buildHardConstraintClassification({ ...boundary, authority: 'user' }, evidence, now);
  }
  if (evidence.length > 0 && evidence.some(message => message.speakerType === 'assistant')
      && isStillTemporallyRelevant(boundary, now)) {
    return buildShortStanceClassification(boundary, evidence, now);
  }
  return { classification: 'archive', reasonCode: 'INSUFFICIENT_OR_EXPIRED_AUTHORITY', evidence };
}

export function migrateAgencyState({ store, apply = false, now = Date.now() }) {
  const snapshot = store.readMigrationSourceSnapshot();
  const decisions = snapshot.activeBoundaries.map(boundary =>
    classifyLegacyBoundary({ boundary, messages: snapshot.messages, now }));
  const report = buildMigrationReport(snapshot, decisions);
  if (apply) store.applyAgencyMigrationInternal({ report, decisions, now });
  return report;
}
```

`isExplicitBoundaryEvidence()` may validate that the archived record already carries explicit user-boundary provenance and its quoted text matches the source message. It must not promote by keywords alone. Ambiguity always archives. Backup output must include all v10 tables and the pre-migration DB SHA-256.

- [ ] **Step 4: Prove dry-run/apply equality on a copy, then apply once**

Run:

```powershell
node --test tests/yuqi-agency-state-migration.test.mjs
node scripts/backup-yuqi-memory.mjs yuqi-runtime/config.json
node scripts/migrate-yuqi-agency-state.mjs --config yuqi-runtime/config.json --dry-run --out artifacts/yuqi-lived-agency-v3/migration-report.json --clone-out artifacts/yuqi-lived-agency-v3/migration-validation.db
node scripts/migrate-yuqi-agency-state.mjs --database artifacts/yuqi-lived-agency-v3/migration-validation.db --apply --expect-report artifacts/yuqi-lived-agency-v3/migration-report.json
```

Expected: tests PASS; dry-run and clone-apply decision checksums match; before/after structural counts match; every source boundary has exactly one audit row. The production database remains unchanged until Task 27 stops the runtime and applies the already-validated migration. Any unresolvable database path, count difference, or checksum difference triggers the stop protocol.

- [ ] **Step 5: Commit**

```powershell
git add scripts/migrate-yuqi-agency-state.mjs scripts/backup-yuqi-memory.mjs tests/yuqi-agency-state-migration.test.mjs
git commit -m "feat: migrate legacy cognition state with authority audit"
```

### Task 4: Define and Validate Cognition-v3 Contracts

**Files:**
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Create: `yuqi-runtime/src/cognition-v3-contract.mjs`
- Create: `yuqi-runtime/test/cognition-v3-contract.test.mjs`

**Interfaces:**
- Consumes: Task 1 agency records and authoritative action targets.
- Produces: the five cognition-v3 contract functions in the Cross-Task Interface Contract.

- [ ] **Step 1: Write red tests for required social reading, state transitions, and expression authority**

```js
test('v3 requires an intentional decision about an identified social bid', () => {
  const value = validCognitionV3();
  value.interactionRead.primarySocialMeaning = 'playful reassurance bid';
  delete value.interactionDecision.shouldAcknowledgeBid;
  assert.throws(() => normalizeCognitionV3Result(value, validationContext()), /shouldAcknowledgeBid/);
});

test('response risks cannot appear in the expression brief', () => {
  const brief = compileExpressionBriefV3(validCompileInput({
    responseRisks: ['may look transactional']
  }));
  assert.equal(JSON.stringify(brief).includes('may look transactional'), false);
});

test('expression cannot add payment, moment, plan, stage, stance, or factual actions', () => {
  const input = validExpressionV3();
  input.paymentAction = { action: 'accept' };
  assert.throws(() => normalizeExpressionV3Result(input), /additional properties/);
});

test('DIRECT_REPLY cannot intentionally skip', () => {
  const value = validCognitionV3();
  value.interactionDecision.intendedResponse = 'skip';
  assert.throws(() => normalizeCognitionV3Result(value, directContext()), /DIRECT_REPLY/);
});
```

- [ ] **Step 2: Run contract tests red**

Run: `node --test yuqi-runtime/test/cognition-v3-contract.test.mjs`

Expected: FAIL because v3 schemas and module are absent.

- [ ] **Step 3: Add exact v3 top-level schemas and materialization rules**

```js
export const COGNITION_SCHEMA_V3 = objectSchema({
  interactionRead: objectSchema({
    surfaceAct: stringSchema(),
    primarySocialMeaning: stringSchema(),
    alternativeMeaning: nullableStringSchema(),
    confidence: numberSchema(),
    evidenceMessageIds: stringArraySchema()
  }),
  selfResponse: objectSchema({
    immediateFeeling: stringSchema(),
    desire: stringSchema(),
    resistance: stringSchema(),
    attention: stringSchema(),
    stanceTransitions: arraySchema(STANCE_TRANSITION_SCHEMA)
  }),
  interactionDecision: objectSchema({
    intendedResponse: enumSchema(['send', 'skip']),
    relationshipEffect: stringSchema(),
    shouldAcknowledgeBid: booleanSchema(),
    intentionalNonResponseReason: nullableStringSchema(),
    mustConvey: stringArraySchema(),
    mustNotClaim: stringArraySchema()
  }),
  actionIntent: ACTION_INTENT_V3_SCHEMA,
  statePatch: STATE_PATCH_V3_SCHEMA
});

export const EXPRESSION_SCHEMA_V3 = objectSchema({
  action: enumSchema(['send', 'skip']),
  reply: stringSchema(),
  usedFactIds: stringArraySchema(),
  bubblePlan: arraySchema(objectSchema({
    text: stringSchema(),
    purpose: stringSchema()
  })),
  incompatibility: nullableStringSchema()
});
```

Validation must reuse the existing authoritative payment/moment/role-plan/life/stage target checks, verify every evidence message ID, require one transition per relevant stance, and reject actions outside `allowedActions`. `compileExpressionBriefV3()` includes only persona/phase tone, complete visible batch/history, compact current state, decided interaction response, `mustConvey`, `mustNotClaim`, authorized actions, and at most two continuity details. It excludes analysis, confidence, risk labels, state field names, stage thresholds, and evaluator taxonomy.

`compileCognitionPacketV3()` returns `{schemaVersion: 3, envelope, cognitionResult, packetChecksum}` where `packetChecksum` hashes the other three fields. It is the checkpoint consumed by expression, supervision, retry, comparison, and Android fallback.

- [ ] **Step 4: Run v2 and v3 contract tests together**

Run: `node --test yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs`

Expected: PASS; v2 behavior remains unchanged and v3 rejects unauthorized expression changes.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/cognition-v3-contract.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs
git commit -m "feat: define cognition v3 decision contracts"
```

### Task 5: Build Bounded TurnKind Adapters

**Files:**
- Create: `yuqi-runtime/src/cognition-v3-adapters.mjs`
- Modify: `yuqi-runtime/src/cognition-context.mjs`
- Modify: `yuqi-runtime/src/conversation-context.mjs`
- Modify: `yuqi-runtime/src/current-user-batch.mjs`
- Create: `yuqi-runtime/test/cognition-v3-adapters.test.mjs`

**Interfaces:**
- Consumes: raw envelope, current complete batch, verified facts, Task 1 agency view, stage/life/plan/moment context.
- Produces: `adapterForTurnKind(kind)` and `buildCognitionEnvelopeV3(input)`.

- [ ] **Step 1: Write one red matrix test that covers every adapter and the context budget**

```js
const turnCases = [
  ['DIRECT_REPLY', ['currentBatch', 'payment', 'attachments', 'quote']],
  ['PROACTIVE_CHAT', ['motiveCandidates', 'openThreads', 'dueCommitments']],
  ['PROACTIVE_MOMENT', ['committedLifeEvents', 'publicPrivacy']],
  ['MOMENT_INTERACTION', ['targetMoment', 'targetComment', 'thread']],
  ['MOMENT_REPLY', ['targetMoment', 'targetComment', 'thread']],
  ['ROLE_PLAN_CHAT', ['rolePlan', 'occurrence']],
  ['ROLE_PLAN_MOMENT', ['rolePlan', 'occurrence', 'publicPrivacy']],
  ['ROLE_PLAN_CHAT_PRIVATE', ['rolePlan', 'occurrence']],
  ['ROLE_PLAN_MOMENT_PRIVATE', ['rolePlan', 'occurrence', 'publicPrivacy']],
  ['LIFE_PLANNING', ['planningWindow', 'existingEpisodes']]
];

for (const [kind, featureKeys] of turnCases) {
  test(`${kind} receives only its feature context`, () => {
    const result = buildCognitionEnvelopeV3(oversizedInput(kind));
    assert.deepEqual(Object.keys(result.featureContext).sort(), featureKeys.sort());
    assert.equal(result.currentInteraction.messages.length, currentBatch(kind).messages.length);
    assert.ok(result.relevantHistory.length <= 20);
    assert.ok(result.verifiedFacts.length <= 8);
    assert.ok(result.hardConstraints.length <= 5);
    assert.ok(result.currentStances.length <= 2);
    assert.ok(result.socialExperience.length <= 3);
    assert.ok(result.openThreads.length <= 3);
  });
}
```

- [ ] **Step 2: Run adapter tests red**

Run: `node --test yuqi-runtime/test/cognition-v3-adapters.test.mjs`

Expected: FAIL on missing adapter module.

- [ ] **Step 3: Implement the adapter registry and preserve complete groups**

```js
const ADAPTERS = Object.freeze({
  DIRECT_REPLY: directReplyAdapter,
  PROACTIVE_CHAT: proactiveChatAdapter,
  PROACTIVE_MOMENT: proactiveMomentAdapter,
  MOMENT_INTERACTION: momentInteractionAdapter,
  MOMENT_REPLY: momentInteractionAdapter,
  ROLE_PLAN_CHAT: rolePlanChatAdapter,
  ROLE_PLAN_MOMENT: rolePlanMomentAdapter,
  ROLE_PLAN_CHAT_PRIVATE: rolePlanChatAdapter,
  ROLE_PLAN_MOMENT_PRIVATE: rolePlanMomentAdapter,
  LIFE_PLANNING: lifePlanningAdapter
});

export function adapterForTurnKind(kind) {
  const adapter = ADAPTERS[String(kind || '')];
  if (!adapter) throw new Error(`unsupported cognition-v3 TurnKind: ${kind}`);
  return adapter;
}

export function buildCognitionEnvelopeV3(input) {
  const adapter = adapterForTurnKind(input.envelope.kind);
  return {
    schemaVersion: 3,
    turnKind: input.envelope.kind,
    currentInteraction: preserveCompleteCurrentInteraction(input),
    relevantHistory: takeCompleteGroups(input.relevantHistory, 20),
    verifiedFacts: rankRelevant(input.verifiedFacts, input, 8),
    ...compileAgencyView({ ...input, limits: {
      hardConstraints: 5, currentStances: 2, preferences: 4
    }}),
    relationshipBasePhase: formalRelationshipView(input),
    lifeSignals: compactLifeSignals(input),
    authorSettings: compileAuthorSettings(input),
    allowedActions: adapter.allowedActions(input),
    featureContext: adapter.buildFeatureContext(input),
    socialExperience: rankRelevant(input.socialExperience, input, 3),
    openThreads: rankRelevant(input.openThreads, input, 3)
  };
}
```

`preserveCompleteCurrentInteraction()` must retain every submitted bubble in order with message ID, type, text/transcript, quote, payment, and attachment reference. It must not inspect only the last bubble. `takeCompleteGroups()` may remove old groups but cannot split a group.

- [ ] **Step 4: Run focused and existing batch tests green**

Run:

```powershell
node --test yuqi-runtime/test/cognition-v3-adapters.test.mjs
node --test yuqi-runtime/test/current-user-batch.test.mjs yuqi-runtime/test/conversation-context.test.mjs
```

Expected: PASS; a submitted batch is processed immediately as one complete unit.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/cognition-v3-adapters.mjs yuqi-runtime/src/cognition-context.mjs yuqi-runtime/src/conversation-context.mjs yuqi-runtime/src/current-user-batch.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs
git commit -m "feat: add bounded cognition v3 feature adapters"
```

### Task 6: Add Immutable v3 Preset Assets and Release Manifest

**Files:**
- Create: `yuqi-runtime/presets/2.1.0/foundation.md`
- Create: `yuqi-runtime/presets/2.1.0/cognition-core-v3.md`
- Create: `yuqi-runtime/presets/2.1.0/expression-v3.md`
- Create: `yuqi-runtime/presets/2.1.0/supervisor-v3.md`
- Create: `yuqi-runtime/presets/2.1.0/consolidation-v3.md`
- Create: `yuqi-runtime/presets/2.1.0/social-experience-v3.json`
- Modify: `yuqi-runtime/presets/manifest.json`
- Modify: `scripts/compile-yuqi-cognition-assets.mjs`
- Modify: `scripts/sync-yuqi-preset-assets.mjs`
- Modify: `yuqi-runtime/src/preset-registry.mjs`
- Modify: `tests/rp-preset-contract.test.mjs`
- Modify: `yuqi-runtime/test/preset-registry.test.mjs`

**Interfaces:**
- Consumes: v3 schema/assets, current immutable 1.9.2 stable, and current 2.0.0 candidate.
- Produces: preset version `2.1.0`; a `pipelineReleaseManifest(version, baselineReleaseId)` whose checksum covers every component in design §15.2.

- [ ] **Step 1: Write red asset and checksum tests**

```js
test('2.1.0 is immutable, complete, and does not replace existing versions', () => {
  const manifest = readPresetManifest();
  assert.ok(manifest.versions['1.9.2']);
  assert.ok(manifest.versions['2.0.0']);
  assert.deepEqual(Object.keys(manifest.versions['2.1.0'].modules).sort(), [
    'cognition', 'consolidation', 'expression', 'foundation', 'socialExperience', 'supervisor'
  ]);
});

test('v3 release checksum changes for adapters evaluator model or stable baseline', () => {
  const original = registry.pipelineReleaseManifest('2.1.0', 'release_stable_a');
  assert.notEqual(original.checksum,
    registry.pipelineReleaseManifest('2.1.0', 'release_stable_b').checksum);
  assert.notEqual(original.checksum,
    registry.pipelineReleaseManifest('2.1.0', 'release_stable_a', { evaluatorVersion: 'v3.1' }).checksum);
});

test('production assets contain no gift-specific response rule', () => {
  const text = readAllPresetText('2.1.0');
  assert.doesNotMatch(text, /红包.*必须|充值.*必须|亲亲.*必须/);
});
```

- [ ] **Step 2: Run asset tests red**

Run:

```powershell
node --test tests/rp-preset-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs
npm run cognition:check
```

Expected: FAIL because 2.1.0 and its release manifest do not exist.

- [ ] **Step 3: Author the v3 modules from the approved decision boundaries**

The cognition module must contain this operational order, expressed as instructions rather than canned dialogue:

```text
1. Establish visible chronology and read the whole submitted group.
2. Identify the literal act and the most likely current social meaning.
3. Form Yuqi's own immediate feeling, desire, resistance, and attention.
4. Reconsider each relevant temporary stance: maintain, strengthen, soften, reverse, expire, or create.
5. Decide how Yuqi participates and what relational effect she knowingly creates.
6. Decide authorized structured actions separately from the social response.
7. Return only the cognition-v3 JSON contract.
```

The expression module must prohibit analysis/policy narration and require natural stopping, non-redundant bubbles, grounded life detail, and no new structured action. The supervisor module must use the six approved finding codes and owner fields. Social experience must be a small retrieval corpus of general patterns derived from the three annotation files; each item has:

```json
{
  "experienceId": "social_bid_reassurance_01",
  "pattern": "A literal joke can also be a request for a reciprocal attitude.",
  "counterPattern": "Do not assume every joke demands reassurance.",
  "applicability": ["direct_reply", "relationship_test"],
  "sourceRefs": ["真人聊天训练批注-第四轮-交接.md#玩笑中包含的认真要求"]
}
```

Do not include reply text or a full evaluation catalog. The registry manifest is:

```js
{
  pipelineVersion: 'yuqi-lived-agency-v3',
  presetVersion: '2.1.0',
  cognitionSchemaVersion: 3,
  expressionSchemaVersion: 3,
  evaluatorVersion: 'yuqi-lived-quality-v1',
  modelProfile,
  components: {
    presets, schemas, stateCompiler, adapterRegistry, supervisor,
    socialExperience, evaluator, stableBaselineReleaseId
  },
  checksum: contentHash(components)
}
```

- [ ] **Step 4: Compile twice and prove deterministic immutable output**

Run:

```powershell
npm run cognition:sync
npm run cognition:check
npm run presets:check
node --test tests/rp-preset-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs
```

Expected: PASS; a second `cognition:sync` creates no diff; old version checksums are unchanged.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/presets/2.1.0 yuqi-runtime/presets/manifest.json scripts/compile-yuqi-cognition-assets.mjs scripts/sync-yuqi-preset-assets.mjs yuqi-runtime/src/preset-registry.mjs tests/rp-preset-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs
git commit -m "feat: add immutable Yuqi lived agency v3 preset"
```

### Task 7: Execute the v3 Pipeline With Fixed Checkpoints and Time Budgets

**Files:**
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/route-policy.mjs`
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Modify: `yuqi-runtime/src/cognition-context.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline.test.mjs`
- Create: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`

**Interfaces:**
- Consumes: Task 4 contracts, Task 5 envelopes, Task 6 release/preset.
- Produces: `runCognitionV3Turn(input) -> { cognitionPacket, expressionResult, draft, checkpoints, timings }`.

- [ ] **Step 1: Write red tests for route escalation, checkpoint reuse, and latency isolation**

```js
test('fast cognition can escalate before expression', async () => {
  client.queue({ routeDecision: 'deep',
    cognitionResult: cognitionResult({ primarySocialMeaning: 'repair bid' }) });
  client.queue(deepCognitionResult());
  client.queue(expressionResult());
  const result = await pipeline.run(v3DirectInput());
  assert.deepEqual(client.roles(), ['cognition_fast', 'cognition_deep', 'expression']);
  assert.equal(result.draft.rewriteMetadata.source, 'cognition-v3');
});

test('retry reuses the committed cognition checkpoint', async () => {
  const first = await pipeline.run(v3DirectInput({ failExpressionOnce: true }));
  const second = await pipeline.run(v3DirectInput({ turnId: first.turnId }));
  assert.equal(client.countRole('cognition_deep'), 1);
  assert.equal(second.cognitionPacket.packetChecksum, first.cognitionPacket.packetChecksum);
});

test('shadow comparison and consolidation never delay visible completion', async () => {
  const result = await pipeline.run(v3DirectInput({ shadowDelayMs: 90_000 }));
  assert.ok(result.timings.visibleCompletedAt - result.timings.startedAt < 60_000);
  assert.equal(result.shadowState, 'queued');
});
```

- [ ] **Step 2: Run v3 pipeline tests red**

Run: `node --test yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`

Expected: FAIL because v3 execution path is absent.

- [ ] **Step 3: Implement a release-pinned v3 state machine**

```js
export async function runCognitionV3Turn(input) {
  const checkpoint = await input.store.getTurnCheckpoint(input.turn.turnId);
  const envelope = checkpoint.cognitionEnvelope
    || buildCognitionEnvelopeV3(await input.contextLoader.load(input));
  let cognitionResult = checkpoint.cognitionResult || null;
  if (!cognitionResult) {
    const fast = await input.client.runRole('cognition_fast', envelope, { deadlineMs: 45_000 });
    cognitionResult = fast.routeDecision === 'deep'
      ? await input.client.runRole('cognition_deep', envelope, {
          deadlineMs: 120_000, priorFastResult: fast.cognitionResult
        })
      : fast.cognitionResult;
  }
  const cognitionPacket = compileCognitionPacketV3({ envelope, cognitionResult });
  await input.store.saveCognitionCheckpointInternal(input.turn.turnId, cognitionPacket);
  const brief = compileExpressionBriefV3(buildBriefInput(input, cognitionPacket));
  const expressionResult = await input.client.runRole('expression_v3', brief, {
    deadlineMs: 60_000
  });
  const draft = materializeV3Draft({ cognitionPacket, expressionResult });
  return { cognitionPacket, expressionResult, draft, checkpoints: checkpointSummary(input),
    timings: input.clock.snapshot() };
}
```

`route-policy.mjs` must make direct simple messages fast by default and escalate for stance transition, relationship test, payment-as-social-action, conflict/repair, jealousy, affection, user correction, multiple plausible meanings, proactive tasks, relationship changes, or structured actions. Keywords may add evidence but cannot be the sole decision. The visible path has bounded calls and returns a recoverable turn state if the five-minute outer deadline is reached; it never waits on shadow or consolidation.

- [ ] **Step 4: Run v2/v3 pipeline and route tests green**

Run:

```powershell
node --test yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/route-policy.test.mjs
```

Expected: PASS; old v2 checkpoints resume; new v3 checkpoints never silently downgrade to v2.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/src/route-policy.mjs yuqi-runtime/src/codex-client.mjs yuqi-runtime/src/cognition-context.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs
git commit -m "feat: execute release-pinned cognition v3 pipeline"
```

### Task 8: Add Owner-Routed Lived-Quality Supervision

**Files:**
- Create: `yuqi-runtime/src/lived-quality-supervisor.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/rewrite-contract.mjs`
- Create: `yuqi-runtime/test/lived-quality-supervisor.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`

**Interfaces:**
- Consumes: cognition packet, expression draft, applicable maximum-three live checks.
- Produces: `superviseLivedTurn(input) -> { approved, findings }`; `repairPlanForFinding(finding)`.

- [ ] **Step 1: Write red tests for all six codes and bounded repair ownership**

```js
const codes = [
  'SOCIAL_BID_DROPPED', 'SOFT_STANCE_FROZEN', 'INTERNAL_POLICY_LEAK',
  'ONE_SIDED_RELATIONAL_DEMAND', 'DIALOGUE_META_NARRATION', 'CHARACTER_STATE_BREAK'
];

for (const code of codes) {
  test(`${code} has evidence, owner, preservation, change, and acceptance fields`, async () => {
    const finding = await supervisor.detect(fixtureFor(code));
    assert.equal(finding.code, code);
    assert.ok(['cognition', 'expression', 'action'].includes(finding.owner));
    assert.ok(finding.evidenceMessageIds.length);
    assert.ok(finding.mustPreserve.length);
    assert.ok(finding.mustChange.length);
    assert.ok(finding.acceptanceCriteria.length);
  });
}

test('cognition and expression each repair at most once', async () => {
  const result = await pipeline.run(alwaysFailingSupervisionInput());
  assert.equal(result.attempts.cognitionReconsideration, 1);
  assert.equal(result.attempts.expressionRewrite, 1);
  assert.equal(result.attempts.finalReview, 1);
  assert.equal(result.state, 'supervision_failed');
});
```

- [ ] **Step 2: Run supervisor tests red**

Run: `node --test yuqi-runtime/test/lived-quality-supervisor.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`

Expected: FAIL on missing supervisor and repair counters.

- [ ] **Step 3: Implement deterministic checks before a compact model review**

```js
export async function superviseLivedTurn(input) {
  const deterministic = [
    detectUnauthorizedAction(input),
    detectInternalPolicyLeak(input),
    detectStageDisclaimer(input),
    detectTurnSupersession(input)
  ].filter(Boolean);
  if (deterministic.length) return { approved: false, findings: deterministic };
  if (!input.highRisk) return { approved: true, findings: [] };
  const applicableChecks = selectApplicableChecks(input, 3);
  const reviewed = await input.reviewer.review({
    cognitionDecision: compactDecision(input),
    visibleDraft: input.draft.reply,
    currentInteraction: input.currentInteraction,
    continuity: input.continuity,
    checks: applicableChecks
  });
  return normalizeSupervisorResult(reviewed, input);
}
```

The pipeline routes `owner=cognition` to one reconsideration preserving valid action/fact decisions, `owner=expression` to one rewrite preserving cognition/action, and `owner=action` to deterministic failure with no model repair. It performs one final review. It must not pass the complete offline taxonomy into a live prompt.

- [ ] **Step 4: Run supervision and rewrite tests green**

Run:

```powershell
node --test yuqi-runtime/test/lived-quality-supervisor.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/rewrite-contract.test.mjs
```

Expected: PASS; a cognition defect cannot be hidden by wording changes and an expression defect cannot change the action.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/lived-quality-supervisor.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/src/rewrite-contract.mjs yuqi-runtime/test/lived-quality-supervisor.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs
git commit -m "feat: supervise Yuqi lived quality by defect owner"
```

### Task 9: Add Persistent Interaction Lanes and Supersession

**Files:**
- Create: `yuqi-runtime/src/interaction-lanes.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Create: `yuqi-runtime/test/interaction-lanes.test.mjs`
- Modify: `yuqi-runtime/test/store-agency-v10.test.mjs`

**Interfaces:**
- Consumes: Task 2 `interaction_lanes`; envelopes and visibility cursor.
- Produces: lane helpers from the Cross-Task Interface Contract and transactional lane claim/supersession methods.

- [ ] **Step 1: Write red priority, collision, and fingerprint tests**

```js
test('private priority is direct reply over due plan over proactive chat', () => {
  assert.equal(priorityForEnvelope(envelope('DIRECT_REPLY')), 300);
  assert.equal(priorityForEnvelope(envelope('ROLE_PLAN_CHAT')), 200);
  assert.equal(priorityForEnvelope(envelope('PROACTIVE_CHAT')), 100);
});

test('new user batch supersedes an uncommitted ordinary proactive turn', () => {
  const result = decideLaneAdmission({
    lane: lane({ generatingTurn: turn('PROACTIVE_CHAT', 'generating') }),
    incoming: turn('DIRECT_REPLY', 'queued'), now: 1000
  });
  assert.equal(result.supersededTurnId, 'proactive_1');
  assert.equal(result.reasonCode, 'superseded_by_user_batch');
});

test('a due commitment is postponed, not deleted', () => {
  const result = decideLaneAdmission({
    lane: lane({ generatingTurn: turn('ROLE_PLAN_CHAT', 'generating') }),
    incoming: turn('DIRECT_REPLY', 'queued'), now: 1000
  });
  assert.equal(result.requeueTurnId, 'plan_1');
  assert.equal(result.cancelTurnId, null);
});

test('fingerprint only deduplicates adjacent matching authority contexts', () => {
  assert.equal(generationFingerprint(fpInput()), generationFingerprint(fpInput()));
  assert.notEqual(generationFingerprint(fpInput()), generationFingerprint(fpInput({ laneRevision: 9 })));
  const canonical = fpInput({ inputVisibilitySequence: 7 });
  assert.equal(
    generationFingerprint(canonical),
    generationFingerprint({ ...canonical, laneRevision: 9 })
  );
  assert.notEqual(
    generationFingerprint(canonical),
    generationFingerprint({ ...canonical, inputVisibilitySequence: 8 })
  );
});
```

- [ ] **Step 2: Run lane tests red**

Run: `node --test yuqi-runtime/test/interaction-lanes.test.mjs`

Expected: FAIL because lane module is absent.

- [ ] **Step 3: Implement lane keys, priority, and compare-and-swap admission**

```js
export function laneKeyForEnvelope(envelope) {
  if (['DIRECT_REPLY', 'PROACTIVE_CHAT', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE']
      .includes(envelope.kind)) return 'private_chat';
  if (['PROACTIVE_MOMENT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE']
      .includes(envelope.kind)) return 'public_moment';
  if (['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(envelope.kind)) {
    return `moment_interaction:${authoritativeMomentId(envelope)}`;
  }
  throw new Error(`no interaction lane for ${envelope.kind}`);
}

export function priorityForEnvelope(envelope) {
  if (envelope.kind === 'DIRECT_REPLY') return 300;
  if (envelope.kind.startsWith('ROLE_PLAN_')) return 200;
  return 100;
}

export function generationFingerprint(input) {
  const authorityContextRevision =
    Number.isSafeInteger(input.inputVisibilitySequence)
      ? `visibility:${input.inputVisibilitySequence}`
      : `lane:${input.laneRevision}`;
  return contentHash({
    roleId: input.roleId, laneKey: input.laneKey, authorityContextRevision,
    normalizedReply: normalizeVisibleText(input.visibleGroup),
    actionTargets: canonicalActionTargets(input.actionSet),
    contextRevision: input.contextRevision
  });
}
```

The store claim uses `BEGIN IMMEDIATE`, checks expected lane revision, records the incoming turn, marks an uncommitted proactive turn `superseded_by_user_batch`, and requeues rather than deletes a due role-plan turn. Superseded turns produce no notification, state patch, fact, memory job, or skip-budget consumption.

- [ ] **Step 4: Run lane/store tests green**

Run: `node --test yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs`

Expected: PASS, including restart recovery from the persisted lane row.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/interaction-lanes.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs
git commit -m "feat: arbitrate Yuqi output through persistent lanes"
```

### Task 10: Add PC v11 Canonical Result Authority and Commit Atomically

**Files:**
- Create: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `yuqi-runtime/test/store-cognition-migration.test.mjs`
- Modify: `yuqi-runtime/test/store-agency-v10.test.mjs`
- Create: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Create: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Create: `tests/fixtures/authority-identity-v1.json`
- Modify: `scripts/migrate-yuqi-agency-state.mjs`
- Modify: `tests/yuqi-agency-state-migration.test.mjs`

**Interfaces:**
- Consumes: the actual Task 2 v10 schema, an authorized draft, Task 9 lane claim, current action target revisions, Task 1 agency/state patch, and an optional already-materialized comparison job.
- Produces: PC schema v11; `store.createCanonicalVisibleTurnInternal(input)` as the only version-1 creation boundary; one cross-retry lineage authority; `commitVisibleResult()`; `store.commitVisibleResultInternal(input)`; receipt-derived `visibleGroupId` and `commitChecksum`; group-keyed result-authority-version-1 outbox.
- Authority rule: `turnId` identifies one execution attempt. `authorityLineageKey` identifies the one user/trigger interaction that may become visible. Only the lineage may own a receipt.
- Compatibility rule: wire protocol and result authority are independent. Task 10 tests use a currently valid protocol-v2 envelope. Ordinary `submitTurn`/`createTurnWithReleasePinInternal` calls remain result authority version 0 on schema v11.

- [ ] **Step 1: Write red populated-v10 migration and lineage tests**

The migration test must construct/open an actual populated `user_version=10` database before the new `YuqiStore` migrates it. It must not obtain “v10” by opening it once with the new migration code.

```js
test('populated PC v10 migrates once to v11 without inventing authority for old turns', () => {
  const db = createPopulatedV10DatabaseWithOldTurnMessagesAndOutbox();
  const before = countLegacyStructuralRows(db);
  const store = new YuqiStore(db.filename);
  assert.equal(store.userVersion(), 11);
  assert.deepEqual(countLegacyStructuralRows(store.rawDb()), before);
  assert.equal(store.getTurn('turn_v2').resultAuthorityVersion, 0);
  assert.equal(store.getTurn('turn_v2').authorityLineageKey, null);
  assert.equal(store.listTurnAuthorityLineages().length, 0);
  store.migrate();
  assert.equal(store.userVersion(), 11);
  assert.deepEqual(countLegacyStructuralRows(store.rawDb()), before);
});

test('ordinary protocol-v2 release-pinned creation remains legacy authority on v11', () => {
  const turn = store.createTurnWithReleasePinInternal(
    legacyReleasePinnedV2Input('turn_legacy')
  );
  assert.equal(turn.resultAuthorityVersion, 0);
  assert.equal(turn.authorityLineageKey, null);
  assert.equal(store.listTurnAuthorityLineages().length, 0);
});

test('explicit canonical internal creation accepts protocol v2 and creates one lineage', () => {
  const outcome = store.createCanonicalVisibleTurnInternal(
    canonicalV2CreateInput('turn_original')
  );
  assert.equal(outcome.status, 'created');
  const turn = outcome.turn;
  assert.equal(turn.resultAuthorityVersion, 1);
  assert.equal(turn.turnRevision, 1);
  const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
  assert.equal(lineage.rootSourceId, turn.sourceMessageId);
  assert.equal(lineage.latestTurnId, turn.turnId);
  assert.equal(lineage.revision, 1);
  assert.equal(lineage.state, 'open');
});

test('retry reuses lineage and sibling retries cannot both replace latest turn', () => {
  const original = createCanonicalV2Turn('turn_original');
  const retry1 = createCanonicalV2Retry(original, 'turn_retry_1');
  assert.equal(retry1.authorityLineageKey, original.authorityLineageKey);
  assert.equal(store.getTurnAuthorityLineage(original.authorityLineageKey).latestTurnId,
    'turn_retry_1');
  assert.throws(
    () => createCanonicalV2Retry(original, 'turn_retry_2'),
    /retry lineage authority conflict/
  );
});
```

`canonicalV2CreateInput()` uses `protocolVersion:2`, `kind:'DIRECT_REPLY'`, and a valid current protocol-v2 user message/context. `createCanonicalV2Retry()` must keep the original canonical message ID/content/sentAt, set `context.retry = {retryOfTurnId, canonicalMessageId}`, and use only a new turn ID/device sequence. The store derives retry lineage and its expected current revision from the validated previous turn; the test must not pass a second `retryOfTurnId` or caller-selected lineage revision outside the envelope.

Also prove all three entry paths:

1. fresh/legacy database runs historical migrations, v10, then v11 in one outer transaction;
2. populated v10 runs only v11;
3. v11 performs invariant checks without rewriting rows, and `user_version > 11` stops unsupported.

The migration CLI test must prove a populated raw v10 source file remains byte-identical in dry-run, its clone becomes v11, and the report records `sourceUserVersion:10`, `workingUserVersion:11`, before/after table counts, source/clone SHA-256, and a checksummed v11 invariant summary. Opening the clone with `YuqiStore` a second time must preserve its logical schema/data checksum and row counts; do not require the physical SQLite file hash to remain fixed across WAL/checkpoint metadata changes.

- [ ] **Step 2: Write red all-or-nothing, state-CAS, retry, and outbox tests**

```js
test('canonical group, projections, action, state, memory, compare, outbox and receipt commit together', () => {
  const result = commitVisibleResult(validCommitInput());
  assert.equal(result.committed, true);
  assert.equal(store.visibleGroupsForLineage(result.authorityLineageKey).length, 1);
  assert.equal(store.visibleItemsForGroup(result.visibleGroupId).length, 2);
  assert.equal(store.actionsForGroup(result.visibleGroupId).length, 1);
  assert.equal(store.getCognitiveState('yuqi').lastAuthorityGroupId, result.visibleGroupId);
  assert.equal(store.memoryJobsForGroup(result.visibleGroupId).length, 1);
  assert.equal(store.comparisonJobsForGroup(result.visibleGroupId).length, 1);
  assert.equal(store.outboxForGroup(result.visibleGroupId).length, 1);
  assert.equal(store.getVisibleCommitReceipt(result.authorityLineageKey).commitChecksum,
    result.commitChecksum);
  assert.equal(store.getInteractionLane('yuqi', 'private_chat').revision, 2);
});

for (const mutation of [
  'new_user_batch_id',
  'visibility_sequence',
  'turn_revision',
  'lineage_revision',
  'lane_revision',
  'cognitive_state_revision',
  'agency_snapshot_checksum',
  'action_target_revision',
  'retry_branch',
  'release_pin',
  'generation_fingerprint'
]) {
  test(`${mutation} conflict rolls back every visible side effect`, () => {
    const input = validCommitInput();
    mutateAuthority(input, mutation);
    assert.throws(() => commitVisibleResult(input), /authority conflict/);
    assert.deepEqual(countCommitSideEffects(store, input.authorityLineageKey),
      allZeroCounts());
  });
}

test('exact repeated commit returns one receipt but changed payload on same lineage conflicts', () => {
  const input = validCommitInput();
  const first = commitVisibleResult(input);
  const second = commitVisibleResult(structuredClone(input));
  assert.equal(second.commitChecksum, first.commitChecksum);
  assert.equal(second.visibleGroupId, first.visibleGroupId);
  assert.equal(store.visibleGroupsForLineage(input.authorityLineageKey).length, 1);
  assert.throws(
    () => commitVisibleResult({ ...input, visibleGroup: changedReply(input.visibleGroup) }),
    /lineage already committed with different checksum/
  );
});

test('original and retry turn IDs cannot create two canonical groups or two deliveries', () => {
  const original = createCanonicalV2Turn('turn_original');
  const retry = createCanonicalV2Retry(original, 'turn_retry');
  assert.throws(() => commitVisibleResult(commitInputFor(original)), /retry branch/);
  const receipt = commitVisibleResult(commitInputFor(retry));
  assert.equal(store.visibleGroupsForLineage(original.authorityLineageKey).length, 1);
  assert.equal(store.outboxForGroup(receipt.visibleGroupId).length, 1);
  assert.equal(store.outboxForTurn(original.turnId).length, 0);
});
```

Inject a forced exception after every individual write/CAS listed in Step 6 and assert that group, messages, actions, state, stance, memory jobs, comparison job, outbox, lane, lineage, turn, and receipt all remain at their pre-transaction values.

- [ ] **Step 3: Run the v11/commit tests red**

Run:

```powershell
node --test yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs
```

Expected: FAIL because v10 currently returns early, canonical authority tables/columns do not exist, and outbox is keyed only by turn.

- [ ] **Step 4: Implement the exact PC v11 schema**

Create these tables:

```sql
CREATE TABLE IF NOT EXISTS turn_authority_lineages (
  lineage_key TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  lane_key TEXT NOT NULL,
  root_source_id TEXT NOT NULL,
  latest_turn_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('open','committed','cancelled')),
  committed_group_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(role_id, lane_key, root_source_id),
  CHECK(
    (state = 'committed' AND committed_group_id IS NOT NULL)
    OR (state IN ('open','cancelled') AND committed_group_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS visible_result_groups (
  group_id TEXT PRIMARY KEY,
  lineage_key TEXT NOT NULL UNIQUE,
  authoritative_turn_id TEXT NOT NULL UNIQUE,
  role_id TEXT NOT NULL,
  lane_key TEXT NOT NULL,
  authority_origin TEXT NOT NULL CHECK(authority_origin IN ('pc','android_fallback')),
  authoritative_release_id TEXT NOT NULL,
  generation_fingerprint TEXT NOT NULL,
  reply_checksum TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  redacted_at INTEGER,
  FOREIGN KEY(lineage_key) REFERENCES turn_authority_lineages(lineage_key),
  FOREIGN KEY(authoritative_turn_id) REFERENCES turns(turn_id)
);

CREATE TABLE IF NOT EXISTS visible_result_items (
  group_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  message_id TEXT NOT NULL UNIQUE,
  item_json TEXT NOT NULL,
  item_checksum TEXT NOT NULL,
  PRIMARY KEY(group_id, ordinal),
  FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
);

CREATE TABLE IF NOT EXISTS visible_result_actions (
  group_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  action_id TEXT NOT NULL UNIQUE,
  action_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_revision TEXT,
  action_json TEXT NOT NULL,
  action_checksum TEXT NOT NULL,
  PRIMARY KEY(group_id, ordinal),
  FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
);

CREATE TABLE IF NOT EXISTS visible_commit_receipts (
  lineage_key TEXT PRIMARY KEY,
  group_id TEXT NOT NULL UNIQUE,
  authoritative_turn_id TEXT NOT NULL UNIQUE,
  authority_origin TEXT NOT NULL CHECK(authority_origin IN ('pc','android_fallback')),
  commit_payload_version TEXT NOT NULL,
  turn_revision_before INTEGER NOT NULL,
  turn_revision_after INTEGER NOT NULL,
  lineage_revision_before INTEGER NOT NULL,
  lineage_revision_after INTEGER NOT NULL,
  lane_revision_before INTEGER,
  lane_revision_after INTEGER,
  cognitive_state_revision_before INTEGER,
  cognitive_state_revision_after INTEGER,
  commit_checksum TEXT NOT NULL UNIQUE,
  committed_at INTEGER NOT NULL,
  FOREIGN KEY(lineage_key) REFERENCES turn_authority_lineages(lineage_key),
  FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id),
  FOREIGN KEY(authoritative_turn_id) REFERENCES turns(turn_id)
);
```

Add columns idempotently with `addColumnIfMissing`:

```text
turns.result_authority_version INTEGER NOT NULL DEFAULT 0
turns.authority_lineage_key TEXT
turns.lineage_revision_at_creation INTEGER
turns.turn_revision INTEGER NOT NULL DEFAULT 0
turns.retry_of_turn_id TEXT
turns.input_user_batch_id TEXT
turns.agency_snapshot_checksum TEXT

messages.authority_group_id TEXT
messages.group_ordinal INTEGER

cognitive_states.last_authority_group_id TEXT

stance_records.authority_group_id TEXT
stance_records.authority_ordinal INTEGER

consolidation_jobs.authority_group_id TEXT
consolidation_jobs.authority_ordinal INTEGER

cloud_deliveries.authority_group_id TEXT
cloud_deliveries.authority_commit_checksum TEXT
```

Create these partial unique indexes:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_authority_group_ordinal
  ON messages(authority_group_id, group_ordinal)
  WHERE authority_group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_stances_authority_group_ordinal
  ON stance_records(authority_group_id, authority_ordinal)
  WHERE authority_group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_consolidation_authority_group_ordinal
  ON consolidation_jobs(authority_group_id, authority_ordinal)
  WHERE authority_group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_authority_group_peer
  ON cloud_deliveries(authority_group_id, peer_id)
  WHERE authority_group_id IS NOT NULL;
```

Do not add `visible_group_id` or `commit_checksum` as competing authority columns on `turns`. `getTurn()` may expose receipt-derived projection fields by joining `visible_commit_receipts`, but persisted truth remains the receipt. `reply_json` remains a legacy/read-optimization projection only.

- [ ] **Step 5: Implement v10→v11 migration, invariant checks, and lineage creation**

Refactor `migrate()` to one ordered version ladder:

```js
const initialVersion = this.userVersion();
if (initialVersion > 11) throw unsupportedVersion(initialVersion);
if (initialVersion === 11) {
  this.assertAgencyV10Invariants();
  this.assertVisibleAuthorityV11Invariants();
  return;
}
this.withImmediateTransaction(() => {
  if (initialVersion < 9) migrateHistoricalToV9Internal();
  if (initialVersion < 10) migrateAgencyV10Internal();
  if (initialVersion < 11) migrateVisibleAuthorityV11Internal();
  assertAgencyV10Invariants({ allowPreFinalVersion: true });
  assertVisibleAuthorityV11Invariants({ allowVersionTen: true });
  this.db.exec('PRAGMA user_version = 11');
});
```

`migrateVisibleAuthorityV11Internal()` leaves every pre-existing turn at `result_authority_version=0` with null lineage fields. It does not infer a canonical group from `reply_json`, messages, delivery rows, timestamps, or the most recent retry. Those old turns remain on their pinned legacy recovery/outbox branch. Only a turn created after the v11 schema is available may set `result_authority_version=1`.

`assertVisibleAuthorityV11Invariants()` must prove:

- every authority-version-1 turn has non-null lineage key, positive turn revision, input batch identity, release pin, lane, and agency checksum;
- every lineage latest turn exists, belongs to the same role/lane/root source, and points back to that lineage;
- every committed lineage joins exactly one group and one receipt;
- every group joins the same lineage, authoritative turn, role, lane, release, and authority origin as its receipt;
- every receipt uses the payload version allowed for its origin;
- every committed version-1 PC turn has a non-null generation fingerprint equal to its visible group; every uncommitted version-1 turn keeps that field null;
- every receipt's turn/lineage revisions increment exactly once; `pc` receipts also require lane before/after to increment once, while imported fallback receipts keep both lane fields null;
- every result-authority-version-1 delivery joins the receipt group and carries the same authority commit checksum;
- every `pc` receipt has its required peer deliveries, while every imported `android_fallback` receipt has none;
- no authority-version-0 turn is silently attached to a canonical lineage or receipt.

Update `migrate-yuqi-agency-state.mjs` so it reads source `PRAGMA user_version` before constructing `YuqiStore`, migrates only `--clone-out` during dry-run, and materializes the v11 invariant summary in the report. `--apply --expect-report` must compare the raw source SHA/version and structural counts from the approved report before opening/migrating production; a changed source stops before mutation. The verified raw backup remains the rollback artifact.

Keep `submitTurn()`, `createTurnWithRolloutInternal()`, and
`createTurnWithReleasePinInternal()` unchanged as compatibility entry points. Even on
schema v11 they return their existing plain turn shape and create only
`result_authority_version=0` rows with null lineage fields.

Add this separate store-owned boundary:

```text
createCanonicalVisibleTurnInternal({
  envelope,
  rolloutKey,
  expectedRolloutRevision,
  authoritativeReleaseId,
  comparisonReleaseId,
  comparisonDirection,
  laneKey,
  expectedLaneRevision,
  inputUserBatchId,
  inputVisibilitySequence,
  agencySnapshotChecksum,
  annotationSnapshot
}) ->
{ status: 'created', turn, agencySnapshot }
{ status: 'already_committed', receipt }
{ status: 'redacted', receipt: receipt | null, lineage }
```

The method call itself—not `envelope.protocolVersion`, an `authority` object, or a
caller-supplied numeric flag—is the sole selector for
`result_authority_version=1`. Reject an input that attempts to supply
`resultAuthorityVersion`, `authorityContractVersion`, `authorityLineageKey`,
`lineageRevisionAtCreation`, or `turnRevision`. Task 10 must not widen
`validateEnvelope()` to accept protocol v3; its fixtures use a currently valid,
normalized protocol-v2 envelope. Task 13 later makes a validated protocol-v3
envelope another input format to this same method.

Do not implement this by calling a compatibility creator and patching its row.
Refactor a private turn-insert primitive if needed, but canonical turn creation,
first lineage insert/replacement, and lane claim must occur in one immediate
transaction. Derive:

```js
rootSourceId = envelope.context?.retry?.canonicalMessageId
  ?? envelope.message?.messageId
  ?? envelope.trigger?.triggerId;
lineageKey = deriveAuthorityLineageKey({
  roleId: envelope.characterId, laneKey, rootSourceId
});
```

For a fresh non-retry creation, inside that same transaction reload the rollout
row, require `revision === expectedRolloutRevision`, independently resolve its
visible and comparison release pair, and require exact equality with the three
supplied release fields. Then load the immutable release rows and pin their
checksums and the authoritative release's preset version. These caller fields
are optimistic CAS expectations from `PromotionController`, not permission to
choose a release. A concurrent promotion or rollback fails before inserting a
turn, lineage, message, or lane mutation.

For a retry, the only retry identity is the already-validated
`envelope.context.retry.retryOfTurnId` plus its `canonicalMessageId`; no duplicate
`retryOfTurnId`, lineage key, or expected lineage revision is accepted outside
the envelope. Load that prior turn, verify the canonical message
ID/content/`sentAt` against the original source batch, derive the same lineage,
and require the prior turn to be the open lineage's current `latestTurnId`. Read
the lineage's current revision inside the same immediate transaction, insert the
retry turn pointing to the same lineage, and CAS `latest_turn_id/revision` from
that observed row. A committed lineage returns
`{status:'already_committed', receipt}` without creating or claiming a new turn.
A stale or sibling retry loses the CAS and reports a retry-lineage authority
conflict. Persist `input_user_batch_id`, current visibility sequence, release
pins, lane revision, derived preset/annotation pins, and the normalized agency
snapshot checksum on the new turn. `generation_fingerprint` remains null until
the canonical visible result transaction because it depends on the authorized
visible draft and action set, which do not exist at turn creation.

A version-1 retry inherits `rolloutRevision`, authoritative/comparison release
IDs and checksums, comparison direction, and preset version from the prior turn;
it does not adopt the rollout table's current pair after a promotion, graduation,
or rollback. Its caller supplies those inherited values as expectations and the
store compares them with the prior turn and immutable release rows. A retry whose
prior turn is version 0 stays on the compatibility creator/recovery path. A
retry whose prior turn is missing or whose authority version/lineage fields are
inconsistent is rejected as an invariant conflict; Task 10 must not synthesize a
new canonical lineage from a partial legacy record.

After validating the normalized envelope against stored source identity, handle
idempotency before fresh authority claims: an exact replay of the same
uncommitted canonical `turnId + envelopeChecksum` returns
`{status:'created', turn}` without incrementing rollout, lane, lineage, or turn
revision; a committed lineage returns its joined receipt even if the rollout has
since changed. Any changed envelope under the same turn/lineage conflicts.

`inputVisibilitySequence` is required to be a non-negative safe integer. For the
current protocol-v2 input, which has no visibility cursor, Task 11 supplies the
persisted lane's `localSequence` snapshot. Once Task 13 accepts protocol v3, it
supplies the validated `context.visibilityCursor.localSequence`; canonical
creation rejects it if it is behind the persisted lane and atomically advances
the lane to it if it is ahead. The turn always stores the resulting exact lane
sequence. Do not synthesize a v3 cursor inside Task 10 or trust an unvalidated
wire value.

Add explicit negative tests proving that a protocol-v2 envelope passed through
an old creation API remains version 0; a protocol-v2 envelope passed through
`createCanonicalVisibleTurnInternal()` becomes version 1; injecting a wire
`resultAuthorityVersion` or external retry/revision selector cannot upgrade or
replace authority; a rollout revision/release-pair race leaves no turn, message,
lineage, or lane mutation; and protocol v2 without a cursor uses a non-zero
persisted lane sequence exactly. Task 10 does not alter protocol-v3 acceptance:
the existing protocol baseline remains red for v3 at this checkpoint and Task 13
intentionally replaces that protocol expectation. Do not put a permanent
“protocol v3 must fail” assertion in the v11 store test.

Also test that an exact open-turn replay is mutation-free, an exact committed
replay returns the original receipt after rollout change, a version-1 retry
inherits its parent's release pair after rollout change, and a retry of a
version-0 or missing parent cannot enter canonical creation.

All authority-changing writes for result-authority-version-1 turns use:

```sql
UPDATE turns
SET ..., turn_revision = turn_revision + 1
WHERE turn_id = ? AND turn_revision = ?;
```

Zero affected rows is an authority conflict. `updated_at` is never a CAS token.

A retryable/final model failure CAS-updates the turn but leaves its lineage `open` and latest so an explicit retry can replace it. User deletion/cancellation and lane supersession CAS the still-open lineage to `cancelled`; cancelled lineages can never commit or be retried implicitly. A committed lineage is immutable. Recovery tests cover all three states.

- [ ] **Step 6: Implement the one canonical commit transaction**

The canonical commit payload must be stable-key ordered and include lineage, origin/payload version, ordered visible items/actions, state patch, memory jobs, optional comparison release/direction, release pin, input batch/cursor identity, generation fingerprint, and agency/state authority checksums. It excludes attempt-only/non-semantic values such as timestamps, random IDs, worker IDs, diagnostics, and raw model traces.

Identity algorithm `al-authority-v1` is cross-platform and must not depend on JSON object iteration order. Define `lp(value)` as the decimal UTF-8 byte length, one colon, then the exact UTF-8 string. Lower-case hexadecimal SHA-256 is used:

```js
lineageKey = 'lin_' + sha256(
  'al-turn-lineage-v1\0' + lp(roleId) + lp(laneKey) + lp(rootSourceId)
);
groupId = 'grp_' + sha256(
  'al-visible-group-v1\0' + lp(lineageKey)
);
messageId = ordinal => 'msg_' + sha256(
  'al-visible-message-v1\0' + lp(groupId) + lp(String(ordinal))
);
actionId = ordinal => 'act_' + sha256(
  'al-visible-action-v1\0' + lp(groupId) + lp(String(ordinal))
);
```

`tests/fixtures/authority-identity-v1.json` contains ASCII, Chinese, emoji, colon, empty-string, and large-ordinal vectors with exact expected IDs. Node must pass these vectors now; Task 13 reuses the same file from Java. Changing the algorithm requires a new named version, never silent replacement.

Implement:

```js
export function commitVisibleResult(input) {
  const canonicalPayload = canonicalCommitPayload({
    ...input,
    authorityOrigin: 'pc',
    commitPayloadVersion: 'pc-visible-commit-v1'
  });
  const commitChecksum = contentHash(canonicalPayload);
  return input.store.withImmediateTransaction(() => {
    const existing = input.store.getVisibleCommitReceipt(input.authorityLineageKey);
    if (existing) {
      assert.equal(existing.authorityOrigin, 'pc',
        'lineage already committed by a different authority origin');
      assert.equal(existing.commitPayloadVersion, 'pc-visible-commit-v1',
        'lineage receipt payload version conflict');
      assert.equal(existing.commitChecksum, commitChecksum,
        'lineage already committed with different checksum');
      return existing;
    }

    const authority = input.store.readCommitAuthority({
      turnId: input.turnId,
      authorityLineageKey: input.authorityLineageKey,
      laneKey: input.laneKey
    });
    assertResultAuthorityVersion(authority, 1);
    assertTurnRevision(authority, input.expectedTurnRevision);
    assertLineageLatestOpen(authority, input.expectedLineageRevision, input.turnId);
    assertLaneRevision(authority, input.expectedLaneRevision);
    assertNoNewerUserBatch(authority, {
      expectedLatestUserBatchId: input.expectedLatestUserBatchId,
      inputVisibilitySequence: input.inputVisibilitySequence
    });
    assertCognitiveStateRevision(authority, input.expectedCognitiveStateRevision);
    assertAgencySnapshotChecksum(authority, input.agencySnapshotChecksum);
    assertReleasePin(authority, input.authoritativeReleaseId);
    assertActionTargets(authority, input.actionSet);
    assert.equal(authority.turn.generationFingerprint, null,
      'an uncommitted turn cannot pre-own an output fingerprint');
    assert.equal(input.generationFingerprint, generationFingerprint({
      roleId: authority.turn.characterId,
      laneKey: authority.turn.laneKey,
      laneRevision: authority.turn.laneRevision,
      inputVisibilitySequence: authority.turn.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet,
      contextRevision: input.agencySnapshotChecksum
    }), 'generation fingerprint mismatch');

    return input.store.commitVisibleResultInternal({
      ...input,
      authorityOrigin: 'pc',
      commitPayloadVersion: 'pc-visible-commit-v1',
      groupId: deriveVisibleGroupId(input.authorityLineageKey),
      statePatch: validateStatePatchAgainstAgency(input.statePatch, authority),
      commitChecksum
    });
  });
}
```

`commitVisibleResultInternal()` performs this exact write order inside the already-open transaction:

1. insert `visible_result_groups`;
2. insert deterministic `visible_result_items`;
3. insert deterministic `visible_result_actions`;
4. insert `messages` projections with `authority_group_id + group_ordinal`;
5. update `cognitive_states` using the expected state revision and `last_authority_group_id`;
6. insert stance revisions with `authority_group_id + authority_ordinal`;
7. insert consolidation/evidence-memory jobs with `authority_group_id + authority_ordinal`;
8. insert the optional dry-run comparison job using the group/commit authority; comparison creation is part of this transaction, not a later call;
9. insert one delivery per peer with `authority_group_id + peer_id` and `authority_commit_checksum`;
10. CAS the lane from expected revision to `revision + 1`, setting latest authoritative group/checksum;
11. CAS the lineage from open/latest/current revision to committed/group/`revision + 1`;
12. CAS the turn from expected revision to committed/`turnRevision + 1`, setting its generation fingerprint to the exact fingerprint stored on the group;
13. insert `visible_commit_receipts` with every before/after revision and return it.

Although the receipt row is inserted last, the whole SQLite transaction is the authority boundary. Any exception rolls back all thirteen steps. `commitVisibleResult()` always records authority origin `pc`; the later Android fallback task may import an already-visible external receipt through a separate validation-only path, never by pretending it was a PC cognition commit. Shadow/comparison execution may write only comparison/quality rows; it never calls this function, an action store, outbox, notification, state, facts, or memory consolidation.

- [ ] **Step 7: Convert only result-authority-version-1 outbox operations to group authority**

Keep legacy rows and public compatibility methods for result-authority-version-0 turns. For rows with `authority_group_id`:

- list/lease/retry/confirm/recover by `authority_group_id + peer_id`;
- load payload by joining `visible_commit_receipts → visible_result_groups/items/actions`;
- use `${authorityGroupId}:${peerId}:${authorityCommitChecksum}` as the idempotency key;
- reject a delivery whose turn, group, lineage, or checksum does not join the same receipt;
- never reconstruct a group from `turn.reply_json`;
- return delivery receipt fields verbatim to the bridge.

Add a restart test where original and retry turn IDs both exist, only the retry owns the committed lineage, and `ResultOutbox` emits exactly one group after multiple process restarts.

- [ ] **Step 8: Run commit/outbox/store tests green**

Run:

```powershell
node --test yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/protocol-store.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: PASS; populated v10 is preserved and becomes v11; exact retry returns one receipt; stale/sibling retry fails; every forced failure leaves no partial authority; old version-0 delivery remains readable; version-1 authority emits one canonical group even though Task 10 fixtures still use wire protocol v2.

- [ ] **Step 9: Commit**

```powershell
git add yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/result-outbox.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs tests/fixtures/authority-identity-v1.json scripts/migrate-yuqi-agency-state.mjs tests/yuqi-agency-state-migration.test.mjs
git commit -m "feat: add canonical Yuqi result authority"
```

### Task 10A: Close v11 Restart Invariants and Migration CLI Safety

**Why this repair gate exists:** Commit `b4715fb` passed its 105-test focused
suite, but two independent counterexamples still succeed: a dry-run without a
clone changes a source database from `user_version=0` to 11, and a version-1
turn pointing at a nonexistent lineage survives close/reopen. Task 11 is
forbidden until Tasks 10A–10C are green and committed.

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `scripts/migrate-yuqi-agency-state.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Modify: `tests/yuqi-agency-state-migration.test.mjs`

**Interfaces:**
- Consumes: Task 10 schema v11 and its existing raw-v10 clone report.
- Produces: exhaustive `assertVisibleAuthorityV11Invariants()`; a migration CLI
  that cannot open a source in write mode during dry-run and cannot apply
  without an approved report; `YuqiStore.openForMigration(path, {
  expectedSourceVersion, expectedPostMigrationInvariantChecksum })` as the only
  apply-mode entry that can compare the post-migration summary before commit.

- [ ] **Step 1: Add red corruption-matrix and CLI no-mutation tests**

Add direct database corruptions that are legal at the SQLite column level but
must make the next `new YuqiStore(path)` throw:

```js
for (const [name, corrupt] of [
  ['version-1 turn has no lineage row', db =>
    db.prepare('DELETE FROM turn_authority_lineages').run()],
  ['lineage latest turn root/role/lane does not join', mutateLineageIdentity],
  ['committed group does not join receipt turn/release/origin', mutateGroupReceiptJoin],
  ['receipt payload version does not match origin', mutateReceiptPayloadVersion],
  ['committed turn/group fingerprints differ', mutateGroupFingerprint],
  ['uncommitted version-1 turn already has fingerprint', seedOpenTurnFingerprint],
  ['turn lineage and lane revision deltas are not exactly one', mutateReceiptDeltas],
  ['PC receipt has no canonical delivery', deletePcDelivery],
  ['delivery checksum differs from receipt', mutateDeliveryChecksum],
  ['version-0 turn is attached to canonical lineage/group', attachLegacyTurn]
]) {
  test(`v11 reopen rejects ${name}`, () => withCommittedV11(path => {
    corrupt(openRaw(path));
    assert.throws(() => new YuqiStore(path), /v11 invariant/i);
  }));
}
```

Add CLI process tests:

```js
test('dry-run without a different clone refuses before opening source', () => {
  const before = rawSnapshot(source);
  const result = runMigration(['--database', source, '--dry-run']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dry-run requires --clone-out/i);
  assert.deepEqual(rawSnapshot(source), before);
});

test('apply without an approved report refuses before opening source', () => {
  const before = rawSnapshot(source);
  const result = runMigration(['--database', source, '--apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /apply requires --expect-report/i);
  assert.deepEqual(rawSnapshot(source), before);
});
```

The dry-run test must cover both `--database` and `--config`. Also prove
`resolve(cloneOut) === resolve(source)` is rejected.

- [ ] **Step 2: Run the new tests red**

Run:

```powershell
node --test yuqi-runtime/test/store-visible-authority-v11.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: FAIL because the current invariant accepts orphan/cross-joined rows and
the current CLI mutates an explicit `--database` dry-run source.

- [ ] **Step 3: Implement exhaustive restart queries and pre-open CLI gates**

`assertVisibleAuthorityV11Invariants()` must fail on every condition listed in
Task 10 Step 5, not merely missing tables. Use one helper per invariant:

```js
function assertNoInvariantRow(db, code, sql) {
  const row = db.prepare(sql).get();
  if (row) throw new Error(`v11 invariant ${code}: ${JSON.stringify(row)}`);
}
```

The query set must prove both directions of every join:

- each version-1 turn joins exactly one lineage with the same role/lane/root
  identity; the lineage's `latestTurnId` exists, points back to that lineage,
  and is the sole current owner (older attempts may remain joined but are not
  latest);
- each committed lineage joins exactly one group and receipt; open/cancelled
  lineages join none;
- group, receipt, turn and lineage agree on IDs, role, lane, release and origin;
- `pc → pc-visible-commit-v1` and
  `android_fallback → android-fallback-commit-v1`;
- every uncommitted/cancelled PC turn has null fingerprint; committed PC turn
  and group fingerprints are equal and non-null;
- receipt before/after turn and lineage revisions differ by exactly one; PC lane
  revisions differ by one; cognitive-state before/after revisions are either
  equal (no patch) or differ by one (validated patch); imported fallback lane
  and cognitive-state revisions are null;
- canonical delivery joins the same group/turn/peer/checksum; every PC receipt
  has its required peer delivery; fallback receipt has no PC delivery;
- no version-0 turn has lineage/group/receipt authority fields.

Place these CLI gates before `rawDatabaseSnapshot()` is followed by any
`YuqiStore` construction:

```js
if (dryRun && (!cloneOut || resolve(cloneOut) === sourceDatabase)) {
  throw new Error('dry-run requires --clone-out different from source');
}
if (apply && !expectedPath) {
  throw new Error('apply requires --expect-report');
}
```

On apply, compare the raw source SHA, `user_version`, and structural counts from
the approved report before constructing `YuqiStore`. A mismatch stops before
mutation. The v11 invariant summary is computed inside the migration transaction
and must equal the clone report before that transaction commits; it cannot be
pretended to exist on the still-v10 source. Implement this through
`YuqiStore.openForMigration(...)`; do not construct the ordinary auto-migrating
store and compare only after it has already committed.

- [ ] **Step 4: Run migration/invariant suites green**

Run the Step 2 command plus:

```powershell
node --test yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs
```

Expected: PASS, including byte-identical source evidence for every refused
command and every corruption rejected on reopen.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/store.mjs scripts/migrate-yuqi-agency-state.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs tests/yuqi-agency-state-migration.test.mjs
git commit -m "fix: enforce v11 authority and migration invariants"
```

### Task 10B: Seal Canonical Creation and Every Version-1 Turn Mutation

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Modify: `yuqi-runtime/test/store-agency-v10.test.mjs`
- Create: `yuqi-runtime/test/canonical-turn-state.test.mjs`

**Interfaces:**
- Consumes: normalized protocol-v2 envelope, Task 9 lane derivation and Task 10
  lineage/release pins.
- Produces:

```text
claimCanonicalTurnInternal({ turnId, workerId, expectedTurnRevision }) -> turn
advanceCanonicalTurnInternal({
  turnId, expectedState, nextState, expectedTurnRevision, patch
}) -> turn
recordCanonicalTurnFailureInternal({
  turnId, expectedState, expectedTurnRevision, failure
}) -> turn
requeueCanonicalFailedTurnInternal({
  turnId, expectedTurnRevision, allowedFailureClass
}) -> turn
cancelCanonicalTurnInternal({
  turnId, authorityLineageKey, expectedTurnRevision,
  expectedLineageRevision, reasonCode
}) -> { turn, lineage }
```

- [ ] **Step 1: Add red creation-authority and mutation-closure tests**

Creation tests must prove zero side effects for:

```js
[
  input => { input.envelope.characterId = 'other_role'; },
  input => { input.rolloutKey = 'PROACTIVE_CHAT'; },       // envelope is DIRECT_REPLY
  input => { input.laneKey = 'public_moment'; },
  input => { input.inputUserBatchId = 'batch_forged'; },
  input => { input.inputVisibilitySequence += 1; }         // v2 has no cursor
]
```

Add retry tests that change an earlier current-batch bubble, attachment,
message ordering or batch ID while preserving the final message; every case
must fail before turn/lineage/lane mutation. A committed retry first validates
the normalized envelope checksum, complete batch and derived lineage against
the stored interaction, then returns the receipt before evaluating mutable
lane/rollout/agency claims. It must not disclose an unrelated lineage receipt
merely because a caller supplied its root ID.

Add canary reservation tests: two fresh accepted canary turns receive distinct
slots, `canary_started_count` increments transactionally, rollout CAS losers
write nothing, and `canary_max_outstanding` cannot be exceeded. An exact replay
and version-1 retry consume no new slot. Outstanding is the rollout-owned value
`canary_started_count - canary_completed_count - canary_failure_count`, not a
count of comparison rows that do not exist until after an authoritative result
commits. This Task 10 primitive predates release-pair selection; Task 11 later
gates it to the first ten comparison-bearing subjects and adds the target cap.

Add mutation closure:

```js
test('legacy mutation APIs cannot write a canonical turn', () => {
  const turn = canonicalOpenTurn();
  for (const call of [
    () => store.claimTurnById(turn.turnId, 'worker'),
    () => store.advanceTurn(turn.turnId, 'queued', 'memory_running'),
    () => store.recoverFailedDraft(turn.turnId),
    () => store.requeueTransientFailedTurn(turn.turnId)
  ]) assert.throws(call, /canonical turn API required/i);
});

test('stale canonical revision cannot claim checkpoint fail requeue or cancel', () => {
  const claimed = store.claimCanonicalTurnInternal({
    turnId, workerId: 'worker', expectedTurnRevision: 1
  });
  assert.equal(claimed.turnRevision, 2);
  assertEveryCanonicalMutationRejectsRevision(1);
});
```

Superseding a version-1 proactive turn must atomically increment its turn
revision, mark its open lineage `cancelled`, and make a later commit/retry fail.
A model failure increments turn revision but leaves lineage `open/latest`, so
one explicit retry may replace it.

- [ ] **Step 2: Run state-boundary tests red**

Run:

```powershell
node --test yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs
```

Expected: FAIL because `b4715fb` trusts caller route/batch fields, does not
reserve canary counters, and legacy state/supersession APIs mutate version-1
turns without turn/lineage CAS.

- [ ] **Step 3: Make store derive identity and close old mutation paths**

Inside `createCanonicalVisibleTurnInternal()` independently require:

```js
assert.equal(envelope.characterId, 'yuqi');
assert.equal(input.rolloutKey, envelope.kind);
assert.equal(input.laneKey, laneKeyForEnvelope(envelope));
assert.equal(input.inputUserBatchId,
  envelope.context?.currentBatch?.batchId
    ?? envelope.message?.messageId
    ?? envelope.trigger?.triggerId);
```

For protocol v2, require `inputVisibilitySequence === lane.localSequence`.
Protocol v3 monotonic advancement remains unreachable until Task 13 validates
its cursor. Retry compares the complete normalized parent/current batch and
message attachment structure by canonical hash.

At this Task 10 boundary, fresh shadow/canary creation validates rollout state
in the same immediate transaction. Canary checks current outstanding work,
increments `canary_started_count`, assigns one unique slot, and increments
rollout revision. Retry inherits the parent slot and release pair without
another reservation. A shadow creation verifies the pinned rollout
revision/release pair under the same immediate transaction but does not
increment canary counters. Task 11 replaces Task 10's temporary all-canary phase
switch with the shared resolver and makes the reservation conditional on a
non-null comparison release, so the final behavior stops at ten.

Every produced method above performs:

```sql
UPDATE turns
SET ..., turn_revision = turn_revision + 1
WHERE turn_id = ?
  AND result_authority_version = 1
  AND state = ?
  AND turn_revision = ?;
```

Zero rows is an authority conflict. `claimTurn()` skips version-1 rows;
`claimTurnById()`, `advanceTurn()`, failed-draft recovery and legacy requeue
throw before writing when `resultAuthorityVersion=1`. Version-0 behavior and
tests remain unchanged. `admitInteractionTurnInternal()` uses
`cancelCanonicalTurnInternal()` for a version-1 superseded owner in the same
outer transaction.

- [ ] **Step 4: Run state and legacy compatibility suites green**

Run Step 2 plus:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs
```

Expected: PASS; all canonical revisions are explicit and legacy turns retain
their existing state machine.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/store.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs
git commit -m "fix: close canonical turn mutation authority"
```

### Task 10C: Make Commit Checksums Semantic and Isolate the Group Outbox

**Files:**
- Modify: `yuqi-runtime/src/agency-state.mjs`
- Modify: `yuqi-runtime/src/interaction-lanes.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `yuqi-runtime/test/agency-state.test.mjs`
- Modify: `yuqi-runtime/test/interaction-lanes.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`

**Interfaces:**
- Consumes: current agency authority heads, authorized state patch, pinned
  comparison release/direction and store-owned action-target revisions.
- Produces:

```text
store.readAgencyAuthoritySnapshotInternal({ roleId, at }) -> {
  version, roleId, constraints, preferenceFacts, stances,
  cognitiveState: { revision, checksum }, checksum
}
validateStatePatchAgainstAgency({
  patch, turn, cognitiveState, activeStances, currentBatch, evidenceIndex,
  effectiveAt
}) -> { semanticPatch, nextState, stanceRevisionRows }
store.resolveCanonicalActionTargetInternal({ turn, action }) ->
  { targetKey, targetRevision, authoritySource }
```

It also produces a semantic `pc-visible-commit-v1` checksum, default-deny
action/state validation, and canonical-only group delivery methods with legacy
isolation.

- [ ] **Step 1: Add red semantic-authority tests**

Add tests proving:

1. `readAgencyAuthoritySnapshotInternal()` is stable under row/order changes,
   contains every active constraint/stance head plus every cognitive-state
   referenced verified `stable_preference` fact, and rejects a referenced fact
   that is missing, suppressed, unverified or the wrong type;
2. canonical creation recomputes that snapshot inside its transaction, rejects
   a forged caller checksum with zero side effects, persists the computed
   checksum, and returns the exact snapshot used by the model;
3. changing an active constraint/stance/preference-evidence head or cognitive
   state after creation invalidates an uncommitted result even when the caller
   repeats the stored checksum; an open-turn recovery reports
   `AGENCY_AUTHORITY_STALE`, while a committed exact replay still returns its
   receipt;
4. a state patch containing `hardConstraints`, new preference evidence,
   foreign-role state, `slowState`, `mediumState`, an extra top-level key, stale
   evidence, or an unsupported stance transition produces zero side effects;
5. maintain/strengthen/soften/reverse append `revision+1` under the same
   `stanceId`, expire appends a terminal head, create alone introduces a new
   `stanceId`, and a reopened store returns only the latest active head;
6. state commit supports both absent cognitive state (`0 → 1` insert) and an
   existing state (`N → N+1` CAS), preserves slow/medium/body/attention, and can
   change only fast mood/open-thread IDs plus validated stance heads;
7. unknown action target kinds and stale revisions are rejected. Supported
   resolvers cover conversation lane, current-batch message/payment, persisted
   moment/comment/role-plan/occurrence input snapshots, PC life episode, current
   relationship snapshot, and lineage-scoped create actions;
8. a required shadow/canary compare job cannot be missing and must match the
   turn's comparison release/direction; a stable turn rejects an injected job;
9. canonical generation fingerprints use stable input visibility sequence rather
   than retry-varying lane claim revision; changing only `turnId` or lane claim
   revision keeps the fingerprint, while changing visibility sequence changes it;
10. two retry attempts with the same semantic visible result, action/state/memory
   descriptors and release pins produce the same canonical checksum even when
   top-level or nested job `turnId`, job IDs, due times, worker IDs and
   timestamps differ;
11. changing any semantic field changes the checksum;
12. item/action JSON containing forged `messageId`, `actionId`, `ordinal`,
   `targetKey` or `targetRevision` cannot override deterministic projection
   fields;
13. every legacy `prepare/mark/confirm/recover` helper rejects a row whose
   `authority_group_id` is non-null without mutation.

- [ ] **Step 2: Run commit/outbox tests red**

Run:

```powershell
node --test yuqi-runtime/test/agency-state.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs
```

Expected: FAIL because the current checksum includes attempt `turnId` and raw
job objects, current agency heads are neither constructed nor recomputed,
stance revisions do not form a persistable stable-ID head chain, state patches
are not validated, and legacy delivery methods can still address canonical rows
by turn ID.

- [ ] **Step 3: Canonicalize only semantic fields and revalidate store authority**

`canonicalCommitPayload()` must use this shape:

```js
{
  payloadVersion: 'pc-visible-commit-v1',
  authorityOrigin: 'pc',
  authorityLineageKey,
  laneKey,
  input: { userBatchId, visibilitySequence },
  agency: { snapshotChecksum, cognitiveStateRevision },
  releases: {
    authoritativeReleaseId,
    comparisonReleaseId,
    comparisonDirection
  },
  generationFingerprint,
  visibleItems: normalizedItemsWithoutCallerIdentity,
  actions: canonicalActionDescriptors,
  statePatch: normalizedCognitionV3StateIntent,
  memoryJobs: canonicalMemoryJobDescriptors,
  comparison: comparisonJob
    ? {
        jobType, comparisonReleaseId, comparisonDirection,
        rolloutEvidenceEpoch, shadowEpoch, canaryEpoch, canarySlot,
        annotationSnapshotChecksum, inputChecksum
      }
    : null
}
```

It excludes attempt `turnId`, job IDs, due/created times, worker, diagnostics and
raw traces, including those fields when nested in a job payload. The receipt
separately retains `authoritativeTurnId`. `canonicalMemoryJobDescriptors` is a
job-type allowlist, not `{...rawPayload}`: for `turn_consolidation` it contains
only `jobType`, `cognitionPacketChecksum`, `resultingCognitiveStateChecksum` and
the already-canonical lineage identity. Unknown memory/compare job types fail.

Commit ordering is exact:

1. default-deny normalize visible items, actions, cognition-v3 state intent,
   memory descriptors and comparison descriptor without reading mutable current
   state;
2. compute the semantic checksum;
3. if a receipt already exists, require exact origin/payload-version/checksum
   and return it without revalidating mutable agency/rollout/lane state;
4. otherwise load current authority, recompute the store-owned agency snapshot,
   resolve action targets, derive the authorized state rows, validate comparison
   pins, then execute the thirteen-write transaction.

This ordering preserves idempotent receipt replay after the first commit has
legitimately changed cognitive state, while still denying stale authority for a
new commit.

Before a new commit writes:

- construct `agency-authority-v1` by canonicalizing all active constraint heads,
  active stable-ID stance heads, the cognitive state's referenced
  `stable_preference` fact rows, and cognitive-state revision/checksum. Sort by
  stable ID/revision and exclude only non-semantic DB bookkeeping;
- `preferenceFromStableFact(fact)` requires `fact.type ===
  'stable_preference'`, `status === 'verified'`, and nonempty evidence; it maps
  `preferenceId=factId`, `topic=fact.topic ?? fact.predicate`,
  `value=fact.value ?? fact.object`, `weight=fact.weight ?? fact.confidence`,
  and source message IDs, then forces `binding:false`;
- recompute that snapshot during canonical creation and commit. The caller
  checksum is only an optimistic expectation; the store-computed value is the
  persisted authority. `createCanonicalVisibleTurnInternal()` returns the
  computed snapshot with its turn;
- run `validateStatePatchAgainstAgency()` against the exact raw cognition-v3
  shape `{mood,currentStances,openThreads}`. Derive `effectiveAt` from the
  canonical root input batch/trigger timestamp, not retry time or caller
  `now`; clone the current schema-v2 state, preserve slow/medium and
  fast body/attention, replace only fast mood/open-thread IDs, and use
  `applyStanceTransitions()` to produce append-only stable-ID next revisions;
- if cognitive state is absent and a patch exists, insert revision 1 with
  `lastAuthorityGroupId`; otherwise CAS `N → N+1`. If no patch exists, leave
  the revision unchanged;
- resolve every action target through this closed registry:
  `conversation`, `message/payment`, `moment/comment`,
  `role_plan/role_occurrence`, `life_episode`, `relationship`, and
  `lineage_create`. Database-owned targets use their current row revision or
  checksum. Android-owned targets use the exact persisted validated envelope
  snapshot revision/checksum, and the Android consumer must perform the final
  local CAS. Unknown namespaces or missing targets fail;
- validate compare presence/release/direction against the pinned turn;
- strip/reject caller identity fields from visible items/actions.

At the Task 10 checkpoint, comparison validation uses the then-persisted turn
descriptor to pair shadow work with `shadow_cognition` and canary work with
`active_canary_compare`; the job's comparison release, rollout evidence epoch,
shadow/canary epoch and canary slot must equal the turn's pins.
`annotationSnapshotChecksum` is recomputed from the turn's stored annotation
snapshot, and `inputChecksum` from its normalized envelope plus pinned
release/checksum fields. The caller cannot provide alternative epoch/input
evidence. Task 11 deliberately replaces this transitional descriptor mapping
with the shared three-domain `comparison-contract.mjs`: final fresh version-1
turn rows persist compatibility mode, while canonical commit/job descriptors
persist the release-aware direction. Historical version-0 aliases remain only
in the legacy worker branch.

The agency snapshot descriptor is exact:

```js
{
  version: 'agency-authority-v1',
  roleId,
  constraints: activeConstraints.map(x => ({
    constraintId: x.constraintId, revision: x.revision,
    authority: x.authority, kind: x.kind, subject: x.subject,
    scope: x.scope, rule: x.rule, sourceMessageIds: x.sourceMessageIds,
    sourceConfigRef: x.sourceConfigRef, releaseCondition: x.releaseCondition,
    status: x.status, supersedes: x.supersedes
  })).sort(byIdRevision),
  preferenceFacts: resolvedPreferenceFacts.map(x => ({
    factId: x.factId, type: x.type, subjectId: x.subjectId,
    predicate: x.predicate, object: x.object,
    sourceMessageIds: x.sourceMessageIds, status: x.status,
    confidence: x.confidence, supersedes: x.supersedes,
    checksum: x.checksum
  })).sort(byFactId),
  stances: activeStances.map(x => ({
    stanceId: x.stanceId, revision: x.revision, topic: x.topic,
    position: x.position, reason: x.reason, strength: x.strength,
    flexibility: x.flexibility, sourceMessageIds: x.sourceMessageIds,
    lastConfirmedAt: x.lastConfirmedAt, expiresAt: x.expiresAt,
    remainingRelevantUserBatches: x.remainingRelevantUserBatches,
    status: x.status, supersedes: x.supersedes
  })).sort(byIdRevision),
  cognitiveState: {
    revision: cognitiveState?.revision ?? 0,
    checksum: cognitiveState?.checksum ?? null
  }
}
```

`createdAt`, `updatedAt`, DB row order and prior `sourceTurnId` are excluded;
evidence IDs, expiry and remaining-batch budget are semantic and included. Its
`checksum` is `contentHash(descriptor)` and is returned alongside, not embedded
inside itself.

`normalizedItemsWithoutCallerIdentity` is a default-deny map of
`content`, `speakerId`, `speakerType`, `recipientId`, `contentType`,
normalized attachment references, and optional `replyToMessageId`. It rejects
unknown fields and excludes `messageId`, group/turn IDs, ordinal, delivery/UI
state, and all timestamps. `canonicalActionDescriptors` contains only
`kind`, store-resolved `targetKey/targetRevision`, and a kind-validated semantic
payload; it excludes action/group/turn IDs, ordinal and execution metadata.

The action-kind registry is also closed:

```js
{
  payment_accept: 'payment',
  payment_decline: 'payment',
  moment_create: 'lineage_create',
  moment_like: 'moment',
  moment_comment: 'moment',
  moment_reply: 'comment',
  role_plan_create: 'lineage_create',
  role_plan_update: 'role_plan',
  role_plan_cancel: 'role_plan',
  role_plan_pause: 'role_plan',
  role_plan_resume: 'role_plan',
  role_plan_complete: 'role_plan',
  life_episode_create: 'lineage_create',
  life_episode_update: 'life_episode',
  life_episode_cancel: 'life_episode',
  relationship_transition: 'relationship'
}
```

The existing cognition validators remain responsible for each payload's domain
schema (amount/currency/payment parties, moment privacy/thread, role-plan
operation, life timing/overlap, relationship evidence). Commit independently
requires the action kind's target namespace to match this registry.

Canonical target keys are respectively
`conversation:<roleId>:<peerId>`, `message:<messageId>`,
`payment:<messageId>`, `moment:<momentId>`, `comment:<commentId>`,
`role_plan:<planId>`, `role_occurrence:<occurrenceId>`,
`life_episode:<episodeId>`, `relationship:<roleId>`, and
`lineage_create:<lineageKey>:<actionKind>`. A numeric authority revision is
serialized as its base-10 string; an immutable input snapshot uses
`sha256:<contentHash(canonicalTarget)>`. The trusted orchestrator constructs
these descriptors from a normalized cognition action; model output cannot
supply an arbitrary target key.

When rebuilding bridge payload, spread stored semantic JSON first and assign
deterministic `messageId/actionId/ordinal/kind/target` last.

All legacy delivery/recovery SQL adds
`AND authority_group_id IS NULL` or performs an explicit preflight rejection.
Canonical rows are addressed only by `authority_group_id + peer_id +
authority_commit_checksum`.

- [ ] **Step 4: Run the complete Task 10 gate**

Run:

```powershell
node --test yuqi-runtime/test/agency-state.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: PASS. Then rerun the two manual counterexamples: dry-run source
`user_version` remains unchanged because the command refuses, and an orphan
version-1 turn makes reopen fail.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/agency-state.mjs yuqi-runtime/src/interaction-lanes.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/result-outbox.mjs yuqi-runtime/test/agency-state.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs
git commit -m "fix: enforce semantic visible result authority"
```

### Task 10D: Close Independent-Review Authority Bypasses

**Why this repair gate exists:** Commits `0f76069`, `b7d3e25`, and `21efad9`
pass the declared 183-test Task 10 suite, but independent counterexamples still
prove five authority violations:

1. a stored `result_authority_version=2` survives reopen, even though Task 11
   branches `0 = legacy`, `1 = canonical`;
2. `setTurnRoute()` mutates a version-1 turn without a revision CAS;
3. a committed retry checks the now-advanced lane before returning its receipt
   and fails with `interaction lane revision conflict`;
4. the payment/moment/comment/role-plan snapshot resolver accepts an ID from one
   object and computes the revision from a different persisted object;
5. two actions with different `targetKey`, `targetRevision`, and nested payload
   currently produce the same generation fingerprint.

The 183 passing tests remain regression evidence, but do not authorize Task 11.
Task 11 is forbidden until this task is independently reviewed and committed.

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/interaction-lanes.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Modify: `yuqi-runtime/test/canonical-turn-state.test.mjs`
- Modify: `yuqi-runtime/test/interaction-lanes.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Modify: `yuqi-runtime/test/interaction-lanes.test.mjs`

**Interfaces:**
- Consumes: schema v11, `createCanonicalVisibleTurnInternal()`, canonical turn
  CAS APIs, `commitVisibleResult()`, and group-keyed deliveries from Tasks
  10–10C.
- Produces:

```text
setCanonicalTurnRouteInternal({
  turnId, expectedState, expectedTurnRevision, route, reasons
}) -> turn
beginCanonicalStageInternal({
  turnId, expectedState, expectedTurnRevision, stage, model, effort, startedAt
}) -> { turn, stage }
finishCanonicalStageInternal({
  turnId, expectedState, expectedTurnRevision, stage, finishedAt
}) -> { turn, stage }
resolveCanonicalTargetRefInternal({
  turn, namespace, targetId
}) -> { targetKey, targetRevision, authoritySource, canonicalTarget }
listPendingAuthorityCloudDeliveries(limit) -> CloudDelivery[]
```

- Preserves: version-0 route/stage/delivery behavior and the wire protocol-v2
  boundary. This task does not begin runtime integration or accept protocol v3.

- [ ] **Step 1: Add red reopen and committed-retry ordering tests**

Add a corruption matrix to
`yuqi-runtime/test/store-visible-authority-v11.test.mjs`:

```js
test('v11 reopen rejects every authority version outside zero and one', () =>
  corruptReopen(database => {
    database.prepare(`
      UPDATE turns SET result_authority_version = 2
      WHERE turn_id = 'turn_legacy'
    `).run();
  }, /v11 invariant authority_version_domain/i));

test('v11 reopen joins committed revisions and every group projection', () => {
  for (const corruption of [
    db => db.prepare(`
      UPDATE turns SET turn_revision = turn_revision + 1
      WHERE turn_id = 'turn_committed'
    `).run(),
    db => db.prepare(`
      UPDATE turn_authority_lineages SET revision = revision + 1
      WHERE state = 'committed'
    `).run(),
    db => db.prepare('DELETE FROM visible_result_items').run(),
    db => db.prepare(`
      UPDATE messages SET authority_group_id = NULL
      WHERE authority_group_id IS NOT NULL
    `).run(),
    db => db.prepare(`
      UPDATE visible_result_actions SET action_id = 'action_forged'
    `).run(),
    db => db.prepare(`
      UPDATE consolidation_jobs SET authority_group_id = 'group_missing'
      WHERE authority_group_id IS NOT NULL
    `).run()
  ]) assertCorruptionRejected(corruption);
});
```

The restart invariant must cover both directions:

- authority version is exactly 0 or 1;
- canonical `envelope_json` hashes to `envelope_checksum`;
- stored input batch identity joins the persisted current batch;
- release IDs/checksums join `pipeline_releases`;
- every retry parent exists in the same lineage and the latest open/committed
  turn's creation revision agrees with lineage/receipt authority;
- committed turn revision equals `receipt.turnRevisionAfter`;
- committed lineage revision equals `receipt.lineageRevisionAfter`;
- at the Task 10D/v11 compatibility gate, every then-existing group has at least
  one contiguous item, and each item has exactly one deterministic message
  projection with the same group/ordinal/turn and valid Yuqi speaker identity;
  Task 10F explicitly supersedes the global “at least one” rule for new v13
  automatic terminal skips while retaining all identity checks for rows that
  exist;
- every stored item/action ID equals the shared deterministic derivation;
- no message, stance, consolidation/comparison job, cognitive-state
  `last_authority_group_id`, or canonical delivery points at a missing group.

Add the exact committed-retry counterexample:

```js
test('committed retry returns its receipt before mutable lane checks', () => {
  const { store, original, originalEnvelope, receipt } = committedOriginal();
  assert.equal(store.getInteractionLane('yuqi', 'private_chat').revision, 2);
  const retry = canonicalRetryInput(original, originalEnvelope, {
    expectedLaneRevision: 1 // the creation-time value is now stale by design
  });
  assert.deepEqual(
    store.createCanonicalVisibleTurnInternal(retry),
    { status: 'already_committed', receipt }
  );
  assert.equal(store.getTurn(retry.envelope.turnId), null);
});
```

Also make exact same-`turnId` replay validate the stored immutable identity:
envelope checksum, derived lineage, rollout/lane/batch/visibility, release pair,
agency checksum, and annotation snapshot. It may ignore only mutable current
lane/rollout/agency state. A mismatch returns an authority conflict and never
returns a receipt.

- [ ] **Step 2: Run the new reopen/retry tests red**

Run:

```powershell
node --test yuqi-runtime/test/store-visible-authority-v11.test.mjs
```

Expected: FAIL on the unknown authority version, actual receipt revision joins,
child projection joins, and stale-lane committed retry.

- [ ] **Step 3: Add red mutation-closure and outbox-list tests**

Extend `canonical-turn-state.test.mjs`:

```js
test('all legacy turn execution writers reject a canonical turn', () => {
  const turn = canonicalOpenTurn();
  for (const write of [
    () => store.setTurnRoute(turn.turnId, 'fast', ['test']),
    () => store.beginStage(turn.turnId, 'memory'),
    () => store.finishStage(turn.turnId, 'memory'),
    () => store.putMessageInternal(canonicalCharacterMessage(turn.turnId))
  ]) {
    assert.throws(write, /canonical .* API required/i);
    assert.equal(store.getTurn(turn.turnId).turnRevision, turn.turnRevision);
  }
});

test('canonical route and stage writers CAS the turn revision', () => {
  const routed = store.setCanonicalTurnRouteInternal({
    turnId, expectedState: 'queued', expectedTurnRevision: 1,
    route: 'fast', reasons: ['direct_reply']
  });
  assert.equal(routed.turnRevision, 2);
  assert.throws(() => store.beginCanonicalStageInternal({
    turnId, expectedState: 'queued', expectedTurnRevision: 1,
    stage: 'memory', model: 'codex', effort: 'medium', startedAt: 10
  }), /authority conflict/i);
});
```

Extend `result-outbox.test.mjs`:

```js
test('legacy pending and receipt entrypoints cannot see or mutate canonical delivery', () => {
  const canonical = committedCanonicalDelivery();
  assert.equal(
    store.listPendingCloudDeliveries().some(x => x.authorityGroupId !== null),
    false
  );
  assert.equal(
    store.listPendingAuthorityCloudDeliveries().map(x => x.authorityGroupId),
    [canonical.authorityGroupId]
  );
  assert.throws(
    () => store.recordDeliveryReceipt(legacyReceiptFor(canonical.turnId)),
    /canonical delivery API required/i
  );
});
```

`listPendingCloudDeliveries()` remains the legacy compatibility method and adds
`authority_group_id IS NULL`. The new canonical list requires a valid
group/receipt/checksum join. No caller may decide which API to use merely from a
turn ID supplied over the wire.

- [ ] **Step 4: Implement the mutation boundary**

In `store.mjs`:

- add `authority_version_domain` and the full reopen joins from Step 1;
- move retry parent/full-batch/lineage validation before lane/rollout/agency
  reads, returning the receipt immediately for a committed lineage;
- validate exact-turn immutable replay before returning `created` or
  `already_committed`;
- make `setTurnRoute()`, `beginStage()`, `finishStage()`, and character-output
  `putMessageInternal()` reject version-1 turns before mutation;
- add the three canonical route/stage methods. Each performs one
  `BEGIN IMMEDIATE` transaction, checks `result_authority_version=1`,
  `expectedState`, and `expectedTurnRevision`, applies its row/stage write,
  increments `turn_revision` exactly once, and appends sync only after the CAS;
- keep canonical input user-message persistence private to canonical creation
  and verify it equals the normalized envelope input;
- make `recordDeliveryReceipt()` reject a version-1 turn before inserting
  receipt items or promoting facts;
- split pending-delivery enumeration as specified above.

Do not “fix” stale committed retry by accepting arbitrary root IDs. The method
still validates the normalized complete batch, retry parent, derived lineage,
and immutable stored pins before receipt return.

- [ ] **Step 5: Add red target-identity, speaker-identity, and fingerprint tests**

Add to `visible-result-commit.test.mjs`:

```js
test('input snapshot target id and revision must come from the same object', () => {
  const turn = paymentTurn({ messageId: 'pay_real' });
  assert.throws(() => store.resolveCanonicalActionTargetInternal({
    turn,
    action: {
      kind: 'payment_accept',
      payload: { messageId: 'pay_forged' }
    }
  }), /target identity conflict/i);
});

for (const fixture of [
  forgedMomentId(), forgedCommentId(), forgedRolePlanId(),
  forgedRoleOccurrenceId(), foreignRolePlanRow()
]) {
  test(fixture.name, () => assert.throws(
    () => store.resolveCanonicalActionTargetInternal(fixture.input),
    /target identity|target not found|role authority/i
  ));
}

test('canonical visible items cannot spoof speaker or recipient identity', () => {
  for (const mutation of [
    item => { item.speakerId = 'user'; },
    item => { item.speakerType = 'user'; },
    item => { item.recipientId = 'other_peer'; },
    item => { item.content = '   '; }
  ]) assertVisibleCommitRollsBack(mutation);
});
```

Add to `interaction-lanes.test.mjs`:

```js
test('fingerprint changes with resolved action target and semantic payload', () => {
  const first = resolvedAction({
    targetKey: 'payment:pay_1',
    targetRevision: `sha256:${'a'.repeat(64)}`,
    payload: { messageId: 'pay_1', decision: 'accept' }
  });
  assert.notEqual(
    generationFingerprint(fpInput({ actionSet: [first] })),
    generationFingerprint(fpInput({ actionSet: [{
      ...first,
      targetKey: 'payment:pay_2',
      payload: { messageId: 'pay_2', decision: 'accept' }
    }] }))
  );
  assert.notEqual(
    generationFingerprint(fpInput({ actionSet: [first] })),
    generationFingerprint(fpInput({ actionSet: [{
      ...first,
      payload: { messageId: 'pay_1', decision: 'decline' }
    }] }))
  );
});
```

Update preference authority tests so every valid `stable_preference` evidence
ID resolves to a real, unsuppressed message. Add separate missing-evidence,
suppressed-evidence, unverified, wrong-type, and missing-fact cases; all must
fail snapshot creation. Existing fixtures that use nonexistent `u1/u2` as
“valid evidence” are incorrect under the design and must not be retained.

- [ ] **Step 6: Implement one target resolver and resolved-action fingerprint**

Add `resolveCanonicalTargetRefInternal()` as the only namespace resolver:

```js
resolveCanonicalTargetRefInternal({ turn, namespace, targetId }) {
  const canonicalTarget = findExactPersistedTarget({
    db: this.db,
    envelope: parseJson(turn.envelopeJson, {}),
    roleId: turn.characterId,
    namespace,
    targetId
  });
  if (!canonicalTarget || canonicalTarget.id !== String(targetId)) {
    throw new Error('canonical action target identity conflict');
  }
  return {
    targetKey: `${namespace}:${canonicalTarget.id}`,
    targetRevision: canonicalTarget.pcOwned
      ? canonicalTarget.revisionOrChecksum
      : `sha256:${contentHash(canonicalTarget.snapshot)}`,
    authoritySource: canonicalTarget.pcOwned ? 'pc_store' : 'input_snapshot',
    canonicalTarget: canonicalTarget.snapshot
  };
}
```

The concrete implementation must:

- derive payment/message/moment/comment IDs from the persisted validated
  envelope first, then compare the action ID;
- hash the exact matched snapshot, not the whole context and not an adjacent
  object;
- verify PC role-plan/occurrence/life rows belong to `turn.characterId`;
- derive conversation from `turn.characterId + turn.deviceId` and the current
  lane revision;
- derive lineage-create only from `turn.authorityLineageKey + action.kind`;
- default-deny unknown namespaces and action kinds.

`resolveCanonicalActionTargetInternal()` maps the already enumerated action
kinds to this resolver. It does not invent a model-facing kind for
`conversation`, `message`, or `role_occurrence`; those namespaces are tested
through the target-ref interface and become reachable only when a trusted
materializer maps a validated domain operation in Task 11.

Change fingerprint action canonicalization to:

```js
function canonicalActionTargets(actionSet) {
  return actionSet.map(action => ({
    kind: String(action.kind),
    targetKey: String(action.targetKey),
    targetRevision: String(action.targetRevision),
    semanticPayloadChecksum: contentHash(action.payload || {})
  }));
}
```

Sort by canonical JSON. On a new commit, resolve actions and validate visible
speaker/recipient identity before comparing the caller fingerprint. Existing
receipt replay continues to normalize and checksum the submitted semantic
descriptor without reading mutable state.

- [ ] **Step 7: Run the complete repair gate**

Run:

```powershell
node --test yuqi-runtime/test/agency-state.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: all prior 183 tests plus the new Task 10D tests PASS.

Then rerun these manual counterexamples and record their exact output in the
handoff:

1. unknown authority version reopen is rejected;
2. `setTurnRoute()` rejects a canonical turn with no revision change;
3. committed retry with stale creation-time lane revision returns the original
   receipt and creates no retry turn;
4. `payment.messageId=pay_forged` against snapshot `pay_real` is rejected;
5. two resolved actions with different target/payload produce different
   fingerprints.

- [ ] **Step 8: Commit and stop for independent review**

```powershell
git add docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md yuqi-runtime/src/store.mjs yuqi-runtime/src/interaction-lanes.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs
git commit -m "fix: close canonical authority review bypasses"
```

After the commit, stop. Report the commit, exact test total, five manual
counterexample outputs, and any deviation from these interfaces. Do not start
Task 11 until the plan owner explicitly reviews and releases this gate.

### Task 10E: Seal Post-Commit Semantics and Restore Fresh-Agency Retry

**Why this repair gate exists:** Commit `b79cd37` passes the declared 199-test
Task 10D suite, but an independent review reproduced four additional violations:

1. `setCanonicalTurnRouteInternal()` accepts `expectedState='committed'`, and
   `advanceCanonicalTurnInternal()` can then move the committed turn back to
   `queued`;
2. changing `visible_result_actions.action_json` survives reopen and the changed
   payload is delivered;
3. deleting the authorized action row survives reopen and the delivery silently
   loses the action;
4. after agency heads change, a retry with the new checksum is rejected for not
   matching the parent, while a retry with the parent checksum is rejected for
   not matching the current snapshot. The explicit recovery required for
   `AGENCY_AUTHORITY_STALE` is therefore impossible.

The same review found two uncovered preservation risks: v11 only checks that an
input batch row exists rather than verifying its ordered contents/checksums, and
`ResultOutbox` always concatenates canonical rows before legacy rows, so a
canonical backlog at the limit can starve legacy delivery indefinitely. Task 11
remains forbidden until Task 10E is implemented, committed, and independently
reviewed.

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md`
- Modify: `docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `scripts/migrate-yuqi-agency-state.mjs`
- Modify: `yuqi-runtime/test/store-cognition-migration.test.mjs`
- Modify: `yuqi-runtime/test/store-agency-v10.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Modify: `yuqi-runtime/test/canonical-turn-state.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Modify: `tests/yuqi-agency-state-migration.test.mjs`

**Interfaces:**
- Consumes: PC schema v11 from Task 10D, canonical turn/lineage CAS, the
  `pc-visible-commit-v1` semantic payload, and separate canonical/legacy pending
  delivery queries.
- Produces: PC schema v12; one manifest row per canonical result; a closed
  canonical transition graph; fresh-agency retry semantics; complete restart
  joins; fair mixed outbox enumeration.
- Android Room remains on the independently versioned schema declared by
  Tasks 12–13. PC `user_version=12` must never be copied into Room versioning.

```text
visible_result_manifests(
  group_id TEXT PRIMARY KEY,
  authority_origin TEXT NOT NULL,
  payload_version TEXT NOT NULL,
  semantic_json TEXT,
  semantic_checksum TEXT NOT NULL UNIQUE,
  redacted_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (
    (semantic_json IS NOT NULL AND redacted_at IS NULL)
    OR (semantic_json IS NULL AND redacted_at IS NOT NULL)
  ),
  FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
)

getVisibleResultManifest(groupId)
  -> { visibleGroupId, authorityOrigin, payloadVersion, semantic,
       semanticChecksum, redactedAt, createdAt } | null

assertCanonicalAttemptMutableInternal({
  turnId, expectedState, expectedTurnRevision, operation
}) -> { turn, lineage }
```

The manifest is the persisted canonical semantic payload itself, not a second
caller-authored summary. For PC results,
`contentHash(parseJson(semantic_json)) === semantic_checksum ===
visible_commit_receipts.commit_checksum`, and `payload_version` is
`pc-visible-commit-v1`.

- [ ] **Step 1: Add red terminal-mutation and fresh-agency retry tests**

Extend `canonical-turn-state.test.mjs` with a committed fixture and exercise
every canonical attempt writer:

```js
test('a committed canonical lineage is immutable through every attempt writer', () => {
  const { store, turn, receipt } = committedCanonicalTurn();
  const writes = [
    () => store.setCanonicalTurnRouteInternal({
      turnId: turn.turnId,
      expectedState: 'committed',
      expectedTurnRevision: receipt.turnRevisionAfter,
      route: 'fast',
      reasons: ['forged']
    }),
    () => store.beginCanonicalStageInternal({
      turnId: turn.turnId,
      expectedState: 'committed',
      expectedTurnRevision: receipt.turnRevisionAfter,
      stage: 'memory'
    }),
    () => store.advanceCanonicalTurnInternal({
      turnId: turn.turnId,
      expectedState: 'committed',
      nextState: 'queued',
      expectedTurnRevision: receipt.turnRevisionAfter
    }),
    () => store.recordCanonicalTurnFailureInternal({
      turnId: turn.turnId,
      expectedState: 'committed',
      expectedTurnRevision: receipt.turnRevisionAfter,
      failure: { failureClass: 'terminal', code: 'FORGED' }
    })
  ];
  for (const write of writes) {
    assert.throws(write, /canonical committed authority is immutable/i);
    assert.deepEqual(store.getVisibleCommitReceipt(turn.authorityLineageKey), receipt);
    assert.equal(store.getTurn(turn.turnId).turnRevision, receipt.turnRevisionAfter);
    assert.equal(store.getTurn(turn.turnId).state, 'committed');
  }
});
```

Add a table-driven transition test. `claimCanonicalTurnInternal()` owns only
`queued→memory_running`; `advanceCanonicalTurnInternal()` allows only:

```js
const canonicalForwardEdges = new Map([
  ['memory_running', 'memory_done'],
  ['memory_done', 'brain_running'],
  ['brain_running', 'brain_done'],
  ['brain_done', 'supervisor_running'],
  ['supervisor_running', 'approved']
]);
```

Every reverse, skip, same-state, `approved→committed`, and
`failed→queued` call through the generic advance method must fail without
revision change. Commit and requeue retain their dedicated APIs.

Extend `store-visible-authority-v11.test.mjs`:

```js
test('open retry fixes a fresh agency snapshot while inheriting model pins', () => {
  const { store, original, originalEnvelope } = openCanonicalTurn();
  mutateCurrentAgencyHead(store);
  const fresh = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi',
    at: originalEnvelope.message.sentAt
  });
  assert.notEqual(fresh.checksum, original.agencySnapshotChecksum);
  const retry = store.createCanonicalVisibleTurnInternal(
    retryInput(original, originalEnvelope, {
      agencySnapshotChecksum: fresh.checksum
    })
  ).turn;
  assert.equal(retry.agencySnapshotChecksum, fresh.checksum);
  assert.equal(retry.authoritativeReleaseId, original.authoritativeReleaseId);
  assert.equal(retry.authoritativePipelineChecksum, original.authoritativePipelineChecksum);
  assert.equal(retry.rolloutRevision, original.rolloutRevision);
  assert.equal(retry.inputUserBatchId, original.inputUserBatchId);
  assert.equal(retry.inputVisibilitySequence, original.inputVisibilitySequence);
});
```

The same test must prove a forged checksum has zero side effects, an exact replay
of the retry validates the retry's own checksum, and an already-committed lineage
still returns its receipt before reading current agency heads.

- [ ] **Step 2: Run the mutation/retry tests red**

Run:

```powershell
node --test yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs
```

Expected: FAIL because committed writers currently accept caller-supplied
terminal states, generic advance has no transition graph, and retry requires the
parent agency checksum.

- [ ] **Step 3: Add red v12 manifest, batch, child-authority, and migration tests**

In `store-visible-authority-v11.test.mjs`, keep the filename for historical
coverage but add a v12 corruption matrix. Seed a committed result containing at
least two items, one action, one state patch/stance transition, one memory job,
one canonical delivery, and a manifest. Close the store, corrupt through raw
SQLite, and require the next `new YuqiStore(path)` to reject each case:

```js
const corruptions = [
  db => db.prepare(`
    UPDATE visible_result_actions
    SET action_json = '{"text":"tampered"}'
  `).run(),
  db => db.prepare('DELETE FROM visible_result_actions').run(),
  db => db.prepare(`
    UPDATE visible_result_actions
    SET action_checksum = ?
  `).run('f'.repeat(64)),
  db => db.prepare(`
    UPDATE current_user_batch_items
    SET message_json = '{"messageId":"msg_source","content":"tampered"}'
  `).run(),
  db => db.prepare(`
    UPDATE current_user_batch_items SET sequence = sequence + 10
  `).run(),
  db => db.prepare(`
    UPDATE consolidation_jobs SET role_id = 'other_role'
    WHERE authority_group_id IS NOT NULL
  `).run(),
  db => db.prepare(`
    UPDATE consolidation_jobs SET payload_json = '{"tampered":true}'
    WHERE authority_group_id IS NOT NULL
  `).run(),
  db => db.prepare(`
    DELETE FROM consolidation_jobs WHERE authority_group_id IS NOT NULL
  `).run(),
  db => db.prepare(`
    UPDATE cognitive_states SET checksum = ?
    WHERE last_authority_group_id IS NOT NULL
  `).run('e'.repeat(64)),
  db => db.prepare('DELETE FROM visible_result_manifests').run(),
  db => db.prepare(`
    UPDATE visible_result_manifests
    SET semantic_json = '{"payloadVersion":"pc-visible-commit-v1"}'
  `).run(),
  db => db.prepare(`
    UPDATE visible_commit_receipts SET commit_checksum = ?
  `).run('d'.repeat(64))
];
for (const corrupt of corruptions) {
  assertV12CorruptionRejected(corrupt);
}
```

Add retry-row corruptions that must fail reopen: changed preset/release/checksum,
comparison mode/release, rollout/evidence epoch, batch identity/visibility,
annotation snapshot, parent lineage, or a child
`lineage_revision_at_creation != parent + 1`. Do not require child
`agency_snapshot_checksum` to equal parent.

Add migration tests:

1. raw populated v10 with only legacy rows migrates v10→v11→v12 with unchanged
   structural counts;
2. v11 with no canonical group/receipt creates the manifest table and becomes
   v12;
3. v11 containing a canonical group/receipt but no manifest throws
   `v12 migration cannot reconstruct canonical manifest` before changing
   `user_version`, schema, logical row counts, or logical data checksum;
4. fresh/open v12 is restart-idempotent;
5. `user_version > 12` stops without rewriting;
6. dry-run clone reports `workingUserVersion:12`, includes manifest table counts
   and v12 invariant checksum, while the source remains byte-identical.

- [ ] **Step 4: Run the v12 corruption and migration tests red**

Run:

```powershell
node --test yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: FAIL because schema v12/manifest does not exist and current reopen
checks neither semantic action/job projections nor complete batch contents.

- [ ] **Step 5: Implement v12, manifest commit, mutation closure, and full reopen invariants**

In `store.mjs`, add `migrateVisibleAuthorityV12Internal()` in the same outer
migration transaction:

```js
if (this.userVersion() === 11) {
  const canonicalRows = Number(this.db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM visible_result_groups) +
      (SELECT COUNT(*) FROM visible_commit_receipts) AS value
  `).get().value);
  if (canonicalRows !== 0) {
    throw new Error('v12 migration cannot reconstruct canonical manifest');
  }
  this.db.exec(`
    CREATE TABLE visible_result_manifests (
      group_id TEXT PRIMARY KEY,
      authority_origin TEXT NOT NULL,
      payload_version TEXT NOT NULL,
      semantic_json TEXT,
      semantic_checksum TEXT NOT NULL UNIQUE,
      redacted_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK (
        (semantic_json IS NOT NULL AND redacted_at IS NULL)
        OR (semantic_json IS NULL AND redacted_at IS NOT NULL)
      ),
      FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
    );
    PRAGMA user_version = 12;
  `);
}
```

Do not use `CREATE TABLE IF NOT EXISTS` to bless a partially modified v11
database. The preflight must distinguish a clean v11 migration from a forged
v12-like table and the invariant must require exactly the declared columns,
indexes, and foreign key.

In `visible-result-commit.mjs`, compute the strict allowlisted
`canonicalCommitPayload(input)` once at entry. This lets an existing exact
receipt compare semantic checksum before reading mutable lane/agency/target
state. On a new commit, resolve targets and validate state/jobs, require those
normalized semantic descriptors to equal the already-built manifest, then pass
the same manifest to the internal transaction:

```js
const authorityManifest = canonicalCommitPayload(input);
const commitChecksum = contentHash(authorityManifest);
const existing = input.store.getVisibleCommitReceipt(input.authorityLineageKey);
if (existing) {
  assert.equal(existing.authorityOrigin, 'pc');
  assert.equal(existing.commitPayloadVersion, authorityManifest.payloadVersion);
  assert.equal(existing.commitChecksum, commitChecksum);
  return { ...existing, committed: false };
}
```

After the existing target/state/comparison validation has produced
`resolvedActions`, `validatedStatePatch`, and `normalizedMemoryJobs`, add these
exact equivalence checks before `commitVisibleResultInternal()`:

```js
assert.deepEqual(authorityManifest.actions, resolvedActions.map(normalizeAction));
assert.deepEqual(authorityManifest.statePatch, validatedStatePatch?.semanticPatch ?? null);
assert.deepEqual(authorityManifest.memoryJobs,
  normalizedMemoryJobs.map(job => normalizeMemoryJob(job)));

return input.store.commitVisibleResultInternal({
  ...input,
  visibleGroup: { items: authorityManifest.visibleItems },
  actionSet: resolvedActions,
  statePatch: validatedStatePatch,
  memoryJobs: normalizedMemoryJobs,
  authorityOrigin: 'pc',
  commitPayloadVersion: authorityManifest.payloadVersion,
  authorityManifest,
  commitChecksum
});
```

In `commitVisibleResultInternal()`:

- recompute `contentHash(input.authorityManifest)` and require it equals
  `input.commitChecksum`;
- insert `visible_result_manifests` inside the same transaction;
- make `visible_result_groups.reply_checksum` hash the ordered normalized
  `{items, actions}` projection rather than items alone;
- insert the manifest before the receipt and add a separate fault-injection
  boundary, making the transaction gate 14 write steps;
- join manifest/group/receipt before returning an existing receipt;
- never reconstruct a manifest from `reply_json`, action rows, jobs, or current
  state.

Add one internal guard used by route/stage/claim/advance/failure writers. Its SQL
must enforce the authority conditions, not merely pre-read them:

```sql
WHERE t.turn_id = ?
  AND t.result_authority_version = 1
  AND t.state = ?
  AND t.turn_revision = ?
  AND EXISTS (
    SELECT 1 FROM turn_authority_lineages l
    WHERE l.lineage_key = t.authority_lineage_key
      AND l.state = 'open'
      AND l.latest_turn_id = t.turn_id
      AND l.committed_group_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM visible_commit_receipts r
    WHERE r.lineage_key = t.authority_lineage_key
  )
```

Apply the explicit transition map from Step 1 before executing
`advanceCanonicalTurnInternal()`. Keep claim, commit, failure, cancellation, and
requeue as dedicated transitions; no generic caller may name a terminal
destination.

For retry creation, compare parent and child immutable pins explicitly:

```js
const inheritedRetryPins = [
  'pipelineMode', 'presetVersion', 'rolloutRevision', 'rolloutEvidenceEpoch',
  'pipelineChecksum', 'shadowEpoch', 'canaryEpoch', 'canarySlot',
  'comparisonMode', 'authoritativeReleaseId', 'comparisonReleaseId',
  'authoritativePipelineChecksum', 'comparisonPipelineChecksum',
  'inputUserBatchId', 'inputVisibilitySequence'
];
```

Also require the complete normalized batch and annotation snapshot to match.
Do not include `agencySnapshotChecksum` in this inherited list. Recompute and
persist the current agency snapshot for a new open retry. Exact same-turn replay
continues to compare its own stored agency checksum.

Replace the shallow v11 reopen checks with v12 closure:

- recompute every envelope, batch header, ordered batch item, item/action/job
  payload checksum;
- compare the persisted batch exactly with `resolveCurrentUserBatch(envelope)`;
- require retry child pins from the list above and annotation hash to equal its
  parent, creation revision to be parent+1, and lineage/root/batch identity to
  match;
- require one manifest per group and one group per manifest;
- for a non-redacted group, require manifest origin/version/checksum to equal
  group/receipt and recompute its canonical JSON hash;
- for a redacted group, require group/manifest matching non-null redaction time,
  null semantic JSON, no pending delivery, no retrievable item/message content,
  no executable action payload, and no path through `visibleDeliveryPayload()`;
- require ordered item/action rows to equal `manifest.visibleItems/actions`
  exactly, including counts and contiguous ordinals;
- reconstruct action checksum from
  `{kind, targetKey, targetRevision, payload}` and require the deterministic
  action ID;
- compare manifest memory/compare descriptor counts and semantics with
  authority-group jobs, while allowing only documented attempt metadata outside
  the semantic descriptor;
- require job `subject_type='turn'`, `subject_id=turn_id=authoritativeTurnId`,
  `role_id=group.roleId`, contiguous authority ordinals, and valid payload hash;
- require stance rows to use the same group role/turn and contiguous authority
  ordinals;
- require a cognitive state carrying `last_authority_group_id` to use the same
  role/turn and a checksum matching `state_json`;
- keep all existing receipt, delivery, message, release, fingerprint, lineage,
  and authority-version checks.

`visibleDeliveryPayload()` must call the same manifest/projection validator
before returning payload, so a corrupt database opened through a test-only raw
handle cannot emit altered actions even before the next process restart.

- [ ] **Step 6: Add and implement fair mixed outbox scheduling**

Add this test to `result-outbox.test.mjs`:

```js
test('mixed canonical and legacy backlog honors global age without starvation', async () => {
  const { outbox, store, fetchOrder } = mixedBacklog({
    canonical: 60,
    legacy: 2,
    legacyUpdatedAt: 1,
    canonicalUpdatedAt: 2
  });
  await outbox.flushOnce(50);
  assert.deepEqual(fetchOrder.slice(0, 2), ['legacy_old_1', 'legacy_old_2']);

  resetMixedBacklog({
    canonical: 2,
    legacy: 60,
    canonicalUpdatedAt: 1,
    legacyUpdatedAt: 2
  });
  await outbox.flushOnce(50);
  assert.deepEqual(fetchOrder.slice(0, 2), ['canonical_old_1', 'canonical_old_2']);
  assert.equal(store.listPendingCloudDeliveries().every(x => x.authorityGroupId == null), true);
  assert.equal(store.listPendingAuthorityCloudDeliveries().every(x => x.authorityGroupId != null), true);
});
```

Keep the two store queries isolated, request up to `limit` from each, merge and
sort by numeric `updatedAt`, then a stable key
`authorityGroupId || turnId`, then `peerId`, and only then slice to `limit`.
Do not concatenate one class ahead of the other.

- [ ] **Step 7: Run the complete Task 10E gate and manual counterexamples**

Run:

```powershell
node --test yuqi-runtime/test/agency-state.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: all 199 Task 10D tests plus every Task 10E test PASS. Record the exact
new total; do not hardcode or waive a lower count.

Then run and report exact output for these counterexamples:

1. committed route/stage/advance/failure each rejects with unchanged receipt,
   state, and revision;
2. action payload mutation is rejected on reopen and on direct delivery load;
3. action deletion is rejected on reopen and on direct delivery load;
4. fresh-agency open retry succeeds, while forged checksum has zero side
   effects;
5. current-user-batch content/order/checksum corruption is rejected;
6. job role/turn/payload/deletion corruption is rejected;
7. with more than `limit` canonical rows, older legacy rows are still selected,
   and the inverse case also passes;
8. raw v11 with a canonical receipt but no manifest refuses v12 migration
   without changing `user_version`, schema, row counts, or logical data
   checksum.

- [ ] **Step 8: Commit and stop for independent review**

```powershell
git add docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md yuqi-runtime/src/store.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/result-outbox.mjs scripts/migrate-yuqi-agency-state.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs tests/yuqi-agency-state-migration.test.mjs
git commit -m "fix: seal canonical result authority"
```

After the commit, stop. Report the commit, exact full-gate total, all eight
manual outputs, migration before/after evidence, and every interface deviation.
Do not start Task 11 until the plan owner independently reviews and explicitly
releases Task 10E.

### Task 10F: Repair v13 Redaction, Replay Closure, and Scoped Validation

**Why this repair gate exists:** Commit `cbe3bdc` passes its declared 228-test
Task 10E suite, but independent review reproduced four untested failures:

1. two sequential legal commits containing `statePatch` make the first historical
   group fail reopen with `manifest cognitive state missing`;
2. an exact committed replay returns a receipt after the manifest has been
   corrupted through an already-open raw handle;
3. a fully cleared redacted audit shell can never pass because the inherited v11
   invariant requires at least one non-null live item, while v13 must accept
   retained item tombstones with null semantics and must later support a genuine
   zero-item automatic skip;
4. the proposed v13 shell has no parent cardinality/identity anchor, so deleting
   the last item/action/current-batch tombstone—or an older retry attempt or
   mailboxed delivery—can leave a self-consistent-looking remainder that passes
   a “remaining ordinals are contiguous” check.

The same review found that `turn.reply_json` and mailboxed/confirmed delivery
payloads remain outside redaction checks, and every canonical target delivery
repeats a whole-database invariant scan. Task 11 remains forbidden until Task
10F is implemented, committed, and independently reviewed.

**Files:**

- Modify: `docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md`
- Modify: `docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `scripts/migrate-yuqi-agency-state.mjs`
- Create: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/store-cognition-migration.test.mjs`
- Modify: `yuqi-runtime/test/store-agency-v10.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Modify: `yuqi-runtime/test/canonical-turn-state.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Modify: `tests/yuqi-agency-state-migration.test.mjs`

**Interfaces:**

- Consumes: Task 10E PC v12 groups/manifests/receipts, current cognitive-state
  row semantics, canonical retry identity, and group-keyed cloud delivery.
- Produces: PC schema v13; nullable input-batch/item/action semantic tombstones
  with immutable IDs/checksums; parent-owned result/batch/lineage
  cardinality-and-identity commitments; redaction-time delivery-set commitment;
  existing `turns.rollout_key` promoted to the sole persistent, non-sensitive
  canonical turn-kind anchor;
  per-turn `authority_redacted_at`;
  per-turn `input_clear_epoch`; new PC commits use
  `pc-visible-commit-v2` while v1 receipts remain replayable;
  `assertV12ToV13SourceInvariantsInternal()`;
  `assertVisibleGroupAuthorityInternal(groupId, options)`;
  `assertVisibleAuthorityV13Invariants()`; and
  `readCanonicalCommitOutcomeInternal(options)`.
- Guarantees: Android Room version does not change; no v12 redacted source is
  guessed or repaired; a live v12 source migrates without semantic changes;
  every existing-receipt return validates group/receipt/manifest closure; a
  redacted receipt returns metadata only; deleting any retained tail/middle/all
  child row is restart-detectable; a canonical automatic skip is a successful
  zero-item/zero-action terminal group while a direct reply can never be empty;
  delivery validation is group-scoped.

- [ ] **Step 1: Add red v12→v13 migration and schema tests**

Create `store-visible-authority-v13.test.mjs`. Add fixture builders
`buildLiveV12Database(path, { groups, statePatches })` and
`snapshotDatabase(path)` that return `userVersion`, normalized schema SQL,
row counts, and logical checksums. They must create real v12 rows using the
Task 10E schema, not a v13 store opened and downgraded by `PRAGMA`.
Add a local `rows(store, table)` helper that uses the fixture store's raw
connection to execute `SELECT * FROM <allowlisted table> ORDER BY rowid`; the
helper must reject table names outside the test's explicit allowlist.

Add these tests:

```js
test('fresh and populated v12 migrate atomically to exact v13 tombstone schema', () => {
  const path = buildLiveV12Database(tempPath(), { groups: 2, statePatches: 2 });
  const before = snapshotDatabase(path);
  const store = new YuqiStore(path);
  assert.equal(store.userVersion(), 13);
  assert.deepEqual(columns(store, 'visible_result_items'), [
    'group_id', 'ordinal', 'message_id', 'item_json', 'item_checksum', 'redacted_at'
  ]);
  assert.deepEqual(columns(store, 'visible_result_actions'), [
    'group_id', 'ordinal', 'action_id', 'action_kind', 'target_key',
    'target_revision', 'action_json', 'action_checksum', 'redacted_at'
  ]);
  assert.deepEqual(columns(store, 'current_user_batch_items'), [
    'turn_id', 'batch_id', 'message_id', 'sequence',
    'message_json', 'checksum', 'redacted_at'
  ]);
  assert.deepEqual(
    columns(store, 'visible_result_groups').slice(-5),
    [
      'item_count', 'action_count', 'tombstone_commitment',
      'redaction_delivery_count', 'redaction_delivery_commitment'
    ]
  );
  assert.deepEqual(
    columns(store, 'current_user_batches').slice(-2),
    ['item_count', 'tombstone_commitment']
  );
  assert.deepEqual(
    columns(store, 'turn_authority_lineages').slice(-3),
    ['redacted_at', 'attempt_count', 'attempt_commitment']
  );
  // Historical v12 could not create zero-item groups; this is a source-migration
  // assertion, not the post-v13 per-kind terminal rule.
  for (const group of rows(store, 'visible_result_groups')) {
    assert.equal(group.item_count >= 1, true);
    assert.equal(group.action_count >= 0, true);
    assert.match(group.tombstone_commitment, /^[a-f0-9]{64}$/);
    assert.equal(group.redaction_delivery_count, null);
    assert.equal(group.redaction_delivery_commitment, null);
  }
  for (const batch of rows(store, 'current_user_batches')) {
    assert.equal(batch.item_count >= 1, true);
    assert.match(batch.tombstone_commitment, /^[a-f0-9]{64}$/);
  }
  for (const lineage of rows(store, 'turn_authority_lineages')) {
    assert.equal(lineage.attempt_count >= 1, true);
    assert.match(lineage.attempt_commitment, /^[a-f0-9]{64}$/);
  }
  assert.equal(columns(store, 'turns').includes('authority_redacted_at'), true);
  assert.equal(columns(store, 'turns').includes('input_clear_epoch'), true);
  assert.equal(columns(store, 'turns').includes('rollout_key'), true);
  assert.equal(columns(store, 'turns').includes('turn_kind'), false);
  assert.equal(columns(store, 'turn_authority_lineages').includes('redacted_at'), true);
  assert.equal(columns(store, 'cloud_deliveries').includes('relay_message_id'), true);
  assert.equal(columns(store, 'cloud_deliveries').includes('redaction_requested_at'), true);
  assert.equal(columns(store, 'cloud_deliveries').includes('redaction_acknowledged_at'), true);
  assert.equal(columns(store, 'interaction_lanes').includes('clear_epoch'), true);
  assert.equal(columns(store, 'interaction_lanes').includes(
    'cleared_through_sequence'), true);
  assert.deepEqual(columns(store, 'conversation_clear_controls'), [
    'control_id', 'role_id', 'clear_epoch', 'cleared_through_sequence',
    'requested_at', 'applied_at', 'checksum'
  ]);
  assert.equal(store.visibleAuthorityV13InvariantSummary().canonicalTurnCount,
    before.canonicalTurnCount);
  store.close();
  assert.doesNotThrow(() => new YuqiStore(path).close());
});

test('raw v12 redaction marker refuses v13 migration without mutation', () => {
  const path = buildLiveV12Database(tempPath(), { groups: 1, statePatches: 1 });
  raw(path).prepare(
    'UPDATE visible_result_groups SET redacted_at = 3000'
  ).run();
  const before = snapshotDatabase(path);
  assert.throws(() => new YuqiStore(path), /v13 migration rejects v12 redacted source/);
  assert.deepEqual(snapshotDatabase(path), before);
});

test('every v13 migration fault rolls back to the exact v12 logical snapshot', () => {
  for (const step of V13_MIGRATION_FAULT_STEPS) {
    const path = buildLiveV12Database(tempPath(), { groups: 2, statePatches: 2 });
    const before = snapshotDatabase(path);
    assert.throws(() => openWithV13MigrationFault(path, step), /forced v13 migration fault/);
    assert.deepEqual(snapshotDatabase(path), before);
  }
});
```

Also cover clean v9→v10→v11→v12→v13, populated v10→v11→v12→v13,
clean v11→v12→v13, `user_version=13` restart idempotence, `>13` rejection, and
v12 corruption rejection before the first write. A v12 database with two
historical state patches is a required accepted source. Add multi-message
original+two-retry fixtures and prove v12 source validation rejects a missing
attempt, non-contiguous `lineage_revision_at_creation`, wrong latest turn,
missing current-batch tail item, missing result tail item, and deleted action
before any v13 commitment is calculated. Also reject a canonical v12 turn whose
`rollout_key` is null, outside the nine-kind closed set, or differs from its
live normalized `envelope.kind`; all three failures must preserve the exact v12
snapshot.

- [ ] **Step 2: Run migration tests red**

Run:

```powershell
node --test yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: FAIL because the runtime stops at v12, input/item/action semantic
columns cannot be tombstoned, turns have no authority redaction marker, and the
migration report still names v12.

- [ ] **Step 3: Implement the v13 migration without accepting corrupt v12**

In `store.mjs`, change the maximum supported PC version to 13. Do not call
`assertVisibleAuthorityV12Invariants()` before a v12 migration because its
historical current-state rule is the bug being repaired. Implement:

```js
assertV12ToV13SourceInvariantsInternal()
migrateVisibleAuthorityV13Internal()
assertVisibleAuthorityV13SchemaInternal()
visibleAuthorityV13InvariantSummary()
```

`assertV12ToV13SourceInvariantsInternal()` must:

- require exact v12 manifest/item/action schema, indexes, and foreign keys;
- reject any v12 group/manifest redaction marker or null manifest semantic JSON;
- validate every live group projection and receipt, but apply the corrected
  current cognitive-state rule from Step 6;
- reject any missing/corrupt group, receipt, manifest, item, action, message,
  job, stance, delivery, envelope, batch, retry pin, release, or lineage join.
- require every version-1 turn's existing `rollout_key` to be non-null, belong
  to the nine canonical turn-kind closed set, and equal its normalized live
  `envelope.kind` before that value is admitted as `turnKind` into the v13
  attempt commitment. `LIFE_PLANNING` is not a turn-group kind;
- before deriving any v13 audit commitment, require each v12 lineage's attempts
  to have revisions `1..N` with no duplicate/gap, retry `i` to name attempt
  `i-1`, and `latest_turn_id` to name attempt N; require open revision `N`,
  committed receipt revisions `N→N+1`, and cancelled revision `N+1` with no
  receipt/group. A source that cannot prove N from its v12 revision graph is
  rejected without writes.

Add four pure canonical helpers used by migration, live writes, scoped
validation, reopen, and redaction; no call site may reimplement their field
selection:

```js
visibleResultTombstoneCommitment({ groupId, itemRows, actionRows })
currentUserBatchTombstoneCommitment({ turnId, batchId, itemRows })
authorityLineageAttemptsCommitment({ lineageKey, attemptRows })
authorityRedactionDeliveriesCommitment({ groupId, deliveryRows })
```

Each returns `{ count fields, commitment }`, validates the exact closed tuple
shape from the design, sorts by the specified authority key, and hashes the
versioned canonical JSON. It must reject a missing/duplicate/non-contiguous row
instead of normalizing it away. A delivery row must contain the
`relayMessageId` member; explicit null is valid only for a waiting row that was
never mailboxed and remains part of the committed delivery set.

`authorityLineageAttemptsCommitment()` keeps the logical tuple member
`turnKind`, but every store query must project it only as
`t.rollout_key AS turn_kind`; the helper receives `row.turn_kind`. The v12 live
source validator may read `envelope.kind` only to prove equality before
backfill. No v13 redacted/reopen/receipt/delivery path may select
`json_extract(t.envelope_json,'$.kind')`.

Use one closed constant for this authority domain:

```js
const CANONICAL_RESULT_TURN_KINDS = new Set([
  'DIRECT_REPLY',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);
```

The lineage-attempt row loader has one field-source contract, shared by
migration, original/retry writes, scoped validation, redacted validation, and
receipt replay:

```sql
SELECT
  t.lineage_revision_at_creation,
  t.turn_id,
  t.rollout_key AS turn_kind,
  t.retry_of_turn_id,
  t.input_user_batch_id,
  t.envelope_checksum,
  b.tombstone_commitment AS batch_tombstone_commitment
FROM turns t
LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
WHERE t.authority_lineage_key = ?
ORDER BY t.lineage_revision_at_creation, t.turn_id
```

If the physical store uses an equivalent parent join for the batch ID, the
projection and aliases above remain mandatory. A missing batch parent projects
explicit null; duplicate batch parents are an invariant failure, never a row
deduplication. `LIFE_PLANNING` is intentionally absent from this constant and
query path.

`migrateVisibleAuthorityV13Internal()` must run in the existing outer
`BEGIN IMMEDIATE`, create replacement current-batch-item/item/action tables with
the exact v13 columns and CHECK constraints from the design, add
`turns.authority_redacted_at`, `turns.input_clear_epoch NOT NULL DEFAULT 0`, and
`turn_authority_lineages.redacted_at`, copy
every live row with `redacted_at=NULL`,
add and populate `visible_result_groups.item_count/action_count/
tombstone_commitment`, `current_user_batches.item_count/tombstone_commitment`,
and `turn_authority_lineages.attempt_count/attempt_commitment`. Add
`visible_result_groups.redaction_delivery_count/
redaction_delivery_commitment` as null for every live source group,
add nullable relay-message/redaction request/acknowledgement columns to
`cloud_deliveries`, add zero-valued clear cursor columns to existing lanes, and
create the exact empty `conversation_clear_controls` authority table,
compare source/destination counts, per-row logical checksums, and every derived
parent commitment, replace the old
tables, recreate indexes/foreign keys, and write `PRAGMA user_version=13` last.
Do not add `turn_kind`: `turns.rollout_key` already exists before v13 and is
copied unchanged. Backfill the lineage commitment from that validated column,
not from JSON extraction after redaction.
Add deterministic fault boundaries after create/alter, each table copy,
each parent commitment backfill, count/checksum/commitment verification,
old-table rename/drop, new-table rename, index
creation, and version write.

Change migration CLI report output from `v12InvariantSummary` to
`v13InvariantSummary`. A dry-run must still require a different clone path.
Source raw hash, logical snapshot, schema, row counts, and user version must
remain unchanged.

New open v13 canonical commits use `pc-visible-commit-v2`; its canonical input
descriptor is exactly:

```js
input: {
  userBatchId: input.expectedLatestUserBatchId,
  visibilitySequence: Number(input.inputVisibilitySequence),
  clearEpoch: Number(input.inputClearEpoch)
}
```

The v1 canonicalizer remains immutable and omits `clearEpoch`. A migrated v1
receipt must have `turn.inputClearEpoch===0` and replay against v1; a new open
turn must not create another v1 receipt.

- [ ] **Step 4: Run the migration suite green and reopen every fixture**

Run the Step 2 command twice.

Expected: all tests PASS both times; every successful database reports
`userVersion:13`; every rejected source has an identical before/after snapshot.

- [ ] **Step 5: Add red group-scoped and current-state tests**

Add to `store-visible-authority-v13.test.mjs`:

```js
test('two sequential state patches keep both manifests valid and only latest owns current state',
  () => withAuthorityV13(store => {
    const first = commitCanonical(store, { messageId: 'msg_1', mood: 'engaged' });
    const second = commitCanonical(store, { messageId: 'msg_2', mood: 'warm' });
    assert.equal(store.getCognitiveState('yuqi').lastAuthorityGroupId,
      second.visibleGroupId);
    assert.equal(store.assertVisibleGroupAuthorityInternal(first.visibleGroupId, {
      purpose: 'reopen'
    }).status, 'live');
    assert.equal(store.assertVisibleGroupAuthorityInternal(second.visibleGroupId, {
      purpose: 'reopen'
    }).status, 'live');
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
    assertRestartPasses(store);
  }));

test('delivery validates one group without invoking the whole database invariant',
  () => withCommittedAuthorityV13(({ store, receipt, peerId }) => {
    let globalCalls = 0;
    let scopedCalls = 0;
    const full = store.assertVisibleAuthorityV13Invariants.bind(store);
    const scoped = store.assertVisibleGroupAuthorityInternal.bind(store);
    store.assertVisibleAuthorityV13Invariants = (...args) => {
      globalCalls += 1;
      return full(...args);
    };
    store.assertVisibleGroupAuthorityInternal = (...args) => {
      scopedCalls += 1;
      return scoped(...args);
    };
    for (let i = 0; i < 50; i += 1) {
      store.visibleDeliveryPayload(receipt.visibleGroupId, peerId);
    }
    assert.equal(globalCalls, 0);
    assert.equal(scopedCalls, 50);
  }));
```

Add corruption cases proving the scoped validator rejects item/action semantic
mutation or deletion, message mutation, job/stance ownership mismatch, receipt
origin/version/checksum mismatch, manifest deletion, delivery checksum mismatch,
current-batch content/order/checksum corruption, and a current cognitive state
pointing to a historical or foreign-role group. Each corruption must be rejected
by both direct scoped validation and restart.

Add `buildCommitmentV13Fixture({ itemCount, actionCount, batchItemCount,
retryCount, deliveryStates })` and an allowlisted
`injectCommitmentCorruption(fixture, caseName)` helper. The helper must perform
exactly one named raw mutation transaction and must never recompute a parent
commitment; cases that remove an attempt may remove its dependent projections
in FK-safe order inside that one transaction. Run at least:

```js
for (const corruption of [
  'delete_last_visible_item',
  'delete_middle_visible_item',
  'delete_only_visible_action',
  'change_visible_item_checksum',
  'change_group_item_count',
  'change_group_action_count',
  'change_group_tombstone_commitment',
  'delete_last_batch_item',
  'delete_middle_batch_item',
  'change_batch_tombstone_commitment',
  'delete_original_attempt_from_retry_lineage',
  'delete_middle_retry_attempt',
  'null_attempt_rollout_key',
  'change_attempt_rollout_key',
  'change_lineage_attempt_count',
  'change_lineage_attempt_commitment'
]) {
  test(`scoped and restart validation reject ${corruption}`, () => {
    const fixture = buildCommitmentV13Fixture({
      itemCount: 3,
      actionCount: corruption === 'delete_only_visible_action' ? 1 : 2,
      batchItemCount: 3,
      retryCount: 2
    });
    injectCommitmentCorruption(fixture, corruption);
    assert.throws(
      () => fixture.store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }),
      /canonical .* authority/
    );
    fixture.store.close();
    assert.throws(() => new YuqiStore(fixture.path), /v13 invariant/);
  });
}
```

Add a separate valid `actionCount:0` fixture and require its empty action-set
commitment to survive restart and redaction. This proves “zero by design” is
distinguishable from “all action tombstones deleted.”
Add delivery fixtures for zero rows, one waiting row with explicit null
`relayMessageId`, one mailboxed row, and one confirmed row. Redaction preserves
all four cardinalities; only the latter two enqueue relay retraction, while
deleting any retained row fails its frozen commitment.

Add a canonical v13 automatic-skip fixture with
`kind:'PROACTIVE_CHAT'`, `visibleItems:[]`, and `actions:[]`. It must commit one
group/manifest/receipt and one terminal delivery, create no message/action row,
create no evidence-memory/consolidation job from the unsent draft, preserve an
allowed cognitive state patch and dry-run comparison descriptor, survive scoped
validation and restart, and project
`terminalDisposition:'skip'`. The same zero-item/zero-action semantic input on
`DIRECT_REPLY` must fail before any group, receipt, delivery, state, memory, or
comparison write. Add an `action_only` moment fixture and a normal visible
direct-reply fixture so all three dispositions are proven. `LIFE_PLANNING` must
be rejected by this group commit API and remain on its independent two-phase
attempt/result authority. The automatic fixture is trigger-driven: assert it
creates no `current_user_batches` row and that its lineage attempt commitment
contains the canonical null batch commitment rather than a fake empty batch.

- [ ] **Step 6: Implement one scoped validator and the corrected current-state rule**

Implement the exact design signature:

```js
assertVisibleGroupAuthorityInternal(groupId, {
  purpose,
  expectedLineageKey = null,
  expectedTurnId = null,
  expectedOrigin = null,
  expectedPayloadVersion = null,
  expectedCommitChecksum = null
})
```

For a live group it must validate the complete target closure and return
`{ status:'live', group, receipt, manifest }`. For a redacted group it must
validate the tombstone closure and return `status:'redacted'`, except
`purpose:'delivery'`, which throws `canonical visible result is redacted`.

Refactor `assertVisibleAuthorityV13Invariants()` into:

1. exact v13 schema/index/FK and global cardinality/orphan/domain checks;
2. one global current-state query requiring every non-null
   `last_authority_group_id` to identify the same role and `last_turn_id`;
3. stable enumeration of every group, calling the scoped validator once.

The scoped live-state check compares a cognitive row only when that row's
`last_authority_group_id` equals the target group. It must not require every
historical `manifest.statePatch` to retain a current row.

Before branching on live/redacted semantics, the scoped validator must:

1. load all lineage attempts and require their count/ordered tuple hash to equal
   `attempt_count/attempt_commitment`; the tuple's logical `turnKind` comes only
   from persisted `turns.rollout_key`. The live branch additionally requires
   `rollout_key === normalized envelope.kind`; the redacted branch never reads
   kind from the tombstoned envelope;
2. for every attempt with a batch, load its parent/items and require batch
   count/ordered tuple hash to equal `item_count/tombstone_commitment`; for an
   attempt without a batch, use explicit null in the lineage tuple. In the live
   branch, `envelope.message` requires exactly one batch and `envelope.trigger`
   requires none;
3. load group items/actions and require both counts plus their combined ordered
   tuple hash to equal the group parent fields;
4. derive terminal disposition from the persisted `turns.rollout_key` and
   validated row sets: `DIRECT_REPLY` requires at least one item; automatic kinds map
   item>0 to `visible`, item=0/action>0 to `action_only`, and both zero to
   `skip`; `LIFE_PLANNING` is rejected because it has a separate result
   authority. A derived `skip` must have no evidence-memory/consolidation job
   descriptor, though a pinned state patch and compare descriptor remain legal.
   Never accept a caller/model-supplied disposition.

The live branch additionally recomputes every semantic child checksum and the
manifest/receipt checksum. The redacted branch never tries to invert child
checksums into cleared content, but it performs all four parent commitment
checks before returning metadata.

Change `visibleDeliveryPayload()` to call only the scoped validator with
`purpose:'delivery'`, then construct payload from the validated returned rows.
It returns the derived `terminalDisposition`; a valid `skip` payload still
closes the remote turn but contains no reply part or action and cannot create a
notification. Do not call any whole-database invariant from the delivery loop.

- [ ] **Step 7: Add red existing-receipt replay tests**

Add to `visible-result-commit.test.mjs`:

```js
test('exact commit replay rejects an in-process corrupted manifest', () =>
  withCommittedInput(({ store, input, receipt }) => {
    rawMutateManifest(store, receipt.visibleGroupId);
    assert.throws(() => commitVisibleResult(input), /canonical commit authority conflict/);
  }));

test('same-turn create and committed retry replay share manifest closure', () =>
  withCommittedInput(({ store, creationInput, retryInput, receipt }) => {
    rawDeleteManifest(store, receipt.visibleGroupId);
    assert.throws(
      () => store.createCanonicalVisibleTurnInternal(creationInput),
      /canonical commit authority conflict/
    );
    assert.throws(
      () => store.createCanonicalVisibleTurnInternal(retryInput),
      /canonical commit authority conflict/
    );
  }));

test('redacted committed lineage returns metadata-only redacted outcome', () =>
  withRedactedAuthorityV13(({ store, creationInput, input, receipt }) => {
    const commitReplay = commitVisibleResult(input);
    const createReplay = store.createCanonicalVisibleTurnInternal(creationInput);
    assert.equal(commitReplay.status, 'redacted');
    assert.equal(createReplay.status, 'redacted');
    assert.equal(JSON.stringify(commitReplay).includes('replyParts'), false);
    assert.equal(JSON.stringify(createReplay).includes('actions'), false);
    assert.throws(
      () => store.visibleDeliveryPayload(receipt.visibleGroupId, 'phone'),
      /redacted/
    );
  }));

test('v1 receipt replay stays stable while every new v13 commit uses v2', () =>
  withMigratedV1AndFreshV13(({ migrated, fresh }) => {
    assert.equal(commitVisibleResult(migrated.input).commitPayloadVersion,
      'pc-visible-commit-v1');
    assert.equal(commitVisibleResult(fresh.input).commitPayloadVersion,
      'pc-visible-commit-v2');
    assert.equal(fresh.input.inputClearEpoch, 3);
  }));

test('clear epoch is a fresh-turn authority pin and an inherited retry pin', () =>
  withLaneAtClearEpoch(3, lane => {
    assert.throws(() => createFresh({ inputClearEpoch: 2 }), /clear epoch authority/);
    const original = createFresh({ inputClearEpoch: 3 });
    assert.equal(original.turn.inputClearEpoch, 3);
    assert.throws(() => createRetry(original.turn, { inputClearEpoch: 4 }),
      /retry immutable authority/);
    assert.equal(createRetry(original.turn, { inputClearEpoch: 3 })
      .turn.inputClearEpoch, 3);
  }));

test('redacted cancelled lineage with no receipt suppresses stale original and retry', () =>
  withRedactedCancelledLineageV13(({ store, originalInput, retryInput }) => {
    const original = store.createCanonicalVisibleTurnInternal(originalInput);
    const retry = store.createCanonicalVisibleTurnInternal(retryInput);
    assert.equal(original.status, 'redacted');
    assert.equal(original.receipt, null);
    assert.equal(retry.status, 'redacted');
    assert.equal(retry.receipt, null);
    assert.equal(store.listRecoverableTurns().length, 0);
    assert.equal(store.listPendingAuthorityCloudDeliveries().length, 0);
  }));
```

The retry fixture must first validate its normalized batch, parent, lineage, and
immutable pins. For a redacted lineage, recompute every incoming batch item hash
and compare it with retained tombstone checksums; never require cleared
`message_json`, and never skip input validation. It may bypass current
rollout/lane/agency only after those immutable checks, exactly as Task 10D
requires.

- [ ] **Step 8: Implement one existing-commit outcome reader**

Add:

```js
readCanonicalCommitOutcomeInternal({
  lineageKey,
  expectedTurnId = null,
  expectedOrigin = null,
  expectedPayloadVersion = null,
  expectedCommitChecksum = null
})
```

For committed lineage it must join lineage, authoritative turn, group, receipt,
and manifest; invoke `assertVisibleGroupAuthorityInternal(...,
{purpose:'receipt_replay', ...})`; then compare every non-null expected field.
Return metadata-only
`{status:'already_committed', receipt}` for live and
`{status:'redacted', receipt}` for redacted.
For `state='cancelled' + redacted_at!=NULL` with no group/receipt, validate all
lineage attempt/batch/message tombstones and return
`{status:'redacted', receipt:null, lineage}`. Never return redacted for an
ordinary cancelled lineage.
Only after closure is established may `commitVisibleResult()` choose the
canonicalizer named by the stored receipt. For an open turn it must require
`inputClearEpoch===turn.inputClearEpoch` and always construct
`pc-visible-commit-v2`.
Add `inputClearEpoch` to the explicit retry inherited-pin list and v13 reopen
checks. Fresh private-chat creation must equal the persisted lane clear epoch;
protocol-v2 input may use 0 only while the lane epoch is 0.

Canonical creation and commit writers must become the only production writers
of the new parent commitments:

- insert `current_user_batches.item_count/tombstone_commitment` in the same
  transaction as its items; trigger-driven turns create no synthetic empty
  batch and contribute explicit null to their lineage attempt tuple;
- original creation first derives `turns.rollout_key` from the validated
  envelope, rejects any caller mismatch, inserts it with the turn, then inserts
  lineage `attempt_count=1` and the commitment over attempt 1 using that
  persisted key as `turnKind`;
- retry creation computes the complete previous+new ordered attempt set, then
  updates `latest_turn_id`, lineage `revision`, `attempt_count`, and
  `attempt_commitment` in the existing one-row CAS; retry must inherit the
  parent `rollout_key`, and a stale CAS leaves no new turn/batch;
- canonical terminal-result commit computes
  `item_count/action_count/tombstone_commitment` from the
  already normalized semantic result and inserts them with the group before any
  item/action projection row; it accepts the validated zero/zero automatic-skip
  case, but rejects empty `DIRECT_REPLY` and all `LIFE_PLANNING` calls;
- commit, cancel, replay, requeue, and redaction never “repair” these fields from
  whatever child rows happen to remain.

Replace every direct existing-receipt return in:

- `commitVisibleResult()`;
- exact same-turn replay;
- fresh original encountering a committed lineage;
- retry encountering a committed lineage.

No fast path may call `getVisibleCommitReceipt()` and return it without this
closure. Preserve the required ordering: immutable envelope/batch/parent/pins
first, committed outcome second, mutable rollout/lane/agency checks only for an
open attempt.

- [ ] **Step 9: Add red v13 audit-shell and privacy-leak tests**

In `store-visible-authority-v13.test.mjs`, add a raw fixture helper that converts
one committed live group into the exact v13 shell in one test transaction. It
must retain item/action IDs and checksums while nulling their semantic columns.

Add:

```js
test('a complete v13 redacted audit shell is restart-valid and non-deliverable', () => {
  const {
    path, groupId, turnId, lineageKey,
    expectedRolloutKey, expectedAttemptCommitment
  } = buildRedactedV13Fixture();
  const store = new YuqiStore(path);
  const turn = rows(store, 'turns').find(row => row.turn_id === turnId);
  const lineage = rows(store, 'turn_authority_lineages')
    .find(row => row.lineage_key === lineageKey);
  assert.equal(turn.rollout_key, expectedRolloutKey);
  assert.equal(JSON.parse(turn.envelope_json).kind, undefined);
  assert.equal(lineage.attempt_commitment, expectedAttemptCommitment);
  assert.equal(store.assertVisibleGroupAuthorityInternal(groupId, {
    purpose: 'reopen'
  }).status, 'redacted');
  assert.throws(() => store.visibleDeliveryPayload(groupId, 'phone'), /redacted/);
  store.close();
  assert.doesNotThrow(() => new YuqiStore(path).close());
});

for (const corruption of [
  'delete_redacted_item_tail',
  'delete_redacted_item_middle',
  'delete_all_redacted_actions',
  'delete_redacted_batch_tail',
  'delete_redacted_batch_middle',
  'delete_redacted_original_attempt',
  'delete_redacted_retry_attempt',
  'null_redacted_rollout_key',
  'change_redacted_rollout_key',
  'delete_redaction_mailboxed_delivery',
  'delete_redaction_confirmed_delivery',
  'change_redaction_relay_message_id'
]) {
  test(`redacted parent commitment rejects ${corruption}`, () => {
    const fixture = buildRedactedV13Fixture({
      itemCount: 3,
      actionCount: 2,
      batchItemCount: 3,
      retryCount: 2,
      deliveryStates: ['mailboxed', 'confirmed']
    });
    injectCommitmentCorruption(fixture, corruption);
    assert.throws(() => new YuqiStore(fixture.path), /redacted authority/);
  });
}

test('redacted zero-action group retains an explicit empty-set commitment', () => {
  const fixture = buildRedactedV13Fixture({ actionCount: 0 });
  const store = new YuqiStore(fixture.path);
  const group = rows(store, 'visible_result_groups')
    .find(row => row.group_id === fixture.groupId);
  assert.equal(group.action_count, 0);
  assert.match(group.tombstone_commitment, /^[a-f0-9]{64}$/);
  assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
    purpose: 'reopen'
  }).status, 'redacted');
  store.close();
});

test('redacted automatic skip retains explicit zero item and action sets', () => {
  const fixture = buildRedactedV13Fixture({
    kind: 'PROACTIVE_CHAT', itemCount: 0, actionCount: 0
  });
  const store = new YuqiStore(fixture.path);
  const authority = store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
    purpose: 'reopen'
  });
  assert.equal(authority.status, 'redacted');
  assert.equal(authority.group.itemCount, 0);
  assert.equal(authority.group.actionCount, 0);
  store.close();
});

for (const leak of [
  'turn_envelope_json',
  'turn_memory_packet_json',
  'turn_brain_draft_json',
  'turn_supervisor_json',
  'turn_reply_json',
  'turn_error_json',
  'turn_annotation_snapshot_json',
  'turn_route_reasons_json',
  'current_batch_message_json',
  'user_message_content',
  'message_content',
  'annotation_json',
  'diagnostic_detail_json',
  'sync_log_payload',
  'codex_session_link',
  'redacted_cancelled_lineage_recoverable_turn',
  'redacted_legacy_turn_recovery_or_outbox',
  'item_json',
  'action_kind',
  'action_target',
  'action_json',
  'manifest_semantic_json',
  'waiting_delivery',
  'mailboxed_payload_json',
  'confirmed_payload_json',
  'authority_group_job',
  'active_stance_head',
  'current_cognitive_state_owner',
  'lane_latest_group'
]) {
  test(`redacted shell rejects ${leak}`, () => {
    const fixture = buildRedactedV13Fixture();
    injectRedactionLeak(fixture, leak);
    assert.throws(() => new YuqiStore(fixture.path), /redacted authority/);
  });
}
```

Also prove mixed live and redacted groups preserve global cardinality, backup
summary counts, deterministic item/action IDs, and receipt/manifest checksum
identity without exposing the cleared semantic JSON. The redaction fixture must
freeze `redaction_delivery_count/commitment` before it clears delivery payloads;
it may not manufacture those fields after a delivery row has already been
deleted.

- [ ] **Step 10: Implement v13 live/redacted branches without weakening live closure**

Update row mappers so nullable semantic fields remain `null`; do not coerce them
to `{}` or empty strings. The live branch preserves all Task 10E semantic hash,
projection, identity, job, stance, state, message, delivery, and receipt checks.
Replace the old one-version origin rule with this closed matrix:

```text
pc               + pc-visible-commit-v1       -> historical, clearEpoch=0 only
pc               + pc-visible-commit-v2       -> current
android_fallback + android-fallback-commit-v1 -> historical, clearEpoch=0 only
android_fallback + android-fallback-commit-v2 -> current
anything else                                    reject
```

The v13 caller of inherited v11/v12 checks must pass an explicit
`allowVersionThirteen` mode. In that mode, the old
`receipt_payload_origin` query uses the matrix above and live item/batch checks
understand v13 nullable columns; it must not run the old “v1 only” predicate
first and make every valid v2 receipt unreopenable.

The redacted branch requires:

- group and manifest have the same non-null redaction time;
- manifest semantic JSON is null and its original checksum still equals receipt;
- every turn in the lineage has the same `authority_redacted_at`, exact
  `envelope_json={"redacted":true}`, null memory/draft/supervisor/reply/error
  working fields, empty route reasons, `{}` annotation snapshot, and retains
  only the original envelope checksum;
- every version-1 attempt retains a non-null `turns.rollout_key` in
  `CANONICAL_RESULT_TURN_KINDS`; the validator projects that column as
  `turn_kind`, recomputes the lineage commitment from it, and derives terminal
  disposition from it. Clearing must never null or rewrite `rollout_key`, and
  this branch must not read kind from the tombstoned envelope;
- lineage `attempt_count/attempt_commitment` exactly covers every original/retry
  turn in revision order and each attempt's retained batch commitment;
- every current-batch item for those turns retains identity/order/checksum but
  has null `message_json` and the same redaction time; every batch parent count
  and commitment exactly covers those rows;
- all linked user and character message content is empty, and no old sync-log
  payload, annotation, or diagnostic for those turn/message identities remains;
- the role has no `sessions` row retaining the old Codex conversation thread;
- a redacted cancelled canonical lineage has no group/receipt/delivery/job and
  no recoverable attempt; a redacted Yuqi authority-version-0 turn cannot appear
  in legacy recovery or legacy outbox queries;
- item rows are contiguous, retain deterministic message IDs/checksums, and have
  null `item_json` plus the same redaction time; group `item_count` and the
  item half of its commitment cover the complete set;
- action rows are contiguous, retain deterministic action IDs/checksums, and
  have null kind/target/revision/action JSON plus the same redaction time; group
  `action_count` explicitly distinguishes zero actions from deleted tombstones
  and the action half of its commitment covers the complete set;
- every group delivery has null payload/checksum and retains the receipt's
  authority commit checksum; its state is either `redaction_pending` with
  non-null request time and relay message ID, or `redacted` with a non-null
  acknowledgement time; a never-enqueued row may be directly `redacted` with
  null relay message ID and acknowledgement time equal to its redaction time;
  the complete immutable delivery set equals the frozen
  `redaction_delivery_count/commitment`, including the explicit empty set;
- no consolidation job remains for the group;
- no active stance head, current cognitive state, or lane cursor points at it.

The live→redacted transaction must first pass the live scoped validator, compute
the delivery commitment from the locked pre-clear rows, and CAS the group from
`redacted_at IS NULL AND redaction_delivery_commitment IS NULL` to the frozen
redaction fields. Only then may it clear payload/semantic columns. Any failure
rolls back both the freeze and the tombstones. Retraction completion updates
state/acknowledgement only; it must retain the delivery row and its immutable
identity after relay deletion succeeds.

Exclude redacted groups only from v11-era *live projection* checks; do not skip
lineage/group/receipt/manifest cardinality, deterministic tombstone identity,
origin/version/checksum, or orphan checks.

- [ ] **Step 11: Add and verify mixed outbox performance accounting**

In `result-outbox.test.mjs`, keep the Task 10E global-age fairness cases and add:

```js
test('fifty canonical sends perform fifty scoped validations and zero full scans',
  async () => {
    const fixture = canonicalOutboxFixture({ count: 50 });
    await fixture.outbox.flushOnce(50);
    assert.equal(fixture.validationCounts.fullDatabase, 0);
    assert.equal(fixture.validationCounts.groupScoped, 50);
    assert.equal(fixture.fetchOrder.length, 50);
  });

test('mailboxed canonical delivery persists the deterministic relay message id',
  async () => {
    const fixture = canonicalOutboxFixture({ count: 1 });
    await fixture.outbox.flushOnce(1);
    const row = fixture.store.outboxForGroup(fixture.groupId)[0];
    assert.equal(row.relayMessageId, fixture.fetchBodies[0].messageId);
  });
```

The outbox must continue to request up to `limit` from each isolated pending
query, globally sort, and slice. It must not cache a previously validated group
across a later database mutation; the optimization is scope reduction, not
validation removal. Corruption remains a failed delivery with a diagnostic
authority code and never an encrypted relay payload. On successful enqueue it
must persist the exact deterministic relay `messageId` in the same mailboxed
state update; Task 20 uses that ID for durable retraction.
`visibleDeliveryPayload()` must copy the authoritative turn's
`inputVisibilitySequence` and `inputClearEpoch` so Android can reject late
pre-clear results without trusting relay arrival order.

- [ ] **Step 12: Run the complete Task 10F gate**

Run:

```powershell
node --test yuqi-runtime/test/agency-state.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs tests/yuqi-agency-state-migration.test.mjs
```

Expected: all 228 Task 10E tests plus every Task 10F test PASS, with 0 fail and
0 skipped. Record the exact total; do not waive a lower count.

Then run and preserve exact output for these manual counterexamples:

1. two sequential state-patch commits, direct delivery of the second group, and
   restart all pass while only the second owns current cognitive state; both new
   receipts are `pc-visible-commit-v2` and carry the pinned clear epoch;
2. post-open manifest mutation makes exact commit, same-turn create, original
   create, and retry committed replay all reject;
3. a valid redacted shell reopens but direct delivery and every replay return no
   semantic content;
   a cancelled redacted lineage without a receipt returns metadata-only
   `status=redacted` and never re-enters recovery;
4. each of turn envelope/working output, input batch JSON, user/character message,
   annotation/diagnostic/sync-log payload, old Codex session link, mailboxed
   payload, confirmed payload, item semantic, action semantic, job, active
   stance, current state, and lane leak is rejected;
5. for both live and redacted fixtures, deleting a tail/middle/all child from
   item/action/batch, deleting original/retry attempts, or deleting
   mailboxed/confirmed delivery rows is rejected; nulling or changing any
   canonical attempt's persisted `rollout_key` is rejected even though its
   redacted envelope contains no kind; a legitimate automatic
   zero-item/zero-action skip and zero-delivery set reopens with explicit
   empty-set commitments, while the same empty result for `DIRECT_REPLY` is
   rejected without writes;
6. 50 repeated canonical delivery loads report `fullDatabaseScans=0` and
   `groupScopedValidations=50`;
7. populated v12 with two historical state patches, multi-message batches,
   original+two retries, and v1 receipts migrates to
   v13, replays v1 unchanged, creates only v2 afterward, and restarts;
8. raw redacted/corrupt v12 refuses without changing user version, schema, row
   counts, or logical checksum;
9. every forced v13 migration fault leaves the exact source snapshot intact.

- [ ] **Step 13: Commit and stop for independent review**

```powershell
git add docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md yuqi-runtime/src/store.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/result-outbox.mjs scripts/migrate-yuqi-agency-state.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/canonical-turn-state.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs tests/yuqi-agency-state-migration.test.mjs
git commit -m "fix: close v13 result lifecycle authority"
```

After the implementation commit, stop. Report the commit, exact full-gate total,
all nine manual outputs, migration before/after snapshots, full/scoped
validation counts, and every interface deviation. Do not start Task 11 until the
plan owner independently reviews Task 10F and explicitly releases it.

### Task 11: Integrate v3, Lanes, Shadow, and Recovery in the Runtime

**Files:**
- Create: `yuqi-runtime/src/release-pair.mjs`
- Create: `yuqi-runtime/src/comparison-contract.mjs`
- Create: `yuqi-runtime/src/release-executor.mjs`
- Create: `yuqi-runtime/src/production-release-adapters.mjs`
- Create: `yuqi-runtime/src/runtime-composition.mjs`
- Modify: `yuqi-runtime/src/promotion-controller.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/turn-dispatcher.mjs`
- Modify: `yuqi-runtime/src/shadow-dispatcher.mjs`
- Modify: `yuqi-runtime/src/life-planning-dispatcher.mjs`
- Modify: `yuqi-runtime/src/reconcile.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Modify: `scripts/migrate-yuqi-agency-state.mjs`
- Create: `yuqi-runtime/test/release-pair.test.mjs`
- Create: `yuqi-runtime/test/comparison-contract.test.mjs`
- Create: `yuqi-runtime/test/release-executor.test.mjs`
- Create: `yuqi-runtime/test/production-release-adapters.test.mjs`
- Create: `yuqi-runtime/test/runtime-composition.test.mjs`
- Modify: `yuqi-runtime/test/promotion-controller.test.mjs`
- Create: `yuqi-runtime/test/store-release-authority-v14.test.mjs`
- Modify: `yuqi-runtime/test/store-cognition-migration.test.mjs`
- Modify: `yuqi-runtime/test/store-agency-v10.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v11.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/test/turn-dispatcher.test.mjs`
- Modify: `yuqi-runtime/test/shadow-dispatcher.test.mjs`
- Modify: `yuqi-runtime/test/life-planning-attempt.test.mjs`
- Create: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`
- Modify: `tests/yuqi-agency-state-migration.test.mjs`
- Modify: `tests/yuqi-deployment-contract.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 7, 9, 10, 10A, 10B, 10C, 10D, 10E, and 10F.
- Produces: one release-pinned dispatch path for all ten rollout keys; nine
  turn-based keys use the first production call to
  `createCanonicalVisibleTurnInternal()` under the explicit eligibility rule
  below, while `LIFE_PLANNING` uses its pre-existing two-phase attempt/result
  authority; receipt-derived bridge results; background comparisons created
  inside the applicable authoritative result transaction only after the checksum
  is deterministic; one pure release-pair resolver shared by the controller and
  both store-owned creation transactions; and persisted release IDs/checksums for
  life-planning attempts. Produces PC schema v14, whose only schema delta from
  v13 is retry-safe canary-slot ownership indexes; v13 visible/redaction
  semantics remain unchanged. Produces one pure fresh-comparison contract that
  distinguishes the persisted compatibility mode, release-aware direction, and
  job type without allowing any caller to equate the three namespaces. Produces
  one side-effect-free production composition factory that constructs exactly
  one complete release executor per PC process and injects the same object into
  authoritative turn execution, life execution, and background comparison
  before the runtime becomes reachable.

Task 11, not Task 23, owns the read-only release-pair contract needed to create
work. Task 23 owns candidate registration, phase mutation, promotion commands,
quality fuses, graduation, and rollback. No orchestrator or dispatcher may
reimplement the phase switch.

The pre-existing `PromotionController.createTurn()` and
`store.createTurnWithRolloutInternal()` remain a sealed result-authority-version-0
compatibility adapter for ineligible/old callers only. Task 11 must not route a
canonical Yuqi subject through them, mutate their row to version 1 afterward, or
copy their `current_mode` switch into new code. Their historical recovery and
wire-v1 behavior remain covered by compatibility tests; Task 23 tests exercise
the Task 11 orchestrator, not this legacy creator.

- [ ] **Step 1: Write red orchestration tests for release direction and recovery**

```js
test('shadow shows stable and queues candidate only after stable commit', async () => {
  rollout('DIRECT_REPLY', { phase: 'shadow', stable: 'r2', candidate: 'r3' });
  const result = await orchestrator.execute(directEnvelope());
  assert.equal(result.authoritativeReleaseId, 'r2');
  assert.equal(result.visible, true);
  const job = store.getComparisonJobForTurn(result.turnId);
  assert.equal(job.payload.comparisonReleaseId, 'r3');
  assert.equal(job.payload.authoritativeResultChecksum, result.commitChecksum);
});

test('canary shows candidate and runs stable as dry-run', async () => {
  rollout('DIRECT_REPLY', { phase: 'canary', stable: 'r2', candidate: 'r3' });
  const result = await orchestrator.execute(directEnvelope());
  assert.equal(result.authoritativeReleaseId, 'r3');
  assert.equal(store.getComparisonJobForTurn(result.turnId).payload.comparisonReleaseId, 'r2');
  assert.equal(store.actionsByRelease('r2').length, 0);
});

test('restart resumes the release pair and lane revision pinned at turn creation', async () => {
  const turn = createThenCrashBeforeModel();
  changeRolloutToRollback();
  const recovered = await newRuntime().recover(turn.turnId);
  assert.equal(recovered.authoritativeReleaseId, turn.authoritativeReleaseId);
  assert.equal(recovered.laneRevision, turn.laneRevision);
});

test('life compare is queued only in the authoritative result transaction', async () => {
  const attempt = controller.createLifePlanningAttempt(lifeInput());
  assert.equal(store.getComparisonJobForLife(attempt.planningId), null);
  controller.commitLifePlanningAuthoritativeResult(validLifeResult(attempt));
  assert.ok(store.getComparisonJobForLife(attempt.planningId));
  assert.equal(store.spy.createCanonicalVisibleTurnInternal.calls.length, 0);
  assert.equal(store.visibleGroupsForLife(attempt.planningId).length, 0);
});

test('automatic skip commits one terminal group without bubbles actions or notification', async () => {
  const result = await orchestrator.execute(proactiveEnvelopeWithNoMotive());
  assert.equal(result.terminalDisposition, 'skip');
  assert.equal(result.visible, false);
  assert.deepEqual(result.replyParts, []);
  assert.deepEqual(result.actions, []);
  assert.equal(store.visibleGroupsForLineage(result.authorityLineageKey).length, 1);
  assert.equal(notifications.count(), 0);
});

test('direct reply cannot enter the automatic zero-result authority path', async () => {
  model.returnSkipFor(directEnvelope());
  await assert.rejects(() => orchestrator.execute(directEnvelope()), /DIRECT_REPLY.*empty/);
  assert.equal(store.visibleGroupsForSource('direct-source').length, 0);
});

test('new Yuqi protocol-v2 execution uses canonical authority independent of wire v3', async () => {
  const result = await orchestrator.execute(directEnvelope({ protocolVersion: 2 }));
  assert.equal(store.getTurn(result.turnId).resultAuthorityVersion, 1);
  assert.equal(store.spy.createCanonicalVisibleTurnInternal.calls.length, 1);
  assert.equal(store.spy.createTurnWithReleasePinInternal.calls.length, 0);
});

test('wire v1, non-Yuqi, and recovered version-0 turns never enter canonical creation', async () => {
  await orchestrator.execute(protocolV1Envelope());
  await orchestrator.execute(nonYuqiEnvelope());
  await orchestrator.recover(existingVersionZeroTurn().turnId);
  assert.equal(store.spy.createCanonicalVisibleTurnInternal.calls.length, 0);
  assertLegacyCompatibilityResults();
});

test('recovery dispatches by persisted resultAuthorityVersion and never recreates a turn', async () => {
  const oldResult = await newRuntime().recover(existingVersionZeroTurn().turnId);
  const canonicalResult = await newRuntime().recover(existingVersionOneTurn().turnId);
  assert.equal(oldResult.recoveryPath, 'legacy');
  assert.equal(canonicalResult.recoveryPath, 'canonical');
  assert.equal(store.spy.createCanonicalVisibleTurnInternal.calls.length, 0);
});

test('redacted committed replay is terminal and never re-enters model or outbox', async () => {
  seedRedactedCanonicalLineage();
  const result = await orchestrator.execute(exactOriginalEnvelope());
  assert.equal(result.status, 'redacted');
  assert.equal(result.terminal, true);
  assert.equal(result.visible, false);
  assert.deepEqual(result.replyParts, []);
  assert.deepEqual(result.actions, []);
  assert.equal(model.calls.length, 0);
  assert.equal(store.listPendingAuthorityCloudDeliveries().length, 0);
});

test('one pure resolver owns stable shadow canary and rollback release direction', () => {
  assert.deepEqual(resolvePipelinePair(rollout({ candidatePhase: 'none' })), {
    visibleReleaseId: 'stable-r2', comparisonReleaseId: null,
    comparisonDirection: null, candidatePhase: 'none'
  });
  assert.deepEqual(resolvePipelinePair(rollout({
    candidatePhase: 'none', candidateReleaseId: null
  })), {
    visibleReleaseId: 'stable-r2', comparisonReleaseId: null,
    comparisonDirection: null, candidatePhase: 'none'
  });
  assert.deepEqual(resolvePipelinePair(rollout({ candidatePhase: 'shadow' })), {
    visibleReleaseId: 'stable-r2', comparisonReleaseId: 'candidate-r3',
    comparisonDirection: 'stable_authoritative_candidate_compare',
    candidatePhase: 'shadow'
  });
  assert.equal(resolvePipelinePair(rollout({
    candidatePhase: 'canary', canaryStartedCount: 9
  })).comparisonReleaseId, 'stable-r2');
  assert.equal(resolvePipelinePair(rollout({
    candidatePhase: 'canary', canaryStartedCount: 10
  })).comparisonReleaseId, null);
  assert.deepEqual(resolvePipelinePair(rollout({ candidatePhase: 'rolled_back' })), {
    visibleReleaseId: 'stable-r2', comparisonReleaseId: null,
    comparisonDirection: null, candidatePhase: 'rolled_back'
  });
  assert.throws(() => resolvePipelinePair(rollout({
    candidatePhase: 'canary', canaryStartedCount: 11
  })), /invalid rollout release authority/);
});

test('one release executor owns authoritative and dry-run adapter selection', async () => {
  const visible = await releaseExecutor.executeTurn({
    releaseId: 'candidate-r3', releaseChecksum: SHA_R3,
    execution: directExecution(), dryRun: false
  });
  const compare = await releaseExecutor.executeTurn({
    releaseId: 'candidate-r3', releaseChecksum: SHA_R3,
    execution: directExecution(), dryRun: true
  });
  assert.equal(visible.adapterId, 'cognition-v3');
  assert.equal(compare.adapterId, 'cognition-v3');
  assert.equal(compare.capabilities.visibleCommit, false);
  await assert.rejects(() => releaseExecutor.executeTurn({
    releaseId: 'candidate-r3', releaseChecksum: SHA_FORGED,
    execution: directExecution(), dryRun: false
  }), /release checksum authority conflict/);
  await assert.rejects(() => releaseExecutor.executeTurn({
    releaseId: 'unknown-pipeline-release', releaseChecksum: SHA_UNKNOWN,
    execution: directExecution(), dryRun: false
  }), /release executor unavailable/);
});

test('production adapters bind each release flavor to one explicit draft provider', async () => {
  const calls = [];
  const EXECUTION_ARGS = Object.freeze({
    release: { releaseId: 'release-fixture', presetVersion: '2.1.0' },
    execution: { subjectId: 'subject-fixture' },
    dryRun: true,
    capabilities: Object.freeze({ visibleCommit: false, action: false, state: false })
  });
  const orchestrator = {
    executeLegacyReleaseTurnDraft: input => calls.push(['legacy-turn', input]),
    executeLegacyLifeReleaseDraft: input => calls.push(['legacy-life', input]),
    executeCognitionV2LifeReleaseDraft: input => calls.push(['v2-life', input]),
    executeCognitionV3LifeReleaseDraft: input => calls.push(['v3-life', input])
  };
  const cognitivePipeline = {
    runV2ReleaseDraft: input => calls.push(['v2-turn', input]),
    runV3ReleaseDraft: input => calls.push(['v3-turn', input])
  };
  const adapters = createProductionReleaseAdapters({ orchestrator, cognitivePipeline });
  assert.deepEqual([...adapters.turnAdapters.keys()], [
    'legacy-v1', 'cognition-v2', 'cognition-v3'
  ]);
  assert.deepEqual([...adapters.lifeAdapters.keys()], [
    'legacy-v1', 'cognition-v2', 'cognition-v3'
  ]);
  await adapters.turnAdapters.get('legacy-v1').executeTurn(EXECUTION_ARGS);
  await adapters.turnAdapters.get('cognition-v2').executeTurn(EXECUTION_ARGS);
  await adapters.turnAdapters.get('cognition-v3').executeTurn(EXECUTION_ARGS);
  await adapters.lifeAdapters.get('legacy-v1').executeLife(EXECUTION_ARGS);
  await adapters.lifeAdapters.get('cognition-v2').executeLife(EXECUTION_ARGS);
  await adapters.lifeAdapters.get('cognition-v3').executeLife(EXECUTION_ARGS);
  assert.deepEqual(calls.map(([provider]) => provider), [
    'legacy-turn', 'v2-turn', 'v3-turn',
    'legacy-life', 'v2-life', 'v3-life'
  ]);
});

test('production composition injects one complete release executor before exposure', () => {
  const runtime = composeYuqiExecutionRuntime(runtimeFixture());
  assert.strictEqual(runtime.orchestrator.releaseExecutor, runtime.releaseExecutor);
  assert.strictEqual(runtime.lifePlanningDispatcher.releaseExecutor,
    runtime.releaseExecutor);
  assert.strictEqual(runtime.shadowDispatcher.releaseExecutor,
    runtime.releaseExecutor);
  assert.deepEqual(runtime.releaseExecutor.adapterIds(), {
    turn: ['legacy-v1', 'cognition-v2', 'cognition-v3'],
    life: ['legacy-v1', 'cognition-v2', 'cognition-v3']
  });
  assert.equal(runtime.orchestrator.releaseExecutorAttached, true);
  assert.throws(
    () => runtime.orchestrator.attachReleaseExecutor(new FakeReleaseExecutor()),
    /release executor already attached/
  );
});

test('release executor refuses an incomplete production adapter set at construction', () => {
  const complete = completeAdapterFixture();
  complete.turnAdapters.delete('legacy-v1');
  assert.throws(() => new ReleaseExecutor({
    store: complete.store,
    turnAdapters: complete.turnAdapters,
    lifeAdapters: complete.lifeAdapters
  }), /complete production release adapter set/);
});

test('all six release adapters return drafts and dry-run performs zero domain writes', async () => {
  for (const adapterId of ['legacy-v1', 'cognition-v2', 'cognition-v3']) {
    const fixture = productionAdapterFixture({ adapterId });
    const turn = await fixture.releaseExecutor.executeTurn({
      releaseId: fixture.releaseId,
      releaseChecksum: fixture.releaseChecksum,
      execution: fixture.turnExecution,
      dryRun: true
    });
    const life = await fixture.releaseExecutor.executeLife({
      releaseId: fixture.releaseId,
      releaseChecksum: fixture.releaseChecksum,
      execution: fixture.lifeExecution,
      dryRun: true
    });
    assert.ok(turn.draft);
    assert.ok(life.draft);
    assert.deepEqual(fixture.domainWrites(), []);
  }
});

test('main delegates the reachable runtime graph to the tested composition factory', () => {
  const source = readFileSync('yuqi-runtime/src/main.mjs', 'utf8');
  assert.match(source, /composeYuqiExecutionRuntime/);
  assert.equal((source.match(/composeYuqiExecutionRuntime\s*\(/g) || []).length, 1);
  assert.doesNotMatch(source, /new ReleaseExecutor\s*\(/);
  assert.doesNotMatch(source, /new ShadowDispatcher\s*\(/);
  assert.doesNotMatch(source, /new LifePlanningDispatcher\s*\(/);
});

test('canonical canary reserves comparison slots only for the first ten subjects', () => {
  seedCanaryRollout({ started: 9, completed: 9, target: 10 });
  const tenth = createCanonicalTurn(10);
  completeComparison(tenth);
  const eleventh = createCanonicalTurn(11);
  assert.equal(tenth.canarySlot, 10);
  assert.equal(tenth.comparisonReleaseId, 'stable-r2');
  assert.equal(eleventh.canarySlot, null);
  assert.equal(eleventh.comparisonReleaseId, null);
  assert.equal(store.getCognitionRollout('DIRECT_REPLY').canaryStartedCount, 10);
});

test('graduated active stable projection remains candidate-v3 visible without comparison', () => {
  seedRollout('DIRECT_REPLY', {
    currentMode: 'active', rolloutPhase: 'stable', candidatePhase: 'none',
    stableReleaseId: 'candidate-r3', candidateReleaseId: null
  });
  const turn = createCanonicalTurn(1);
  assert.equal(turn.pipelineMode, 'active');
  assert.equal(turn.authoritativeReleaseId, 'candidate-r3');
  assert.equal(turn.comparisonReleaseId, null);
  assert.equal(turn.canarySlot, null);
});

test('invalid compatibility and candidate phase projection has zero side effects', () => {
  seedRollout('DIRECT_REPLY', {
    currentMode: 'legacy', rolloutPhase: 'stable', candidatePhase: 'canary'
  });
  const before = snapshotCanonicalCreationRows();
  assert.throws(() => createCanonicalTurn(1), /rollout phase projection conflict/);
  assert.deepEqual(snapshotCanonicalCreationRows(), before);
});

test('life planning pins the same release pair and creates no compare before result commit', () => {
  seedShadowRollout('LIFE_PLANNING');
  const attempt = controller.createLifePlanningAttempt(lifeInput());
  assert.equal(attempt.authoritativeReleaseId, 'stable-r2');
  assert.equal(attempt.comparisonReleaseId, 'candidate-r3');
  assert.match(attempt.authoritativePipelineChecksum, /^[a-f0-9]{64}$/);
  assert.match(attempt.comparisonPipelineChecksum, /^[a-f0-9]{64}$/);
  assert.equal(store.getComparisonJobForLife(attempt.planningId), null);
  controller.commitLifePlanningAuthoritativeResult(validLifeResult(attempt));
  const job = store.getComparisonJobForLife(attempt.planningId);
  assert.equal(job.payload.authoritativeReleaseId, 'stable-r2');
  assert.equal(job.payload.comparisonReleaseId, 'candidate-r3');
});

test('comparison worker loads canonical receipt authority and executes the pinned release dry-run', async () => {
  const result = await orchestrator.execute(directEnvelope());
  overwriteNonAuthorityReplyProjection(result.turnId, { forged: true });
  const comparison = await shadowDispatcher.runOnce();
  assert.equal(comparison.input.authoritativeResultChecksum, result.commitChecksum);
  assert.equal(comparison.executedReleaseId, 'candidate-r3');
  assert.equal(store.actionsByRelease('candidate-r3').length, 0);
  assert.equal(notifications.count(), 1); // authoritative result only
});

test('life comparison worker uses attempt input/result authority without a chat turn', async () => {
  const attempt = createAndCommitShadowLifeAttempt();
  const comparison = await shadowDispatcher.runOnce();
  assert.equal(comparison.subjectType, 'life_planning');
  assert.equal(comparison.subjectId, attempt.planningId);
  assert.equal(comparison.inputChecksum, attempt.inputChecksum);
  assert.equal(comparison.authoritativeResultChecksum,
    attempt.authoritativeResultChecksum);
  assert.equal(store.getTurn(attempt.planningId), null);
  assert.equal(store.visibleGroupsForLife(attempt.planningId).length, 0);
});

test('redaction before comparison cancels without loading content or calling a model', async () => {
  const subject = createCommittedCanarySubject();
  redactCanonicalLineage(subject.authorityLineageKey);
  const result = await shadowDispatcher.runOnce();
  assert.equal(result.status, 'cancelled_redacted');
  assert.equal(model.calls.length, 0);
  assert.equal(findPlaintextForLineage(subject.authorityLineageKey), null);
  assert.deepEqual(canaryCounts(subject.rolloutKey), {
    started: 1, completed: 0, failed: 1
  });
  await shadowDispatcher.runOnce();
  assert.equal(canaryCounts(subject.rolloutKey).failed, 1);
});

test('life planning uses only ten canary comparison slots and recovers its pinned pair', () => {
  seedCanaryRollout('LIFE_PLANNING', { started: 9, completed: 9, target: 10 });
  const tenth = controller.createLifePlanningAttempt(lifeInput({ windowIndex: 10 }));
  assert.equal(tenth.canarySlot, 10);
  assert.equal(tenth.comparisonReleaseId, 'stable-r2');
  const restored = reopenRuntime();
  const recovered = restored.controller.createLifePlanningAttempt(
    lifeInput({ windowIndex: 10 })
  );
  assert.equal(recovered.planningId, tenth.planningId);
  restored.completeLifeAttemptAndComparison(recovered);
  const eleventh = restored.controller.createLifePlanningAttempt(
    lifeInput({ windowIndex: 11 })
  );
  assert.equal(eleventh.canarySlot, null);
  assert.equal(eleventh.comparisonReleaseId, null);
  assert.equal(restored.store.getCognitionRollout(
    'LIFE_PLANNING').canaryStartedCount, 10);
  assert.equal(restored.store.getComparisonJobForLife(eleventh.planningId), null);
});

test('fresh selection uses the runtime clock rather than historical interaction time', async () => {
  clock.set(2_000_000);
  const envelope = directEnvelope({ sentAt: 1_000 });
  await orchestrator.execute(envelope);
  assert.equal(promotionController.spy.lastFreshSelection.now, 2_000_000);
});

test('release-aware directions classify shadow and canary while legacy jobs still resume', () => {
  assertComparisonOutcomeDirection({
    jobType: 'shadow_cognition',
    direction: 'stable_authoritative_candidate_compare',
    expectedCounter: 'liveShadowSuccessCount',
    canonicalDescriptorOmits: ['rolloutKey', 'pipelineChecksum']
  });
  assertComparisonOutcomeDirection({
    jobType: 'active_canary_compare',
    direction: 'candidate_authoritative_stable_compare',
    expectedCounter: 'canaryCompletedCount'
  });
  assertLegacyVersionZeroComparisonJobStillCompletes(
    'legacy_authoritative_cognition_compare'
  );
  assert.throws(() => recordComparisonWithDirection({
    jobType: 'shadow_cognition',
    direction: 'candidate_authoritative_stable_compare'
  }), /comparison direction authority conflict/);
});

test('fresh comparison contract keeps database mode direction and job type distinct', () => {
  assert.deepEqual(
    comparisonContractForDirection('stable_authoritative_candidate_compare'),
    {
      comparisonMode: 'cognition_compare',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      jobType: 'shadow_cognition'
    }
  );
  assert.deepEqual(comparisonContractForMode('legacy_compare'), {
    comparisonMode: 'legacy_compare',
    comparisonDirection: 'candidate_authoritative_stable_compare',
    jobType: 'active_canary_compare'
  });
  assert.deepEqual(comparisonContractForMode('none'), {
    comparisonMode: 'none',
    comparisonDirection: null,
    jobType: null
  });
  for (const legacyAlias of [
    'legacy_authoritative_cognition_compare',
    'cognition_authoritative_legacy_compare'
  ]) {
    assert.throws(
      () => comparisonContractForDirection(legacyAlias),
      /fresh comparison contract/
    );
  }
});

test('canonical commit validates compatibility mode against release direction and job type', () => {
  const shadow = createCommittedDraftWithPinnedComparison({
    comparisonMode: 'cognition_compare',
    comparisonReleaseId: 'candidate-r3'
  });
  assert.doesNotThrow(() => commitVisibleResult({
    ...shadow.commit,
    comparisonReleaseId: 'candidate-r3',
    comparisonDirection: 'stable_authoritative_candidate_compare',
    comparisonJob: {
      ...shadow.commit.comparisonJob,
      jobType: 'shadow_cognition',
      payload: {
        ...shadow.commit.comparisonJob.payload,
        comparisonDirection: 'stable_authoritative_candidate_compare'
      }
    }
  }));
  for (const mutation of [
    { comparisonDirection: 'cognition_compare' },
    { comparisonDirection: 'legacy_authoritative_cognition_compare' },
    { comparisonDirection: 'candidate_authoritative_stable_compare' },
    { comparisonReleaseId: 'stable-r2' },
    { jobType: 'active_canary_compare' }
  ]) {
    const input = mutateComparisonCommit(shadow.commit, mutation);
    assert.throws(() => commitVisibleResult(input), /comparison authority conflict/);
  }

  const canary = createCommittedDraftWithPinnedComparison({
    comparisonMode: 'legacy_compare',
    comparisonReleaseId: 'stable-r2'
  });
  assert.doesNotThrow(() => commitVisibleResult(withComparisonContract(canary.commit, {
    comparisonDirection: 'candidate_authoritative_stable_compare',
    jobType: 'active_canary_compare'
  })));

  const stable = createCommittedDraftWithPinnedComparison({
    comparisonMode: 'none',
    comparisonReleaseId: null
  });
  assert.doesNotThrow(() => commitVisibleResult({
    ...stable.commit,
    comparisonReleaseId: null,
    comparisonDirection: null,
    comparisonJob: null
  }));
  assert.throws(() => commitVisibleResult({
    ...stable.commit,
    comparisonReleaseId: 'candidate-r3',
    comparisonDirection: 'stable_authoritative_candidate_compare'
  }), /comparison authority conflict/);
});

test('stale or caller-invented release pairs have zero creation side effects', () => {
  const before = snapshotCanonicalCreationRows();
  assert.throws(() => createCanonicalTurnWithPair({
    visibleReleaseId: 'candidate-r3',
    comparisonReleaseId: 'stable-r2',
    comparisonDirection: 'candidate_authoritative_stable_compare'
  }), /rollout release pair conflict|rollout revision conflict/);
  assert.deepEqual(snapshotCanonicalCreationRows(), before);
  const lifeBefore = snapshotLifeAttemptAndRolloutRows();
  assert.throws(() => createLifeAttemptAfterSelectionRace(), /rollout.*conflict/);
  assert.deepEqual(snapshotLifeAttemptAndRolloutRows(), lifeBefore);
});

test('retryable canonical failure keeps one lineage slot until retry comparison completes', () => {
  seedCanaryRollout('DIRECT_REPLY', { started: 0, completed: 0, failed: 0 });
  const original = createCanonicalTurn(1);
  failCanonicalTurnRetryable(original);
  const retry = createCanonicalRetry(original);
  assert.equal(retry.canarySlot, original.canarySlot);
  assert.equal(retry.authorityLineageKey, original.authorityLineageKey);
  assert.deepEqual(canaryCounts('DIRECT_REPLY'), {
    started: 1, completed: 0, failed: 0
  });
  commitAndCompleteComparison(retry);
  replayComparisonCompletion(retry);
  assert.deepEqual(canaryCounts('DIRECT_REPLY'), {
    started: 1, completed: 1, failed: 0
  });
});

test('terminal lineage and life failures close canary accounting exactly once', () => {
  seedCanaryRollout('DIRECT_REPLY', { started: 0, completed: 0, failed: 0 });
  const turn = createCanonicalTurn(1);
  cancelCanonicalLineage(turn);
  replayCanonicalCancellation(turn);
  assert.deepEqual(canaryCounts('DIRECT_REPLY'), {
    started: 1, completed: 0, failed: 1
  });
  seedCanaryRollout('LIFE_PLANNING', { started: 0, completed: 0, failed: 0 });
  const attempt = controller.createLifePlanningAttempt(lifeInput());
  failLifeAttemptTerminally(attempt);
  replayLifeAttemptFailure(attempt);
  assert.deepEqual(canaryCounts('LIFE_PLANNING'), {
    started: 1, completed: 0, failed: 1
  });
});

test('outstanding canary authority counts one lineage, includes life, and excludes other kinds', () => {
  const original = createCanaryOriginalThenRetry('DIRECT_REPLY');
  const life = createCanaryLifeAttempt();
  createUnfinishedCanaryTurn('MOMENT_REPLY');
  const direct = store.readCanaryOutstandingAuthorityInternal({
    rolloutKey: 'DIRECT_REPLY', canaryEpoch: original.canaryEpoch
  });
  const planning = store.readCanaryOutstandingAuthorityInternal({
    rolloutKey: 'LIFE_PLANNING', canaryEpoch: life.canaryEpoch
  });
  assert.deepEqual(direct, { count: 1, oldestAt: original.createdAt });
  assert.deepEqual(planning, { count: 1, oldestAt: life.createdAt });
});

test('populated v13 migrates to v14 without changing semantic rows', () => {
  const source = buildPopulatedV13WithCanaryOriginalAndLifeAttempt();
  const before = logicalRowSnapshot(source);
  const store = new YuqiStore(source.path);
  assert.equal(store.userVersion(), 14);
  assert.deepEqual(logicalRowSnapshot(store), before);
  assertExactCanarySlotIndexes(store);
  assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
});

test('every v14 index migration fault leaves the exact v13 source intact', () => {
  for (const step of V14_MIGRATION_FAULT_STEPS) {
    const source = buildPopulatedV13WithCanaryOriginalAndLifeAttempt();
    const before = rawAndLogicalSnapshot(source);
    assert.throws(() => openWithV14MigrationFault(source.path, step),
      /forced v14 migration fault/);
    assert.deepEqual(rawAndLogicalSnapshot(source.path), before);
  }
});

test('inconsistent v13 canary counters refuse v14 migration before the first write', () => {
  const source = buildPopulatedV13WithCanaryOriginalAndLifeAttempt();
  corruptCurrentCanaryStartedCount(source, 9);
  const before = rawAndLogicalSnapshot(source);
  assert.throws(() => new YuqiStore(source.path),
    /v14 migration canary accounting conflict/);
  assert.deepEqual(rawAndLogicalSnapshot(source.path), before);
});
```

The migration suite also covers fresh v14, populated
v9→v10→v11→v12→v13→v14, populated v10/v12/v13 sources, v14 restart
idempotence, raw `>14` rejection, clone CLI report/restart, and a v13 source with
no canary rows. Existing Task 10F v13 semantic/redaction fixtures remain green;
update only their final opened-store version expectation, never weaken their
v13 invariant assertions.

- [ ] **Step 2: Run runtime integration tests red**

Run:

```powershell
node --test yuqi-runtime/test/release-pair.test.mjs yuqi-runtime/test/comparison-contract.test.mjs yuqi-runtime/test/release-executor.test.mjs yuqi-runtime/test/production-release-adapters.test.mjs yuqi-runtime/test/runtime-composition.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs tests/yuqi-agency-state-migration.test.mjs tests/yuqi-deployment-contract.test.mjs
npm.cmd test
```

Expected: FAIL because the shared release resolver does not exist, the store still
duplicates phase selection and allocates a comparison to every canary turn, life
attempt creation does not persist release IDs/checksums, v14 retry-safe slot
ownership does not exist, outstanding accounting omits life/retry lineage
semantics, release IDs/lanes are not wired into runtime execution, the
production `main.mjs` graph has no release executor, the six production adapter
sources are not bound, and v2/v3 shadow execution still reuses a checkpoint-
writing foreground path.

- [ ] **Step 3: Route every fresh subject through the authoritative release pair**

First migrate PC schema v13→v14 in one immediate transaction. V14 does not
rewrite any semantic row and does not change Task 10F's visible/redaction
contract. It changes only canary-slot ownership indexes so a canonical retry may
inherit its lineage's slot without allowing a second root owner:

```sql
DROP INDEX idx_turns_rollout_canary_slot;

CREATE UNIQUE INDEX idx_turns_rollout_canary_root_slot
ON turns(rollout_key, canary_epoch, canary_slot)
WHERE canary_slot IS NOT NULL AND retry_of_turn_id IS NULL;

CREATE INDEX idx_turns_rollout_canary_lineage_slot
ON turns(rollout_key, canary_epoch, canary_slot, authority_lineage_key)
WHERE canary_slot IS NOT NULL;
```

Before the first DDL write, run all v13 invariants and a v14 preflight. For every
current canary epoch it must prove: slot values are integers in `1..10`; root
turn/life owners are unique and contiguous through `canary_started_count`;
every canonical retry with a slot joins the same lineage/root and has the exact
same epoch, slot, release pair and checksums; terminal comparison/cancellation
evidence agrees with completed/failure counters; and
`started = completed + failure + outstanding`. Refuse an inconsistent source
with zero writes—never repair or fabricate historical counts.

Migration fault hooks cover before drop, after drop, after root-index creation,
after lineage-index creation, after invariant verification, and before
`PRAGMA user_version=14`; every fault rolls the whole transaction back to the
exact v13 schema/data/user-version snapshot. Write user version last. Reopen
runs all v13 semantic invariants plus `assertReleaseAuthorityV14Invariants()`.
The migration CLI remains clone-only/dry-run-safe, reports
`v14InvariantSummary` containing the nested v13 semantic summary and canary-slot
summary, leaves the source raw hash/logical snapshot unchanged, and rejects
`>14`.

Create `release-pair.mjs` as a dependency-free projection module. It must not
import the store, controller, orchestrator, model, or preset registry:

```js
export const CANARY_COMPARISON_TARGET = 10;

export function resolvePipelinePair(rollout) {
  if (!rollout || typeof rollout !== 'object' || Array.isArray(rollout)) {
    throw new Error('rollout release authority is required');
  }
  const candidatePhase = String(rollout.candidatePhase || '');
  const stableReleaseId = String(rollout.stableReleaseId || '');
  const candidateReleaseId = rollout.candidateReleaseId == null
    ? null
    : String(rollout.candidateReleaseId);
  const canaryStartedCount = Number(rollout.canaryStartedCount);
  if (!stableReleaseId
    || !['none', 'shadow', 'canary', 'rolled_back'].includes(candidatePhase)
    || !Number.isSafeInteger(canaryStartedCount) || canaryStartedCount < 0
    || canaryStartedCount > CANARY_COMPARISON_TARGET
    || Number(rollout.canaryTargetCount) !== CANARY_COMPARISON_TARGET
    || (['shadow', 'canary'].includes(candidatePhase)
      && (!candidateReleaseId || candidateReleaseId === stableReleaseId))) {
    throw new Error('invalid rollout release authority');
  }
  if (candidatePhase === 'shadow') {
    return {
      visibleReleaseId: stableReleaseId,
      comparisonReleaseId: candidateReleaseId,
      comparisonDirection: 'stable_authoritative_candidate_compare',
      candidatePhase
    };
  }
  if (candidatePhase === 'canary') {
    const compare = canaryStartedCount < CANARY_COMPARISON_TARGET;
    return {
      visibleReleaseId: candidateReleaseId,
      comparisonReleaseId: compare ? stableReleaseId : null,
      comparisonDirection: compare
        ? 'candidate_authoritative_stable_compare'
        : null,
      candidatePhase
    };
  }
  return {
    visibleReleaseId: stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    candidatePhase
  };
}
```

Create `comparison-contract.mjs` as the only fresh-version-1 conversion between
the three deliberately different namespaces. Neither store, orchestrator,
visible commit, life planning nor comparison worker may carry a second map:

```js
const FRESH_COMPARISON_CONTRACTS = Object.freeze([
  Object.freeze({
    comparisonMode: 'none',
    comparisonDirection: null,
    jobType: null
  }),
  Object.freeze({
    comparisonMode: 'cognition_compare',
    comparisonDirection: 'stable_authoritative_candidate_compare',
    jobType: 'shadow_cognition'
  }),
  Object.freeze({
    comparisonMode: 'legacy_compare',
    comparisonDirection: 'candidate_authoritative_stable_compare',
    jobType: 'active_canary_compare'
  })
]);

function copy(contract) {
  return { ...contract };
}

export function comparisonContractForDirection(comparisonDirection) {
  const contract = FRESH_COMPARISON_CONTRACTS.find(
    item => item.comparisonDirection === comparisonDirection
  );
  if (!contract) throw new Error('fresh comparison contract direction conflict');
  return copy(contract);
}

export function comparisonContractForMode(comparisonMode) {
  const contract = FRESH_COMPARISON_CONTRACTS.find(
    item => item.comparisonMode === comparisonMode
  );
  if (!contract) throw new Error('fresh comparison contract mode conflict');
  return copy(contract);
}
```

The module intentionally does not accept either historical comparison-direction
alias. Those aliases belong only to the explicitly version-0 worker branch and
must never be converted into a fresh contract.

Create `release-executor.mjs` as the only release-ID-to-runtime adapter
registry. It loads the immutable `pipeline_releases` row itself, verifies the
caller/subject checksum, and selects from a closed exact `pipelineVersion`
mapping:

```js
const RELEASE_ADAPTERS = new Map([
  ['stable-visible-baseline-2026-07-30', 'legacy-v1'],
  ['cognition-v2-candidate-2026-07-30', 'cognition-v2'],
  ['yuqi-lived-agency-v3', 'cognition-v3']
]);
```

Export `supportsPipelineVersion()` over this same closed map for Tasks 22/23;
they may not duplicate the list.
The constructor receives the three turn adapters and their life-planning
counterparts. `executeTurn()` / `executeLife()` return drafts only; visible
state/action/message commits remain outside the adapter. An unknown
`pipelineVersion`, unavailable adapter, or release checksum mismatch fails
before a model call. `dryRun=true` supplies a capability object with every
visible/action/state/fact/memory/outbox/notification write disabled. The
authoritative orchestrator and `ShadowDispatcher` call this same registry; no
dispatcher branches directly on `current_mode`, release ID prefixes, or
`comparisonPipeline`.

Each provider returns only its normalized draft body. `ReleaseExecutor` wraps
it as `{ adapterId, releaseId, releaseChecksum, draft, dryRun, capabilities }`;
the provider cannot self-report a different adapter/release identity.
`LifePlanningDispatcher` passes only `result.draft` to the authoritative life
result validator/commit transaction.

The constructor is production-strict: before it can be returned, it verifies
that both maps contain exactly `legacy-v1`, `cognition-v2`, and `cognition-v3`,
that every turn entry exposes `executeTurn`, and every life entry exposes
`executeLife`. Missing, extra, or duplicate adapters fail with
`complete production release adapter set is required`; a runtime must not start
with a lazy "fail when first selected" hole. `adapterIds()` returns the two
sorted exact lists for composition diagnostics/tests, not mutable adapter
objects.

Create `production-release-adapters.mjs`. It owns construction of the six
production adapters, while `release-executor.mjs` remains the sole
`pipelineVersion → adapterId` registry. The sources are fixed:

| Adapter | Turn draft provider | Life draft provider |
|---|---|---|
| `legacy-v1` | `orchestrator.executeLegacyReleaseTurnDraft()` factored from the existing memory→brain→supervisor behavior | `orchestrator.executeLegacyLifeReleaseDraft()` factored from the existing `plan_yuqi_life` behavior |
| `cognition-v2` | `cognitivePipeline.runV2ReleaseDraft()` using the pinned v2 preset/schema | `orchestrator.executeCognitionV2LifeReleaseDraft()` using the pinned v2 release |
| `cognition-v3` | `cognitivePipeline.runV3ReleaseDraft()` using the Task 3–8 v3 envelope/contract/supervisor | `orchestrator.executeCognitionV3LifeReleaseDraft()` using the v3 life adapter and pinned release |

Every provider receives exactly `{ release, execution, dryRun, capabilities }`
and returns a normalized draft; it may not commit a visible group, message,
action, state patch, fact, memory job, outbox row or notification. The legacy
turn provider may reuse/refactor existing request builders and validation, but
must stop before `commitApproved()` and must not call the version-0
`advanceTurn()`/delivery path for a canonical turn. Version-0 recovery continues
to call the old compatibility path directly and is not smuggled through a fake
release row.

`CognitivePipeline.runForeground()` remains the version-0 compatibility wrapper.
Task 11 adds `runV2ReleaseDraft()` and `runV3ReleaseDraft()` with an explicit
`dryRun/capabilities` input. Authoritative execution may persist only the
canonical attempt checkpoints allowed by the canonical turn writer; dry-run
must not call `persistCognitionCheckpoint`, `saveCognitionCheckpointInternal`,
legacy `advanceTurn`, cognitive-state/fact/memory writers, or any output writer.
Do not implement dry-run as `runShadow() → runForeground()` against the live
store. The focused cognitive-pipeline tests use throwing write spies for both v2
and v3 and prove that model calls still occur while domain writes remain zero.

Create side-effect-free `runtime-composition.mjs` and keep `main.mjs` as config,
I/O and lifecycle only. One PC process owns exactly one `ReleaseExecutor`
instance. Because the legacy providers are methods on the orchestrator, use a
closed, one-time attachment sequence rather than constructing incomplete
consumer-local executors:

```js
export function composeYuqiExecutionRuntime(input) {
  const orchestrator = new YuqiOrchestrator({
    ...input,
    releaseExecutor: null
  });
  const { turnAdapters, lifeAdapters } = createProductionReleaseAdapters({
    orchestrator,
    cognitivePipeline: input.cognitivePipeline
  });
  const releaseExecutor = new ReleaseExecutor({
    store: input.store,
    turnAdapters,
    lifeAdapters
  });
  orchestrator.attachReleaseExecutor(releaseExecutor);
  const turnDispatcher = new TurnDispatcher({
    store: input.store,
    orchestrator
  });
  const lifePlanningDispatcher = new LifePlanningDispatcher({
    store: input.store,
    promotionController: input.promotionController,
    releaseExecutor,
    buildExecution: attempt => orchestrator.buildLifePlanningReleaseExecution(attempt)
  });
  orchestrator.setLifePlanningDispatcher(lifePlanningDispatcher);
  const shadowDispatcher = new ShadowDispatcher({
    store: input.store,
    releaseExecutor,
    promotionController: input.promotionController,
    legacyVersionZeroComparisonExecutor:
      execution => input.cognitivePipeline.runShadow(execution),
    foregroundActivity: { isBusy: () => turnDispatcher.inflight.size > 0 }
  });
  return Object.freeze({
    releaseExecutor,
    orchestrator,
    turnDispatcher,
    lifePlanningDispatcher,
    shadowDispatcher
  });
}
```

`attachReleaseExecutor()` accepts one complete executor exactly once and exposes
`releaseExecutorAttached=true`; a second attachment fails. Canonical
`accept/process/run`, life release execution, and v1 comparison fail closed if
attachment is absent. The factory performs the attachment before it returns,
and `main.mjs` must call the factory exactly once before constructing the local
server, cloud pump, timers, or invoking any `recover/start`. Main must not call
`new ReleaseExecutor`, `new ShadowDispatcher`, or `new LifePlanningDispatcher`
itself.

`LifePlanningDispatcher` receives that same instance and calls
`executeLife()` with the attempt's persisted authoritative release/checksum;
`ShadowDispatcher` receives the same instance and calls it with `dryRun=true`
for every version-1 job. Its separately named
`legacyVersionZeroComparisonExecutor` exists only for an already-persisted
version-0 job after explicit authority-version classification. It cannot be
selected for fresh work. No consumer constructs or owns another executor.

`PromotionController.resolvePipelinePair(rollout)` delegates directly to this
function. It must not copy the switch. Add
`selectPipelinePairForFreshSubject(rolloutKey, { now })`, which reads the current
rollout, resolves the pair, validates canary outstanding count/deadline, and
returns `{ rollout, pair }`. Deadline age is measured from the durable
subject/attempt reservation time, not from a delayed compare-job creation time.
A deadline breach always blocks canary selection. The max-outstanding check
blocks only when the resolved pair would allocate another comparison; a
post-target pair with no comparison may proceed while non-expired earlier
comparisons finish. Until Task 23 supplies candidate rollback mutations, a
blocked canary selection fails closed with stable code
`CANARY_COMPARE_BACKLOG` and no writes; it never silently returns a stale canary
pair. Task 23 extends this same method to perform the transactional per-kind
rollback, so the orchestrator call site does not change.

There are three distinct fields, and they are never equal by design:

| Authority field | Fresh version-1 value | Purpose |
|---|---|---|
| `turns.comparison_mode` / life `comparison_mode` | `none`, `cognition_compare`, `legacy_compare` | existing database compatibility/scheduling projection |
| canonical commit + job payload `comparisonDirection`, life `comparison_direction` | release-aware direction below or null | immutable release direction |
| comparison job `job_type` | `shadow_cognition`, `active_canary_compare` or absent | worker operation |

`turns` has no `comparison_direction` column, and v14 must not add one: its only
schema delta remains the retry-safe canary indexes. Fresh version-1 canonical
commit descriptors/jobs and fresh Task 11 life attempts use only the
release-aware direction strings emitted above:
`stable_authoritative_candidate_compare` and
`candidate_authoritative_stable_compare`. The older
`legacy_authoritative_cognition_compare` /
`cognition_authoritative_legacy_compare` strings remain read-only aliases for
already-persisted result-authority-version-0 turns, jobs and life attempts.
`recordComparisonOutcomeInternal()` classifies direction from the closed
`jobType + comparisonDirection` pair, validates the subject's stored release
IDs/checksums/epochs/slot, accepts the appropriate legacy alias only for a
legacy subject, and rejects a cross-direction pair. New code never emits a
legacy alias.

On the uncommitted path, `commitVisibleResult()` must import
`comparisonContractForMode()` and validate the complete persisted-turn tuple
before any canonical result write:

1. `input.comparisonReleaseId` exactly equals the pinned turn release ID;
2. `input.comparisonDirection` exactly equals the contract's release-aware
   direction, never the compatibility mode string;
3. a comparison exists iff the contract has a non-null `jobType`;
4. the job type and payload direction exactly equal that same contract;
5. `none` requires null comparison release/direction and no comparison job.

The normalized canonical commit payload retains the release-aware top-level
direction and the normalized comparison descriptor. A version-1 canonical
turn presenting a legacy alias, `cognition_compare`/`legacy_compare` as a
direction, a cross-paired job type, or a different top-level release ID fails
with zero commit writes. Existing exact-replay checksum behavior remains
unchanged.

Do not expand or reinterpret Task 10F's canonical comparison descriptor to
repair the old worker. For a version-1 turn job, the worker joins
`consolidation_jobs.authority_group_id → visible result group/receipt →
authoritative turn` and derives rollout key/revision, authoritative release and
both checksums from those persisted authorities; the small job payload supplies
only the already-validated comparison descriptor plus group/result checksum.
For life work it joins `subject_id → cognition_life_planning_attempts` and uses
that attempt's pins. It must not require canonical payload fields such as
`rolloutKey` or `pipelineChecksum` that Task 10F intentionally excluded, and it
must not compare a stable-visible subject checksum to the compatibility
`cognition_kind_rollouts.pipeline_checksum`. Existing version-0 jobs may use
their historical self-contained payload. Shadow/canary freshness is proven
from current stable/candidate release IDs, immutable release checksums,
evidence/shadow/canary epochs and the subject slot; ordinary rollout revision
increments caused by other slot allocations do not make an earlier subject
stale.

`createCanonicalVisibleTurnInternal()` imports the same pure resolver. For a
fresh original, inside its existing `BEGIN IMMEDIATE` transaction it reloads the
rollout, checks `expectedRolloutRevision`, resolves the pair again, verifies
caller pair fields, then loads immutable release rows and pins their
checksums/preset. It must remove the current in-method phase switch. A
version-1 retry does not reload or resolve the current rollout: after immutable
parent/lineage validation it inherits the parent's complete release pair,
checksums, preset, epochs and slot exactly as Task 10 requires. A canary
comparison reservation is allocated only for a fresh subject when the resolved
pair has a non-null comparison release:

```js
const pair = resolvePipelinePair(mapCognitionRollout(rolloutRow));
assertExactCallerPair(input, pair);
const reservesCanaryComparison =
  pair.candidatePhase === 'canary' && pair.comparisonReleaseId !== null;
const canarySlot = reservesCanaryComparison
  ? rollout.canaryStartedCount + 1
  : null;
if (reservesCanaryComparison) {
  assertCanaryOutstandingBelowLimit(rollout);
  reserveCanaryComparisonSlotCAS(rollout.rolloutKey, rollout.revision);
}
```

`canary_started_count` counts allocated comparison subjects, not every
candidate-visible result. It stops at exactly ten. The eleventh and later canary
subject remains candidate-visible but has `canary_slot=NULL`, no comparison
release/job, and does not change the started counter. Retry creation inherits the
parent pair and slot and never resolves or allocates again.

Apply the same rule to `createLifePlanningAttempt()`. Its existing store
transaction must first return an existing open/exact attempt with its original
pins. Only for a fresh attempt does it read the current rollout, re-resolve and
validate the supplied pair, reserve a canary comparison slot for that
`LIFE_PLANNING` rollout key only among its first ten subjects, and persist the
already-existing columns:

```text
authoritative_release_id
comparison_release_id
authoritative_pipeline_checksum
comparison_pipeline_checksum
```

The life request key includes both release IDs/checksums, comparison direction,
candidate phase, evidence epoch, and canary epoch so a changed release cannot
reuse an old attempt. `commitLifePlanningResultInternal()` copies those stored
release IDs/checksums into the compare-job payload; it still creates that job
only in the authoritative result transaction after the result checksum exists.
No additional life-attempt columns are required because Task 2 already added
these four; the v14 slot-index migration above is still required.
The pair resolver deliberately does not invent compatibility mode. The store
also validates the rollout's `current_mode/rollout_phase/candidate_phase`
projection (including graduated `active/stable/none`) and pins
`pipeline_mode=current_mode`. Derive the remaining compatibility fields from
that validated row and pair only through
`comparisonContractForDirection(pair.comparisonDirection)`: stable-visible comparison maps to
`comparison_mode=cognition_compare`; candidate-visible comparison maps to
`comparison_mode=legacy_compare`; no comparison maps to
`comparison_mode=none`; `authoritative_pipeline` is `cognition` only for an
active visible release and `legacy` otherwise. The authoritative checksum is
always the selected visible release checksum, never an independently supplied
rollout checksum. `comparison_direction` itself is always the release-aware
pair direction for a fresh attempt; compatibility mode names do not replace it.

For every allocated canary slot, exactly one durable terminal accounting event
must eventually increment `canary_completed_count` or `canary_failure_count`.
The subject identity is the canonical lineage for turn work and `planning_id`
for life work, never an individual retry attempt. A retryable turn failure or
life `retry_wait` leaves the one slot outstanding; a retry inherits it. Only a
terminal lineage cancellation, terminal life failure/cancellation, successful
comparison, critical comparison, or permanently failed comparison closes the
slot. Compare retry/replay and repeated terminal calls are idempotent and cannot
increment a counter twice. These counters belong to the subject's own rollout
key; turn kinds and `LIFE_PLANNING` share the accounting rules and controller,
not a cross-kind counter.

Add one store read,
`readCanaryOutstandingAuthorityInternal({ rolloutKey, canaryEpoch })`. It
enumerates allocation owners from root turns
(`retry_of_turn_id IS NULL`) and life attempts with non-null slots, groups all
canonical attempts by lineage, subtracts only durable terminal evidence, and
returns `{ count, oldestAt }` using the original reservation timestamp. It must
not enumerate unfiltered consolidation jobs. It verifies allocation,
terminal, and unresolved cardinalities against the rollout counters and throws
`CANARY_ACCOUNTING_INVARIANT` on any mismatch. The existing
`countOutstandingComparisonSubjects(..., { canaryEpoch })` delegates to this
authority path; its shadow/replay query behavior remains separate.

Close counters in the same transaction as their terminal evidence:

- `recordComparisonOutcomeInternal()` changes completed/failure once while
  moving the leased job to completed;
- final (non-`retry_wait`) `failConsolidationJob()` changes failure once for a
  live canary comparison and updates a life attempt's comparison state when
  applicable;
- `cancelCanonicalTurnInternal()` changes failure once only when it terminally
  closes an allocated lineage with no prior terminal comparison;
- `failLifePlanningAttemptInternal()` and stale-basis cancellation do the same
  for an allocated life attempt;
- retryable turn failure, life retry scheduling, lease recovery, exact replay,
  and canonical retry creation change no terminal counter.

Each update matches rollout key, canary epoch, slot, release pins and current
counter revision. A stale epoch records its own terminal job/run state but
cannot mutate the current rollout counters.

Then wire the runtime:

```js
const existingTurn = findPersistedTurnForRecovery(envelope);
if (existingTurn) {
  return existingTurn.resultAuthorityVersion === 0
    ? recoverLegacyTurn(existingTurn)
    : recoverCanonicalTurnOrQuarantine(existingTurn);
}

const retryParent = envelope.context?.retry
  ? store.getTurn(envelope.context.retry.retryOfTurnId)
  : null;
if (envelope.context?.retry && !retryParent) {
  return quarantineInvariantFailure('missing_retry_parent');
}

const eligibleForCanonicalResultAuthority =
  envelope.characterId === 'yuqi'
  && (envelope.protocolVersion === 2 || envelope.protocolVersion === 3)
  && SUPPORTED_ROLLOUT_KEYS.has(envelope.kind)
  && (!retryParent || retryParent.resultAuthorityVersion === 1)
  && executionEntry === 'cognition-release-pinned';

if (!eligibleForCanonicalResultAuthority) {
  return executeCompatibilityPath(envelope);
}

if (envelope.kind === 'LIFE_PLANNING') {
  const openAttempt = store.getOpenLifePlanningAttempt(envelope.characterId);
  if (openAttempt) return recoverPinnedLifePlanningAttempt(openAttempt);
  return executeTwoPhaseLifePlanningAuthority({
    envelope,
    annotationSnapshot,
    now: runtimeClock.now()
  });
}

const selection = retryParent
  ? null
  : promotionController.selectPipelinePairForFreshSubject(
      envelope.kind, { now: runtimeClock.now() }
    );
const rollout = selection?.rollout ?? null;
const pair = retryParent
  ? releasePairPinnedByTurn(retryParent)
  : selection.pair;
if (retryParent) assertValidCanonicalRetryParent(retryParent, pair);
const laneKey = laneKeyForEnvelope(envelope);
const lane = store.getInteractionLane(envelope.characterId, laneKey)
  ?? { revision: 0, localSequence: 0, clearEpoch: 0, clearedThroughSequence: 0 };
const inputVisibilitySequence =
  Number.isSafeInteger(envelope.context?.visibilityCursor?.localSequence)
    ? envelope.context.visibilityCursor.localSequence
    : lane.localSequence;
const inputClearEpoch = Number(
  envelope.context?.visibilityCursor?.clearEpoch
  ?? (envelope.trigger ? lane.clearEpoch : 0)
);
const agencyPreview = store.readAgencyAuthoritySnapshotInternal({
  roleId: envelope.characterId,
  at: canonicalInteractionAt(envelope)
});
const creation = store.createCanonicalVisibleTurnInternal({
  envelope,
  rolloutKey: envelope.kind,
  expectedRolloutRevision: retryParent?.rolloutRevision ?? rollout.revision,
  authoritativeReleaseId: pair.visibleReleaseId,
  comparisonReleaseId: pair.comparisonReleaseId,
  comparisonDirection: pair.comparisonDirection,
  laneKey,
  expectedLaneRevision: lane.revision,
  inputUserBatchId: envelope.context?.currentBatch?.batchId
    ?? envelope.message?.messageId
    ?? envelope.trigger?.triggerId,
  inputVisibilitySequence,
  inputClearEpoch,
  agencySnapshotChecksum: agencyPreview.checksum,
  annotationSnapshot
});
if (creation.status === 'already_committed') {
  return bridgeResultFromCommitReceipt(creation.receipt);
}
if (creation.status === 'redacted') {
  return {
    status: 'redacted',
    terminal: true,
    visible: false,
    authorityLineageKey:
      creation.receipt?.authorityLineageKey ?? creation.lineage.lineageKey,
    visibleGroupId: creation.receipt?.visibleGroupId ?? null,
    commitChecksum: creation.receipt?.commitChecksum ?? null,
    replyParts: [],
    actions: []
  };
}
const turn = creation.turn;
const agencyView = compileAgencyView({
  constraints: creation.agencySnapshot.constraints,
  preferences: creation.agencySnapshot.preferenceFacts.map(preferenceFromStableFact),
  stances: creation.agencySnapshot.stances,
  featureContext: featureContextForEnvelope(envelope),
  limits: { hardConstraints: 5, currentStances: 2, preferences: 4 }
});
const execution = await releaseExecutor.executeTurn({
  releaseId: turn.authoritativeReleaseId,
  releaseChecksum: turn.authoritativePipelineChecksum,
  execution: { turn, envelope, agencyView },
  dryRun: false
});
if (execution.draft.action === 'skip') {
  if (!isAutomaticKind(turn.rolloutKey)) {
    throw new Error('DIRECT_REPLY cannot commit an empty canonical result');
  }
  execution.visibleGroup = { items: [] };
  execution.actionSet = [];
}
const outputFingerprint = generationFingerprint({
  roleId: turn.characterId,
  laneKey: turn.laneKey,
  laneRevision: turn.laneRevision,
  inputVisibilitySequence: turn.inputVisibilitySequence,
  visibleGroup: execution.visibleGroup,
  actionSet: execution.actionSet,
  contextRevision: turn.agencySnapshotChecksum
});
const comparisonJob = turn.comparisonReleaseId
  ? buildComparisonJobDraftFromTurn({ turn, envelope })
  : null;
const receipt = commitVisibleResult(toCommitInput(execution, {
  expectedTurnRevision: store.getTurn(turn.turnId).turnRevision,
  expectedLineageRevision: store.getTurnAuthorityLineage(
    turn.authorityLineageKey).revision,
  expectedCognitiveStateRevision: execution.inputCognitiveStateRevision,
  generationFingerprint: outputFingerprint,
  comparisonJob
}));
return bridgeResultFromCommitReceipt(receipt);
```

`executionEntry` is an internal orchestrator constant set only after the request
has entered this Task 11 release-pinned cognition handler; it is not read from
the envelope. During Task 11 the reachable accepted wire version is 2. The
`protocolVersion === 3` arm is deliberately dormant until Task 13 extends and
validates the wire protocol; it does not authorize version 1 by itself. A valid
release pair is required in both stable-visible shadow and candidate-visible
canary phases, so both use the same canonical commit authority. No code may call
an old creator and later mutate that turn to version 1.

`executeCompatibilityPath()` handles a retry parent with
`resultAuthorityVersion=0`; the boolean above must never upgrade it. A canonical
retry uses `releasePairPinnedByTurn(retryParent)` even if the rollout controller
now reports a different phase or release. Add a recovery/race test that changes
the rollout between original failure and retry and proves the retry retains the
parent’s release IDs/checksums/preset while still taking a fresh lane and agency
snapshot.

`agencyPreview.checksum` is only an optimistic CAS expectation. The model must
receive `creation.agencySnapshot`, which the store recomputed inside the same
turn-creation transaction; it must not receive the pre-read object after a race.
`canonicalInteractionAt(envelope)` is the stable root batch/trigger time shared
by retries. Recovery of an open canonical turn recomputes this snapshot and
continues only when it equals `turn.agencySnapshotChecksum`; otherwise it records
`AGENCY_AUTHORITY_STALE` and requires an explicit retry. There is no
`agencyView.checksum` field.

For protocol v2, `inputVisibilitySequence` is deliberately the lane snapshot,
not a fabricated client cursor; add a test with a non-zero persisted lane
sequence and no `context.visibilityCursor`. For protocol v3, Task 13 owns cursor
validation before this handler runs. An automatic turn derives
`inputUserBatchId` and `rootSourceId` from `envelope.trigger.triggerId`, never
from a nonexistent top-level `triggerId`.

`buildComparisonJobDraftFromTurn({ turn, envelope })` has no database side
effect and accepts the persisted turn object rather than caller-selected
release fields. It deterministically derives job type, comparison release and
direction through `comparisonContractForMode(turn.comparisonMode)`, rollout
evidence/shadow/canary epochs/slot, annotation checksum and
Task 10F's exact input checksum. Task 10 inserts it as
step 8 of the same result transaction and fills the authoritative group/checksum
from that transaction; there is no post-commit window where a visible result
lacks required comparison work.

Add
`store.loadComparisonExecutionAuthorityInternal({ jobId, workerId })` as the
only comparison input loader. While the job lease is held it:

1. verifies job payload checksum/type/direction;
2. for a canonical turn, scoped-validates `authority_group_id`, joins the
   receipt/group/manifest/authoritative turn, reconstructs the authoritative
   result from canonical items/actions/terminal disposition, and uses the
   stored commit checksum rather than `turn.reply_json`;
3. for life planning, joins the attempt, verifies stored input/result
   checksums and returns its input snapshot/episodes without creating a turn;
4. resolves both immutable release rows and returns the exact comparison
   release executor plus a dry-run capability object;
5. for a legacy job only, uses the frozen legacy payload path.

If the lineage/group or life source was redacted/cancelled before claim, the
loader returns a metadata-only terminal cancellation, never reconstructs
content and never calls a model. The same transaction marks the job cancelled
and closes an allocated canary subject as failure exactly once. A redaction
racing after claim must win at the final outcome transaction: the worker
discards its draft and applies the same metadata-only cancellation.

`ShadowDispatcher` consumes only that loader and invokes the same
release-ID-based execution registry as the authoritative path with
`dryRun=true`. Turn comparison and life comparison have separate context
adapters but the same release authority. The dry-run capability can write only
the leased job, `cognition_shadow_runs`, quality reports/findings and canary
terminal accounting; it cannot call action stores, visible commit, outbox,
notification, cognitive/life state, fact, memory or consolidation APIs. Add
negative capability spies for all of them.

Life planning retains two phases: attempt creation fixes
release/epoch/checksum/canary slot/input; result commit creates comparison work
in the same transaction. Outstanding canary count includes attempts allocated
before the comparison job exists.

`executeTwoPhaseLifePlanningAuthority()` is selected before canonical turn/group
creation. Its controller transaction checks for an existing open/exact attempt
before reading current rollout state. A fresh attempt calls the same
`selectPipelinePairForFreshSubject('LIFE_PLANNING', { now })`, then the store
re-resolves that pair and reserves any canary slot before inserting the attempt.
It pins the release pair on `cognition_life_planning_attempt`; authoritative
life execution calls `releaseExecutor.executeLife()` with the attempt's
authoritative ID/checksum, and result commit owns its checksum and compare job.
It never fabricates an empty chat batch, visible group, receipt, delivery, or
Android notification.

For the other nine keys, zero visible items are not globally rejected.
`commitVisibleResult()` derives the Task 10F terminal disposition from persisted
kind plus validated item/action rows. An automatic zero/zero result is a
successful `skip`: it still has one lineage/group/manifest/receipt and terminal
delivery so retries and Android completion are exactly-once, but it creates no
message, action or notification. Direct reply remains non-skippable.

Recovery branches explicitly on persisted `resultAuthorityVersion` before any
new-turn creation: version 0 resumes the pre-v11 pinned legacy turn/outbox path;
version 1 must load lineage, current turn revision, canonical receipt/group and
group delivery. Recovery never invokes `createCanonicalVisibleTurnInternal()`.
A version-1 turn with a missing or inconsistent lineage is quarantined as an
invariant failure and never regenerated or silently downgraded.

- [ ] **Step 4: Run all runtime integration tests green**

Run:

```powershell
node --test yuqi-runtime/test/release-pair.test.mjs yuqi-runtime/test/comparison-contract.test.mjs yuqi-runtime/test/release-executor.test.mjs yuqi-runtime/test/production-release-adapters.test.mjs yuqi-runtime/test/runtime-composition.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs tests/yuqi-agency-state-migration.test.mjs tests/yuqi-deployment-contract.test.mjs
```

Expected: PASS; the resolver/store/controller direction tests agree at canary
slots 9/10/11; life attempts persist release IDs/checksums across restart;
fresh canonical commits keep compatibility mode, release-aware direction and
job type distinct and reject every cross-pair with zero writes;
the production composition exposes one complete executor instance shared by
orchestrator/life/shadow, all six adapter providers are present, v2/v3/legacy
dry-run write-spy totals remain zero, and `main.mjs` cannot bypass the tested
factory;
graduated `active/stable/none` remains active on its new stable release;
v13→v14 changes only slot indexes/user version and is fault-atomic; canonical
retry and life subjects reconcile exactly with canary counters;
recovered result-authority-version-0 turns still use the old branch; recovered
version-1 turns never adopt a later rollout change. The full repository gate
passes with zero failures/skips; existing non-Yuqi, wire-v1/version-0,
moments/plans/proactive, Android contracts, UI, service-worker and legacy
stable-visible behavior remain unchanged.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/release-pair.mjs yuqi-runtime/src/comparison-contract.mjs yuqi-runtime/src/release-executor.mjs yuqi-runtime/src/production-release-adapters.mjs yuqi-runtime/src/runtime-composition.mjs yuqi-runtime/src/promotion-controller.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/turn-dispatcher.mjs yuqi-runtime/src/shadow-dispatcher.mjs yuqi-runtime/src/life-planning-dispatcher.mjs yuqi-runtime/src/reconcile.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/src/main.mjs scripts/migrate-yuqi-agency-state.mjs yuqi-runtime/test/release-pair.test.mjs yuqi-runtime/test/comparison-contract.test.mjs yuqi-runtime/test/release-executor.test.mjs yuqi-runtime/test/production-release-adapters.test.mjs yuqi-runtime/test/runtime-composition.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/test/store-agency-v10.test.mjs yuqi-runtime/test/store-visible-authority-v11.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs tests/yuqi-agency-state-migration.test.mjs tests/yuqi-deployment-contract.test.mjs
git commit -m "feat: integrate v3 release execution and recovery"
```

### Task 12: Persist Android Conversation Visibility Cursors

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/db/ConversationCursorEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/ConversationAuthorityEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Create: `android/app/src/androidTest/java/com/siyi/al/AlExecutionPluginTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionServicePolicy.java`
- Create: `android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: Task 10 receipt fields, native completion, and existing successful DOM `uiAppliedAt` acknowledgement.
- Produces: Android Room v11 (independent from PC schema v14); durable local lineage/receipt mirror; plugin methods `getConversationCursor` and `markConversationCleared`; existing acknowledgement methods updating the cursor; monotonic `clearedThroughSequence + clearEpoch`.

- [ ] **Step 1: Write red Room migration and monotonic cursor tests**

```java
@Test
public void migration10To11PreservesTurnsAndCreatesCursor() {
    SupportSQLiteDatabase db = helper.createDatabase(TEST_DB, 10);
    insertCompletedV10Turn(db, "turn-1", "yuqi");
    db.close();
    db = helper.runMigrationsAndValidate(TEST_DB, 11, true, MIGRATION_10_11);
    assertEquals(1L, DatabaseUtils.queryNumEntries((SQLiteDatabase) db, "chat_turns"));
    assertTrue(hasTable(db, "conversation_cursors"));
    assertTrue(hasTable(db, "conversation_authorities"));
    assertTrue(hasColumn(db, "conversation_authorities", "terminalDisposition"));
    assertTrue(hasColumn(db, "chat_turns", "visibleGroupId"));
    assertTrue(hasColumn(db, "chat_turns", "authorityLineageKey"));
    assertTrue(hasColumn(db, "chat_turns", "lineageRevision"));
    assertTrue(hasColumn(db, "chat_turns", "turnRevision"));
    assertTrue(hasColumn(db, "chat_turns", "pipelineReleaseId"));
    assertTrue(hasColumn(db, "chat_turns", "inputVisibilitySequence"));
    assertTrue(hasColumn(db, "chat_turns", "inputClearEpoch"));
    assertTrue(hasColumn(db, "chat_turns", "terminalDisposition"));
}

@Test
public void cursorStagesAdvanceMonotonicallyAndIdempotently() {
    store.markNativeCompleted("yuqi", "turn-1", "group-1", 7L, 1000L);
    store.markUiApplied("yuqi", "turn-1", "group-1", 7L, 1100L);
    store.markNativeCompleted("yuqi", "turn-old", "group-old", 6L, 1200L);
    ConversationCursorEntity cursor = store.getConversationCursor("yuqi");
    assertEquals("group-1", cursor.nativeCompletedGroupId);
    assertEquals("group-1", cursor.uiAppliedGroupId);
    assertEquals(7L, cursor.nativeCompletedSequence);
    assertEquals(7L, cursor.uiAppliedSequence);
    assertEquals(7L, cursor.localSequence);
}

@Test
public void clearCursorRejectsLateGroupsAtOrBeforeClearedSequence() {
    store.markConversationCleared("yuqi", 7L, 3L, 1200L);
    assertEquals(DeliveryDisposition.REDACTED,
        store.classifyIncomingGroup("yuqi", "group-old", 7L));
    assertEquals(DeliveryDisposition.REDACTED,
        store.classifyIncomingGroup("yuqi", "group-older", 6L));
    assertEquals(DeliveryDisposition.APPLY,
        store.classifyIncomingGroup("yuqi", "group-new", 8L));
}
```

- [ ] **Step 2: Run Android tests red**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: FAIL on missing Room entity/migration/store APIs.

- [ ] **Step 3: Implement Room v11 and the plugin cursor payload**

```java
@Entity(tableName = "conversation_cursors")
public final class ConversationCursorEntity {
    @PrimaryKey @NonNull public String characterId;
    public String nativeCompletedTurnId;
    public String nativeCompletedGroupId;
    public long nativeCompletedSequence;
    public String uiAppliedTurnId;
    public String uiAppliedGroupId;
    public long uiAppliedSequence;
    public long localSequence;
    public long clearedThroughSequence;
    public long clearEpoch;
    public long clearedAt;
    public boolean chatOpen;
    public long updatedAt;
}

@Entity(
    tableName = "conversation_authorities",
    indices = @Index(
        value = {"characterId", "laneKey", "rootSourceId"},
        unique = true
    )
)
public final class ConversationAuthorityEntity {
    @PrimaryKey @NonNull public String authorityLineageKey;
    @NonNull public String characterId;
    @NonNull public String laneKey;
    @NonNull public String rootSourceId;
    @NonNull public String latestTurnId;
    public long revision;
    @NonNull public String state; // OPEN | COMMITTED | CANCELLED
    public String visibleGroupId;
    public String commitChecksum;
    public String commitPayloadVersion;
    public String authorityOrigin; // pc | android_fallback
    public String terminalDisposition; // visible | action_only | skip
    public long updatedAt;
}

static final Migration MIGRATION_10_11 = new Migration(10, 11) {
    @Override public void migrate(@NonNull SupportSQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `conversation_cursors` (" +
            "`characterId` TEXT NOT NULL, `nativeCompletedTurnId` TEXT, " +
            "`nativeCompletedGroupId` TEXT, `nativeCompletedSequence` INTEGER NOT NULL, " +
            "`uiAppliedTurnId` TEXT, `uiAppliedGroupId` TEXT, " +
            "`uiAppliedSequence` INTEGER NOT NULL, `localSequence` INTEGER NOT NULL, " +
            "`clearedThroughSequence` INTEGER NOT NULL, `clearEpoch` INTEGER NOT NULL, " +
            "`clearedAt` INTEGER NOT NULL, " +
            "`chatOpen` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, " +
            "PRIMARY KEY(`characterId`))");
        db.execSQL("CREATE TABLE IF NOT EXISTS `conversation_authorities` (" +
            "`authorityLineageKey` TEXT NOT NULL, `characterId` TEXT NOT NULL, " +
            "`laneKey` TEXT NOT NULL, `rootSourceId` TEXT NOT NULL, " +
            "`latestTurnId` TEXT NOT NULL, `revision` INTEGER NOT NULL, " +
            "`state` TEXT NOT NULL, `visibleGroupId` TEXT, `commitChecksum` TEXT, " +
            "`commitPayloadVersion` TEXT, `authorityOrigin` TEXT, " +
            "`terminalDisposition` TEXT, `updatedAt` INTEGER NOT NULL, " +
            "PRIMARY KEY(`authorityLineageKey`))");
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS " +
            "`index_conversation_authorities_characterId_laneKey_rootSourceId` " +
            "ON `conversation_authorities` (`characterId`,`laneKey`,`rootSourceId`)");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `visibleGroupId` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `authorityLineageKey` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `authorityOrigin` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `commitPayloadVersion` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `lineageRevision` INTEGER");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `turnRevision` INTEGER");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `laneKey` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `laneRevision` INTEGER");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `generationFingerprint` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `pipelineReleaseId` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `inputVisibilitySequence` INTEGER");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `inputClearEpoch` INTEGER");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `bridgeCommitChecksum` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `terminalDisposition` TEXT");
    }
};
```

Add nullable matching fields, including `terminalDisposition`, to
`ChatTurnEntity`. New v3 submission creates/claims
`ConversationAuthorityEntity` and pins its lineage key/revision on the turn
before any route is attempted. Task 13 fills completion fields from a validated
PC receipt; Task 14 may fill them from a locally committed fallback receipt. Old
Android Room v10 turns retain null and continue using turn ID for legacy
deduplication. The PC `user_version=14` database and Android Room version 11 are
unrelated stores; their version numbers have no shared lifecycle.

DAO updates must use one transaction and enforce two independent rules:

1. cursor stages advance only when incoming `localSequence >= stored.localSequence`;
2. once a turn has non-null
   `authorityLineageKey + visibleGroupId + commitPayloadVersion +
   bridgeCommitChecksum + terminalDisposition`, an exact replay is idempotent
   but any changed member is a `BRIDGE_AUTHORITY_CONFLICT` and cannot overwrite
   the row or advance `nativeCompleted`.

Lineage claim/replace/commit is also compare-and-swap on `ConversationAuthorityEntity.revision`. A new retry must prove its `retryOfTurnId` is the current `latestTurnId`; a committed lineage returns the stored receipt and never launches another model. The shared lineage/group hash implementation and cross-language vectors are added in Task 13.

`nativeCompleted` is written after the exact native terminal group is durably
complete: reply/action rows for `visible/action_only`, or the validated
metadata-only receipt for `skip`. `uiApplied` is written after Web confirms
every bubble/action of that group landed, or after its no-DOM skip
acknowledgement. `getConversationCursor({characterId})` returns all fields even
when null.
`markConversationCleared({characterId, clearedThroughSequence, clearEpoch})` is
monotonic on both cursor fields, clears Room reply/action rows through that
sequence, and prevents a late native completion from recreating them. A late
group is still acknowledged for relay cleanup, but it cannot trigger a
notification or WebView event.

- [ ] **Step 4: Run Android Room tests green**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebugAndroidTest connectedDebugAndroidTest --no-daemon --no-problems-report
```

Expected: PASS on an attached device/emulator; migration retains all Android Room v10 rows, exact receipt replay is idempotent, conflicting receipt replay is rejected, and repeated acknowledgements create one cursor. Merely compiling the instrumentation APK is not migration evidence. If no device/emulator can execute the migration test, stop and report the missing validation environment before formal release.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/db/ConversationCursorEntity.java android/app/src/main/java/com/siyi/al/execution/db/ConversationAuthorityEntity.java android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "feat: persist Android conversation visibility cursor"
```

### Task 13: Carry Visibility and Visible-Group Authority Through the Bridge

> **Execution authority amendment (2026-08-01):** The original Task 13 file
> list, examples, and steps below are retained only as design history. They are
> superseded in full by
> `docs/superpowers/plans/2026-08-01-yuqi-task13-bridge-authority.md`. Implement
> Task 13A, 13B, and 13C from that document, in order. Do not use the narrower
> legacy file whitelist or its fictional `normalizeEnvelope()` /
> `orchestrator.execute()` examples as an implementation contract.

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnSubmission.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AuthorityIdentity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AuthorityIdentityTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `tests/payment-batch-bridge-contract.test.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`

**Interfaces:**
- Consumes: Task 12 cursor and the existing complete user batch.
- Produces: shared `al-authority-v1` IDs; protocol v3 `authority` plus `context.visibilityCursor`; validation that maps v3 claims into the same Task 10 internal creation contract without selecting its authority version; activation of Task 11's previously dormant protocol-v3 canonical execution arm only after normalization succeeds; a receipt-derived result containing `authorityLineageKey`, `visibleGroupId`, lineage/turn/lane revisions, `inputVisibilitySequence`, `inputClearEpoch`, `generationFingerprint`, `releaseId`, `commitPayloadVersion`, `commitChecksum`, and the independently derived `terminalDisposition`.

- [ ] **Step 1: Write red Java and Node bridge contract tests**

```java
@Test
public void userReplyIncludesCompleteBatchAndVisibilityCursor() throws Exception {
    JSONObject input = BridgeInput.from(submission()).toJson();
    assertEquals(3, input.getJSONObject("message").getJSONObject("currentBatch")
        .getJSONArray("messages").length());
    JSONObject cursor = input.getJSONObject("context").getJSONObject("visibilityCursor");
    assertEquals("group-native-7", cursor.getString("nativeCompletedGroupId"));
    assertEquals("group-ui-6", cursor.getString("uiAppliedGroupId"));
    assertEquals(12L, cursor.getLong("localSequence"));
    assertEquals(7L, cursor.getLong("clearedThroughSequence"));
    assertEquals(3L, cursor.getLong("clearEpoch"));
    assertTrue(cursor.getBoolean("chatOpen"));
}

@Test
public void javaAuthorityIdentityMatchesEveryNodeVector() throws Exception {
    for (JSONObject vector : readAuthorityIdentityVectors()) {
        assertEquals(vector.getString("lineageKey"),
            AuthorityIdentity.lineageKey(vector.getString("roleId"),
                vector.getString("laneKey"), vector.getString("rootSourceId")));
        assertEquals(vector.getString("groupId"),
            AuthorityIdentity.groupId(vector.getString("lineageKey")));
    }
}

@Test
public void bridgeResultFromOlderClearEpochIsAcknowledgedWithoutVisibleRows() {
    store.markConversationCleared("yuqi", 12L, 3L, 1200L);
    BridgeResult old = validBridgeResult();
    old.inputVisibilitySequence = 12L;
    old.inputClearEpoch = 2L;
    assertEquals(DeliveryDisposition.REDACTED, mirror.apply(old));
    assertNull(store.findReplyGroup(old.visibleGroupId));
    assertEquals(0, notifications.count());
}

@Test
public void canonicalSkipCompletesWithoutReplyRowsOrNotification() {
    BridgeResult result = validCanonicalSkipResult();
    assertEquals("skip", result.terminalDisposition);
    assertEquals(DeliveryDisposition.APPLIED, mirror.apply(result));
    assertNull(store.findReplyGroup(result.visibleGroupId));
    assertEquals(result.visibleGroupId,
        store.getConversationCursor("yuqi").nativeCompletedGroupId);
    assertEquals(0, notifications.count());
}
```

```js
test('protocol v3 rejects an impossible visibility cursor', () => {
  const envelope = validProtocolV3Envelope();
  envelope.context.visibilityCursor.uiAppliedSequence = 9;
  envelope.context.visibilityCursor.nativeCompletedSequence = 8;
  assert.throws(() => normalizeEnvelope(envelope), /uiApplied.*nativeCompleted/);
});

test('protocol v3 authority is a verified claim, not a result-authority selector', () => {
  const envelope = validProtocolV3Envelope();
  envelope.authority.lineageKey = 'lin_forged';
  assert.throws(() => normalizeEnvelope(envelope), /authority lineage mismatch/);
  assert.equal(
    Object.hasOwn(normalizeEnvelope(validProtocolV3Envelope()), 'resultAuthorityVersion'),
    false
  );
});

test('protocol v3 result uses the persisted commit receipt and never derives group identity', () => {
  const receipt = store.getVisibleCommitReceipt('lineage-1');
  const result = bridgeResultFromCommitReceipt(receipt);
  assert.equal(result.authorityLineageKey, receipt.authorityLineageKey);
  assert.equal(result.visibleGroupId, receipt.visibleGroupId);
  assert.equal(result.commitChecksum, receipt.commitChecksum);
  assert.equal(result.terminalDisposition, 'visible');
  assert.equal(result.inputClearEpoch,
    store.getTurn(receipt.authoritativeTurnId).inputClearEpoch);
  assert.throws(
    () => bridgeResultFromTurnReplyJson(store.getTurn(receipt.authoritativeTurnId)),
    /receipt required/
  );
});

test('a normalized protocol v3 Yuqi turn enters the existing canonical v1 path', async () => {
  const envelope = normalizeEnvelope(validProtocolV3Envelope());
  const result = await orchestrator.execute(envelope);
  assert.equal(store.getTurn(result.turnId).resultAuthorityVersion, 1);
  assert.equal(store.spy.createCanonicalVisibleTurnInternal.calls.length, 1);
  assert.equal(store.spy.createTurnWithReleasePinInternal.calls.length, 0);
});
```

- [ ] **Step 2: Run focused bridge tests red**

Run:

```powershell
node --test tests/payment-batch-bridge-contract.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
cd android
.\gradlew.bat testDebugUnitTest --tests "*BridgeInputTest" --tests "*RoomBridgeMirrorTest" --no-daemon --no-problems-report
```

Expected: FAIL on missing cursor/group fields.

- [ ] **Step 3: Add the exact protocol payload**

```json
{
  "protocolVersion": 3,
  "authority": {
    "algorithm": "al-authority-v1",
    "roleId": "yuqi",
    "laneKey": "private_chat",
    "rootSourceId": "canonical-message-or-trigger-id",
    "lineageKey": "lin_sha256",
    "claimedLineageRevision": 1,
    "retryOfTurnId": "turn-id-or-null"
  },
  "context": {
    "visibilityCursor": {
      "nativeCompletedTurnId": "turn-id-or-null",
      "nativeCompletedGroupId": "group-id-or-null",
      "nativeCompletedSequence": 12,
      "uiAppliedTurnId": "turn-id-or-null",
      "uiAppliedGroupId": "group-id-or-null",
      "uiAppliedSequence": 11,
      "localSequence": 13,
      "clearedThroughSequence": 7,
      "clearEpoch": 3,
      "clearedAt": 1700000000000,
      "chatOpen": true,
      "quotedMessageId": "message-id-or-null"
    }
  }
}
```

Protocol normalization accepts v2 without a cursor/authority object for old installed clients and synthesizes an `unknown` visibility state. V3 requires both. Android obtains `rootSourceId` from the canonical source message/trigger, derives and persists the lineage before route execution, and sends it. `claimedLineageRevision` is 1 for a first local claim and increments exactly once when a retry replaces `latestTurnId`; it is not a caller-selected PC CAS token. PC independently derives role, lane and root source from the normalized envelope, recomputes `al-authority-v1`, loads the prior turn/lineage when present, and accepts the claimed revision only when it equals the deterministic next revision. V3 also verifies UI sequence is not ahead of native completion, `clearedThroughSequence <= localSequence`, clear epoch/time are non-negative, and retains every current-batch message.

The normalized `authority` object is verification evidence only. It never
produces, accepts, or overwrites `resultAuthorityVersion`; a v3 envelope sent
through an old compatibility creator still creates version 0, while Task 11's
eligible internal path creates version 1 for a valid v2 or v3 envelope. Task 13
must not add a second authority-version option to any store API. After v3
normalization succeeds, Task 11 passes the normalized envelope to the already
implemented `createCanonicalVisibleTurnInternal()` and the store independently
re-derives the lineage. A claim mismatch fails before turn creation.

Task 13 changes the Task 11 orchestrator eligibility guard from the single
accepted wire version `2` to the closed set `{2, 3}` and removes the temporary
explicit v3 rejection. It does not change release-pair, authority-version,
retry, or version-0 compatibility rules. The runtime recovery test must prove
that valid normalized v3 enters the existing canonical v1 creator, while wire
v1, non-Yuqi, invalid v3, and persisted version-0 recovery stay on their prior
paths.

Bridge results return:

```json
{
  "authorityLineageKey": "turn-lineage-key",
  "visibleGroupId": "reply-group-id",
  "lineageRevision": 2,
  "turnRevision": 4,
  "laneKey": "private_chat",
  "laneRevision": 8,
  "inputVisibilitySequence": 13,
  "inputClearEpoch": 3,
  "generationFingerprint": "sha256",
  "releaseId": "release-id",
  "commitPayloadVersion": "pc-visible-commit-v2",
  "commitChecksum": "sha256",
  "terminalDisposition": "visible|action_only|skip"
}
```

`AuthorityIdentity.java` implements the exact byte-length-prefixed SHA-256
algorithm from Task 10 and passes the same
`tests/fixtures/authority-identity-v1.json`; do not create an Android-only
canonicalization. The PC response builder must join
`visible_commit_receipts`, `visible_result_groups`, ordered items/actions, the
lineage, lane and authoritative turn, copy stored authority fields verbatim, and
derive only `terminalDisposition` through Task 10F's closed rule. It rejects any
non-joining turn/group/lineage/checksum or count mismatch rather than falling
back to `reply_json`. For an old installed v2 client, the wire response keeps its
legacy turn-ID-shaped payload and omits v3 receipt fields, but this is only a
response projection: an eligible new Task 11 execution may still be version 1
internally and use one canonical group/outbox. Persisted pre-v11/version-0 turns
continue to use the truly legacy authority and outbox path.

`terminalDisposition` is computed on PC from the already validated
`turns.rollout_key` and group rows, never from `envelope_json`, then verified
again on Android against the persisted Room turn kind: item count > 0 is
`visible`; zero items plus actions is `action_only`; zero/zero is `skip` only
for an automatic kind. It is never copied from model output. `RoomBridgeMirror` validates and
writes all v3 authority fields to the same `ChatTurnEntity` completion
transaction before advancing `nativeCompleted`. Before writing reply/action rows
it reads the cursor: if `result.inputClearEpoch < cursor.clearEpoch`, the result
is acknowledged as redacted and discarded; equal/newer epoch continues through
ordinary monotonic sequence checks. A `skip` stores the receipt and advances
completion but creates no reply group/part, action or notification. Exact
event/poll/replay duplicates return the stored row; a different
lineage/group/checksum/disposition for the same turn is quarantined as
`BRIDGE_AUTHORITY_CONFLICT`. A restart reconstructs the exact
lineage/group/release/revisions/input epoch/fingerprint/disposition from Room;
Android and Web must not generate a new group ID or checksum from current
content.

- [ ] **Step 4: Run bridge tests green**

Run the Step 2 commands again.

Expected: PASS for v2 compatibility, v3 receipt authority, complete batches, payment order, exact mirror replay, and conflicting-receipt rejection.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/TurnSubmission.java android/app/src/main/java/com/siyi/al/execution/AuthorityIdentity.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java android/app/src/test/java/com/siyi/al/execution/AuthorityIdentityTest.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java tests/payment-batch-bridge-contract.test.mjs yuqi-runtime/src/protocol.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
git commit -m "feat: carry visible conversation authority through bridge"
```

### Task 14: Add v3 Android Fallback Without Breaking v1/v2

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/FallbackCognitionPacketCodec.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/FallbackCognitionPacketCodecTest.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/LocalFallbackActionAuthority.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/LocalFallbackActionAuthorityTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngineStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/LiveReplyQualityGate.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/FallbackJournal.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/BridgeReceiptCheckpoint.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/LiveReplyQualityGateTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionServicePolicyTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/reconcile.mjs`
- Create: `yuqi-runtime/test/android-fallback-authority.test.mjs`
- Modify: `yuqi-runtime/test/reconcile.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/store-release-authority-v14.test.mjs`
- Create: `android/app/src/test/resources/fixtures/cognition-v3.json`
- Create: `android/app/src/test/resources/fixtures/cognition-v2.json`
- Create: `android/app/src/test/resources/fixtures/memory-v1.json`
- Create: `android/app/src/test/resources/fixtures/chat-v1.json`
- Create: `tests/fixtures/android-fallback-authority-v2.json`

**Interfaces:**
- Consumes: Task 12 local lineage, Task 13 shared IDs, `cognition-v3`, `cognition-v2`, `memory-v1`, and `chat-v1` snapshots.
- Produces: `FallbackCognitionPacketCodec.decode(JSONObject) -> FallbackContext`; a separate closed `FallbackExecution` carrier; ambiguity-safe fallback routing; one Room local receipt; idempotent PC import of an already-visible Android result.

#### Task 14 authority and payload contract

`cognition-v3` remains a compact semantic view. Its semantic-view key set is exactly the object returned by `withCognitionV3Snapshot()` in Task 15: `contract`, `schemaVersion`, `roleId`, `hardConstraints`, `preferences`, `currentStances`, `relationship`, `recentGroups`, `verifiedFacts`, `lifeSignals`, and `authorSettings`. The local `snapshotJson` is a submission container: `buildNativeExecutionSnapshot()` stores that semantic view plus the reserved local-only `fallbackExecution` key so a restart before first prepare cannot lose model inputs. The semantic checksum is computed after splitting the container and removing `fallbackExecution`; LAN/cloud `BridgeInput` projection always removes the reserved key.

The reserved local `fallbackExecution` object is a separate closed member of that submission container when local execution is possible:

```json
{
  "contract": "cognition-v3-fallback-v1",
  "deviceId": "<stable native device id>",
  "cognition": { "configId": "<1..128 chars>", "system": "<0..65536 UTF-8 bytes>", "messages": "<0..200 ordered messages, 512 KiB total>" },
  "expression": { "configId": "<1..128 chars>", "system": "<0..65536 UTF-8 bytes>", "messages": "<0..200 ordered messages, 512 KiB total>" }
}
```

The local object's exact keys are `contract`, `deviceId`, `cognition`, and `expression`; the two nested model objects have no keys other than `configId`, `system`, and `messages`. `deviceId` is the stable native installation/bridge identity already supplied by the Web settings and persisted with the turn; it is not generated during fallback or after restart. When a non-empty `BridgeConfig.deviceId` exists it must equal this value, even if the bridge is disabled. A disabled bridge therefore authorizes the route without making `bridgeDeviceId()` throw or creating a random replacement identity. Messages use the existing supported content shape (including the current ordered `{role,content}` memory/chat form), are checked for native types and bounded UTF-8/array size, and are never required to invent IDs or sequence fields. `FallbackCognitionPacketCodec` first splits the submission container into the exact semantic view and this reserved local object. `fallbackExecution` is restored from the container/checkpoint, is never folded into the semantic checksum, and is never serialized into a LAN/cloud envelope. `BridgeInput.prepareV3Envelope()` never serializes the submission container. Direct turns keep the existing closed v3 `context` facts (`currentBatch`, payment, retry, visibility cursor, and only a separately supplied protocol-valid scene); they do not put the cognition-v3 semantic object into `context.scene`. Automatic turns may place a copy of the compact semantic view at `trigger.context.snapshot`. Both paths explicitly drop `fallbackExecution`, device/config IDs, system prompts, and model messages before envelope hashing. The only fallback discriminator is `contract`. `packetType` is accepted solely by the explicitly named v1/v2 compatibility decoder and is never used to select a v3 path; v1/v2 envelope bytes remain unchanged.

The four v3 route outcomes are one closed enum shared by Android and PC:

```text
LOCAL_FALLBACK_ALLOWED  = bridge disabled before any remote call
                         | every attempted route explicitly returns NOT_ACCEPTED_ALLOW_FALLBACK
REMOTE_OWNS_AUTHORITY   = CLOUD_ACCEPTED | BRIDGE_WAITING
AUTHORITY_AMBIGUOUS     = deadline | lost response | timeout | unknown exception
REMOTE_FINAL_FAILURE    = explicit final failure without fallback permission
```

Only `LOCAL_FALLBACK_ALLOWED` may invoke `NativeModelGateway` locally. `AUTHORITY_AMBIGUOUS` persists `BRIDGE_WAITING`, does not call the local model, and later reconciles/polls/replays. At the five-minute global limit it exposes `FAILED_RETRYABLE/AUTHORITY_UNRESOLVED` while retaining the open lineage. No HTTP status, timeout, retryable exception, or caller-supplied boolean may be converted into `NOT_ACCEPTED_ALLOW_FALLBACK`. v1/v2 retain their existing routing and fallback behavior byte-for-byte.

Even after local execution is authorized, the local model output is only a draft. `BridgeRouter` may return that draft only for `LOCAL_FALLBACK_ALLOWED`; `ExecutionEngine` then runs the existing parser, `LiveReplyQualityGate`, terminal-disposition rules, and structured-action target validation before calling the store. No temporary `BridgeResult`, raw reply, hidden directive, or parsed action becomes visible, notifiable, or journaled before the Room authority transaction commits.

`RoomExecutionStore.commitAndroidFallbackInternal(...)` is one Android Room transaction that re-reads the open `ConversationAuthorityEntity`, active terminal `ChatTurnEntity`/`ExecutionAttempt` checkpoint, checkpoint checksum, cursor/clear epoch, and lane revision; derives the complete input batch and authority IDs; inserts the existing Android `ReplyPartEntity` rows, including the already-supported typed structured parts such as payment/moment/relationship/plan (or an automatic zero-part/zero-action `skip` with a deterministic group identity and receipt); stores the corresponding closed action-authority projections in checkpoint v2/receipt instead of inventing a second Android action table; CASes the local authority to committed; writes `commitPayloadVersion='android-fallback-commit-v2'`, `authorityOrigin='android_fallback'`, `journalSyncSeq`, and `nativeCompleted`. A direct fallback cannot produce `skip`. It never writes PC cognition/state/stance/memory/comparison/outbox/notification rows; PC `turns/...` mirror rows are created only by the later import transaction.

An old-epoch local result is stored as a redacted audit checkpoint with `deletedAt`, no parts, no group receipt, no journal receipt and no notification. Room may retain its internal terminal row as `COMPLETED` for atomic audit closure, but the Capacitor result projection must expose native `redacted:true`, the exact nullable `deletedAt`, and public `state='CANCELLED'`; this lets the existing UI reconciliation clear a pending indicator without treating an empty redacted result as a successful visible reply.

The Android generator, `BridgeReceiptCheckpoint`, and the PC external-receipt importer use the same closed action contract rather than treating a matching hash as semantic validation. Every supported action kind has an exact namespace/target and exact payload-key/type rule; moment and relationship payloads reuse the existing canonical validators, payment contains only its immutable message target, and each role-plan operation permits only the fields consumed by the existing role-plan domain for that exact `op`, including recursively closed `patch`/`schedule` members. On checkpoint replay Android must also recompute every mutable action target revision from the checkpoint's persisted normalized input snapshot: payment from the exact payment object, moment/comment from the exact target object, relationship from `{relationshipStage,stagePersonaRevision}`, role-plan create from the pinned lineage revision, and later role-plan operations from the exact pinned plan object. A syntactically valid SHA revision is insufficient. An unknown kind, wrong kind/target pair, duplicate single-action namespace, mismatched recomputed revision, or rehashed unknown/nested field such as `secret` fails before the Room commit or PC mirror write. Valid legacy v1/v2 action projections remain byte-compatible.

Because a direct receipt's batch does not contain the structured payment/scene target, a direct result with actions also carries one closed `input.pinnedActionContext`. Its exact keys are `version/payment/scene/input/checksum`; `input` has the exact nullable keys `targetMoment/targetComment/rolePlan`. Android selects only snapshots actually consumed by that receipt's actions, strips `currentBatch`, retry/cursor data, full scene prompt material, model configuration and all unused targets, then hashes `{version,payment,scene,input}`. Each retained payment, moment, comment and role-plan snapshot is itself an allow-listed native-type object; an unknown/private nested field is rejected before the Room commit rather than copied or silently hashed into authority. The Android checkpoint validator compares this projection with the persisted normalized envelope; the PC importer independently enforces the same nested allow-lists, checksum and one-to-one action coverage before recomputing every target revision. A direct receipt with actions but no proof, an unused extra proof, or a changed proof/action pair is a zero-write conflict. A direct text-only receipt omits the field, while automatic receipts continue to use their already-persisted closed trigger context.

Legacy `paymentStatus:'pending'` also remains byte-compatible on v1/v2, but it is not a canonical terminal mutation and must never be relabelled as accept or decline. In a v3 local draft, visible text plus a pending directive commits only the visible text; a pending-only draft does not complete, notify, or emit a receipt and remains on the existing non-terminal/failure-retry path. Likewise, an old simplified relationship directive that lacks the canonical evidence/revision fields may not be padded with invented confidence, evidence, reason, or time. V1/v2 retain the old projection; a v3 local draft with visible text drops only that non-authoritative directive and keeps the text, while a directive-only draft remains uncommitted. A complete relationship action still uses the strict canonical contract and pinned scene revision.

The local receipt semantic tuple also carries the checkpoint's native nullable `retryOfTurnId`. A null value is the only legal fresh import. A non-null value is legal only after a verified remote failure: the PC transaction must already contain that exact failed parent as the open lineage's latest member, the parent must retain native `retryAllowed:true`, and the receipt's claimed lineage revision must equal the persisted parent lineage revision plus one. The importer then creates the Android-owned child attempt and commits that lineage atomically; it never fabricates a missing parent, replaces a committed lineage, or silently flattens a retry into a fresh root. Exact replay still resolves by lineage/group/checksum after the child commit.

`reconcile.importExternalVisibleReceiptInternal(receipt)` is the only PC import entry point. It validates all Task 10/13 IDs and commitments, then in one transaction creates or exact-replays the complete mirror graph: `turn_authority_lineages`, root/attempt `turns`, `current_user_batches`/items and their message identity projections, the required existing lane/cursor joins, visible group/items/actions, manifest, and commit receipt. The external receipt and manifest are the import proof; PC never creates `cloud_deliveries` or an outbox row for this mirror. It reuses verified immutable parent projections and never invents missing parents. Android remains the execution owner for every imported action because the enclosing group/receipt origin is `android_fallback`; the PC action executor and outbox must reject that origin instead of adding a fictitious per-action status field or executing it again. It writes no PC cognition/state/stance/memory/comparison/outbox/notification/evidence rows and only advances visibility cursors monotonically. ACK is sent only after commit. Same lineage/group/checksum replay is idempotent; a different receipt records at most one redacted `authority_conflict` diagnostic in a separate transaction and is not ACKed. Redacted/cancelled sources cannot be resurrected.

Before inserting any imported input or visible `messages` projection, the transaction checks the complete existing row with the same `message_id`. An authority-equivalent row is reused without mutation; a foreign turn/group, changed speaker/recipient/content/time/device identity, or changed authoritative projection is a zero-write conflict. This applies to both pre-existing synchronized input bubbles and character result messages, so first import after another recovery channel is idempotent instead of failing a raw primary-key insert.

The non-PC execution release is a real immutable row in the existing `pipeline_releases` table, not a fabricated model release. For contract checksum `C`, use `release_id='android_fallback:' + C`; `release_checksum` is the deterministic canonical hash of the closed metadata `{origin:'android_fallback', contract:'cognition-v3-fallback-v1', contractChecksum:C, codecVersion:1}` (never a hash of `now` or a generated model release). Required existing columns use closed values (`pipeline_version='android-fallback-v2'`, `preset_version=C`, `evaluator_version='android-fallback-authority-v1'`, `created_at=0`, and model/component JSON containing only the same origin/contract/checksum metadata). Creation is insert-or-exact-replay; a same-ID/different-checksum row is a hard conflict. The imported PC turn/group stores `authoritativeReleaseId='android_fallback:' + C` and `authoritativePipelineChecksum=release_checksum`, and every manifest/receipt checksum join uses that metadata hash. Reopen validates every Android fallback turn/group/receipt against this registry row. No schema version increase is permitted; if the existing required columns cannot store this closed metadata, stop before implementation with the exact missing-column evidence.

The Android local checkpoint and journal are versioned independently from the PC remote checkpoint: local fallback uses `bridgeAuthorityCheckpoint.version=2` with the closed local-only fields `fallbackExecution`, `journalSyncSeq`, and the v2 receipt payload; the Task 13 remote checkpoint remains version 1 with its existing closed key set. Version 2 is stored in the two existing nullable `ExecutionAttemptEntity` checkpoint columns added by Room v12; Task 14 adds no entity, table, or migration. The `authority_receipt` journal entry is a deterministic `FallbackJournal` projection of that persisted v2 checkpoint, not a second mutable copy or placeholder message. `BridgeReceiptCheckpoint` and Room reopen validation must branch explicitly on version 1 versus version 2, never widen the v1 allow-list. `journalSyncSeq` is allocated through one `AlExecutionDao` transaction using a reserved allocator row in the existing `yuqi_sync_cursors` table (separate from the `yuqi_pc` ACK cursor), is a positive safe integer globally monotonic per device across raw-message, annotation, and authority-receipt journal sources, and is persisted in checkpoint v2. `RoomBridgeMirror`, `AlExecutionPlugin` annotation/import writers, and local fallback commit must all use this allocator; no remaining producer may use its own `maxRawSyncSeq/maxAnnotationSyncSeq + 1`. It never derives from a turn-local reply ordinal or wall-clock time. `FallbackJournal` enumerates `authority_receipt` by this sequence, so automatic `skip` cannot depend on a message sequence.

An Android-fallback v2 checkpoint is journal-only for PC convergence. `AlExecutionService` and `ExecutionServicePolicy` must classify `checkpoint.version=2`, `authorityOrigin='android_fallback'`, and `outcome.route='local'` before any remote-receipt coordinator call, must never send it as `AUTHORITY_DELIVERY_RECEIPT`, and must not fall back to the legacy message receipt. The remote Task 13 checkpoint v1 keeps its existing coordinator path. Redacted local fallback never emits a group receipt. Until Task 20 introduces an independent retraction/control transport, the durable v2 receipt is exported by `FallbackJournal` on the next recovery packet and remains pending across restart until the PC recovery ACK advances past its `journalSyncSeq`; tests must prove this pending/replay/ACK lifecycle instead of assuming a separate immediate sender.

Every `authority_receipt` entry contains the complete normalized payload needed for one PC import: lineage/turn/group identity, terminal disposition, ordered input batch, ordered reply items/actions, cursor/clear epoch, the compact semantic cognition snapshot plus its `agencySnapshotChecksum`, release contract/checksum, `journalSyncSeq`, and the canonical commit checksum. `agencySnapshotChecksum` is the canonical SHA-256 of the compact semantic snapshot after `fallbackExecution` is removed, and becomes the imported turn's immutable `agency_snapshot_checksum`; PC can therefore recompute it without receiving local model configuration. The entry explicitly excludes `fallbackExecution`, device/config IDs, system prompts, and model messages; those remain local checkpoint material. The receipt entry is durable before any subsequent ordinary message projection. A later message entry may only exact-idempotently reference the same authority group/item identity; it cannot create a second authority or supply missing semantic fields. Automatic `skip` still has a deterministic group identity and receipt, but exactly zero reply parts and zero actions; it is never represented as “no group.”

The imported mirror must satisfy the existing v13/v14 reopen invariants before ACK: `resultAuthorityVersion=1`, `lineageRevisionAtCreation>=1`, one complete input batch and attempt commitment, non-null agency snapshot checksum, `turns.rollout_key` in the closed kind set, immutable release join to the `android_fallback:<contractChecksum>` row, exact lineage/group/manifest/receipt/action commitments, and the required lane/cursor joins. Close/reopen must validate this graph and the release row; no import is accepted merely because a group row exists.

- [ ] **Step 1: Write red codec compatibility and authority tests**

```java
@Test
public void decodesV3CompactAgencySnapshot() throws Exception {
    FallbackContext value = codec.decode(readFixture("cognition-v3.json"));
    assertEquals(3, value.schemaVersion);
    assertEquals(2, value.currentStances.size());
    assertEquals("close", value.relationshipBase);
    assertEquals(20, value.recentGroups.size());
}

@Test
public void continuesToDecodeV2AndV1() throws Exception {
    assertEquals(2, codec.decode(readFixture("cognition-v2.json")).schemaVersion);
    assertEquals(1, codec.decode(readFixture("memory-v1.json")).schemaVersion);
    assertEquals(1, codec.decode(readFixture("chat-v1.json")).schemaVersion);
}

@Test
public void fallbackCannotPersistInferredHardConstraint() {
    assertFalse(gateway.execute(v3SubmissionWithInferredBoundary())
        .statePatch().has("hardConstraints"));
}

@Test
public void ambiguousTimeoutNeverAuthorizesV3Fallback() {
    lan.failWith(lanDeadlineAfterPossibleAccept());
    cloud.failWith(cloudDeadlineAfterPossibleAccept());
    assertThrows(BridgePendingException.class,
        () -> router.execute(v3Submission()));
    assertEquals(0, fallback.callCount());
}

@Test
public void explicitNotAcceptedOrDisabledBridgeCanCommitOneLocalReceipt() {
    lan.failWith(explicitNotAccepted());
    cloud.failWith(explicitNotAccepted());
    engine.runPrepared(v3Submission());
    ChatTurnEntity turn = dao.turn(v3Submission().turnId);
    ConversationAuthorityEntity authority = dao.conversationAuthority(turn.authorityLineageKey);
    assertEquals("android_fallback", turn.authorityOrigin);
    assertEquals(AuthorityIdentity.groupId(turn.authorityLineageKey), turn.visibleGroupId);
    assertEquals("COMMITTED", authority.state);
    assertNotNull(turn.bridgeCommitChecksum);
}

@Test
public void automaticFallbackSkipCommitsGroupReceiptWithoutReplyParts() {
    TurnSubmission submission = v3AutomaticSubmissionWithNoMotive();
    engine.runPrepared(submission);
    ChatTurnEntity turn = dao.turn(submission.turnId);
    assertEquals("skip", turn.terminalDisposition);
    assertNotNull(turn.visibleGroupId);
    assertEquals(0, dao.replyPartCount(turn.turnId));
    assertEquals(0, BridgeReceiptCheckpoint.localActions(dao.activeAttempt(turn.turnId)).size());
    assertEquals(0, notifications.count());
}
```

```js
test('Android fallback receipt imports as external visibility without PC side effects', () => {
  const beforeState = store.getCognitiveState('yuqi');
  const receipt = reconcile.importAndroidFallbackReceipt(validFallbackReceipt());
  assert.equal(receipt.authorityOrigin, 'android_fallback');
  assert.equal(store.visibleGroupsForLineage(receipt.authorityLineageKey).length, 1);
  assert.equal(
    store.getVisibleResultManifest(receipt.visibleGroupId).payloadVersion,
    'android-fallback-commit-v2'
  );
  assert.equal(
    store.getVisibleResultManifest(receipt.visibleGroupId).semanticChecksum,
    receipt.commitChecksum
  );
  assert.equal(store.outboxForGroup(receipt.visibleGroupId).length, 0);
  assert.deepEqual(store.getCognitiveState('yuqi'), beforeState);
  assert.equal(store.comparisonJobsForGroup(receipt.visibleGroupId).length, 0);
  assert.deepEqual(reconcile.importAndroidFallbackReceipt(validFallbackReceipt()), receipt);
});

test('different PC and Android receipts for one lineage are quarantined, never merged', () => {
  commitVisibleResult(pcCommitFor('lineage-1'));
  assert.throws(
    () => reconcile.importAndroidFallbackReceipt(changedFallbackReceipt('lineage-1')),
    /cross-device authority conflict/
  );
  assert.equal(store.visibleGroupsForLineage('lineage-1').length, 1);
  assert.equal(store.authorityConflictsFor('lineage-1').length, 1);
});
```

The fixture boundary is explicit: the four Android JSON files are loaded from `android/app/src/test/resources/fixtures/` by `readFixture(...)`; `tests/fixtures/android-fallback-authority-v2.json` is the deterministic PC/reconcile matrix. The matrix has independent normal-visible, automatic-skip, action-only, exact-replay-after-restart, cross-device conflict, changed group/lineage/commit/checksum, out-of-order or missing IDs, malformed checksum, redacted/cancelled, v1 `inputClearEpoch=0`, v1 non-zero clear epoch rejection, and write-fault cases. Every invalid case asserts zero Room semantic writes, zero PC mirror writes, zero ACK, and no legacy fallback.

Add a red contract test that builds a v3 direct and automatic envelope from a submission container containing `fallbackExecution`. The direct envelope must contain only its existing closed current-batch/payment/retry/cursor facts and must not substitute the cognition object for `context.scene`; the automatic `trigger.context.snapshot` may contain only the compact semantic view. Neither envelope may contain `fallbackExecution`, `deviceId` from the local carrier, config IDs, system prompts, or model messages; v1/v2 serialized bytes must equal their existing snapshots. Add a checkpoint test that accepts the local v2 closed keys, rejects a v2 key added to the remote v1 checkpoint, and rejects a local checkpoint missing `journalSyncSeq`. Add a real Room concurrency test in which message, annotation, and fallback receipt producers interleave and still receive unique increasing journal sequences; ACK at any returned sequence must not skip a same-sequence entry from another source.

- [ ] **Step 2: Run Android unit tests red**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*FallbackCognitionPacketCodecTest" --tests "*LocalFallbackActionAuthorityTest" --tests "*ExecutionEngineTest" --tests "*LiveReplyQualityGateTest" --tests "*BridgeRouterTest" --tests "*RoomBridgeMirrorTest" --tests "*BridgeInputTest" --tests "*BridgeReceiptCheckpointTest" --tests "*FallbackJournalTest" --tests "*ExecutionServicePolicyTest" --no-daemon --no-problems-report
cd ..
node --test yuqi-runtime/test/android-fallback-authority.test.mjs yuqi-runtime/test/reconcile.test.mjs
```

Expected: FAIL because v3 is currently rejected, deadline still broadly authorizes fallback, local checkpoint v2/journal sequencing is absent, and no external receipt import authority exists. Record the exact red failures before implementation.

- [ ] **Step 3: Implement a focused compatibility codec and v3 fallback**

```java
public final class FallbackCognitionPacketCodec {
    public FallbackContext decode(JSONObject snapshot) throws JSONException {
        String contract = snapshot.optString("contract", "chat-v1");
        switch (contract) {
            case "cognition-v3": return decodeV3(snapshot);
            case "cognition-v2": return decodeV2(snapshot);
            case "memory-v1": return decodeMemoryV1(snapshot);
            case "chat-v1": return decodeChatV1(snapshot);
            default: throw new IllegalArgumentException("unsupported fallback contract: " + contract);
        }
    }
}
```

`FallbackCognitionPacketCodec` splits the local submission container into the exact semantic view and the reserved `fallbackExecution` object. `NativeModelGateway` consumes that typed carrier, uses its persisted `deviceId` for local authority preparation (and verifies equality with a configured non-empty bridge device ID), sends a compact cognition request before expression for v3, and enforces the same structured-action targets as PC. Fallback receives relevant hard constraints, at most two current stances, base/phase, recent complete groups, and allowed actions. Fallback-created facts are marked `pending_review`; it never overwrites a PC state record or rewrites a result already visible.

For v3, replace the old broad `fallbackAuthorized` boolean with these explicit route outcomes:

```text
bridge disabled before any remote call                  -> LOCAL_FALLBACK_ALLOWED
all routes explicitly reply NOT_ACCEPTED_ALLOW_FALLBACK -> LOCAL_FALLBACK_ALLOWED
CLOUD_ACCEPTED / BRIDGE_WAITING                         -> REMOTE_OWNS_AUTHORITY
deadline, lost response, unknown exception              -> AUTHORITY_AMBIGUOUS
explicit final without fallback                         -> REMOTE_FINAL_FAILURE
```

`AUTHORITY_AMBIGUOUS` persists `BRIDGE_WAITING` and uses receipt/poll/replay; it never invokes the local model. If no receipt or definitive not-accepted result is available by the global five-minute limit, stop the thinking UI and expose `FAILED_RETRYABLE/AUTHORITY_UNRESOLVED`; keep the lineage open for later reconciliation and do not fabricate a local reply. Preserve legacy routing behavior for old v1/v2 turns only.

When local fallback is allowed, `RoomExecutionStore` uses the one Android transaction described above, including allocation of `journalSyncSeq` in the same commit. An automatic `skip` commits the authority/group identity and receipt with zero reply/action rows and no notification; a direct fallback can never skip. Its normalized checksum payload contains lineage/group, ordered reply/action payloads, the complete input batch/cursor identity including `inputClearEpoch`, fallback contract checksum, and the deterministic `android_fallback:<contractChecksum>` release ID; it contains no unavailable PC state revisions and no timestamps/random IDs. Exact replay returns the stored receipt; different content conflicts.

`FallbackJournal` enumerates the durable `authority_receipt` entries by `journalSyncSeq`, whose payload contains the normalized semantic receipt, input batch, manifest, and result items/actions but never `fallbackExecution`, system prompts, or model messages. `reconcile.mjs` validates all Task 10/13 IDs, release metadata, complete commitments, and the semantic checksum, then calls `store.importExternalVisibleReceiptInternal()`. The manifest stores the exact normalized `android-fallback-commit-v2` payload received from Room and must hash to the imported receipt checksum; it is never reconstructed from projection rows. The transaction creates no PC cognition state/stance/memory/comparison/outbox/cloud-delivery/notification writes and never increments live shadow/canary evidence. Imported actions retain their original semantic payload; non-execution is enforced by the `android_fallback` group/receipt origin at every PC action/outbox entry point, not by mutating the signed action JSON. Its receipt has null PC lane/state revisions; reconciliation may only advance lane visibility cursors monotonically by the imported local sequence and clear epoch and must not replace a newer PC `latest_authoritative_group_id`. A different existing receipt inserts a sanitized authority-conflict diagnostic and aborts import. Import may accept historical v1 only when `inputClearEpoch=0`; every new fallback writes v2.

- [ ] **Step 4: Run Android fallback tests green**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*FallbackCognitionPacketCodecTest" --tests "*LocalFallbackActionAuthorityTest" --tests "*ExecutionEngineTest" --tests "*LiveReplyQualityGateTest" --tests "*BridgeRouterTest" --tests "*RoomBridgeMirrorTest" --tests "*BridgeInputTest" --tests "*BridgeReceiptCheckpointTest" --tests "*FallbackJournalTest" --tests "*ExecutionServicePolicyTest" --no-daemon --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
cd ..
node --test yuqi-runtime/test/android-fallback-authority.test.mjs yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs
npm.cmd test
git diff --check
```

Expected: PASS for all four contracts; v3 invalid action targets fail before any local commit; ambiguous remote outcomes never start fallback; explicit local authority produces/imports one receipt with no PC duplicate side effects.

The final gate must additionally prove:

- direct visible, automatic visible, action-only, and automatic skip each commit exactly one Room authority receipt; skip has one group identity and zero part/action rows;
- fault injection at every Room write boundary leaves authority, parts/actions, cursor, checkpoint, and journal sequence unchanged;
- close/reopen preserves local checkpoint v2 and enumerates `authority_receipt` before optional message projections; exact replay does not allocate a second sequence, and interleaved message/annotation/receipt producers cannot duplicate or skip a journal sequence;
- v3 direct and automatic bridge envelopes contain no `fallbackExecution`, local carrier device/config ID, system prompt, or local model message; direct keeps the pre-existing v3 scene contract rather than embedding cognition-v3 there, automatic carries only the compact semantic snapshot, and v1/v2 byte snapshots remain unchanged;
- PC import passes v13/v14 close/reopen, creates the deterministic external release row, and has zero cognition/state/stance/memory/comparison/outbox/cloud-delivery/notification/live-shadow/canary side effects;
- malformed/changed/duplicate-order/cross-device/redacted receipts are zero-write and zero-ACK; an exact retry after a crash before ACK returns the original receipt and then advances the cursor once;
- no attached device means `connectedDebugAndroidTest` remains an explicit release hard gate, not a claimed pass or a skipped success.

Stop at this gate for independent review. Any missing persistent fact, schema mismatch, or v1/v2 snapshot change is structural and must amend this task before committing.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/FallbackCognitionPacketCodec.java android/app/src/test/java/com/siyi/al/execution/FallbackCognitionPacketCodecTest.java android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java android/app/src/main/java/com/siyi/al/execution/ExecutionEngineStore.java android/app/src/main/java/com/siyi/al/execution/LiveReplyQualityGate.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java android/app/src/main/java/com/siyi/al/execution/bridge/FallbackJournal.java android/app/src/main/java/com/siyi/al/execution/BridgeReceiptCheckpoint.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java android/app/src/test/java/com/siyi/al/execution/LiveReplyQualityGateTest.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java android/app/src/test/resources/fixtures/cognition-v3.json android/app/src/test/resources/fixtures/cognition-v2.json android/app/src/test/resources/fixtures/memory-v1.json android/app/src/test/resources/fixtures/chat-v1.json tests/fixtures/android-fallback-authority-v2.json yuqi-runtime/src/store.mjs yuqi-runtime/src/reconcile.mjs yuqi-runtime/test/android-fallback-authority.test.mjs yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs
git commit -m "feat: support cognition v3 Android fallback"
```

### Task 15: Build the Web v3 Snapshot and Exactly-Once Cursor Handshake

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: Task 12 plugin cursor, complete staged batch, current character snapshot.
- Produces: `withCognitionV3Snapshot()`, `getYuqiVisibilityCursor()`, v3 task options, and exactly-once `uiApplied` acknowledgement.

- [ ] **Step 1: Write red Web contract tests for snapshot bounds and cursor order**

```js
test('v3 snapshot is compact and preserves complete visible groups', () => {
  const snapshot = withCognitionV3Snapshot(fixtureSnapshot);
  assert.equal(snapshot.contract, 'cognition-v3');
  assert.ok(snapshot.hardConstraints.length <= 5);
  assert.ok(snapshot.currentStances.length <= 2);
  assert.ok(snapshot.recentGroups.length <= 20);
  assert.deepEqual(snapshot.recentGroups.at(-1).messageIds, ['u1', 'u2', 'u3']);
  assert.equal(JSON.stringify(snapshot).includes('responseRisks'), false);
});

test('native v3 submission keeps one local fallback carrier outside semantic snapshot', async () => {
  const container = await buildNativeExecutionSnapshot('yuqi', directTask());
  assert.equal(container.contract, 'cognition-v3');
  assert.equal(container.fallbackExecution.contract, 'cognition-v3-fallback-v1');
  assert.equal(container.fallbackExecution.deviceId, settings.deviceId);
  assert.deepEqual(Object.keys(container.fallbackExecution).sort(),
    ['cognition', 'contract', 'deviceId', 'expression']);
  assert.equal(JSON.stringify(withCognitionV3Snapshot(container)).includes('fallbackExecution'), false);
});

test('submit reads native cursor before building one complete task', async () => {
  await queueAndroidUserReply(threeBubbleBatch());
  assert.deepEqual(plugin.calls.map(x => x.name).slice(0, 2),
    ['getConversationCursor', 'submitTurn']);
  assert.equal(plugin.calls[1].args.options.context.visibilityCursor.localSequence, 13);
});

test('event and polling race renders and acknowledges one visible group', async () => {
  await Promise.all([emitCompletion('turn-1'), pollCompletion('turn-1')]);
  assert.equal(renderedGroups('group-1'), 1);
  assert.equal(plugin.count('markUiApplied', 'group-1'), 1);
});

test('terminal skip acknowledges once without a DOM group or notification', async () => {
  await Promise.all([emitCompletion('skip-turn'), pollCompletion('skip-turn')]);
  assert.equal(renderedGroups('skip-group'), 0);
  assert.equal(notificationsFor('skip-turn'), 0);
  assert.equal(plugin.count('markUiApplied', 'skip-group'), 1);
});
```

- [ ] **Step 2: Run Web tests red**

Run: `node --test test-basic.mjs tests/yuqi-ui-contract.test.mjs`

Expected: FAIL on missing v3 snapshot/cursor handshake.

- [ ] **Step 3: Implement the bounded snapshot and one reconciliation path**

```js
function withCognitionV3Snapshot(snapshot) {
  return {
    contract: 'cognition-v3',
    schemaVersion: 3,
    roleId: snapshot.roleId,
    hardConstraints: rankRelevant(snapshot.hardConstraints, 5),
    preferences: rankRelevant(snapshot.preferences, 4),
    currentStances: rankRelevant(snapshot.currentStances, 2),
    relationship: compactRelationship(snapshot.relationship),
    recentGroups: takeCompleteMessageGroups(snapshot.recentGroups, 20),
    verifiedFacts: rankRelevant(snapshot.verifiedFacts, 8),
    lifeSignals: compactLifeSignals(snapshot.lifeSignals),
    authorSettings: compactAuthorSettings(snapshot.authorSettings)
  };
}

function withLocalFallbackExecution(semanticSnapshot, localModelInputs, deviceId) {
  return {
    ...semanticSnapshot,
    fallbackExecution: closedFallbackExecution({
      contract: 'cognition-v3-fallback-v1',
      deviceId,
      cognition: localModelInputs.cognition,
      expression: localModelInputs.expression
    })
  };
}

async function getYuqiVisibilityCursor(characterId) {
  return withTimeout(
    AlExecution.getConversationCursor({ characterId }),
    3000,
    unknownVisibilityCursor(characterId)
  );
}
```

`buildNativeExecutionSnapshot()` writes the local submission container by combining the exact compact semantic snapshot with one closed `fallbackExecution` carrier. It calls `ensureDeviceId()` before building that carrier, so the persisted ID is stable even when bridge transport is disabled; it never copies secrets, tokens, endpoints, or entire settings. `withCognitionV3Snapshot()` and every wire projection ignore/remove the reserved carrier. `queueAndroidUserReply()` reads the cursor, then builds one task from the already-complete submitted batch. Event, poll, reload replay, and notification-open all enter the existing bounded single-flight reconciler. DOM insertion is keyed by `visibleGroupId`; only after every bubble in a `visible` group exists does Web call `markUiApplied`. For a verified `skip`, the same reconciler confirms there are zero reply/action rows, renders nothing, and sends one no-DOM `markUiApplied` acknowledgement for that authority group so reload cannot loop forever. `action_only` waits for the structured action application rather than a chat bubble. A timed-out plugin Promise releases its lock in `finally` and leaves Room unacknowledged for later replay.

Keep the existing transport copy: `LOCAL_QUEUED` shows “正在把消息送过去…”, `CLOUD_ACCEPTED` remains a delivery/waiting state, and only `PC_ACCEPTED` may switch the UI to model-thinking wording. V3 metadata must not collapse local queue acceptance into PC acceptance.

- [ ] **Step 4: Run all six recovery races and Web contracts green**

Run: `node --test test-basic.mjs tests/yuqi-ui-contract.test.mjs`

Expected: PASS for notification-before-Web, Web-before-notification, hanging plugin, lost event, page reload, event/poll duplicate, and complete multi-bubble landing.

- [ ] **Step 5: Commit**

```powershell
git add tavern-app/index.html test-basic.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: handshake Web visibility with cognition v3"
```

### Task 16: Integrate Direct Reply, Payment, Media, Quotes, and Multi-Bubble Semantics

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs` — v3-only rich `currentBatch.messages` projection and closed native-type validation; v1/v2 normalization remains byte-compatible.
- Modify: `yuqi-runtime/src/current-user-batch.mjs` — preserve the validated rich message projection and emit `transcript: null` when a voice message has no transcript.
- Modify: `yuqi-runtime/src/cognition-v3-contract.mjs` — carry the already-authorized payment intent into the canonical draft without allowing expression text to mutate it.
- Modify: `yuqi-runtime/src/interaction-contract.mjs` — keep response risks as turn-local advisories and derive forbidden moves only from active hard constraints/action authority.
- Modify: `yuqi-runtime/src/cognitive-state.mjs` — keep response risks out of durable state while preserving existing explicit-boundary/recovery behavior.
- Modify: `yuqi-runtime/src/image-attachments.mjs` — deterministic `turnId + attachmentChecksum` materialization receipt and path reuse across duplicate calls/restarts.
- Modify: `yuqi-runtime/src/orchestrator.mjs` — connect rich v3 batch input, canonical payment action, deterministic image receipt, and visible group/checksum without changing legacy commit paths.
- Modify: `yuqi-runtime/test/protocol-store.test.mjs` — v3 rich-message validation plus v1/v2 byte-compatibility fixtures.
- Modify: `yuqi-runtime/test/current-user-batch.test.mjs` — closed rich-message projection and unknown voice behavior.
- Modify: `yuqi-runtime/test/cognition-v3-contract.test.mjs` — payment intent authority and expression non-mutation.
- Modify: `yuqi-runtime/test/cognition-v3-adapters.test.mjs` — prove the production v3 adapter consumes the closed rich batch without a second projection or field loss.
- Modify: `yuqi-runtime/test/interaction-contract.test.mjs` — advisory-only response-risk assertions.
- Modify: `yuqi-runtime/test/cognitive-state.test.mjs` — no response-risk persistence and unchanged explicit-boundary recovery.
- Modify: `yuqi-runtime/test/image-attachments.test.mjs` — deterministic receipt/path reuse and one materialization per checksum.
- Modify: `yuqi-runtime/test/orchestrator.test.mjs` — production-path canonical payment, mixed batch, image reuse, and three-bubble authority group.
- Create: `yuqi-runtime/test/direct-reply-v3-features.test.mjs` — focused cross-module contract matrix.
- Modify: `tests/payment-batch-bridge-contract.test.mjs` — staged payment remains separate from social reply and v3 batch evidence is complete.

**Interfaces:**
- Consumes: v3 `currentBatch` with closed message fields; authoritative payment `{ kind, amount, note, messageId, status }`; quote `{ messageId, speakerId, speakerType, text }`; image attachment `{ attachmentId, messageId, kind, mime, bytes, checksum/dataUrl }`.
- Produces: `currentUserInteractionForCognition(batch)` whose rich message fields are lossless for v3 and unchanged for v1/v2; canonical payment action `{ kind, targetKey, targetRevision, payload: { messageId } }`; deterministic materialization receipt `{ turnId, attachmentChecksum, path }`; one `visibleGroupId` and one `commitChecksum` for all bubbles in a direct result.
- Recovery boundary: no Room/schema migration. v3 rich fields are normalized only in v3 envelopes/semantic snapshots; v1/v2 and result-authority-version-0 recovery keep their existing normalized bytes and `canonicalCommitPayloadV1` behavior. A materialization receipt is an idempotent local artifact, not an authority row; restart reuses a matching path and re-materializes only when the verified artifact is absent.
- Closed semantics: voice with no transcript is `transcript: null` and remains unknown; emoji keeps raw type/content and never receives an inferred emotion; quote identity is checked against the referenced original message; payment authority is immutable and independent of visible social text; `responseRisks` are advisory for the current turn only and never enter `forbiddenMoves` or `cognitive-state`; visible bubbles share the same group/checksum.

- [ ] **Step 1: Write the failing tests**

Add the following executable cases before implementation:

```js
test('v3 preserves a mixed ordered batch without losing rich evidence', () => {
  const normalized = validateEnvelope(v3MixedBatchEnvelope());
  assert.deepEqual(normalized.context.currentBatch.messages.map(message => message.messageId), [
    'msg_text', 'msg_image', 'msg_quote', 'msg_voice', 'msg_emoji', 'msg_payment'
  ]);
  assert.equal(normalized.context.currentBatch.messages[3].transcript, null);
  assert.deepEqual(normalized.context.currentBatch.messages[2].quote, {
    messageId: 'msg_original', speakerId: 'user', speakerType: 'user', text: '原话'
  });
  assert.equal(normalized.context.currentBatch.messages[4].type, 'emoji');
  assert.equal(normalized.context.currentBatch.messages[4].emotion, undefined);
  assert.equal(normalized.context.currentBatch.messages[5].payment.messageId, 'msg_payment');
});

test('v1 and v2 normalized snapshots remain byte-compatible', () => {
  assert.deepEqual(validateEnvelope(legacyV1Envelope()), legacyV1Expected());
  assert.deepEqual(validateEnvelope(legacyV2Envelope()), legacyV2Expected());
});

test('canonical payment intent is authoritative and cannot be changed by expression prose', () => {
  const draft = materializeV3Draft({
    cognitionPacket: paymentCognitionPacket(),
    expressionResult: expressionWithText('我先不收，但谢谢你')
  });
  const canonical = normalizeCanonicalBrainDraft(draft);
  assert.equal(canonical.paymentAction, 'received');
  assert.deepEqual(canonical.actionIntent.payment, paymentCognitionPacket().cognitionResult.actionIntent.payment);
  assert.throws(() => normalizeCognitionV3Result(forgedPaymentResult(), paymentValidationContext()), /payment target/);
});

test('response risks remain advisory and never become forbidden moves or durable state', () => {
  const contract = compileInteractionContract({ conversationFrame: { responseRisks: ['may sound transactional'] } });
  assert.deepEqual(contract.forbiddenMoves, []);
  assert.deepEqual(contract.advisories.responseRisks, ['may sound transactional']);
  assert.equal(JSON.stringify(reduceCognitiveStateFrom(contract)).includes('may sound transactional'), false);
});

test('three visible bubbles share one group and commit checksum', async () => {
  const result = await runDirectV3Reply(threeBubbleDraft(['一', '二', '三']));
  assert.equal(result.visibleItems.length, 3);
  assert.equal(new Set(result.visibleItems.map(item => item.groupId)).size, 1);
  assert.equal(new Set(result.visibleItems.map(item => item.commitChecksum)).size, 1);
});

test('image materialization reuses the same receipt after duplicate call and restart', async () => {
  const first = await materializeImageAttachments([imageAttachment()], { turnId: 'turn_image_1' });
  const second = await materializeImageAttachments([imageAttachment()], { turnId: 'turn_image_1' });
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(second.paths[0], first.paths[0]);
});
```

The v3 protocol test must also reject unknown rich-message keys, quote identity mismatches, payment mutation, non-native transcript values, and incomplete/duplicate batch members before storage. The current v1/v2 fixtures must be asserted against hard-coded literal serialized output rather than regenerated, cloned, or normalized by the new implementation. `cognition-v3-adapters.test.mjs` must pass the rich batch through the real production adapter and prove that it neither drops nor reinterprets those fields.

- [ ] **Step 2: Run the focused tests and preserve the real red result**

Run:

```powershell
node --test yuqi-runtime/test/direct-reply-v3-features.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/current-user-batch.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/interaction-contract.test.mjs yuqi-runtime/test/cognitive-state.test.mjs yuqi-runtime/test/image-attachments.test.mjs yuqi-runtime/test/orchestrator.test.mjs tests/payment-batch-bridge-contract.test.mjs
```

Expected red assertions are: rich fields are currently dropped by `normalizedBatchMessage`, canonical payment intent is not projected into `canonicalActionSet`, response risks still appear in `forbiddenMoves`, repeated image calls do not reuse a receipt, and the new three-bubble/payment integration tests are not yet implemented. Do not weaken a fixture or add `only`/`skip` to make this gate green.

- [ ] **Step 3: Implement the smallest v3-only authority changes**

1. Extend `normalizedBatchMessage` and `currentUserInteractionForCognition` with a closed v3 projection for `messageType/type`, nullable voice `transcript`, exact quote identity, raw emoji fields, immutable payment, and safe attachment references. Reject unknown keys and cross-message quote/payment identity conflicts. Keep the v1/v2 branches byte-for-byte unchanged.
2. Map `actionIntent.payment` into `normalizeCanonicalBrainDraft` and `canonicalActionSet` using the persisted payment target/revision. The expression reply is display text only; it cannot infer, replace, or mutate the canonical payment action. Preserve the old v1/v2 `paymentAction` output and settlement behavior.
3. Change `deriveForbiddenMoves` to consume only active hard constraints and deterministic action prohibitions. Expose `responseRisks` under a turn-local advisory object with `persistence: 'none'`; do not write it through `reduceCognitiveState` or any release checkpoint.
4. Compute `attachmentChecksum` from the validated image bytes and use a deterministic path keyed by `{ turnId, attachmentChecksum }`. Before writing, verify the existing receipt/path and checksum; return it unchanged on duplicate or restart. Do not delete a reusable artifact during a retry; cleanup happens once after the terminal pipeline has released its local reference.
5. Keep the existing `canonicalVisibleGroup`/`commitVisibleResult` authority path: all three bubbles use one `visibleGroupId` and one `commitChecksum`; no changes to RA0 recovery, v1/v2 payloads, or unrelated modules.

- [ ] **Step 4: Run the focused tests green and verify compatibility**

Run the Step 2 command again. Expected: PASS with no `only`/`skip`; the mixed v3 batch retains all six evidence kinds, voice remains unknown without a transcript, emoji has no inferred emotion, quote identity is exact, payment authority is stable against social-text changes, image materialization is deterministic/idempotent, risks stay advisory-only, and three bubbles share one authority group/checksum. The same run must also prove the existing v1/v2 fixtures and result-authority-version-0 recovery are unchanged.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/protocol.mjs yuqi-runtime/src/current-user-batch.mjs yuqi-runtime/src/cognition-v3-contract.mjs yuqi-runtime/src/interaction-contract.mjs yuqi-runtime/src/cognitive-state.mjs yuqi-runtime/src/image-attachments.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/current-user-batch.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/interaction-contract.test.mjs yuqi-runtime/test/cognitive-state.test.mjs yuqi-runtime/test/image-attachments.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/direct-reply-v3-features.test.mjs tests/payment-batch-bridge-contract.test.mjs
git commit -m "feat: integrate direct social and structured interactions"
```

### Task 17: Integrate Proactive Chat With Motive and Collision Semantics

**Files:**
- Modify: `yuqi-runtime/src/life-simulation.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-contract.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-adapters.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/turn-dispatcher.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/test/life-simulation.test.mjs`
- Modify: `yuqi-runtime/test/cognition-v3-contract.test.mjs`
- Modify: `yuqi-runtime/test/cognition-v3-adapters.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/store-release-authority-v14.test.mjs`
- Modify: `yuqi-runtime/test/turn-dispatcher.test.mjs`
- Modify: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Modify: `yuqi-runtime/test/bridge-authority-v3.test.mjs`
- Modify: `yuqi-runtime/test/android-fallback-authority.test.mjs`
- Modify: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`
- Create: `yuqi-runtime/test/proactive-chat-v3.test.mjs`
- Modify: `tests/yuqi-cognition-feature-matrix.test.mjs`

**Interfaces:**
- Consumes: the existing phone/cloud `PROACTIVE_CHAT` timer as a consideration signal; persisted `life_episodes`, the current checksum/revision-pinned `cognitive_states` row, immutable agency constraints, Task 9 private-chat lane authority, and the Task 10F canonical terminal transaction.
- Produces: `proactiveMotiveAuthority` in the existing immutable `turns.annotation_snapshot_json`, a closed cognition `motiveEvidenceIds` decision, and exactly one of a visible canonical result, a canonical `skip`, or a canonical cancelled/superseded outcome.
- Does not create another scheduler, does not add a database schema version, and does not let the phone, timer, trigger text, model, delivery policy, or legacy skip budget invent a motive.

**Authority and compatibility contract:**

1. The Android/cloud timer means only “Yuqi may consider speaking now.” It is not motive evidence and never forces output. PC reconstructs candidates from persisted facts before creating the canonical turn.
2. A fresh `PROACTIVE_CHAT` turn stores this exact closed object beside any existing annotations:

   ```js
   {
     version: 'proactive-motive-v1',
     consideredAt,
     candidates: [{
       motiveId,
       sourceType,       // current_life_episode | recent_life_episode | open_thread
       sourceId,
       sourceRevision,   // non-negative safe integer or null
       sourceChecksum,   // lowercase SHA-256
       occurredAt,
       expiresAt,
       summary
     }],
     structuralSilence: null | {
       reasonCode: 'ACTIVE_PRIVATE_CHAT_CONSTRAINT',
       constraintRefs: [{ constraintId, revision }]
     },
     checksum
   }
   ```

   `checksum` is `contentHash()` of the other four fields. `motiveId` is exactly `motive_${contentHash({sourceType,sourceId,sourceRevision,sourceChecksum}).slice(0,24)}`. Candidates are unique by `motiveId`, capped at six, and ordered by `occurredAt DESC, motiveId ASC`, so an unchanged source revision/checksum cannot authorize two visible proactive messages.
3. Eligible life sources are non-cancelled current episodes and non-cancelled episodes that ended no more than six hours before fixed `consideredAt`. Because `life_episodes` has no semantic revision column and `advanceLifeState()` updates bookkeeping `updated_at` even when episode meaning is unchanged, every life candidate fixes `sourceRevision:null`; only the persisted semantic `checksum` changes its source version. An `updated_at`-only change therefore keeps the same motive ID, while a real adjustment that changes the episode checksum creates a new one. Eligible open threads come only from the current `cognitive_states` checksum/revision, have non-empty `threadId`, `summary`, `sourceTurnId`, and a `lastTouchedAt` no more than seven days old. The production schema-v2 state stores these records under `state.fastState.openThreads`; legacy schema-v1 compatibility may read `state.openThreads`. `state.fastState.openThreadIds` by itself is not evidence and a test fixture must not fabricate a top-level schema-v1 shape while claiming to exercise schema v2. For a canonical v3 state patch, each normalized `statePatch.openThreads` string is persisted in the same visible-result transaction as the deterministic record `{threadId:value,summary:value,sourceTurnId:authoritativeTurnId,lastTouchedAt:effectiveAt}` and `openThreadIds` is its ordered ID projection. The current-state scoped/reopen invariant recomputes that projection from the committed manifest and authoritative turn; missing, extra, reordered, foreign-source, changed-summary, or changed-time records fail closed. A later canonical wire-v2 state update remains byte-compatible when no Task-17 field exists, but if it follows a v3 state it must remove the Task-17 `fastState.openThreads` field while applying its historical `openThreadIds` update so stale rich evidence cannot survive under a v2 current turn. The motive builder accepts schema-v2 rich threads only when the current state's `lastTurnId` resolves to the canonical wire-v3 commit that deterministically materialized them. This uses the existing `state_json` column and does not add a schema migration. A mood string, vague attention text, timer label, model inference, future episode, cancelled episode, expired thread, or missing checksum is never a candidate. Task 19 owns role-plan commitments; Task 17 emits no `due_commitment` candidate until an exact persisted commitment authority exists.
4. A candidate already cited by a committed `PROACTIVE_CHAT` result is consumed for that exact source version and is filtered from later fresh turns. Task 17 adds `pc-visible-commit-v3`, whose only delta from v2 is the required closed `proactiveMotiveEvidenceIds`, and uses it only for canonical wire-v3 `PROACTIVE_CHAT`; that immutable manifest field—not visible prose—is the consumption fact source. Skips store `[]`. Failed/cancelled turns, shadow drafts, and uncommitted work consume nothing. Exact replay/restart reads the already-pinned annotation snapshot and committed manifest instead of rebuilding either. Retries inherit the parent snapshot through the existing canonical retry authority. Every other PC result remains `pc-visible-commit-v1/v2` byte-compatible.
5. Structural silence recognizes only active hard constraints whose channel is `private_chat` or `all`, whose kind is `action` or `consent`, and whose exact machine rule is `deny_proactive_chat` or `deny_all_contact`. It never parses free-form refusal, mood, distance, or a prior one-off skip into a permanent ban.
6. `motiveEvidenceIds` is an optional property in the shared v3 schema so other kinds remain byte-compatible. The v3 contract makes it mandatory for `PROACTIVE_CHAT`: `send` requires one to three unique IDs, all in the pinned candidate set; `skip` requires `[]` and requires `payment`, `moment`, `rolePlan`, `lifeAdjustment`, and `relationshipReview` all to be `null`. With zero candidates or structural silence, the orchestrator commits a structural skip before calling `ReleaseExecutor`. With candidates, cognition may still choose an intentional skip, but a skip can never smuggle a relationship-stage or other action into an `action_only` result.
7. No-motive and structural-silence skips bypass `getProactiveChatDeliveryPolicy()` and its legacy skip budget. They use the normal Task 10F terminal commit with `items:[]`, `actions:[]`, no evidence-memory job, no message projection, no placeholder, and no notification payload. A model-produced intentional skip uses the same transaction.
8. Task 17 changes canonical v3 `PROACTIVE_CHAT` and its collision with canonical v3 `DIRECT_REPLY` only. RA0, wire v1/v2, role-plan kinds, moment kinds, cloud stale-trigger handling, and their serialized outputs remain exact compatibility paths.

- [ ] **Step 1: Write red tests for the immutable motive authority**

```js
test('the timer permits consideration but zero persisted motives never calls a model', async () => {
  const result = await runCanonicalProactive({ episodes: [], cognitiveState: null });
  assert.equal(result.terminalDisposition, 'skip');
  assert.equal(result.reasonCode, 'NO_LIVED_MOTIVE');
  assert.equal(result.releaseExecutions, 0);
  assert.deepEqual(result.replyParts, []);
  assert.deepEqual(result.actions, []);
});

test('a visible proactive result cites only the pinned persisted source version', async () => {
  const source = completedLifeEpisode('life-7');
  const motiveId = motiveIdForSource(source);
  const result = await runCanonicalProactive({
    episodes: [source],
    cognition: sendWithMotiveIds([motiveId])
  });
  assert.equal(result.terminalDisposition, 'visible');
  assert.deepEqual(result.cognition.motiveEvidenceIds, [motiveId]);
  assert.deepEqual(result.commitManifest.proactiveMotiveEvidenceIds, [motiveId]);
  assert.equal(result.pinnedAuthority.checksum, result.reopenedAuthority.checksum);
});

test('forged stale and already-consumed motives cannot authorize a send', async () => {
  await assert.rejects(
    runCanonicalProactive({ cognition: sendWithMotiveIds(['motive_forged']) }),
    /proactive motive authority conflict/
  );
  const first = await commitOneProactiveFor('life-7');
  const second = await runCanonicalProactive({ episodes: [first.source] });
  assert.equal(second.reasonCode, 'NO_LIVED_MOTIVE');
  assert.equal(second.releaseExecutions, 0);
});
```

`life-simulation.test.mjs` must freeze source normalization and ordering: current and recent episodes are accepted; future/cancelled/older-than-six-hours episodes are rejected; a real schema-v2 state with a complete `fastState.openThreads` record is accepted; schema-v2 `openThreadIds` alone, a fabricated top-level `state.openThreads`, thread-local checksum/revision overrides, missing IDs/checksums, over-age threads, and vague mood/attention alone are rejected. Add a real canonical state-commit/reopen test proving the deterministic rich projection is written without a migration and survives restart. `cognition-v3-contract.test.mjs` must reject missing, duplicate, unknown, more-than-three, non-string, and skip-with-nonempty `motiveEvidenceIds`, while existing non-proactive v3 fixtures remain valid. `cognition-v3-adapters.test.mjs` must prove that the real adapter receives the exact pinned candidates from `turn.annotationSnapshot.proactiveMotiveAuthority` and does not add or prefer caller-supplied timer, free-text, or motive-candidate data. `cognitive-pipeline-v3.test.mjs` must exercise the real `runV3ReleaseDraft()`/`runCognitionV3Turn()` path: a send citing a pinned ID passes, a forged ID fails, and a retry uses its inherited parent annotation snapshot rather than mutable current sources.

- [ ] **Step 2: Run the motive/contract tests and preserve the red result**

Run:

```powershell
node --test yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/proactive-chat-v3.test.mjs
```

Expected red assertions: no closed motive builder exists, `motiveEvidenceIds` is outside the v3 schema, the timer still reaches the release executor with zero motives, and source consumption is not persisted through the canonical turn input checksum. Do not create a fake life event or relax an existing fixture to make the tests green.

- [ ] **Step 3: Implement and pin the motive snapshot before model execution**

Add a pure builder in `life-simulation.mjs` with this public shape:

```js
export function buildProactiveMotiveAuthority({
  consideredAt,
  lifeContext,
  cognitiveState,
  consumedMotiveIds = [],
  hardConstraints = []
}) {
  const considered = requireSafeTimestamp(consideredAt, 'proactive consideredAt');
  const structuralSilence = proactiveStructuralSilence(hardConstraints);
  const candidates = stableMotiveCandidates([
    ...lifeEpisodeMotiveCandidates(lifeContext, considered),
    ...openThreadMotiveCandidates(cognitiveState, considered)
  ], consumedMotiveIds);
  const semantic = {
    version: 'proactive-motive-v1',
    consideredAt: considered,
    candidates,
    structuralSilence
  };
  return Object.freeze({ ...semantic, checksum: contentHash(semantic) });
}
```

`YuqiOrchestrator.createCanonicalTurnForEnvelope()` must use fixed `canonicalInteractionAt(envelope, clock)` as `consideredAt`, read the source rows and consumed IDs, build the snapshot, and pass:

```js
annotationSnapshot: {
  ...(existingAnnotations || {}),
  proactiveMotiveAuthority
}
```

Only the orchestrator constructs this reserved key. `createCanonicalVisibleTurnInternal()` must validate the snapshot checksum, source IDs/checksums/revisions, expiration at `consideredAt`, deterministic sort/limit, structural constraint identity, and consumed-set status inside its existing immediate transaction before inserting a fresh proactive turn. Exact-turn replay and retry use the already persisted snapshot and existing immutable-annotation checksum checks. Add a scoped store reader for committed proactive motive IDs; it may read canonical `PROACTIVE_CHAT` roots/receipts and their annotation snapshot, but must ignore cancelled, failed, shadow-only, or uncommitted turns and must not introduce a schema migration.

`lifeEpisodeMotiveCandidates`, `openThreadMotiveCandidates`, `stableMotiveCandidates`, and `proactiveStructuralSilence` are private helpers in the same file and implement the exact eligibility, closed shapes, deterministic ID, sort, limit, consumption, and machine-rule constraints above; they reject rather than coerce invalid native types. `requireSafeTimestamp` accepts only a native non-negative safe integer. `openThreadMotiveCandidates` accepts the rich list from `state.fastState.openThreads` for schema v2 or `state.openThreads` for legacy schema v1, but every candidate's `sourceRevision` and `sourceChecksum` come exclusively from the enclosing current `cognitive_states` row; a thread-local `revision` or `checksum` is never trusted. A schema-v2 row containing only `openThreadIds` produces no open-thread candidate until a real committed state patch materializes the rich projection.

Extend `COGNITION_SCHEMA_V3.interactionDecision` with optional `motiveEvidenceIds`. In `normalizeCognitionV3Result()`, require and validate it only when `envelope.kind === 'PROACTIVE_CHAT'`. Pass the pinned candidates through `buildCognitionV3Envelope()`/the existing `proactiveChatFeatureContext`; do not rebuild candidates inside the cognitive pipeline. The adapter must read the store-owned `input.turn.annotationSnapshot.proactiveMotiveAuthority` reserved key as its authority source; caller-supplied `motiveCandidates`, timer text, trigger text, and free-form context cannot override it. After building the cognition envelope, `v3ValidationContext()` must derive the exact `proactiveMotiveIds` set from `cognitionEnvelope.featureContext.motiveCandidates` and pass that set to `normalizeCognitionV3Result()`. A component-only test that injects validation context manually does not satisfy this production-linkage requirement.

Add `canonicalCommitPayloadV3()` and select it only when the authoritative turn is canonical wire-v3 `PROACTIVE_CHAT`. Its only semantic delta from v2 is `proactiveMotiveEvidenceIds`; it must not duplicate `proactiveMotiveAuthorityChecksum` or another annotation field into the manifest. `runCanonicalReleaseTurn()` supplies the normalized cognition IDs for `send` and `[]` for either kind of skip. After `readCommitAuthority()` and before any write, `commitVisibleResult()` reads the store-owned pinned annotation snapshot, verifies its checksum, derives the candidate-ID set, and validates the manifest IDs against that set; caller-supplied IDs or checksums are never an authority source. The receipt records `commit_payload_version:'pc-visible-commit-v3'`. The v13/v14 scoped and reopen validators accept v3 only for that turn kind, require the field, and reject missing, duplicate, unknown, non-string, extra manifest keys, or an annotation/manifest mismatch. Non-proactive and historical manifests remain byte-compatible on v1/v2.

In `runCanonicalReleaseTurn()`, before image materialization or `releaseExecutor.executeTurn()`:

```js
if (turn.rolloutKey === 'PROACTIVE_CHAT'
    && (authority.structuralSilence || authority.candidates.length === 0)) {
  return commitCanonicalProactiveSkip({
    turn,
    reasonCode: authority.structuralSilence
      ? 'STRUCTURAL_SILENCE'
      : 'NO_LIVED_MOTIVE'
  });
}
```

`commitCanonicalProactiveSkip()` must call the same `commitVisibleResult()` path used by other canonical results with empty visible/action sets, the pinned comparison descriptor, and a generation fingerprint whose proactive context revision is `contentHash({agencySnapshotChecksum,proactiveMotiveAuthorityChecksum})`. Visible proactive sends use that same context revision. `commitVisibleResult()` must recompute this exact proactive context revision while every other kind keeps its existing agency-only fingerprint formula. `canonicalActionSet()` must return `[]` for an already validated proactive skip, and the commit layer must independently reject any non-empty action set when a v3 proactive cognition/manifest says skip. The skip helper must not call the legacy delivery-policy budget and must not create evidence-memory work.

- [ ] **Step 4: Write red atomic collision and recovery tests**

```js
test('a direct user batch atomically supersedes an uncommitted proactive turn', async () => {
  const proactive = await beginSlowCanonicalProactive();
  const direct = await submitCanonicalDirectBatch([{ messageId: 'u9', content: '在吗' }]);
  releaseSlowProactive();
  const late = await proactive.finished;

  assert.equal(late.status, 'superseded');
  assert.equal(store.getTurn(proactive.turnId).state, 'failed');
  assert.equal(store.getTurnAuthorityLineage(proactive.lineageKey).state, 'cancelled');
  assert.equal(store.visibleGroupsFor(proactive.turnId).length, 0);
  assert.equal(store.deliveriesFor(proactive.turnId).length, 0);
  assert.equal(store.qualityFindingsFor(proactive.turnId).length, 0);
  assert.equal(direct.terminalDisposition, 'visible');
});

test('a proactive trigger arriving behind a direct turn fails retryably with zero writes', async () => {
  const direct = await beginSlowCanonicalDirect();
  await assert.rejects(
    submitCanonicalProactiveTrigger(),
    /INTERACTION_LANE_BUSY/
  );
  assert.equal(store.getInteractionLane('yuqi', 'private_chat').generatingTurnId, direct.turnId);
  assert.equal(store.getTurn('turn_proactive_waiting'), null);
  assert.equal(cloud.acks.length, 0);
  assert.equal(store.diagnosticsFor('turn_proactive_waiting').length, 0);
});

test('restart does not revive a superseded proactive result', async () => {
  const ids = await createDirectProactiveCollision();
  await reopenStore();
  const recovered = await dispatcher.recover(ids.proactiveTurnId);
  assert.equal(recovered.status, 'superseded');
  assert.equal(modelCallsAfterRestart, 0);
});
```

Also add a race in which the direct transaction wins while proactive generation is in flight, a race in which proactive commits first and direct follows normally, exact proactive replay with one receipt/group, same-source second trigger filtering, a source whose checksum changes and therefore creates a new motive ID, a canary proactive cancellation, and a provider that rejects only after the proactive lineage was cancelled. The cancellation must create no `quality_findings`; the row-level admission helper must call `settleCanaryFailureInternal()` inside the same outer immediate transaction with reason `CANARY_SOURCE_SUPERSEDED`, so the reserved slot cannot leak and rollback restores both cancellation and rollout counters together. This conservative rollout failure is not a model-quality finding.

- [ ] **Step 5: Implement canonical private-chat admission in the creation transaction**

Do not call the existing public `admitInteractionTurnInternal()` from inside `createCanonicalVisibleTurnInternal()` because that would nest an independent transaction after the caller has already pinned the lane. Extract a row-level helper used by both paths:

```js
admitCanonicalPrivateChatRowsInternal({
  incomingTurnId,
  expectedLaneRevision,
  now
})
```

Before rollout/canary reservation or any turn write, a fresh incoming canonical v3 `PROACTIVE_CHAT` must inspect the pinned lane revision. If a different uncommitted `DIRECT_REPLY` or `PROACTIVE_CHAT` owns it, throw a stable `InteractionLaneBusyError` with code `INTERACTION_LANE_BUSY` and zero Task-17 turn, lineage, lane, rollout, delivery, or diagnostic writes. `TurnDispatcher` treats that as retryable scheduling contention, not model/pipeline failure. `CloudRelayPump` must catch only this exact error before its generic failure-diagnostic path: write no diagnostic or duplicate marker, create no turn/delivery/rollout state, send no relay ACK, and leave the relay input retryable; the existing validated stale-trigger gate may later retire it. A separately authenticated and fully validated Task-13B recovery snapshot remains independent transport reconciliation: because ingress intentionally validates and reconciles it before turn admission, its message/annotation imports and `sync_cursors` advance may commit exactly once even when the proactive turn is busy. Those idempotent recovery writes are not proactive admission side effects and must not be rolled back, duplicated, or counted as an accepted proactive turn. Do not reorder acceptance ahead of reconciliation or build a new cross-module transaction merely to undo valid recovery facts.

For an admitted fresh turn, the row-level helper handles only these canonical v3 pairs on `private_chat`:

- incoming `DIRECT_REPLY`, current uncommitted `PROACTIVE_CHAT`: call `cancelCanonicalTurnRowsInternal()` with `superseded_by_user_batch`, then claim the lane for direct in the same immediate transaction;
- same turn replay: keep the existing owner and immutable replay path;
- already committed current work: rely on the committed lane state and normal next-sequence admission; do not cancel a committed group.

All other kinds continue through their existing Task 9/Task 19 paths. Do not invent a SQL turn state named `superseded_by_user_batch`; the persisted turn remains `state:'failed'`, the lineage becomes `state:'cancelled'`, and `error_json.code` carries the reason. `createCanonicalTurnForEnvelope()`, `runCanonicalReleaseTurn()`, `TurnDispatcher.accept/recover`, and their callers must recognize this terminal outcome and return `{status:'superseded', visible:false}` without invoking the model, recording a quality failure, requeueing, or producing a delivery.

Before release execution and again immediately before drafting actions/quality/commit, `runCanonicalReleaseTurn()` must re-read the turn and lineage. If the direct transaction cancelled it while the model was running, return the same terminal superseded outcome. If `releaseExecutor.executeTurn()` rejects, the catch path must first perform that same exact turn/lineage check; a persisted `state:'failed'`, lineage `state:'cancelled'`, and `error_json.code:'superseded_by_user_batch'` returns superseded without calling `recordActivePipelineFailure`, requeue, or quality evaluation. Unknown provider, SQLite, and authority errors continue through the existing failure path; do not classify arbitrary failures as supersession.

- [ ] **Step 6: Run the complete Task 17 focused gate**

Run:

```powershell
node --test yuqi-runtime/test/proactive-chat-v3.test.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/android-fallback-authority.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs
```

Expected: PASS with no `only`/`skip`. The gate must prove zero-motive and structural-silence execution call no model; a visible send cites pinned evidence; a two-candidate send consumes only the cited manifest ID while the uncited candidate remains eligible, and a skip consumes none; consumed/expired/forged evidence cannot send; an `updated_at`-only life bookkeeping change keeps the same motive ID while a changed persisted semantic checksum yields a new deterministic source version; schema-v2 rich open-thread state is production-reachable and tamper-closed; canonical skip has zero items/actions/messages/delivery text/memory jobs; direct/proactive races have one lane owner and at most one visible group; lane-busy cloud input creates no turn/lineage/lane/rollout/delivery/diagnostic and sends no relay ACK, while an attached valid recovery snapshot may advance only its independent idempotent sync/message/annotation state exactly once; provider rejection after supersession creates no pipeline or quality failure; close/reopen preserves cancelled and committed authority; and RA0, wire v1/v2, role-plan, moment, and cloud stale-trigger fixtures are unchanged.

- [ ] **Step 7: Run the project regression gate**

Run:

```powershell
npm.cmd test
```

Expected: PASS with zero failures and zero skipped tests. Run `git diff --check` and search the modified tests for `.only` and `.skip`. Do not start the PC service, cloud timers, or Android runtime during this task.

- [ ] **Step 8: Commit**

```powershell
git add yuqi-runtime/src/life-simulation.mjs yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/cognition-v3-contract.mjs yuqi-runtime/src/cognition-v3-adapters.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/turn-dispatcher.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/bridge-authority-v3.test.mjs yuqi-runtime/test/android-fallback-authority.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs yuqi-runtime/test/proactive-chat-v3.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs
git commit -m "feat: ground proactive chat in lived motives"
```

### Task 18: Integrate Public Moments and Moment Threads

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/interaction-lanes.mjs`
- Modify: `yuqi-runtime/src/life-simulation.mjs`
- Modify: `yuqi-runtime/src/cognition-context.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-adapters.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-contract.mjs`
- Modify: `yuqi-runtime/src/cognitive-pipeline.mjs`
- Modify: `yuqi-runtime/src/role-schemas.mjs`
- Modify: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/social-experience.mjs`
- Modify: `tavern-app/index.html`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/test/interaction-lanes.test.mjs`
- Modify: `yuqi-runtime/test/life-simulation.test.mjs`
- Modify: `yuqi-runtime/test/cognition-context.test.mjs`
- Modify: `yuqi-runtime/test/cognition-v3-adapters.test.mjs`
- Modify: `yuqi-runtime/test/cognition-v3-contract.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-pipeline-v3.test.mjs`
- Modify: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/store-release-authority-v14.test.mjs`
- Create: `yuqi-runtime/test/moments-v3.test.mjs`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Modify: `tests/yuqi-cognition-feature-matrix.test.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: explicit public-safe projections already persisted inside completed `life_episodes`; exact authenticated public moment/comment snapshots normalized from the Web/Android trigger; immutable agency privacy constraints; canonical lane/result authority.
- Produces: a store-owned `publicMomentAuthority` or `momentTargetAuthority` annotation, a closed cognition decision, and exactly one canonical public post, public-thread action-only result, skip, or fail-closed authority conflict.
- Does not add a moment table or schema version, does not send private chat/history/payment/relationship/private-plan data to a public model call, does not let caller-provided `lifeEvents` invent public evidence, and does not virtualize an unknown v3 target.

**Authority, privacy, and compatibility contract:**

1. `PROACTIVE_MOMENT` may use only a non-cancelled `life_episodes` row whose persisted status is `completed` and whose `payload_json.publicMomentCandidate` is the exact closed object `{version:'public-moment-candidate-v1',visibility:'public',summary}`. `summary` is pre-sanitized public wording, native string, trimmed, 1–280 characters. Episode title, arbitrary payload fields, private memory, chat text, payment state, relationship state, and model-generated facts are not fallback sources. Task 18 reserves this key and makes every existing general writer (`putLifePlanInternal`, chat life adjustment, import/restore, external caller data) reject it before any write; a Task-18 test may seed a pre-existing valid completed row through raw fixture SQL only to exercise the reader, but Task 18 exposes no production writer. Task 19 is the sole production author: after its authoritative life result has passed the closed life-result validator, `commitLifePlanningResultInternal()` may persist the marker in the same transaction as the completed life episode. Historical episodes without it remain valid but produce no public candidate.
2. A fresh canonical wire-v3 `PROACTIVE_MOMENT` stores the closed `publicMomentAuthority` reserved annotation beside existing annotations:

   ```js
   {
     version: 'public-moment-authority-v1',
     consideredAt,
     candidates: [{
       evidenceId,       // public_event_${sha256(...).slice(0,24)}
       sourceEpisodeId,
       sourceChecksum,
       occurredAt,       // completed episode endAt
       expiresAt,        // endAt + 12 hours
       summary
     }],
     structuralSilence: null | {
       reasonCode: 'ACTIVE_PUBLIC_MOMENT_CONSTRAINT',
       constraintRefs: [{ constraintId, revision }]
     },
     checksum
   }
   ```

   `checksum` hashes the other fields. Candidates are unique, capped at three, and ordered by `occurredAt DESC, evidenceId ASC`. Only hard `action|consent` constraints scoped to `public_moment|all` with machine rule `deny_public_moment|deny_all_public_actions` create structural silence. Fresh creation rebuilds this object from SQLite inside the existing immediate transaction. Replay/retry/reopen validates the pinned closed object and never rebuilds it from later mutable life state. A committed live `pc-visible-commit-v4` manifest consumes only its cited IDs. Redacted groups expose no semantic IDs and are excluded rather than parsed or retained.
3. The public cognition path is a data-flow isolation boundary, not a prose filter. For `PROACTIVE_MOMENT`, `MOMENT_INTERACTION`, and `MOMENT_REPLY`, `buildCognitionV3Input()`/`buildCognitionEnvelopeV3()` must emit empty private history, verified private facts, payment, relationship base/phase, private stances/preferences, private open threads, life payload, and ordinary memory retrieval. It may emit only the store-owned public authority, the exact public target/thread, fixed public audience rules, public-safe author settings, and public-safe social lessons. `fixedPublicBoundary()` ignores caller input and returns exactly `{version:'public-boundary-v1',visibility:'public',recipientId:'public_moments',allowPrivateChatContext:false,allowPaymentContext:false,allowRelationshipContext:false,allowPrivateMemoryContext:false}` with native booleans and no extra keys. Tests inject unique private canary secrets into every excluded source and inspect the exact model request; a regex assertion over final prose is not accepted as privacy proof. Because no program can prove every possible hallucinated sentence is semantically harmless, the implementation must not claim such a guarantee; it guarantees that persisted private facts are absent from the public model input and that structured private actions cannot commit.
4. New Web/Android v3 moment triggers use the canonical closed input projection:

   ```js
   {
     targetMoment: {
       momentId, authorType, authorId, text, createdAt,
       likes: [authorId],
       comments: [{
         commentId, authorType, authorId, text, createdAt,
         replyToCommentId
       }]
     },
     targetComment: null | { commentId, authorType, authorId, text, createdAt, replyToCommentId }
   }
   ```

   All keys and native types are closed; strings are bounded, likes are unique/sorted, comment IDs are unique, and comment order is preserved. `MOMENT_REPLY` requires a `targetComment` that appears byte-for-byte in `targetMoment.comments` and is authored by the player. `MOMENT_INTERACTION` requires `targetComment:null`. `validateEnvelope()` normalizes this before any store/reconcile work. A wire-v3 moment-family input accepts only `targetMoment`/`targetComment`: it rejects generic `snapshot`, legacy `moment/playerComment/replyToCommentId`, and any attempt to derive or merge a missing canonical target from those fields. `BridgeInput` keeps the existing wire-v2 legacy shape unchanged on the separate compatibility path.
5. Fresh canonical creation derives and stores `{version:'moment-target-authority-v1',targetMoment,targetComment,checksum}` from the normalized v3 envelope. Caller side fields cannot override it. The lane is `moment_interaction:<targetMoment.momentId>`. The generation fingerprint includes `contentHash({agencySnapshotChecksum,momentTargetAuthorityChecksum})`. Action targets and revisions come only from the persisted target snapshot. Wrong moment/comment identity, comment not in the moment, changed snapshot, duplicate comment, foreign target, or replay with different target is rejected before writes; exact replay/retry/restart uses the pinned snapshot. Different moments may proceed independently; the same moment serializes.
6. Canonical commit uses `pc-visible-commit-v4` only for wire-v3 `PROACTIVE_MOMENT`, `MOMENT_INTERACTION`, and `MOMENT_REPLY`. Its base keys are exactly the v2 set `payloadVersion,authorityOrigin,authorityLineageKey,laneKey,input,agency,releases,generationFingerprint,visibleItems,actions,statePatch,memoryJobs,comparison`, with `input.clearEpoch` retained. `PROACTIVE_MOMENT` adds exactly `publicMomentEvidenceIds`; visible post requires one to three pinned IDs and skip requires `[]`. `MOMENT_INTERACTION`/`MOMENT_REPLY` instead add exactly `momentTargetAuthorityChecksum`; neither v4 shape accepts the other kind's extra field or any unknown key. `commitChecksum` is `contentHash()` of that exact canonical v4 object. A live group recomputes the corresponding annotation checksum, cited-ID consumption, item/action projection, fingerprint, manifest checksum, and receipt. Redaction atomically clears `semantic_json` and annotation semantics while retaining the existing identity/cardinality/checksum tombstones; scoped/reopen validation must not parse or reconstruct public evidence IDs or target prose from a redacted group, and consumption readers skip it. `PROACTIVE_MOMENT` send is one or more public-moment items addressed to `public_moments` and has no payment/relationship/private-plan action. Like/comment/reply are `action_only`, contain zero visible/private-chat items and at least one exact moment action. Skip has zero items/actions/messages/jobs. Unknown action kinds, payment, relationship transition, private role-plan operation, mixed public/private recipient, or public text on an action-only thread fail closed before commit and quarantine through the existing canonical authority path.
7. `ROLE_PLAN_MOMENT_PRIVATE` remains a public moment lane/recipient. Here `PRIVATE` means the schedule was created from a private-decision source; it does not mean a private audience. Task 18 must freeze this existing meaning with tests and must not reroute it into chat. Its public boundary and validated role-plan occurrence remain Task 19 authority; Task 18 only prevents it from receiving private cognition context or bypassing the public commit allowlist.
8. RA0 and wire v1/v2 keep their current serialized input, virtual-moment fallback, lane, payload, and UI behavior. For result-authority v1/wire-v3, an absent or changed target never calls `materializeVirtualMoment()` and never records UI-applied success. `sourceTurnId`/canonical action proof prevents duplicate posts/comments across page reload. Web landing of `skip` creates nothing; action-only applies only the action; visible creates only the public post. Cloud/LAN input acknowledgement remains tied to durable canonical acceptance, while UI application/receipt remains tied to actual target application.

- [ ] **Step 1: Write red public-privacy and target-integrity tests**

```js
test('proactive moment needs a completed store-owned public-safe life projection', async () => {
  const planned = await runRealCanonicalMoment({
    episode: lifeEpisode({ status: 'planned', publicCandidate: true })
  });
  assert.equal(planned.terminalDisposition, 'skip');
  assert.equal(planned.releaseExecutions, 0);

  const completed = await runRealCanonicalMoment({
    episode: lifeEpisode({ status: 'completed', publicCandidate: true }),
    cognition: postWithPublicEvidence()
  });
  assert.equal(completed.terminalDisposition, 'visible');
  assert.deepEqual(completed.manifest.publicMomentEvidenceIds,
    [completed.authority.candidates[0].evidenceId]);
});

test('public cognition request contains none of the persisted private canaries', async () => {
  const capture = await captureRealPublicModelRequest(privateCanaryStore());
  assert.deepEqual(capture.relevantHistory, []);
  assert.deepEqual(capture.verifiedFacts, []);
  assert.equal(capture.relationshipBasePhase.base, null);
  assert.equal(JSON.stringify(capture).includes('PRIVATE_CANARY_7f2c'), false);
});

test('moment reply is pinned to the exact persisted trigger snapshot across restart', async () => {
  const created = await createRealMomentReply(exactCanonicalThread());
  await reopenStore();
  assert.equal((await commitReply(created)).terminalDisposition, 'action_only');
  await assert.rejects(() => replayWithChangedComment(created), /authority conflict/);
});
```

The red matrix must also cover completed episodes with missing/private/malformed candidate markers; all ordinary life writers rejecting the reserved marker with zero writes; a raw-SQL pre-existing valid marker surviving close/reopen; expired and already-consumed evidence; two candidates with only the cited ID consumed; structural silence; caller `lifeEvents` override attempts; non-canonical Web legacy fields or a generic snapshot on v3; changed/extra/foreign moment/comment fields; comment-not-in-thread; duplicate IDs; invalid native types; same-moment serialization and different-moment independence; public send with payment/relationship/private-plan action; interaction with private-chat text; skip with any item/action; v3 unknown target UI application; exact reload/replay; and RA0/wire-v2 byte-compatible snapshots. Use real `YuqiStore` create/commit/close/reopen fixtures and a real `runV3ReleaseDraft()` adapter path, not a `runKind()` helper that manually supplies validation context.

- [ ] **Step 2: Run moment tests red**

Run:

```powershell
node --test yuqi-runtime/test/moments-v3.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/cognition-context.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs tests/yuqi-ui-contract.test.mjs
```

Expected red: caller events still reach cognition, private history/facts remain in the public request, old Web fields do not form the canonical target, v3 unknown targets virtualize, no v4 manifest/annotation validator exists, and moment actions may create chat items.

- [ ] **Step 3: Implement public-safe feature context and exact action targets**

```js
function proactiveMomentFeatureContext(input) {
  const authority = input.turn.annotationSnapshot.publicMomentAuthority;
  return {
    committedLifeEvents: structuredClone(authority.candidates),
    publicPrivacy: fixedPublicBoundary(authority)
  };
}

function momentInteractionFeatureContext(input) {
  const authority = input.turn.annotationSnapshot.momentTargetAuthority;
  return {
    targetMoment: structuredClone(authority.targetMoment),
    targetComment: structuredClone(authority.targetComment),
    thread: structuredClone(authority.targetMoment.comments)
  };
}
```

Add pure `buildPublicMomentAuthority()` and `buildMomentTargetAuthority()` helpers with the exact contracts above. The orchestrator builds the reserved key before creation; store independently rebuilds the fresh public-source authority or derives the target authority from the normalized envelope inside the immediate transaction. Reserve `publicMomentCandidate` at every existing generic life write boundary and reject caller/import/chat-adjustment attempts before mutation; do not add a trusted production author in Task 18. Adapters and validation read only the persisted turn annotation. `normalizeCognitionV3Result()` receives the exact public evidence/target set from the final built cognition envelope; manually injected caller context is not accepted.

`buildCognitionContext()` must branch on the three public moment kinds before listing messages or building an evidence pack. The public branch must not perform those private reads at all, rather than read then delete. Add spies proving zero `listMessages`, evidence retrieval, payment, relationship, private stance/preference, and private life payload access. It may load only the public authority/thread already pinned to the turn.

Extend canonical commit and the v13/v14 group-scoped/reopen validator with the kind-specific `pc-visible-commit-v4` key sets, evidence consumption, annotation checksum, context fingerprint, item/action/recipient shape, and redacted-group behavior. Every consumption reader first runs one group-scoped authority validation and performs zero full-database invariant scans. No migration is added.

Update `queueYuqiMomentTurn()` to emit the canonical target keys and bounded snapshots. Update the Android mapper and its JVM tests so a v3 checkpoint preserves that canonical projection while the v2 legacy shape remains unchanged. In Web application, forbid virtual target creation for an RA1/wire-v3 action; exact missing target returns false and leaves UI cursor/receipt unapplied. Keep virtual fallback only for legacy results.

Every moment-family `action:'skip'` uses the same canonical zero-item/zero-action
terminal path as proactive chat. A like/comment/reply with no chat bubble is
`action_only` and must contain at least one validated action row; a public post
is `visible` and must contain a public-moment item. Neither case may fabricate a
private-chat bubble merely to satisfy an old “at least one item” invariant.

- [ ] **Step 4: Run the complete Task 18 focused gate**

Run the Step 2 command.

Then run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*BridgeInputTest" --no-daemon --no-problems-report
cd ..
```

Expected: all tests pass with no `.only`/`.skip`. The gate must prove real public-source reachability, zero-candidate pre-model skip, private-input read isolation, exact v4 manifests and fingerprints, target identity/restart closure, no private structured action, no private-chat bubble, v3 unknown-target fail-closed UI behavior, and unchanged RA0/wire-v1/v2 plus both role-plan moment variants. `ROLE_PLAN_MOMENT_PRIVATE` must remain a public moment because its suffix describes the plan source, not the audience.

- [ ] **Step 5: Run the project regression gate**

Run `npm.cmd test`, `git diff --check`, and scan every modified test for `.only`/`.skip`. Do not start the PC service, cloud timers, or Android runtime. An attached device is not required for this Task 18 JVM/Web/PC gate; the full connected-device release gate remains later.

- [ ] **Step 6: Commit**

```powershell
git add yuqi-runtime/src/protocol.mjs yuqi-runtime/src/interaction-lanes.mjs yuqi-runtime/src/life-simulation.mjs yuqi-runtime/src/cognition-context.mjs yuqi-runtime/src/cognition-v3-adapters.mjs yuqi-runtime/src/cognition-v3-contract.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/src/role-schemas.mjs yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/social-experience.mjs tavern-app/index.html android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/interaction-lanes.test.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/cognition-context.test.mjs yuqi-runtime/test/cognition-v3-adapters.test.mjs yuqi-runtime/test/cognition-v3-contract.test.mjs yuqi-runtime/test/cognitive-pipeline-v3.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/moments-v3.test.mjs android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java tests/yuqi-cognition-feature-matrix.test.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: integrate public-safe moment cognition"
```

### Task 19: Integrate Role Plans, Life Planning, and Formal Relationship Stages

**Files:**
- Modify: `yuqi-runtime/src/relationship-stage.mjs`
- Modify: `yuqi-runtime/src/life-planning-dispatcher.mjs`
- Modify: `yuqi-runtime/src/life-simulation.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-adapters.mjs`
- Modify: `yuqi-runtime/test/relationship-stage.test.mjs`
- Modify: `yuqi-runtime/test/life-planning-attempt.test.mjs`
- Modify: `yuqi-runtime/test/life-simulation.test.mjs`
- Modify: `yuqi-runtime/test/store-release-authority-v14.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Create: `yuqi-runtime/test/role-plan-life-stage-v3.test.mjs`
- Modify: `tests/role-plan-domain.test.mjs`
- Modify: `tests/role-plan-repository.test.mjs`

**Interfaces:**
- Consumes: exact role-plan occurrence/schedule, life basis checksum, base/phase graph and evidence.
- Produces: v3 role-plan operations, two-phase life attempts, the sole validated writer for a closed public-moment candidate, and formal-only stage review.

- [ ] **Step 1: Write red plan/life/stage consistency tests**

```js
test('visible role-plan reply and operation cannot contradict', async () => {
  const result = await runRolePlan({ userText: '明天下午三点提醒我', now: fixedNow });
  assert.equal(result.operation.op, 'create');
  assert.equal(result.operation.schedule.at, '2026-07-31T15:00:00+08:00');
  assert.match(result.visibleText, /明天下午|三点/);
});

test('unclear time cannot be guessed into a structured schedule', async () => {
  const result = await runRolePlan({ userText: '过几天提醒我' });
  assert.equal(result.operation, null);
  assert.match(result.visibleText, /哪天|什么时候/);
});

test('v3 user-visible plan confirmation is rendered from the canonical operation', async () => {
  const result = await runRolePlan({
    kind: 'DIRECT_REPLY', userText: '明天下午三点提醒我',
    modelReply: '好，明天下午四点提醒你', now: fixedNow
  });
  assert.equal(result.operation.schedule.at, '2026-07-31T15:00:00+08:00');
  assert.equal(result.visibleText,
    renderRolePlanConfirmation(result.operation, result.targetSnapshot, 'Asia/Shanghai'));
  assert.doesNotMatch(result.visibleText, /四点/);
});

test('automatic and private-decision lanes never receive a private plan confirmation', async () => {
  for (const kind of ['ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE',
    'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE']) {
    const result = await runRolePlan({ kind, source: 'private_decision' });
    assert.equal(result.usedUserConfirmationRenderer, false);
  }
  assert.equal((await runRolePlan({ kind: 'ROLE_PLAN_MOMENT_PRIVATE',
    source: 'private_decision' })).recipientId, 'public_moments');
});

test('life planning fixes basis and creates compare only after result commit', async () => {
  const attempt = createLifeAttempt();
  assert.ok(attempt.lifeBasisChecksum);
  assert.equal(store.getComparisonJobForLife(attempt.planningId), null);
  commitLifeResult(attempt, ordinaryLifeResult());
  assert.ok(store.getComparisonJobForLife(attempt.planningId));
});

test('life planning evidence is store-pinned input authority, never model-cited ids', () => {
  const attempt = runningLifeAttempt();
  assert.equal(attempt.inputSnapshot.roleId, attempt.roleId);
  assert.deepEqual(attempt.inputSnapshot.planningWindow, {
    startAt: attempt.planningWindowStartAt,
    targetEndAt: attempt.planningWindowEndAt
  });
  for (const forbidden of ['evidenceIds', 'sourceMessageIds', 'usedFactIds', 'lifeBasisChecksum']) {
    assert.throws(() => commitLifeResult(attempt, {
      ...ordinaryLifeResult(), [forbidden]: forbidden === 'lifeBasisChecksum'
        ? attempt.lifeBasisChecksum : ['model_supplied']
    }), /life planning result authority conflict/);
  }
});

test('coordinated input checksum tampering cannot change attempt role or window', () => {
  const attempt = runningLifeAttempt();
  rawTamperAttemptSnapshotAndRehash(attempt.planningId, {
    ...attempt.inputSnapshot,
    roleId: 'foreign_role',
    planningWindow: { ...attempt.inputSnapshot.planningWindow, targetEndAt: 1 }
  });
  assert.throws(() => commitLifeResult(attempt, ordinaryLifeResult()),
    /life planning evidence authority conflict/);
  assert.deepEqual(lifeResultSideEffects(attempt.planningId), emptyLifeResultSideEffects());
});

test('terminal life replay validates historical input and stored output without recomputing post-write basis', () => {
  const attempt = runningLifeAttempt();
  const result = ordinaryLifeResult();
  const committed = commitLifeResult(attempt, result);
  assert.notEqual(store.getLifeBasisChecksum(attempt.roleId, planningWindow(attempt)),
    attempt.lifeBasisChecksum);
  assert.deepEqual(commitLifeResult(attempt, result), committed);
  tamperPersistedLifeEpisode(committed.authoritativeResult.episodes[0].episodeId);
  assert.throws(() => commitLifeResult(attempt, result), /life planning episode authority conflict/);
});

test('stage cannot generate a routine affection disclaimer', async () => {
  const result = await runDirectAtStage({ base: 'familiar', phase: 'normal',
    userText: '抱一下' });
  assert.doesNotMatch(result.visibleText, /还没到|这个阶段|等关系更近|不能太亲密/);
});

test('user-edited stage persona survives v3 compilation without becoming a blanket ban', () => {
  const compiled = compileStagePersona({
    revision: 7,
    userEditedText: '这个阶段她比较克制，但会在真正想靠近时主动。',
    authorHardSettings: []
  });
  assert.equal(compiled.sourceRevision, 7);
  assert.match(compiled.toneTendencies.join(' '), /克制/);
  assert.equal(compiled.hardConstraints.length, 0);
});

test('ordinary life generation rejects major unsupported events', () => {
  assert.throws(() => validateLifeResult({
    episodes: [{ type: 'major_event', text: '突然重病住院' }]
  }), /unsupported major life event/);
});

test('only a committed validated life result may author a public moment candidate', () => {
  assert.throws(() => store.putLifePlanInternal('yuqi', [episodeWithPublicMarker()]),
    /reserved public moment candidate/);
  const attempt = runningLifeAttempt();
  const committed = store.commitLifePlanningResultInternal({
    planningId: attempt.planningId,
    workerId: attempt.leaseOwner,
    validatedResult: validatedLifeResultWithPublicCandidate()
  });
  assert.deepEqual(store.getLifeEpisode(committed.authoritativeResult.episodes[0].episodeId)
    .payload.publicMomentCandidate, validClosedPublicCandidate());
});
```

- [ ] **Step 2: Run plan/life/stage tests red**

Run:

```powershell
node --test yuqi-runtime/test/role-plan-life-stage-v3.test.mjs yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs
```

Expected: FAIL until formal stage and v3 operations are separated from expression.

- [ ] **Step 3: Implement strict domains and two-phase life authority**

```js
export function compileRelationshipForCognition(state) {
  return {
    base: state.base,
    phase: state.phase,
    formalFacts: state.formalFacts,
    allowedFormalTransitions: state.allowedTransitions,
    toneTendencies: state.stagePersona.toneTendencies
  };
}

export function relationshipExpressionView(state) {
  return {
    formalFacts: state.formalFacts,
    toneTendencies: state.stagePersona.toneTendencies
  };
}
```

Do not pass stage thresholds, transition graph labels, or “allowed affection” flags to expression. Preserve user-edited stage-persona text and revision; compile ordinary wording such as “克制、不太主动” into tone tendencies, and compile only explicitly author-marked non-negotiable settings into author hard constraints. Role-plan operations remain the existing closed domain `create/update/cancel/pause/resume/complete` and `private_message/moment_post/role_schedule`; targets, evidence, and time validate deterministically.

Do not compare a free reply with a schedule by regex. Add a pure closed `renderRolePlanConfirmation(operation,targetSnapshot,'Asia/Shanghai')` and a code-owned `requiresUserConfirmation` classifier. The classifier is true only for v3 `DIRECT_REPLY` operations whose normalized persisted source is `spoken/accepted_request/user_created`; update/cancel/pause/resume/complete read that source and identity from the pinned target snapshot, never from model prose. Before rendering, the operation must pass the existing domain/repository/store validators, its target/revision/evidence must be exact, and every user-requested create or schedule-changing update must have `timeConfidence:'explicit'`. When true, the renderer replaces the complete free model reply and renders all canonical operations in ordinal order; the rendered item and action descriptors enter the same visible-result commit and generation fingerprint. Unknown operation/schedule, mixed communicative/private-decision operations, conflicting target snapshots, ambiguous time or renderer failure rejects the whole action set before visible commit and enters the normal repair path; it must not keep the action, guessed time or contradictory free text. `private_decision`, `ROLE_PLAN_CHAT`, `ROLE_PLAN_CHAT_PRIVATE`, `ROLE_PLAN_MOMENT` and `ROLE_PLAN_MOMENT_PRIVATE` never use this user-confirmation renderer. The two moment lanes remain `public_moments`, including `ROLE_PLAN_MOMENT_PRIVATE`; v1/v2/RA0 remain byte-compatible.

Life attempt creation fixes rollout/release/epoch/checksums/canary slot/input but creates no compare job.

Life planning is future-plan synthesis from a store-pinned snapshot, not fact extraction from model-cited evidence. Its immutable evidence authority is exactly `roleId + planningWindowStartAt + planningWindowEndAt + lifeBasisChecksum + contextChecksum + inputChecksum`, closed by `requestBaseKey = contentHash({roleId,startAt,endAt,lifeBasisChecksum,contextChecksum})`; rollout/release/epoch/canary pins remain the separate execution authority and are revalidated as already required by Task 11. `inputSnapshot.roleId/planningWindow` must equal the attempt columns even if a forged row synchronously changes and rehashes its snapshot/checksums/request key, `contentHash(inputSnapshot)` must equal `inputChecksum`, and every `current/recent/upcoming` episode reference must have belonged to that role and matched a real store row/checksum when the attempt was created. This uses the existing attempt columns and does not add a caller-writable evidence field or a schema version. The closed authoritative result top level is exactly `{episodes}`; `evidence/evidenceIds/sourceMessageIds/usedFactIds/lifeBasisChecksum/contextChecksum/inputChecksum/requestBaseKey` and every other top-level key are rejected before any write. The model cannot authorize its own result by echoing checksums or IDs.

On first commit, `commitLifePlanningResultInternal()` revalidates the full input tuple and current pre-write life basis inside the controller's immediate transaction before writing anything. A stale basis cancels/fails through the controller exactly once and writes no episode/marker/compare job. On terminal exact replay, the newly committed output episodes necessarily change the current basis, so replay must not recompute that pre-write value. It instead revalidates the persisted input/context/request commitments, the caller result checksum, the stored authoritative result checksum, every output episode's role/source planning ID/semantic checksum, the optional reserved object, the compare job and attempt terminal state; only then may it return the original result. Missing or changed projection is an authority conflict with zero writes.

Only an episode payload nested inside that closed result may optionally carry `publicMomentCandidate`, and only as the exact `{version:'public-moment-candidate-v1',visibility:'public',summary}` object; summary uses the same native-string/trimmed/1–280 limit as Task 18. `commitLifePlanningResultInternal()` revalidates that object from the authoritative result inside its immediate transaction and calls a private trusted life-plan row writer. No generic `putLifePlanInternal`, chat adjustment, import/restore, caller flag, comparison result, failed/shadow draft, or retry-wait attempt can set or preserve the reserved key. Exact replay returns the same result; changed marker/checksum conflicts; close/reopen recomputes the episode checksum and reserved object. Authoritative result commit creates the compare job in the same transaction. Failed authority creates no episode/marker/compare job; active/canary failure routes to the controller. Chat life adjustments and visible wording must agree.

- [ ] **Step 4: Run all plan/life/stage tests green**

Run the Step 2 command.

Expected: PASS for schedule recovery, role-plan history, life restart, base/phase evidence, and no routine stage leakage.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/relationship-stage.mjs yuqi-runtime/src/life-planning-dispatcher.mjs yuqi-runtime/src/life-simulation.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/cognition-v3-adapters.mjs yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/role-plan-life-stage-v3.test.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs
git commit -m "feat: integrate plans life and formal relationship stages"
```

### Task 20: Constrain Memory Consolidation and Complete Data Lifecycle

Task 20 is a five-gate lifecycle migration, not one UI delete handler. Each gate
must be committed and independently reviewed before the next begins. Task 13C's
Room-v12 checkpoint contract is the immutable input baseline. Android advances
through Room v13 lifecycle authority and the already-implemented v14 inbound-ACK
tombstone schema, then Task 20E performs the explicit current v14→v15
notification-cancellation migration. Separately, the PC database advances to
its own schema v15 for `conversation_clear_controls`; equal version numbers do
not imply a shared schema or migration domain.
Do not implement a second redaction path, reuse `change_events` as an outbox, or
treat relay mailbox acceptance as proof that PC applied a clear.

#### Task 20A: Evidence-only memory consolidation

**Files:**
- Modify: `yuqi-runtime/src/consolidation-worker.mjs`
- Modify: `yuqi-runtime/src/evidence-memory.mjs`
- Modify: `yuqi-runtime/src/retrieval.mjs`
- Modify: `yuqi-runtime/test/consolidation-worker.test.mjs`
- Modify: `yuqi-runtime/test/evidence-memory.test.mjs`
- Create: `yuqi-runtime/test/memory-authority-v3.test.mjs`

**Closed contract:**
- `validateConsolidationCandidate(candidate, evidence)` accepts only
  `user_fact`, `delivered_yuqi_life_fact`, `formal_commitment`,
  `retrievable_event`, `stable_preference`, `fact_conflict`, and
  `fact_supersession`.
- Every positive candidate resolves to a committed, non-redacted canonical
  message/action projection. Drafts, supervisor judgments, inferred motives,
  mood/current stance, comparison output, automatic skip, and uncommitted or
  withdrawn messages are never fact evidence.
- Candidate evidence is closed and typed: message evidence uses unique
  `sourceMessageIds` plus exact `{messageId,speakerId,text}` quotes; action
  evidence uses unique `sourceActionIds` plus exact
  `{actionId,kind,targetKey,targetRevision,payload,actionChecksum}` projections
  from the same scoped canonical loader. At least one source class is non-empty.
  Unknown, missing, duplicate, changed, undelivered, or cross-group evidence
  rejects the entire candidate; actions are never disguised as chat quotes.
- Both source-ID arrays contain native non-empty strings. Quotes have exactly
  three keys and form a complete one-to-one mapping to `sourceMessageIds`;
  actions have exactly the six listed keys and map one-to-one to
  `sourceActionIds`. Candidate identity/object/confidence/commitment fields use
  their closed native types. `origin`, `evidenceSource`, and
  `authorityContractVersion` are store-owned fixed/recomputed values, not model
  assertions.
- `user_fact` requires user-message evidence. Any character-message or visible
  action evidence requires the group delivery receipt to be confirmed.
  `action_only` may support an otherwise valid event/life/commitment candidate,
  but never a `user_fact`; `skip` supplies no evidence of either class.
- Every evidence member is type-checked even when messages and actions are
  mixed. An action-only/mixed life fact accepts only a same-role canonical
  `life_episode_*` action. A formal-commitment action must carry a native
  `promisedBy` proof equal to the candidate; a valid message cannot mask an
  unrelated action.
- A `stable_preference` requires two independent committed sources. Repeats of
  one source ID, original/retry projections of one lineage, or two facts derived
  from one visible group count once.
- Retrieval excludes redacted, withdrawn, archived, suppressed, superseded, and
  expired evidence before ranking; the model never sees a filtered record's
  text in debug metadata or annotations.

- [ ] **20A.1: Add red allowlist, source-authority, retry-deduplication, and
  retrieval lifecycle tests.**
- [ ] **20A.2: Implement one validator and one retrieval lifecycle predicate;
  route the worker and direct evidence writes through them.**
- [ ] **20A.3: Run the focused gate and commit.**

```powershell
node --test yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/memory-authority-v3.test.mjs
git add yuqi-runtime/src/consolidation-worker.mjs yuqi-runtime/src/evidence-memory.mjs yuqi-runtime/src/retrieval.mjs yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/memory-authority-v3.test.mjs
git commit -m "fix: constrain cognition memory to delivered evidence"
```

Stop after this commit for independent review. This slice may run in parallel
with 20B only while its six files remain exclusively owned.

#### Task 20B: Room-v13 lifecycle authority and atomic local clear

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/LifecycleControl.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/LifecycleControlCodec.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/LifecycleControlEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/BridgeReceiptCheckpoint.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/LifecycleControlCodecTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Room-v13 schema:**
- `lifecycle_controls` has one row per immutable `control_id` and columns
  `control_kind`, `character_id`, `peer_id`, `clear_epoch`,
  `cleared_through_sequence`, `requested_at`, `semantic_json`,
  `semantic_checksum`, `state`,
  `lease_id`, `lease_attempt`, `leased_at`, `relay_message_id`, `applied_at`,
  `relay_expires_at`, and `updated_at`.
- `control_kind` is closed to `conversation_clear_v1` and `role_delete_v1`;
  `state` is closed to `waiting`, `pending`, `relay_accepted`, `applied`, and
  `quarantined`. Conversation clears are unique by `(character_id,clear_epoch)`.
- `LifecycleControlCodec` freezes both closed wire shapes in 20B. For
  `role_delete_v1`, `clear_epoch/cleared_through_sequence` are null and
  `semantic_json` contains the exact nine-key Task 20E role-delete wire object,
  including its exact backup receipt tuple; 20B does not
  yet delete a role, but proves the schema can persist/reopen that future
  control without another migration or lossy parser.
- `MIGRATION_12_13` only creates this table/index set. It preserves every v12
  turn, attempt, cursor, authority, reply, raw message, memory, plan, and UTF-8
  field byte-for-byte and never fabricates controls or checkpoint tombstones.
  Fresh v13, populated 12→13, 10→11→12→13, restart, migration fault rollback,
  and `>13` refusal are release gates.

**Local clear transaction:**
- Replace the caller-authoritative plugin API with
  `createConversationClear(characterId, expectedCursorChecksum)`. Room, not
  JavaScript, reads the current cursor, sets `clearEpoch=current+1`, fixes
  `clearedThroughSequence=current.localSequence`, derives `controlId` and the
  canonical checksum, and inserts the waiting outbox row.
- `getConversationCursor` returns `cursorChecksum`, the SHA-256 of exact canonical
  JSON `{contract:'conversation-cursor-clear-v1',characterId,`
  `nativeCompletedTurnId,nativeCompletedGroupId,nativeCompletedSequence,`
  `uiAppliedTurnId,uiAppliedGroupId,uiAppliedSequence,localSequence,`
  `clearedThroughSequence,clearEpoch,clearedAt,chatOpen,updatedAt}`. Nullable IDs
  remain explicit JSON `null`; integers and the boolean retain native types.
  Room recomputes this projection inside the transaction; timestamps are never
  used as a revision/CAS by themselves.
- The plugin has no `peerId` argument. It loads `BridgeConfig.deviceId` from
  `AlSecretStore` and passes that store-owned binding to
  `RoomExecutionStore.createConversationClear(...)`; absence of a configured
  peer fails before mutation. Room verifies every affected v3 checkpoint is
  pinned to the same device. JavaScript cannot choose, replace, or omit it.
  `saveBridgeConfig` must refresh this native binding in the same process;
  generating or changing a device ID never requires an app restart before a
  clear can use the new store-owned peer.
- `controlId` is `ctl_` plus the lowercase SHA-256 of canonical
  `{contract:'android-lifecycle-control-id-v1',controlKind,characterId,peerId,`
  `clearEpoch,clearedThroughSequence,requestedAt,inputCursorChecksum}`.
  `semantic_json` stores the exact eleven-key clear wire object including its
  `checksum`. The wire `checksum` hashes the other ten keys;
  `semantic_checksum` separately hashes the complete persisted eleven-key object
  (including `checksum`). Both layers are revalidated on every
  list/claim/complete/reopen; no later task reconstructs wire from an internal
  seven-key DTO.
- In the same `runInTransaction`, validate every affected Task 13C v12
  checkpoint/checksum, replace it with the exact
  `android-bridge-redacted-checkpoint-v1` tombstone, clear reply/raw/action and
  semantic failure/result/route/relay fields through the boundary, advance the
  dedicated `clearedThroughSequence/clearEpoch` boundary, and then insert the
  control. Do not invent a turn/group identity at the clear boundary and do not
  rewrite `nativeCompleted*` or `uiApplied*`: those remain factual delivery/UI
  watermarks and may legitimately lag the independent clear boundary.
- The affected snapshot is closed inside that transaction: every existing
  legacy conversation turn for the role is included because historical v0/v2
  rows may have no trustworthy visibility sequence; every v3 turn must have a
  safe sequence and is included iff `inputVisibilitySequence <= boundary`.
  Legacy rows are redacted/cancelled without inventing a v3 checkpoint. A v3 row
  missing its sequence or active checkpoint, a one-sided checkpoint/checksum
  pair, or a corrupt/duplicate remote-member set is an authority conflict that
  rolls the whole clear back. A historical attempt that provably failed before
  acquiring any remote member may retain a null/null checkpoint pair, but its
  attempt semantics are still scrubbed in the transaction. This preflight enumerates every v3
  row for the role before filtering by the boundary, so a null, negative, or
  non-safe sequence cannot disappear from the affected-set query; a valid row
  above the boundary remains byte-for-byte unchanged.
- For each affected v3 lineage, the same transaction closes the existing
  `ConversationAuthorityEntity`: state becomes `CANCELLED`, revision advances
  exactly once from the validated member set, latest member identity is retained,
  and visible group/checksum/payload version/origin/disposition are cleared.
  Missing, foreign, duplicate, partially affected, or already-divergent lineage
  authority rejects before any tombstone is committed.
- The tombstone retains the existing Task 13C root key set and checkpoint
  version so old rows need no invented migration. It sets
  `normalizedEnvelope=null`; keeps the existing immutable identity/pin fields
  and original `envelopeChecksum`; and writes redaction time only at
  `outcome.redactedAt`. The outcome is exactly
  `{type:'redacted',route:null,relayMessageId:null,failure:null,`
  `result:{contract:'conversation-clear-redacted-v1',controlId,clearEpoch,`
  `clearedThroughSequence},redactedAt}`. A local-v2 root additionally retains
  its existing `fallbackExecution` and `journalSyncSeq` keys but sets the former
  to null and the latter to 0. Redacted validators branch before parsing
  `normalizedEnvelope`; all non-redacted parsers still require the original
  object. It contains no envelope, text, items, actions, failure detail, route,
  relay ID, fallback packet, or model memory.
- Per-turn diagnostics and change-event projections inside the affected set may
  retain their cursor/row identity only after being rewritten to one closed
  non-semantic redacted form. Old error detail, visible group/disposition,
  route, model text, or arbitrary payload keys are cleared in the same
  transaction and participate in every write-boundary rollback assertion.
- `BridgeReceiptCheckpoint` returns no receipt and `BridgeInput` refuses to
  execute this tombstone without reading `normalizedEnvelope`; tests cover both
  v1 remote and v2 local checkpoint roots.
- Any missing member, duplicate member, bad checksum, mixed epoch, stale cursor
  checksum, or injected write-boundary failure rolls the transaction back to a
  deep-equal pre-state. A tombstoned attempt cannot execute, fallback, notify,
  emit a completed event, enter the UI inbox, or publish a group receipt.
- `inputCursorChecksum` is included in the closed clear semantic/wire object.
  Exact plugin replay returns the same control when the supplied checksum equals
  that retained pre-clear checksum. If the current epoch's control is not yet
  `applied`, a page reload presenting the current post-clear checksum also
  resumes that row instead of allocating another epoch. Only an applied current
  control permits a later, intentional clear to allocate `clearEpoch+1`.
  A changed replay or two
  concurrent clear calls yields one row/one epoch; no caller can skip epochs or
  choose an arbitrary sequence.

- [ ] **20B.1: Add migration and full write-boundary red tests.**
- [ ] **20B.2: Add the entity/codec/DAO and one store-owned clear transaction.**
- [ ] **20B.3: Run JVM tests and build the instrumentation APK; run connected
  migration/Room tests when a device is attached.**

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*LifecycleControlCodecTest" --tests "*BridgeReceiptCheckpointTest" --tests "*BridgeInputTest" --no-daemon --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
adb devices -l
.\gradlew.bat connectedDebugAndroidTest --tests "*ConversationCursorStoreTest" --tests "*RoomExecutionStoreTest" --no-daemon --no-problems-report
cd ..
git add android/app/src/main/java/com/siyi/al/execution/LifecycleControl.java android/app/src/main/java/com/siyi/al/execution/LifecycleControlCodec.java android/app/src/main/java/com/siyi/al/execution/db/LifecycleControlEntity.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/execution/BridgeReceiptCheckpoint.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/androidTest/java/com/siyi/al/AlExecutionPluginTest.java android/app/src/test/java/com/siyi/al/execution/LifecycleControlCodecTest.java android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "feat: persist Android lifecycle clear authority"
```

No attached device is an explicit blocked release gate, not a skipped pass.
Stop after this commit for independent review.

#### Task 20C0: Make relay expiry refresh real before Android depends on it

**Files:**
- Modify: `yuqi-relay-worker.js`
- Modify: `tests/yuqi-relay-worker.test.mjs`

The existing relay `INSERT OR IGNORE` cannot refresh a live envelope: duplicate
`message_id` or `(device_id,idempotency_key)` returns idempotent without changing
`expires_at`. Android must not claim durable seven-day refresh until this server
contract exists.

- Add authenticated `POST /bridge/refresh-expiry`. Its body is closed to exact
  native strings `deviceId,messageId,idempotencyKey,direction` plus a native safe
  integer `expiresAt`. It updates only one existing, non-expired row whose full
  identity matches; ciphertext, nonce, byte count, created time and direction
  never change. The new expiry must be greater than the persisted expiry and no
  later than `now+7 days`. Exact/lower replay returns the persisted expiry
  idempotently; foreign, changed, missing or already-expired identity is zero
  write and fail-closed.
- Before normal enqueue, both D1 and memory stores may remove an expired row only
  when the complete persisted identity simultaneously equals
  `deviceId,messageId,idempotencyKey,direction` and `expiresAt<=now`. A conflict
  on only the message ID or only the device/idempotency identity is foreign or
  changed input: it is zero-write and fail-closed. The expired-row removal,
  removal of its live identity index, and replacement insert are one store-owned
  atomic operation: D1 uses one transactional `batch`/equivalent rollback unit;
  the memory store performs the envelope/index mutation in one synchronous
  critical section. A failed insert restores neither a half-deleted row nor a
  stale identity index. Normal ACK likewise removes both the live envelope and
  its live identity index in memory, matching D1's row-deletion semantics; the
  index is not a second durable receipt store. The same semantic control can then
  be encrypted again and inserted with the same stable IDs after ACK or a long
  offline expiry. A still-live row is never replaced with new ciphertext.
- Tests cover live refresh, exact replay, changed/foreign identity, expiry bounds,
  ciphertext immutability, memory/D1-equivalent behavior, ACK index cleanup,
  transaction/batch rollback, partial-identity conflict, and expired exact
  re-enqueue. Commit this slice before 20C Android code consumes the endpoint.

```powershell
node --test tests/yuqi-relay-worker.test.mjs
git add yuqi-relay-worker.js tests/yuqi-relay-worker.test.mjs
git commit -m "feat: refresh lifecycle relay expiry safely"
```

Stop after this commit for independent review.

#### Task 20C: Durable Android LAN/cloud control delivery and PC-applied ACK

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/LifecycleControl.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/LifecycleControlCodec.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/LifecycleControlSender.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionServicePolicyTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/LifecycleControlCodecTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/LifecycleControlSenderTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Delivery contract:**
- The one Room row is the outbox authority. `waiting|expired pending` is claimed
  by exact lease CAS; an unexpired pending row is not selectable. The relay ID
  and idempotency key are stable for the semantic checksum across retries; a
  new lease attempt does not generate a new relay identity.
- The encrypted clear envelope is stable across the crash window as well.
  Lifecycle controls alone derive the 12-byte AES-GCM nonce as the first 12
  bytes of HMAC-SHA-256 using the configured 32-byte encryption key over UTF-8
  `android-lifecycle-gcm-nonce-v1\n<relayMessageId>`. The immutable
  `semantic_json`, semantic-bound relay ID and Room reopen validator guarantee
  that one derived nonce is never used for changed plaintext. Ordinary
  turn/result traffic keeps its existing random nonces.
- A successful new `/bridge/enqueue` response is closed to
  `ok,messageId,idempotent`; when `idempotent=false`, Room persists the expiry
  it requested. When a crash retry returns `idempotent=true`, that response has
  no authoritative persisted expiry, so Android must call
  `/bridge/refresh-expiry` with the same full identity before its Room CAS and
  persist only the returned expiry. A process death after either network call
  repeats the same ciphertext/identity and converges through that refresh; it
  never guesses server expiry.
- `relay_accepted` remains selectable for refresh when its persisted
  `relayExpiresAt` reaches the retry window. It takes a new exact lease, reuses
  the same relay ID/idempotency key, and requests a fresh expiry of at most seven
  days. Thus relay acceptance does not silently become permanent success, and a
  control continues until a validated PC-applied ACK moves it to `applied`.
- LAN calls `POST /v3/controls/conversation-clear` and marks `applied` only after
  the authenticated 200 response carries the exact closed applied proof defined
  below.
- Cloud sends encrypted `CONVERSATION_CLEAR` through `phone_to_pc`. Relay
  acceptance advances only to `relay_accepted`; it is not PC application proof.
  PC later emits encrypted `CONVERSATION_CLEAR_APPLIED` to the same peer. The
  relay wrapper has no semantic type, so its decrypted body has exactly ten keys:
  `protocolVersion,type,controlId,controlChecksum,roleId,peerId,clearEpoch,`
  `clearedThroughSequence,appliedAt,checksum`. `protocolVersion` is the native
  integer `3`, `type` is exactly `CONVERSATION_CLEAR_APPLIED`,
  `controlChecksum` equals the persisted lifecycle `semanticChecksum`, and
  `checksum` is SHA-256 of canonical JSON of the other nine fields. The relay
  wrapper owns only relay ID, direction and expiry; those are not inner ACK keys.
  Android validates this exact
  tuple and only then marks the row `applied` and ACKs that relay envelope.
  Duplicate/late ACKs are idempotent; changed ACKs quarantine. The lifecycle row's
  persisted `relayMessageId,relayExpiresAt` identify the outbound phone-to-PC
  clear command. Room reloads and exact-matches that persisted pair as its own CAS
  snapshot; it is never compared with the inbound PC-to-phone applied envelope's
  different relay ID/expiry. The inbound relay ID is used only to ACK that applied
  envelope after the Room transaction commits, and neither relay identity
  substitutes for role/peer/applied proof.
- Boot, wake, service recovery, LAN timeout, cloud timeout, process death after
  claim, and process death after relay acceptance all resume from Room. Two
  workers may cause external at-least-once calls after a lease expiry but use
  the same relay idempotency key; one live lease produces one HTTP call.
- Store APIs, not BridgeClient, own list/claim/complete/quarantine. Every CAS
  matches `controlId,semanticChecksum,expectedState,leaseId,leaseAttempt,leasedAt`
  and the complete persisted relay snapshot when present:
  `relayMessageId,relayExpiresAt`. The relay ID is recomputed and must equal the
  stable formula before mutation; a LAN row must keep both relay fields null.
  A stale lease completion updates zero rows and may only return an
  already-equivalent terminal outcome; it cannot overwrite a replacement lease,
  applied row or quarantine.
- The state shape is exact. `waiting` has attempt zero and no lease/relay/applied
  fields. `pending` has one active lease; it has no relay identity for a first
  send, or retains the exact relay ID/old expiry pair for a refresh/re-enqueue.
  `relay_accepted` has the stable relay ID/expiry and no active lease. `applied`
  has a positive applied time and no active lease; a cloud row may retain its
  relay ID/expiry pair as audit proof while a LAN row retains neither.
  `quarantined` has no lease/relay/applied fields. Pending lease expiry is
  `leasedAt+60_000`; relay refresh becomes claimable 24 hours before expiry.
- IDs are recomputed on every claim/complete/reopen, not stored as caller truth:
  `leaseId='ctllease_'+sha256(canonical {contract:'android-lifecycle-lease-id-v1',`
  `controlId,semanticChecksum,leaseAttempt})`,
  `relayMessageId='ctlmsg_'+sha256(canonical {contract:'android-lifecycle-relay-message-id-v1',`
  `controlId,semanticChecksum})`, and
  `idempotencyKey='ctlidem_'+sha256(canonical {contract:'android-lifecycle-idempotency-v1',`
  `controlId,semanticChecksum})`. Lease attempt/time/randomness never changes
  relay identity.
- `BridgeRouter` routes controls separately from turns. It never creates a
  `TurnSubmission`, fallback, mirror reply, notification, or completed event.
- `LifecycleControlSender`/an independent `ControlRouteClient` owns this route;
  it never calls the turn endpoint. A newly created clear calls
  `AlExecutionService.requestRun()` after the Room commit so delivery does not
  wait for an unrelated turn or periodic scan.
- 20C registers only `conversation_clear_v1`. The shared Room lease/CAS machinery
  validates `role_delete_v1`, but that kind remains `waiting` and zero-write/
  zero-send until Task 20E registers its route. Missing route is not quarantine.

- [ ] **20C.1: Add red two-Room-connection, exact lease, expiry/refresh, LAN,
  cloud, ACK, restart, role-delete-hold, and turn-path-isolation tests.**
- [ ] **20C.2: Wire one shared Room-backed sender into Runtime/service/wake.**
- [ ] **20C.3: Run focused JVM tests and commit.**

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*BridgeClientTest" --tests "*BridgeRouterTest" --tests "*RoomBridgeMirrorTest" --tests "*ExecutionServicePolicyTest" --no-daemon --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
adb devices -l
.\gradlew.bat connectedDebugAndroidTest --tests "*RoomExecutionStoreTest" --no-daemon --no-problems-report
cd ..
git add android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/execution/LifecycleControl.java android/app/src/main/java/com/siyi/al/execution/LifecycleControlCodec.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/LifecycleControlSender.java android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeRouter.java android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeClientTest.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRouterTest.java android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java android/app/src/test/java/com/siyi/al/execution/ExecutionServicePolicyTest.java android/app/src/test/java/com/siyi/al/execution/LifecycleControlCodecTest.java android/app/src/test/java/com/siyi/al/execution/LifecycleControlSenderTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "feat: deliver lifecycle controls durably"
```

Stop after this commit for independent review.

No attached device is an explicit blocked release gate, not a skipped pass.

#### Task 20D: PC clear transaction, relay retraction, and application ACK

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Modify: `yuqi-runtime/src/turn-status.mjs`
- Modify: `yuqi-runtime/src/evidence-memory.mjs`
- Modify: `yuqi-runtime/src/retrieval.mjs`
- Modify: `yuqi-runtime/src/consolidation-worker.mjs`
- Modify: `yuqi-relay-worker.js`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Create: `yuqi-runtime/test/agency-data-lifecycle.test.mjs`
- Modify: `yuqi-runtime/test/local-server.test.mjs`
- Modify: `yuqi-runtime/test/cloud-relay-pump.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`
- Modify: `yuqi-runtime/test/evidence-memory.test.mjs`
- Modify: `yuqi-runtime/test/retrieval.test.mjs`
- Modify: `yuqi-runtime/test/consolidation-worker.test.mjs`
- Modify: `yuqi-runtime/test/store-visible-authority-v13.test.mjs`
- Modify: `yuqi-runtime/test/store-release-authority-v14.test.mjs`
- Modify: `tests/yuqi-relay-worker.test.mjs`

Task 20D consumes, and must not weaken or reimplement, the committed Task 20C0
relay contract: `/bridge/refresh-expiry`, exact full-identity refresh, atomic
expired cleanup/reinsert, ACK live-index cleanup, and live ciphertext/nonce
immutability remain regression gates. A refresh accepted by the relay followed
by a failed Android Room CAS is recovered after restart by the same stable relay
identity; exact/lower refresh returns the persisted expiry and the subsequent
exact Room CAS applies that returned value without creating a second envelope.

**Wire and authority contract:**
- `validateConversationClearControl(raw)` accepts exactly
  `protocolVersion,type,controlVersion,controlId,roleId,peerId,clearEpoch,`
  `clearedThroughSequence,requestedAt,inputCursorChecksum,checksum`; values are native types,
  `protocolVersion=3`, `type=CONVERSATION_CLEAR`, and
  `controlVersion=conversation_clear_v1`. `checksum` is the UTF-8 canonical JSON
  hash of the other ten fields. Unknown/missing/coerced values reject before
  store, reconcile, diagnostic, relay ACK, or application ACK.
- Both ingress paths validate/authenticate first and call
  `applyConversationClearInternal(control)` in one `BEGIN IMMEDIATE`. Cloud ACK
  of the phone→PC ciphertext occurs only after commit. The applied ACK is a
  separate closed `CONVERSATION_CLEAR_APPLIED` inner body containing exactly
  `protocolVersion,type,controlId,controlChecksum,roleId,peerId,clearEpoch,`
  `clearedThroughSequence,appliedAt,checksum`. `protocolVersion` is native
  integer `3`, `type` is exactly `CONVERSATION_CLEAR_APPLIED`,
  `controlChecksum` is the original control semantic checksum, and `checksum`
  hashes canonical JSON of the other nine fields. Relay identity, direction and
  expiry remain in the authenticated outer transport wrapper and are not accepted
  as extra inner keys.
- PC does not need a second local ACK-outbox table. The already persisted
  `conversation_clear_controls` row proves application, while the unacknowledged
  phone→PC relay ciphertext is the durable retry trigger. CloudRelayPump calls
  relay `POST /bridge/ack-with-response`, which atomically deletes that exact
  incoming message and inserts the encrypted PC→phone applied envelope with a
  deterministic message ID/idempotency key. The D1 implementation uses one
  transactional batch; the memory store performs the same operation without an
  observable intermediate state. If PC crashes after its DB commit but before
  this relay transaction, the incoming ciphertext remains, is polled again, and
  exact control replay produces the same applied response. If the relay
  transaction commits but its HTTP response is lost, the incoming message is
  gone and the applied response remains pollable by Android.
- The applied-response relay message ID/idempotency key and encrypted bytes are
  deterministic for the committed ten-key applied proof. Its AES-GCM nonce uses
  the corresponding PC-side lifecycle-response contract plus the stable response
  relay ID. Thus two concurrent processors of the same still-live incoming
  ciphertext submit byte-identical response envelopes; normal non-lifecycle
  relay traffic retains random nonces.
- `/bridge/ack-with-response` is a closed ciphertext-only relay wrapper. It
  accepts exactly the authenticated `deviceId`, one incoming `messageId`, and
  one normal encrypted response envelope; it repeats the existing
  device/direction/idempotency/size/expiry checks and rejects plaintext fields.
  It never decrypts or derives lifecycle semantics.
- The wrapper shape is exactly
  `{deviceId,incomingMessageId,response}`. `response` has exactly the normal
  encrypted-envelope keys
  `{deviceId,messageId,direction,ciphertext,nonce,idempotencyKey,expiresAt}`;
  its `deviceId` equals the authenticated outer device, its direction is
  `pc_to_phone`, and the deleted incoming row must be the same device's live
  `phone_to_pc` row identified by `incomingMessageId`. The success body is
  exactly `{ok,incomingMessageId,responseMessageId,idempotent}`. Missing,
  foreign, changed or partially matching identities fail closed without
  deleting the incoming row or inserting/changing a response.
- For a validated, reopened ten-key applied proof `proof`, derive the response
  relay message ID as `ctlack_` plus the first 24 lowercase hex characters of
  `SHA-256(UTF-8("pc-lifecycle-response-message-id-v1\n" + proof.controlId +
  "\n" + proof.checksum))`; derive the idempotency key in the same way with
  prefix `ctlackidem_` and domain
  `pc-lifecycle-response-idempotency-v1`. Serialize the encrypted plaintext as
  UTF-8 canonical JSON of `proof`. Its 12-byte AES-GCM nonce is the first 12
  bytes of `HMAC-SHA-256(encryptionKey,
  "pc-lifecycle-response-gcm-nonce-v1\n" + responseMessageId)`. The response
  expiry is exactly `proof.appliedAt + 604800000` after safe-integer and
  captured-clock validation. These fields are therefore byte-identical for
  replay and concurrent processors; normal relay messages retain their random
  nonce and caller-selected expiry.
- Relay atomic exchange is exact-replay idempotent. If the incoming row is
  already absent but the complete response identity and encrypted bytes are
  present, return the same success with `idempotent=true`. Any changed response
  byte, nonce, direction, idempotency key or expiry is a 409 conflict. Memory
  storage performs all preflight checks before one unobservable mutation; D1
  deletes the incoming row, inserts the response and accounts for its usage in
  one transactional batch. A failed batch leaves all three facts unchanged.

**PC schema-v15 control authority amendment:**
- Task 20D raises the PC SQLite `user_version` from 14 to 15 before adding the
  production clear writer. `conversation_clear_controls` is rebuilt with the
  exact columns `control_id,role_id,peer_id,clear_epoch,cleared_through_sequence,`
  `requested_at,applied_at,input_cursor_checksum,checksum,applied_checksum,`
  `authority_version,semantic_json`. `authority_version` is exactly `0|1`.
- A v15 authority-v1 row is the sole durable proof for a new protocol-v3 clear:
  `peer_id` and `input_cursor_checksum` are non-null native wire projections;
  `semantic_json` is exactly `canonicalJson(validateConversationClearControl(raw))`;
  and `checksum` is the lower-case SHA-256 of the first ten wire fields. The v1
  columns `control_id,role_id,peer_id,clear_epoch,cleared_through_sequence,`
  `requested_at,input_cursor_checksum,checksum` must each equal their projection
  from that JSON. `authority_version` is the store-owned native integer `1`, and
  `applied_at` is the store commit timestamp; neither is an inbound command field
  nor appears in `semantic_json`. `applied_checksum` is the lower-case SHA-256 of
  the closed ten-key `CONVERSATION_CLEAR_APPLIED` proof rebuilt from the persisted
  v1 command columns plus `applied_at`; it is the independent commitment that
  makes changed applied time fail reopen. The production writer inserts only
  authority-v1 rows and rebuilds every applied response from this persisted row,
  never from request-layer values.
- Populated v14 rows retain all seven historical values byte-for-byte and migrate
  as authority-v0 audit shells with `peer_id,input_cursor_checksum,semantic_json`
  null; `applied_checksum` is also null. Migration must not infer a peer from a
  current lane/device, invent a cursor checksum, or reinterpret an arbitrary
  historical `checksum` string as a v1 SHA-256. The v1 hash/type rules apply only
  after `authority_version=1` is established. An authority-v0 row can neither
  authorize protocol-v3 replay nor produce an applied response; a new control
  colliding by `control_id` or `(role_id,clear_epoch)` fails closed with zero
  writes instead of overwriting it.
- The v14→v15 migration runs in one immediate transaction with real fault
  checkpoints after new-table creation, row copy, projection verification,
  table swap/index recreation and version write. Every injected failure leaves
  the source schema, rows and `user_version=14` unchanged. Fresh databases and
  populated v10/v12/v13/v14 databases must converge to the same exact v15 schema;
  v13 redacted groups, v14 canary indexes and authority-v0 shells remain valid.
  Reopen invariants recompute every authority-v1 semantic projection and reject
  missing/extra columns, partial authority-v1 rows, forged JSON/checksum, changed
  peer/cursor/boundary/time/applied proof, duplicate role/epoch, and an authority-v0
  row that contains any v1-only value.
- The normal migration target becomes 15. Opening an existing version-15 database
  runs the v15 reopen invariant directly; versions above 15 refuse. The historical
  v13/v14 seven-column schema validator remains exact for its source versions and
  is not weakened or reused against v15; v15 has a separate exact schema and row
  invariant layered on all still-applicable v10/v11/v13/v14 authority checks.
- Export two independent closed protocol helpers:
  `validateConversationClearControl(raw)` for the eleven-key command and
  `validateConversationClearApplied(raw)` for the ten-key applied proof. Both
  require native string/number types before hashing; they must not reuse the
  legacy `String(...)`/`Number(...)` coercing helpers. The applied projector
  accepts only a reopened authority-v1 row plus its committed lane state and
  returns the same ten-key bytes on exact replay/restart.
- Exact `controlId` replay and exact `(roleId,clearEpoch)` replay return the
  original applied record. Changed checksum, changed boundary, epoch skipping,
  lower through sequence, foreign peer, or concurrent changed control is zero
  write. The store boundary is
  `turn.input_clear_epoch < clearEpoch` OR
  `(turn.input_clear_epoch = clearEpoch AND input_visibility_sequence <= clearedThroughSequence)`.
  This predicate is evaluated only inside the persisted `(roleId,'private_chat')`
  lane. Both result-authority-v1 protocol-v2 and protocol-v3 canonical attempts
  are eligible; a canonical candidate must have `turn.lane_key`, lineage lane and
  the validated envelope-derived lane all equal `private_chat`, plus a persisted
  non-negative sequence/epoch pair. A canonical v2 row is never skipped merely
  because it predates the v3 wire. Public-moment and moment-thread rows are outside
  the affected set and remain byte-identical.

**Single clear transaction order:**
1. Load and CAS the private-chat lane. Freeze the target lineage/group/delivery
   set and reject any corrupt live authority before mutation.
2. Cancel open canonical lineages and stop recovery. For committed lineages,
   invoke the Task 10F redaction implementation, never a UI-specific variant.
   Keep `rollout_key`, parent counts/commitments, deterministic child IDs and
   original hashes; erase semantic envelope/message/item/action/manifest/state,
   old session, linked annotation/diagnostic/sync payload and executable jobs.
3. Scrub Yuqi authority-v0 turns and exclude them from legacy recovery/outbox.
   They cannot remain as a hidden plaintext compatibility copy.
4. Before any delivery payload is cleared, persist exact delivery count and
   commitment. Waiting rows with no relay ID become `redacted`; mailboxed or
   confirmed rows become `redaction_pending` with their original deterministic
   relay ID. No new delivery may be added to a redacted group.
5. Archive/expire evidence, stance and user-derived constraints whose sole
   authority is cleared; rebuild current cognitive state without a redacted
   group. Preserve author/system constraints and global release definitions.
6. Advance lane clear cursor, insert `conversation_clear_controls`, append only
   the closed redaction audit, run the scoped redacted lineage/group validator,
   and commit. An injected failure after every write boundary rolls all of it
   back.

**Authority-v0 legacy redaction authority:**
- A live `result_authority_version=0` turn is selected by the same persisted
  `(input_clear_epoch,input_visibility_sequence)` boundary as a canonical turn.
  Protocol v1 and v2 are both accepted only after `validateEnvelope()` and the
  persisted `envelope_checksum` are revalidated inside the clear transaction.
  Protocol v1 is the historical private-chat-only contract. Protocol v2 is
  eligible only when `laneKeyForEnvelope(validatedEnvelope)==='private_chat'`;
  `PROACTIVE_MOMENT`, moment interaction/reply and every other non-private lane
  are excluded and byte-identical after clear.
  Historical authority-v0 rows legitimately predate visibility cursors:
  `input_visibility_sequence=NULL` is interpreted as legacy baseline sequence
  zero only for affected-set selection, and is never rewritten or presented as a
  newly proven cursor. A non-null sequence and `input_clear_epoch` must be native
  non-negative safe integers; the v13 default epoch zero is the pre-clear epoch.
  A malformed live envelope, invalid sequence/epoch, foreign role, or an
  authority-v0 row already carrying canonical group/receipt authority rejects
  before the first write. A previously redacted v0 turn is validated and skipped;
  it is never redacted a second time.
- Redaction never upgrades the turn. It preserves `turn_id`, character/device
  identity, device sequence, source message identity, `result_authority_version=0`,
  the original `envelope_checksum`, release pins and revisions. It sets the
  terminal state to `cancelled`, writes `authority_redacted_at=appliedAt`, replaces
  `envelope_json` with exact `{"redacted":true}`, clears worker/model/memory/
  supervisor/reply/error/route/annotation semantics, deletes `turn_stages`, and
  tombstones any complete v2 batch and turn-linked message without changing their
  retained identities. Linked diagnostics, non-redaction sync rows, sessions and
  executable jobs are removed in the same transaction. The legacy recovery,
  status and delivery writers must branch before parsing the redacted envelope
  and must never requeue, prepare or reconstruct this turn.
- No schema v16 is introduced. Existing `sync_log` is the authority anchor. The
  transaction appends exactly one row per newly redacted v0 turn with
  `entity_type='legacy_turn_redaction'`, `entity_id=turnId`,
  `operation='redact'`, `created_at=appliedAt`, canonical payload and checksum.
  This is an application-integrity authority, not an external cryptographic
  signature. Validators must reject application bugs, interrupted writes and
  independent/mismatched corruption of the audit or its retained projections.
  A local administrator who can rewrite the authority audit, every dependent
  row and every checksum in one coordinated operation is outside this model;
  detecting that requires a signing key or append-only root outside the SQLite
  database and is not to be simulated by a second mutable in-database hash.
  The payload is a closed object with exactly
  `auditVersion,controlId,roleId,turnId,protocolVersion,redactedAt,deliveryCount,`
  `deliveries,deliveryCommitment,messageTombstoneCount,`
  `messageTombstoneCommitment,batchTombstoneCount,batchTombstoneCommitment`;
  `auditVersion` is
  `legacy_turn_redaction_v1`. `deliveries` is sorted by `peerId` and each entry
  has exactly `peerId,originalState,originalChecksum,relayMessageId,deliveredAt,`
  `confirmedAt,recoveryAckSeq`. `originalChecksum` is null for `waiting` and
  the original lowercase SHA-256 for every prepared state, so reopen can
  independently recompute the stable relay identity after payload removal.
  `originalState` is a native string in the closed set
  `waiting,pending,mailboxed,confirmed,delivered`; `peerId` is a non-empty native
  string, `relayMessageId` is a non-empty native string or null, the two times are
  positive safe integers or null, and `recoveryAckSeq` is a native non-negative
  safe integer. It contains no payload, reply, error, route, content or model
  field. `deliveryCommitment` is the lowercase SHA-256 of canonical
  `{auditVersion:'legacy-turn-deliveries-v1',turnId,deliveries}` and
  `deliveryCount===deliveries.length`.
- Before erasing content, freeze the exact RA0 message and v2 batch tombstone
  projections into the same audit. `messageTombstoneCount` is the retained
  turn-linked message count and `messageTombstoneCommitment` hashes canonical
  `{auditVersion:'legacy-turn-messages-v1',turnId,messages}` where sorted
  `messages` entries contain exactly
  `messageId,turnId,characterId,speakerId,speakerType,recipientId,sentAt,origin,`
  `deviceId,deviceSeq,batchId,batchSequence,checksum`, never content. `batchId`
  and `batchSequence` come from the unique retained batch-item row for that
  message in this turn, or are both null when no such row exists.
  `batchTombstoneCount` counts retained v2 batches and
  `batchTombstoneCommitment` hashes canonical
  `{auditVersion:'legacy-turn-batches-v1',turnId,batches}`. Each sorted batch
  entry contains exactly `turnId,batchId,characterId,sourceMessageId,startedAt,`
  `committedAt,checksum,itemCount,itemCommitment`; `itemCommitment` hashes
  canonical `{auditVersion:'legacy-turn-batch-items-v1',turnId,batchId,items}`
  where `items` is the ordered array of closed tuples
  `sequence,messageId,checksum`. Protocol v1 has an empty
  batch set and the fixed canonical empty commitment. The transaction retains
  the batch/item identities, ordinals and original checksums, sets every item
  `message_json=NULL,redacted_at=appliedAt`, and writes the existing batch
  `item_count/tombstone_commitment`; it never deletes the batch authority.
  Reopen recomputes both audit commitments from the retained empty-content
  message rows and batch/item tombstones and rejects a missing, extra, foreign,
  reordered or restored projection.
- Before clearing a legacy delivery payload/checksum, freeze the complete target
  set into that audit. Validate this closed source matrix before the first write:
  `waiting` has null payload/checksum/relay/delivered/confirmed and zero attempts;
  `pending` has canonical payload whose SHA-256 is the stored checksum, null
  delivered/confirmed times and non-negative attempts; `mailboxed` adds a positive
  delivered time and null confirmed time; historical `delivered` has a positive
  delivered time and permits a null or positive confirmed time; `confirmed` has
  both times positive. Every prepared state has a
  non-empty lowercase checksum; its audit `originalChecksum` equals that value;
  a retained relay ID is either null or exactly
  `stableId('relay_pc', turnId + ':' + peerId + ':' + checksum)`. An unknown state,
  waiting row with prepared data, prepared row with missing/non-canonical payload
  or checksum, impossible time shape, foreign group/commit authority, or mismatched
  relay rejects before mutation and cannot be washed into a valid audit.
- A valid `waiting` row becomes `redacted` with no relay ID, null request time,
  local acknowledgement at `appliedAt`, zero attempts and no delivery/confirmation
  time. A valid `pending`, `mailboxed`, `confirmed` or historical `delivered` row
  retains or deterministically derives the legacy relay ID
  `stableId('relay_pc', turnId + ':' + peerId + ':' + checksum)`, becomes
  `redaction_pending`, records `redaction_requested_at=appliedAt`, clears attempts,
  payload and checksum, and retains its original delivered/confirmed times for
  audit comparison. A stale legacy sender must re-read the turn and exact delivery
  state after clear; it may neither enqueue nor mark mailboxed. The retraction
  worker later consumes only the retained relay ID.
- The v15 reopen invariant validates every redacted authority-v0 turn against
  exactly one legacy audit and the applied v1 clear control: shell/time/role,
  original envelope hash, message/batch tombstones, absence of stages and semantic
  projections, exact delivery target set, audit count/commitment, relay identity,
  and redaction lifecycle. Deleted/extra/foreign delivery rows, duplicate audit,
  unknown audit keys, changed original state/time/relay/count/commitment, restored
  plaintext, or a recoverable/outbox-visible redacted turn fail closed. Exact clear
  replay returns the existing applied proof without appending another audit.
  Positive close/reopen and fault-rollback fixtures cover every legal source state,
  including historical `delivered` with `confirmedAt=null`.
  Authority-v0 has no visible group identity. Group-linked jobs, state and lane
  pointers for a clear that also affects authority-v1 data remain owned by the
  existing scoped redacted lineage/group validator, which runs in the same
  post-write and replay closure. The legacy loader must not invent a group for
  an authority-v0 turn or reject unrelated live authority-v1 group pointers.
- Add one store-owned scoped `loadValidatedLegacyTurnRedactionInternal(turnId)`
  that closes the turn shell, applied control, unique `legacy_turn_redaction`
  audit and exact delivery set without a full scan. Its validation evidence is
  internal and is not a caller-supplied capability: do not export a branding
  symbol or accept a shape-compatible token in `publicTurnStatus()`. Add
  store-owned `publicLegacyRedactedTurnStatusInternal(turnId)`, which calls the
  scoped loader and returns the fixed projection in the same trusted call. The
  standalone status projector rejects every redacted legacy turn before
  `reply_json/error_json` parsing; `envelope_json={"redacted":true}` alone is
  never sufficient. The store method returns one fixed non-semantic terminal
  redacted result, and LAN maps it to the same fixed
  HTTP 410 body used for canonical redaction. It must never surface `thinking`,
  fallback, route, stage, reply, action or error detail from a redacted v0 turn.
- After inserting the v1 clear control, but before commit, invoke the scoped RA0
  loader for every newly redacted legacy turn and the existing scoped RA1
  validator for every affected lineage/group. Exact-control and exact
  role/epoch replay fast paths run the same applied-closure validation before
  returning the persisted proof; they never trust the control row alone. Thus
  an audit, message/batch tombstone, delivery or authority shell corrupted in
  the same process is rejected on replay without requiring a database reopen.

**Evidence, memory, stance, constraint, and current-state pruning:**
- The turn/group scrub and the memory prune consume one store-owned,
  transaction-local affected-authority closure. Freeze it before the first
  mutation as a closed object containing sorted unique `turnIds,lineageKeys,`
  `groupIds,messageIds,actionIds`. Every ID comes from the already validated
  RA1 group/lineage closure or the validated RA0 turn/batch/message closure;
  callers, text matching, role-wide queries and model output cannot add IDs.
  This object is not added to either wire payload or the closed legacy
  redaction audit. The current turn/delivery implementation must expose this
  single helper to the later pruning phase in the same `BEGIN IMMEDIATE`, not
  rebuild a second affected set after plaintext has been erased.
- Add one store-owned evidence-source resolver. For an active user-derived
  fact it reads the closed `sourceMessageIds`, `sourceActionIds` and optional
  `evidenceAuthority.{authorityGroupIds,lineageKeys,commitChecksums}` from the
  persisted fact, resolves every source to its persisted message/action,
  turn, group, lineage and commit receipt, and returns `affected`, `surviving`
  or `unresolved`. If `evidenceAuthority` exists, it must equal the exact
  tuple derived from the resolved sources. Historical facts may omit that
  object only when their non-empty legacy source-message/action lists resolve
  completely; it is then derived, never guessed. An active user-derived fact
  with no source, a missing/foreign source, mismatched authority tuple, mixed
  role, or ambiguous public/private lane fails before the first clear write.
  Already archived legacy facts are not revived. Author/system/preset/global
  rows are recognized only by their closed persisted authority/source-config
  contract, not by free-form `origin` text.
- A sole-affected fact is converted by an exact old-checksum CAS into a
  non-semantic archived shell. Its exact SQL projection is
  `subject_id='__redacted__',predicate='redacted',object_json='null',`
  `evidence_mode='redacted',source_message_ids_json='[]',exact_quotes_json='[]',`
  `status='archived',confidence=0,origin='redacted',verified_at=NULL`; its
  `supersedes` and `created_at` identity/history values remain unchanged.
  `fact_json` is exactly the closed canonical object
  `{factId,characterId,status:'archived',redacted:true,redactedAt}` and the row
  `checksum` is the hash of that object, never the old semantic checksum.
  `listFacts()` recognizes only this exact shell as redacted and neither it nor
  a partial imitation is retrievable. One closed sync audit
  `fact_redaction_v1` retains exactly
  `controlId,roleId,factId,oldChecksum,newChecksum,redactedAt,replacementFactId`
  plus its audit-version field; it retains no subject, predicate, object,
  quote, action or source ID.
  A mixed-source fact first receives that same archived shell, then appends a
  deterministic replacement whose ID is derived from the old fact ID,
  control ID and surviving-evidence checksum using
  `stableId('fact_prune', oldFactId + ':' + controlId + ':' +
  survivingEvidenceChecksum)`, whose `supersedes` points to the old fact, and
  whose evidence/quotes/actions/authority tuple contains only surviving
  sources. The replacement keeps the old fact's semantic subject/predicate/
  object, status and confidence, sets `createdAt=redactedAt`, retains
  `verifiedAt` only when every surviving source remains verified, and receives
  the normal canonical fact checksum. The audit's `replacementFactId` is that
  ID or null for a sole-affected fact. Exact replay verifies the old shell,
  audit and replacement and performs no write. This is
  the only store-owned lifecycle path allowed to change an existing fact;
  normal `putFact` immutability remains unchanged. Constraint revisions and
  stance revisions use their existing append-only revision models instead of
  mutating historical semantic revisions.
- `listRetrievableFacts()` and retrieval ranking must call one store-owned
  authority-lifecycle validator, not only `suppressed_messages`. Any source
  whose turn/group/lineage is redacted, cancelled by the clear, unresolved or
  superseded is non-retrievable; action-only evidence is covered identically.
  Consolidation/retrieval workers re-run the same validator after claim and
  immediately before model invocation and commit. A clear racing an old
  worker lease therefore rejects the old completion and cannot recreate a
  fact from a cleared draft or cached snapshot.
- Rebuilding `cognitive_states` never retains a redacted `last_turn_id`. If a
  surviving authoritative turn exists, rebuild from the latest surviving
  authority in deterministic `(effectiveAt,turnId)` order. If none exists,
  persist one store-owned schema-v2 empty anchor rather than deleting the row:
  `last_turn_id=stableId('cognitive_clear_anchor', roleId + ':' + controlId)`,
  `last_authority_group_id=NULL`, and exact state
  `{fastState:{mood:'',openThreadIds:[],openThreads:[]},mediumState:{},`
  `slowState:{preferenceFactIds:[]}}`. Its checksum is the canonical state
  hash, revision is the prior revision plus one (or one if no prior row), and
  `updated_at=appliedAt`. Exact clear replay does not increment it. The v15
  reopen invariant accepts that otherwise-non-turn anchor only when its ID,
  time, checksum and role match the latest applied clear control; every normal
  state still requires a real surviving turn/group. A later committed turn
  advances from the anchor revision normally, preserving monotonic history.
- Perform this only after all affected canonical and legacy turn shells are
  valid. Delete or archive a fact, stance or user-derived constraint only when
  every persisted supporting message/turn/group belongs to the affected set.
  Mixed-source records retain only surviving evidence and receive a recomputed
  canonical checksum/revision. Author/system constraints, preset/persona source
  records, global release definitions and unrelated-role rows are immutable to
  conversation clear.
- Cancel pending consolidation/retrieval jobs whose input authority was cleared;
  no cleared draft, unconfirmed output or redacted evidence may remain
  retrievable. Rebuild the role's current cognitive-state projection from the
  surviving authority rows in deterministic order, preserving its monotonic
  revision while removing redacted `last_turn_id`, authority-group references,
  open threads and user-derived state. A fault after pruning or rebuild rolls the
  entire clear transaction back, including all turn redactions and the control.
- Tests must cover sole-source deletion, mixed-source evidence pruning,
  author/system preservation, unrelated-role byte equality, no retrieval of
  cleared content, deterministic restart rebuild, and every new write boundary.

**Retraction worker:**
- `ResultOutbox.flushRetractionsOnce(limit)` runs before normal sends and only
  selects `redaction_pending`, then explicitly dispatches either a scoped RA1
  group-redaction validator or the scoped RA0 `legacy_turn_redaction` validator.
  A null-group row without the exact RA0 audit, a grouped row without RA1
  authority, or any cross-version mixture fails closed; state alone is never the
  authority discriminator. The worker uses the validator-returned retained relay
  ID to call idempotent `/bridge/ack`; missing/already-removed ciphertext counts as
  success. It marks `redacted` only by exact turn/peer/relay/request-time/state CAS
  and records `redaction_acknowledged_at`; it never reconstructs payload. Network
  failure remains durable; authority failure is quarantined and surfaced, never
  sent through legacy.
- A stale outbox snapshot revalidates after concurrent clear/redaction. It may
  not reconstruct payload, send a redacted result, append semantic diagnostic,
  or alter Task 20's redaction lifecycle.

- [ ] **20D.1: Add red validator, transaction fault matrix, legacy scrub,
  retraction, duplicate/control-race, relay atomic exchange, and LAN/cloud ACK
  tests.**
- [ ] **20D.1a: Add the v14→v15 red migration/reopen/fault matrix before the
  first production clear write.** Cover a populated v14 audit shell without
  fabricating peer/cursor semantics, a fresh authority-v1 row, exact replay,
  every scalar/JSON/checksum mutation, partial v1 rows, v0/v1 collision, all
  migration fault checkpoints, and `>15` refusal. Update the v10/v13/v14
  invariant version domains explicitly; do not weaken their historical checks.
- [ ] **20D.2: Implement the one store transaction and one retraction worker.**
- [ ] **20D.3: Run focused and reopen gates, then commit.**

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs tests/yuqi-relay-worker.test.mjs
git add yuqi-runtime/src/protocol.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/local-server.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/src/result-outbox.mjs yuqi-relay-worker.js yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs tests/yuqi-relay-worker.test.mjs
git commit -m "feat: apply distributed conversation clear authority"
```

Stop after this commit for independent review.

#### Task 20E: Web integration, role deletion, and verified backup/restore

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tests/test-basic.test.mjs`
- Modify: `tests/yuqi-memory-backup.test.mjs`
- Modify: `package.json`
- Modify: `scripts/backup-yuqi-memory.mjs`
- Modify: `scripts/audit-yuqi-memory.mjs`
- Create: `scripts/restore-yuqi-memory.mjs`
- Create: `tests/yuqi-memory-lifecycle.test.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/RoleNotificationCancellationEntity.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/test/agency-data-lifecycle.test.mjs`

**Web clear:**
- In the Android app, `clearCurrentChat()` first awaits the native Room-v13
  transaction and receives its immutable control. Only then may it remove Web
  messages/moments/view caches. If the plugin call suspends, fails, or the page
  reloads, the UI remains intact or visibly pending; it never reports success
  from localStorage alone.
- In a non-native desktop browser, the equivalent authenticated PC control must
  commit before local deletion. Clearing all roles serializes per-role controls;
  it does not launch overlapping `Promise.all` calls against one authority DB.
- Event/poll/reload reconciliation checks Room clear epoch before DOM insert.
  Old results are relay-ACKed but never rendered, notified, or marked UI-applied.

**Role deletion:**
- `role_delete_v1` uses the same Android lifecycle outbox/lease/PC-applied ACK
  path, but has a distinct closed checksum schema and no sequence boundary.
- Its wire object has exactly `protocolVersion,type,controlVersion,controlId,`
  `roleId,peerId,requestedAt,backupReceipt,checksum`, with native types,
  `protocolVersion=3`, `type=ROLE_DELETE`, and
  `controlVersion=role_delete_v1`. `backupReceipt` has exactly
  `receiptVersion,receiptId,roleId,manifestChecksum,snapshotSha256,`
  `logicalChecksum,createdAt,receiptChecksum`; its version is
  `yuqi-backup-receipt-v1` and both checksums are recomputed. `controlId` is
  `ctl_` plus the SHA-256 of exact canonical
  `{contract:'android-lifecycle-control-id-v1',controlKind:'role_delete_v1',`
  `roleId,peerId,requestedAt,backupReceiptChecksum}` where the final field equals
  `backupReceipt.receiptChecksum`; the outer checksum covers the complete closed
  object except itself. `/v3/controls/role-delete` and cloud use the same
  validator and the same atomic relay ACK-with-response contract as clear.
- `LifecycleControlEntity.semantic_json` persists this full object. No backup
  receipt may exist only in a Web promise, request body, or log message.
- The operation is allowed only after a verified backup receipt is attached.
  PC creates that receipt by appending exactly one
  `sync_log(entity_type='backup_receipt',entity_id=receiptId,operation='create')`
  whose canonical payload/checksum equals the receipt. It survives role deletion
  and exact replay. Role-delete validation joins this immutable audit and
  rejects a missing, changed, foreign-role, duplicate, or postdated receipt
  before any role row changes.
  Android tombstones and removes role-scoped Room data in one transaction while
  retaining the non-semantic control audit. PC verifies the backup receipt,
  redacts/retracts all role chat first, then deletes role-scoped constraint,
  stance, state, memory, plan, lane, rollout and authority rows in FK-safe order;
  global releases remain. A closed `role_deletion` sync audit keyed by controlId
  is the idempotency proof after role rows are gone. Exact replay returns the
  proof; changed replay conflicts. Neither endpoint physically deletes audit or
  control proof.
- Role deletion is a two-phase authority lifecycle; it is never implemented as
  one eager series of `DELETE` statements. In the first immediate transaction,
  PC validates the exact `backup_receipt` and appends exactly one closed
  `role_deletion_request` sync audit keyed by `controlId`. That durable request
  immediately freezes the role against every new direct, automatic, retry and
  life-planning turn. A resumable follow-up transaction then applies the existing
  canonical/legacy redaction machinery to all role conversations. A crash between
  these transactions is safe: restart sees the request, keeps the role frozen and
  resumes redaction; it never treats the request alone as applied deletion. Every
  already-enqueued PC-to-phone delivery keeps its immutable remote relay identity
  and enters the existing retraction lifecycle. The request audit is the
  restart-stable phase source; exact replay resumes it and a changed control
  conflicts before any write.
- The first phase returns a stable pending result while any role delivery is
  `redaction_pending`. LAN returns HTTP 202 with the closed pending projection;
  cloud deliberately does not ACK the incoming role-delete control yet, so the
  relay retries the same immutable control. This is safe because the PC relay
  loop drains outbound retractions before polling inbound controls. Pending is
  not success: Android keeps the lifecycle control and role tombstone, and the
  Web UI must not remove the visible role merely because phase one committed.
- After every role retraction is durably acknowledged, an exact replay performs
  phase two in one immediate transaction. It revalidates the request and backup
  audits, proves that no pending/outbound role delivery remains, then deletes
  every role-scoped PC row and child projection in FK-safe order. It retains the
  immutable `backup_receipt`, `role_deletion_request`, and final
  `role_deletion` audits, but no message, action, memory, evidence, state,
  stance, plan, lane, lineage, delivery, diagnostic, comparison or semantic
  redaction row for the deleted role. Global release definitions remain.
- The closed pending projection has exactly
  `protocolVersion,type,controlId,controlChecksum,roleId,peerId,state,`
  `pendingRetractions,requestedAt,checksum`; `type` is
  `ROLE_DELETE_PENDING`, `state` is `pending_retractions`, and the final applied
  projection remains the exact nine-key `ROLE_DELETE_APPLIED` contract. Both are
  computed solely from persistent audit/delivery state. Cloud ACK-with-response
  occurs only for final applied replay; LAN 202 pending never fabricates an
  Android applied ACK.
- The retained Android `role_delete_v1` lifecycle control is the local
  tombstone after application. Any late LAN/cloud turn, reply, result, action,
  notification, UI inbox item or Room recovery row for that role is relay-ACKed
  when applicable but suppressed before Room/Web recreation. Backup receipt,
  request/final audits and the Android tombstone are metadata-only and must not
  retain role chat or memory semantics.
- Android Room schema 15 is reached only through registered
  `MIGRATION_14_15`; fresh databases create the same v15 schema. Populated v14
  rows migrate unchanged, every migration fault rolls back, and a database
  newer than v15 is rejected rather than silently downgraded or repaired. Room
  v15 adds one transient, metadata-only
  `role_notification_cancellations` outbox. Role deletion computes the distinct
  deterministic notification IDs for the role's turns and inserts exact
  `waiting` cancellation intents in the same Room transaction that inserts the
  lifecycle tombstone and deletes role semantics. That transaction never calls
  `NotificationManager`: a later injected fault must roll back the control,
  deletion and cancellation intents with zero external cancellation. Only after
  commit may the plugin/service drain the intents by invoking `cancel(id)` and
  then exact-CAS removing/completing that intent. A crash after `cancel` but
  before CAS retries the same ID idempotently; a thrown cancellation retains the
  intent. Service startup and lifecycle wakes drain the same durable queue, so
  recovery does not depend on the original Web promise or process. The table
  contains no turn text, notification content, chat payload, memory, or action,
  and successful drain leaves no cancellation row behind; the lifecycle control
  remains the only durable role-deletion tombstone.
- The table shape is exact:
  `cancellation_key TEXT PRIMARY KEY, control_id TEXT NOT NULL, character_id TEXT`
  ` NOT NULL, notification_id INTEGER NOT NULL, intent_checksum TEXT NOT NULL,`
  ` state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`,
  with a unique index on `(control_id,notification_id)`. State is exactly
  `waiting`; successful completion deletes the row, so no second terminal state
  is invented. All strings are native non-empty canonical identities,
  notification IDs are native Android integers in the deterministic message
  notification range, and times are positive native safe integers with
  `updated_at>=created_at`. `intent_checksum` is SHA-256 of canonical JSON
  `{contract:'android-role-notification-cancellation-v1',controlId,characterId,`
  `notificationId,createdAt}` and `cancellation_key` is `rncan_` plus that full
  lowercase checksum. Every list/drain/reopen joins exactly one retained
  `role_delete_v1` lifecycle control with matching `control_id` and
  `character_id`, then recomputes the key/checksum before any external cancel.
  Missing, foreign, duplicate or corrupt control/intent sets fail closed with
  zero cancellation and zero row mutation.
- After `cancel(notificationId)` returns, completion deletes only the exact
  snapshot matching `cancellation_key,control_id,character_id,notification_id,`
  `intent_checksum,state,created_at,updated_at`. Concurrent drainers may repeat
  the same idempotent Android cancel, but only one exact delete succeeds; a
  stale snapshot can never complete or cancel a changed/foreign intent. An
  already-absent exact intent is an idempotent completed outcome only after the
  role-delete control remains valid. Service startup drains and validates this
  outbox immediately after opening Room and before ordinary turn recovery,
  completed-turn events/notifications, continuation scheduling, or lifecycle
  delivery. Every lifecycle wake repeats that ordering. A corrupt pending set
  blocks deleted-role side effects and is surfaced as an authority conflict;
  it is never ignored in order to continue ordinary notification work.
- Tests must cover first-phase restart, exact pending replay, changed replay,
  new-turn rejection during pending/applied deletion, waiting and already
  mailboxed deliveries, redaction acknowledgement before finalization, final
  fault rollback at every write boundary, exact applied replay, two concurrent
  finalizers, and close/reopen proof that only the three allowed metadata audits
  remain. They must also prove that a stale outbox snapshot cannot enqueue or
  quarantine a delivery after the role-deletion phase changes.
  Android tests additionally cover populated Room 14→15 and fresh-15 schema,
  rollback with zero external cancellation at every post-intent failure point,
  successful post-commit cancellation, cancellation failure/retry, and
  close/reopen compensation before any deleted-role notification can survive.

**Backup/restore:**
- Role deletion first calls authenticated LAN
  `POST /v3/backups/yuqi` with the closed request
  `{protocolVersion:3,type:'YUQI_BACKUP_REQUEST',requestVersion:'yuqi-backup-request-v1',`
  `roleId,peerId,requestedAt,androidRoomHead,checksum}`. `androidRoomHead` is
  required for an Android-initiated role-deletion backup and is null only for a
  desktop/CLI capture. The endpoint invokes the exported
  `createVerifiedYuqiBackup()` implementation, appends the immutable
  `backup_receipt` audit, and returns that receipt. No Room/Web role row is
  deleted before this response is durably stored in `semantic_json`. If PC is
  offline or backup verification fails, role deletion is blocked; Task 20 does
  not pretend an unverified phone-only export protects the PC authority DB.
- Backup uses a transactionally consistent SQLite snapshot and writes the exact
  closed `yuqi-backup-manifest-v1` object with keys
  `manifestVersion,createdAt,schemaVersion,snapshotSha256,logicalChecksum,`
  `tableRowCounts,roleLifecycleHeads,redactedInvariantSummary,androidRoomHead,`
  `manifestChecksum`.
  Object keys and each role/table array are canonically sorted; the final field
  is SHA-256 over the other fields. This is a content-addressed integrity
  manifest, not a claim of public-key authenticity: no unspecified signing key
  or algorithm may be invented. Trust comes from the local protected database,
  authenticated bridge, and the immutable `backup_receipt` audit. It includes
  Room schema/cursor/control-head export metadata when initiated from the app.
  Plain “VACUUM INTO succeeded” is not acceptance.
- `restore-yuqi-memory.mjs` restores only into a clone, runs schema migration and
  full restart invariants there, and atomically replaces the target only after
  all checks pass and an explicit backup of the current target exists. Import
  never row-merges two independent authority histories. Newer local release
  registration is preserved only by an explicit validated overlay step; the
  default is full-snapshot restore.
- Clear→backup→restore→restart must remain cleared. A pre-clear backup restored
  deliberately must restore its pre-clear history and its older clear cursor as
  one coherent snapshot; it may not merge with newer relay/control state.

**Exact backup artifact and receipt contract (20E authority amendment):**
- One capture owns one native-safe-integer `createdAt`. It first checkpoints the
  source, writes a `VACUUM INTO` snapshot, closes the source handle, and then
  derives every manifest field from the immutable snapshot file rather than
  rereading the live database. The verified role-delete artifact is stored in
  `snapshots/verified/<receiptId>/` as exactly `snapshot.sqlite` and
  `manifest.json`; ordinary rotating snapshots never prune a verified directory
  referenced by a `backup_receipt` audit.
- `tableRowCounts` is a table-name-sorted array of exact objects
  `{tableName,rowCount}`. `logicalChecksum` is SHA-256 of UTF-8 canonical JSON of
  `{contract:'yuqi-backup-logical-v1',schemaVersion,tables}`. `tables` is sorted
  by `tableName`; each entry is exactly `{tableName,createSql,rows}`. Every row is
  encoded as an array in `PRAGMA table_info` column order. Each SQLite cell is
  one closed tagged object: `{type:'null'}`, `{type:'integer',value:'<decimal>'}`,
  `{type:'real',value:'<SQLite quote() text>'}`, `{type:'text',value:'<text>'}` or
  `{type:'blob',value:'<lowercase hex>'}`. Rows sort by their canonical tagged
  representation and duplicates remain duplicated. This makes null/text/blob,
  integer width, row order and duplicate rows unambiguous across Node versions.
- `roleLifecycleHeads` is a role-id-sorted array. Every entry is exactly
  `{roleId,clearHead,laneHeads,lineageHeads}`. `clearHead` is null or the highest
  clear epoch projected as
  `{controlId,clearEpoch,clearedThroughSequence,appliedAt,checksum}`.
  `laneHeads` sorts by `laneKey` and contains exactly
  `{laneKey,revision,clearEpoch,clearedThroughSequence,lastCommitChecksum}`.
  `lineageHeads` sorts by `lineageKey` and contains exactly
  `{lineageKey,laneKey,latestTurnId,revision,state,committedGroupId,redactedAt}`.
  Roles are the sorted union present in controls, lanes and lineages; no current
  UI character list is allowed to hide an authority-bearing role.
- `androidRoomHead` is null for a desktop/CLI capture. For an Android-initiated
  capture it is the exact closed object
  `{headVersion,roleId,roomSchemaVersion,cursor,lifecycleHead,capturedAt,checksum}`.
  `headVersion` is `android-room-backup-head-v1`; roleId must equal the requested
  backup role; schema/capture values are native safe integers; checksum hashes
  the other six fields. `cursor` is exactly
  `{characterId,nativeCompletedTurnId,nativeCompletedGroupId,`
  `nativeCompletedSequence,uiAppliedTurnId,uiAppliedGroupId,uiAppliedSequence,`
  `localSequence,clearedThroughSequence,clearEpoch,clearedAt,chatOpen,updatedAt,`
  `cursorChecksum}`. Its IDs, sequence order and native types are validated and
  `cursorChecksum` is recomputed from the existing
  `conversation-cursor-clear-v1` basis. `lifecycleHead` is null or exactly
  `{controlId,controlKind,peerId,state,semanticChecksum,clearEpoch,`
  `clearedThroughSequence,requestedAt,appliedAt,updatedAt}`. Kind is clear/delete,
  state is one of waiting/pending/relay_accepted/applied/quarantined, clear fields
  are present only for clear, and appliedAt is present only for applied. This is
  authenticated Room head metadata for deletion/restore diagnostics, not a claim
  that the PC SQLite snapshot contains or can independently restore Room rows.
- `redactedInvariantSummary` is exactly
  `{legacyRedactedTurns,redactedLineages,redactedGroups,authorityRedactionAudits,`
  `agencyRedactionAudits,factRedactionAudits,factRedactionSetAudits}` with native
  non-negative safe-integer counts read from the snapshot after a disposable
  clone successfully opens through the full `YuqiStore` restart invariant. It
  is an inspection summary, not a substitute for that invariant.
- `manifestChecksum` is SHA-256 of canonical JSON of the other nine manifest
  fields. `snapshotSha256` hashes the closed snapshot bytes before any validator
  opens a copy. Creation succeeds only when a fresh disposable copy passes
  snapshot SHA, logical checksum, manifest checksum, schema and complete restart
  invariants. The original snapshot bytes must remain unchanged by verification.
- A receipt is created only after that verification. `receiptId` is `bkrcpt_`
  plus the first 24 lowercase hex characters of SHA-256 over canonical
  `{contract:'yuqi-backup-receipt-id-v1',roleId,manifestChecksum,snapshotSha256,`
  `logicalChecksum,createdAt}`. `receiptChecksum` hashes the other seven exact
  receipt fields. In one immediate transaction, PC rejects any foreign or
  changed row and appends exactly one canonical
  `sync_log('backup_receipt',receiptId,'create')`; only that committed row may be
  returned to Android. A crash before the audit may leave an orphan verified
  directory, but it cannot authorize role deletion.
- Verification and restore accept only a manifest and snapshot from the same
  verified directory. They reject symlinks, path escape, extra manifest keys,
  unsafe numbers, changed schema/count/head/summary/logical hashes, and any byte
  mismatch before touching the target. The backup snapshot itself is never
  migrated in place.
- Restore requires the runtime to be stopped. It checkpoints the target, refuses
  a non-empty live WAL, creates and verifies a separate pre-restore protected
  backup, copies the requested snapshot to a sibling `restore-ready` file, opens
  only that copy through migration and full restart invariants, closes it, then
  replaces the target on the same volume. `-wal`/`-shm` files cannot be carried
  across histories. It reopens and revalidates the replaced target; on failure it
  restores the verified pre-restore snapshot. A report records source manifest,
  pre-restore receipt, pre/post schema and logical checksums. No row merge or
  release overlay occurs unless a later separately specified command requests it.

- [ ] **20E.1: Add red native-first UI, plugin suspension/reload, role-delete,
  closed receipt/audit, backup manifest vectors, corrupt restore, and
  clear/restore/restart tests.**
- [ ] **20E.2: Implement Web/native integration, role-delete control, and
  clone-first restore.**
- [ ] **20E.3: Run the complete Task 20 gate once and commit.**

```powershell
node --test yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/memory-authority-v3.test.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/store-visible-authority-v13.test.mjs yuqi-runtime/test/store-release-authority-v14.test.mjs tests/yuqi-ui-contract.test.mjs tests/test-basic.test.mjs tests/yuqi-memory-lifecycle.test.mjs
cd android
.\gradlew.bat testDebugUnitTest --no-daemon --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
adb devices -l
.\gradlew.bat connectedDebugAndroidTest --no-daemon --no-problems-report
cd ..
node scripts/backup-yuqi-memory.mjs yuqi-runtime/config.json --verify
node scripts/audit-yuqi-memory.mjs yuqi-runtime/config.json
npm.cmd test
git diff --check
```

Expected: every focused gate and full regression passes; connected Android tests
pass on a real attached device; no semantic field survives a clear tombstone;
no cleared evidence is retrievable; every relay retraction and lifecycle control
survives restart; and backup restore proves both live and redacted authority.

```powershell
git add tavern-app/index.html tests/yuqi-ui-contract.test.mjs tests/test-basic.test.mjs scripts/backup-yuqi-memory.mjs scripts/audit-yuqi-memory.mjs scripts/restore-yuqi-memory.mjs tests/yuqi-memory-lifecycle.test.mjs android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java yuqi-runtime/src/protocol.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/local-server.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs
git commit -m "feat: complete Yuqi data lifecycle"
```

### Task 21: Separate Protocol Regression From Source-Grounded Human Quality Scenes

**Files:**
- Move: `tests/fixtures/yuqi-cognition-replay-v1/` → `tests/fixtures/yuqi-cognition-protocol-v1/`
- Modify: `scripts/generate-yuqi-replay-fixtures.mjs`
- Modify: `scripts/run-yuqi-cognition-replay.mjs`
- Modify: `scripts/report-yuqi-cognition-replay.mjs`
- Modify: `yuqi-runtime/src/replay-runner.mjs`
- Modify: `yuqi-runtime/test/replay-runner.test.mjs`
- Create: `tests/fixtures/yuqi-lived-quality-v1/manifest.json`
- Create: `tests/fixtures/yuqi-lived-quality-v1/sentinel-seeds.jsonl`
- Create: `tests/fixtures/yuqi-lived-quality-v1/coverage-scenes.jsonl`
- Create: `tests/fixtures/yuqi-lived-quality-v1/sources.json`
- Create: `scripts/compile-yuqi-lived-quality-scenes.mjs`
- Create: `scripts/extract-yuqi-real-history-scenes.mjs`
- Create: `tests/yuqi-lived-quality-contract.test.mjs`
- Create: `tests/yuqi-real-history-extractor.test.mjs`
- Modify: `.gitignore`
- Read: `preset-references/真人聊天训练批注-第一轮.md`
- Read: `preset-references/真人聊天训练批注-第二轮.md`
- Read: `preset-references/真人聊天训练批注-第四轮-交接.md`

**Interfaces:**
- Consumes: existing 270 protocol cases, three human annotation files, known production failures, local history database.
- Produces: 270-case `protocol-v1`; 24 committed sentinel seeds; 72 committed coverage scenes; 30 local-only real-history scenes.

- [ ] **Step 1: Write red suite-purpose, count, provenance, and scene-depth tests**

```js
test('protocol suite contains 270 cases but makes no human-quality claim', () => {
  const manifest = readJson('tests/fixtures/yuqi-cognition-protocol-v1/manifest.json');
  assert.equal(manifest.suitePurpose, 'protocol_regression');
  assert.equal(manifest.caseCount, 270);
  assert.equal(manifest.qualityEvidenceEligible, false);
});

test('human quality suite has exact source-grounded counts and complete annotations', () => {
  const suite = compileQualitySuite({ rootDir: process.cwd(), checkOnly: true });
  assert.equal(suite.sentinelSeeds.length, 24);
  assert.equal(suite.coverageScenes.length, 72);
  for (const scene of [...suite.sentinelSeeds, ...suite.coverageScenes]) {
    assert.ok(scene.turns.length >= 4 && scene.turns.length <= 12);
    assert.ok(scene.mustNotice.length);
    assert.ok(scene.allowedDecisionRange.length);
    assert.ok(scene.forbiddenFailurePatterns.length);
    assert.ok(scene.requiredActionIntegrity);
    assert.ok(scene.allowedPersonalityVariation.length);
    assert.ok(scene.expectedStateTransitions);
    assert.ok(scene.forbiddenStateTransitions);
    assert.ok(scene.sourceAnnotation.file);
    assert.ok(scene.sourceAnnotation.heading);
    assert.ok(['critical', 'high', 'medium'].includes(scene.severity));
    assert.doesNotMatch(JSON.stringify(scene), /脱敏测试消息\s*\d+/);
  }
});

test('each sentinel has three independently authored structural variants', () => {
  const suite = compileQualitySuite({ rootDir: process.cwd(), checkOnly: true });
  for (const seed of suite.sentinelSeeds) {
    const variants = suite.coverageScenes.filter(scene => scene.parentSentinelId === seed.sceneId);
    assert.deepEqual(variants.map(x => x.variantKind).sort(),
      ['delayed_or_interrupted', 'feature_coupled', 'surface_rewording']);
    assert.equal(new Set(variants.map(x => contentHash(x.turns))).size, 3);
  }
});
```

- [ ] **Step 2: Run quality contract tests red**

Run: `node --test tests/yuqi-lived-quality-contract.test.mjs yuqi-runtime/test/replay-runner.test.mjs`

Expected: FAIL because suite separation and source-grounded files do not exist.

- [ ] **Step 3: Relabel the existing suite and prevent replay/live counter mixing**

Use `git mv` for the fixture directory. Change its manifest to:

```json
{
  "schemaVersion": 2,
  "suiteId": "yuqi-cognition-protocol-v1",
  "suitePurpose": "protocol_regression",
  "qualityEvidenceEligible": false,
  "caseCount": 270,
  "rolloutKeys": {
    "DIRECT_REPLY": 30,
    "ROLE_PLAN_CHAT": 30,
    "ROLE_PLAN_MOMENT": 30,
    "ROLE_PLAN_CHAT_PRIVATE": 30,
    "ROLE_PLAN_MOMENT_PRIVATE": 30,
    "PROACTIVE_CHAT": 30,
    "PROACTIVE_MOMENT": 30,
    "MOMENT_INTERACTION": 30,
    "MOMENT_REPLY": 30
  }
}
```

The replay runner writes the existing closed-enum value `cognition_replay_runs.source_type='approved_fixture'` (the database authority name for an approved protocol fixture); local history writes `source_type='local_history'`. Batch summaries and provenance may use the shorter semantic label `fixture`, but no second synonymous database enum is introduced. Neither code path may call `putCognitionShadowRunInternal()` or increment rollout live counters.

- [ ] **Step 4: Author the exact 24 sentinel IDs and 72 independent variants**

The 24 sentinel IDs and source coverage are fixed:

```json
[
  "first_sleep_deprived_still_working",
  "first_i_miss_you",
  "first_fear_of_being_annoying",
  "first_red_packet_as_social_action",
  "first_scolded_by_manager",
  "first_apology_after_sharp_words",
  "first_initial_stage_not_fixed_coldness",
  "second_one_day_no_contact",
  "second_proactive_before_presentation",
  "second_role_has_no_energy",
  "second_after_user_disagrees",
  "second_jealousy_without_label",
  "second_proactive_seen_next_day",
  "second_interruption_changes_with_time",
  "fourth_push_away_and_want_pursuit",
  "fourth_joke_contains_serious_request",
  "fourth_coquetry_test_or_pressure",
  "fourth_whatever_meaning_split",
  "fourth_topic_shift_meaning_split",
  "fourth_repeated_question_fact_or_attitude",
  "fourth_equality_and_special_priority",
  "fourth_rejecting_insincere_comfort",
  "fourth_self_deprecation_meaning_split",
  "fourth_silence_meaning_split"
]
```

Each JSONL scene uses:

```json
{
  "sceneId": "first_red_packet_as_social_action",
  "rolloutKey": "DIRECT_REPLY",
  "initialState": {
    "relationship": {"base": "familiar", "phase": "normal"},
    "lifeSignals": [],
    "currentStances": [],
    "verifiedFacts": []
  },
  "turns": [
    {"at": "2026-07-01T20:00:00+08:00", "speaker": "user",
     "batch": [{"messageId": "u1", "type": "text", "text": "今天辛苦了"}]},
    {"at": "2026-07-01T20:00:20+08:00", "speaker": "assistant",
     "batch": [{"messageId": "a1", "type": "text", "text": "刚收完店，手都是凉的"}]},
    {"at": "2026-07-01T20:01:00+08:00", "speaker": "user",
     "batch": [{"messageId": "u2", "type": "payment", "amount": 50, "text": "给你买杯热的"}]},
    {"at": "2026-07-01T20:01:05+08:00", "speaker": "system", "event": "candidate_response"}
  ],
  "mustNotice": ["payment is also a care bid in the current relationship"],
  "allowedDecisionRange": ["accept warmly", "accept with reserve", "decline without erasing the care bid"],
  "forbiddenFailurePatterns": ["treat ordinary gifting as inherently improper", "turn a soft stance into a permanent rule", "drop the care bid"],
  "requiredActionIntegrity": {"paymentTargetMustMatch": "u2"},
  "allowedPersonalityVariation": ["warm", "teasing", "reserved", "brief"],
  "expectedStateTransitions": {"allow": ["create", "maintain", "soften", "reverse"]},
  "forbiddenStateTransitions": {"hardConstraintFromYuqiPreference": true},
  "sourceAnnotation": {"file": "真人聊天训练批注-第一轮.md", "heading": "发红包"},
  "severity": "critical"
}
```

The other 23 seeds must be authored from their named source headings with original multi-turn context, not copied generic text. Each gets three separately written 4–12 turn variants: surface rewording, delayed/interrupted chronology, and a feature-coupled version using one relevant structured feature. The compiler checks unique turn checksums, source heading existence, complete annotation fields, TurnKind distribution, payment/moment/plan target validity, and public privacy.

Across the 72 coverage scenes, the compiler enforces these minimums: `DIRECT_REPLY ≥ 18`, `PROACTIVE_CHAT ≥ 6`, `PROACTIVE_MOMENT ≥ 6`, `MOMENT_INTERACTION ≥ 6`, `MOMENT_REPLY ≥ 6`, each of the four role-plan TurnKinds `≥ 4`, and `LIFE_PLANNING ≥ 4`. One scene may cover only one primary rollout key; counts cannot be inflated by aliases.

- [ ] **Step 5: Extract verified candidates, then label 30 local real-history scenes without committing private content**

The extractor takes an explicit absolute `--database` path to a frozen PC v15
authority snapshot. Raw v0/v10/v13/v14 (or any version below v15) input fails
closed before output and is never migrated; the extractor must not invent
authority for legacy turns. It must use SQLite read-only mode directly: it may
not load `yuqi-runtime/config.json`, construct `YuqiStore`, migrate the source,
change journal mode, or create production release/shadow rows. Before and after
the read it verifies the main database plus non-empty WAL/rollback-journal
content; process-local SHM lock bytes are excluded from source identity.

Only closed, canonical `DIRECT_REPLY` authority lineages are eligible. The
read-only validator covers the complete v13/v14/v15 closure: lineage/root/retry
and revision, canonical turn/envelope and message identity/checksums,
current-user batch/items, visible group/items/actions, manifest/receipt,
release pins, interaction lane/cursor, redaction state, and v15 clear-control
schema. It validates the root attempt, retry chain/cycle closure, latest member,
role/device/source ownership and all persisted checksums. It aggregates windows
of 2–6 complete persisted exchanges (4–12 ordered turns) from persisted user batches/messages and committed
visible result items/actions on the same role and lane; it never reads
`reply_json`, annotation snapshots, or guesses structure from keywords.

The first stage emits only private candidate JSONL. Every candidate is a closed
`{windowId,sourceWindowChecksum,role,lane,timeBounds,turns,persistedContextProjection}`
projection; identifiers are deterministically replaced while user-visible
semantic text is preserved locally. A second, independent `--labels <absolute
private JSONL>` sidecar is the sole source of `initialState`, Task 22 evaluation
annotations, nine-category structure, and severity. Labels must bind the exact
candidate window/checksum and annotator version, and may not contain or replace
turns/actions. Without labels no final scenes are generated. With labels, the
extractor requires exactly 30 unique windows and complete coverage of all nine
structures, then writes the closed final scenes. Missing/stale/duplicate/unknown
labels fail closed. A migration clone is validation-only and cannot invent
legacy authority or serve as a 30-scene source.

Output is a closed Task 22 scene projection: unknown fields, speakers,
structures, nested state, attachments, actions, or severity values fail the
whole extraction instead of being copied or guessed.

Publish `real-history-scenes.jsonl` together with
`real-history-scenes.manifest.json` under
`artifacts/yuqi-lived-agency-v3/private/`. The manifest binds the ordered scene
IDs and SHA-256 generation checksum. Both files are staged and verified before
publication, with backup rollback on a publication error; readers reject a
missing or mismatched pair (the two-file rename is not claimed crash-proof).
The private directory
remains ignored and no raw private content is committed or copied into public
reports.

- [ ] **Step 6: Compile and verify both suites**

Run:

```powershell
node scripts/compile-yuqi-lived-quality-scenes.mjs --check
node scripts/extract-yuqi-real-history-scenes.mjs --database <absolute-v15-authority-snapshot> --limit 30 --out artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl --manifest artifacts/yuqi-lived-agency-v3/private/real-history-scenes.manifest.json
node scripts/extract-yuqi-real-history-scenes.mjs --database <absolute-v15-authority-snapshot> --labels <absolute-private-history-labels.jsonl> --limit 30 --out artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl --manifest artifacts/yuqi-lived-agency-v3/private/real-history-scenes.manifest.json
node --test tests/yuqi-lived-quality-contract.test.mjs tests/yuqi-real-history-extractor.test.mjs yuqi-runtime/test/replay-runner.test.mjs
npm run cognition:replay
npm run cognition:replay-report
```

Expected: 270 protocol cases PASS; 24 sentinel and 72 coverage scenes validate; the first extraction emits only private candidates, and exactly 30 final local-history scenes exist only when the independent labels sidecar passes; live shadow counts remain unchanged before/after these commands.

- [ ] **Step 7: Commit public suite and tooling only**

```powershell
git add tests/fixtures/yuqi-cognition-protocol-v1 tests/fixtures/yuqi-lived-quality-v1 scripts/generate-yuqi-replay-fixtures.mjs scripts/run-yuqi-cognition-replay.mjs scripts/report-yuqi-cognition-replay.mjs scripts/compile-yuqi-lived-quality-scenes.mjs scripts/extract-yuqi-real-history-scenes.mjs yuqi-runtime/src/replay-runner.mjs yuqi-runtime/test/replay-runner.test.mjs tests/yuqi-lived-quality-contract.test.mjs tests/yuqi-real-history-extractor.test.mjs .gitignore docs/superpowers/plans/2026-07-30-yuqi-lived-agency-v3.md
git commit -m "test: separate protocol and lived quality evidence"
```

### Task 22: Implement Repeated Blind Quality Evaluation and Hard Gates

**Files:**
- Create: `yuqi-runtime/src/quality-evaluator.mjs`
- Create: `yuqi-runtime/src/quality-replay.mjs`
- Modify: `yuqi-runtime/src/comparison-evaluator.mjs`
- Create: `yuqi-runtime/test/quality-evaluator.test.mjs`
- Create: `yuqi-runtime/test/quality-replay.test.mjs`
- Create: `yuqi-runtime/test/quality-report.test.mjs`
- Modify: `yuqi-runtime/test/comparison-evaluator.test.mjs`
- Create: `scripts/run-yuqi-lived-quality-replay.mjs`
- Create: `scripts/report-yuqi-lived-quality.mjs`
- Modify: `scripts/compile-yuqi-lived-quality-scenes.mjs`
- Modify: `tests/yuqi-lived-quality-contract.test.mjs`
- Create: `tests/fixtures/yuqi-lived-quality-v1/source-grounding-index.json`
- Modify: `package.json`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/quality-report.json`

**Interfaces:**
- Consumes: Task 21 suites; immutable stable/candidate release IDs.
- Produces: deterministic findings, blinded model scores, pairwise preference,
  disagreement queue, materialized gate report, and the full checksummed
  immutable candidate-release definition compiled from Task 6 assets. It does
  not mutate the production release table.

- [ ] **Step 1: Write red scoring, blinding, and gate tests**

```js
test('blind evaluator cannot see release identity or output order', () => {
  const input = buildBlindEvaluation(stableCandidatePair(), { seed: 7 });
  assert.equal(JSON.stringify(input).includes('stable'), false);
  assert.equal(JSON.stringify(input).includes('candidate'), false);
  assert.deepEqual(input.labels.sort(), ['A', 'B']);
});

test('six dimensions normalize to integer 1 through 5', () => {
  const result = normalizeBlindEvaluation(validEvaluation());
  assert.deepEqual(Object.keys(result.scores).sort(), [
    'actionFactIntegrity', 'agency', 'livedExpression',
    'relationshipParticipation', 'socialUnderstanding', 'stateContinuityFlexibility'
  ]);
  assert.ok(Object.values(result.scores).every(x => Number.isInteger(x) && x >= 1 && x <= 5));
});

test('average cannot hide a severe sentinel failure', () => {
  const report = aggregateQualityGate(highAverageWithOneCriticalFailure());
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('SENTINEL_SEVERE_FAILURE'));
});

test('approved candidate meets every numerical gate', () => {
  const report = aggregateQualityGate(goodEvidence());
  assert.equal(report.sentinelSevereFailureCount, 0);
  assert.ok(report.dimensionAverages.every(x => x.average >= 4));
  assert.equal(report.scoreOneCount, 0);
  assert.ok(report.candidatePreferredRate >= 0.60);
  assert.ok(report.regressionRate <= 0.10);
  assert.equal(report.structuralRegressionCount, 0);
  assert.equal(report.eligible, true);
});

test('missing, duplicate, unresolved, or incomplete evidence can never pass', () => {
  for (const evidence of [
    emptyEvidence(), missingOneSentinelRun(), missingOneCoverageRun(),
    missingOneHistoryRun(), duplicateEvidenceKey(), unresolvedDimensionScore(),
    scoreWithMissingDimension(), scoreWithNonIntegerDimension()
  ]) {
    const report = aggregateQualityGate(evidence);
    assert.equal(report.eligible, false);
    assert.ok(report.failedGates.includes('INCOMPLETE_QUALITY_EVIDENCE'));
  }
});

test('blind projection is closed and excludes every release and execution side channel', () => {
  const input = projectBlindEvaluationInput(pairWithAllInternalMetadata(), { seed: 17 });
  assert.deepEqual(Object.keys(input).sort(), [
    'dimensions', 'outputs', 'sceneAnnotation', 'version'
  ]);
  assert.equal(recursiveContainsForbiddenMetadata(input), false);
  assertLabelsIndependentOfSourceOrder(input, { seed: 17 });
  assert.throws(() => projectBlindEvaluationInput(pairWithUnknownNestedKey()),
    /blind evaluation input shape/);
});

test('clean checkout compiles source-grounded scenes without private annotation files', () => {
  const suite = compileQualityScenes({ rootDir: cleanCheckoutWithoutPresetReferences() });
  assert.equal(suite.sentinelSeeds.length, 24);
  assert.equal(suite.coverageScenes.length, 72);
});

test('one closed adapter executes every scene through the pinned release executor', async () => {
  const execution = compileSceneExecutionInput(validDirectScene());
  const pairRecord = await runScenePair(execution, frozenReleasePair());
  assert.equal(pairRecord.stable.dryRun, true);
  assert.equal(pairRecord.candidate.dryRun, true);
  assert.equal(pairRecord.executionChecksum, contentHash(pairRecord.execution));
  assert.equal(pairRecord.stableInputChecksum, pairRecord.executionChecksum);
  assert.equal(pairRecord.candidateInputChecksum, pairRecord.executionChecksum);
});
```

- [ ] **Step 2: Run quality evaluator tests red**

Run: `node --test yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/comparison-evaluator.test.mjs`

Expected: FAIL on missing evaluator.

- [ ] **Step 3: Implement three evidence layers and fixed finding ownership**

```js
export const QUALITY_DIMENSIONS = Object.freeze([
  'socialUnderstanding', 'agency', 'relationshipParticipation',
  'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'
]);

export function aggregateQualityGate(evidence) {
  const completeness = validateExactEvidenceSet(evidence, {
    sentinelRuns: 72,
    coverageRuns: 144,
    historyRuns: 30,
    dimensions: QUALITY_DIMENSIONS
  });
  const summary = summarizeEvidence(evidence);
  const failedGates = [
    !completeness.ok && 'INCOMPLETE_QUALITY_EVIDENCE',
    summary.protocolFailures > 0 && 'PROTOCOL_REGRESSION',
    summary.sentinelSevereFailureCount > 0 && 'SENTINEL_SEVERE_FAILURE',
    summary.dimensionAverages.some(x => x.average < 4) && 'DIMENSION_BELOW_FOUR',
    summary.scoreOneCount > 0 && 'SEVERE_SCORE_ONE',
    summary.candidatePreferredRate < 0.60 && 'PREFERENCE_BELOW_SIXTY_PERCENT',
    summary.regressionRate > 0.10 && 'REGRESSION_ABOVE_TEN_PERCENT',
    summary.tieOrUnresolvedRate > 0.20 && 'TOO_MANY_UNRESOLVED_PAIRS',
    summary.structuralRegressionCount > 0 && 'STRUCTURAL_REGRESSION'
  ].filter(Boolean);
  return { ...summary, failedGates, eligible: failedGates.length === 0 };
}
```

`validateExactEvidenceSet()` is fail-closed. The finalized evidence identity is
exactly `(layer, sceneId, repeatIndex)`: the materialized set must contain one
and only one finalized result for each expected identity, totaling 72 sentinel,
144 coverage, and 30 local-history results. Raw evaluator attempts are
append-only children with the closed identity
`(layer, sceneId, repeatIndex, attemptIndex, evaluatorId)`; retries never create
a second finalized result and an identity with zero or multiple accepted
completions is unresolved. Duplicate attempt/final identities, a gap in native
non-negative `attemptIndex`, an unexpected scene, an unresolved final result,
or any missing, non-native-integer, or out-of-range score in the six fixed
dimensions makes the report ineligible. Empty arrays and `NaN` aggregates are
never eligible.

`projectBlindEvaluationInput()` is the sole model-evaluator input builder. Its
closed output contains only `version`, `sceneAnnotation`, `dimensions`, and
`outputs`. Unknown or missing fields are rejected, never silently stripped.
`version` is the native integer `1`; `dimensions` is exactly the six literal
dimension names in their frozen order. `sceneAnnotation` is a closed object of
`{sceneId,severity,focus,turns,requiredChecks,allowedVariation}`; its turns and
structured feature records use the closed Task 21 scene projection and contain
only user-visible scenario content, never source file/heading paths. `outputs`
is an array of exactly two closed
`{label,terminalDisposition,replyParts,actions}` objects. Labels are exactly A
and B; reply parts/actions use an identity-free closed evaluator projection
with native types and recursively reject unknown keys. No nested object may
contain release IDs, pipeline names, checksums, model profiles, latency,
attempt/order/source-side labels, rollout keys, paths, timestamps, or transport
metadata. The A/B permutation key is exactly
`contentHash({sceneId,repeatIndex,evaluationSeed})`; it contains no release,
output order, latency, checksum, or path input. Swapping stable/candidate source
order under the same key must preserve the permutation rule without revealing
which release produced either label.

Layer 1 runs deterministic schema/target/privacy/stage/duplicate/state-authority checks. Layer 2 gives a reviewer two identity-free, seed-shuffled outputs plus the scene annotations and six dimensions. It may not see pipeline names, checksums, latency, or which side is current. Layer 3 creates a manual review queue for any critical finding, evaluator disagreement, score 1, or sampled structured feature. Manual review records evidence and a decision; it cannot edit raw model output.

`candidatePreferredRate = candidateWins / (candidateWins + stableWins)` and `regressionRate = stableWins / totalCompletedPairs`. The report is ineligible if more than 20% of completed pairs are ties/unresolved, so silence cannot inflate either gate. A severe live-quality finding is “confirmed” only when two independent blinded evaluator calls agree on severity/code, or when the finding is deterministic action/privacy corruption.

- [ ] **Step 4: Run exact repeated evaluation**

The replay command executes:

```js
for (const scene of sentinelSeeds) runPair(scene, { repeats: 3 });
for (const scene of coverageScenes) runPair(scene, { repeats: 2 });
for (const scene of localHistoryScenes) runPair(scene, { repeats: 1 });
```

Each repeat gets a fixed input/checkpoint checksum, independent model calls, randomized blind labels, full latency, deterministic findings, six scores, pairwise result, and evaluator version. A retry appends an attempt under the same run/scene/repeat key; it cannot replace a completed record.

The replay script owns one closed `compileSceneExecutionInput(scene)` adapter.
It validates the Task 21 scene shape and deterministically projects it to the
exact Task 11 `ReleaseExecutor` execution input, including rollout kind,
ordered turns, context/state checkpoint, and structured-action targets. It
computes one execution checksum before selecting a release, then invokes both
frozen release IDs/checksums through the same `ReleaseExecutor` with
`dryRun:true`. Stable and candidate may not use separate scene compilers,
production turn creators, store writers, or caller-supplied draft shortcuts;
the Task 22 pair record (not `ReleaseExecutor`) stores the canonical execution,
its checksum, and identical `stableInputChecksum`/`candidateInputChecksum`.
The executor interface remains unchanged. Both calls must use zero
visible/action capabilities.

Task 21 source grounding must also be reproducible from a clean checkout.
Commit `source-grounding-index.json` as a privacy-safe deterministic object with
exactly `{schemaVersion,sentinels}`. `schemaVersion` is native integer `1` and
`sentinels` is an object with exactly the 24 expected sentinel scene IDs; each
value is the closed object
`{file,heading,headingChecksum,sceneChecksum}`. Both checksums are lowercase
SHA-256: `headingChecksum` commits the exact normalized heading, while
`sceneChecksum` commits the full canonical sentinel seed (including its source
annotation and variants), so a valid heading cannot be reused for substituted
scene content. Unknown/duplicate/missing scene mappings, duplicate scene IDs,
or any mismatch among the scene source annotation, heading commitment, and
scene checksum is fatal. It must not contain quoted private chat or annotation
bodies. The compiler always validates every sentinel and all 72 derived
coverage scenes through their parent sentinel against this committed index.
When a private source Markdown is present locally it additionally verifies the
document heading; when it is absent, clean-checkout compilation still succeeds
from the committed commitments without weakening the scene-to-source binding.
Tests must cover absent private sources, wrong heading/checksum, substituted
scene content, missing/extra/duplicate mapping, and a coverage scene with the
wrong parent. No committed test or script may require the untracked
`真人聊天训练批注-第四轮-交接.md` file.

The materialized report embeds `candidateRelease` with every
`pipeline_releases` field (`releaseId`, `pipelineVersion`, `presetVersion`,
cognition/expression schema versions, evaluator version, model profile,
component manifest, release checksum and createdAt). Its ID/checksum are
recomputed from the immutable Task 6 manifest and exact model profile; the
reporter rejects a caller-supplied ID or a pipeline version unsupported by Task
11's `ReleaseExecutor`. This closes the handoff: Task 22 produces the immutable
definition, while Task 23 alone may register it in production.

Before report materialization, the central window resolves every Layer 3 queue item in `artifacts/yuqi-lived-agency-v3/manual-quality-review.jsonl` using:

```json
{
  "reviewId": "review_<content-hash>",
  "evalRunId": "run-id",
  "sceneId": "scene-id",
  "repeatIndex": 0,
  "evidenceFindingIds": ["finding-id"],
  "decision": "confirm|downgrade|reject_evaluator|unresolved",
  "reason": "evidence-based explanation",
  "reviewer": "central_window",
  "createdAt": 0
}
```

The reporter rejects any `unresolved` critical/score-1 item. It also requires manual review of every structured-action critical result and a deterministic 10% sample of otherwise-passing payment, moment, role-plan, stage, and life scenes.

Add scripts:

```json
{
  "cognition:quality:check": "node scripts/compile-yuqi-lived-quality-scenes.mjs --check",
  "cognition:quality:replay": "node scripts/run-yuqi-lived-quality-replay.mjs",
  "cognition:quality:report": "node scripts/report-yuqi-lived-quality.mjs"
}
```

- [ ] **Step 5: Run tests and materialize the checksummed report**

Run:

```powershell
node --test yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/quality-report.test.mjs yuqi-runtime/test/comparison-evaluator.test.mjs
node --test tests/yuqi-lived-quality-contract.test.mjs yuqi-runtime/test/replay-runner.test.mjs
npm run cognition:quality:check
npm run cognition:quality:replay -- --stable-from artifacts/yuqi-lived-agency-v3/baseline.json --candidate-preset 2.1.0
npm run cognition:quality:report -- --out artifacts/yuqi-lived-agency-v3/quality-report.json
```

Expected: tests PASS from a clean checkout without private annotation Markdown.
The report records exactly all 72 sentinel runs, 144 coverage runs, 30 history
runs, all six dimension aggregates, pairwise rates, severe findings, structural
results, the complete checksummed stable/candidate release definitions, and
`eligible`. Any missing, duplicate, unresolved, malformed, identity-leaking, or
non-dry-run evidence makes `eligible=false`. If `eligible=false`, stop before
registering a production candidate; do not weaken gates.

- [ ] **Step 6: Commit**

```powershell
git add yuqi-runtime/src/quality-evaluator.mjs yuqi-runtime/src/quality-replay.mjs yuqi-runtime/src/comparison-evaluator.mjs yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/quality-replay.test.mjs yuqi-runtime/test/quality-report.test.mjs yuqi-runtime/test/comparison-evaluator.test.mjs scripts/run-yuqi-lived-quality-replay.mjs scripts/report-yuqi-lived-quality.mjs scripts/compile-yuqi-lived-quality-scenes.mjs tests/yuqi-lived-quality-contract.test.mjs tests/fixtures/yuqi-lived-quality-v1/source-grounding-index.json package.json
git commit -m "feat: gate Yuqi v3 with blind lived quality evidence"
```

### Task 23: Make Rollout Release-Aware With Promotion Commands and Quality Fuse

**Files:**
- Modify: `yuqi-runtime/src/promotion-controller.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/preset-registry.mjs`
- Modify: `yuqi-runtime/test/promotion-controller.test.mjs`
- Modify: `yuqi-runtime/test/store-cognition-migration.test.mjs`
- Create: `scripts/cognition-rollout.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 release rows; Task 11 `release-pair.mjs`,
  `release-executor.mjs`,
  `selectPipelinePairForFreshSubject()` and comparison-slot accounting; Task 22
  materialized report; live shadow/canary rows only.
- Produces: candidate registration/phase mutation, exact Cross-Task Interface
  promotion methods, transactional quality-fuse rollback, and CLI commands. It
  does not introduce a second release resolver or a second turn creator.

- [ ] **Step 1: Write red release-pair, evidence, canary, and rollback tests**

```js
test('registering candidate requires immutable release and eligible materialized report', () => {
  assert.throws(() => controller.registerCandidate({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: 1,
    releaseId: 'r3', reportId: 'bad', reportChecksum: 'wrong'
  }), /eligible materialized quality report/);
});

test('candidate definition is inserted once from the report and cannot be substituted', () => {
  const report = eligibleReportWithCandidateRelease('candidate-r3');
  controller.registerCandidate(registerInput(report));
  assert.deepEqual(store.getPipelineRelease('candidate-r3'),
    report.candidateRelease);
  const forged = structuredClone(report);
  forged.candidateRelease.componentManifest.executor = 'unknown';
  assert.throws(() => controller.registerCandidate(registerInput(forged)),
    /candidate release checksum|release executor unavailable/);
});

test('replay rows never satisfy live shadow gate', () => {
  insertReplaySuccesses('DIRECT_REPLY', 300);
  assert.equal(controller.promotionCheck('DIRECT_REPLY').liveShadowSuccessCount, 0);
});

test('canary pins candidate visible and stable compare for exactly the first ten', async () => {
  makeDirectEligibleForCanary();
  controller.promoteToCanary(canaryInput());
  const turns = await executeAndCompleteCanaryTurnsThroughTask11Runtime(11);
  assert.equal(turns.filter(x => x.comparisonReleaseId === 'stable-r2').length, 10);
  assert.equal(turns[10].comparisonReleaseId, null);
});

test('canary allows at most three outstanding comparisons and survives restart', async () => {
  makeDirectEligibleForCanary();
  controller.promoteToCanary(canaryInput());
  createUnfinishedCanaryTurns(3);
  const restored = reopenTask11Runtime();
  const next = await restored.orchestrator.execute(directTurnInput());
  assert.equal(restored.promotionController.getStatus(
    'DIRECT_REPLY').candidatePhase, 'rolled_back');
  assert.equal(next.authoritativeReleaseId, 'stable-r2');
  assert.equal(restored.promotionController.getStatus(
    'DIRECT_REPLY').lastReasonCode,
    'CANARY_COMPARE_BACKLOG');
});

test('hard action error rolls back only that TurnKind for new turns', async () => {
  const oldTurn = createCanaryTurn('MOMENT_REPLY');
  controller.recordCriticalFinding(criticalFinding('PUBLIC_PRIVACY_VIOLATION', oldTurn));
  assert.equal(controller.getStatus('MOMENT_REPLY').candidatePhase, 'rolled_back');
  assert.equal(store.getTurn(oldTurn.turnId).authoritativeReleaseId, 'candidate-r3');
  assert.equal((await runtime.execute(
    momentReplyInput())).authoritativeReleaseId, 'stable-r2');
  assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'canary');
});

test('two confirmed severe lived failures in fifteen minutes trip quality fuse', () => {
  recordSevereConfirmed('DIRECT_REPLY', 1000);
  recordSevereConfirmed('DIRECT_REPLY', 1000 + 14 * 60_000);
  assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
});
```

- [ ] **Step 2: Run promotion tests red**

Run: `node --test yuqi-runtime/test/release-pair.test.mjs yuqi-runtime/test/release-executor.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs`

Expected: FAIL because candidate registration, phase mutation, promotion gates,
quality-fuse rollback, and CLI methods do not exist. Task 11 release-pair tests
must already be green; a failure in `release-pair.test.mjs` is not an acceptable
Task 23 red state.

- [ ] **Step 3: Implement transactional candidate mutations and gates**

Do not implement or copy `resolvePipelinePair()` here. Import the Task 11
function through `PromotionController.resolvePipelinePair()` and leave
`release-pair.mjs` unchanged. This task adds only the transactional mutations
around that projection:

```js
registerCandidate({ rolloutKey, expectedRevision, releaseId, reportId, reportChecksum })
promoteToCanary({ rolloutKey, expectedRevision, reportId, reportChecksum })
graduateCandidate({ rolloutKey, expectedRevision, reportId, reportChecksum })
rollbackCandidate({ rolloutKey, expectedRevision, reasonCode, findingIds })
```

Each mutation updates `candidate_phase`, the compatibility
`current_mode/rollout_phase` projection, evidence/canary epochs and counters in
one store transaction. `selectPipelinePairForFreshSubject()` preserves Task 11's
conditional max-outstanding rule and is extended so an applicable backlog or
any deadline breach transactionally calls `rollbackCandidate()`, reloads the
row, then returns the stable pair. The Task 11 orchestrator remains unchanged
and the store still re-resolves under its creation CAS. Existing open
turns/attempts retain their stored pair.

Task 11 already owns “first ten only” allocation for both turn and life-planning
subjects. Task 23 must not increment `canary_started_count` itself during
selection; only the store-owned creation transactions reserve a comparison
slot. Task 23 reads those durable counters to decide promotion, graduation,
backlog and rollback.

Registration obtains the full candidate definition from the exact materialized
Task 22 report, recomputes its release ID/checksum, verifies the stable baseline
ID, evaluator version, suite checksum, `eligible=true`, and Task 11 executor
support, then calls `putPipelineReleaseInternal()` in the same transaction as
the rollout mutation. An absent row is inserted once; an existing exact row is
reused; any same-ID/checksum/content mismatch rolls the transaction back. The
CLI's `--candidate-release-id` is only an equality assertion against the report,
not enough data to invent a release. Registration then increments a new
evidence epoch and enters shadow. Initial live gates are:

| kind | minimum real shadow success | observation span | canary comparisons | post-canary observation |
|---|---:|---:|---:|---:|
| `DIRECT_REPLY` | 10 | 72 hours | first 10 | 48 hours |
| each other turn kind | 30 | 72 hours | first 10 | 48 hours |
| `LIFE_PLANNING` | 30 completed real attempts | 72 hours | first 10 | 48 hours |

All require zero critical error, no stale evidence, and no outstanding comparison backlog. Canary preserves `canary_target_count=10`, `canary_max_outstanding=3`, and `canary_compare_deadline_ms=900000`; allocation and completion counters live in SQLite and survive restart. When a fresh subject would allocate a fourth outstanding comparison, or any outstanding subject is older than 15 minutes, the affected kind rolls back before that fresh subject is pinned. These thresholds control production promotion, not APK build completion. Graduation requires all canary comparisons complete, no critical error, no confirmed severe quality fuse, no outstanding work, and observation deadline elapsed. It atomically swaps candidate into stable.

Immediate per-kind rollback codes include payment target/amount mismatch, public privacy leak, illegal stage transition, duplicate structured action, unauthorized target, and deterministic pipeline/preset absence. A lived-quality failure becomes confirmed only after two independent blinded evaluator judgments agree on severity/code. Two confirmed severity-critical turns within 15 minutes roll back the same kind. Ordinary style disagreement records a finding only. Existing turns keep fixed release IDs.

- [ ] **Step 4: Add one CLI around the one controller**

```json
{
  "cognition:promotion-check": "node scripts/cognition-rollout.mjs check",
  "cognition:promote": "node scripts/cognition-rollout.mjs promote",
  "cognition:rollback": "node scripts/cognition-rollout.mjs rollback",
  "cognition:rollout-status": "node scripts/cognition-rollout.mjs status"
}
```

Required forms:

```powershell
npm run cognition:rollout-status -- --config yuqi-runtime/config.json
npm run cognition:promotion-check -- --config yuqi-runtime/config.json --kind DIRECT_REPLY
npm run cognition:promote -- --config yuqi-runtime/config.json --kind DIRECT_REPLY --expected-revision 7 --candidate-release-id <release-id-from-quality-report> --report artifacts/yuqi-lived-agency-v3/quality-report.json
npm run cognition:rollback -- --config yuqi-runtime/config.json --kind DIRECT_REPLY --expected-revision 8 --reason MANUAL_SAFETY_ROLLBACK
```

`promote` distinguishes `register-candidate`, `canary`, and `graduate` from current row state; it rejects skipped phases. Status names stable/candidate release IDs, phase, evidence epoch, live/replay counts separately, canary outstanding, deadlines, last finding, and revision.

- [ ] **Step 5: Run tests and a dry rollout drill**

Run:

```powershell
node --test yuqi-runtime/test/release-pair.test.mjs yuqi-runtime/test/release-executor.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs
npm run cognition:rollout-status -- --config yuqi-runtime/config.json
npm run cognition:promotion-check -- --config yuqi-runtime/config.json --kind DIRECT_REPLY
```

Expected: tests PASS; status is read-only and clearly separates genuine live evidence from replay/history. Do not mutate production rollout in this task.

- [ ] **Step 6: Commit**

```powershell
git add yuqi-runtime/src/promotion-controller.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/preset-registry.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs scripts/cognition-rollout.mjs package.json
git commit -m "feat: control Yuqi stable candidate rollout by release"
```

### Task 24: Expose End-to-End Delivery, Release, Lane, and Quality Diagnostics

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `tavern-app/index.html`
- Modify: `yuqi-runtime/src/local-server.mjs`
- Modify: `yuqi-runtime/src/main.mjs`
- Create: `scripts/verify-yuqi-v3-races.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `test-basic.mjs`
- Create: `yuqi-runtime/test/v3-diagnostics.test.mjs`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/race-report.json`

**Interfaces:**
- Consumes: turn, lineage, canonical group, commit receipt, group delivery, cursor, lane, release/rollout, comparison, and quality findings.
- Produces: one joined authority chain, separate observable stages, and a checksummed race report.

- [ ] **Step 1: Write red diagnostics tests**

```js
test('diagnostics do not collapse four delivery stages', async () => {
  const value = await diagnosticsFor('turn-1');
  assert.deepEqual(Object.keys(value.delivery).sort(), [
    'cloudConfirmed', 'nativeCompleted', 'notificationShown', 'uiApplied'
  ]);
  assert.equal(value.transport.stage, 'PC_ACCEPTED');
  assert.equal(value.delivery.nativeCompleted, true);
  assert.equal(value.delivery.uiApplied, false);
});

test('diagnostics name release pair and lane authority', async () => {
  const value = await diagnosticsFor('turn-1');
  assert.equal(value.pipeline.authoritativeReleaseId, 'candidate-r3');
  assert.equal(value.pipeline.comparisonReleaseId, 'stable-r2');
  assert.equal(value.pipeline.candidatePhase, 'canary');
  assert.equal(value.lane.key, 'private_chat');
  assert.equal(value.lane.revision, 8);
  assert.equal(value.visibleGroup.id, 'group-1');
  assert.equal(value.authority.lineageKey, 'lineage-1');
  assert.equal(value.authority.origin, 'pc');
  assert.equal(value.authority.chainValid, true);
  assert.equal(value.authority.commitChecksum, 'commit-sha256');
  assert.equal(value.outbox.authorityGroupId, 'group-1');
});

test('diagnostics never fabricate authority from turn reply JSON', async () => {
  corruptReceiptJoinWithoutChangingTurnProjection('turn-1');
  const value = await diagnosticsFor('turn-1');
  assert.equal(value.authority.chainValid, false);
  assert.equal(value.visibleGroup, null);
  assert.equal(value.authority.errorCode, 'VISIBLE_AUTHORITY_INVARIANT');
});

test('raw internal cognition text and private quality scenes are not exposed', async () => {
  const json = JSON.stringify(await diagnosticsFor('turn-1'));
  assert.equal(json.includes('immediateFeeling'), false);
  assert.equal(json.includes('real-history-scenes'), false);
});
```

- [ ] **Step 2: Run diagnostics tests red**

Run:

```powershell
node --test yuqi-runtime/test/v3-diagnostics.test.mjs tests/yuqi-ui-contract.test.mjs test-basic.mjs
```

Expected: FAIL on missing release/lane/quality diagnostics.

- [ ] **Step 3: Implement a sanitized diagnostic projection**

```js
function projectTurnDiagnostics({
  turn, lineage, group, receipt, delivery, lane, rollout, comparison, findings
}) {
  const authority = validateVisibleAuthorityJoin({
    turn, lineage, group, receipt, delivery, lane
  });
  return {
    turnId: turn.turnId,
    kind: turn.rolloutKey,
    state: turn.state,
    transport: {
      stage: normalizeTransportStage(turn),
      localQueuedAt: turn.localQueuedAt,
      cloudAcceptedAt: turn.cloudAcceptedAt,
      pcAcceptedAt: turn.pcAcceptedAt
    },
    delivery: {
      cloudConfirmed: Boolean(delivery?.cloudConfirmedAt),
      nativeCompleted: Boolean(delivery?.nativeCompletedAt),
      notificationShown: Boolean(delivery?.notificationShownAt),
      uiApplied: Boolean(delivery?.uiAppliedAt)
    },
    authority: authority.valid ? {
      lineageKey: lineage.lineageKey,
      lineageRevision: lineage.revision,
      turnRevision: turn.turnRevision,
      origin: receipt.authorityOrigin,
      commitPayloadVersion: receipt.commitPayloadVersion,
      commitChecksum: receipt.commitChecksum,
      chainValid: true
    } : {
      lineageKey: turn.authorityLineageKey,
      chainValid: false,
      errorCode: 'VISIBLE_AUTHORITY_INVARIANT'
    },
    visibleGroup: authority.valid ? {
      id: group.groupId,
      authoritativeTurnId: group.authoritativeTurnId,
      redacted: Boolean(group.redactedAt)
    } : null,
    outbox: authority.valid && delivery ? {
      authorityGroupId: delivery.authorityGroupId,
      peerId: delivery.peerId,
      state: delivery.state
    } : authority.valid && receipt.authorityOrigin === 'android_fallback'
      ? { authorityGroupId: group.groupId, state: 'not_applicable_external_visibility' }
      : null,
    lane: { key: lane.laneKey, revision: lane.revision, localSequence: lane.localSequence },
    pipeline: {
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      candidatePhase: rollout.candidatePhase,
      evidenceEpoch: rollout.evidenceEpoch
    },
    comparison: summarizeComparison(comparison),
    quality: summarizeFindingCodes(findings),
    timings: sanitizeTimings(turn)
  };
}
```

`diagnosticsFor()` performs the join from `turn.authority_lineage_key → turn_authority_lineages → visible_commit_receipts → visible_result_groups`, and for origin `pc` additionally requires matching `cloud_deliveries`. Origin `android_fallback` must have no PC delivery and reports `not_applicable_external_visibility`. It never reads `turn.reply_json` to obtain group/checksum and never reports a synthetic success when any key, revision, origin, release, lane or checksum disagrees. Legacy authority-version-0 turns are labeled `legacy_turn_identity`, not failed v3 joins.

Android native diagnostics expose four stage timestamps, local authority lineage/group/checksum/origin/revisions, cursor IDs, local sequence, fallback contract, and last native error. Web displays each stage independently and never marks success merely because a notification has body text. PC exposes no prompt bodies, private scene text, secrets, or full cognitive chain.

The transport projection is separate from delivery: `LOCAL_QUEUED`, `CLOUD_ACCEPTED`, `PC_ACCEPTED`, `COMPLETED`, and `UI_APPLIED` remain distinguishable. `BRIDGE_WAITING` is a persisted execution state corresponding to `CLOUD_ACCEPTED`; it is neither runnable nor fallback-eligible.

- [ ] **Step 4: Execute the fixed race matrix**

`verify-yuqi-v3-races.mjs` must run and record:

```js
const raceCases = [
  'proactive_generating_then_user_batch',
  'proactive_outbox_then_user_batch',
  'native_completed_before_ui_open',
  'ui_open_before_notification',
  'event_and_poll_same_group',
  'event_lost_poll_recovers',
  'plugin_promise_hangs_then_replay',
  'page_reload_before_ui_ack',
  'runtime_restart_before_visible_commit',
  'runtime_restart_after_visible_commit',
  'original_retry_and_sibling_retry_compete',
  'populated_v10_migrates_then_restarts_v13',
  'canary_rollback_while_turn_in_flight',
  'same_fingerprint_adjacent_revisions',
  'cloud_waiting_does_not_block_next_local_turn',
  'ambiguous_remote_timeout_never_falls_back',
  'android_fallback_receipt_syncs_without_pc_redelivery',
  'pc_android_receipt_conflict_is_quarantined'
];
```

Each case asserts one visible authority group, correct state-write count, no duplicate action/notification, expected cursor/lane revision, and correct release pin. The report stores inputs/result checksums and failures.

- [ ] **Step 5: Run diagnostics/race tests green**

Run:

```powershell
node --test yuqi-runtime/test/v3-diagnostics.test.mjs tests/yuqi-ui-contract.test.mjs test-basic.mjs
node scripts/verify-yuqi-v3-races.mjs --out artifacts/yuqi-lived-agency-v3/race-report.json
```

Expected: tests PASS; all 18 race cases pass and report checksum is materialized.

- [ ] **Step 6: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java tavern-app/index.html yuqi-runtime/src/local-server.mjs yuqi-runtime/src/main.mjs scripts/verify-yuqi-v3-races.mjs tests/yuqi-ui-contract.test.mjs test-basic.mjs yuqi-runtime/test/v3-diagnostics.test.mjs
git commit -m "feat: expose Yuqi v3 authority diagnostics"
```

### Task 25: Add One Reproducible Release-Readiness Gate and Run the Full Matrix

**Files:**
- Create: `scripts/verify-yuqi-v3-readiness.mjs`
- Create: `tests/yuqi-v3-readiness.test.mjs`
- Modify: `package.json`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/readiness-report.json`

**Interfaces:**
- Consumes: baseline, clone migration, protocol, quality, races, rollout status, Node and Android test results.
- Produces: `verifyReadiness(evidence) -> { ready, failedGates, checksums }`.

- [ ] **Step 1: Write a red test that refuses missing or stale evidence**

```js
test('readiness requires every design completion artifact for the same candidate', () => {
  const result = verifyReadiness(completeEvidenceFixture());
  assert.equal(result.ready, true);
  for (const missing of [
    'baseline', 'migration', 'protocol', 'quality', 'races',
    'androidFallback', 'rolloutStatus', 'nodeTests', 'androidTests'
  ]) {
    const evidence = completeEvidenceFixture();
    delete evidence[missing];
    assert.equal(verifyReadiness(evidence).ready, false, missing);
  }
});

test('readiness rejects checksum or release identity mismatch', () => {
  const evidence = completeEvidenceFixture();
  evidence.quality.candidateReleaseId = 'different-release';
  assert.deepEqual(verifyReadiness(evidence).failedGates,
    ['CANDIDATE_RELEASE_MISMATCH']);
});
```

- [ ] **Step 2: Run readiness tests red**

Run: `node --test tests/yuqi-v3-readiness.test.mjs`

Expected: FAIL on missing readiness verifier.

- [ ] **Step 3: Implement a manifest-based verifier**

```js
export function verifyReadiness(evidence) {
  const required = [
    'baseline', 'migration', 'protocol', 'quality', 'races',
    'androidFallback', 'rolloutStatus', 'nodeTests', 'androidTests'
  ];
  const failedGates = required.filter(key => !evidence[key])
    .map(key => `MISSING_${key.toUpperCase()}`);
  failedGates.push(...verifySharedReleaseIdentity(evidence));
  failedGates.push(...verifyArtifactChecksums(evidence));
  failedGates.push(...verifyGateOutcomes(evidence));
  return {
    ready: failedGates.length === 0,
    failedGates,
    candidateReleaseId: evidence.quality?.candidateReleaseId || null,
    checksums: collectArtifactChecksums(evidence)
  };
}
```

Add:

```json
{
  "cognition:v3:readiness": "node scripts/verify-yuqi-v3-readiness.mjs"
}
```

With `--run`, the command executes `npm.cmd test` and Android `gradlew.bat testDebugUnitTest assembleDebugAndroidTest connectedDebugAndroidTest`, captures exit codes and SHA-256 hashes of sanitized logs under the evidence directory, then validates all pre-existing reports. It computes file checksums itself; it never trusts a report's self-declared checksum without recomputing it.

Readiness also enforces visible-path latency evidence from quality/history/race runs:

```js
if (metrics.directReplyMedianMs > 60_000) failedGates.push('DIRECT_MEDIAN_ABOVE_TARGET');
if (metrics.directReplyP95Ms > 180_000) failedGates.push('DIRECT_P95_ABOVE_THREE_MINUTES');
if (metrics.maximumVisibleMs > 300_000) failedGates.push('VISIBLE_REPLY_ABOVE_HARD_LIMIT');
if (metrics.shadowBlockedVisibleCount > 0) failedGates.push('SHADOW_BLOCKED_VISIBLE_PATH');
```

The one-minute median is the performance target; any visible reply above five minutes is a hard release failure.

- [ ] **Step 4: Run the complete source and platform verification**

Run:

```powershell
npm run cognition:quality:check
npm run cognition:replay
npm run cognition:replay-report
npm run cognition:quality:report -- --out artifacts/yuqi-lived-agency-v3/quality-report.json
node scripts/verify-yuqi-v3-races.mjs --out artifacts/yuqi-lived-agency-v3/race-report.json
npm run cognition:v3:readiness -- --run --evidence-dir artifacts/yuqi-lived-agency-v3 --out artifacts/yuqi-lived-agency-v3/readiness-report.json
```

Expected: every command exits 0 and readiness says `ready=true`. If quality report is not eligible, migration validation differs, a race fails, or Android fallback fails, stop before versioning or publishing.

- [ ] **Step 5: Commit the verifier after green**

```powershell
git add scripts/verify-yuqi-v3-readiness.mjs tests/yuqi-v3-readiness.test.mjs package.json
git commit -m "test: gate Yuqi v3 release readiness"
```

### Task 26: Select an Unused Android Version and Publish a Matching Signed OTA

**Files:**
- Create: `scripts/resolve-android-release-version.mjs`
- Create: `tests/android-release-version-resolution.test.mjs`
- Modify after resolution: `android/app/build.gradle`
- Modify after resolution: `.github/workflows/android-apk.yml`
- Modify after resolution: `android-update.json`
- Modify after resolution: `tavern-app/index.html`
- Modify after resolution: `tavern-app/sw-v11.js`
- Modify after resolution: `tests/android-unsigned-release-contract.test.mjs`
- Modify after resolution: `test-basic.mjs`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/release-version.json`
- Create at runtime: `artifacts/AL-<resolved-version>-release.apk`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/release-verification.json`

**Interfaces:**
- Consumes: Task 25 readiness, local source/artifacts, remote formal release tags/update channel through authenticated GitHub REST.
- Produces: one resolved version, source-consistent release commit, signed APK, canonical OTA manifest, verification evidence.

- [ ] **Step 1: Write a red resolver test using occupied-version fixtures**

```js
test('resolver chooses the next code above every source, remote, and artifact value', async () => {
  const result = resolveNextVersion({
    gradle: { code: 108, name: '1.0.108' },
    workflow: { code: 108, name: '1.0.108' },
    checkedManifest: { code: 108, name: '1.0.108' },
    remoteReleaseCodes: [106, 107, 108],
    signedArtifactVersions: [{ code: 108, name: '1.0.108' }]
  });
  assert.deepEqual(result, { versionCode: 109, versionName: '1.0.109' });
});

test('resolver stops when equal code has conflicting names', () => {
  assert.throws(() => resolveNextVersion(conflictingOccupiedVersions()),
    /occupied Android version conflict/);
});
```

- [ ] **Step 2: Run resolver tests red**

Run: `node --test tests/android-release-version-resolution.test.mjs`

Expected: FAIL on missing resolver.

- [ ] **Step 3: Resolve once and use the generated values everywhere**

```js
export function resolveNextVersion(evidence) {
  validateOccupiedVersionNames(evidence);
  const maximum = Math.max(...collectOccupiedCodes(evidence));
  return { versionCode: maximum + 1, versionName: `1.0.${maximum + 1}` };
}
```

Run:

```powershell
node scripts/resolve-android-release-version.mjs --root . --github-repository siyi78118-hue/- --out artifacts/yuqi-lived-agency-v3/release-version.json
```

Expected at the current mapped baseline: a value greater than 108. If remote state has advanced, use the larger result. Stop if remote release/update state cannot be verified or if names conflict.

- [ ] **Step 4: Apply the resolved code/name and fix canonical asset naming**

Set Gradle defaults and workflow environment to the generated values. Set the Web build marker to `<date>.<versionCode>`. Increment the service-worker cache identity inside `sw-v11.js` and update cache/build assertions; keeping the file name is allowed, but the cache name must change.

Use one canonical release asset:

```text
AL-<versionName>-release.apk
```

Before release upload, the workflow must copy the build output to that exact basename:

```bash
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk \
  "dist/AL-${AL_RELEASE_VERSION_NAME}-release.apk"
```

GitHub CLI's `file#text` syntax sets a display label; it does not rename the uploaded file. Therefore the workflow must upload the `dist/AL-...-release.apk` file itself, without relying on `#` for its download basename. The workflow upload, checked-in `android-update.json`, and generated update-channel manifest must all use:

```text
https://github.com/siyi78118-hue/-/releases/download/android-v<versionCode>/AL-<versionName>-release.apk
```

The current `app-release.apk` URL may match the old build-output basename; this task intentionally changes both the actual uploaded basename and the manifest together. Update the release contract test to parse Gradle, workflow, Web build, service-worker cache, checked manifest, tag, and asset URL from the same resolved version.

- [ ] **Step 5: Run release-contract and full tests before commit**

Run:

```powershell
node --test tests/android-release-version-resolution.test.mjs tests/android-unsigned-release-contract.test.mjs test-basic.mjs
npm.cmd test
cd android
.\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: PASS; checked manifest URL ends in the exact canonical asset name.

- [ ] **Step 6: Commit, push, trigger, and supervise the fixed-certificate workflow**

```powershell
git add scripts/resolve-android-release-version.mjs tests/android-release-version-resolution.test.mjs android/app/build.gradle .github/workflows/android-apk.yml android-update.json tavern-app/index.html tavern-app/sw-v11.js tests/android-unsigned-release-contract.test.mjs test-basic.mjs
git commit -m "release: prepare AL Android <resolved-version>"
git push origin codex/al-tdd
```

Use the REST process in `docs/AL-android-signing-runbook.md` to dispatch `.github/workflows/android-apk.yml` on `codex/al-tdd`, record run ID, and poll jobs to successful completion. Do not print credentials. If a job fails, inspect annotations/logs, reproduce, repair in a new focused commit, rerun all affected gates, and trigger again.

- [ ] **Step 7: Download and independently verify the formal APK and OTA**

Download `artifacts/AL-<versionName>-release.apk` from `signed-builds` using GitHub Contents REST. Verify:

```powershell
aapt dump badging artifacts/AL-<versionName>-release.apk
apksigner verify --verbose --print-certs artifacts/AL-<versionName>-release.apk
Get-FileHash artifacts/AL-<versionName>-release.apk -Algorithm SHA256
```

Required results:

```text
package: com.siyi.al
versionCode: <resolved versionCode>
versionName: <resolved versionName>
signer count: 1
APK Signature Scheme v2 or newer: true
certificate SHA-256: 5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b
```

Fetch the raw update-channel manifest and its `releaseUrl`. The manifest must return the resolved code/name; the URL must return the same APK bytes whose SHA-256 was just computed. Record HTTP status, content length, version, signer, certificate, local/remote SHA-256, workflow run ID, release tag, and URLs in `release-verification.json`. Test an actual covering install over the previous formal APK on the available Android device/emulator; a clean install alone is insufficient.

- [ ] **Step 8: Commit any generated checked release metadata only if the repository convention requires it**

Do not commit APK binaries to the source branch. Keep the formal APK under `artifacts/` locally and `signed-builds` remotely. If no checked metadata changed after Step 6, record “no source commit required” in the release evidence rather than creating an empty commit.

### Task 27: Apply the Validated Production Migration and Start Truthful Shadow Rollout

**Files:**
- Modify only through commands: production runtime database and rollout rows.
- Create at runtime: `artifacts/yuqi-lived-agency-v3/production-migration-report.json`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/production-migration-clone.sqlite`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/rollout-initialization.json`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/final-handoff.json`
- Read only: all evidence from Tasks 0–26.

**Interfaces:**
- Consumes: ready source, formal APK, validated migration decisions, eligible quality report, release manifest.
- Produces: production PC v14 state, stable-visible candidate shadow per kind, honest completion/handoff report.

- [ ] **Step 1: Stop runtime cleanly, back up, and prove the source database matches the validated dry run**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop-yuqi-background.ps1
node scripts/backup-yuqi-memory.mjs yuqi-runtime/config.json
node scripts/migrate-yuqi-agency-state.mjs --config yuqi-runtime/config.json --dry-run --clone-out artifacts/yuqi-lived-agency-v3/production-migration-clone.sqlite --out artifacts/yuqi-lived-agency-v3/production-migration-report.json
```

Expected: the raw backup is created before any new `YuqiStore` opens production; only the clone migrates through v11, v12, v13, and v14 during dry-run. Current database SHA/source decision checksum matches the validated basis or produces a new complete report with no structural count loss. The clone passes v13 manifest/tombstone invariants, v14 release/slot/accounting invariants, and restart-open checks. If messages or state legitimately changed since Task 3, rerun clone validation against this new report before applying. Do not apply an old report to changed data.

- [ ] **Step 2: Apply migration atomically, audit, and restart on stable**

Run:

```powershell
node scripts/migrate-yuqi-agency-state.mjs --config yuqi-runtime/config.json --apply --expect-report artifacts/yuqi-lived-agency-v3/production-migration-report.json
node scripts/audit-yuqi-memory.mjs yuqi-runtime/config.json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-yuqi-background.ps1
node scripts/verify-yuqi-runtime.mjs
```

Expected: runtime healthy, PC database v14, current production stable release still visible, no candidate active, old authority-version-0 unfinished turns resumable on the legacy branch, and before/after structural counts preserved. Every eligible new cognition-release turn created through the canonical internal boundary has lineage authority and a semantic manifest. On failure, stop runtime, restore the verified database backup, start the prior runtime, and report rollback evidence.

- [ ] **Step 3: Register the same eligible v3 candidate for each rollout key in shadow**

For each of:

```text
DIRECT_REPLY
ROLE_PLAN_CHAT
ROLE_PLAN_MOMENT
ROLE_PLAN_CHAT_PRIVATE
ROLE_PLAN_MOMENT_PRIVATE
PROACTIVE_CHAT
PROACTIVE_MOMENT
MOMENT_INTERACTION
MOMENT_REPLY
LIFE_PLANNING
```

run the release-aware register-candidate operation with current expected revision and the exact materialized quality report checksum. The controller must leave stable visible and candidate background. Do not register any key whose adapter, protocol row, quality coverage, or structural test is missing.

Use this form for each key, substituting the current revision returned immediately before the mutation:

```powershell
npm run cognition:promote -- --config yuqi-runtime/config.json --kind <ROLLOUT_KEY> --expected-revision <CURRENT_REVISION> --candidate-release-id <RELEASE_ID_FROM_QUALITY_REPORT> --report artifacts/yuqi-lived-agency-v3/quality-report.json
```

- [ ] **Step 4: Verify real shadow collection and automatic rollback mechanics without fabricating production counts**

Run one non-live rollback drill against a temporary cloned database and record it. In production, inspect status after the next genuine turns arrive:

```powershell
npm run cognition:rollout-status -- --config yuqi-runtime/config.json
npm run cognition:promotion-check -- --config yuqi-runtime/config.json --kind DIRECT_REPLY
```

Expected: replay/local-history counts are reported separately; only real comparisons increment live counts. Candidate results remain invisible in shadow. The formal APK does not need reinstallation for later promotion.

- [ ] **Step 5: Promote only when the controller's genuine gates pass**

If `DIRECT_REPLY` already has 10 genuine successful shadow comparisons spanning 72 hours with zero critical findings, promote it to canary; otherwise leave it shadow and state the exact missing live count/time. For every other kind and life planning, require the Task 23 thresholds. Never insert synthetic rows or backdate timestamps.

During DIRECT_REPLY canary, the first ten new turns show v3 and run stable dry-run. Any hard error rolls back immediately. After ten comparisons and 48 hours with no blocking finding/outstanding work, graduation may make v3 the new stable release. This post-APK rollout can continue without a new APK.

- [ ] **Step 6: Materialize the final handoff**

`final-handoff.json` must contain:

```json
{
  "design": {"path": "", "commit": ""},
  "plan": {"path": "", "commit": ""},
  "database": {"userVersion": 14, "backupPath": "", "backupSha256": "", "migrationReport": ""},
  "protocol": {"cases": 270, "passed": 270, "reportPath": "", "sha256": ""},
  "quality": {"sentinelRuns": 72, "coverageRuns": 144, "historyRuns": 30,
    "eligible": true, "reportPath": "", "sha256": ""},
  "races": {"cases": 18, "passed": 18, "reportPath": "", "sha256": ""},
  "rollouts": [],
  "android": {"apkPath": "", "versionCode": 0, "versionName": "",
    "packageName": "com.siyi.al", "signerSha256": "", "apkSha256": "",
    "coverInstallVerified": true},
  "ota": {"manifestUrl": "", "releaseUrl": "", "downloadSha256Matches": true},
  "notActiveYet": [],
  "rollback": {"databaseBackup": "", "stableReleaseIds": [], "previousApkPath": ""}
}
```

The actual numeric Android version replaces zero. `rollouts` lists every kind's stable/candidate release IDs, phase, genuine live counts, canary state, and missing gate. `notActiveYet` is mandatory and honest.

- [ ] **Step 7: Completion rule**

The implementation milestone is complete when the production database is safely migrated, all candidates are registered no further than their evidence permits, the signed covering-install APK and working OTA are delivered, and all evidence artifacts exist. Production rollout is complete per kind only after that kind graduates through genuine shadow/canary evidence. Do not hold back the compatible formal APK merely because a low-frequency kind is truthfully still shadow, and do not call that kind active.

No source commit is expected in this task. Database changes and generated evidence are runtime artifacts; record their hashes and recovery locations.

---

## Central Window Execution and Stop Protocol

Execute Tasks 0–27 in order. The central window may continue automatically after an ordinary red test becomes green. It must stop immediately when any of these is true:

1. The baseline cannot identify the actual visible stable implementation and checksum.
2. A PC v9→10→11→12→13→14 or Android Room 10→11→12 migration loses or reclassifies data without exact evidence.
3. A required TurnKind lacks an adapter, structural-action domain, or quality coverage.
4. Android v3 fallback and PC v3 assign different authority or state meaning.
5. A comparison path can commit a visible action, message, state, fact, outbox item, or notification.
6. Human quality scenes contain numbered dummy text, copied near-duplicates, missing source headings, or fewer than the required complete turns.
7. Offline/replay/history evidence increments a live rollout counter.
8. An evaluator/report cannot be tied to exact stable/candidate release checksums.
9. A proposed repair would weaken a quality gate, remove stable rollback, or silently activate a low-evidence kind.
10. Release version, asset name, OTA URL, package, certificate, or APK bytes disagree.
11. A change breaks a preserved feature or non-Yuqi path.
12. Continuing would require inventing user intent, data provenance, credentials, signing identity, or production evidence.

The stop report uses this exact structure:

```text
Stopped at: Task <number>, Step <number>
Production code modified in this task: yes|no
Evidence:
- file/table/command
- exact observed value
Conflicting design clause:
Completed state:
Uncompleted state:
Affected features:
Why continuing would be unsafe or dishonest:
Safe revision choices:
Recommended plan amendment:
```

After this design window amends the authoritative plan, the central window rereads the changed task plus every task whose interface consumes it, reruns affected tests from red, and resumes at the stopped task. It does not skip the failed gate and does not continue building a formal APK while a structural stop is unresolved.

## Design Coverage Matrix

| Design section | Implemented and proved by |
|---|---|
| §5 authority-separated state | Tasks 1–4, 16, 20 |
| §6 three time scales | Tasks 1, 5, 7, 19, 20 |
| §7 cognition-v3 | Tasks 4–7, 10–11 |
| §8 expression layer | Tasks 4, 6–8 |
| §9 deterministic/lived supervision | Tasks 8, 22–23 |
| §10 stage persona and memory | Tasks 6, 19–20 |
| §11 life system | Tasks 5, 11, 19, 21–23 |
| §12 all feature adapters | Tasks 5, 14–20, 21 |
| §13 lanes, cursor, transport stages, races, deduplication | Tasks 9–15, 17, 24 |
| §14 human quality evaluation | Tasks 21–22, 25 |
| §15 stable/candidate rollout | Tasks 2, 6, 11, 23, 27 |
| §16 migration | Tasks 0, 2–3, 20, 27 |
| §17 Android and formal release | Tasks 12–15, 24–26 |
| §18 rollback | Tasks 0, 23, 26–27 |
| §19 central stop protocol | Global Constraints and the stop section above |
| §20 completion evidence | Tasks 24–27 and checklist below |
| §21 explicit exclusions | Global Constraints, Tasks 1, 6, 16, 21–23 |

## Evidence Checklist Before Any “Finished” Claim

- [ ] Baseline report identifies immutable current stable evidence.
- [ ] PC v10→v11→v12→v13→v14 populated clone migration and production migration reports match their source database; v14 changes only canary-slot indexes/user version, old turns remain authority version 0, no historical receipt was invented, and every new canonical receipt has one manifest.
- [ ] All 270 protocol cases pass and are labeled non-quality evidence.
- [ ] 24×3 sentinel runs, 72×2 coverage runs, and 30 local-history runs are present.
- [ ] Six-dimensional gate and pairwise stable/candidate comparison are eligible.
- [ ] Every TurnKind and life planning has adapter, structured-domain, recovery, and rollout evidence.
- [ ] All 18 lane/delivery/retry/fallback/restart/head-of-line races pass.
- [ ] Android Room populated 10→11→12 migration, v1/v2/v3 fallback, event/poll/replay, v12 checkpoint redaction, and four delivery stages pass.
- [ ] Full Node and Android test suites pass.
- [ ] Production stable/candidate state is explicit; non-active kinds are listed.
- [ ] Formal APK package/version/signature/certificate/SHA-256 pass.
- [ ] OTA manifest resolves to the exact canonical release asset and identical APK hash.
- [ ] Covering installation over the prior formal APK succeeds.
- [ ] Database backup, prior stable release, prior APK, and per-kind rollback remain available.
