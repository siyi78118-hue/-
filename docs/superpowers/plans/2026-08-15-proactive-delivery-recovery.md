# Proactive Delivery Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development for every production change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover real Android proactive chat and moment delivery across old FCM registrations, process crashes, silent replays and the existing remote-paused/local-scheduled upgrade state.

**Architecture:** Cloud automatic-authority FCM deliveries remain retryable until a later authority transition completes them. Android distinguishes claim, replay and stale outcomes, and a Room-owned reconciler may requeue only the exact immutable outbox generation whose matching remote row is an empty paused shell.

**Tech Stack:** Cloudflare Worker/D1, Node test runner, Android Java, Room, WorkManager, Capacitor WebView, Gradle.

## Global Constraints

- Do not modify cognition, memory, expression or quality replay.
- Do not use manual test push as end-to-end evidence.
- Do not change job ID, due time, generation or checksum during repair.
- Preserve legacy non-authority timer behavior and direct-conversation pause.
- Preserve role-deletion suppression.
- Work in the shared checkout with exclusive file locks; do not reset, checkout or stage unrelated dirt.
- “常务” is read-only throughout.

---

### Task 1: Cloud automatic delivery retention and exact recovery

**Owner:** primary controller

**Files:**
- Modify: `cloud-timer-worker.js`
- Modify: `tests/cloud-timer-worker.test.mjs`
- Modify: `tests/cloud-timer-d1.test.mjs`

**Interfaces:**
- Consumes: the existing validated automatic transition and delivery tuple.
- Produces: exact paused-shell recovery through `transitionAutomaticStream(input)`; automatic FCM always returns `awaitingAck=true` after transport acceptance.

- [ ] **Step 1: Write failing Worker tests**

Add cases proving that an automatic-authority FCM target with `backgroundAck=0` enters `awaiting_ack`, while a legacy job retains fire-and-forget behavior. Add a D1 case whose current row is an empty `paused` shell with the same generation/checksum and whose exact scheduled transition restores `scheduled`, original job ID, original due time and payload.

- [ ] **Step 2: Run the red tests**

Run:

```powershell
node --test tests/cloud-timer-worker.test.mjs tests/cloud-timer-d1.test.mjs
```

Expected: the new capability and paused-shell recovery assertions fail before production edits.

- [ ] **Step 3: Implement the minimal state-machine change**

In `deliverJob`, compute `awaitingAck` as true for every successful FCM `automaticAuthority` job. In `transitionAutomaticStream`, distinguish `idempotent` from `recover_paused`: recovery is allowed only for `input.operation === 'schedule'`, exact generation/checksum/identity, current `state === 'paused'`, and null active job/due/payload. Use the existing CAS update and reject every other mismatch.

- [ ] **Step 4: Run focused and basic gates**

```powershell
node --test tests/cloud-timer-worker.test.mjs tests/cloud-timer-d1.test.mjs
node test-basic.mjs
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Stop for 常务 read-only review**

Do not deploy until 常务 has reproduced the old failure and rejected cross-generation, direct-pause, active-job and changed-checksum recovery.

### Task 2: Android outcome closure and metadata events

**Owner:** 中控

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AutomaticTaskCoordinator.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Test: `android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java`
- Test: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: `AutomaticTaskCoordinator.DispatchOutcome` and the existing schedule event table.
- Produces: `recordAutomaticDeliveryOutcome(...)` and `enqueueAutomaticScheduleReconcile(...)`; `REPLAY` wakes without notifying.

- [ ] **Step 1: Write failing dispatch tests**

Cover `CLAIMED` = one notification + wake, `REPLAY` = zero notification + wake, `STALE` = zero semantic rows/notification + one metadata event + reconcile request, invalid token = zero semantic rows + reconcile request, and role-deleted = no event/wake/notification.

- [ ] **Step 2: Run the red unit tests**

```powershell
android\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.AlFirebaseMessagingServiceTest --no-daemon --no-problems-report
```

Expected: new outcome assertions fail.

- [ ] **Step 3: Implement outcome handling**

Keep Room claim before any wake. Split notification from wake: only `CLAIMED` runs the pending-notification policy; `CLAIMED` and `REPLAY` enqueue execution. `STALE` and safely identifiable invalid input call the metadata-only event writer and schedule reconciler, then return without semantic writes.

- [ ] **Step 4: Run unit and instrumentation compile gates**

```powershell
android\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.AlFirebaseMessagingServiceTest --no-daemon --no-problems-report
android\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Stop for 常务 review**

常务 must verify no duplicate turn, notification, payment/moment/reply row or role-deleted side effect.

### Task 3: Room-owned remote reconciliation

**Owner:** 中控

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleSender.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/ExecutionRuntime.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionWakeWorker.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Test: `android/app/src/test/java/com/siyi/al/execution/AutomaticScheduleSenderTest.java`
- Test: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`

**Interfaces:**
- Consumes: closed `/v2/schedule-status`, local authority and immutable outbox rows.
- Produces: `reconcileRemotePausedSchedules(now)` and an exact `synced -> waiting` outbox CAS.

- [ ] **Step 1: Write failing parser and Room tests**

Cover the exact repair predicate, malformed/extra response keys, remote identity/checksum/generation/job/due conflicts, local paused/claimed/disabled states, role deletion, concurrent reconcilers and restart. Assert that successful repair leaves generation/job/due/payload/checksum byte-identical and only changes outbox/cloud-sync state.

- [ ] **Step 2: Run the red gates**

```powershell
android\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.AutomaticScheduleSenderTest --no-daemon --no-problems-report
android\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
```

Expected: parser/requeue APIs are missing or new assertions fail.

- [ ] **Step 3: Implement closed status parsing and exact CAS**

POST the stream identity to `/v2/schedule-status`, parse only the documented keys and compare every persisted authority field. Within one Room transaction re-read authority, outbox, claimed turn and tombstone, then CAS only the exact synced outbox row to waiting and set its authority cloud-sync state to waiting. Enqueue the existing sender; never invoke the planner.

- [ ] **Step 4: Run focused tests and Android build gate**

```powershell
android\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.AutomaticScheduleSenderTest --no-daemon --no-problems-report
android\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --no-problems-report
git diff --check
```

Expected: all pass. If no device is connected, record but do not claim `connectedDebugAndroidTest`.

- [ ] **Step 5: Stop for 常务 review**

常务 independently checks that normal scheduled/awaiting-ack, direct pause, role deletion and claimed turns cannot be repaired.

### Task 4: Compact truthful status

**Owner:** 中控

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `tavern-app/index.html`
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: last metadata-only schedule event and local authority status.
- Produces: compact real-delivery stage/time and transport-only wording for the manual test.

- [ ] **Step 1: Write failing UI contract tests**

Require the manual test label to say it verifies only FCM transport. Require compact status to show current schedule, cloud sync and last real delivery stage, while excluding old HTML errors, tokens and full epochs.

- [ ] **Step 2: Run red UI tests**

```powershell
node --test tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
```

Expected: the new copy/stage assertions fail.

- [ ] **Step 3: Implement the projection and UI copy**

Extend the native status projection with only `lastDeliveryStage` and `lastDeliveryAt`. Render a compact current state and move historical details out of the primary status block. Do not infer success from a manual test.

- [ ] **Step 4: Run UI and Android compile gates**

```powershell
node --test tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
android\gradlew.bat :app:compileDebugAndroidTestJavaWithJavac --no-daemon --no-problems-report
git diff --check
```

Expected: all pass.

### Task 5: Independent integration, deployment and release

**Owner:** primary controller; 常务 is read-only reviewer

**Files:**
- Modify after all implementation gates: version/release manifest, Service Worker cache and release workflow files required by the Android signing runbook.
- Create: `artifacts/qa/proactive-delivery-recovery-1.0.120.md`
- Create after signed build: `artifacts/AL-1.0.120-release.apk`

**Interfaces:**
- Consumes: Tasks 1-4 reviewed commits.
- Produces: deployed Worker, signed 1.0.120 APK and production smoke evidence.

- [ ] **Step 1: Run combined local gates**

```powershell
node --test tests/cloud-timer-worker.test.mjs tests/cloud-timer-d1.test.mjs tests/yuqi-ui-contract.test.mjs
node test-basic.mjs
android\gradlew.bat :app:testDebugUnitTest --no-daemon --no-problems-report
android\gradlew.bat :app:assembleDebugAndroidTest --no-daemon --no-problems-report
git diff --check
```

Expected: all pass; no `.only` or `.skip` in modified tests.

- [ ] **Step 2: 常务 performs final adversarial review**

Require a written P0/P1 verdict for cloud retries, exact repair, dispatch outcomes, direct pause, role deletion, restart and all file boundaries. Fix any confirmed issue before deployment.

- [ ] **Step 3: Deploy Worker and verify production health**

Deploy only the reviewed Worker. Verify `/health` version, cron health and that no migration or unrelated binding changed.

- [ ] **Step 4: Build and verify signed APK**

Follow `docs/AL-android-signing-runbook.md`. Verify package `com.siyi.al`, versionName `1.0.120`, versionCode `120`, APK signer certificate SHA-256 and file SHA-256. Never substitute a debug or unsigned APK.

- [ ] **Step 5: Run the real production smoke test**

After cover-install and opening the app, wait for one short-interval real proactive chat generation. Pass only when the cloud reports the stream delivered/advanced, Android records a real claim/replay stage, the PC database contains the new proactive turn, and the next schedule exists. The manual test notification is supplemental only.

- [ ] **Step 6: Publish evidence and delivery**

Record exact timestamps, stream generation, PC turn ID, test commands, APK identity and remaining device-test limitations in the QA artifact; then place the signed APK in `artifacts/`.

## Self-Review

- Every design requirement is assigned to a task.
- Cloud and Android implementation files are disjoint until the integration task.
- Recovery uses the immutable existing generation and never invokes the planner.
- Direct pause, role deletion and legacy timer behavior have explicit negative tests.
- The only unavailable gate allowed before APK creation is device instrumentation when no device is attached; the final production smoke still requires the user's phone.

