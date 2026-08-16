# AL Complete Phone Data Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently delete the previously removed 许弥 role and atomically restore every verifiable 虞栖 data category from Web recovery sources and Android Room, while reporting data for which no verified source exists.

**Architecture:** Add closed, paginated Android recovery projections and a pure Web restoration assembler. The assembler uses an explicit source-priority lattice, produces a metadata-only completeness report, and commits the merged Web/IndexedDB/role-plan state through an expanded recovery journal. Role deletion remains the existing `role_delete_v1` authority path; no zero-message heuristic becomes a product rule.

**Tech Stack:** Java 17, Android Room, Capacitor plugin bridge, browser JavaScript, IndexedDB, Node test runner, Gradle Android tests.

## Global Constraints

- Never infer deletion from an empty role directory or zero raw messages.
- The confirmed deletion target is exactly `char_1783694247588_zojx`; persist a formal deletion control/tombstone so old recovery sources cannot resurrect it.
- Never return message bodies, prompts, avatar bytes, API keys, or vectors in metadata-only diagnostics.
- Never treat the native compiled execution prompt as a lossless editable character card.
- Current valid Web state wins over recovery sources; recovery may add missing data but may not roll back current messages, settings, cursors, secrets, or cloud bindings.
- Every native row projection uses exact keys, stable identities, checksums, deterministic ordering, and snapshot/page consistency.
- A missing verified avatar source is reported as `avatar_bytes_missing`; no generated or substitute image is allowed.
- Recovery is idempotent and rollback-safe. Any failed pre-commit verification leaves the pre-recovery Web state intact and frozen.
- Preserve unrelated shared-worktree dirt and never stage it.

---

### Task 1: Freeze the restoration source and report contracts

**Files:**
- Create: `tavern-app/lib/complete-app-restoration.js`
- Modify: `tavern-app/lib/app-state-recovery.js`
- Test: `tests/complete-app-restoration.test.mjs`
- Test: `tests/app-state-recovery.test.mjs`

**Interfaces:**
- Consumes: existing `ALAppStateRecovery.canonicalJson`, `sha256CanonicalJson`, and `mergeRecoveryState`.
- Produces: `ALCompleteAppRestoration.buildPlan(input)`, `verifyNativePage(page, contract)`, `summarizePlan(plan)`, and `applyWebCandidate(current, plan)`.

- [ ] **Step 1: Write failing closed-contract and source-priority tests**

Create fixtures for current Web, recovery journal, legacy slot, mirror, native census, and built-in Yuqi profile. Assert:

```js
const plan = await restoration.buildPlan({
  current: state({ yuqi: { name: '虞栖', avatarData: 'current-avatar' } }),
  recoveryBefore: state({ yuqi: { description: 'recovered description' } }),
  legacy: state({ yuqi: { avatarData: 'legacy-avatar' } }),
  mirror: state({ yuqi: { personality: 'mirror style' } }),
  native: nativeEvidence(),
  builtinYuqi: builtinProfile(),
  deletionTargets: ['char_1783694247588_zojx']
});
assert.equal(plan.roles.yuqi.avatarData, 'current-avatar');
assert.equal(plan.roles.yuqi.description, 'recovered description');
assert.equal(plan.roles.yuqi.personality, 'mirror style');
assert.deepEqual(plan.excludedRoleIds, ['char_1783694247588_zojx']);
assert.equal(plan.report.avatar.status, 'restored');
```

Also assert unknown keys, duplicate identities, conflicting checksums, changed page snapshot tokens, fabricated moments, native compiled prompt as editable card, and an unconfirmed zero-message role all reject or remain excluded from automatic deletion.

- [ ] **Step 2: Run tests and capture the red result**

Run:

```bash
node --test tests/complete-app-restoration.test.mjs tests/app-state-recovery.test.mjs
```

Expected: FAIL because `complete-app-restoration.js` and the new APIs do not exist.

- [ ] **Step 3: Implement the pure contract module**

The module must export a frozen API and use exact category states:

```js
const CATEGORY_STATES = Object.freeze([
  'already_present', 'restored', 'native_only', 'conflict', 'no_verified_source'
]);
const CONFIRMED_DELETION_ID = 'char_1783694247588_zojx';

async function buildPlan({ current, recoveryBefore, legacy, mirror, native,
  builtinYuqi, deletionTargets = [] }) {
  assertDeletionTargets(deletionTargets);
  const sources = [current, recoveryBefore, legacy, mirror];
  const yuqi = mergeRoleByField('yuqi', sources, builtinYuqi);
  return deepFreeze({
    version: 1,
    excludedRoleIds: [...deletionTargets],
    roles: { yuqi },
    chats: mergeChatsByStableId(sources, native.messages || []),
    moments: mergeVerifiedMoments(sources, native.momentEvidence || []),
    memories: mergeVerifiedMemories(sources, native.memories || []),
    rolePlans: mergeVerifiedRolePlans(sources, native.rolePlans || []),
    report: buildCompletenessReport({ yuqi, native, sources })
  });
}
```

Do not special-case arbitrary empty roles. Only the exact user-confirmed ID may enter `excludedRoleIds`.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit Task 1 only**

```bash
git add tavern-app/lib/complete-app-restoration.js tavern-app/lib/app-state-recovery.js tests/complete-app-restoration.test.mjs tests/app-state-recovery.test.mjs
git commit -m "test: freeze complete restoration contracts"
```

### Task 2: Add Android read-only recovery projections

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Test: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/AppRecoveryProjectionTest.java`

**Interfaces:**
- Produces store methods `readAppRecoveryReplyParts`, `readAppRecoveryMemoryRecords`, `readAppRecoveryRolePlans`, and `readAppRecoveryMomentEvidence`, each returning `{contract, characterId, snapshotToken, nextCursor, hasMore, rows, pageChecksum}`.
- Produces matching Capacitor plugin methods with page limit 1–200.

- [ ] **Step 1: Add red tests for exact projection, pagination, and zero writes**

Seed real Room rows for one role, including text/moment/action reply parts, two memory types, active/completed role plans, plan history, and a tombstoned role. For every projection assert deterministic order, exact JSON keys, row checksum, page checksum, stable snapshot token, restart equality, and unchanged table counts/`PRAGMA data_version` after reads.

Use this required page shape:

```json
{
  "contract": "android-app-recovery-memory-v1",
  "characterId": "yuqi",
  "snapshotToken": "sha256:<64 lowercase hex>",
  "nextCursor": {"afterCreatedAt": 0, "afterId": ""},
  "hasMore": false,
  "rows": [],
  "pageChecksum": "<64 lowercase hex>"
}
```

Assert any `role_delete_v1` row makes all projections reject that character.

- [ ] **Step 2: Run Android red tests**

Run:

```bash
android\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.AppRecoveryProjectionTest --no-daemon --no-problems-report
android\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
```

Expected: compilation/test failure for missing recovery projection APIs.

- [ ] **Step 3: Add deterministic DAO queries**

Add read-only queries ordered by stable composite keys. Example:

```java
@Query("SELECT parts.* FROM reply_parts parts INNER JOIN chat_turns turns "
    + "ON turns.turnId = parts.turnId WHERE turns.characterId = :characterId "
    + "AND (parts.createdAt > :afterCreatedAt OR "
    + "(parts.createdAt = :afterCreatedAt AND parts.replyPartId > :afterId)) "
    + "ORDER BY parts.createdAt ASC, parts.replyPartId ASC LIMIT :limit")
List<ReplyPartEntity> appRecoveryReplyParts(
    String characterId, long afterCreatedAt, String afterId, int limit);
```

Add equivalent stable queries for memory records, role plans/history, and moment-producing turn/reply evidence. Queries must not mutate or auto-migrate rows.

- [ ] **Step 4: Implement store projection helpers**

Each helper runs inside one Room read transaction, rejects tombstoned roles, validates every stored row before projection, computes a role/category snapshot token from count + min/max identity/checksum, and computes `pageChecksum` over the closed output without `pageChecksum`.

Memory row keys are exactly:

```java
set("memoryId", "sourceKey", "characterId", "type", "title", "content",
    "vectorJson", "eventTime", "createdAt", "updatedAt", "manual", "sourceChecksum")
```

Reply/action rows may expose semantic content only through the explicit recovery call, never `inspectAppRecoveryState` or diagnostics.

- [ ] **Step 5: Expose matching Capacitor methods**

Validate `characterId`, cursor key, and limit before the store call. Return the closed store JSON unchanged. Do not log row bodies on failure.

- [ ] **Step 6: Run focused Android tests**

Run Step 2 commands plus:

```bash
android\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: BUILD SUCCESSFUL. If no device is connected, record `connectedDebugAndroidTest` as an unexecuted release gate, not a pass.

- [ ] **Step 7: Commit Task 2 only**

```bash
git add android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java android/app/src/test/java/com/siyi/al/execution/AppRecoveryProjectionTest.java
git commit -m "feat: expose verified native restoration projections"
```

### Task 3: Recover the Web-only sources and built-in Yuqi profile

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/lib/complete-app-restoration.js`
- Test: `tests/complete-app-restoration.test.mjs`
- Test: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes recovery journal keys `recovery_before_v1`, `recovery_before_mirror_v1`, current/legacy storage slots, and `YUQI_FIRST_PROFILE`.
- Produces `collectCompleteRestorationSources()` and `readVerifiedAvatarCandidate(roleId, sources)`.

- [ ] **Step 1: Write red source-recovery tests**

Cover current state, recovery-before raw slots, legacy `tavern_*` slots, the pre-recovery mirror record, current app-state mirror, and built-in Yuqi fallback. Assert source priority is field-specific, richer current data wins, recovery journal raw slots are never deleted, malformed whole JSON is not heuristically scraped, and avatar data is accepted only when it is a valid image data URL bound to role `yuqi` inside a valid source object.

- [ ] **Step 2: Run Web red tests**

```bash
node --test tests/complete-app-restoration.test.mjs tests/yuqi-ui-contract.test.mjs
```

Expected: FAIL for missing source collector and UI entry.

- [ ] **Step 3: Implement source collection**

Read recovery journal and mirror records without removing them. Convert valid raw snapshots with the existing recovery semantic reader. Pass the frozen built-in profile as the final role-card fallback only when role ID is exactly `yuqi`.

Never copy native `candidate.systemPrompt` into `char.systemPrompt`; retain it only as an opaque checksum/source field in the restoration report.

- [ ] **Step 4: Implement avatar acceptance**

Accept only `data:image/png|jpeg|webp|gif;base64,...` values under a verified `characters` row whose ID is `yuqi`. Enforce a decoded byte ceiling of 20 MiB and reject malformed Base64. If none exists, keep `avatarData: null` and set report status `no_verified_source` with reason `avatar_bytes_missing`.

- [ ] **Step 5: Run focused Web tests and commit**

Run Step 2. Expected: PASS.

```bash
git add tavern-app/index.html tavern-app/lib/complete-app-restoration.js tests/complete-app-restoration.test.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: recover verified web role presentation"
```

### Task 4: Assemble chat, memory, plan, and moment candidates

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/lib/complete-app-restoration.js`
- Test: `tests/complete-app-restoration.test.mjs`
- Test: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Produces `readAllNativeRecoveryPages(plugin, method, characterId)` and category-specific mappers.
- Consumes the Task 2 page contracts and existing `MemoryDB`/RolePlanRepository shapes.

- [ ] **Step 1: Write red end-to-end candidate tests**

Use three-page fixtures and assert pages cannot be reordered, omitted, duplicated, or mixed across snapshot tokens. Cover 1759 existing raw messages plus new reply/action evidence without duplicates; old-epoch/redacted rows stay suppressed; unknown action kinds remain `native_only`; existing manually edited memory wins; plan status/history and moment target identity are preserved.

- [ ] **Step 2: Run red tests**

Run the Task 3 focused command. Expected: FAIL for missing page reader/mappers.

- [ ] **Step 3: Implement exact page draining**

```js
async function readAllNativeRecoveryPages(plugin, method, characterId) {
  let cursor = { afterCreatedAt: 0, afterId: '' };
  let snapshotToken = '';
  const rows = [];
  do {
    const page = await plugin[method]({ characterId, ...cursor, limit: 100 });
    await verifyNativePage(page, method);
    if (snapshotToken && page.snapshotToken !== snapshotToken) {
      throw new Error('APP_RESTORATION_NATIVE_SNAPSHOT_CHANGED');
    }
    snapshotToken = page.snapshotToken;
    rows.push(...page.rows);
    cursor = page.nextCursor;
    if (!page.hasMore) return rows;
  } while (rows.length <= 100000);
  throw new Error('APP_RESTORATION_PAGE_LIMIT_CONFLICT');
}
```

- [ ] **Step 4: Implement category mappers**

Map only lossless types. Preserve unknown native data in place and report `native_only`, rather than reducing it to text. Role plans are merged by planId and historyId then sent once to RolePlanRepository after the final Web commit. Moment create/comment/like/reply actions require exact target closure. Memory vector JSON must parse as a finite-number array before it enters Web `vectors`.

- [ ] **Step 5: Run focused tests and commit**

Run Step 3 focused command. Expected: PASS.

```bash
git add tavern-app/index.html tavern-app/lib/complete-app-restoration.js tests/complete-app-restoration.test.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: assemble complete verified recovery candidate"
```

### Task 5: Coordinate permanent deletion and atomic multi-store commit

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/lib/app-state-recovery.js`
- Modify: `tavern-app/lib/complete-app-restoration.js`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Test: `tests/complete-app-restoration.test.mjs`
- Test: `tests/app-state-recovery.test.mjs`
- Test: `tests/yuqi-ui-contract.test.mjs`
- Test: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Produces `runCompleteRestorationTransaction(...)` and a metadata-only `complete_restoration_v1` journal.
- Uses the existing verified backup + `createRoleDelete` lifecycle for the exact 许弥 character ID.

- [ ] **Step 1: Write deletion and fault-boundary red tests**

Test the exact confirmed deletion ID and reject every other implicit zero-message deletion. Cover sources that attempt to reintroduce 许弥, late native result/UI replay, interrupted backup/control creation, waiting PC, applied deletion, and repeat recovery. Add fault injection after: journal prepare, Web slots, app-state mirror, MemoryDB category writes, role-plan replace, deletion intent persist, final verification, unlock.

- [ ] **Step 2: Run red Web and Android tests**

Run all focused commands from Tasks 1–4 plus Android Room tests. Expected: failures for missing complete transaction/deletion coordination.

- [ ] **Step 3: Expand the recovery journal**

Persist before-images for Web storage, app-state mirror, changed MemoryDB rows, and role-plan candidates. The journal record contains only checksums/counts:

```js
{
  version: 1,
  state: 'prepared',
  source: 'complete_phone_restoration',
  excludedRoleIds: ['char_1783694247588_zojx'],
  categoryChecksums: { roles: sha, chats: sha, moments: sha, memories: sha, rolePlans: sha },
  preparedAt,
  committedAt: null
}
```

- [ ] **Step 4: Persist the deletion intent before restoring**

Call the existing verified-backup role-delete path for the exact ID. Once the native lifecycle row exists, treat waiting/pending/relay_accepted/applied as frozen and excluded. If PC is unreachable, keep the delete control pending and continue only with Yuqi recovery; never show 许弥 as chat-capable.

- [ ] **Step 5: Commit and verify all categories**

Write the merged Web semantic state, app-state mirror, MemoryDB, and role plans in the documented order. Re-read every category, recompute checksums/counts, then mark journal committed and unlock. Roll back all Web-side stores before unlock on any mismatch. Never roll back an already-created remote deletion authority; retain it as the user-confirmed deletion.

- [ ] **Step 6: Run all focused gates and commit**

Expected: all focused tests PASS and repeated recovery produces no change.

```bash
git add tavern-app/index.html tavern-app/lib/app-state-recovery.js tavern-app/lib/complete-app-restoration.js android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java tests/complete-app-restoration.test.mjs tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java
git commit -m "fix: atomically restore phone data and delete stale role"
```

### Task 6: Add the one-button completeness report and recovery UX

**Files:**
- Modify: `tavern-app/index.html`
- Test: `tests/yuqi-ui-contract.test.mjs`
- Test: `test-basic.mjs`

**Interfaces:**
- Consumes `summarizePlan(plan)` and `runCompleteRestorationTransaction`.
- Produces a recovery screen with `一次性完整恢复`, per-category counts/status, deletion state, retry-safe progress, and copyable metadata-only diagnostics.

- [ ] **Step 1: Write UI red tests**

Assert the page shows roles, chat, rich structure, moments, memories, role plans, player/settings, and avatar as distinct rows. It must distinguish restored/already present/native only/no verified source/conflict; show 许弥 as permanent deletion rather than a recoverable role; and never insert bodies, prompts, avatar data, keys, or vectors into copied diagnostics.

- [ ] **Step 2: Run UI red tests**

```bash
node --test tests/yuqi-ui-contract.test.mjs test-basic.mjs
```

Expected: FAIL for missing complete-restoration controls.

- [ ] **Step 3: Implement the one-button flow**

The button first computes the report, then runs the deletion/restoration transaction, then renders the post-commit report. Disable it while active; persist progress so app reload resumes or rolls back; keep ordinary app writes frozen until verification. When only avatar bytes are missing, completion text must say “可验证数据已全部恢复；原头像没有可用副本” rather than claiming the avatar was restored.

- [ ] **Step 4: Run UI gates and commit**

Run Step 2. Expected: PASS.

```bash
git add tavern-app/index.html tests/yuqi-ui-contract.test.mjs test-basic.mjs
git commit -m "feat: show complete phone restoration report"
```

### Task 7: Full regression, signed release, and phone acceptance

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tavern-app/sw-v11.js`
- Modify: `android-update.json`
- Create: `artifacts/qa/al-complete-phone-restoration-1.0.122.md`

**Interfaces:**
- Produces official same-package, same-certificate APK `AL-1.0.122-release.apk` and a phone acceptance record.

- [ ] **Step 1: Run complete local gates**

```bash
node --test tests/complete-app-restoration.test.mjs tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs test-basic.mjs
npm.cmd test
android\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-daemon --no-problems-report
git diff --check
```

Expected: all tests pass, zero skipped gates except the explicitly unavailable connected-device execution.

- [ ] **Step 2: Verify no unrelated files are staged**

```bash
git status --short
git diff --name-only HEAD
```

Compare the result with Tasks 1–7 file lists. Preserve pre-existing plan dirt, zhaxian-workbench deletions, artifacts, presets, and user files.

- [ ] **Step 3: Bump and publish 1.0.122**

Follow `docs/AL-android-signing-runbook.md`. Keep package ID unchanged, set `versionName 1.0.122`, `versionCode 122`, synchronize Gradle/Actions/service-worker cache/update manifest, push the authorized `codex/al-tdd` branch, and trigger the official signed workflow.

- [ ] **Step 4: Verify release artifact**

Record APK SHA-256, package ID, versionName/versionCode, signing validity, and official certificate SHA-256. Never deliver an unsigned/debug/different-certificate artifact as an update.

- [ ] **Step 5: Phone acceptance without USB**

Install over the current app without clearing storage. In the recovery page run `一次性完整恢复`, then export the metadata-only report. Acceptance requires:

- 许弥 absent and deletion state pending/applied; after restart she remains absent.
- 虞栖 message count is at least the recovered 1759 baseline plus later valid messages, with no duplicate IDs.
- Every verifiable native category reports restored/already present; unsupported native rows report native_only; missing avatar bytes report no_verified_source.
- Existing cloud binding, bridge configuration, current messages, and proactive settings remain intact.
- Repeating recovery and restarting produce identical counts/checksums.

- [ ] **Step 6: Commit release metadata**

```bash
git add android/app/build.gradle .github/workflows/android-apk.yml tavern-app/sw-v11.js android-update.json artifacts/qa/al-complete-phone-restoration-1.0.122.md
git commit -m "release: prepare AL 1.0.122 complete restoration"
```
