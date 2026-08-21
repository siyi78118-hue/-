# Role Delete Observability P0 Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with a review gate after each task.

**Goal:** Make role deletion observable, frozen, idempotent, and recoverable after timeout without claiming to solve the 6GB deletion latency yet.

**Architecture:** Create a durable operation journal and role-freeze tombstone in one short transaction. Keep the existing semantic deletion transaction unchanged for P0, but record its lifecycle outside that long transaction and reconcile unknown outcomes after restart. All role-scoped semantic writers must honor the durable freeze gate.

**Tech Stack:** Android Java, Room, SQLite migrations, Capacitor plugin, Web app, JUnit/Room tests.

**Current implementation status (2026-08-21):** The journal entity, v16→v17 migration, DAO CAS methods, public plugin status/reconcile API, Web extended status validation, automatic status-timeout reconciliation, and store-owned semantic-write gates are implemented in the working tree. Focused Android execution is still pending because the host Gradle process is blocked by the Windows CET environment error; no APK has been released.

## Global Constraints

- P0 does not introduce batched deletion; that is a later P1.
- A timeout or lost response is `unknown`, never guessed as success or rollback.
- Recovery of Yuqi and deletion of Xumi remain separate operations.
- No APK release until migration, timeout, restart, idempotency, and rollback tests pass.
- Existing user dirt and unrelated task changes remain untouched.

### Task 1: Map Current Role-Delete Contracts

**Files:**
- Read: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Read: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Read: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Read/Test: existing Room role-delete tests

- [x] Step 1: Record current schema version, lifecycle control semantics, delete phases, and every role-scoped writer.
- [x] Step 2: Verify whether the retained role-delete control is a durable freeze gate for every writer; if not, stop and add the missing gate to the implementation scope.
- [x] Step 3: Write the first red tests for operation/tombstone atomic creation, timeout unknown, restart reconciliation, and duplicate calls.

### Task 2: Add Operation Journal and Atomic Freeze

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/db/RoleDeleteOperationEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Test: `android/app/src/androidTest/java/com/siyi/al/execution/RoleDeleteOperationTest.java`, existing `RoomExecutionStoreTest.java`

**Interface:** `prepareRoleDeleteOperation(characterId, peerId, expectedCursorChecksum, backupReceipt, requestedAt)` returns an immutable operation snapshot and creates the operation plus freeze tombstone atomically. State starts at `prepared`; no bulk rows are deleted in this transaction.

- [x] Step 1: Add migration/entity fields: operationId, controlId, characterId, operationChecksum, state, phase, cursor, affectedCount, sourceSnapshotChecksum, createdAt, updatedAt, lastError.
- [x] Step 2: Add DAO insert, exact read, and compare-and-set state update methods.
- [x] Step 3: Add failing tests for duplicate operation identity, foreign role, cursor/checksum mismatch, and operation-without-tombstone prevention.
- [x] Step 4: Implement one short transaction that inserts the journal and retained freeze tombstone together.
- [ ] Step 5: Run focused Room tests and verify rollback leaves neither row.

### Task 3: Make All Role Writers Honor the Durable Gate

**Files:**
- Modify only the existing role-scoped writer files identified in Task 1 (including `android/app/src/main/java/com/siyi/al/execution/AutomaticScheduleStore.java` for its direct claim API).
- Test: Room writer, bridge, automatic, role-plan, FCM, and Web contract tests.

- [x] Step 1: Add red tests for prepared/running/unknown freeze blocking submit, retry, cloud import, plan occurrence, memory, mirror, and notification side effects.
- [x] Step 2: Route each writer through one store-owned gate; do not duplicate role-delete logic in callers.
- [x] Step 3: Verify non-deleted roles remain unaffected.

### Task 4: Add Timeout-Safe State Reconciliation

**Files:**
- Modify: `RoomExecutionStore.java`, `AlExecutionPlugin.java`, Web recovery/delete caller.
- Test: Room restart tests and Web plugin contract tests.

**Interface:** `queryRoleDeleteOperation(operationId)` returns only metadata: operationId, controlId, roleId, state, phase, cursor, counts, timestamps, and error code.

- [x] Step 1: Add red tests for explicit failure, response loss, process restart, committed tombstone, rolled-back transaction, and unknown state.
- [x] Step 2: Implement `unknown` as the only result for timeout/connection loss without proof.
- [x] Step 3: On restart, reconcile operation journal with the retained tombstone and verified role rows; never use a single row's presence as proof.
- [x] Step 4: Make duplicate calls with the same operation identity return the existing operation; block a second delete while state is prepared/running/unknown.

### Task 5: Version and Resource Gate

**Files:**
- Modify version/migration tests only after Tasks 1–4 are green.
- Read: signing runbook and installed-material identity records.

- [ ] Step 1: Run migration tests on a small clone, then a medium clone; do not open the original 6GB database.
- [x] Step 2: Run Android unit tests and assemble the test APK (focused unit 56/56; `assembleDebugAndroidTest` BUILD SUCCESSFUL).
- [x] Step 3: Record absent-device instrumentation as an explicit release blocker, not a pass (`adb devices` has no attached device; connected tests not claimed).
- [ ] Step 4: Stop before APK release unless all focused tests, migration checks, and artifact identity checks pass.

P1 batching, P2 restore/delete separation, full compatibility adapters, and proactive-message correlation remain separate plans.
