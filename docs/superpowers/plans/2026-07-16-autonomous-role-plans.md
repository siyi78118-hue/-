# Autonomous Role Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable per-character schedule where the role can create, revise, cancel, and execute private-message, moment-post, and non-sending role-schedule plans from hidden chat-model directives.

**Architecture:** Keep Android Room authoritative and use IndexedDB meta records as the web fallback. The chat model emits validated `<al_plan>` operations; the local plan engine stores full private content while Cloudflare stores only the next occurrence identifiers and due time. FCM claims an occurrence atomically, then either submits a prioritized native generation turn or advances a non-sending role schedule.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Node `node:test`, Capacitor 8, Java 21, Android Room, Firebase Cloud Messaging, Cloudflare Workers KV, existing OpenAI-compatible native execution engine.

## Global Constraints

- Treat the current uncommitted `MAX_CHAT_OUTPUT_TOKENS = 8192`, `APP_BUILD_VERSION = '2026-07-16.88'`, and `ReplyParser.collapseTextBubbles(...)` changes as protected baseline work from another window.
- Never replace `tavern-app/index.html`, `ReplyParser.java`, `ReplyParserTest.java`, or `test-basic.mjs` wholesale; apply narrow patches on top of their current contents.
- Explicit commitments survive later conversation until explicitly cancelled, rescheduled, contradicted by a clear fact, or changed by the user in the schedule screen.
- Support one-time, daily, weekly, monthly, fixed-interval, and bounded custom recurrence using the device local timezone.
- Support `private_message`, `moment_post`, and non-sending `role_schedule` plans.
- Generate private messages and moments at execution time from the latest locally mirrored context; do not store prewritten final messages.
- Permit `spoken`, `accepted_request`, `private_decision`, and `user_created` sources.
- Keep at most 50 effective plans per character; history does not count toward the limit.
- Full plan intent, evidence, chat, memory, prompts, and keys remain local. Cloudflare receives only minimal identifiers, type, and due time.
- Direct user replies outrank role plans; explicit/accepted plans outrank private decisions; ordinary proactive tasks remain last.
- Each occurrence is idempotent by `planId + scheduledFor` and must survive foreground/background races, duplicate FCM, process reclaim, and UI absence.
- Preserve all cloud singleton/KV quota fixes and Android execution recovery tests introduced through build `1.0.61`.
- Room upgrades must use an explicit migration and must never use destructive fallback.
- The final release must use the existing in-app Android update channel.

---

### Task 0: Preserve the Other Window's Verified Baseline

**Files:**
- Modify only by committing existing changes: `tavern-app/index.html`
- Modify only by committing existing changes: `test-basic.mjs`
- Modify only by committing existing changes: `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`
- Modify only by committing existing changes: `android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java`

**Interfaces:**
- Consumes: Current working-tree changes already verified on 2026-07-16.
- Produces: A clean, separately reviewable baseline commit containing output limit `8192`, web build `.88`, and lossless 12-bubble collapsing.

- [ ] **Step 1: Confirm the protected diff is still present**

Run:

```powershell
git diff -- android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java android/app/src/main/java/com/siyi/al/execution/api/ReplyParserTest.java tavern-app/index.html test-basic.mjs
```

Expected: the diff contains `MAX_CHAT_OUTPUT_TOKENS = 8192`, `APP_BUILD_VERSION = '2026-07-16.88'`, `collapseTextBubbles`, and `preservesAllTextWhenReplyExceedsTheTwelveBubbleStorageLimit`.

- [ ] **Step 2: Re-run the protected baseline checks**

Run:

```powershell
npm test
cd android
.\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.api.ReplyParserTest
```

Expected: both commands pass. If the diff changed while this task was being executed, stop and re-read it instead of restoring any file.

- [ ] **Step 3: Commit only the four protected files**

```powershell
git add -- tavern-app/index.html test-basic.mjs android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java
git commit -m "fix: preserve long native chat replies"
```

Expected: unrelated `zhaxian-workbench`, document, APK, output, and preset changes remain untouched.

---

### Task 1: Implement the Pure Role-Plan Domain

**Files:**
- Create: `tavern-app/lib/role-plan-domain.js`
- Create: `tests/role-plan-domain.test.mjs`
- Modify: `test-basic.mjs`
- Modify: `tavern-app/sw-v11.js`

**Interfaces:**
- Consumes: Plain JSON plan objects and device-local epoch milliseconds.
- Produces: global `ALRolePlans` with `normalizeOperation`, `applyOperations`, `nextOccurrence`, `occurrenceId`, `effectivePlans`, `scheduleContext`, and `cloudJob`.

- [ ] **Step 1: Write failing domain tests**

Create tests that load the browser script in a VM and assert exact behavior:

```js
test('explicit commitment survives unrelated later chat', () => {
  const created = applyOperations([], [], [{
    op: 'create', type: 'private_message', source: 'spoken',
    title: '起床后发早安', intent: '起床后主动发早安',
    schedule: { kind: 'once', at: '2026-07-17T09:00:00+08:00' },
    timeConfidence: 'explicit'
  }], { charId: 'char-a', now: Date.parse('2026-07-16T20:00:00+08:00'), uid: () => 'plan-a' });
  assert.equal(created.plans[0].status, 'active');
  assert.equal(created.plans[0].nextRunAt, Date.parse('2026-07-17T09:00:00+08:00'));
});

test('clear contradiction cancels matching work schedule only', () => {
  const result = applyOperations(existingWorkPlans, [], [{
    op: 'cancel', planId: 'work-daily', reason: '角色明确表示已经辞职'
  }], { charId: 'char-a', now, uid });
  assert.equal(result.plans.find(p => p.planId === 'work-daily').status, 'cancelled');
  assert.equal(result.plans.find(p => p.planId === 'morning-message').status, 'active');
});
```

Also cover daily, weekly, monthly, interval, end date, inferred time, five-minute minimum, semantic duplicate merge, invalid target rejection, occurrence ID stability, device-timezone recalculation, and the 50-plan limit.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test tests/role-plan-domain.test.mjs`

Expected: FAIL because `tavern-app/lib/role-plan-domain.js` does not exist.

- [ ] **Step 3: Implement the domain as a browser/Node-compatible IIFE**

The public surface must be exact:

```js
(function initRolePlanDomain(root) {
  const EFFECTIVE = new Set(['active', 'paused', 'running', 'failed']);
  const TYPES = new Set(['private_message', 'moment_post', 'role_schedule']);
  const SOURCES = new Set(['spoken', 'accepted_request', 'private_decision', 'user_created']);
  const ACTIVE_LIMIT = 50;
  const MIN_SEND_GAP_MS = 5 * 60 * 1000;

  function occurrenceId(planId, scheduledFor) {
    return `${String(planId)}:${Number(scheduledFor)}`;
  }

  function effectivePlans(plans, charId) {
    return (plans || []).filter(plan => plan.characterId === charId && EFFECTIVE.has(plan.status));
  }

  function localCandidate(baseMs, time, dayOffset = 0) {
    const [hour, minute] = String(time || '00:00').split(':').map(Number);
    const value = new Date(baseMs);
    value.setDate(value.getDate() + dayOffset);
    value.setHours(hour, minute, 0, 0);
    return value.getTime();
  }

  function nextOccurrence(schedule, afterMs) {
    const rule = schedule || {};
    const endsAt = rule.endsAt ? Date.parse(rule.endsAt) : Number.POSITIVE_INFINITY;
    let candidate = null;
    if (rule.kind === 'once') candidate = Date.parse(rule.at);
    if (rule.kind === 'interval') {
      const anchor = Date.parse(rule.startsAt);
      const intervalMs = Math.max(5 * 60000, Number(rule.intervalMs));
      candidate = anchor > afterMs ? anchor : anchor + (Math.floor((afterMs - anchor) / intervalMs) + 1) * intervalMs;
    }
    if (rule.kind === 'daily') {
      candidate = localCandidate(afterMs, rule.time);
      if (candidate <= afterMs) candidate = localCandidate(afterMs, rule.time, 1);
    }
    if (rule.kind === 'weekly') {
      const weekdays = new Set((rule.weekdays || []).map(Number));
      for (let offset = 0; offset <= 7; offset += 1) {
        const probe = localCandidate(afterMs, rule.time, offset);
        if (probe > afterMs && weekdays.has(new Date(probe).getDay())) { candidate = probe; break; }
      }
    }
    if (rule.kind === 'monthly') {
      for (let offset = 0; offset <= 12; offset += 1) {
        const base = new Date(afterMs);
        const monthStart = new Date(base.getFullYear(), base.getMonth() + offset, 1);
        const lastDay = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
        monthStart.setDate(Math.min(Math.max(1, Number(rule.day)), lastDay));
        const probe = localCandidate(monthStart.getTime(), rule.time);
        if (probe > afterMs) { candidate = probe; break; }
      }
    }
    return Number.isFinite(candidate) && candidate > afterMs && candidate <= endsAt ? candidate : null;
  }

  function normalizeOperation(operation, context) {
    const op = structuredClone(operation || {});
    if (!['create', 'update', 'cancel', 'pause', 'resume', 'complete'].includes(op.op)) return { ok:false, code:'PLAN_OP_INVALID', detail:'unknown operation' };
    if (op.op !== 'create' && !String(op.planId || '').trim()) return { ok:false, code:'PLAN_TARGET_REQUIRED', detail:'planId is required' };
    if (op.op !== 'create') return { ok:true, value:op };
    if (!TYPES.has(op.type) || !SOURCES.has(op.source)) return { ok:false, code:'PLAN_ENUM_INVALID', detail:'invalid type or source' };
    const nextRunAt = nextOccurrence(op.schedule, Number(context.now) - 1);
    if (!nextRunAt) return { ok:false, code:'PLAN_TIME_INVALID', detail:'schedule has no future occurrence' };
    const minRunAt = Number(context.now) + MIN_SEND_GAP_MS;
    return { ok:true, value:{
      ...op,
      planId:String(op.planId || context.uid()).slice(0, 96),
      characterId:String(context.charId),
      title:String(op.title || '').trim().slice(0, 80),
      intent:String(op.intent || '').trim().slice(0, 600),
      evidenceMessageIds:(op.evidenceMessageIds || []).map(String).slice(0, 12),
      sourceQuote:String(op.sourceQuote || '').trim().slice(0, 240),
      nextRunAt:op.type === 'role_schedule' ? nextRunAt : Math.max(nextRunAt, minRunAt),
      status:'active', origin:op.origin === 'user' ? 'user' : 'ai',
      timeConfidence:op.timeConfidence === 'inferred' ? 'inferred' : 'explicit'
    }};
  }

  function applyOperations(plans, history, operations, context) {
    const nextPlans = structuredClone(plans || []);
    const nextHistory = structuredClone(history || []);
    const rejected = [];
    let changed = false;
    for (const raw of operations || []) {
      const checked = normalizeOperation(raw, context);
      if (!checked.ok) { rejected.push(checked); continue; }
      const op = checked.value;
      if (op.op === 'create') {
        const duplicate = nextPlans.find(plan => plan.characterId === context.charId && plan.type === op.type && plan.status === 'active' && plan.intent.replace(/\s+/g, '') === op.intent.replace(/\s+/g, '') && Math.abs(Number(plan.nextRunAt) - Number(op.nextRunAt)) < 5 * 60000);
        if (duplicate) { duplicate.nextRunAt = op.nextRunAt; duplicate.updatedAt = context.now; changed = true; continue; }
        if (effectivePlans(nextPlans, context.charId).length >= ACTIVE_LIMIT) { rejected.push({ ok:false, code:'PLAN_LIMIT', detail:'50 effective plans' }); continue; }
        nextPlans.push({ ...op, createdAt:context.now, updatedAt:context.now });
        nextHistory.push({ historyId:context.uid(), planId:op.planId, operation:'create', detailJson:JSON.stringify({ title:op.title }), createdAt:context.now });
        changed = true;
        continue;
      }
      const target = nextPlans.find(plan => plan.planId === op.planId && plan.characterId === context.charId);
      if (!target) { rejected.push({ ok:false, code:'PLAN_TARGET_MISSING', detail:op.planId }); continue; }
      if (op.op === 'update') Object.assign(target, op.patch || {}, { updatedAt:context.now });
      if (op.op === 'cancel') Object.assign(target, { status:'cancelled', cancelledAt:context.now, updatedAt:context.now });
      if (op.op === 'pause') Object.assign(target, { status:'paused', updatedAt:context.now });
      if (op.op === 'resume') Object.assign(target, { status:'active', updatedAt:context.now });
      if (op.op === 'complete') Object.assign(target, { status:'completed', completedAt:context.now, updatedAt:context.now });
      nextHistory.push({ historyId:context.uid(), planId:target.planId, operation:op.op, detailJson:JSON.stringify({ reason:op.reason || '' }), createdAt:context.now });
      changed = true;
    }
    return { plans:nextPlans, history:nextHistory, changed, rejected };
  }

  function scheduleContext(plans, charId, nowMs) {
    return effectivePlans(plans, charId).filter(plan => plan.type === 'role_schedule' && plan.status === 'active' && Number(plan.startedAt || plan.nextRunAt) <= nowMs && (!plan.endsAt || Number(plan.endsAt) > nowMs));
  }

  function cloudJob(plan, deviceId) {
    const scheduledFor = Number(plan.nextRunAt);
    return {
      deviceId,
      jobId: `rpl_${deviceId}_${plan.planId}_${scheduledFor}`,
      planId: plan.planId,
      occurrenceId: occurrenceId(plan.planId, scheduledFor),
      charId: plan.characterId,
      dueAt: new Date(scheduledFor).toISOString(),
      type: 'role-plan',
      kind: plan.type,
      source: plan.source
    };
  }

  root.ALRolePlans = { normalizeOperation, applyOperations, nextOccurrence, occurrenceId, effectivePlans, scheduleContext, cloudJob };
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

Replace the comments in the implementation with the tested logic; do not use locale-dependent string parsing after normalization.

- [ ] **Step 4: Add the domain asset to app and Service Worker shells**

Add before the main inline script:

```html
<script src="./lib/role-plan-domain.js"></script>
```

Add `./lib/role-plan-domain.js` to `APP_SHELL`, bump `CACHE_NAME` by one, and add static assertions to `test-basic.mjs` for the asset and `ALRolePlans` interface. Preserve `.88`; release versioning happens only in Task 10.

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/role-plan-domain.test.mjs && npm test`

Expected: PASS.

```powershell
git add tavern-app/lib/role-plan-domain.js tests/role-plan-domain.test.mjs tavern-app/index.html tavern-app/sw-v11.js test-basic.mjs
git commit -m "feat: add role plan domain"
```

---

### Task 2: Parse and Prompt Hidden Plan Operations Without Losing Replies

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java`
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: `<al_plan>{"operations":[...]}</al_plan>` emitted after visible reply text.
- Produces: native reply part `type = "PLAN"`, web `extractRolePlanDirective(text)`, and `stripRolePlanDirective(text)`.

- [ ] **Step 1: Add failing parser tests on top of the protected bubble test**

```java
@Test
public void emitsPlanPartWithoutLeakingDirectiveOrDroppingOverflowText() {
    String raw = "早。\n我九点再找你。\n<al_plan>{\"operations\":[{\"op\":\"create\",\"type\":\"private_message\"}]}</al_plan>";
    ParsedReply parsed = parser.parse(raw, "turn-plan", "attempt-plan");
    assertEquals("早。", parsed.parts.get(0).content);
    assertEquals("我九点再找你。", parsed.parts.get(1).content);
    assertEquals("PLAN", parsed.parts.get(2).type);
    assertTrue(parsed.parts.get(2).payloadJson.contains("operations"));
}

@Test
public void invalidPlanJsonKeepsVisibleReply() {
    ParsedReply parsed = parser.parse("知道了。<al_plan>{bad}</al_plan>", "turn-bad", "attempt-bad");
    assertEquals(1, parsed.parts.size());
    assertEquals("知道了。", parsed.parts.get(0).content);
}
```

- [ ] **Step 2: Verify RED**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.api.ReplyParserTest`

Expected: FAIL because no `PLAN` part is emitted.

- [ ] **Step 3: Extend ReplyParser with narrow changes**

Add alongside existing patterns:

```java
private static final Pattern PLAN = Pattern.compile("<al_plan>([\\s\\S]*?)</al_plan>", Pattern.CASE_INSENSITIVE);
```

In `parse`, read `JSONObject plan = directive(PLAN, source);`, keep the other window's `textBubbles` and `collapseTextBubbles` code unchanged, add a `PLAN` part only when `operations` is a non-empty JSON array, and strip `<al_plan>` inside `clean`.

- [ ] **Step 4: Add equivalent web extraction and hidden-stream cleaning**

```js
function extractRolePlanDirective(text) {
  const match = String(text || '').match(/<al_plan>([\s\S]*?)<\/al_plan>/i);
  if (!match) return { operations: [] };
  try {
    const value = JSON.parse(match[1]);
    return { operations: Array.isArray(value?.operations) ? value.operations : [] };
  } catch {
    return { operations: [], error: 'PLAN_JSON_INVALID' };
  }
}

function stripRolePlanDirective(text) {
  return String(text || '').replace(/<al_plan>[\s\S]*?<\/al_plan>/gi, '').replace(/<al_plan>[\s\S]*$/gi, '').trim();
}
```

Add `<al_plan>` to `cleanStreamingDraftText` hidden markers and ensure all visible reply cleanup paths call `stripRolePlanDirective`.

- [ ] **Step 5: Give the chat model an active-plan catalog and exact operation contract**

Add a prompt block only for chat-generation scenes:

```js
composer.add('role-plan-contract', `角色可以自主安排未来私聊、朋友圈和自己的日程。
当前有效计划目录：
${rolePlanCatalogForPrompt(char.id)}
若本轮确实需要创建、修改、取消、暂停、恢复或完成计划，在可见回复最后输出：
<al_plan>{"operations":[...]}</al_plan>
修改类操作必须引用目录中的 planId。明确取消或事实冲突才能取消；“不想上班”不等于“不上班了”。
允许 source=spoken|accepted_request|private_decision。没有计划变化时不要输出标签。`, { priority: 42, scenes: ['chat'] });
```

Do not remove the existing `<al_schedule>` contract yet; Task 7 will stop generic follow-up scheduling from replacing plan jobs.

- [ ] **Step 6: Run and commit**

Run: `npm test; cd android; .\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.api.ReplyParserTest`

Expected: PASS, including the protected 16-segment lossless test.

```powershell
git add tavern-app/index.html test-basic.mjs android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java
git commit -m "feat: parse hidden role plans"
```

---

### Task 3: Add Durable Room Plans, Occurrences, History, and Migration

**Files:**
- Create: `android/app/src/main/java/com/siyi/al/execution/db/RolePlanEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/RolePlanOccurrenceEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/db/RolePlanHistoryEntity.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/RolePlanSchedule.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/RolePlanStore.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/RolePlanScheduleTest.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDatabase.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`

**Interfaces:**
- Consumes: normalized plan JSON and epoch milliseconds from `ALRolePlans`.
- Produces: Room database version 3; plugin methods `upsertRolePlans`, `listRolePlans`, `mutateRolePlan`, `saveRolePlanRuntimeSnapshot`, and `rolePlanHistory`.

- [ ] **Step 1: Write failing recurrence tests**

```java
@Test public void dailyRuleKeepsLocalWallClock() {
    long next = RolePlanSchedule.nextOccurrence(
        "{\"kind\":\"daily\",\"time\":\"09:00\"}",
        Instant.parse("2026-07-16T02:00:00Z").toEpochMilli(),
        ZoneId.of("Asia/Shanghai")
    );
    assertEquals(Instant.parse("2026-07-17T01:00:00Z").toEpochMilli(), next);
}

@Test public void occurrenceIdIsStable() {
    assertEquals("plan-a:1784240400000", RolePlanSchedule.occurrenceId("plan-a", 1784240400000L));
}
```

Cover weekly, monthly day clamping, interval, end date, role-schedule START/END phase, and device timezone changes.

- [ ] **Step 2: Verify RED**

Run: `cd android; .\gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.RolePlanScheduleTest`

Expected: compile failure because `RolePlanSchedule` is absent.

- [ ] **Step 3: Create Room entities with exact indexed fields**

Use these required columns:

```java
@Entity(tableName = "role_plans", indices = {
    @Index(value = {"characterId", "status", "nextRunAt"}),
    @Index(value = {"cloudJobId"}, unique = true)
})
public class RolePlanEntity {
    @PrimaryKey @NonNull public String planId = "";
    @NonNull public String characterId = "";
    @NonNull public String type = "private_message";
    @NonNull public String origin = "ai";
    @NonNull public String source = "spoken";
    @NonNull public String title = "";
    @NonNull public String intent = "";
    @NonNull public String scheduleJson = "{}";
    @NonNull public String timeConfidence = "explicit";
    @NonNull public String status = "active";
    @NonNull public String phase = "RUN";
    @NonNull public String evidenceJson = "[]";
    @NonNull public String sourceQuote = "";
    @NonNull public String runtimeSnapshotId = "";
    @NonNull public String cloudSyncState = "PENDING";
    @Nullable public String cloudJobId;
    public long nextRunAt;
    public long createdAt;
    public long updatedAt;
    @Nullable public Long startedAt;
    @Nullable public Long endsAt;
    @Nullable public Long completedAt;
    @Nullable public Long cancelledAt;
    @Nullable public String lastOccurrenceId;
    @Nullable public String lastErrorCode;
    @Nullable public String lastErrorDetail;
}
```

Occurrence rows use this contract:

```java
@Entity(tableName = "role_plan_occurrences", indices = {
    @Index(value = {"planId", "state", "scheduledFor"}),
    @Index(value = {"turnId"}, unique = true)
})
public class RolePlanOccurrenceEntity {
    @PrimaryKey @NonNull public String occurrenceId = "";
    @NonNull public String planId = "";
    @NonNull public String state = "CLAIMED";
    @NonNull public String phase = "RUN";
    @NonNull public String cloudJobId = "";
    @Nullable public String turnId;
    public long scheduledFor;
    public long createdAt;
    public long updatedAt;
    @Nullable public Long completedAt;
    @Nullable public String errorCode;
    @Nullable public String errorDetail;
    public boolean retryable;
}
```

History rows use auto-ID, `planId`, `operation`, compact `detailJson`, and `createdAt`.

- [ ] **Step 4: Add migration 2→3**

Set `version = 3`, include all three entities, and add `MIGRATION_2_3` with exact `CREATE TABLE` and `CREATE INDEX` statements matching Room's non-null/default expectations. Register both migrations:

```java
.addMigrations(MIGRATION_1_2, MIGRATION_2_3)
```

Never add `fallbackToDestructiveMigration`.

- [ ] **Step 5: Add atomic DAO operations**

Required signatures:

```java
@Insert(onConflict = OnConflictStrategy.REPLACE) void upsertRolePlan(RolePlanEntity plan);
@Insert(onConflict = OnConflictStrategy.IGNORE) long insertRolePlanOccurrence(RolePlanOccurrenceEntity occurrence);
@Insert long insertRolePlanHistory(RolePlanHistoryEntity history);
@Query("SELECT * FROM role_plans WHERE planId=:planId LIMIT 1") RolePlanEntity rolePlan(String planId);
@Query("SELECT * FROM role_plans WHERE characterId=:characterId ORDER BY nextRunAt ASC") List<RolePlanEntity> rolePlans(String characterId);
@Query("SELECT COUNT(*) FROM role_plans WHERE characterId=:characterId AND status IN ('active','paused','running','failed')") int effectiveRolePlanCount(String characterId);
@Query("SELECT * FROM role_plan_occurrences WHERE turnId=:turnId LIMIT 1") RolePlanOccurrenceEntity occurrenceByTurn(String turnId);
```

Implement `@Transaction boolean claimRolePlanOccurrence(String planId, String occurrenceId, long scheduledFor, String cloudJobId, long now)` so it verifies active status, matching `nextRunAt`, matching cloud job, and inserts the occurrence only once.

- [ ] **Step 6: Implement RolePlanStore and plugin bridge**

`RolePlanStore` must expose:

```java
public final class RolePlanAdvance {
    public final String planId;
    public final String occurrenceId;
    public final long nextRunAt;
    public final String phase;
    public final boolean completed;
    public RolePlanAdvance(String planId, String occurrenceId, long nextRunAt, String phase, boolean completed) {
        this.planId = planId;
        this.occurrenceId = occurrenceId;
        this.nextRunAt = nextRunAt;
        this.phase = phase;
        this.completed = completed;
    }
}

public List<RolePlanEntity> list(String characterId);
public void upsert(RolePlanEntity plan, long now);
public boolean claim(String planId, String occurrenceId, long scheduledFor, String cloudJobId, long now);
public void bindTurn(String occurrenceId, String turnId, long now);
public RolePlanAdvance complete(String occurrenceId, long now);
public void fail(String occurrenceId, String code, String detail, boolean retryable, long now);
public void mutate(String planId, String action, String patchJson, long now);
public List<RolePlanHistoryEntity> history(String planId, int limit);
```

Clamp strings, redact secrets, enforce 50 effective rows, and append history in the same transaction as each mutation. The Capacitor methods serialize only these fields plus history; API credentials never enter plan rows.

- [ ] **Step 7: Run and commit**

Run: `cd android; .\gradlew.bat testDebugUnitTest`

Expected: PASS.

```powershell
git add android/app/src/main/java/com/siyi/al android/app/src/test/java/com/siyi/al
git commit -m "feat: persist durable role plans"
```

---

### Task 4: Allow Multiple Minimal Role-Plan Jobs in Cloudflare

**Files:**
- Modify: `cloud-timer-worker.js`
- Create: `test-cloud-role-plans.mjs`
- Modify: `package.json`
- Modify: `test-cloud-task-singleton.mjs`

**Interfaces:**
- Consumes: `/schedule` payload `{ type:'role-plan', planId, occurrenceId, charId, kind, source, dueAt }`.
- Produces: independent role-plan active keys and FCM payloads while preserving ordinary proactive singleton replacement.

- [ ] **Step 1: Write failing coexistence and privacy tests**

```js
const first = await schedule({ deviceId:'device-a', jobId:'rpl_a_1', planId:'plan-1', occurrenceId:'plan-1:100', charId:'char-a', type:'role-plan', kind:'private_message', source:'spoken', dueAt:futureIso(30) });
const second = await schedule({ deviceId:'device-a', jobId:'rpl_a_2', planId:'plan-2', occurrenceId:'plan-2:200', charId:'char-a', type:'role-plan', kind:'moment_post', source:'private_decision', dueAt:futureIso(60) });
assert.equal(first.status, 200);
assert.equal(second.status, 200);
assert.equal([...kv.rows.keys()].filter(k => k.startsWith('job:rpl_')).length, 2);
assert.equal(JSON.stringify([...kv.rows.values()]).includes('起床后发早安'), false);
```

Also assert that two ordinary `proactive` chat jobs still replace one another and that cancelling one role plan does not cancel its neighbor.

- [ ] **Step 2: Verify RED**

Run: `node test-cloud-role-plans.mjs`

Expected: FAIL because the second role plan replaces the first through the current device/character/kind active key.

- [ ] **Step 3: Implement role-plan active keys and minimal fields**

```js
function activeKeyForJob(job) {
  if (job?.test) return `active:test:${encodeURIComponent(String(job.deviceId || ''))}:${encodeURIComponent(String(job.jobId || ''))}`;
  if (job?.type === 'role-plan') {
    return `active:role-plan:${encodeURIComponent(String(job.deviceId || ''))}:${encodeURIComponent(String(job.jobId || ''))}`;
  }
  return `active:${encodeURIComponent(String(job.deviceId || ''))}:${encodeURIComponent(String(job.charId || ''))}:${encodeURIComponent(String(job.kind || 'chat'))}`;
}
```

Add only `planId`, `occurrenceId`, and `source` to the stored-field allowlist. Reject `intent`, `sourceQuote`, `messages`, `memory`, `prompt`, and any key-like field with HTTP 400 `ROLE_PLAN_PAYLOAD_NOT_MINIMAL`.

FCM data for role plans must contain `type=role-plan`, `planId`, `occurrenceId`, `jobId`, `charId`, `kind`, `source`, and `dueAt` only.

- [ ] **Step 4: Extend device cleanup without changing default plan retention**

Add an explicit request flag `includeRolePlans`. Existing emergency automatic-task cleanup sends false/omits it, so long-term role plans survive. Character deletion and full-data reset send true and scan `job:rpl_<deviceId>_`.

- [ ] **Step 5: Add test to npm suite and commit**

Run: `npm test`

Expected: all cloud quota, singleton, cleanup, Service Worker, and role-plan tests pass.

```powershell
git add cloud-timer-worker.js test-cloud-role-plans.mjs test-cloud-task-singleton.mjs package.json
git commit -m "feat: schedule independent role plan wakes"
```

---

### Task 5: Execute Role Plans Through the Native Android Chain

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/TurnKind.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/db/AlExecutionDao.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Modify: `android/app/src/main/java/com/siyi/al/AlFirebaseMessagingService.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- Create: `android/app/src/main/java/com/siyi/al/execution/RolePlanCoordinator.java`
- Modify: `android/app/src/test/java/com/siyi/al/AlFirebaseMessagingServiceTest.java`
- Modify: `android/app/src/test/java/com/siyi/al/execution/ExecutionEngineTest.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/RolePlanCoordinatorTest.java`

**Interfaces:**
- Consumes: verified FCM role-plan identifiers plus Room plan/runtime snapshot.
- Produces: `ROLE_PLAN_CHAT`/`ROLE_PLAN_MOMENT` turns, no-send schedule advancement, completed occurrence, next cloud wake, and plan-specific diagnostics.

- [ ] **Step 1: Write failing priority and duplicate-delivery tests**

```java
@Test public void directReplyRunsBeforeExplicitAndPrivatePlans() {
    store.add(turn("private", TurnKind.ROLE_PLAN_CHAT_PRIVATE, 1));
    store.add(turn("explicit", TurnKind.ROLE_PLAN_CHAT, 2));
    store.add(turn("direct", TurnKind.DIRECT_REPLY, 3));
    assertEquals("direct", store.claimNext(4).turnId);
}

@Test public void duplicateRolePlanPushClaimsOneOccurrence() {
    assertTrue(store.claim("plan-a", "plan-a:100", 100L, "rpl-a", 101L));
    assertFalse(store.claim("plan-a", "plan-a:100", 100L, "rpl-a", 102L));
}
```

Also test stale occurrence, cancelled plan, mismatched job, role-schedule START/END, and deterministic 403 failure pausing only the current occurrence.

- [ ] **Step 2: Verify RED**

Run: `cd android; .\gradlew.bat testDebugUnitTest`

Expected: compile/test failures for absent role-plan kinds and coordinator.

- [ ] **Step 3: Add turn kinds and priority**

Use exact kinds:

```java
DIRECT_REPLY,
ROLE_PLAN_CHAT,
ROLE_PLAN_MOMENT,
ROLE_PLAN_CHAT_PRIVATE,
ROLE_PLAN_MOMENT_PRIVATE,
PROACTIVE_CHAT,
PROACTIVE_MOMENT
```

Update `nextRunnableTurn` CASE ordering to direct `0`, explicit/accepted role plan `1`, private role plan `2`, ordinary proactive `3`, and moment fallback `4`.

- [ ] **Step 4: Handle role-plan FCM without disturbing proactive snapshot handling**

At the top of the proactive branch:

```java
if ("role-plan".equals(text(data.get("type")))) {
    handleRolePlan(data);
    return;
}
```

`handleRolePlan` must validate plan/occurrence/job/due fields, atomically claim Room occurrence, load `snapshotId = characterId + ":role-plan-runtime"`, inject compact plan and timing data into a new immutable turn snapshot, and submit one turn. For `role_schedule`, call the coordinator directly without invoking memory/chat APIs.

- [ ] **Step 5: Complete occurrences only after reply persistence**

`AlExecutionService.notifyCompletedTurns` calls:

```java
RolePlanOccurrenceEntity occurrence = database.executionDao().occurrenceByTurn(turn.turnId);
if (occurrence != null) rolePlans.completeAndScheduleNext(occurrence, turn, System.currentTimeMillis());
```

`RolePlanCoordinator` must advance Room state transactionally before POSTing the next `/schedule`. On POST failure it leaves `cloudSyncState=PENDING`; every service kick and foreground reconciliation retries only pending syncs. `/ack` outcome must be `generated-role-plan`.

- [ ] **Step 6: Record bounded diagnostics**

Required codes: `ROLE_PLAN_FCM`, `ROLE_PLAN_STALE`, `ROLE_PLAN_CLAIMED`, `ROLE_PLAN_STARTED`, `ROLE_PLAN_DONE`, `ROLE_PLAN_FAILED`, `ROLE_PLAN_NEXT_SYNCED`, and `ROLE_PLAN_NEXT_SYNC_FAILED`. Add a DAO prune query that retains the newest 500 diagnostic rows.

- [ ] **Step 7: Run and commit**

Run: `cd android; .\gradlew.bat testDebugUnitTest`

Expected: PASS.

```powershell
git add android/app/src/main/java/com/siyi/al android/app/src/test/java/com/siyi/al
git commit -m "feat: execute role plans natively"
```

---

### Task 6: Add the Web Repository, Native Sync, and Role Schedule Context

**Files:**
- Create: `tavern-app/lib/role-plan-repository.js`
- Create: `tests/role-plan-repository.test.mjs`
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`
- Modify: `test-basic.mjs`

**Interfaces:**
- Consumes: `ALRolePlans`, `MemoryDB`, and optional `AlExecution` Capacitor plugin.
- Produces: `RolePlanRepository.list/apply/mutate/history/saveRuntimeSnapshot/reconcile`, plus `rolePlanCatalogForPrompt` and `roleScheduleContextForPrompt`.

- [ ] **Step 1: Write failing repository adapter tests**

Test an in-memory native adapter and IndexedDB-meta fallback for the same contract:

```js
const repo = createRolePlanRepository({ nativePlugin: null, metaStore, domain: ALRolePlans });
await repo.apply('char-a', [{ op:'create', type:'role_schedule', source:'user_created', title:'上班', intent:'工作', schedule:{ kind:'daily', time:'10:00' }, timeConfidence:'explicit' }]);
assert.equal((await repo.list('char-a')).length, 1);
assert.match(await repo.scheduleContext('char-a', Date.parse('2026-07-17T10:30:00+08:00')), /上班/);
```

Assert native calls use `upsertRolePlans`, fallback uses meta keys `role_plans_v1` and `role_plan_history_v1`, and neither stores API settings.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/role-plan-repository.test.mjs`

Expected: FAIL because the repository file is missing.

- [ ] **Step 3: Implement repository and reconciliation**

The exact interface is:

```js
function createRolePlanRepository({ nativePlugin, metaStore, domain, now = () => Date.now(), uid = rolePlanUid }) {
  return {
    list(characterId, options = {}),
    apply(characterId, operations),
    mutate(planId, action, patch = {}),
    history(planId, limit = 100),
    saveRuntimeSnapshot(characterId),
    reconcile(characterId),
    scheduleContext(characterId, at = now())
  };
}
```

On Android, Room wins reconciliation. On web, arrays live in IndexedDB `meta`, not localStorage. `saveRuntimeSnapshot` writes a stable `characterId:role-plan-runtime` CharacterSnapshot containing current prompts, latest messages, memory-query configuration, plan catalog, and active role schedules; it must use the protected `normalizedChatMaxTokens(settings.maxTokens)`.

- [ ] **Step 4: Apply plan parts only after visible replies are persisted**

Foreground replies call `extractRolePlanDirective(reply)` and `repo.apply` after `appendAssistantMessages` succeeds. Native results read every `PLAN` reply part and apply once using `turnId` as an idempotency key stored in history. Parse failures log diagnostics without failing the reply.

- [ ] **Step 5: Add role schedules to chat and plan-generation prompts**

```js
composer.add('role-schedule-context', roleScheduleContextForPrompt(char.id, Date.now()), {
  priority: 37,
  scenes: ['chat', 'proactive-chat', 'moment-post']
});
```

The context includes only current/relevant active schedules and excludes cancelled, ended, or contradicted rows.

- [ ] **Step 6: Refresh runtime snapshots at safe state boundaries**

After a chat turn commit, plan mutation, character edit, app boot reconciliation, or role-schedule transition, debounce `repo.saveRuntimeSnapshot(characterId)` for 300 ms. Do not write one snapshot per plan.

- [ ] **Step 7: Add assets, run, and commit**

Add repository asset to `APP_SHELL`; bump the Service Worker cache again.

Run: `node --test tests/role-plan-repository.test.mjs; npm test`

Expected: PASS.

```powershell
git add tavern-app/lib/role-plan-repository.js tests/role-plan-repository.test.mjs tavern-app/index.html tavern-app/sw-v11.js test-basic.mjs
git commit -m "feat: sync role plans with app state"
```

---

### Task 7: Build the Per-Character Schedule Screen

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `test-basic.mjs`
- Create: `tests/role-plan-ui.test.mjs`

**Interfaces:**
- Consumes: `RolePlanRepository` list, history, and mutation methods.
- Produces: screens `role-plans` and `role-plan-editor`, opened from contact profile and chat info.

- [ ] **Step 1: Write failing DOM/static UI tests**

Assert the HTML contains:

```js
assert.match(html, /id="screen-role-plans"/);
assert.match(html, /id="screen-role-plan-editor"/);
assert.match(html, /onclick="openRolePlans\(currentCharId, 'chat-info'\)"/);
assert.match(script, /async function renderRolePlansScreen\(\)/);
assert.match(script, /async function saveRolePlanEditor\(\)/);
assert.match(script, /async function retryRolePlanOccurrence\(/);
```

Add pure rendering assertions for four sections and labels `明确承诺`, `角色私下决定`, `用户创建`, `AI 推定时间`.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/role-plan-ui.test.mjs`

Expected: FAIL because screens and functions are absent.

- [ ] **Step 3: Add navigation entries and screen markup**

Add “安排表” buttons to both contact profile and chat info. The schedule screen contains tab/filter controls for `upcoming`, `recurring`, `schedule`, and `history`; a floating/new button; and a list region. The editor contains exact fields for type, source display, title, intent, recurrence kind, local time/date/weekdays/month day/interval, optional end date, inferred marker, and status actions.

- [ ] **Step 4: Render and mutate without chat notices**

`renderRolePlansScreen` groups repository rows, sorts next occurrence ascending, and exposes edit/pause/resume/run-now/cancel/retry/history actions. AI-created plans do not call `toast` and do not append chat messages. User actions may show a short settings toast.

Use safe escaping for all AI text and never embed raw JSON in `onclick`; store plan IDs in `data-plan-id`.

- [ ] **Step 5: Implement manual create/edit and confirmations**

Manual save uses `origin:'user'`, `source:'user_created'`, and the same domain validation. Cancel retains history. Physical deletion is available only for terminal history rows. “立即执行” creates a new occurrence at `Date.now()+5000` without changing the recurrence rule.

- [ ] **Step 6: Run and commit**

Run: `node --test tests/role-plan-ui.test.mjs; npm test`

Expected: PASS.

```powershell
git add tavern-app/index.html test-basic.mjs tests/role-plan-ui.test.mjs
git commit -m "feat: add character schedule screen"
```

---

### Task 8: Reconcile Foreground, Web Fallback, Cleanup, and Failure Recovery

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`
- Modify: `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/RoomExecutionStore.java`
- Create: `test-role-plan-recovery.mjs`
- Modify: `test-sw-automatic-task-guard.mjs`
- Modify: `test-cloud-device-cleanup.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: due web-fallback plans, Room pending-sync/failure states, existing automatic-task cleanup.
- Produces: recovery order, explicit plan retry, and cleanup scopes that do not accidentally delete role plans.

- [ ] **Step 1: Write failing recovery tests**

Cover:

```js
assert.deepEqual(recoveryOrder, ['direct-replies', 'explicit-role-plans', 'private-role-plans', 'ordinary-proactive']);
assert.equal(clearAutomaticTasks({ includeRolePlans:false }).remainingRolePlans, 2);
assert.equal(clearCharacterData({ includeRolePlans:true }).remainingRolePlans, 0);
assert.equal(retryDecision({ code:'HTTP_403' }).automatic, false);
assert.equal(retryDecision({ code:'NETWORK_INTERRUPTED', attempts:0 }).automatic, true);
```

Also test duplicate foreground/background claims, offline overdue execution, stale cloud push rejection, plan result persisted before next recurrence, and deterministic errors not spamming logs.

- [ ] **Step 2: Verify RED**

Run: `node test-role-plan-recovery.mjs`

Expected: FAIL before recovery orchestration exists.

- [ ] **Step 3: Enforce foreground recovery order**

Boot/app-active flow must be:

```js
await syncFromServiceWorkerState({ checkProactive: false });
resumePendingAssistantTurns();
await reconcileRolePlans({ sources: ['explicit', 'private'] });
await checkProactiveMessages();
```

`reconcileRolePlans` must skip generation when any chat has a pending direct reply, claim occurrences idempotently, and use the same persistence-before-display rules as native results.

- [ ] **Step 4: Implement deterministic failure pause and explicit retry**

Map 400 configuration errors, 401/403, insufficient balance, and model access errors to `failed` with `retryable=false`. Network/408/429/5xx use bounded retry. The schedule screen’s “重试本期” clears only the occurrence error and schedules a fresh job with the same occurrence ID; claim logic permits retry only from failed state.

- [ ] **Step 5: Scope cleanup explicitly**

Emergency “清空全部自动任务” must pass `includeRolePlans:false` and report “角色安排已保留”. Character deletion, full app-data restore, or a dedicated “清空该角色安排” passes true and removes local plans, snapshots, occurrences, history, and remote jobs.

- [ ] **Step 6: Bound diagnostics and history**

Retain newest 500 native diagnostics globally and newest 200 history rows per plan unless the user keeps fewer by deleting history. Error detail is capped at 600 characters and redacts bearer tokens, `sk-` keys, `x-api-key`, full prompts, and full message bodies.

- [ ] **Step 7: Run and commit**

Run: `npm test; cd android; .\gradlew.bat testDebugUnitTest`

Expected: PASS.

```powershell
git add tavern-app/index.html tavern-app/sw-v11.js android/app/src/main/java/com/siyi/al test-role-plan-recovery.mjs test-sw-automatic-task-guard.mjs test-cloud-device-cleanup.mjs package.json
git commit -m "fix: recover and isolate role plans"
```

---

### Task 9: End-to-End Verification and Cloud Deployment

**Files:**
- Modify if a test exposes a defect: files from Tasks 1–8 only
- Verify: `cloud-timer-worker.js`
- Verify: `wrangler.toml`

**Interfaces:**
- Consumes: complete local feature.
- Produces: tested Worker and app code ready for Android release.

- [ ] **Step 1: Run complete JavaScript and Worker tests**

Run:

```powershell
npm test
```

Expected: PASS for basic app, cloud device cleanup, quota recovery, ordinary singleton, role-plan coexistence, Service Worker guard, domain, repository, UI, and recovery tests.

- [ ] **Step 2: Run complete Android verification**

Run:

```powershell
cd android
.\gradlew.bat testDebugUnitTest
.\gradlew.bat lintDebug
```

Expected: both builds succeed with no new lint errors.

- [ ] **Step 3: Run a local Cloudflare dry deployment check**

Run: `npm run cloud:health`

Expected: current Worker health succeeds. Then deploy with the existing wrapper: `npm run cloud:deploy`.

Expected deployment smoke checks:

- Two `role-plan` jobs for one character coexist.
- A normal proactive chat job still replaces only the previous normal proactive chat job.
- Cancelling one role plan leaves the other intact.
- `/ack` removes only the matching occurrence job.
- A payload containing `intent` is rejected.

- [ ] **Step 4: Commit only test-driven corrections**

```powershell
git add -- cloud-timer-worker.js tavern-app/index.html tavern-app/sw-v11.js tavern-app/lib/role-plan-domain.js tavern-app/lib/role-plan-repository.js test-basic.mjs test-cloud-role-plans.mjs test-role-plan-recovery.mjs tests/role-plan-domain.test.mjs tests/role-plan-repository.test.mjs tests/role-plan-ui.test.mjs android/app/src/main/java/com/siyi/al android/app/src/test/java/com/siyi/al
git commit -m "test: verify autonomous role plans"
```

Skip the commit if verification required no code changes.

---

### Task 10: Publish the In-App Android Update

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/sw-v11.js`
- Modify: `test-basic.mjs`
- Verify: `.github/workflows/android-apk.yml`

**Interfaces:**
- Consumes: verified main-ready code and the current online Android build number.
- Produces: signed release APK, GitHub Release, and `update-channel/android-update.json` visible to in-app update checks.

- [ ] **Step 1: Fetch current main and release state before versioning**

Run:

```powershell
git fetch origin --prune
git rev-list --left-right --count origin/main...HEAD
& 'C:\Users\Administrator\Tools\bin\gh.exe' release view --repo siyi78118-hue/- --json tagName,publishedAt,url
```

Expected: no unreviewed remote commits are silently overwritten. If main advanced, rebase/merge narrowly and re-run all tests.

- [ ] **Step 2: Bump web build and Service Worker cache once**

Increase `APP_BUILD_VERSION` from the protected/current value to the next unused build string and increment `CACHE_NAME`. Update exact assertions in `test-basic.mjs`. Do not lower `MAX_CHAT_OUTPUT_TOKENS` or remove `collapseTextBubbles`.

- [ ] **Step 3: Run final release checks**

Run:

```powershell
npm test
cd android
.\gradlew.bat testDebugUnitTest lintDebug
```

Expected: PASS.

- [ ] **Step 4: Commit, push main, and monitor signing workflow**

```powershell
git add tavern-app/index.html tavern-app/sw-v11.js test-basic.mjs
git commit -m "build: publish autonomous role plans"
git push origin HEAD:main
& 'C:\Users\Administrator\Tools\bin\gh.exe' run watch --exit-status --interval 10
```

Expected: workflow passes app checks, native checks, release build, APK signature verification, asset upload, GitHub Release publication, and update-manifest publication.

- [ ] **Step 5: Verify the exact channel used by the app**

```powershell
$manifest=Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/siyi78118-hue/-/update-channel/android-update.json' -Headers @{ 'Cache-Control'='no-cache' }
$head=Invoke-WebRequest -Uri $manifest.releaseUrl -Method Head -MaximumRedirection 5
$manifest | ConvertTo-Json
$head.StatusCode
```

Expected: `latestBuild` exceeds the previously published build, `version` matches the new GitHub Release, and APK HEAD returns 200.
