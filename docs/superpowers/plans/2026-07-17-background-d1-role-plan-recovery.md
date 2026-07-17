# Background D1 Role Plan Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver proactive messages and role plans without requiring the app to return to foreground, replace KV task writes with D1, and make every role-plan occurrence recoverable and observable.

**Architecture:** Use D1 as the authoritative cloud timer queue. On Android, converge FCM, AlarmManager, boot/app-start, a 60-second foreground-service scan, and 15-minute WorkManager fallback through a Room-backed occurrence coordinator; expedited WorkManager extends FCM processing and a visible placeholder notification preserves high-priority semantics.

**Tech Stack:** Cloudflare Worker JavaScript, D1/SQLite migrations, Node tests, Android Java, Room, WorkManager, AlarmManager, Firebase Cloud Messaging, Capacitor web UI.

## Global Constraints

- Preserve all existing committed 1.06 role-plan and native execution work.
- Do not restore or stage unrelated deleted `zhaxian-workbench` files or untracked APK/doc/preset files.
- Use tests first for every behavioral change.
- Do not store chat, memory, prompts, or API keys in D1.
- A role-plan occurrence is unique by `planId + scheduledFor`.
- New cloud writes go to D1, not KV.

---

### Task 1: D1 timer store

**Files:**
- Create: `migrations/0001_timer_store.sql`
- Create: `tests/helpers/fake-d1.mjs`
- Create: `tests/cloud-timer-d1.test.mjs`
- Modify: `cloud-timer-worker.js`
- Modify: `wrangler.toml`
- Modify: `package.json`

**Interfaces:**
- Consumes: existing `/register`, `/schedule`, `/job-status`, `/cancel`, `/ack`, `/trigger`, `/cancel-device-tasks`, cron requests.
- Produces: the same HTTP contract backed by `env.AL_TIMER_DB`.

- [ ] Write a failing D1 test asserting one row per job, logical replacement, idempotent retry, independent role plans, indexed due delivery, ack deletion, device cleanup, and no KV writes.
- [ ] Run `node --test tests/cloud-timer-d1.test.mjs`; expect failure because the D1 binding/schema is absent.
- [ ] Add the two-table schema and due/device indexes.
- [ ] Replace KV job/subscription access with prepared D1 statements and transactional `batch()` writes; cron selects due rows directly.
- [ ] Add D1 limit classification while preserving structured retryable errors.
- [ ] Run the D1 test and the complete `npm test`; expect pass.

### Task 2: Android wake coordinator

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/AlBackgroundCoordinator.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlPeriodicRecoveryWorker.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/AlPlanAlarmReceiver.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/RolePlanOccurrenceStore.java`
- Create tests with matching names under `android/app/src/test/java/com/siyi/al/execution/`
- Modify: `AlExecutionWakeWorker.java`, `AlExecutionService.java`, `AlFirebaseMessagingService.java`, `AlBootReceiver.java`, `MainActivity.java`, and `AndroidManifest.xml`.

**Interfaces:**
- `AlBackgroundCoordinator.ensureScheduled(Context)` registers unique 15-minute periodic recovery.
- `AlExecutionWakeWorker.enqueueExpedited(Context, reason)` uses `OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST`.
- FCM, alarms, boot, app start, and service failure all call the coordinator.

- [ ] Add failing policy tests for expedited FCM work, 15-minute periodic recovery, stable alarm identifiers, and FCM priority diagnostics.
- [ ] Run targeted Android tests; expect failure because coordinator APIs are absent.
- [ ] Implement the coordinator, placeholder notification, priority logging, expedited work, periodic scan, alarm receiver, boot/update rescheduling, and exact/inexact permission-aware alarm scheduling.
- [ ] Run targeted tests and `gradlew.bat testDebugUnitTest`; expect pass.

### Task 3: Durable plan occurrences and UI sync state

**Files:**
- Create: `RolePlanOccurrenceEntity.java` and coordinator tests.
- Modify: `RolePlanEntity.java`, `AlExecutionDatabase.java`, `AlExecutionDao.java`, `AlExecutionPlugin.java`, `AlFirebaseMessagingService.java`, `AlExecutionService.java`, `tavern-app/index.html`, role-plan repository/domain tests, and recovery tests.

**Interfaces:**
- Room migration 3→4 adds unique occurrence rows and cloud/local sync fields.
- `claimOccurrence` is transactional and returns true exactly once.
- Web repository exposes local/cloud/alarm status and foreground `reconcile`.

- [ ] Add failing Room/domain/repository tests for duplicate claims, overdue recovery, remote verification, sync failure display, cleanup, recurrence continuation, and scheduled-vs-executed time.
- [ ] Run the focused tests; expect failures for missing occurrence and status fields.
- [ ] Implement migration, atomic claim/completion/failure, pending cloud sync, background and foreground reconciliation, truthful timing context, and bounded retries.
- [ ] Add schedule-screen status text and retry controls without adding chat messages.
- [ ] Run focused tests and full JS/Android suites; expect pass.

### Task 4: Cloud deployment and update package

**Files:**
- Modify only version/update files required by the existing release channel after all tests pass.

- [ ] Run `wrangler deploy --dry-run` and Android lint.
- [ ] Create/apply the D1 migration remotely, deploy the Worker, and verify `/health`, register, schedule, status, trigger, and ack with isolated IDs.
- [ ] Build the signed/update-channel APK through the existing workflow without overwriting unrelated work.
- [ ] Verify the in-app update manifest points at the new build.
