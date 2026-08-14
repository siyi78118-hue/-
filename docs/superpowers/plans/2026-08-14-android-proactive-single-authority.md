# Android Proactive Single Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Android Room the only scheduler authority for native proactive chat/moment streams, make D1 reject stale writers by epoch/generation CAS, and make Web/SW read-only so one terminal event creates exactly one next task.

**Architecture:** A Room v16 authority row and ordered outbox commit every schedule/pause/disable transition before network I/O. Cloudflare stores one permanent stream authority row and conditionally advances it; Web and Service Worker only configure or display the native authority. A shared transition identity makes retries deterministic, and a cross-layer harness proves event/poll, Alarm/FCM, restart, stale cloud retry, and mirror restore cannot create a second next task.

**Tech Stack:** Android Java, Room/SQLite, AlarmManager, WorkManager, Capacitor, browser JavaScript, Service Worker, Cloudflare Workers, D1, Node test runner, Gradle/JUnit.

## Global Constraints

- Native automatic stream key is exactly `{deviceId, characterId, kind}` with `kind` closed to `chat | moment`.
- Android owner is exactly `android-v1`; Web-only owner is exactly `web-v1`; one stream cannot have both.
- Room is upgraded from schema v15 to v16 without fabricating authority from historical chat content.
- Room transition commit is authoritative; HTTP success never generates a new job ID or due time.
- Schedule operations are closed to `schedule | pause | disable` and generations are strictly monotonic.
- Visible, action-only, skip, and failed terminal results use the same finalizer.
- Manual test jobs and role-plan jobs stay outside automatic stream authority.
- No-op foreground checks are read-only and do not persist a new status timestamp.
- Legacy `/schedule` is accepted only before a stream has an owner claim; after claim, ownerless writes receive 409.
- Cloud delivery defer/ACK can mutate only the exact active epoch/generation/job.
- Full authority epoch is never projected into Web; Web receives only a short fingerprint.
- Existing protocol v1/v2, role plans, lifecycle controls, backups, relay, and legacy Web-only mode keep their established behavior.
- Release target is `1.0.117 (117)` with Service Worker cache `rpchat-v117`; formal APK must follow `docs/AL-android-signing-runbook.md`.

---

## File Map and Ownership

### Shared contract and Cloudflare

- Create `automatic-schedule-contract.mjs`: closed wire validation, canonical checksums, stream/job identity helpers, stable error classification.
- Create `migrations/0003_automatic_schedule_authority.sql`: permanent D1 stream authority and metadata event tables/triggers.
- Modify `cloud-timer-worker.js`: v2 transition/status/ACK/defer routes and legacy owner-claim boundary.
- Modify `tests/cloud-timer-d1.test.mjs`: real CAS/store matrix.
- Modify `tests/cloud-timer-worker.test.mjs`: HTTP, cron, stale retry, ACK, and compatibility matrix.
- Create `tests/fixtures/automatic-schedule-authority-v1.json`: cross-runtime canonical vectors.

### Android Room/domain

- Create `android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleAuthorityEntity.java`.
- Create `android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleOutboxEntity.java`.
- Create `android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleEventEntity.java`.
- Modify `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`: v15→v16 migration and entity registration.
- Modify `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`: exact authority/outbox/event queries and CAS writers.
- Create `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleContract.java`: enums, native types, canonical validation and frozen vectors.
- Create `android/app/src/main/java/com/siyi/al/execution/AutomaticSchedulePlanner.java`: deterministic due time and job ID.
- Create `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleStore.java`: sole Room transition API and claim/finalize/migration logic.
- Create `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleSender.java`: ordered outbox lease and v2 HTTP sender.

### Android runtime integration

- Modify `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`: direct-input pause and terminal delegation in existing transactions.
- Modify `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`: single terminal finalizer and sender/recovery pump.
- Modify `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskCoordinator.java`: generation-aware local claim.
- Modify `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`: epoch/generation/job verification and stale ACK.
- Modify `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskAlarmScheduler.java`: generation extras plus explicit cancellation.
- Modify `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`: generation extras, per-job cancellation, authority recovery.
- Modify `android/app/src/main/java/com/siyi/al/execution/AlAutomaticAlarmReceiver.java`: closed authority input.
- Modify `android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java`: one shared AutomaticScheduleStore/Sender instance.

### Native plugin, Web and Service Worker

- Modify `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`: configure/status/migration projection; remove native Web scheduling writes.
- Modify `tavern-app/index.html`: native read-only status, one-time legacy candidate handoff, no terminal/event/poll scheduling.
- Modify `sw-v11.js`: no native-owner schedule writes; web-v1 CAS only.
- Modify `test-sw-automatic-task-guard.mjs`, `tests/yuqi-ui-contract.test.mjs`, and `test-basic.mjs`.

### Release and verification

- Modify `android/app/build.gradle`, `.github/workflows/android-release.yml`, update manifest files discovered by `tests/yuqi-deployment-contract.test.mjs`, and Service Worker cache/version constants.
- Create `tests/proactive-single-authority-e2e.test.mjs` for cross-layer state-machine scenarios.
- Create `scripts/verify-proactive-single-authority.mjs` for accelerated and idle-soak evidence.
- Create `artifacts/qa/proactive-single-authority-1.0.117.md` only after actual gates run.

---

### Task 1: Freeze the schedule wire contract and D1 CAS

**Files:**
- Create: `automatic-schedule-contract.mjs`
- Create: `migrations/0003_automatic_schedule_authority.sql`
- Create: `tests/fixtures/automatic-schedule-authority-v1.json`
- Modify: `cloud-timer-worker.js`
- Modify: `tests/cloud-timer-d1.test.mjs`
- Modify: `tests/cloud-timer-worker.test.mjs`

**Interfaces:**
- Consumes: existing D1 `timer_devices`, `timer_jobs`, role-plan/manual-test behavior.
- Produces: `validateScheduleTransition(value)`, `scheduleStreamKey(value)`, `scheduleSemanticChecksum(value)`, `transitionAutomaticStream(value)`, `getAutomaticStreamStatus(value)`, `deferAutomaticDelivery(value)`, and `ackAutomaticDelivery(value)`.

- [ ] **Step 1: Add closed contract red tests**

Add table-driven tests that construct this exact shape and mutate every field/type:

```js
const transition = {
  protocolVersion: 2,
  operation: 'schedule',
  owner: 'android-v1',
  authorityEpoch: '00112233445566778899aabbccddeeff',
  generation: 1,
  expectedPreviousJobId: null,
  deviceId: 'device-a',
  characterId: 'char-a',
  kind: 'chat',
  jobId: 'pro_53fd68a5b14aec79_1',
  dueAt: 1786728600000,
  mode: 'planned',
  sourceType: 'bootstrap',
  sourceId: 'bootstrap:char-a:chat',
  sourceChecksum: 'b'.repeat(64),
  policyRevision: 1,
  policyChecksum: 'a'.repeat(64),
  transitionChecksum: '53fd68a5b14aec79a154b157a6fe9f797be18b892a9ab97fff2f359fa2132ed2',
  scheduleChecksum: '8bf4550b02d4eba0e919ba5cca9505bd9a3fb732892e9f0ada3c7fb21057d6c2'
};
```

The fixture must contain the canonical transition JSON text, the exact transition checksum and job ID above, the canonical full schedule JSON text, and the exact schedule checksum above. Node tests recompute from independent production code and Android tests later consume the same frozen values. Reject missing/extra keys, coerced integers, mixed owner, invalid epoch, old/skip generation, nullable fields in the wrong operation, and checksum drift.

- [ ] **Step 2: Run the contract tests and observe red**

Run:

```powershell
node --test tests/cloud-timer-d1.test.mjs tests/cloud-timer-worker.test.mjs
```

Expected: FAIL because `automatic-schedule-contract.mjs`, migration 0003, and `/v2/schedule-transitions` do not exist.

- [ ] **Step 3: Add the permanent D1 stream schema**

Use this schema boundary (add the full indexes and trigger payload in the migration):

```sql
CREATE TABLE timer_stream_authorities (
  logical_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  char_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('chat','moment')),
  owner TEXT NOT NULL CHECK(owner IN ('android-v1','web-v1')),
  authority_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  state TEXT NOT NULL CHECK(state IN ('scheduled','paused','disabled','awaiting_ack')),
  active_job_id TEXT,
  due_at INTEGER,
  payload_json TEXT,
  expected_previous_job_id TEXT,
  schedule_checksum TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_timer_stream_due
  ON timer_stream_authorities(state, due_at);
```

Add `timer_job_events` with metadata-only columns and `AFTER INSERT`/`AFTER UPDATE` triggers. Triggers copy IDs, generation, state, dueAt, and checksum only; never copy payload JSON.

- [ ] **Step 4: Implement one conditional transition path**

Implement the public boundary exactly as:

```js
const OWNER = new Set(['android-v1', 'web-v1']);
const OPERATION = new Set(['schedule', 'pause', 'disable']);
const KIND = new Set(['chat', 'moment']);
const TRANSITION_KEYS = Object.freeze([
  'authorityEpoch','characterId','deviceId','dueAt','expectedPreviousJobId',
  'generation','jobId','kind','mode','operation','owner','policyChecksum',
  'policyRevision','protocolVersion','scheduleChecksum','sourceChecksum',
  'sourceId','sourceType','streamKey','transitionChecksum'
]);

function contract(field) {
  const error = new Error(`invalid automatic schedule ${field}`);
  error.code = 'SCHEDULE_CONTRACT_INVALID';
  return error;
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
  );
  return value;
}
export function canonicalScheduleJson(value) {
  return JSON.stringify(canonicalize(value));
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateScheduleTransition(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw contract('shape');
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...TRANSITION_KEYS].sort())) {
    throw contract('keys');
  }
  if (!OWNER.has(value.owner) || !OPERATION.has(value.operation) || !KIND.has(value.kind)) {
    throw contract('enum');
  }
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw contract('generation');
  if (!/^[a-f0-9]{32}$/.test(value.authorityEpoch)) throw contract('authorityEpoch');
  if (!/^[a-f0-9]{64}$/.test(value.sourceChecksum)
      || !/^[a-f0-9]{64}$/.test(value.policyChecksum)
      || !/^[a-f0-9]{64}$/.test(value.transitionChecksum)
      || !/^[a-f0-9]{64}$/.test(value.scheduleChecksum)) throw contract('checksum');
  const normalized = structuredClone(value);
  if (await scheduleTransitionChecksum(normalized) !== normalized.transitionChecksum
      || await scheduleSemanticChecksum(normalized) !== normalized.scheduleChecksum) {
    throw contract('checksum');
  }
  return Object.freeze(normalized);
}
export function scheduleStreamKey({ deviceId, characterId, kind }) {
  return `active:${encodeURIComponent(deviceId)}:${encodeURIComponent(characterId)}:${kind}`;
}
export async function scheduleTransitionChecksum(value) {
  const { protocolVersion, jobId, transitionChecksum, scheduleChecksum, ...basis } = value;
  return sha256(canonicalScheduleJson(basis));
}
export async function scheduleSemanticChecksum(value) {
  const { protocolVersion, scheduleChecksum, ...basis } = value;
  return sha256(canonicalScheduleJson(basis));
}
```

In the D1 store, expose:

```js
async function transitionAutomaticStream(input) {
  // exact replay -> idempotent
  // current generation + 1 and exact predecessor -> conditional UPSERT
  // all other shapes -> stable 409 code with zero write
}
```

`pause` and `disable` retain owner/epoch/generation and set active job/due/payload to NULL. Do not delete `timer_stream_authorities` rows.

- [ ] **Step 5: Close cron, defer and ACK against stale jobs**

Automatic due queries read only `state IN ('scheduled','awaiting_ack')` rows from `timer_stream_authorities`. Defer and ACK update with this full predicate:

```sql
WHERE logical_key = ?
  AND authority_epoch = ?
  AND generation = ?
  AND active_job_id = ?
```

If `changes === 0`, return `SCHEDULE_STALE_DELIVERY` without recreating a row. Keep existing `timer_jobs` routes unchanged for `test=true` and `type='role-plan'`.

- [ ] **Step 6: Test legacy claim and post-claim rejection**

Add tests proving:

```js
await post('/schedule', legacyA);                 // accepted before claim
await post('/v2/schedule-transitions', claim1);  // generation 1
await post('/schedule', legacyB);                 // 409 authority conflict
await post('/v2/schedule-transitions', claim1);  // exact replay 200 idempotent
await post('/v2/schedule-transitions', stale0);  // 409, row unchanged
await post('/v2/schedule-transitions', next2);   // 200 only with predecessor job1
```

Also prove that A's late defer and ACK do not change B, while manual test and two independent role plans preserve their current byte behavior.

- [ ] **Step 7: Run focused Cloudflare gates**

Run:

```powershell
node --test tests/cloud-timer-d1.test.mjs tests/cloud-timer-worker.test.mjs
node --check automatic-schedule-contract.mjs
node --check cloud-timer-worker.js
```

Expected: all tests PASS, no skipped tests.

- [ ] **Step 8: Commit Task 1**

```powershell
git add automatic-schedule-contract.mjs migrations/0003_automatic_schedule_authority.sql tests/fixtures/automatic-schedule-authority-v1.json cloud-timer-worker.js tests/cloud-timer-d1.test.mjs tests/cloud-timer-worker.test.mjs
git commit -m "feat: add proactive schedule authority CAS"
```

---

### Task 2: Add Room v16 authority, outbox and audit tables

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleAuthorityEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleOutboxEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleEventEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java`

**Interfaces:**
- Consumes: v15 database and current `CharacterSnapshotEntity` rows as migration candidates only.
- Produces: v16 tables and DAO methods `automaticScheduleAuthority`, `upsertAutomaticScheduleAuthority`, `nextAutomaticScheduleOutbox`, `automaticScheduleOutbox`, `automaticScheduleEvents`, and exact CAS updates.

- [ ] **Step 1: Write populated v15→v16 migration red tests**

Create v15 rows containing chat turns, snapshots, lifecycle controls and role-delete data. Run migration and assert all old fields are byte-equal, all new tables exist and are empty, and no authority epoch/job is fabricated. Add fresh-v16 and future-v17 refusal tests.

```java
assertEquals(0, count(db, "automatic_schedule_authorities"));
assertEquals(0, count(db, "automatic_schedule_outbox"));
assertEquals(0, count(db, "automatic_schedule_events"));
assertEquals(oldSnapshotJson, migratedSnapshot.contextJson);
```

- [ ] **Step 2: Run Android test compilation to prove red**

Run:

```powershell
cd android
.\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
```

Expected: FAIL on missing v16 entities and `MIGRATION_15_16`.

- [ ] **Step 3: Add exact Room entities**

Use one primary key per stream/generation/event:

```java
@Entity(tableName = "automatic_schedule_authorities")
public final class AutomaticScheduleAuthorityEntity {
  @PrimaryKey @NonNull public String streamKey = "";
  @NonNull public String characterId = "";
  @NonNull public String kind = "";
  @NonNull public String owner = "android-v1";
  @NonNull public String authorityEpoch = "";
  public long generation;
  @NonNull public String state = "disabled";
  public String activeJobId;
  public Long dueAt;
  @NonNull public String semanticJson = "{}";
  @NonNull public String semanticChecksum = "";
  @NonNull public String cloudSyncState = "waiting";
  public long conversationSequence;
  public long createdAt;
  public long updatedAt;
}
```

Outbox uses primary key `streamKey:generation`, closed operation/state, exact lease fields and immutable payload/checksum. Event ID is deterministic from stream/generation/event type.

- [ ] **Step 4: Add public v15→v16 migration**

Register all three entities, set `SCHEMA_VERSION = 16`, create tables/check constraints/indexes, expose `public static final Migration MIGRATION_15_16`, and append it to `addMigrations`. Migration must not parse `contextJson` or create authority rows.

- [ ] **Step 5: Add exact DAO boundaries**

DAO methods must use named rows, not broad deletes:

```java
@Query("SELECT * FROM automatic_schedule_authorities WHERE streamKey=:streamKey LIMIT 1")
AutomaticScheduleAuthorityEntity automaticScheduleAuthority(String streamKey);

@Query("SELECT * FROM automatic_schedule_outbox o WHERE o.state='waiting' "
  + "AND NOT EXISTS (SELECT 1 FROM automatic_schedule_outbox prior "
  + "WHERE prior.streamKey=o.streamKey AND prior.generation<o.generation "
  + "AND prior.state NOT IN ('synced','superseded')) "
  + "ORDER BY o.updatedAt ASC LIMIT 1")
AutomaticScheduleOutboxEntity nextAutomaticScheduleOutbox();
```

Add CAS queries for waiting/expired-pending→pending, matching lease→synced, and matching current authority generation/job→claimed.

- [ ] **Step 6: Run migration and full Android compile gates**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: BUILD SUCCESSFUL. If `adb devices -l` has no device, record that connected migration execution remains a release gate; do not call it passed.

- [ ] **Step 7: Commit Task 2**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleAuthorityEntity.java android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleOutboxEntity.java android/app/src/main/java/com/siyi/al/execution/db/AutomaticScheduleEventEntity.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/androidTest/java/com/siyi/al/execution/ConversationCursorStoreTest.java
git commit -m "feat: add Room proactive schedule authority"
```

---

### Task 3: Implement deterministic Android transitions

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleContract.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AutomaticSchedulePlanner.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleStore.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AutomaticScheduleContractTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AutomaticSchedulePlannerTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: Task 1 fixture and Task 2 DAO/entities.
- Produces: `configure`, `pauseForConversationInternal`, `finalizeDirectInternal`, `claim`, `finalizeAutomatic`, `disable`, `migrateLegacyCandidate`, and `status` on `AutomaticScheduleStore`.

- [ ] **Step 1: Add cross-language and deterministic planner red tests**

Android loads every fixture vector and asserts canonical JSON/checksum and derived identity. Add two identical transition retries at different wall-clock times and assert exact equality:

```java
AutomaticSchedulePlanner.Plan a = planner.next(source, policy, 1_000L);
AutomaticSchedulePlanner.Plan b = planner.next(source, policy, 9_999_999L);
assertEquals(a.jobId, b.jobId);
assertEquals(a.dueAt, b.dueAt);
assertEquals(a.semanticChecksum, b.semanticChecksum);
```

The planner may use current time only when forming the source event before commit; retrying the same source checksum must not sample again.

- [ ] **Step 2: Run focused unit tests and observe red**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.AutomaticSchedule*" --no-daemon --no-problems-report
```

Expected: FAIL on missing contract/planner/store.

- [ ] **Step 3: Implement closed transition types and seeded planning**

Expose immutable values:

```java
public enum Operation { SCHEDULE, PAUSE, DISABLE }
public enum TerminalDisposition { VISIBLE, ACTION_ONLY, SKIP, FAILED }
public static final class Source {
  public final String type, id, checksum;
  public final long conversationSequence;
  public Source(String type, String id, String checksum, long conversationSequence) {
    this.type = type; this.id = id; this.checksum = checksum;
    this.conversationSequence = conversationSequence;
  }
}
public static final class Policy {
  public final long revision, minDelayMs, maxDelayMs;
  public final String checksum, mode, explicitAt;
  public Policy(long revision, String checksum, String mode,
                long minDelayMs, long maxDelayMs, String explicitAt) {
    this.revision = revision; this.checksum = checksum; this.mode = mode;
    this.minDelayMs = minDelayMs; this.maxDelayMs = maxDelayMs;
    this.explicitAt = explicitAt;
  }
}
```

Use SHA-256 over canonical UTF-8 bytes for the random fraction and the two-stage transition/job/schedule derivation. Never use `Math.random()` or `System.currentTimeMillis()` inside retryable derivation. The order is transition tuple → transitionChecksum → jobId → full schedule tuple → scheduleChecksum.

- [ ] **Step 4: Implement one transaction API**

`AutomaticScheduleStore.transitionAutomaticSchedule()` performs:

```java
database.runInTransaction(() -> {
  AutomaticScheduleAuthorityEntity current = dao.automaticScheduleAuthority(streamKey);
  TransitionDecision decision = contract.decide(current, event);
  if (decision.isReplay()) return;
  dao.upsertAutomaticScheduleAuthority(decision.authority());
  dao.insertAutomaticScheduleOutbox(decision.outbox());
  dao.insertAutomaticScheduleEvent(decision.event());
});
```

It must verify native owner, role-delete tombstone, source sequence, predecessor, generation, source checksum and exact replay before any write. Same source replay returns the stored authority; same source ID with changed checksum rejects with zero writes.

- [ ] **Step 5: Add Room fault-boundary matrix**

Inject failure after authority, outbox and event writes. Each failure must roll back all three counts and the old authority snapshot. Cover schedule, pause and disable. Add restart tests for visible/action-only/skip/failed exact replay and older conversation result suppression.

- [ ] **Step 6: Run focused unit/instrumentation compile gates**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.AutomaticSchedule*" --no-daemon --no-problems-report
.\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
```

Expected: all focused unit tests PASS and androidTest compilation succeeds.

- [ ] **Step 7: Commit Task 3**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleContract.java android/app/src/main/java/com/siyi/al/execution/AutomaticSchedulePlanner.java android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleStore.java android/app/src/test/java/com/siyi/al/execution/AutomaticScheduleContractTest.java android/app/src/test/java/com/siyi/al/execution/AutomaticSchedulePlannerTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "feat: add deterministic proactive transitions"
```

---

### Task 4: Synchronize the ordered Room outbox with Cloudflare

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleSender.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/AutomaticScheduleSenderTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: ordered outbox and `/v2/schedule-transitions`.
- Produces: `flushOne(now)`, `recoverExpiredLeases(now)`, and `nextDelayMs(now)`.

- [ ] **Step 1: Write lease/order/crash red tests**

Tests must prove generation 2 cannot be claimed while generation 1 is waiting/pending; two senders share one DB and only one claims; crash-before-HTTP waits until lease expiry; exact retry uses identical body; old lease completion cannot overwrite a new lease; 409 authority/checksum quarantines only the target; 429/503 retains retry.

- [ ] **Step 2: Run sender tests and observe red**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.AutomaticScheduleSenderTest" --no-daemon --no-problems-report
```

Expected: FAIL because the sender does not exist.

- [ ] **Step 3: Implement exact lease and HTTP body**

Constructor and result types are fixed as:

```java
AutomaticScheduleSender(AlExecutionDatabase db, HttpTransport transport,
                        String endpoint, ExecutionClock clock)
Outcome flushOne(long now);
long nextDelayMs(long now);
```

The sender loads an eligible row, CASes one lease, POSTs its persisted payload unchanged, and marks synced only with `(outboxId, checksum, leaseId, leaseAttempt)`. It never calls the planner.

- [ ] **Step 4: Wire one shared sender into runtime recovery**

Create one store/sender in `ExecutionRuntime`, inject it into `AlExecutionService`, and schedule the next wake from the minimum of execution, lifecycle and automatic-schedule delays. Do not construct senders inside loops.

- [ ] **Step 5: Run crash/restart Room tests**

Add a real Room test: commit generation 1, close DB before send, reopen, flush, lose response after cloud accepts, reopen again, replay and assert one D1-equivalent transition identity and one synced outbox.

- [ ] **Step 6: Run focused gates**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.AutomaticSchedule*" --no-daemon --no-problems-report
.\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: BUILD SUCCESSFUL and no skipped focused unit tests.

- [ ] **Step 7: Commit Task 4**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleSender.java android/app/src/test/java/com/siyi/al/execution/AutomaticScheduleSenderTest.java android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "feat: sync proactive authority outbox"
```

---

### Task 5: Make Android claims and terminal results single-path

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskCoordinator.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskAlarmScheduler.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlAutomaticAlarmReceiver.java`
- Modify: `android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/AutomaticTaskRecoveryPolicyTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionServicePolicyTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/YuqiAutomaticTriggerTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: Task 3 store and Task 4 sender.
- Produces: generation-aware DIRECT_REPLY pause, Alarm/FCM claim, unified terminal finalizer and stale-input ACK.

- [ ] **Step 1: Write dual-entry and four-disposition red tests**

Use one real Room DB and race local Alarm against FCM with the same epoch/generation/job. Assert one claimed turn. For each disposition, fire event and poll twice and assert one next generation/outbox/event. Add changed result checksum rejection and exact replay.

```java
assertEquals(1, dao.turnsForCloudJob(jobId).size());
assertEquals(previousGeneration + 1, authority.generation);
assertEquals(1, dao.outboxForGeneration(streamKey, authority.generation).size());
```

- [ ] **Step 2: Run focused tests and observe red**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.AlFirebaseMessagingServiceTest" --tests "com.siyi.al.execution.ExecutionServicePolicyTest" --no-daemon --no-problems-report
.\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
```

Expected: red assertions because existing inputs have no epoch/generation and `continueAutomaticTask()` still creates jobs independently.

- [ ] **Step 3: Pause current chat stream inside direct submit**

In the existing `RoomExecutionStore.submitTurn` transaction, when kind is DIRECT_REPLY, call `pauseForConversationInternal(characterId, localSequence, sourceMessageId, envelopeChecksum)`. The pause and submitted turn must commit or roll back together. A second newer input advances sequence; a late older result cannot schedule.

- [ ] **Step 4: Replace `continueAutomaticTask()` with unified finalization**

Delete job generation, HTTP POST, stable snapshot writes, `Math.random()`, SharedPreferences continuation authority, and direct Alarm/Work scheduling from this method. It should only project the persisted turn/result into:

```java
automaticScheduleStore.finalizeTerminal(
  turn.turnId, turn.characterId, turn.kind, turn.cloudJobId,
  turn.terminalDisposition, persistedResultChecksum, turn.inputVisibilitySequence
);
```

DIRECT_REPLY finalization uses `finalizeDirect`; proactive chat/moment use `finalizeAutomatic`. Both call the same transition planner/store.

- [ ] **Step 5: Add epoch/generation to Alarm, Work and FCM**

All three inputs carry a closed token:

```json
{"authorityEpoch":"00112233445566778899aabbccddeeff","generation":7,"jobId":"pro_53fd68a5b14aec79_7","characterId":"char-a","kind":"chat"}
```

`AutomaticTaskCoordinator` calls one `claim` CAS. Old/missing/mismatched inputs return STALE without diagnostics or semantic writes. FCM stale input sends a deletion-safe ACK; it does not schedule or notify.

- [ ] **Step 6: Cancel and reconcile local schedulers**

Add `AutomaticTaskAlarmScheduler.cancel(context, jobId)` and `AlExecutionWakeWorker.cancelAutomatic(context, jobId)`. On each successful transition cancel the previous projection and schedule only the current authority. Boot/restart enumerates active authority rows, rejects old snapshot-only work, and recreates current Alarm/Work with epoch/generation extras.

- [ ] **Step 7: Cover lifecycle and race gates**

Tests: clear epoch, role delete, disable, user input arriving during due claim, role deletion between claim/result, and an old terminal result after a newer direct input. Each old path must be a no-op or stale ACK and must not create notification/message/next generation.

- [ ] **Step 8: Run Android focused gates**

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests "com.siyi.al.execution.AutomaticSchedule*" --tests "com.siyi.al.AlFirebaseMessagingServiceTest" --tests "com.siyi.al.execution.ExecutionServicePolicyTest" --no-daemon --no-problems-report
.\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 9: Commit Task 5**

```powershell
git add android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java android/app/src/main/java/com/siyi/al/execution/AutomaticTaskCoordinator.java android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java android/app/src/main/java/com/siyi/al/execution/AutomaticTaskAlarmScheduler.java android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java android/app/src/main/java/com/siyi/al/execution/AlAutomaticAlarmReceiver.java android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java android/app/src/test/java/com/siyi/al/execution/AutomaticTaskRecoveryPolicyTest.java android/app/src/test/java/com/siyi/al/execution/ExecutionServicePolicyTest.java android/app/src/androidTest/java/com/siyi/al/execution/YuqiAutomaticTriggerTest.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "fix: make proactive terminal scheduling single-path"
```

---

### Task 6: Cut Web and Service Worker over to read-only native authority

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `tavern-app/index.html`
- Modify: `sw-v11.js`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `test-sw-automatic-task-guard.mjs`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: native `AutomaticScheduleStore.configure/status/migrateLegacyCandidate`.
- Produces Capacitor methods `configureAutomaticSchedule`, `getAutomaticScheduleStatus`, and `migrateLegacyAutomaticScheduleCandidate`; native Web scheduling becomes read-only.

- [ ] **Step 1: Write static and behavioral red tests**

UI contract tests must reject all native-mode calls from terminal/event/poll/foreground check to `/schedule`, `ensureCloudProactiveKindScheduled`, or `saveProactiveSnapshot`. Assert a no-due foreground cycle performs zero `DB.set`, MemoryDB mirror, schedule POST and native snapshot write.

Add this behavioral invariant:

```js
assert.deepEqual(after, before, 'native status refresh cannot mutate schedule state');
assert.equal(schedulePosts, 0);
assert.equal(nativeSnapshotWrites, 0);
```

- [ ] **Step 2: Run Web/SW tests and observe red**

```powershell
node --test tests/yuqi-ui-contract.test.mjs
node test-sw-automatic-task-guard.mjs
node test-basic.mjs
```

Expected: FAIL because native completion and foreground checks still write/schedule.

- [ ] **Step 3: Add closed native plugin methods**

Plugin projections return only:

```json
{
  "characterId":"char-a","kind":"chat","owner":"android-v1",
  "epochFingerprint":"a1b2c3d4","generation":7,"state":"scheduled",
  "jobId":"pro_53fd68a5b14aec79_7","dueAt":1786728600000,"cloudSyncState":"synced",
  "lastChangeSource":"proactive_terminal","lastChangedAt":1786720000000
}
```

Never return full epoch, semantic payload, chat content or outbox lease. Configure validates settings and calls native store; migration candidate is accepted once and never trusts its job ID as the new identity.

- [ ] **Step 4: Remove native Web write authority**

In native mode:

- foreground/start/focus call status only;
- execution event and poll only render terminal result;
- visible/action-only/skip do not delete or generate local jobs;
- direct input no longer calls Web reanchor/reschedule;
- old `pendingProactiveJob/pendingMomentJob` are handed off once, then removed after native claim;
- app-state mirror/backup import filters both fields;
- manual test uses `cloudTimerTestJob` and the independent D1 test key.

Keep the old Web logic behind explicit `owner === 'web-v1'` only.

- [ ] **Step 5: Make status rendering fact-separated and no-op**

Render planned due, generation/job, last real change, cloud sync, in-memory last check and delivery retry on separate lines. `setCloudTimerStatus` must not persist when the text/fact set is unchanged; the one-minute no-task branch updates only an in-memory check indicator.

- [ ] **Step 6: Disable native-owner Service Worker scheduling**

SW reads owner from the push payload/state. For `android-v1`, it never creates a job or POSTs schedule. For `web-v1`, it sends the v2 epoch/generation/CAS transition and reloads status after 409 rather than guessing a new time.

- [ ] **Step 7: Run Web, SW and Android plugin gates**

```powershell
node --test tests/yuqi-ui-contract.test.mjs
node test-sw-automatic-task-guard.mjs
node test-basic.mjs
cd android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: all Node tests PASS and Android BUILD SUCCESSFUL.

- [ ] **Step 8: Commit Task 6**

```powershell
git add android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java tavern-app/index.html sw-v11.js tests/yuqi-ui-contract.test.mjs test-sw-automatic-task-guard.mjs test-basic.mjs
git commit -m "fix: make native proactive scheduling read only in Web"
```

---

### Task 7: Prove cross-layer convergence and migration retirement

**Files:**
- Create: `tests/proactive-single-authority-e2e.test.mjs`
- Create: `scripts/verify-proactive-single-authority.mjs`
- Modify: `tests/cloud-timer-d1.test.mjs`
- Modify: `tests/cloud-timer-worker.test.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/YuqiAutomaticTriggerTest.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/YuqiProcessRecoveryTest.java`

**Interfaces:**
- Consumes: all preceding production interfaces.
- Produces: release-grade convergence evidence and an accelerated soak command.

- [ ] **Step 1: Add a real state-machine harness**

The harness must run actual Worker contract/store functions and the same canonical fixture used by Android. It represents Room authority, D1 authority, Web mirror and delivery callbacks separately; it must not replace all three with one mock object.

- [ ] **Step 2: Encode the ten required counterexamples**

Create named tests for:

1. one terminal plus event+poll;
2. visible/action-only/skip/failed;
3. stale Web A after Android B;
4. stale D1 defer/ACK from A after B;
5. simultaneous Alarm/FCM;
6. cloud accepted but response lost and process restart;
7. two user messages with earlier reply late;
8. clear/role-delete/disable;
9. old app-state/SW ownerless write;
10. repeated status refresh with stable job/due/generation.

Each asserts one current authority, at most one current Alarm/Work projection, one next outbox per generation, and no semantic output on stale paths.

- [ ] **Step 3: Add migration-retirement tests**

Start with three conflicting legacy candidates (Web, Room snapshot, D1). Assert migration creates one generation-1 authority with a new deterministic job identity, cancels every legacy Alarm/Work, rejects missing epoch callbacks, and permanently rejects old `/schedule` writes after claim.

- [ ] **Step 4: Run the complete focused gate**

```powershell
node --test tests/cloud-timer-d1.test.mjs tests/cloud-timer-worker.test.mjs tests/proactive-single-authority-e2e.test.mjs tests/yuqi-ui-contract.test.mjs
node test-sw-automatic-task-guard.mjs
node test-basic.mjs
cd android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: all pass, zero skips in the named suites.

- [ ] **Step 5: Run accelerated soak**

```powershell
node scripts/verify-proactive-single-authority.mjs --transitions 100 --streams chat,moment --out artifacts/qa/proactive-single-authority-soak.json
```

Expected report: 100 committed transitions, 100 unique monotonic generations, zero stale overwrites, zero duplicate terminal advancements, zero no-op status writes.

- [ ] **Step 6: Run full repository gate**

```powershell
npm.cmd test
```

Expected: exit 0, no skipped focused authority tests.

- [ ] **Step 7: Commit Task 7**

```powershell
git add tests/proactive-single-authority-e2e.test.mjs scripts/verify-proactive-single-authority.mjs tests/cloud-timer-d1.test.mjs tests/cloud-timer-worker.test.mjs tests/yuqi-ui-contract.test.mjs android/app/src/androidTest/java/com/siyi/al/execution/YuqiAutomaticTriggerTest.java android/app/src/androidTest/java/com/siyi/al/execution/YuqiProcessRecoveryTest.java
git commit -m "test: prove proactive schedule convergence"
```

---

### Task 8: Deploy the authority migration and build 1.0.117

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-release.yml`
- Modify: `sw-v11.js`
- Modify: `cloud-timer-worker.js`
- Modify: deployment/update manifest files selected by `tests/yuqi-deployment-contract.test.mjs`
- Create: `artifacts/qa/proactive-single-authority-1.0.117.md`

**Interfaces:**
- Consumes: passing Tasks 1–7.
- Produces: deployed backward-compatible Worker, formally signed upgrade APK, checksums and device/idle-soak checklist.

- [ ] **Step 1: Back up and apply D1 migration before the APK cutover**

Export current D1, apply migration 0003, deploy Worker in legacy-compatible pre-claim mode, and run health plus Task 1 remote smoke tests. Do not enable strict owner rejection globally; it activates per stream only after a successful owner claim.

- [ ] **Step 2: Set release versions exactly**

Set Android `versionName "1.0.117"`, `versionCode 117`, Service Worker cache `rpchat-v117`, Worker version to the release timestamp identifier, Actions contract and update manifest to the same release.

- [ ] **Step 3: Run deployment and signing contracts**

```powershell
node --test tests/yuqi-deployment-contract.test.mjs tests/android-unsigned-release-contract.test.mjs
npm.cmd test
```

Expected: exit 0.

- [ ] **Step 4: Build through the formal signing workflow**

Follow `docs/AL-android-signing-runbook.md`: push the reviewed branch, trigger the formal GitHub build with local credentials/REST workflow, download the artifact, and verify package ID, version code/name, APK signature, formal certificate SHA-256 and file SHA-256. Never substitute a debug/unsigned APK.

- [ ] **Step 5: Record device gates honestly**

If a connected device exists, run:

```powershell
cd android
.\gradlew.bat connectedDebugAndroidTest --no-daemon --no-problems-report
```

Record the actual device, v15→v16 migration, FCM+Alarm race, foreground/background/process-kill/reboot/network-switch results. If no device exists, mark these as pending user-device acceptance and do not call them passed.

- [ ] **Step 6: Run idle acceptance**

For 24 hours without chat before the next due time, record Room/D1/UI epoch fingerprint, generation, job ID and dueAt at start/end; all four must match. At due, record terminal disposition and exactly one next generation. Network retry may exceed 90 seconds but cannot alter the planned dueAt.

- [ ] **Step 7: Publish evidence and commit release metadata**

Write the QA file with every command/result, remote Worker version, D1 migration, APK signature/certificate/file hashes, device gate status and soak report path.

```powershell
git add android/app/build.gradle .github/workflows/android-release.yml sw-v11.js cloud-timer-worker.js artifacts/qa/proactive-single-authority-1.0.117.md
git commit -m "release: build AL 1.0.117"
```

---

## Plan Self-Review Result

- Spec coverage: Room authority/outbox/events, permanent D1 owner/epoch/generation, pause/disable retention, Web/SW cutover, deterministic planning, all four terminal dispositions, legacy migration, stale Alarm/FCM/cloud retry, mirror filtering, status separation, observability, full tests and signed release each map to an explicit task.
- Placeholder scan: implementation steps contain exact files, signatures, state/value closures, commands and expected failures/passes. The fixture checksum is intentionally produced and frozen in Task 1 before either runtime consumes it; later tests treat the committed bytes as external evidence.
- Type consistency: `authorityEpoch`, `generation`, `expectedPreviousJobId`, `jobId`, `scheduleChecksum`, operations, owners, kinds and terminal dispositions use the same names across D1, Android, plugin and test harness.
- Scope: role-plan recurrence, cognition behavior and manual test jobs remain isolated. The plan stays unified because the acceptance invariant is specifically that independently implemented layers cannot create multiple next jobs.
