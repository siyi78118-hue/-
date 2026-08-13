# Recovery Convergence and Foreground Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock the currently queued DIRECT_REPLY through normal recovery while preserving strict authority checks, then reduce Android foreground cloud scanning from 60 seconds to 15 seconds.

**Architecture:** Reconciliation recognizes two closed, semantically identical Android projections of an existing canonical v3 user message: the deployed legacy-visible alias and the canonical-visible echo observed in production. Both converge without mutating the canonical PC row; all semantic or authority changes still fail closed. Android changes only the foreground scan cadence; cognition deadlines and the 15-minute process-death fallback remain unchanged.

**Tech Stack:** Node.js ESM, `node:test`, SQLite, Java, Android Gradle/JUnit.

## Global Constraints

- Do not delete, manually ACK, rewrite, or fabricate the existing cloud relay message.
- Do not weaken generic message checksum validation or accept character-message aliases.
- A valid compatibility projection must preserve message identity, content, time, role, recipient, owner authority, peer, and journal sequence.
- `AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS` becomes exactly `15L`.
- Ninety seconds is an experience target, not a turn deadline or cancellation threshold.
- Preserve all unrelated dirty workspace files.

---

### Task 1: Canonical-visible recovery convergence

**Files:**
- Modify: `yuqi-runtime/src/reconcile.mjs:28-63`
- Test: `yuqi-runtime/test/reconcile.test.mjs:147-217`

**Interfaces:**
- Consumes: `store.getMessage(messageId)`, `store.getTurn(turnId)`, validated recovery entries from `normalizeRecoverySnapshot`.
- Produces: a closed boolean helper used only before `store.putMessage`; no database mutation on a compatible replay.

- [ ] **Step 1: Add the production-shaped failing test**

Add a test that seeds an authority-v1/protocol-v3 user message, records its full `before` value, and submits a recovery entry whose `turnId` remains the canonical owner turn while `deviceId` is `<peer>:visible` and `deviceSeq` is the journal sequence:

```js
test('a canonical visible recovery echo converges without rewriting its authority row', async () => withStore(async store => {
  const seeded = seedCanonicalUserMessage(store, { messageId: 'msg_canonical_visible_echo' });
  const before = store.getMessage(seeded.message.messageId);
  const echo = messageEntry(73, {
    ...seeded.message,
    turnId: seeded.turnId,
    characterId: 'yuqi',
    origin: 'phone',
    deviceId: `${seeded.deviceId}:visible`,
    deviceSeq: 73
  });
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('an exact recovery echo needs no model call'); } }
  });

  const result = await reconciler.reconcileFrom({
    peerId: seeded.deviceId,
    lastCommonSeq: 72,
    lastSeq: 73,
    entries: [echo]
  });

  assert.equal(result.ackSeq, 73);
  assert.equal(result.importedMessages, 0);
  assert.deepEqual(store.getMessage(seeded.message.messageId), before);
}));
```

- [ ] **Step 2: Run the focused test and verify the real failure**

Run: `node --test yuqi-runtime/test/reconcile.test.mjs`

Expected: the new test fails with `message checksum conflict`; existing tests remain green.

- [ ] **Step 3: Add closed canonical-visible identity recognition**

Refactor `isCanonicalUserMessageRecoveryAlias` into a projection check that keeps the existing eleven-key shape and shared semantic checks, then accepts exactly one of these identity relations:

```js
const legacyVisible = payload.turnId === `turn_legacy_${payload.messageId}`
  && existing.turnId === `turn_${payload.messageId}`;
const canonicalVisible = payload.turnId === existing.turnId;

return (legacyVisible || canonicalVisible)
  && Number(owner?.resultAuthorityVersion || 0) === 1
  && Number(owner?.protocolVersion || 0) === 3
  && owner.turnId === existing.turnId
  && owner.characterId === payload.characterId
  && owner.deviceId === peerId
  && owner.sourceMessageId === payload.messageId;
```

Keep the existing checks for exact payload keys, `entry.entityId`, user speaker, phone origin, `<peer>:visible`, `entry.seq`, message semantic fields, existing canonical peer/device sequence, and recipient. Do not use prefix-only matching or ignore unknown keys.

- [ ] **Step 4: Add canonical-visible mutation counterexamples**

Add table-driven cases for changed content, sentAt, speaker, recipient, canonical turnId, visible peer, journal sequence, owner authority version, and owner protocol version. Each case must assert `message checksum conflict`, unchanged stored message, and unchanged sync cursor.

- [ ] **Step 5: Run reconciliation and ingress regression gates**

Run:

```powershell
node --test yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/protocol-store.test.mjs
```

Expected: all tests pass, zero skipped.

- [ ] **Step 6: Commit the compatibility fix**

```powershell
git add -- yuqi-runtime/src/reconcile.mjs yuqi-runtime/test/reconcile.test.mjs
git commit -m "fix: converge canonical visible recovery echoes"
```

### Task 2: Release the existing queued message through the normal pipeline

**Files:**
- Read only: `yuqi-runtime/config.json`
- Read only: configured SQLite database
- Read only: cloud relay status and local health endpoint

**Interfaces:**
- Consumes: the committed Task 1 runtime, existing encrypted relay item, normal `CloudRelayPump` ACK behavior.
- Produces: a persisted PC turn and eventual phone delivery without manual queue mutation.

- [ ] **Step 1: Restart only the single Yuqi runtime process**

Use the existing runtime launcher/service mechanism. Verify exactly one listener on port 17891 after restart.

- [ ] **Step 2: Observe the existing relay item retry**

Poll read-only diagnostics until the relay ID is no longer failing with `message checksum conflict`. Do not enqueue a replacement and do not ACK it manually.

- [ ] **Step 3: Verify durable acceptance**

Read the database and assert:

```text
turn_id = turn_msg_1786646002626_gzf4q7 exists
source_message_id = msg_1786646002626_gzf4q7
state progresses beyond queued or reaches a terminal state
sync cursor advances through recovery sequence 1173
```

- [ ] **Step 4: Verify normal cloud convergence**

Confirm the phone-to-PC relay item disappears only after normal ACK and that the resulting PC-to-phone delivery is present or confirmed. If model generation is still running, report that separately from ingress rather than declaring the message stuck.

### Task 3: Fifteen-second Android foreground scan

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlBackgroundPolicy.java:5`
- Test: `android/app/src/test/java/com/siyi/al/execution/AlBackgroundPolicyTest.java:10-15`

**Interfaces:**
- Consumes: `AlExecutionService` scheduled executor, which already references `FOREGROUND_SCAN_SECONDS` for initial delay and period.
- Produces: `FOREGROUND_SCAN_SECONDS = 15L`; no bridge deadline changes.

- [ ] **Step 1: Change the policy test first**

```java
assertEquals(15L, AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS);
```

- [ ] **Step 2: Run the focused unit test and verify it fails**

Run:

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.AlBackgroundPolicyTest --no-daemon --no-problems-report
```

Expected: failure showing actual `60` versus expected `15`.

- [ ] **Step 3: Make the minimal production change**

```java
public static final long FOREGROUND_SCAN_SECONDS = 15L;
```

Do not modify `PERIODIC_RECOVERY_MINUTES`, `turnDeadlineMs`, cognition timeouts, or transient retry backoff.

- [ ] **Step 4: Run Android focused and compile gates**

Run:

```powershell
.\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.AlBackgroundPolicyTest --no-daemon --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --no-problems-report
```

Expected: both commands succeed. If no ADB device is attached, record `connectedDebugAndroidTest` as an outstanding release gate rather than claiming it passed.

- [ ] **Step 5: Commit the polling change**

```powershell
git add -- android/app/src/main/java/com/siyi/al/execution/AlBackgroundPolicy.java android/app/src/test/java/com/siyi/al/execution/AlBackgroundPolicyTest.java
git commit -m "fix: shorten foreground cloud scan interval"
```

### Task 4: Final regression and evidence

**Files:**
- Verify only: all files from Tasks 1-3

**Interfaces:**
- Consumes: both commits and the live convergence evidence.
- Produces: test counts, live relay result, and an APK follow-up boundary.

- [ ] **Step 1: Run final Node regression**

Run:

```powershell
node --test yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/protocol-store.test.mjs
```

- [ ] **Step 2: Run final Android focused regression**

Run:

```powershell
cd android
.\gradlew.bat :app:testDebugUnitTest --tests com.siyi.al.execution.AlBackgroundPolicyTest --no-daemon --no-problems-report
```

- [ ] **Step 3: Check patch hygiene**

Run: `git diff --check`

Expected: no whitespace errors; unrelated user dirt remains untouched.

- [ ] **Step 4: Report two distinct outcomes**

Report separately: (a) whether the already queued message entered and completed; (b) whether the 15-second polling source change and tests are ready for the next signed APK. Do not imply the installed APK changed until a formally signed build is produced and installed.

