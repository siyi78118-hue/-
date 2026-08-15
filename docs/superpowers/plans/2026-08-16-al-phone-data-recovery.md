# AL Phone Data Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a same-package Android recovery release that prevents empty/corrupt Web state from overwriting surviving phone data, inventories native Room data without writes, and safely restores missing role entries from an unambiguous source.

**Architecture:** A pure Web recovery-policy module classifies localStorage, legacy keys, IndexedDB mirror, and native census before normal boot is allowed. Android exposes a metadata-only, read-only Room census and a separately requested role candidate. Recovery is a two-phase Web transaction that merges stable identities and verifies the result before unfreezing the existing app.

**Tech Stack:** Capacitor WebView, vanilla JavaScript, Node `node:test`, Android Java, Room/SQLite, Gradle Android tests.

## Global Constraints

- Do not clear, migrate destructively, uninstall, or overwrite existing phone data.
- Do not resume ordinary 1.0.120 release work until the recovery gate is complete.
- A `role_delete_v1` tombstone is the only authority that a role was intentionally deleted.
- Recovery adds missing rows by stable identity; it never deletes existing Web or Room rows.
- Diagnostics contain counts, byte sizes, timestamps, IDs, and checksums only; no chat text, API keys, or role prompts.
- Room role prompts are returned only by the explicit recovery-candidate call, never by ordinary diagnostics.
- If any source is ambiguous or malformed, the app remains frozen and exposes diagnostics instead of guessing.
- Without a connected device, do not claim that real-phone recovery succeeded.

---

### Task 1: Pure Web Recovery Policy and Startup Write Barrier

**Files:**
- Create: `tavern-app/lib/app-state-recovery.js`
- Create: `tests/app-state-recovery.test.mjs`
- Modify: `tavern-app/index.html:961-975,1547-1550,5077-5140,13676-13776`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Produces: `ALAppStateRecovery.readStorageSlot(storage, primaryKey, legacyKey)` returning `{status, source, value, rawBytes, errorCode}`.
- Produces: `ALAppStateRecovery.decideRecovery({local, mirror, native})` returning `{mode, frozen, source, reasonCode}`.
- Produces: `ALAppStateRecovery.mergeRecoveryState(current, candidate)` returning a non-destructive merged state.
- Produces: global `appStateRecoveryGuard` with `frozen`, `reasonCode`, `allowNormalBoot()` and `assertWritable()`.

- [ ] **Step 1: Write failing policy tests**

```js
test('invalid primary JSON uses a valid legacy slot without treating corruption as empty', () => {
  const storage = fakeStorage({ rpchat_characters: '{', tavern_characters: '[{"id":"yuqi"}]' });
  assert.deepEqual(readStorageSlot(storage, 'rpchat_characters', 'tavern_characters'), {
    status: 'valid', source: 'legacy', value: [{ id: 'yuqi' }], rawBytes: 15,
    errorCode: 'PRIMARY_JSON_INVALID'
  });
});

test('newer empty local state cannot overwrite an older non-empty mirror', () => {
  const decision = decideRecovery({
    local: state({ characters: [], updatedAt: 200 }),
    mirror: state({ characters: [{ id: 'yuqi' }], updatedAt: 100 }),
    native: census({ roleCount: 1 })
  });
  assert.equal(decision.mode, 'restore_mirror');
  assert.equal(decision.frozen, true);
});

test('native roles plus empty web sources freeze normal boot', () => {
  assert.deepEqual(decideRecovery({
    local: state({ characters: [] }), mirror: state({ characters: [] }),
    native: census({ roleCount: 1 })
  }), { mode: 'native_candidate', frozen: true, source: 'native', reasonCode: 'WEB_ROLE_DIRECTORY_MISSING' });
});
```

- [ ] **Step 2: Run the focused test and observe red**

Run: `node --test tests/app-state-recovery.test.mjs`

Expected: FAIL because `tavern-app/lib/app-state-recovery.js` does not exist.

- [ ] **Step 3: Implement the minimal pure policy module**

```js
function decideRecovery({ local, mirror, native }) {
  if (local.invalidCritical) return usable(mirror) ? frozen('restore_mirror', 'mirror', 'LOCAL_STATE_INVALID')
    : frozen('diagnostic_only', '', 'LOCAL_STATE_INVALID');
  if (hasRoles(local)) return normal();
  if (hasRoles(mirror)) return frozen('restore_mirror', 'mirror', 'LOCAL_ROLE_DIRECTORY_EMPTY');
  if (Number(native?.roleCount) > 0) return frozen('native_candidate', 'native', 'WEB_ROLE_DIRECTORY_MISSING');
  return normal();
}
```

`readStorageSlot` must parse primary and legacy strings independently. It may fall back from an invalid primary value to a valid legacy value, but must preserve `PRIMARY_JSON_INVALID` in the returned evidence. `mergeRecoveryState` merges roles/messages/moments by stable IDs and never removes a current row.

- [ ] **Step 4: Add the startup barrier to the Web app**

Replace silent critical reads with evidence-aware reads before assigning `settings`, `characters`, `allChats`, and `allMoments`. While frozen:

```js
DB.set = (key, value) => {
  appStateRecoveryGuard.assertWritable(key);
  // existing write and mirror scheduling
};

async function mirrorAppStateNow() {
  appStateRecoveryGuard.assertWritable('app_state');
  // existing mirror body
}
```

`bootApp()` must resolve the recovery decision before `startNativeReplyPolling`, listeners, `syncFromServiceWorkerState`, proactive loops, role-plan sync, or the final mirror call. A frozen decision renders recovery UI only.

- [ ] **Step 5: Add contract assertions for zero side effects while frozen**

The UI contract must assert that the recovery gate precedes native polling and that `mirrorAppStateNow`, `reconcileNativeExecutionTurns`, `checkProactiveMessages`, and role-plan sync all call the guard.

- [ ] **Step 6: Run green tests**

Run: `node --test tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs`

Expected: PASS; existing normal-state boot assertions remain unchanged.

- [ ] **Step 7: Commit Task 1**

```bash
git add tavern-app/lib/app-state-recovery.js tavern-app/index.html tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "fix: freeze unsafe empty web state"
```

---

### Task 2: Read-Only Android Room Recovery Census

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Create: `android/app/src/test/java/com/siyi/al/AppRecoveryPluginContractTest.java`

**Interfaces:**
- Produces: `RoomExecutionStore.inspectAppRecoveryState()` returning metadata-only `JSONObject`.
- Produces: `RoomExecutionStore.readAppRecoveryRoleCandidate(String characterId)` returning one explicit recovery candidate including name/playerName/systemPrompt.
- Produces: `RoomExecutionStore.readAppRecoveryMessages(String characterId, long afterSentAt, String afterMessageId, int limit)` returning an ordered, bounded page of verified raw messages.
- Produces plugin methods `inspectAppRecoveryState`, `readAppRecoveryRoleCandidate`, and `readAppRecoveryMessages`.

- [ ] **Step 1: Write failing real-Room tests**

Create snapshots, turns, raw messages, reply parts, memory, and role plans for two roles; tombstone one with a verified `role_delete_v1` control. Capture every relevant table count before and after:

```java
JSONObject census = store.inspectAppRecoveryState();
assertEquals(1, census.getInt("roleCount"));
assertEquals("yuqi", census.getJSONArray("roles").getJSONObject(0).getString("characterId"));
assertFalse(census.toString().contains("secret chat text"));
assertEquals(beforeCounts, snapshotCounts(database));
```

Close and reopen Room, then assert byte-for-byte equivalent canonical census output except for database file size fields that may grow but not shrink due to the read.

- [ ] **Step 2: Run Android test compilation and observe red**

Run: `android\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report`

Expected: FAIL because the census methods and DAO queries do not exist.

- [ ] **Step 3: Add scoped DAO queries**

Add a sorted union query for distinct character IDs represented in snapshots, turns, raw messages, memory, or role plans. Exclude any character with a `role_delete_v1` lifecycle control. Add scoped count/time-range queries and:

```java
@Query("SELECT * FROM character_snapshots WHERE characterId = :characterId "
    + "ORDER BY createdAt DESC, snapshotId DESC LIMIT 1")
CharacterSnapshotEntity latestRecoverySnapshot(String characterId);
```

No query may use `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, or a writable transaction.

- [ ] **Step 4: Implement store-owned census validation**

For each role, return only:

```json
{
  "characterId":"yuqi",
  "displayName":"虞栖",
  "latestSnapshotAt":123,
  "turnCount":10,
  "rawMessageCount":20,
  "replyPartCount":8,
  "memoryCount":4,
  "rolePlanCount":2,
  "candidateAvailable":true
}
```

`readAppRecoveryRoleCandidate` must re-check absence of a role-delete tombstone and return exact keys `characterId,name,playerName,systemPrompt,createdAt,sourceSnapshotId,sourceChecksum`. The checksum is SHA-256 of canonical JSON excluding `sourceChecksum`.

`readAppRecoveryMessages` must re-check the tombstone, use `(sentAt,messageId)` keyset pagination, cap `limit` at 200, return only stable message identity/speaker/recipient/content/time/origin/checksum fields, and never load the full 6 GB data set into memory. Each page includes `nextAfterSentAt`, `nextAfterMessageId`, and `done`.

- [ ] **Step 5: Expose the two plugin calls**

`inspectAppRecoveryState` also reports `databaseBytes`, `walBytes`, and `shmBytes` from `applicationContext.getDatabasePath("al-execution.db")` and sibling files. The candidate/message calls return semantic content only after the user presses recovery. None of the three calls may open a backup, modify Room, or record a diagnostic.

- [ ] **Step 6: Run focused Android gates**

Run:

```powershell
android\gradlew.bat :app:testDebugUnitTest --no-daemon --no-problems-report
android\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: BUILD SUCCESSFUL. If `adb devices` is empty, record connected tests as unexecuted rather than passed.

- [ ] **Step 7: Commit Task 2**

```bash
git add android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java android/app/src/test/java/com/siyi/al
git commit -m "feat: inspect surviving phone data without writes"
```

---

### Task 3: Safe Source Selection and Recovery Screen

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/lib/app-state-recovery.js`
- Modify: `tests/app-state-recovery.test.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: `inspectAppRecoveryState`, `readAppRecoveryRoleCandidate`, `decideRecovery`, `mergeRecoveryState`.
- Produces: `prepareAppStateRecovery()`, `renderAppStateRecoveryScreen()`, `commitAppStateRecovery(source)`.

- [ ] **Step 1: Write failing source-selection tests**

Cover these exact cases:

1. valid non-empty primary local state -> normal boot;
2. invalid primary + valid legacy -> frozen legacy candidate;
3. empty local + older non-empty mirror -> frozen mirror candidate;
4. non-empty local + empty newer mirror -> normal local, mirror cannot overwrite;
5. empty Web + one or more native roles -> frozen native candidate;
6. native candidate with tombstone -> excluded;
7. conflicting role IDs/snapshot checksums -> diagnostic-only;
8. no source data -> legitimate empty app, normal boot.

- [ ] **Step 2: Run focused test and observe red**

Run: `node --test tests/app-state-recovery.test.mjs`

Expected: FAIL on the missing prepare/render/commit functions.

- [ ] **Step 3: Implement pre-boot source collection**

`prepareAppStateRecovery()` must:

- read critical local slots without writes;
- open IndexedDB in the current schema without deleting/recreating stores;
- call native census only in the Android app;
- calculate the decision;
- return immediately for a valid non-empty normal state;
- leave the guard frozen and render the recovery screen for all recovery decisions.

- [ ] **Step 4: Implement the recovery screen**

Display only counts, byte sizes, source names, reason code, and role display names. Buttons:

- `恢复角色入口` invokes the selected two-phase commit;
- `复制诊断` copies metadata-only JSON;
- no create/import/clear/ordinary backup controls are rendered while frozen.

- [ ] **Step 5: Prove frozen UI has no background writers**

Use test doubles for plugin, localStorage, IndexedDB and timers. After rendering the recovery screen, advance timers and dispatch focus/visibility/app-state events; assert zero calls to DB writes, mirror writes, native apply, submitTurn, proactive scheduling, role-plan sync, and service-worker state writes.

- [ ] **Step 6: Run green Web gates**

Run: `node --test tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs tests/test-basic.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add tavern-app/index.html tavern-app/lib/app-state-recovery.js tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs tests/test-basic.mjs
git commit -m "feat: add phone data recovery screen"
```

---

### Task 4: Two-Phase Non-Destructive Recovery Commit

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/lib/app-state-recovery.js`
- Modify: `tests/app-state-recovery.test.mjs`
- Modify: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Consumes: selected local/legacy/mirror/native candidate plus its checksum.
- Produces: durable `recovery_candidate_v1` record with states `prepared|committed|rolled_back`.

- [ ] **Step 1: Write failing transaction/fault tests**

Inject faults after each boundary:

1. candidate prepared;
2. characters localStorage written;
3. chats localStorage written;
4. moments localStorage written;
5. reread verified;
6. app_state mirror written;
7. candidate committed;
8. guard unfrozen.

At boundaries 1-7, restart and assert the pre-recovery state is restored or the exact prepared transaction resumes idempotently. No current role/message may disappear.

- [ ] **Step 2: Run and observe red**

Run: `node --test tests/app-state-recovery.test.mjs --test-name-pattern="two-phase|fault|idempotent"`

Expected: FAIL because no durable recovery transaction exists.

- [ ] **Step 3: Implement candidate preparation**

Write `MemoryDB.setMeta('recovery_candidate_v1', record)` where the record has exact keys:

```json
{
  "version":1,
  "state":"prepared",
  "source":"mirror",
  "reasonCode":"LOCAL_ROLE_DIRECTORY_EMPTY",
  "beforeChecksum":"...",
  "candidateChecksum":"...",
  "preparedAt":123,
  "committedAt":null
}
```

The before snapshot itself remains in a separate recovery-only IndexedDB value and is never logged or displayed.

- [ ] **Step 4: Implement merge, verification and rollback**

Merge by `character.id`, message ID, and moment ID. Preserve the more complete current role object and all current rows. After writes, reread each JSON slot, revalidate, and compare the target checksum. Only then write `app_state`, mark committed, and call `allowNormalBoot()`.

If verification fails, restore the exact before snapshot, mark rolled_back, retain the guard, and show a stable recovery error.

- [ ] **Step 5: Implement native candidate recovery**

Request one candidate at a time and verify its checksum in JavaScript. Create a minimal normalized role object using the original `characterId`, name, playerName and systemPrompt. Page through `readAppRecoveryMessages` with the returned keyset cursor, verify every message checksum and stable order, and merge each bounded page by message ID. Do not synthesize avatars, moments, relationship state, memories, or plans. Mark missing Web-only presentation data for later backup merge.

- [ ] **Step 6: Run recovery and normal-regression gates**

Run:

```powershell
node --test tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs tests/test-basic.mjs
npm.cmd test
```

Expected: all pass, zero skipped tests newly introduced by this work.

- [ ] **Step 7: Commit Task 4**

```bash
git add tavern-app/index.html tavern-app/lib/app-state-recovery.js tests/app-state-recovery.test.mjs tests/yuqi-ui-contract.test.mjs tests/test-basic.mjs
git commit -m "fix: recover missing roles without overwriting data"
```

---

### Task 5: Release Verification and Recovery APK

**Files:**
- Modify only if required by existing release contract: `android/app/build.gradle`, `.github/workflows/android-release.yml`, `tavern-app/sw-v11.js`, update manifest files.
- Create: `artifacts/AL-1.0.120-recovery-verification.txt`
- Create: `artifacts/AL-1.0.120-recovery-release.apk` after signed workflow succeeds.

**Interfaces:**
- Consumes: committed Tasks 1-4 and the existing formal signing workflow.
- Produces: same-package, same-certificate recovery APK with verified hashes.

- [ ] **Step 1: Run static and full gates**

```powershell
git diff --check
npm.cmd test
android\gradlew.bat :app:testDebugUnitTest :app:assembleDebugAndroidTest --no-daemon --no-problems-report
adb devices -l
```

Expected: Web/PC/Android tests pass. If no device is attached, `connectedDebugAndroidTest` remains an explicit unfulfilled release gate.

- [ ] **Step 2: Verify package/version/cache/update consistency**

Assert package `com.siyi.al`, versionCode `120`, versionName `1.0.120`, Service Worker cache/version and update manifest all reference the same recovery build. The recovery APK must not silently enable normal release rollout before phone recovery is verified.

- [ ] **Step 3: Build through the formal signing workflow**

Follow `docs/AL-android-signing-runbook.md`. Do not present an unsigned/debug APK as installable recovery software.

- [ ] **Step 4: Verify signed artifact**

Record:

- APK filename and byte size;
- SHA-256;
- package/version code/version name;
- signer certificate SHA-256 matching the established production certificate;
- build workflow/run ID;
- connected-device gate status.

- [ ] **Step 5: Phone handoff**

Tell the user to install by coverage update only. Do not uninstall or clear storage. First launch should show either the normal existing roles or the recovery screen. Do not claim success until the user confirms the source counts and restored role directory.

