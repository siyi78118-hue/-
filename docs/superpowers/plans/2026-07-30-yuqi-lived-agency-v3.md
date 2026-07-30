# Yuqi Lived Agency v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This project uses one central execution window; do not dispatch overlapping writers for coupled runtime, database, Android, or release files.

**Goal:** Replace Yuqi's rule-accumulating cognition path with a versioned cognition-v3 agency model that understands whole interactions, can revise temporary attitudes, preserves every existing feature, arbitrates concurrent outputs, and ships through a truthful stable/candidate rollout with a formally signed OTA-capable APK.

**Architecture:** Keep one cognition core and provide small TurnKind adapters around it. Separate durable authority into hard constraints, non-binding preferences, and expiring current stances; generate a compact expression brief; validate hard actions deterministically; and commit the visible message group, structured actions, state patch, memory work, outbox, and interaction-lane revision atomically. Treat the current production pipeline as an immutable stable release and v3 as an immutable candidate release, with stable-visible shadow, candidate-visible canary, per-kind rollback, and evidence-bound quality gates.

**Tech Stack:** Node.js 22 ESM, `node:test`, SQLite via the existing runtime store, Markdown/JSON preset assets, Java 21, Android Room, Capacitor 8, WebView JavaScript, GitHub Actions/REST, Android `aapt`/`apksigner`.

**Authoritative design:** `docs/superpowers/specs/2026-07-30-yuqi-lived-agency-v3-design.md`

## Global Constraints

- The authoritative design above wins over older cognition-v2 plans wherever they conflict.
- Do not add production special cases for red packets, kisses, recharge jokes, or any individual sentence. Fix the general social-state mechanism.
- Preserve direct chat, payments, images, voice, emoji, quotes, multi-bubble batches, proactive chat, proactive moments, moment interaction/reply, role plans, life planning, relationship stages, memory, notifications, recovery, diagnostics, export/import/backup/delete, and Android fallback.
- Preserve the existing Android cloud-queue convergence state machine: `LOCAL_QUEUED → CLOUD_ACCEPTED/BRIDGE_WAITING → PC_ACCEPTED → COMPLETED → UI_APPLIED`. A cloud-accepted turn releases the single drain thread, is completed by inbox recovery, and is never re-enqueued merely because the app restarts.
- A user stages multiple bubbles and explicitly submits one complete batch. Never add a timer that waits for more user bubbles after submission.
- Keep ordinary visible replies near one minute; five minutes is the hard user-facing limit. Shadow comparison and consolidation never block the visible path.
- `responseRisks` are current-turn evidence only. They never become `forbiddenMoves`, hard constraints, preferences, or persistent stances.
- Only system/author/user authority may create a hard constraint. Yuqi's ordinary refusal, discomfort, or prior wording is a revisable stance, not a permanent rule.
- Relationship `base/phase` controls formal facts and commitments, not whether ordinary affection is allowed and not visible disclaimer text.
- State writes occur only in the same successful authority transaction as the visible result. Failed, superseded, duplicate, shadow, or uncommitted drafts write no character state or facts.
- Non-Yuqi characters remain on the existing path.
- Existing preset versions remain immutable. Add v3 as a new version; never overwrite `1.9.2` or `2.0.0`.
- Existing old turns resume with their pinned schema and pipeline fields. Only new turns use v3 release IDs and v3 state.
- The existing 270 fixtures are protocol regression evidence only. They do not count as human-chat quality evidence or live shadow evidence.
- Offline replay rows use replay/quality tables. Only real production comparisons may increment live shadow/canary counters.
- One SQLite row per TurnKind in `cognition_kind_rollouts` remains the current rollout authority. History tables are append-only audit, never current-state authority.
- Stable/candidate release IDs and checksums, not the old words `legacy/cognition`, decide which implementation is visible.
- Low-frequency TurnKinds without genuine live evidence remain shadow and must be reported as such. Do not claim that all kinds are active.
- PC runtime database migration is `user_version 9 → 10`; Android Room migration is `10 → 11`. Both must be transactional, idempotent, and covered by migration tests.
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
- `yuqi-runtime/src/quality-evaluator.mjs`: deterministic findings, six-dimensional evaluation normalization, blind comparison, and gate aggregation.

### Existing PC runtime modules to evolve

- `yuqi-runtime/src/store.mjs`: v9→v10 migration, release pins, authority records, lanes, quality evidence, atomic commit primitives, backup/export lifecycle.
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
normalizeCurrentStance(value, now) -> CurrentStance
applyStanceTransitions({ stances, transitions, relevantBatch, now }) -> {
  activeStances, changedRecords, auditRecords
}
compileAgencyView({ constraints, preferences, stances, featureContext, limits }) -> {
  hardConstraints, preferences, currentStances
}

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
commitVisibleResult({ store, turnId, laneKey, expectedTurnRevision, expectedLaneRevision,
  inputVisibilitySequence, authoritativeReleaseId, visibleGroup, actionSet,
  statePatch, memoryJobs, generationFingerprint, now }) -> CommitVisibleResult

// promotion-controller.mjs
resolvePipelinePair(rollout) -> {
  visibleReleaseId, comparisonReleaseId, comparisonDirection, candidatePhase
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
| `canary` | candidate release | stable release |
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
  assert.equal(result.changedRecords[0].status, 'superseded');
  assert.equal(result.activeStances[0].supersedes, 's1');
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

export function applyStanceTransitions({ stances, transitions, relevantBatch, now }) {
  validateTransitionCoverage(stances, transitions, relevantBatch);
  return reduceTransitionsAppendOnly({ stances, transitions, relevantBatch, now });
}

export function compileAgencyView({ constraints, preferences, stances, featureContext, limits }) {
  return rankAndLimitAgencyRecords({ constraints, preferences, stances, featureContext, limits });
}
```

The implementation must reject missing transition coverage for every relevant active stance, reject `maintain` without fresh evidence, expire by time before ranking, decrement only when the submitted batch is relevant, cap extensions at three new relevant batches, and preserve superseded/expired records for audit.

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
- Produces: PC schema v10; store methods named in the implementation block below.

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
  return contentHash({
    roleId: input.roleId, laneKey: input.laneKey, laneRevision: input.laneRevision,
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

### Task 10: Commit Visible Results and State Atomically

**Files:**
- Create: `yuqi-runtime/src/visible-result-commit.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/src/result-outbox.mjs`
- Create: `yuqi-runtime/test/visible-result-commit.test.mjs`
- Modify: `yuqi-runtime/test/result-outbox.test.mjs`

**Interfaces:**
- Consumes: an authorized draft, Task 9 lane claim, action target revisions, Task 1 stance patch.
- Produces: `commitVisibleResult()` and `store.commitVisibleResultInternal(input)`.

- [ ] **Step 1: Write red all-or-nothing and exactly-once tests**

```js
test('visible result, action, state, memory job, outbox, and lane revision commit together', () => {
  const result = commitVisibleResult(validCommitInput());
  assert.equal(result.committed, true);
  assert.equal(store.visibleGroupsFor('turn_1').length, 1);
  assert.equal(store.actionsFor('turn_1').length, 1);
  assert.equal(store.getCognitiveState('yuqi').schemaVersion, 2);
  assert.equal(store.memoryJobsFor('turn_1').length, 1);
  assert.equal(store.outboxFor('turn_1').length, 1);
  assert.equal(store.getInteractionLane('yuqi', 'private_chat').revision, 2);
});

for (const mutation of ['new_user_batch', 'lane_revision', 'action_target', 'retry_branch']) {
  test(`${mutation} conflict rolls back every visible side effect`, () => {
    const input = validCommitInput();
    mutateAuthority(input, mutation);
    assert.throws(() => commitVisibleResult(input), /authority conflict/);
    assert.deepEqual(countCommitSideEffects(store, 'turn_1'), allZeroCounts());
  });
}

test('repeated commit returns the same authority receipt without duplication', () => {
  const first = commitVisibleResult(validCommitInput());
  const second = commitVisibleResult(validCommitInput());
  assert.equal(second.commitChecksum, first.commitChecksum);
  assert.equal(store.visibleGroupsFor('turn_1').length, 1);
});
```

- [ ] **Step 2: Run commit tests red**

Run: `node --test yuqi-runtime/test/visible-result-commit.test.mjs`

Expected: FAIL on missing commit module.

- [ ] **Step 3: Implement one transaction boundary**

```js
export function commitVisibleResult(input) {
  return input.store.transaction(() => {
    const authority = input.store.readCommitAuthority(input.turnId, input.laneKey);
    assertTurnRevision(authority, input.expectedTurnRevision);
    assertLaneRevision(authority, input.expectedLaneRevision);
    assertReleasePin(authority, input.authoritativeReleaseId);
    assertNoNewerUserBatch(authority, input.inputVisibilitySequence);
    assertActionTargets(authority, input.actionSet);
    assertRetryLineage(authority, input.turnId);
    assertFingerprintAuthority(authority, input.generationFingerprint);
    return input.store.commitVisibleResultInternal({
      ...input,
      statePatch: validateStatePatchAgainstAgency(input.statePatch, authority),
      commitChecksum: contentHash(canonicalCommitPayload(input))
    });
  });
}
```

`commitVisibleResultInternal()` inserts the visible reply group, authorized action rows, new cognitive snapshot/stance revisions, evidence-memory jobs, one outbox group, and the lane revision before marking the turn committed. All tables use unique authority keys so exact retry returns the existing receipt. Shadow results call no part of this function.

- [ ] **Step 4: Run commit/outbox/store tests green**

Run:

```powershell
node --test yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs yuqi-runtime/test/protocol-store.test.mjs
```

Expected: PASS; forced failure at each insert point leaves no partial rows.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/visible-result-commit.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/result-outbox.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/result-outbox.test.mjs
git commit -m "feat: commit Yuqi visible results and state atomically"
```

### Task 11: Integrate v3, Lanes, Shadow, and Recovery in the Runtime

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/turn-dispatcher.mjs`
- Modify: `yuqi-runtime/src/shadow-dispatcher.mjs`
- Modify: `yuqi-runtime/src/life-planning-dispatcher.mjs`
- Modify: `yuqi-runtime/src/reconcile.mjs`
- Modify: `yuqi-runtime/src/cloud-relay-pump.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Modify: `yuqi-runtime/test/turn-dispatcher.test.mjs`
- Modify: `yuqi-runtime/test/shadow-dispatcher.test.mjs`
- Modify: `yuqi-runtime/test/life-planning-attempt.test.mjs`
- Create: `yuqi-runtime/test/v3-runtime-recovery.test.mjs`

**Interfaces:**
- Consumes: Tasks 2, 7, 9, and 10.
- Produces: one release-pinned execution path for all ten rollout keys; background comparisons created only after authoritative result checksums exist.

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
});
```

- [ ] **Step 2: Run runtime integration tests red**

Run:

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
```

Expected: FAIL because release IDs/lanes are not wired into execution.

- [ ] **Step 3: Route every new turn through the authoritative release pair**

```js
const rollout = promotionController.getStatus(envelope.kind);
const pair = promotionController.resolvePipelinePair(rollout);
const turn = store.createTurnWithReleasePinInternal({
  envelope,
  rolloutKey: envelope.kind,
  authoritativeReleaseId: pair.visibleReleaseId,
  comparisonReleaseId: pair.comparisonReleaseId,
  comparisonDirection: pair.comparisonDirection,
  laneKey: laneKeyForEnvelope(envelope),
  expectedLaneRevision: lane.revision,
  inputVisibilitySequence: envelope.context.visibilityCursor.localSequence
});
const execution = await executePinnedRelease(turn);
const receipt = commitVisibleResult(toCommitInput(execution));
if (turn.comparisonReleaseId) {
  store.createComparisonJobAfterAuthorityInternal({
    subjectType: 'turn',
    subjectId: turn.turnId,
    authoritativeResultChecksum: receipt.commitChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    comparisonReleaseId: turn.comparisonReleaseId
  });
}
```

The compare worker is dry-run: it can write only comparison/quality rows. It cannot call action stores, visible commit, outbox, notification, state, fact, or consolidation APIs. Life planning retains two phases: attempt creation fixes release/epoch/checksum/canary slot/input; result commit creates comparison work in the same transaction. Outstanding canary count includes attempts allocated before the comparison job exists.

- [ ] **Step 4: Run all runtime integration tests green**

Run:

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
```

Expected: PASS; recovered old v2 turns still use the old branch; recovered new turns never adopt a later rollout change.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/turn-dispatcher.mjs yuqi-runtime/src/shadow-dispatcher.mjs yuqi-runtime/src/life-planning-dispatcher.mjs yuqi-runtime/src/reconcile.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/v3-runtime-recovery.test.mjs
git commit -m "feat: integrate v3 release execution and recovery"
```

### Task 12: Persist Android Conversation Visibility Cursors

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/db/ConversationCursorEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Create: `android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: native completion and existing successful DOM `uiAppliedAt` acknowledgement.
- Produces: Room v11; plugin methods `getConversationCursor` and existing acknowledgement methods updating the cursor.

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
    assertTrue(hasColumn(db, "chat_turns", "visibleGroupId"));
    assertTrue(hasColumn(db, "chat_turns", "pipelineReleaseId"));
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
    public boolean chatOpen;
    public long updatedAt;
}

static final Migration MIGRATION_10_11 = new Migration(10, 11) {
    @Override public void migrate(@NonNull SupportSQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS `conversation_cursors` (" +
            "`characterId` TEXT NOT NULL, `nativeCompletedTurnId` TEXT, " +
            "`nativeCompletedGroupId` TEXT, `nativeCompletedSequence` INTEGER NOT NULL, " +
            "`uiAppliedTurnId` TEXT, `uiAppliedGroupId` TEXT, " +
            "`uiAppliedSequence` INTEGER NOT NULL, `localSequence` INTEGER NOT NULL, " +
            "`chatOpen` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, " +
            "PRIMARY KEY(`characterId`))");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `visibleGroupId` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `laneKey` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `laneRevision` INTEGER");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `generationFingerprint` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `pipelineReleaseId` TEXT");
        db.execSQL("ALTER TABLE `chat_turns` ADD COLUMN `bridgeCommitChecksum` TEXT");
    }
};
```

Add nullable matching fields to `ChatTurnEntity`. Task 13 fills them from the validated BridgeResult; old v10 turns retain null and continue using turn ID for legacy deduplication. DAO updates must use one transaction and update only when incoming `localSequence >= stored.localSequence`. `nativeCompleted` is written after the native reply group is durably complete; `uiApplied` only after Web confirms exact DOM landing. `getConversationCursor({characterId})` returns all fields even when null.

- [ ] **Step 4: Run Android Room tests green**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest assembleDebugAndroidTest connectedDebugAndroidTest --no-daemon --no-problems-report
```

Expected: PASS on an attached device/emulator; migration retains all v10 rows and repeated acknowledgements create one cursor. Merely compiling the instrumentation APK is not migration evidence. If no device/emulator can execute the migration test, stop and report the missing validation environment before formal release.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/db/ConversationCursorEntity.java android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/ExecutionStore.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "feat: persist Android conversation visibility cursor"
```

### Task 13: Carry Visibility and Visible-Group Authority Through the Bridge

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnSubmission.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java`
- Modify: `tests/payment-batch-bridge-contract.test.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Consumes: Task 12 cursor and the existing complete user batch.
- Produces: protocol v3 `context.visibilityCursor`; result `visibleGroupId`, `laneKey`, `laneRevision`, `generationFingerprint`.

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
    assertTrue(cursor.getBoolean("chatOpen"));
}
```

```js
test('protocol v3 rejects an impossible visibility cursor', () => {
  const envelope = validProtocolV3Envelope();
  envelope.context.visibilityCursor.uiAppliedSequence = 9;
  envelope.context.visibilityCursor.nativeCompletedSequence = 8;
  assert.throws(() => normalizeEnvelope(envelope), /uiApplied.*nativeCompleted/);
});
```

- [ ] **Step 2: Run focused bridge tests red**

Run:

```powershell
node --test tests/payment-batch-bridge-contract.test.mjs yuqi-runtime/test/protocol-store.test.mjs
cd android
.\gradlew.bat testDebugUnitTest --tests "*BridgeInputTest" --tests "*RoomBridgeMirrorTest" --no-daemon --no-problems-report
```

Expected: FAIL on missing cursor/group fields.

- [ ] **Step 3: Add the exact protocol payload**

```json
{
  "protocolVersion": 3,
  "context": {
    "visibilityCursor": {
      "nativeCompletedTurnId": "turn-id-or-null",
      "nativeCompletedGroupId": "group-id-or-null",
      "nativeCompletedSequence": 12,
      "uiAppliedTurnId": "turn-id-or-null",
      "uiAppliedGroupId": "group-id-or-null",
      "uiAppliedSequence": 11,
      "localSequence": 13,
      "chatOpen": true,
      "quotedMessageId": "message-id-or-null"
    }
  }
}
```

Protocol normalization accepts v2 without a cursor for old installed clients and synthesizes an `unknown` visibility state. V3 requires the cursor, verifies UI sequence is not ahead of native completion, and retains every current-batch message. Bridge results return:

```json
{
  "visibleGroupId": "reply-group-id",
  "laneKey": "private_chat",
  "laneRevision": 8,
  "generationFingerprint": "sha256",
  "releaseId": "release-id",
  "commitChecksum": "sha256"
}
```

`RoomBridgeMirror` writes those five authority fields plus the bridge commit checksum to the same `ChatTurnEntity` completion transaction before advancing `nativeCompleted`. A restart reconstructs the exact group/release/fingerprint from Room; it must not generate a new group ID from current content.

- [ ] **Step 4: Run bridge tests green**

Run the Step 2 commands again.

Expected: PASS for v2 compatibility, v3 validation, complete batches, payment order, and mirror replay.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/TurnSubmission.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java android/app/src/main/java/com/siyi/al/execution/bridge/BridgeResult.java android/app/src/main/java/com/siyi/al/execution/bridge/RoomBridgeMirror.java android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java android/app/src/test/java/com/siyi/al/execution/bridge/RoomBridgeMirrorTest.java tests/payment-batch-bridge-contract.test.mjs yuqi-runtime/src/protocol.mjs yuqi-runtime/test/protocol-store.test.mjs
git commit -m "feat: carry visible conversation authority through bridge"
```

### Task 14: Add v3 Android Fallback Without Breaking v1/v2

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/FallbackCognitionPacketCodec.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/FallbackCognitionPacketCodecTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/LiveReplyQualityGate.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/LiveReplyQualityGateTest.java`

**Interfaces:**
- Consumes: `cognition-v3`, `cognition-v2`, `memory-v1`, and `chat-v1` snapshots.
- Produces: `FallbackCognitionPacketCodec.decode(JSONObject) -> FallbackContext`; v3 fallback request/response parsing.

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
```

- [ ] **Step 2: Run Android unit tests red**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest --tests "*FallbackCognitionPacketCodecTest" --tests "*ExecutionEngineTest" --tests "*LiveReplyQualityGateTest" --no-daemon --no-problems-report
```

Expected: FAIL because v3 is currently rejected.

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

`NativeModelGateway` delegates parsing to the codec, sends a compact cognition request before expression for v3, and enforces the same structured-action targets as PC. Fallback receives relevant hard constraints, at most two current stances, base/phase, recent complete groups, and allowed actions. Fallback-created facts are marked `pending_review`; it never overwrites a PC state record or rewrites a result already visible.

- [ ] **Step 4: Run Android fallback tests green**

Run the Step 2 command.

Expected: PASS for all four contracts; v3 invalid action targets fail before any local commit.

- [ ] **Step 5: Commit**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/FallbackCognitionPacketCodec.java android/app/src/test/java/com/siyi/al/execution/FallbackCognitionPacketCodecTest.java android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java android/app/src/main/java/com/siyi/al/execution/ExecutionEngine.java android/app/src/main/java/com/siyi/al/execution/LiveReplyQualityGate.java android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java android/app/src/test/java/com/siyi/al/execution/LiveReplyQualityGateTest.java
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

async function getYuqiVisibilityCursor(characterId) {
  return withTimeout(
    AlExecution.getConversationCursor({ characterId }),
    3000,
    unknownVisibilityCursor(characterId)
  );
}
```

`queueAndroidUserReply()` reads the cursor, then builds one task from the already-complete submitted batch. Event, poll, reload replay, and notification-open all enter the existing bounded single-flight reconciler. DOM insertion is keyed by `visibleGroupId`; only after every bubble in that group exists does Web call `markUiApplied`. A timed-out plugin Promise releases its lock in `finally` and leaves Room unacknowledged for later replay.

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
- Modify: `yuqi-runtime/src/interaction-contract.mjs`
- Modify: `yuqi-runtime/src/cognitive-state.mjs`
- Modify: `yuqi-runtime/src/image-attachments.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/interaction-contract.test.mjs`
- Modify: `yuqi-runtime/test/cognitive-state.test.mjs`
- Modify: `yuqi-runtime/test/image-attachments.test.mjs`
- Create: `yuqi-runtime/test/direct-reply-v3-features.test.mjs`
- Modify: `tests/payment-batch-bridge-contract.test.mjs`

**Interfaces:**
- Consumes: v3 direct adapter, authoritative payment/media/quote objects.
- Produces: general direct-interaction behavior with payment action separated from social response.

- [ ] **Step 1: Write red end-to-end feature tests**

```js
test('a later playful gift can change a prior soft stance without changing payment authority', async () => {
  await sendBatch([{ id: 'u1', type: 'payment', amount: 50, text: '给你买奶茶' }]);
  await commitStance({ topic: 'gift_play', position: 'not accepting another today',
    strength: 0.5, flexibility: 0.8, remainingRelevantUserBatches: 2 });
  const result = await sendBatch([
    { id: 'u2', type: 'payment', amount: 100, text: '充值亲亲' },
    { id: 'u3', type: 'text', text: '这次总能收了吧' }
  ]);
  assert.equal(result.cognition.interactionDecision.shouldAcknowledgeBid, true);
  assert.ok(['accept', 'reject', 'wait'].includes(result.actions.payment.action));
  assert.ok(result.cognition.selfResponse.stanceTransitions
    .some(x => ['soften', 'reverse', 'maintain'].includes(x.operation)));
  assert.doesNotMatch(result.visibleText, /阶段|规则|兑换|交易成立|还没到/);
});

test('risks do not become persistent forbidden moves', () => {
  const contract = compileInteractionContract({
    responseRisks: ['may sound transactional'],
    hardConstraints: [], currentStances: []
  });
  assert.deepEqual(contract.forbiddenMoves, []);
  assert.equal(JSON.stringify(nextTurnState(contract)).includes('may sound transactional'), false);
});

test('ordered batch keeps image quote voice emoji payment and text evidence', async () => {
  const result = await sendBatch(mixedMediaBatch());
  assert.deepEqual(result.cognition.interactionRead.evidenceMessageIds,
    mixedMediaBatch().map(x => x.id));
  assert.equal(materializationCount('image-1'), 1);
  assert.equal(result.input.messages.find(x => x.type === 'voice').transcript, null);
  assert.equal(result.input.messages.find(x => x.type === 'quote').quotedSpeaker, 'assistant');
});
```

- [ ] **Step 2: Run direct feature tests red**

Run:

```powershell
node --test yuqi-runtime/test/direct-reply-v3-features.test.mjs yuqi-runtime/test/interaction-contract.test.mjs yuqi-runtime/test/cognitive-state.test.mjs yuqi-runtime/test/image-attachments.test.mjs tests/payment-batch-bridge-contract.test.mjs
```

Expected: FAIL because risks still feed forbidden moves and v3 feature integration is incomplete.

- [ ] **Step 3: Remove the risk-to-rule path and integrate feature authority**

```js
export function deriveForbiddenMoves({ hardConstraints = [], actionAuthority = {} }) {
  return [
    ...hardConstraints.filter(isApplicableActiveConstraint).map(toForbiddenMove),
    ...deterministicActionProhibitions(actionAuthority)
  ];
}

export function compileCurrentTurnAdvisories({ responseRisks = [], ambiguities = [] }) {
  return { responseRisks: structuredClone(responseRisks), ambiguities: structuredClone(ambiguities),
    persistence: 'none' };
}
```

Delete the merge from `responseRisks` into `forbiddenMoves`. New v3 turns do not write `activeBoundaries`; old v2 resume continues to read its frozen checkpoint. Payment validation locks message ID, kind, amount, currency, payer/payee, current status, refund, and wallet effects, while cognition independently decides the social response. Image materialization remains exactly once. Voice without transcript remains unknown. Emoji gets no fixed emotion mapping. Quotes retain original speaker/message ID. Visible multi-bubbles share one authority group and commit checksum.

- [ ] **Step 4: Run direct feature tests green**

Run the Step 2 command.

Expected: PASS; the test allows Yuqi to accept or reject but rejects policy leakage, frozen stance, dropped social bid, wrong payment target, invented media content, or missing batch evidence.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/interaction-contract.mjs yuqi-runtime/src/cognitive-state.mjs yuqi-runtime/src/image-attachments.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/interaction-contract.test.mjs yuqi-runtime/test/cognitive-state.test.mjs yuqi-runtime/test/image-attachments.test.mjs yuqi-runtime/test/direct-reply-v3-features.test.mjs tests/payment-batch-bridge-contract.test.mjs
git commit -m "feat: integrate direct social and structured interactions"
```

### Task 17: Integrate Proactive Chat With Motive and Collision Semantics

**Files:**
- Modify: `yuqi-runtime/src/route-policy.mjs`
- Modify: `yuqi-runtime/src/life-simulation.mjs`
- Modify: `yuqi-runtime/src/turn-dispatcher.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/test/turn-dispatcher.test.mjs`
- Create: `yuqi-runtime/test/proactive-chat-v3.test.mjs`
- Modify: `tests/yuqi-cognition-feature-matrix.test.mjs`

**Interfaces:**
- Consumes: life changes, open threads, mood/attention, commitments, real user hard boundaries, Task 9 lane.
- Produces: proactive candidate motive and either intentional skip or committed message; no forced send.

- [ ] **Step 1: Write red motive, silence, and direct-collision tests**

```js
test('scheduler permits consideration but cannot force a message', async () => {
  const result = await runProactive({ lifeSignals: [], openThreads: [], commitments: [] });
  assert.equal(result.action, 'skip');
  assert.equal(result.reasonCode, 'NO_LIVED_MOTIVE');
});

test('proactive message requires a source motive and independent visible content', async () => {
  const result = await runProactive({
    lifeSignals: [{ id: 'life-7', type: 'finished_photo_roll', delivered: true }],
    openThreads: [{ id: 'thread-2', topic: 'user presentation' }]
  });
  assert.equal(result.action, 'send');
  assert.ok(result.cognition.motiveEvidenceIds.includes('life-7')
    || result.cognition.motiveEvidenceIds.includes('thread-2'));
});

test('a user batch supersedes an uncommitted proactive result without quality penalty', async () => {
  const proactive = beginSlowProactive();
  const direct = await submitDirectBatch([{ id: 'u9', text: '在吗' }]);
  await proactive;
  assert.equal(store.getTurn(proactive.turnId).state, 'superseded_by_user_batch');
  assert.equal(store.visibleGroupsFor(proactive.turnId).length, 0);
  assert.equal(store.qualityFindingsFor(proactive.turnId).length, 0);
  assert.equal(direct.visible, true);
});
```

- [ ] **Step 2: Run proactive tests red**

Run: `node --test yuqi-runtime/test/proactive-chat-v3.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs`

Expected: FAIL until motives and lane supersession are connected.

- [ ] **Step 3: Implement motive candidates and authority recheck**

```js
function proactiveMotiveCandidates(context) {
  return [
    ...deliveredLifeChanges(context),
    ...dueCommitments(context),
    ...openThreads(context),
    ...currentEmotionOrAttention(context),
    ...specificCuriosity(context)
  ].filter(hasSourceEvidence);
}

async function executeProactiveChat(turn) {
  const motives = proactiveMotiveCandidates(await loadProactiveContext(turn));
  const execution = await executePinnedRelease({ ...turn, motives });
  if (execution.draft.action === 'skip') return commitLegalAutomaticSkip(turn, execution);
  return commitVisibleResult(revalidateProactiveLane(execution));
}
```

Structural silence reads active user/system hard constraints only. It cannot interpret Yuqi's temporary refusal as a ban on future initiative. A skip is valid without a message when no lived motive exists. A direct collision supersedes before commit and consumes neither normal skip budget nor notification.

- [ ] **Step 4: Run proactive and matrix tests green**

Run the Step 2 command.

Expected: PASS; no proactive/direct duplicate fingerprint becomes visible.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/route-policy.mjs yuqi-runtime/src/life-simulation.mjs yuqi-runtime/src/turn-dispatcher.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/test/proactive-chat-v3.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs
git commit -m "feat: ground proactive chat in lived motives"
```

### Task 18: Integrate Public Moments and Moment Threads

**Files:**
- Modify: `yuqi-runtime/src/cognition-v3-adapters.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/social-experience.mjs`
- Create: `yuqi-runtime/test/moments-v3.test.mjs`
- Modify: `tests/yuqi-cognition-feature-matrix.test.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: committed public life events, exact moment/comment/thread targets, privacy constraints.
- Produces: authorized public post/like/comment/reply/skip with lane-specific commit.

- [ ] **Step 1: Write red public-privacy and target-integrity tests**

```js
test('proactive moment needs a committed public-safe life event', async () => {
  const skipped = await runKind('PROACTIVE_MOMENT', {
    lifeEvents: [{ id: 'e1', state: 'draft', privacy: 'public' }]
  });
  assert.equal(skipped.action, 'skip');
  const sent = await runKind('PROACTIVE_MOMENT', {
    lifeEvents: [{ id: 'e2', state: 'committed', privacy: 'public' }]
  });
  assert.equal(sent.action, 'post');
  assert.deepEqual(sent.evidenceIds, ['e2']);
});

test('public content cannot reveal private chat payment or unannounced relationship', async () => {
  const result = await runKind('PROACTIVE_MOMENT', privateLeakContext());
  assert.doesNotMatch(result.visibleText, /100元|充值亲亲|我们已经在一起/);
});

test('moment reply is locked to the triggering moment and comment', async () => {
  const result = await runKind('MOMENT_REPLY', exactThreadContext());
  assert.equal(result.action.momentId, 'moment-7');
  assert.equal(result.action.replyToCommentId, 'comment-9');
  assert.throws(() => commitChangedTarget(result, 'comment-10'), /authority conflict/);
});
```

- [ ] **Step 2: Run moment tests red**

Run: `node --test yuqi-runtime/test/moments-v3.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs tests/yuqi-ui-contract.test.mjs`

Expected: FAIL on missing v3 moment integration.

- [ ] **Step 3: Implement public-safe feature context and exact action targets**

```js
function proactiveMomentFeatureContext(input) {
  return {
    committedLifeEvents: input.lifeEvents.filter(event =>
      event.state === 'committed' && event.privacy === 'public'),
    publicPrivacy: compilePublicPrivacyRules(input)
  };
}

function momentInteractionFeatureContext(input) {
  return {
    targetMoment: requireExactMoment(input),
    targetComment: optionalExactComment(input),
    thread: exactVisibleThread(input)
  };
}
```

Only committed public-safe facts reach expression. The program layer locks moment/comment IDs and public/private permissions. `moment_interaction:<momentId>` lanes allow unrelated moments to proceed independently while serializing the same thread.

- [ ] **Step 4: Run moments tests green**

Run the Step 2 command.

Expected: PASS for `PROACTIVE_MOMENT`, `MOMENT_INTERACTION`, `MOMENT_REPLY`, `ROLE_PLAN_MOMENT`, and `ROLE_PLAN_MOMENT_PRIVATE` matrix rows.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/cognition-v3-adapters.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/social-experience.mjs yuqi-runtime/test/moments-v3.test.mjs tests/yuqi-cognition-feature-matrix.test.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: integrate public-safe moment cognition"
```

### Task 19: Integrate Role Plans, Life Planning, and Formal Relationship Stages

**Files:**
- Modify: `yuqi-runtime/src/relationship-stage.mjs`
- Modify: `yuqi-runtime/src/life-planning-dispatcher.mjs`
- Modify: `yuqi-runtime/src/life-simulation.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/cognition-v3-adapters.mjs`
- Modify: `yuqi-runtime/test/relationship-stage.test.mjs`
- Modify: `yuqi-runtime/test/life-planning-attempt.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`
- Create: `yuqi-runtime/test/role-plan-life-stage-v3.test.mjs`
- Modify: `tests/role-plan-domain.test.mjs`
- Modify: `tests/role-plan-repository.test.mjs`

**Interfaces:**
- Consumes: exact role-plan occurrence/schedule, life basis checksum, base/phase graph and evidence.
- Produces: v3 role-plan operations, two-phase life attempts, formal-only stage review.

- [ ] **Step 1: Write red plan/life/stage consistency tests**

```js
test('visible role-plan reply and operation cannot contradict', async () => {
  const result = await runRolePlan({ userText: '明天下午提醒我', now: fixedNow });
  assert.equal(result.operation.op, 'create');
  assert.equal(result.operation.schedule.at, '2026-07-31T15:00:00+08:00');
  assert.match(result.visibleText, /明天下午|三点/);
});

test('unclear time cannot be guessed into a structured schedule', async () => {
  const result = await runRolePlan({ userText: '过几天提醒我' });
  assert.equal(result.operation, null);
  assert.match(result.visibleText, /哪天|什么时候/);
});

test('life planning fixes basis and creates compare only after result commit', async () => {
  const attempt = createLifeAttempt();
  assert.ok(attempt.lifeBasisChecksum);
  assert.equal(store.getComparisonJobForLife(attempt.planningId), null);
  commitLifeResult(attempt, ordinaryLifeResult());
  assert.ok(store.getComparisonJobForLife(attempt.planningId));
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
```

- [ ] **Step 2: Run plan/life/stage tests red**

Run:

```powershell
node --test yuqi-runtime/test/role-plan-life-stage-v3.test.mjs yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs
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

Do not pass stage thresholds, transition graph labels, or “allowed affection” flags to expression. Preserve user-edited stage-persona text and revision; compile ordinary wording such as “克制、不太主动” into tone tendencies, and compile only explicitly author-marked non-negotiable settings into author hard constraints. Role-plan operations remain the existing closed domain `create/update/cancel/pause/resume/complete` and `private_message/moment_post/role_schedule`; targets, evidence, and time validate deterministically. Life attempt creation fixes rollout/release/epoch/checksums/canary slot/input but creates no compare job. Authoritative result commit creates the compare job in the same transaction. Failed authority creates no compare job; active/canary failure routes to the controller. Chat life adjustments and visible wording must agree.

- [ ] **Step 4: Run all plan/life/stage tests green**

Run the Step 2 command.

Expected: PASS for schedule recovery, role-plan history, life restart, base/phase evidence, and no routine stage leakage.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/relationship-stage.mjs yuqi-runtime/src/life-planning-dispatcher.mjs yuqi-runtime/src/life-simulation.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/src/cognition-v3-adapters.mjs yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/role-plan-life-stage-v3.test.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs
git commit -m "feat: integrate plans life and formal relationship stages"
```

### Task 20: Constrain Memory Consolidation and Complete Data Lifecycle

**Files:**
- Modify: `yuqi-runtime/src/consolidation-worker.mjs`
- Modify: `yuqi-runtime/src/evidence-memory.mjs`
- Modify: `yuqi-runtime/src/retrieval.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `yuqi-runtime/test/consolidation-worker.test.mjs`
- Modify: `yuqi-runtime/test/evidence-memory.test.mjs`
- Create: `yuqi-runtime/test/agency-data-lifecycle.test.mjs`
- Modify: `scripts/backup-yuqi-memory.mjs`
- Modify: `scripts/audit-yuqi-memory.mjs`

**Interfaces:**
- Consumes: committed visible results and source evidence only.
- Produces: evidence-only facts/preferences/events; explicit new-table behavior for backup/export/import/clear/delete.

- [ ] **Step 1: Write red memory allowlist and lifecycle tests**

```js
test('consolidation rejects inferred motives mood stances and unsent drafts', () => {
  for (const candidate of [
    memory('user_trait', '用户其实害怕被抛弃'),
    memory('mood', '虞栖现在心软了'),
    memory('current_stance', '今天不收第二次红包'),
    memory('draft', '未送达的一句话'),
    memory('supervisor', '这轮像真人')
  ]) assert.throws(() => validateConsolidationCandidate(candidate), /not persistable/);
});

test('committed facts commitments events and repeated preferences are allowed with evidence', () => {
  for (const candidate of validMemoryCandidates()) {
    assert.doesNotThrow(() => validateConsolidationCandidate(candidate));
    assert.ok(candidate.sourceMessageIds.length || candidate.sourceActionIds.length);
  }
});

test('clear operations affect exactly their declared v10 tables', () => {
  const matrix = lifecycleMatrix();
  assert.deepEqual(matrix.clearAutomaticTasks.deletedTables.sort(),
    ['automatic_tasks', 'comparison_jobs'].sort());
  assert.equal(matrix.clearAutomaticTasks.preservedTables.includes('stance_records'), true);
  assert.equal(matrix.clearChat.deletedTables.includes('interaction_lanes'), true);
  assert.equal(matrix.clearChat.revisionActions.constraint_records,
    'archive_when_sole_message_evidence_is_deleted');
  assert.equal(matrix.clearMemory.deletedTables.includes('constraint_records'), false);
  assert.equal(matrix.deleteRole.deletedTables.includes('constraint_records'), true);
});
```

- [ ] **Step 2: Run memory/lifecycle tests red**

Run:

```powershell
node --test yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs
```

Expected: FAIL because v10 records are not yet classified by lifecycle.

- [ ] **Step 3: Implement memory allowlist and explicit lifecycle matrix**

```js
const PERSISTABLE_MEMORY_TYPES = new Set([
  'user_fact', 'delivered_yuqi_life_fact', 'formal_commitment',
  'retrievable_event', 'stable_preference', 'fact_conflict', 'fact_supersession'
]);

export function validateConsolidationCandidate(candidate) {
  if (!PERSISTABLE_MEMORY_TYPES.has(candidate.type)) throw new Error('memory type is not persistable');
  if (!hasAuthoritativeDeliveredEvidence(candidate)) throw new Error('memory lacks delivered evidence');
  if (candidate.type === 'stable_preference' && independentEvidenceCount(candidate) < 2) {
    throw new Error('stable preference lacks repeated independent evidence');
  }
  return candidate;
}
```

Implement and test this table:

| operation | constraints | stances | cognitive snapshot | lanes | releases/rollout | quality/audit |
|---|---|---|---|---|---|---|
| backup/export | include | include | include | include | include | include |
| import | merge by immutable ID/revision | merge | replace only if newer valid revision | rebuild safe cursor state | preserve local authority unless explicit full restore | append |
| clear automatic tasks | preserve | preserve | preserve | preserve | preserve | preserve |
| clear chat | preserve system/author; archive user constraints whose sole evidence is deleted | expire evidence-dependent stances | remove chat-derived fast state | delete/reinitialize | preserve | preserve |
| clear memory | preserve system/author and explicit user boundaries | expire memory-dependent stances | rebuild from persona/stage | preserve cursor | preserve | preserve |
| delete Yuqi role | delete role rows | delete | delete | delete | keep global release definitions; delete role rollout state | retain redacted audit |

Withdrawn/deleted messages are removed from future retrieval; dependent stance/constraint records become released/archived through a new revision rather than being physically rewritten. Non-Yuqi lifecycle remains unchanged.

- [ ] **Step 4: Run memory, lifecycle, and backup audit tests green**

Run:

```powershell
node --test yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs
node scripts/audit-yuqi-memory.mjs yuqi-runtime/config.json
```

Expected: PASS; audit reports all v10 tables and no dangling message evidence.

- [ ] **Step 5: Commit**

```powershell
git add yuqi-runtime/src/consolidation-worker.mjs yuqi-runtime/src/evidence-memory.mjs yuqi-runtime/src/retrieval.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/test/agency-data-lifecycle.test.mjs scripts/backup-yuqi-memory.mjs scripts/audit-yuqi-memory.mjs
git commit -m "feat: constrain Yuqi memory and agency lifecycle"
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

The replay runner writes `cognition_replay_runs.source_type='fixture'`; local history writes `source_type='local_history'`. Neither code path may call `putCognitionShadowRunInternal()` or increment rollout live counters.

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

- [ ] **Step 5: Extract 30 local real-history scenes without committing private content**

```js
export function selectRealHistoryScenes({ store, limit = 30 }) {
  return diversifyByFailureStructure(
    store.listReplayEligibleTurns({ rolloutKey: 'DIRECT_REPLY', limit: 200 }),
    {
      limit,
      requiredStructures: [
        'social_bid', 'temporary_stance', 'stage_leak', 'proactive_collision',
        'payment', 'repair', 'time_gap', 'multi_bubble', 'media_or_quote'
      ]
    }
  ).map(redactIdentifiersButKeepSemantics);
}
```

Write them to `artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl`; add that private directory to `.gitignore`. Preserve exact semantic text locally because replacing it with numbered dummy text would destroy evaluation value. Record a SHA-256 and counts in the public report, never raw private content.

- [ ] **Step 6: Compile and verify both suites**

Run:

```powershell
node scripts/compile-yuqi-lived-quality-scenes.mjs --check
node scripts/extract-yuqi-real-history-scenes.mjs --config yuqi-runtime/config.json --limit 30 --out artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl
node --test tests/yuqi-lived-quality-contract.test.mjs yuqi-runtime/test/replay-runner.test.mjs
npm run cognition:replay
npm run cognition:replay-report
```

Expected: 270 protocol cases PASS; 24 sentinel and 72 coverage scenes validate; exactly 30 local history scenes exist; live shadow counts remain unchanged before/after these commands.

- [ ] **Step 7: Commit public suite and tooling only**

```powershell
git add tests/fixtures/yuqi-cognition-protocol-v1 tests/fixtures/yuqi-lived-quality-v1 scripts/generate-yuqi-replay-fixtures.mjs scripts/run-yuqi-cognition-replay.mjs scripts/report-yuqi-cognition-replay.mjs scripts/compile-yuqi-lived-quality-scenes.mjs scripts/extract-yuqi-real-history-scenes.mjs yuqi-runtime/src/replay-runner.mjs yuqi-runtime/test/replay-runner.test.mjs tests/yuqi-lived-quality-contract.test.mjs .gitignore
git commit -m "test: separate protocol and lived quality evidence"
```

### Task 22: Implement Repeated Blind Quality Evaluation and Hard Gates

**Files:**
- Create: `yuqi-runtime/src/quality-evaluator.mjs`
- Modify: `yuqi-runtime/src/comparison-evaluator.mjs`
- Create: `yuqi-runtime/test/quality-evaluator.test.mjs`
- Modify: `yuqi-runtime/test/comparison-evaluator.test.mjs`
- Create: `scripts/run-yuqi-lived-quality-replay.mjs`
- Create: `scripts/report-yuqi-lived-quality.mjs`
- Modify: `package.json`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/quality-report.json`

**Interfaces:**
- Consumes: Task 21 suites; immutable stable/candidate release IDs.
- Produces: deterministic findings, blinded model scores, pairwise preference, disagreement queue, materialized gate report.

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
  const summary = summarizeEvidence(evidence);
  const failedGates = [
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
node --test yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/comparison-evaluator.test.mjs
npm run cognition:quality:check
npm run cognition:quality:replay -- --stable-from artifacts/yuqi-lived-agency-v3/baseline.json --candidate-preset 2.1.0
npm run cognition:quality:report -- --out artifacts/yuqi-lived-agency-v3/quality-report.json
```

Expected: tests PASS. The report records all 72 sentinel runs, 144 coverage runs, 30 history runs, all six dimension aggregates, pairwise rates, severe findings, structural results, release/checksum IDs, and `eligible`. If `eligible=false`, stop before registering a production candidate; do not weaken gates.

- [ ] **Step 6: Commit**

```powershell
git add yuqi-runtime/src/quality-evaluator.mjs yuqi-runtime/src/comparison-evaluator.mjs yuqi-runtime/test/quality-evaluator.test.mjs yuqi-runtime/test/comparison-evaluator.test.mjs scripts/run-yuqi-lived-quality-replay.mjs scripts/report-yuqi-lived-quality.mjs package.json
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
- Consumes: Task 2 release rows; Task 22 materialized report; live shadow/canary rows only.
- Produces: exact Cross-Task Interface rollout methods and CLI commands.

- [ ] **Step 1: Write red release-pair, evidence, canary, and rollback tests**

```js
test('registering candidate requires immutable release and eligible materialized report', () => {
  assert.throws(() => controller.registerCandidate({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: 1,
    releaseId: 'r3', reportId: 'bad', reportChecksum: 'wrong'
  }), /eligible materialized quality report/);
});

test('replay rows never satisfy live shadow gate', () => {
  insertReplaySuccesses('DIRECT_REPLY', 300);
  assert.equal(controller.promotionCheck('DIRECT_REPLY').liveShadowSuccessCount, 0);
});

test('canary pins candidate visible and stable compare for exactly the first ten', () => {
  makeDirectEligibleForCanary();
  controller.promoteToCanary(canaryInput());
  const turns = createAndCompleteCanaryTurns(11);
  assert.equal(turns.filter(x => x.comparisonReleaseId === 'stable-r2').length, 10);
  assert.equal(turns[10].comparisonReleaseId, null);
});

test('canary allows at most three outstanding comparisons and survives restart', () => {
  makeDirectEligibleForCanary();
  controller.promoteToCanary(canaryInput());
  createUnfinishedCanaryTurns(3);
  const restored = new PromotionController({ store: reopenStore(), presetRegistry });
  const next = restored.createTurn(directTurnInput());
  assert.equal(restored.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
  assert.equal(next.authoritativeReleaseId, 'stable-r2');
  assert.equal(restored.getStatus('DIRECT_REPLY').lastReasonCode,
    'CANARY_COMPARE_BACKLOG');
});

test('hard action error rolls back only that TurnKind for new turns', () => {
  const oldTurn = createCanaryTurn('MOMENT_REPLY');
  controller.recordCriticalFinding(criticalFinding('PUBLIC_PRIVACY_VIOLATION', oldTurn));
  assert.equal(controller.getStatus('MOMENT_REPLY').candidatePhase, 'rolled_back');
  assert.equal(store.getTurn(oldTurn.turnId).authoritativeReleaseId, 'candidate-r3');
  assert.equal(controller.createTurn(momentReplyInput()).authoritativeReleaseId, 'stable-r2');
  assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'canary');
});

test('two confirmed severe lived failures in fifteen minutes trip quality fuse', () => {
  recordSevereConfirmed('DIRECT_REPLY', 1000);
  recordSevereConfirmed('DIRECT_REPLY', 1000 + 14 * 60_000);
  assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
});
```

- [ ] **Step 2: Run promotion tests red**

Run: `node --test yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs`

Expected: FAIL because current controller treats `legacy/cognition` as identity and lacks release methods.

- [ ] **Step 3: Implement transactional release resolution and gates**

```js
export function resolvePipelinePair(rollout) {
  switch (rollout.candidatePhase) {
    case 'none':
    case 'rolled_back':
      return pair(rollout.stableReleaseId, null, null, rollout.candidatePhase);
    case 'shadow':
      return pair(rollout.stableReleaseId, rollout.candidateReleaseId,
        'stable_authoritative_candidate_compare', 'shadow');
    case 'canary':
      return pair(rollout.candidateReleaseId,
        rollout.canaryStartedCount < 10 ? rollout.stableReleaseId : null,
        rollout.canaryStartedCount < 10 ? 'candidate_authoritative_stable_compare' : null,
        'canary');
    default:
      throw new Error('invalid candidate phase');
  }
}
```

Registration verifies report checksum, release checksum, baseline release ID, evaluator version, suite checksum, and `eligible=true`, then increments a new evidence epoch and enters shadow. Initial live gates are:

| kind | minimum real shadow success | observation span | canary comparisons | post-canary observation |
|---|---:|---:|---:|---:|
| `DIRECT_REPLY` | 10 | 72 hours | first 10 | 48 hours |
| each other turn kind | 30 | 72 hours | first 10 | 48 hours |
| `LIFE_PLANNING` | 30 completed real attempts | 72 hours | first 10 | 48 hours |

All require zero critical error, no stale evidence, and no outstanding comparison backlog. Canary preserves `canary_target_count=10`, `canary_max_outstanding=3`, and `canary_compare_deadline_ms=900000`; allocation and completion counters live in SQLite and survive restart. A fourth outstanding subject or one older than 15 minutes rolls the affected kind back before a new turn is pinned. These thresholds control production promotion, not APK build completion. Graduation requires all canary comparisons complete, no critical error, no confirmed severe quality fuse, no outstanding work, and observation deadline elapsed. It atomically swaps candidate into stable.

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
node --test yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs
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
- Consumes: delivery timestamps, cursor, lane, release/rollout, comparison, quality findings.
- Produces: separate observable stages and a checksummed race report.

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
function projectTurnDiagnostics({ turn, delivery, lane, rollout, comparison, findings }) {
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
      cloudConfirmed: Boolean(delivery.cloudConfirmedAt),
      nativeCompleted: Boolean(delivery.nativeCompletedAt),
      notificationShown: Boolean(delivery.notificationShownAt),
      uiApplied: Boolean(delivery.uiAppliedAt)
    },
    visibleGroup: { id: turn.visibleGroupId, commitChecksum: turn.commitChecksum },
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

Android native diagnostics expose four stage timestamps, group/cursor IDs, local sequence, fallback contract, and last native error. Web displays each stage independently and never marks success merely because a notification has body text. PC exposes no prompt bodies, private scene text, secrets, or full cognitive chain.

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
  'canary_rollback_while_turn_in_flight',
  'same_fingerprint_adjacent_revisions',
  'cloud_waiting_does_not_block_next_local_turn'
];
```

Each case asserts one visible authority group, correct state-write count, no duplicate action/notification, expected cursor/lane revision, and correct release pin. The report stores inputs/result checksums and failures.

- [ ] **Step 5: Run diagnostics/race tests green**

Run:

```powershell
node --test yuqi-runtime/test/v3-diagnostics.test.mjs tests/yuqi-ui-contract.test.mjs test-basic.mjs
node scripts/verify-yuqi-v3-races.mjs --out artifacts/yuqi-lived-agency-v3/race-report.json
```

Expected: tests PASS; all 13 race cases pass and report checksum is materialized.

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
- Create at runtime: `artifacts/yuqi-lived-agency-v3/rollout-initialization.json`
- Create at runtime: `artifacts/yuqi-lived-agency-v3/final-handoff.json`
- Read only: all evidence from Tasks 0–26.

**Interfaces:**
- Consumes: ready source, formal APK, validated migration decisions, eligible quality report, release manifest.
- Produces: production v10 state, stable-visible candidate shadow per kind, honest completion/handoff report.

- [ ] **Step 1: Stop runtime cleanly, back up, and prove the source database matches the validated dry run**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop-yuqi-background.ps1
node scripts/backup-yuqi-memory.mjs yuqi-runtime/config.json
node scripts/migrate-yuqi-agency-state.mjs --config yuqi-runtime/config.json --dry-run --out artifacts/yuqi-lived-agency-v3/production-migration-report.json
```

Expected: current database SHA/source decision checksum matches the validated basis or produces a new complete report with no structural count loss. If messages or state legitimately changed since Task 3, rerun clone validation against this new report before applying. Do not apply an old report to changed data.

- [ ] **Step 2: Apply migration atomically, audit, and restart on stable**

Run:

```powershell
node scripts/migrate-yuqi-agency-state.mjs --config yuqi-runtime/config.json --apply --expect-report artifacts/yuqi-lived-agency-v3/production-migration-report.json
node scripts/audit-yuqi-memory.mjs yuqi-runtime/config.json
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start-yuqi-background.ps1
node scripts/verify-yuqi-runtime.mjs
```

Expected: runtime healthy, database v10, current production stable release still visible, no candidate active, old unfinished turns resumable, and before/after structural counts preserved. On failure, stop runtime, restore the verified database backup, start the prior runtime, and report rollback evidence.

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
  "database": {"userVersion": 10, "backupPath": "", "backupSha256": "", "migrationReport": ""},
  "protocol": {"cases": 270, "passed": 270, "reportPath": "", "sha256": ""},
  "quality": {"sentinelRuns": 72, "coverageRuns": 144, "historyRuns": 30,
    "eligible": true, "reportPath": "", "sha256": ""},
  "races": {"cases": 13, "passed": 13, "reportPath": "", "sha256": ""},
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
2. A v9/v10 or Room 10/11 migration loses or reclassifies data without exact evidence.
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
- [ ] PC v10 clone migration and production migration reports match their source database.
- [ ] All 270 protocol cases pass and are labeled non-quality evidence.
- [ ] 24×3 sentinel runs, 72×2 coverage runs, and 30 local-history runs are present.
- [ ] Six-dimensional gate and pairwise stable/candidate comparison are eligible.
- [ ] Every TurnKind and life planning has adapter, structured-domain, recovery, and rollout evidence.
- [ ] All 13 lane/delivery/restart/head-of-line races pass.
- [ ] Android Room v11 migration, v1/v2/v3 fallback, event/poll/replay, and four delivery stages pass.
- [ ] Full Node and Android test suites pass.
- [ ] Production stable/candidate state is explicit; non-active kinds are listed.
- [ ] Formal APK package/version/signature/certificate/SHA-256 pass.
- [ ] OTA manifest resolves to the exact canonical release asset and identical APK hash.
- [ ] Covering installation over the prior formal APK succeeds.
- [ ] Database backup, prior stable release, prior APK, and per-kind rollback remain available.
