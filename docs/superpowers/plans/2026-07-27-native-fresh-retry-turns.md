# Native Fresh Retry Turns Implementation Plan

**Goal:** Make user-triggered retries real native execution turns and recover
legacy phantom retries without duplicate replies.

**Architecture:** Room permits multiple turns for one canonical message and uses
the primary turn ID for idempotency. The browser keeps explicit retry ancestry
and applies the first completed member of a lineage, while suppressing later
members before side effects.

**Tech stack:** Android Java, Room, Capacitor, browser JavaScript, Node test runner.

### Task 1: Specify retry storage behavior

**Files:**
- Modify: `android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- Modify: `tests/yuqi-ui-contract.test.mjs`

1. Add a test that submits two distinct turn IDs for one source message.
2. Assert both turns exist and each owns one attempt.
3. Add static schema/idempotency assertions.
4. Run the focused tests and confirm failure for the old unique-source design.

### Task 2: Migrate Room and change idempotency

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/ChatTurnEntity.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`

1. Make the source-message index non-unique.
2. Add migration 8→9 that recreates the index as non-unique.
3. Deduplicate submission by `turnId`.
4. Run focused contract tests until green.

### Task 3: Specify lineage winner behavior

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`

1. Add assertions for explicit retry ancestry.
2. Add an executable behavior test showing a completed ancestor is accepted.
3. Add an executable behavior test showing an unrelated turn is rejected.
4. Assert native acceptance compares `result.turnId` with the requested turn.
5. Run focused tests and confirm failure.

### Task 4: Implement UI lineage reconciliation

**Files:**
- Modify: `tavern-app/index.html`

1. Persist a bounded retry lineage in `pendingReply`.
2. Teach supersession logic to accept a completed lineage ancestor.
3. Reject a mismatched native submission response instead of recording a phantom
   retry as accepted.
4. Ensure a winner clears the pending descendant for the same user message.
5. Run focused tests until green.

### Task 5: Verify and package

1. Run the complete Node test suite.
2. Run Android unit/instrumentation compilation available in the environment.
3. Inspect the exact diff and preserve unrelated worktree changes.
4. Bump the Android release version only if producing an installable update.
5. Follow `docs/AL-android-signing-runbook.md` for any formal APK.
