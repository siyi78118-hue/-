# Yuqi Proactive Skip Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated silent `PROACTIVE_CHAT` completions by allowing at most one committed skip in the latest four proactive-chat turns after the user's latest direct message.

**Architecture:** Derive a read-only delivery policy from the existing `turns` and `messages` tables, then pass that policy to the brain and supervisor. When the policy forbids another skip, runtime converts model-level silence into a structured rewrite instead of committing an empty result; hard safety failures remain blocking.

**Tech Stack:** Node.js ESM, `node:sqlite`, Node test runner, Markdown preset modules, Capacitor Android, Gradle, GitHub Actions fixed-certificate release build.

## Global Constraints

- Only `PROACTIVE_CHAT` uses the skip budget; moments, role plans, direct replies, and payment behavior remain unchanged.
- The latest four committed proactive-chat turns may contain at most one final `skip`.
- A newly stored direct user message resets the derived window.
- No Chinese phrase or user-literal-command matching may be added.
- No mutable skip counter table may be added.
- Frequency enforcement never bypasses identity, attribution, payment, time, or internal-format safety checks.
- The generated Android package must remain `com.siyi78118.tavern`.
- The formal APK must use certificate SHA-256 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`.

---

### Task 1: Derive the proactive-chat delivery policy from committed history

**Files:**
- Modify: `yuqi-runtime/src/store.mjs`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Produces: `YuqiStore.getProactiveChatDeliveryPolicy(characterId, options?)`
- Returns: `{ kind, windowSize, maxSkips, usedSkips, skipAllowed, inspectedTurnIds, resetAfterTurnId }`
- Consumes: existing `turns.envelope_json`, `turns.reply_json`, `turns.state`, and canonical user rows in `messages`

- [ ] **Step 1: Write failing store tests**

Add test helpers that submit and commit direct/proactive turns through the real store. Cover:

```js
assert.deepEqual(store.getProactiveChatDeliveryPolicy('yuqi'), {
  kind: 'proactive_chat',
  windowSize: 4,
  maxSkips: 1,
  usedSkips: 1,
  skipAllowed: false,
  inspectedTurnIds: ['turn_proactive_4', 'turn_proactive_3', 'turn_proactive_2', 'turn_proactive_1'],
  resetAfterTurnId: 'turn_direct_1'
});
```

Also assert that:

```js
assert.equal(store.getProactiveChatDeliveryPolicy('yuqi').skipAllowed, true);
```

after a new canonical direct user message, and that failed/cancelled/proactive-moment turns never consume the budget.

- [ ] **Step 2: Run the focused store tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="proactive chat delivery policy" yuqi-runtime/test/protocol-store.test.mjs
```

Expected: FAIL because `getProactiveChatDeliveryPolicy` does not exist.

- [ ] **Step 3: Implement the minimal derived query**

Add:

```js
getProactiveChatDeliveryPolicy(characterId, { windowSize = 4, maxSkips = 1 } = {}) {
  const safeWindowSize = Math.max(1, Math.min(20, Number(windowSize) || 4));
  const safeMaxSkips = Math.max(0, Math.min(safeWindowSize, Number(maxSkips) || 0));
  const reset = this.db.prepare(`
    SELECT t.turn_id, t.created_at
    FROM messages m
    JOIN turns t ON t.turn_id = m.turn_id
    WHERE m.character_id = ? AND m.speaker_type = 'user'
    ORDER BY t.created_at DESC
    LIMIT 1
  `).get(characterId);
  const rows = this.db.prepare(`
    SELECT turn_id, reply_json
    FROM turns
    WHERE character_id = ?
      AND state IN ('committed', 'delivered', 'completed')
      AND json_extract(envelope_json, '$.kind') = 'PROACTIVE_CHAT'
      AND created_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(characterId, Number(reset?.created_at || -1), safeWindowSize);
  const usedSkips = rows.filter(row => parseJson(row.reply_json, {})?.action === 'skip').length;
  return {
    kind: 'proactive_chat',
    windowSize: safeWindowSize,
    maxSkips: safeMaxSkips,
    usedSkips,
    skipAllowed: usedSkips < safeMaxSkips,
    inspectedTurnIds: rows.map(row => row.turn_id),
    resetAfterTurnId: reset?.turn_id || null
  };
}
```

- [ ] **Step 4: Run the focused store tests and verify GREEN**

Run the command from Step 2.

Expected: PASS with the policy window, reset, and excluded-state assertions all green.

- [ ] **Step 5: Commit only Task 1 files**

```powershell
git add -- yuqi-runtime/src/store.mjs yuqi-runtime/test/protocol-store.test.mjs
git commit -m "feat: derive proactive skip budget"
```

### Task 2: Feed the policy to both roles and rewrite a forbidden brain skip

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `store.getProactiveChatDeliveryPolicy(characterId)`
- Produces: `YuqiOrchestrator.deliveryPolicyFor(envelope)`
- Adds input field: `deliveryPolicy` to brain and supervisor requests only for `PROACTIVE_CHAT`

- [ ] **Step 1: Write failing orchestrator tests**

Create committed proactive history with one skip, then process another `PROACTIVE_CHAT`. Supply two brain outputs: first `skip`, second a visible reply. Assert:

```js
assert.equal(brainCalls[0].input.deliveryPolicy.skipAllowed, false);
assert.equal(brainCalls[1].input.task, 'rewrite_as_yuqi');
assert.equal(
  brainCalls[1].input.rewriteContract.issues[0].code,
  'PROACTIVE_DELIVERY_REQUIRED'
);
assert.equal(result.action, 'send');
assert.equal(result.reply.content, '我刚忙完，忽然想起你。');
```

Add a companion test proving `PROACTIVE_MOMENT` and `ROLE_PLAN_CHAT` requests have no `deliveryPolicy`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="proactive skip budget|delivery policy" yuqi-runtime/test/orchestrator.test.mjs
```

Expected: FAIL because no delivery policy is attached and the first skip is committed.

- [ ] **Step 3: Add policy lookup and structured delivery rewrite**

Add a policy helper that returns `null` for non-`PROACTIVE_CHAT` turns and catches store-query errors:

```js
deliveryPolicyFor(envelope) {
  if (envelope.kind !== 'PROACTIVE_CHAT') return null;
  try {
    return this.store.getProactiveChatDeliveryPolicy(envelope.characterId);
  } catch (error) {
    this.store.putDiagnostic({
      turnId: envelope.turnId,
      stage: 'proactive_delivery_policy',
      level: 'warning',
      detail: { action: 'policy_read_failed', message: error.message, skipAllowed: true }
    });
    return { kind: 'proactive_chat', windowSize: 4, maxSkips: 1, usedSkips: 0, skipAllowed: true };
  }
}
```

Attach the returned object to `brainRequest` and `supervisorRequest`.

When `brain_done` contains `action: "skip"` and `skipAllowed === false`, advance back to `brain_running` with a normalized rewrite review:

```js
{
  decision: 'rewrite',
  approved: false,
  attempt,
  issues: [{
    code: 'PROACTIVE_DELIVERY_REQUIRED',
    severity: 'soft',
    message: '本轮主动私聊需要形成自然可见正文，不要以沉默结束',
    mustPreserve: ['事实、身份、时间、关系状态和生活连续性'],
    mustChange: ['把空草稿改成虞栖此刻真实想发的一条消息'],
    allowedStrategies: ['分享生活片段', '自然换话题', '轻量试探', '重新开口'],
    acceptanceCriteria: ['reply 是非空可见正文', '不解释系统规则']
  }]
}
```

Record one `proactive_skip_rewrite_requested` diagnostic containing the computed policy and model decision.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2.

Expected: PASS; the visible second draft commits, and unrelated automatic kinds remain unchanged.

- [ ] **Step 5: Commit only Task 2 files**

```powershell
git add -- yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: rewrite forbidden proactive skips"
```

### Task 3: Prevent supervisor decisions from reopening the silent path

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `deliveryPolicyFor(envelope)`
- Produces: supervisor `skip`/`reject` conversion into an actionable `rewrite`
- Preserves: hard safety rejection and existing direct-reply rewrite behavior

- [ ] **Step 1: Write failing supervisor tests**

With `skipAllowed: false`, supply a non-empty first draft and a supervisor `skip`; then provide a corrected draft and approval. Assert:

```js
assert.equal(brainCalls[1].input.supervisorIssues[0].code, 'PROACTIVE_DELIVERY_REQUIRED');
assert.equal(result.action, 'send');
```

Add a hard-issue exhaustion test asserting the turn fails instead of committing `skip`, and a soft-issue exhaustion test asserting the last valid non-empty draft may be selected.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --test-name-pattern="supervisor.*proactive|proactive.*supervisor" yuqi-runtime/test/orchestrator.test.mjs
```

Expected: FAIL because automatic supervisor `skip` and `reject` currently commit silence.

- [ ] **Step 3: Convert forbidden supervisor silence into rewrite**

Before handling supervisor decisions, normalize `skip` and `reject` to a delivery rewrite only when:

```js
envelope.kind === 'PROACTIVE_CHAT' && deliveryPolicy.skipAllowed === false
```

At the final rewrite attempt:

- never commit `skip`;
- if hard issues remain, throw `PROACTIVE_DELIVERY_BLOCKED` so unsafe text is not sent;
- if only soft issues remain and the draft has visible text, approve that draft and record `proactive_soft_fallback_selected`;
- include original supervisor decision and policy in diagnostics.

- [ ] **Step 4: Run focused tests and the complete orchestrator suite**

Run:

```powershell
node --test yuqi-runtime/test/orchestrator.test.mjs
```

Expected: all tests PASS, including existing deliberate-silence tests when the budget still permits silence.

- [ ] **Step 5: Commit only Task 3 files**

```powershell
git add -- yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "fix: close proactive supervisor skip path"
```

### Task 4: Teach presets to honor policy without interpreting literal user commands

**Files:**
- Modify: `yuqi-runtime/presets/yuqi-core.md`
- Modify: `yuqi-runtime/presets/supervisor.md`
- Modify: `yuqi-runtime/presets/manifest.json`
- Test: `yuqi-runtime/test/preset-registry.test.mjs`
- Test: `tests/rp-preset-contract.test.mjs`
- Generated sync targets: updated only through `npm run presets:sync`

**Interfaces:**
- Consumes: request-level `deliveryPolicy`
- Produces: preset version `1.8.4`
- Preserves: character autonomy over topic, tone, interpretation, and whether to follow literal user wording

- [ ] **Step 1: Write failing preset contract tests**

Assert the compiled brain and supervisor presets state:

```js
assert.match(brain, /deliveryPolicy/);
assert.match(brain, /skipAllowed/);
assert.match(supervisor, /PROACTIVE_DELIVERY_REQUIRED/);
assert.doesNotMatch(brain, /暂时不理你|你自己去玩/);
```

- [ ] **Step 2: Run preset tests and verify RED**

Run:

```powershell
node --test yuqi-runtime/test/preset-registry.test.mjs tests/rp-preset-contract.test.mjs
```

Expected: FAIL because preset version `1.8.3` does not describe the delivery policy.

- [ ] **Step 3: Update the two role modules and manifest**

Brain rule:

```markdown
当输入包含 deliveryPolicy：它只约束本轮是否必须形成可见正文。
skipAllowed=true 时，你仍可基于自己的生活、关系与意愿决定沉默；
skipAllowed=false 时，选择一个你此刻自然愿意发出的内容，返回 action=send 和非空 reply。
该策略不要求服从用户的字面命令，也不替你决定潜台词、话题、态度或亲密程度。
```

Supervisor rule:

```markdown
当 deliveryPolicy.skipAllowed=false 时，不用 skip/reject 代替可修正的回复。
可修正问题返回 rewrite，并提供具体问题与改法；只有仍存在硬性安全冲突时才阻止发送。
```

Set `currentVersion` to `1.8.4`, then run:

```powershell
npm run presets:sync
```

- [ ] **Step 4: Run preset tests and verify GREEN**

Run the command from Step 2, followed by:

```powershell
npm run presets:check
```

Expected: all PASS and generated assets are synchronized.

- [ ] **Step 5: Commit only preset sources, tests, and generated sync targets**

Use `git status --short` to enumerate sync targets, stage only files changed by this task, then:

```powershell
git commit -m "feat: publish proactive skip policy preset"
```

### Task 5: Regression verification and formal updateable APK

**Files:**
- Modify: `android/app/build.gradle`
- Build artifact: `artifacts/AL-1.0.96-release.apk`
- Follow: `docs/AL-android-signing-runbook.md`

**Interfaces:**
- Produces Android `versionCode=96`, `versionName=1.0.96`
- Produces an APK signed by the existing AL certificate

- [ ] **Step 1: Run runtime and repository tests**

Run:

```powershell
node --test yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/preset-registry.test.mjs
npm test
```

Expected: zero failures.

- [ ] **Step 2: Set the Android version and run unsigned release verification**

Change defaults:

```gradle
versionCode Integer.parseInt(System.getenv("AL_VERSION_CODE") ?: "96")
versionName System.getenv("AL_VERSION_NAME") ?: "1.0.96"
```

Run:

```powershell
npm run android:sync
Set-Location android
.\gradlew.bat assembleRelease --no-problems-report
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit the version bump**

Stage only the Android version file and any deterministic Capacitor sync targets required by the build:

```powershell
git commit -m "build: prepare Android 1.0.96 proactive fix"
```

- [ ] **Step 4: Build and download the formal APK**

Follow `docs/AL-android-signing-runbook.md`: use the in-memory Git Credential Manager credential with GitHub REST, trigger `.github/workflows/android-apk.yml`, wait for success, and download the fixed-certificate artifact as:

```text
artifacts/AL-1.0.96-release.apk
```

- [ ] **Step 5: Verify identity, version, signature, and checksum**

Run `aapt dump badging`, `apksigner verify --verbose --print-certs`, and SHA-256 hashing. Required results:

```text
package: com.siyi78118.tavern
versionCode: 96
versionName: 1.0.96
Signer certificate SHA-256:
5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b
```

Also compare the signer identity with `artifacts/AL-1.0.95-release.apk`.

- [ ] **Step 6: Report the APK and verification evidence**

Provide a clickable absolute link to `artifacts/AL-1.0.96-release.apk`, its file SHA-256, test results, and confirmation that unrelated dirty worktree files were not staged or modified.
