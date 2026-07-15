# Clear All Automatic Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one emergency button that stops and clears every automatic private-chat and moment task across web state, Service Worker state, Android native execution, and Cloudflare while preserving the device push binding and user data.

**Architecture:** The browser freezes scheduling first and persists a clean application snapshot, then asks the native execution plugin and Cloudflare Worker to purge their task layers. The Cloudflare endpoint deletes only `mom_` and `pro_` jobs for one device and removes their due-bucket references while leaving `sub:<deviceId>` intact; Service Worker and FCM guards reject late pushes after cleanup.

**Tech Stack:** Vanilla HTML/JavaScript, Service Worker + IndexedDB, Capacitor 8, Android Java, Room 2, WorkManager, Cloudflare Workers KV, Node `assert`, JUnit 4.

## Global Constraints

- Preserve characters, chat messages, moment content, memory data, API keys, model settings, `deviceId`, `pushSubscription`, `nativeFcmToken`, `pushTransport`, and `sub:<deviceId>`.
- Clear only `PROACTIVE_CHAT` and `PROACTIVE_MOMENT`; never cancel `DIRECT_REPLY`.
- Freeze `proactiveEnabled` and `cloudTimerEnabled` before any asynchronous native or cloud request.
- The clear operation must be idempotent and must report web, Android, and cloud results separately.
- Re-enabling “主动消息” and “云闹钟” must create fresh jobs without rebinding push.
- `KV.list()` is allowed only in the explicit cleanup request path; cron delivery must remain bucket-driven and scan-free.
- Follow red-green-refactor: every production change starts with a failing test and ends with the focused test plus the relevant regression suite passing.

---

## File Map

- `cloud-timer-worker.js`: add device-scoped task purge endpoint and paginated KV helpers.
- `test-basic.mjs`: add Worker endpoint, web cleanup helper, UI, Service Worker gate, and preservation tests.
- `tavern-app/index.html`: add the danger button, pure cleanup helpers, native/cloud orchestration, persistence, status reporting, and restore behavior.
- `tavern-app/sw-v11.js`: reject proactive pushes when the mirrored switches are off.
- `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`: add transactional bulk updates for automatic turns, attempts, completed inbox rows, and proactive snapshots.
- `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`: expose one typed bulk-cleanup operation.
- `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskCleanupResult.java`: carry native cleanup counts without coupling the plugin to SQL details.
- `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`: expose cancellation of the unique wake work.
- `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`: expose `clearAutomaticTasks()` to JavaScript, stop the service, and return counts.
- `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`: reject snapshots explicitly marked disabled.
- `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`: verify native bulk cleanup preserves direct replies.
- `android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java`: verify late FCM rejection.
- `scripts/check-cloud-timer.mjs`: update the expected deployed Worker version.
- `CLOUD_TIMER_DEPLOY.md`: document the cleanup endpoint and retained subscription guarantee.

---

### Task 1: Device-scoped Cloudflare task purge

**Files:**
- Modify: `test-basic.mjs:588-650`
- Modify: `cloud-timer-worker.js:25-130, 240-320`
- Modify: `scripts/check-cloud-timer.mjs:1-20`
- Modify: `CLOUD_TIMER_DEPLOY.md`

**Interfaces:**
- Consumes: `POST /cancel-device-tasks` JSON `{ deviceId: string }`.
- Produces: JSON `{ ok: true, deviceId, momentJobsDeleted, chatJobsDeleted, dueReferencesDeleted, dueBucketsDeleted, subscriptionPreserved }`.
- Produces: `cancelDeviceAutomaticTasks(deviceId, env): Promise<CleanupSummary>` for the Worker request handler.

- [ ] **Step 1: Write the failing Worker tests**

Add a paginated KV mock and assertions to `test-basic.mjs`:

```js
const purgeStore = new Map([
  ['sub:device-a', '{"deviceId":"device-a"}'],
  ['job:mom_device-a_char-1_a', '{"deviceId":"device-a","jobId":"mom_device-a_char-1_a","kind":"moment"}'],
  ['job:pro_device-a_char-1_b', '{"deviceId":"device-a","jobId":"pro_device-a_char-1_b","kind":"chat"}'],
  ['job:mom_device-b_char-2_c', '{"deviceId":"device-b","jobId":"mom_device-b_char-2_c","kind":"moment"}'],
  ['job:test_device-a_char-1_d', '{"deviceId":"device-a","jobId":"test_device-a_char-1_d","kind":"chat","test":true}'],
  ['due:100', '["mom_device-a_char-1_a","mom_device-b_char-2_c"]'],
  ['due:101', '["pro_device-a_char-1_b"]'],
  ['due:102', '["mom_device-a_char-1_orphan"]']
]);
const purgeEnv = {
  AL_TIMER_KV: {
    async get(key) { return purgeStore.get(key) ?? null; },
    async put(key, value) { purgeStore.set(key, value); },
    async delete(key) { purgeStore.delete(key); },
    async list({ prefix = '', cursor = '' }) {
      const rows = [...purgeStore.keys()].filter(key => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = rows.slice(start, start + 1);
      return { keys: page.map(name => ({ name })), list_complete: start + 1 >= rows.length, cursor: String(start + 1) };
    }
  }
};
const purgeResponse = await cloudWorkerModule.default.fetch(new Request('https://worker.example/cancel-device-tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'device-a' })
}), purgeEnv);
const purgeResult = await purgeResponse.json();
assert.equal(purgeResponse.status, 200);
assert.deepEqual(
  { moment: purgeResult.momentJobsDeleted, chat: purgeResult.chatJobsDeleted, refs: purgeResult.dueReferencesDeleted },
  { moment: 1, chat: 1, refs: 3 }
);
assert.equal(purgeStore.has('job:mom_device-a_char-1_a'), false);
assert.equal(purgeStore.has('job:pro_device-a_char-1_b'), false);
assert.equal(purgeStore.has('job:mom_device-b_char-2_c'), true);
assert.equal(purgeStore.has('job:test_device-a_char-1_d'), true);
assert.equal(purgeStore.has('sub:device-a'), true);
assert.equal(purgeStore.get('due:100'), '["mom_device-b_char-2_c"]');
assert.equal(purgeStore.has('due:101'), false);
```

Replace the global no-list assertion with a cron-specific assertion:

```js
const runDueJobsSource = cloudTimerWorker.slice(
  cloudTimerWorker.indexOf('async function runDueJobs'),
  cloudTimerWorker.indexOf('async function getLastCron')
);
assert.doesNotMatch(runDueJobsSource, /\.list\s*\(/, 'cron path must not scan KV');
assert.match(cloudTimerWorker, /url\.pathname === '\/cancel-device-tasks'/);
```

- [ ] **Step 2: Run the Node test and verify RED**

Run: `npm test`

Expected: FAIL because `/cancel-device-tasks` returns 404 and the cleanup counts are absent.

- [ ] **Step 3: Implement the paginated explicit cleanup path**

In `cloud-timer-worker.js`, bump the Worker version to `2026-07-15.14`, add request validation, and implement:

```js
async function listKvKeys(env, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await env.AL_TIMER_KV.list({ prefix, ...(cursor ? { cursor } : {}) });
    names.push(...(page.keys || []).map(row => row.name));
    cursor = page.list_complete ? '' : page.cursor;
  } while (cursor);
  return names;
}

function validDeviceId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function isDeviceAutomaticJobId(jobId, deviceId) {
  const value = String(jobId || '');
  return value.startsWith(`mom_${deviceId}_`) || value.startsWith(`pro_${deviceId}_`);
}

async function cancelDeviceAutomaticTasks(deviceId, env) {
  if (!validDeviceId(deviceId)) throw new Error('invalid deviceId');
  const prefixes = [
    { prefix: `job:mom_${deviceId}_`, kind: 'moment' },
    { prefix: `job:pro_${deviceId}_`, kind: 'chat' }
  ];
  let momentJobsDeleted = 0;
  let chatJobsDeleted = 0;
  for (const row of prefixes) {
    for (const key of await listKvKeys(env, row.prefix)) {
      const raw = await env.AL_TIMER_KV.get(key);
      const job = raw ? JSON.parse(raw) : null;
      if (!job || job.deviceId !== deviceId || job.test) continue;
      await env.AL_TIMER_KV.delete(key);
      if (row.kind === 'moment') momentJobsDeleted += 1;
      else chatJobsDeleted += 1;
    }
  }
  let dueReferencesDeleted = 0;
  let dueBucketsDeleted = 0;
  for (const key of await listKvKeys(env, 'due:')) {
    const raw = await env.AL_TIMER_KV.get(key);
    const ids = raw ? JSON.parse(raw) : [];
    const remaining = ids.filter(id => !isDeviceAutomaticJobId(id, deviceId));
    dueReferencesDeleted += ids.length - remaining.length;
    if (remaining.length === ids.length) continue;
    if (remaining.length) await env.AL_TIMER_KV.put(key, JSON.stringify(remaining), { expirationTtl: JOB_BUCKET_TTL_SECONDS });
    else {
      await env.AL_TIMER_KV.delete(key);
      dueBucketsDeleted += 1;
    }
  }
  return {
    ok: true,
    deviceId,
    momentJobsDeleted,
    chatJobsDeleted,
    dueReferencesDeleted,
    dueBucketsDeleted,
    subscriptionPreserved: !!(await env.AL_TIMER_KV.get(`sub:${deviceId}`))
  };
}
```

Add the route before `/cancel`:

```js
if (request.method === 'POST' && url.pathname === '/cancel-device-tasks') {
  const body = await request.json();
  const result = await cancelDeviceAutomaticTasks(String(body.deviceId || ''), env);
  await appendEvent(env, {
    type: 'cancel-device-tasks',
    deviceId: shortId(body.deviceId),
    momentJobsDeleted: result.momentJobsDeleted,
    chatJobsDeleted: result.chatJobsDeleted,
    dueReferencesDeleted: result.dueReferencesDeleted,
    dueBucketsDeleted: result.dueBucketsDeleted,
    ok: true
  });
  return json(result);
}
```

Update `scripts/check-cloud-timer.mjs` to expect `2026-07-15.14` and document the endpoint in `CLOUD_TIMER_DEPLOY.md`.

- [ ] **Step 4: Run the Node test and verify GREEN**

Run: `npm test`

Expected: PASS, including pagination, other-device preservation, test-task preservation, due cleanup, and subscription preservation.

- [ ] **Step 5: Commit the Worker slice**

```bash
git add cloud-timer-worker.js test-basic.mjs scripts/check-cloud-timer.mjs CLOUD_TIMER_DEPLOY.md
git commit -m "feat: purge automatic tasks by device"
```

---

### Task 2: Android native bulk cancellation and late-FCM protection

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskCleanupResult.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java`

**Interfaces:**
- Produces: `RoomExecutionStore.clearAutomaticTasks(long now): AutomaticTaskCleanupResult`.
- Produces: Capacitor method `AlExecution.clearAutomaticTasks(): Promise<{cancelledTurns, cancelledAttempts, acknowledgedCompletedTurns, deletedSnapshots}>`.
- Produces: `AlExecutionWakeWorker.cancel(Context)`.
- Produces: `AlFirebaseMessagingService.snapshotAllowsAutomaticTask(CharacterSnapshotEntity, String): boolean`.

- [ ] **Step 1: Write failing native store tests**

Add helper submissions with explicit kinds and this test to `RoomExecutionStoreTest.java`:

```java
@Test
public void clearAutomaticTasksCancelsOnlyProactiveWork() {
    store.submitTurn(submission("direct", "direct-msg", TurnKind.DIRECT_REPLY));
    store.submitTurn(submission("chat-auto", "chat-auto-msg", TurnKind.PROACTIVE_CHAT));
    store.submitTurn(submission("moment-auto", "moment-auto-msg", TurnKind.PROACTIVE_MOMENT));

    AutomaticTaskCleanupResult result = store.clearAutomaticTasks(20L);

    assertEquals(2, result.cancelledTurns);
    assertEquals(TurnState.QUEUED, store.displayState("direct"));
    assertEquals(TurnState.CANCELLED, store.displayState("chat-auto"));
    assertEquals(TurnState.CANCELLED, store.displayState("moment-auto"));
}
```

Add a completed proactive turn, acknowledge verification, and snapshot row assertion:

```java
@Test
public void clearAutomaticTasksSuppressesCompletedInboxAndDeletesSnapshots() {
    store.submitTurn(submission("completed-auto", "completed-auto-msg", TurnKind.PROACTIVE_MOMENT));
    String attemptId = store.activeAttempt("completed-auto").attemptId;
    prepareChatDone("completed-auto", attemptId);
    store.commitReply("completed-auto", attemptId,
        Collections.singletonList(textPart("completed-auto", attemptId, "旧朋友圈")), 12L);
    CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
    snapshot.snapshotId = "char-1:moment";
    snapshot.characterId = "char-1";
    snapshot.characterName = "角色";
    snapshot.playerName = "我";
    snapshot.systemPrompt = "";
    snapshot.momentSystemPrompt = "";
    snapshot.contextJson = "{\"cloudJobId\":\"old\"}";
    snapshot.chatConfigId = "chat-v1";
    snapshot.memoryConfigId = "memory-v1";
    snapshot.createdAt = 1L;
    database.executionDao().upsertSnapshot(snapshot);

    AutomaticTaskCleanupResult result = store.clearAutomaticTasks(20L);

    assertEquals(1, result.acknowledgedCompletedTurns);
    assertEquals(1, result.deletedSnapshots);
    assertEquals(0, store.unappliedCompletedTurns(10).size());
    assertEquals(null, database.executionDao().latestSnapshot("char-1:moment"));
}
```

- [ ] **Step 2: Write the failing late-FCM unit test**

Add to `AlFirebaseMessagingServiceTest.java`:

```java
@Test
public void rejectsSnapshotWhenAutomaticTasksAreDisabled() {
    CharacterSnapshotEntity snapshot = new CharacterSnapshotEntity();
    snapshot.contextJson = "{\"cloudJobId\":\"job-current\",\"automaticTasksEnabled\":false}";
    assertFalse(AlFirebaseMessagingService.snapshotAllowsAutomaticTask(snapshot, "job-current"));
}
```

- [ ] **Step 3: Run focused Android tests and verify RED**

Run:

```powershell
cd android
./gradlew.bat testDebugUnitTest
./gradlew.bat connectedDebugAndroidTest
```

Expected: compile/test failure because the cleanup result, store method, and snapshot guard do not exist.

- [ ] **Step 4: Implement transactional native cleanup**

Create `AutomaticTaskCleanupResult.java`:

```java
package com.siyi.al.execution;

public final class AutomaticTaskCleanupResult {
    public final int cancelledTurns;
    public final int cancelledAttempts;
    public final int acknowledgedCompletedTurns;
    public final int deletedSnapshots;

    public AutomaticTaskCleanupResult(int cancelledTurns, int cancelledAttempts, int acknowledgedCompletedTurns, int deletedSnapshots) {
        this.cancelledTurns = cancelledTurns;
        this.cancelledAttempts = cancelledAttempts;
        this.acknowledgedCompletedTurns = acknowledgedCompletedTurns;
        this.deletedSnapshots = deletedSnapshots;
    }
}
```

Add DAO update methods restricted to `PROACTIVE_CHAT` and `PROACTIVE_MOMENT`, then combine them in a `@Transaction` default method. The attempt update must run before clearing `activeAttemptId` on turns:

```java
@Query("UPDATE execution_attempts SET state = 'CANCELLED', stage = 'FINISHED', heartbeatAt = :now, finishedAt = :now, errorCode = 'CANCELLED', retryable = 0 WHERE turnId IN (SELECT turnId FROM chat_turns WHERE kind IN ('PROACTIVE_CHAT','PROACTIVE_MOMENT') AND state != 'COMPLETED') AND state NOT IN ('COMPLETED','CANCELLED')")
int cancelAutomaticAttempts(long now);

@Query("UPDATE chat_turns SET state = 'CANCELLED', activeAttemptId = NULL, updatedAt = :now, cancelledAt = :now WHERE kind IN ('PROACTIVE_CHAT','PROACTIVE_MOMENT') AND state NOT IN ('COMPLETED','CANCELLED')")
int cancelAutomaticTurns(long now);

@Query("UPDATE chat_turns SET uiAppliedAt = :now WHERE kind IN ('PROACTIVE_CHAT','PROACTIVE_MOMENT') AND state = 'COMPLETED' AND uiAppliedAt IS NULL")
int acknowledgeCompletedAutomaticTurns(long now);

@Query("DELETE FROM character_snapshots")
int deleteProactiveSnapshots();
```

Have `RoomExecutionStore.clearAutomaticTasks()` call those four operations inside `database.runInTransaction()` and return their counts.

```java
public AutomaticTaskCleanupResult clearAutomaticTasks(long now) {
    final int[] counts = new int[4];
    database.runInTransaction(() -> {
        counts[1] = dao.cancelAutomaticAttempts(now);
        counts[0] = dao.cancelAutomaticTurns(now);
        counts[2] = dao.acknowledgeCompletedAutomaticTurns(now);
        counts[3] = dao.deleteProactiveSnapshots();
    });
    return new AutomaticTaskCleanupResult(counts[0], counts[1], counts[2], counts[3]);
}
```

- [ ] **Step 5: Implement plugin/service cancellation and FCM guard**

Add to `AlExecutionWakeWorker`:

```java
public static void cancel(Context context) {
    WorkManager.getInstance(context.getApplicationContext()).cancelUniqueWork(WORK_NAME);
}
```

Add `@PluginMethod clearAutomaticTasks` to `AlExecutionPlugin` that calls the store, cancels wake work, stops `AlExecutionService`, and resolves the four counts. Do not clear `AlSecretStore`.

```java
@PluginMethod
public void clearAutomaticTasks(PluginCall call) {
    execute(call, () -> {
        AutomaticTaskCleanupResult cleanup = store.clearAutomaticTasks(System.currentTimeMillis());
        AlExecutionWakeWorker.cancel(getContext());
        getContext().stopService(new Intent(getContext(), AlExecutionService.class));
        JSObject result = new JSObject();
        result.put("cancelledTurns", cleanup.cancelledTurns);
        result.put("cancelledAttempts", cleanup.cancelledAttempts);
        result.put("acknowledgedCompletedTurns", cleanup.acknowledgedCompletedTurns);
        result.put("deletedSnapshots", cleanup.deletedSnapshots);
        return result;
    });
}
```

Add this guard helper and use it in `onMessageReceived` before `submitTurn`:

```java
static boolean snapshotAllowsAutomaticTask(CharacterSnapshotEntity snapshot, String jobId) {
    if (!matchesSnapshotJob(snapshot, jobId)) return false;
    try {
        return new JSONObject(snapshot.contextJson).optBoolean("automaticTasksEnabled", true);
    } catch (Exception ignored) {
        return false;
    }
}
```

- [ ] **Step 6: Run focused Android tests and verify GREEN**

Run:

```powershell
cd android
./gradlew.bat testDebugUnitTest
./gradlew.bat connectedDebugAndroidTest
```

Expected: PASS. If no emulator/device is attached, `testDebugUnitTest` must pass and the instrumentation command must be recorded as environment-blocked rather than silently skipped.

- [ ] **Step 7: Commit the Android slice**

```bash
git add android/app/src/main/java/com/siyi/al android/app/src/test/java/com/siyi/al android/app/src/androidTest/java/com/siyi/al
git commit -m "feat: clear native automatic task queue"
```

---

### Task 3: Service Worker suppression and automatic-call log filtering

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/sw-v11.js:150-190, 1600-1730`
- Modify: `tavern-app/index.html:3080-3265, 1891-1955`

**Interfaces:**
- Produces: `automaticTasksEnabled(settings): boolean` in both page and Service Worker contexts.
- Produces: `isAutomaticTaskCallLog(log): boolean` in the page context.
- Extends native proactive snapshots with `automaticTasksEnabled: true`.

- [ ] **Step 1: Write failing page and Service Worker tests**

Add static and behavioral assertions to `test-basic.mjs`:

```js
assert.match(swScript, /if \(!automaticTasksEnabled\(state\.settings\)\) return/);
assert.match(script, /automaticTasksEnabled: automaticTasksEnabled\(settings\)/);
assert.match(script, /function isAutomaticTaskCallLog\(log\)/);

const automaticLogProbe = vm.runInContext(`JSON.stringify([
  isAutomaticTaskCallLog({ scene: 'proactive-moment' }),
  isAutomaticTaskCallLog({ scene: 'background-memory-query-moment-post' }),
  isAutomaticTaskCallLog({ scene: 'chat' })
])`, context);
assert.equal(automaticLogProbe, JSON.stringify([true, true, false]));
```

Export `automaticTasksEnabled` and `isAutomaticTaskCallLog` through the existing `__appTest` object for the behavioral probe.

- [ ] **Step 2: Run Node tests and verify RED**

Run: `npm test`

Expected: FAIL because the helpers and push guard do not exist.

- [ ] **Step 3: Implement the shared semantics**

Add equivalent helpers in the page and Service Worker:

```js
function automaticTasksEnabled(currentSettings = {}) {
  return currentSettings.proactiveEnabled === true && currentSettings.cloudTimerEnabled === true;
}

function isAutomaticTaskCallLog(log = {}) {
  const scene = String(log.scene || '').toLowerCase();
  return scene.includes('proactive')
    || scene.includes('moment-post')
    || scene.includes('background-memory-query-proactive');
}

async function automaticTasksStillEnabled() {
  const current = await getMeta('app_state', null).catch(() => null);
  return automaticTasksEnabled(current?.settings || {});
}
```

In each Service Worker proactive push entry, load `app_state` and return before memory/chat work when `automaticTasksEnabled(state.settings)` is false. Before committing generated content, writing `app_state`, scheduling recovery, or scheduling the next task, reload `app_state` and abort when the switches have since been disabled. This second check prevents an already-running handler from overwriting the clean mirror after the button is pressed.

Add `automaticTasksEnabled: automaticTasksEnabled(settings)` to the native proactive snapshot JSON created by `syncNativeProactiveSnapshot()`.

- [ ] **Step 4: Run Node tests and verify GREEN**

Run: `npm test`

Expected: PASS, with manual chat logs retained and automatic-task scenes identified.

- [ ] **Step 5: Commit the guard slice**

```bash
git add tavern-app/sw-v11.js tavern-app/index.html test-basic.mjs
git commit -m "fix: suppress disabled automatic task pushes"
```

---

### Task 4: One-click web cleanup orchestration and UI

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html:850-875, 1300-1325, 2310-2350, 7000-7050, 7660-7720, 8400-8460, 9000-9020`

**Interfaces:**
- Produces: `clearAutomaticTaskChatState(chats): { chats, clearedChatJobs, clearedMomentJobs }`.
- Produces: `clearAutomaticTaskSettings(settings): settings` preserving binding fields.
- Produces: `clearAllAutomaticTasks(): Promise<CleanupReport>`.
- Consumes: native `AlExecution.clearAutomaticTasks()` and Worker `POST /cancel-device-tasks`.

- [ ] **Step 1: Write failing pure-state tests**

Add test data and assertions to `test-basic.mjs`:

```js
const cleanupStateProbe = vm.runInContext(`(() => {
  const oldSettings = {
    proactiveEnabled: true,
    cloudTimerEnabled: true,
    deviceId: 'device-a',
    pushSubscription: { transport: 'fcm', token: 'keep-token' },
    nativeFcmToken: 'keep-token',
    chatApiKey: 'keep-chat-key'
  };
  const oldChats = {
    char1: {
      messages: [{ role: 'user', content: '保留消息' }],
      pendingProactiveJob: { jobId: 'pro-a' },
      pendingMomentJob: { jobId: 'mom-a' },
      cloudScheduleSyncedAt: 1,
      cloudMomentScheduleSyncedAt: 2,
      lastProactiveMomentError: 'old error'
    }
  };
  return JSON.stringify({
    settings: clearAutomaticTaskSettings(oldSettings),
    result: clearAutomaticTaskChatState(oldChats)
  });
})()`, context);
const cleanupState = JSON.parse(cleanupStateProbe);
assert.equal(cleanupState.settings.proactiveEnabled, false);
assert.equal(cleanupState.settings.cloudTimerEnabled, false);
assert.equal(cleanupState.settings.pushSubscription.token, 'keep-token');
assert.equal(cleanupState.settings.chatApiKey, 'keep-chat-key');
assert.equal(cleanupState.result.chats.char1.messages[0].content, '保留消息');
assert.equal('pendingProactiveJob' in cleanupState.result.chats.char1, false);
assert.equal('pendingMomentJob' in cleanupState.result.chats.char1, false);
assert.equal(cleanupState.result.clearedChatJobs, 1);
assert.equal(cleanupState.result.clearedMomentJobs, 1);
```

Add UI and ordering assertions:

```js
assert.match(html, /紧急清空全部自动任务/);
assert.match(html, /保留聊天、角色、配置和云闹钟绑定/);
assert.match(script, /async function clearAllAutomaticTasks\(\)/);
assert.match(script, /POST[\s\S]*\/cancel-device-tasks/);
```

- [ ] **Step 2: Run Node tests and verify RED**

Run: `npm test`

Expected: FAIL because the button and pure cleanup helpers are missing.

- [ ] **Step 3: Implement pure cleanup helpers**

Add cloning helpers that do not mutate the caller while tests exercise them:

```js
function clearAutomaticTaskSettings(current = {}) {
  const next = { ...current, proactiveEnabled: false, cloudTimerEnabled: false };
  [
    'cloudTimerLastStatus', 'cloudTimerLastChatStatus', 'cloudTimerLastMomentStatus',
    'cloudTimerLastChatTrace', 'cloudTimerLastMomentTrace',
    'cloudTimerLastTriggerAckStatus', 'cloudTimerLastTestAckStatus'
  ].forEach(key => { next[key] = ''; });
  [
    'cloudTimerLastStatusAt', 'cloudTimerLastChatStatusAt', 'cloudTimerLastMomentStatusAt',
    'cloudTimerLastChatTraceAt', 'cloudTimerLastMomentTraceAt',
    'cloudTimerLastTriggerAckAt', 'cloudTimerLastTestAckAt'
  ].forEach(key => { next[key] = 0; });
  return next;
}

function clearAutomaticTaskChatState(chats = {}) {
  const next = JSON.parse(JSON.stringify(chats || {}));
  let clearedChatJobs = 0;
  let clearedMomentJobs = 0;
  Object.values(next).forEach(chat => {
    if (!chat || typeof chat !== 'object') return;
    if (chat.pendingProactiveJob) clearedChatJobs += 1;
    if (chat.pendingMomentJob) clearedMomentJobs += 1;
    [
      'pendingProactiveJob', 'pendingMomentJob',
      'cloudScheduleSyncedAt', 'cloudMomentScheduleSyncedAt',
      'lastProactiveFailedAt', 'lastProactiveChatFailedAt', 'lastProactiveMomentFailedAt',
      'lastProactiveChatError', 'lastProactiveMomentError'
    ].forEach(key => delete chat[key]);
  });
  return { chats: next, clearedChatJobs, clearedMomentJobs };
}
```

- [ ] **Step 4: Implement persistence, native/cloud calls, and per-layer report**

Implement `clearAllAutomaticTasks()` in this exact order:

```js
async function clearAllAutomaticTasks() {
  if (!confirm('将关闭主动消息和云闹钟，并清空本机与云端的全部主动私聊、朋友圈任务。聊天、角色、记忆、API 配置和设备绑定不会删除。继续？')) return null;
  const button = document.getElementById('clear-all-automatic-tasks');
  if (button) button.disabled = true;
  const report = { web: { ok: false }, native: { ok: !isNativeApp(), skipped: !isNativeApp() }, cloud: { ok: false } };
  try {
    settings = clearAutomaticTaskSettings(settings);
    const local = clearAutomaticTaskChatState(allChats);
    allChats = local.chats;
    DB.set('settings', settings);
    DB.set('chats', allChats);
    localStorage.setItem('rpchat_app_state_updated_at', String(Date.now()));
    const localLogs = getModelCallLogs().filter(log => !isAutomaticTaskCallLog(log));
    localStorage.setItem('rpchat_call_logs', JSON.stringify(localLogs));
    const swLogs = await MemoryDB.getMeta('call_logs', []);
    await MemoryDB.setMeta('call_logs', (Array.isArray(swLogs) ? swLogs : []).filter(log => !isAutomaticTaskCallLog(log)));
    await mirrorAppStateNow();
    startProactiveLoop();
    report.web = { ok: true, clearedChatJobs: local.clearedChatJobs, clearedMomentJobs: local.clearedMomentJobs };

    const plugin = nativeExecutionPlugin();
    if (plugin?.clearAutomaticTasks) {
      try { report.native = { ok: true, ...(await plugin.clearAutomaticTasks()) }; }
      catch (error) { report.native = { ok: false, error: friendlyErrorMessage(error) }; }
    }

    try {
      const response = await fetchWithTimeout(timerUrl('/cancel-device-tasks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: settings.deviceId })
      }, API_TIMEOUT_MS);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      report.cloud = result;
    } catch (error) {
      report.cloud = { ok: false, error: friendlyErrorMessage(error) };
    }

    document.getElementById('set-proactive-enabled').value = 'off';
    document.getElementById('set-cloud-timer-enabled').value = 'off';
    renderCloudTimerStatus();
    renderDiagnosticsScreen();
    showAutomaticTaskCleanupReport(report);
    return report;
  } finally {
    if (button) button.disabled = false;
  }
}
```

`showAutomaticTaskCleanupReport(report)` must show each layer independently and use the approved success copy only when all applicable layers succeed.

```js
function showAutomaticTaskCleanupReport(report) {
  const layer = (label, row) => row?.ok
    ? `${label}：完成`
    : row?.skipped
      ? `${label}：不适用`
      : `${label}：失败｜${row?.error || '未知错误'}`;
  const allOk = report.web?.ok && (report.native?.ok || report.native?.skipped) && report.cloud?.ok;
  const message = allOk
    ? '已清空全部自动任务并暂停调度。云闹钟绑定已保留；重新开启“主动消息”和“云闹钟”即可恢复。'
    : [
        '自动任务已停止，部分清理步骤需要重试。',
        layer('本地网页', report.web),
        layer('Android 原生', report.native),
        layer('云端', report.cloud)
      ].join('\n');
  setCloudTimerStatus(message, true);
  toast(message, allOk ? 3600 : 5200);
}
```

- [ ] **Step 5: Add the danger button and exports**

Add to the diagnostics action group:

```html
<button class="cell danger" id="clear-all-automatic-tasks" onclick="clearAllAutomaticTasks()" type="button">
  <div class="cell-label">紧急清空全部自动任务</div>
  <div class="cell-body">保留聊天、角色、配置和云闹钟绑定</div>
  <div class="mini">›</div>
</button>
```

Export `clearAutomaticTaskSettings`, `clearAutomaticTaskChatState`, `isAutomaticTaskCallLog`, and `clearAllAutomaticTasks` through `__appTest`/`ALDebug` as appropriate.

- [ ] **Step 6: Run Node tests and verify GREEN**

Run: `npm test`

Expected: PASS, including preservation, idempotence, button copy, and cleanup ordering assertions.

- [ ] **Step 7: Commit the web slice**

```bash
git add tavern-app/index.html test-basic.mjs
git commit -m "feat: add emergency automatic task cleanup"
```

---

### Task 5: Integrated verification, deployment, and production cleanup

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- Consumes all interfaces from Tasks 1-4.
- Produces a deployed Worker version `2026-07-15.14` and a verified Android debug build.

- [ ] **Step 1: Run the full local web suite**

Run: `npm test`

Expected: PASS with no assertion failures.

- [ ] **Step 2: Run Android unit tests and build**

Run:

```powershell
cd android
./gradlew.bat testDebugUnitTest assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Run Android instrumentation tests when a device is available**

Run:

```powershell
cd android
./gradlew.bat connectedDebugAndroidTest
```

Expected: PASS. If no device is attached, record the exact Gradle failure and do not claim instrumentation coverage.

- [ ] **Step 4: Re-run repository diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional feature files are modified.

- [ ] **Step 5: Deploy and health-check the Worker**

Use the authenticated Wrangler wrapper already configured for this workspace:

```powershell
& 'C:\Users\Administrator\Tools\bin\wrangler.cmd' deploy
node scripts/check-cloud-timer.mjs
```

Expected: deployment succeeds and health reports version `2026-07-15.14`.

- [ ] **Step 6: Exercise the button on the affected device**

Before clicking, record the affected device's current `job:mom_`, `job:pro_`, `due:`, and `sub:` counts. Click “紧急清空全部自动任务” once and verify the UI reports web, Android, and cloud success separately.

Expected after two cron cycles:

- Target device `mom_` jobs: 0.
- Target device `pro_` jobs: 0.
- Target device references in `due:` buckets: 0.
- `sub:dev_q6kzt72oymqmrge8f9x`: still present.
- No new automatic memory or chat model calls.

- [ ] **Step 7: Verify restoration without rebinding**

Turn “主动消息” and “云闹钟” back on and save.

Expected: the existing subscription is reused, each active conversation receives at most one new chat job and one new moment job, and none of the deleted job IDs returns.

- [ ] **Step 8: Final feature commit if verification required adjustments**

If verification required a code correction, stage only the affected feature files and commit:

```bash
git add cloud-timer-worker.js tavern-app/index.html tavern-app/sw-v11.js test-basic.mjs android/app/src/main/java android/app/src/test/java android/app/src/androidTest/java scripts/check-cloud-timer.mjs CLOUD_TIMER_DEPLOY.md
git commit -m "fix: complete automatic task cleanup verification"
```

If no correction was required, do not create an empty commit.
