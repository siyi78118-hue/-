# Proactive Deadline Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the next proactive-chat deadline fixed unless a real new conversation or a completed task outcome justifies replacing it.

**Architecture:** Add one Web scheduling boundary for completed Android direct replies. It always replaces a stale dice job with a planned job immediately, using the model's explicit timestamp when present and the existing idle delay otherwise; existing foreground validation continues to preserve future jobs.

**Tech Stack:** Browser JavaScript in `tavern-app/index.html`, Node VM contract tests in `test-basic.mjs`, Node test runner.

## Global Constraints

- New ordinary chat activity may replace the next proactive deadline.
- Without new chat activity or a task outcome, foreground checks, settings screens, restart recovery, and cloud verification must preserve the same `jobId` and `dueAt`.
- Do not change moments, role plans, manual test jobs, D1 schemas, or FCM transport behavior.
- Preserve all existing dirty worktree changes and stage only files explicitly named by this plan.

---

### Task 1: Re-anchor proactive chat after Android direct replies

**Files:**
- Modify: `test-basic.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Consumes: `nativePartPayload(part)`, `parseProactiveScheduleTime(value)`, `schedulePlannedChatFromReply(charId, directive)`.
- Produces: `rescheduleAfterNativeDirectReply(charId, schedulePart = null): Promise<boolean>`.

- [x] **Step 1: Write the failing behavioral test**

Add a VM probe that installs a future `mode: 'dice'` chat job, invokes the missing helper after a completed Android direct reply, and asserts that the job is immediately replaced by `mode: 'planned'`. Cover both no `SCHEDULE` part (existing idle delay) and an explicit future `nextProactiveAt`.

```js
const nativeDirectScheduleProbe = await vm.runInContext(`(async () => {
  const savedSettings = settings;
  const savedChats = allChats;
  settings = { ...settings, proactiveEnabled: true, cloudTimerEnabled: false, deviceId: 'native-direct-device', proactiveIdleMinutes: 30 };
  const oldDueAt = new Date(Date.now() + 90 * 60000).toISOString();
  allChats = { native_direct_char: { messages: [{ role: 'user', content: '还在聊', time: Date.now() }], pendingProactiveJob: { jobId: 'old-dice-job', dueAt: oldDueAt, kind: 'chat', mode: 'dice' } } };
  const startedAt = Date.now();
  await rescheduleAfterNativeDirectReply('native_direct_char', null);
  const fallback = { ...allChats.native_direct_char.pendingProactiveJob };
  const explicitDueAt = new Date(Date.now() + 2 * 60 * 60000).toISOString();
  await rescheduleAfterNativeDirectReply('native_direct_char', { payloadJson: JSON.stringify({ nextProactiveAt: explicitDueAt }) });
  const explicit = { ...allChats.native_direct_char.pendingProactiveJob };
  settings = savedSettings;
  allChats = savedChats;
  return { fallback, explicit, explicitDueAt, startedAt };
})()`, context);
assert.equal(nativeDirectScheduleProbe.fallback.mode, 'planned');
assert.notEqual(nativeDirectScheduleProbe.fallback.jobId, 'old-dice-job');
assert.ok(Date.parse(nativeDirectScheduleProbe.fallback.dueAt) >= nativeDirectScheduleProbe.startedAt + 29 * 60000);
assert.equal(nativeDirectScheduleProbe.explicit.mode, 'planned');
assert.equal(nativeDirectScheduleProbe.explicit.dueAt, nativeDirectScheduleProbe.explicitDueAt);
```

- [x] **Step 2: Run the test to verify RED**

Run: `node test-basic.mjs`

Expected: FAIL with `ReferenceError: rescheduleAfterNativeDirectReply is not defined`.

- [x] **Step 3: Implement the single scheduling boundary**

Add beside `schedulePlannedChatFromReply`:

```js
async function rescheduleAfterNativeDirectReply(charId, schedulePart = null) {
  const at = schedulePart
    ? parseProactiveScheduleTime(nativePartPayload(schedulePart).nextProactiveAt)
    : null;
  return schedulePlannedChatFromReply(charId, at ? { dueAt: at } : null);
}
```

Replace the conditional native-direct scheduling block with one unconditional call:

```js
rescheduleAfterNativeDirectReply(charId, schedule)
  .catch(err => console.warn('[AL Timer] native schedule skipped:', err.message));
```

- [x] **Step 4: Run focused and proactive regression gates**

Run:

```powershell
node test-basic.mjs
node --test tests/cloud-timer-worker.test.mjs tests/cloud-timer-d1.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/proactive-chat-v3.test.mjs
git diff --check -- tavern-app/index.html test-basic.mjs tests/cloud-timer-worker.test.mjs
```

Expected: all commands exit 0; the proactive Node gate reports 51 passing tests and 0 failures.

- [x] **Step 5: Preserve the verified work for the current release**

Do not commit `tavern-app/index.html` or `test-basic.mjs` separately while they contain earlier uncommitted release work. Report the exact new hunks and test results so the release commit can include them intentionally with the existing update.
