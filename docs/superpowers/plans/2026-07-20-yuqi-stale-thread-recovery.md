# Yuqi Stale Thread Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover a Yuqi role automatically when its saved Codex rollout no longer exists, while preserving fallback behavior for genuine downstream failures.

**Architecture:** Keep recovery inside `CodexAppServerClient.ensureThreadInternal(role)`, the existing single boundary for role session creation and resumption. Retry exactly once with `thread/start` only when `thread/resume` explicitly reports `no rollout found for thread id`; persist the replacement under the same role and rethrow every unrelated error unchanged.

**Tech Stack:** Node.js 24 ES modules, Codex App Server JSON-RPC, SQLite `sessions`, `node:test`, PowerShell runtime scripts.

## Global Constraints

- Only `no rollout found for thread id` authorizes automatic replacement.
- Network, authentication, permission, model, quota, and timeout errors must not replace a stored thread.
- Replace only the failed role and retain three-role isolation.
- Preserve model `gpt-5.6-sol`, effort `high`, strict role schemas, fallback behavior, messages, facts, presets, diagnostics, and sync state.
- The already displayed fallback reply must not produce a second visible reply.
- This is a desktop runtime change; the installed Android 1.0.70 APK remains unchanged.

---

### Task 1: Specify Missing-Rollout Recovery

**Files:**
- Modify: `yuqi-runtime/test/fixtures/fake-app-server.mjs`
- Modify: `yuqi-runtime/test/codex-client.test.mjs`

**Interfaces:**
- Consumes: `CodexAppServerClient.runTurn(role, input)` and `YuqiStore.setSession/getSession`.
- Produces: deterministic fake `thread/resume` failures for `thr_missing` and `thr_denied`.

- [ ] **Step 1: Add deterministic fake resume failures**

Before the normal `thread/resume` success response, add:

```js
if (message.params.threadId === 'thr_missing') {
  write({ id: message.id, error: { code: -32001, message: 'no rollout found for thread id thr_missing' } });
  return;
}
if (message.params.threadId === 'thr_denied') {
  write({ id: message.id, error: { code: -32002, message: 'permission denied' } });
  return;
}
```

- [ ] **Step 2: Add the missing-rollout recovery test**

```js
test('replaces a stored role thread only when its rollout no longer exists', async () => fixture(async ({ client, store, logFile }) => {
  store.setSession('memory', 'thr_missing');
  const result = await client.runTurn('memory', 'find evidence');
  assert.equal(result.threadId, 'thr_new_1');
  assert.equal(store.getSession('memory'), 'thr_new_1');
  assert.deepEqual(methods(logFile), [
    'initialize', 'initialized', 'thread/resume', 'thread/start', 'turn/start'
  ]);
}));
```

- [ ] **Step 3: Add the unrelated-error preservation test**

```js
test('does not replace a stored role thread for unrelated resume errors', async () => fixture(async ({ client, store, logFile }) => {
  store.setSession('memory', 'thr_denied');
  await assert.rejects(client.runTurn('memory', 'find evidence'), /permission denied/);
  assert.equal(store.getSession('memory'), 'thr_denied');
  assert.deepEqual(methods(logFile), ['initialize', 'initialized', 'thread/resume']);
}));
```

- [ ] **Step 4: Run both new tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="replaces a stored role thread|does not replace a stored role thread" yuqi-runtime/test/codex-client.test.mjs
```

Expected: the missing-rollout test fails because `thread/start` is not called. The unrelated-error test passes, proving the new production behavior is the only missing behavior.

### Task 2: Implement Narrow Single-Retry Recovery

**Files:**
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Test: `yuqi-runtime/test/codex-client.test.mjs`

**Interfaces:**
- Consumes: `CodexProtocolError.message`, `CodexProtocolError.details`, and `store.setSession(role, threadId)`.
- Produces: the existing `ensureThread(role): Promise<string>` contract with a replacement thread ID after an explicitly missing rollout.

- [ ] **Step 1: Add the narrow error predicate**

```js
function isMissingRolloutError(error) {
  if (!(error instanceof CodexProtocolError)) return false;
  const message = [error.message, error.details?.message].filter(Boolean).join('\n');
  return /\bno rollout found for thread id\b/i.test(message);
}
```

- [ ] **Step 2: Add a single create-and-persist path**

```js
async startRoleThread(role) {
  const result = await this.request('thread/start', {
    cwd: this.cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only'
  });
  const threadId = result?.thread?.id;
  if (!threadId) throw new CodexProtocolError('thread/start returned no thread id');
  this.store?.setSession?.(role, threadId);
  return threadId;
}
```

- [ ] **Step 3: Resume first and recover once**

Implement `ensureThreadInternal(role)` so it:

```js
await this.start();
const stored = this.store?.getSession?.(role) || '';
if (!stored) return this.startRoleThread(role);
try {
  const result = await this.request('thread/resume', { threadId: stored });
  const threadId = result?.thread?.id;
  if (!threadId) throw new CodexProtocolError('thread/resume returned no thread id');
  return threadId;
} catch (error) {
  if (!isMissingRolloutError(error)) throw error;
  return this.startRoleThread(role);
}
```

- [ ] **Step 4: Run the focused client suite and verify GREEN**

Run: `node --test yuqi-runtime/test/codex-client.test.mjs`

Expected: all client tests pass.

- [ ] **Step 5: Run the complete repository suite**

Run: `npm.cmd test`

Expected: exit code `0` with no failed subtests.

- [ ] **Step 6: Commit only the three recovery files**

```powershell
git add -- yuqi-runtime/src/codex-client.mjs yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/test/fixtures/fake-app-server.mjs
git commit -m "fix: recover missing Yuqi role threads"
```

### Task 3: Back Up, Heal Sessions, and Restart Runtime

**Files:**
- Read: `yuqi-runtime/config.json`
- Create through existing script: a timestamped SQLite snapshot under `C:\Users\PC\Documents\虞栖AL记忆库备份\backups`
- Update through runtime: `C:\Users\PC\Documents\虞栖AL记忆库备份\database\yuqi-runtime.sqlite`

**Interfaces:**
- Consumes: `scripts/backup-yuqi-memory.ps1`, `scripts/stop-yuqi-background.ps1`, `scripts/bootstrap-yuqi-roles.mjs`, and `scripts/start-yuqi-background.ps1`.
- Produces: three valid persisted role thread IDs and a healthy runtime on TCP 17891.

- [ ] **Step 1: Create and verify a pre-restart backup**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/backup-yuqi-memory.ps1`

Expected: a new readable SQLite backup path is printed.

- [ ] **Step 2: Stop only the recorded Yuqi runtime process**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-yuqi-background.ps1`

Expected: `Yuqi runtime stopped.` and TCP 17891 is no longer owned by the recorded PID.

- [ ] **Step 3: Heal all saved role sessions before background restart**

Run: `node scripts/bootstrap-yuqi-roles.mjs yuqi-runtime/config.json`

Expected:

```json
{"ok":true,"roles":["memory","brain","supervisor"],"isolated":true}
```

- [ ] **Step 4: Start the hidden background runtime**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-yuqi-background.ps1`

Expected: `Yuqi runtime started. PID=<new pid>`.

- [ ] **Step 5: Verify health and stored isolation**

Run `curl.exe http://127.0.0.1:17891/v1/health` and a read-only SQLite query of `sessions`.

Expected: health reports all three roles `true`, preset `1.1.0`, context limit `200`, and the three saved thread IDs are non-empty and distinct.

- [ ] **Step 6: Push the committed recovery**

Run: `git push origin codex/al-tdd`

Expected: the recovery commit is present on the authorized GitHub branch.

### Task 4: Confirm the Next Phone Reply Source

**Files:**
- Read only: runtime `turns`, `diagnostics`, `messages`, and `cloud_deliveries` tables.

**Interfaces:**
- Consumes: one new user message sent from Android 1.0.70.
- Produces: evidence that the new turn commits with `origin='codex'` and is delivered through `cloud` or `lan`, not `fallback`.

- [ ] **Step 1: Ask the user to send one short test message**

Use a new message that is easy to identify and does not require sensitive content.

- [ ] **Step 2: Inspect the new turn without printing chat text**

Read the latest turn state, origin, diagnostic stages, and cloud delivery state. Do not print message bodies, API keys, tokens, or thread IDs.

- [ ] **Step 3: Report the verified route**

Success requires a committed/delivered/completed turn with character reply origin `codex`, no fallback message for that turn, and a successful `cloud` or `lan` result on the phone.
