# 虞栖模糊时间自主安排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让合法的 `timeConfidence: inferred` 角色安排真实提交和执行，同时保留自然回复，只对明确时间和其他显式操作生成代码确认。

**Architecture:** 保留现有 canonical role-plan action authority、target resolver 和原子提交；只调整 DIRECT_REPLY 的确认决策与渲染选择。所有操作先走完整验证，随后按“需要公开确认”与“静默推测时间”分组；action set 仍包含两组，visible reply 只由需要公开确认的一组替换。

**Tech Stack:** Node.js ESM、`node:test`、Yuqi canonical action authority、SQLite authority tests。

## Global Constraints

- `timeConfidence: explicit` 和 `timeConfidence: inferred` 都可以形成真实安排。
- 合法推测时间必须保留在 canonical action set、生成指纹并原子提交。
- 纯推测时间保留模型自然回复，不公开内部具体时刻。
- 混合操作只渲染明确时间或取消、暂停、恢复、完成等公开确认项。
- 无效时间、未知字段、伪造目标、跨角色操作继续 fail closed。
- protocol v1/v2、authority-v0 与历史已提交安排保持兼容。

---

### Task 1: DIRECT_REPLY 推测时间确认策略与原子提交

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs:342-474,2688-2747`
- Test: `yuqi-runtime/test/orchestrator.test.mjs:1070-1160,1429-1520`

**Interfaces:**
- Consumes: `rolePlanOperationNeedsExplicitTime(operation)`, `validateRolePlanConfirmationOperation(operation, targetSnapshot)`, `canonicalResolvedActionBundle(turn, draft)`。
- Produces: `requiresUserConfirmation(...)` 对纯 inferred 返回 false；`rolePlanOperationNeedsVisibleConfirmation(operation)` 供 DIRECT_REPLY 渲染分组使用。

- [ ] **Step 1: 把现有拒绝测试改成推测时间允许测试**

将 `v3 role-plan confirmation rejects ambiguous schedule and private or legacy lanes` 改为：

```js
test('v3 role-plan confirmation keeps inferred schedules silent while legacy lanes stay unchanged', () => {
  const inferred = {
    op: 'create', type: 'private_message', source: 'spoken', title: '提醒', intent: '明早问候',
    schedule: { kind: 'once', at: '2026-07-24T15:00:00+08:00' }, timeConfidence: 'inferred'
  };
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 3, kind: 'DIRECT_REPLY', operations: [inferred], targetSnapshots: [null]
  }), false);
  for (const kind of ['ROLE_PLAN_CHAT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE']) {
    assert.equal(orchestratorModule.requiresUserConfirmation({
      protocolVersion: 3, kind, operations: [inferred], targetSnapshots: [null]
    }), false);
  }
  assert.equal(orchestratorModule.requiresUserConfirmation({
    protocolVersion: 2, kind: 'DIRECT_REPLY', operations: [inferred], targetSnapshots: [null]
  }), false);
});
```

- [ ] **Step 2: 把真实早安用例改成要求 action 被保留**

在 `runCanonicalReleaseTurn preserves a direct reply...` 中把期望改成：

```js
assert.equal(result.status, 'committed');
assert.equal(resolverCalls, 1);
assert.equal(committed.visibleGroup.items[0].content, '嗯，明天醒了就来找你。晚安。');
assert.equal(committed.actionSet.length, 1);
assert.equal(committed.actionSet[0].kind, 'role_plan_create');
assert.equal(committed.actionSet[0].payload.timeConfidence, 'inferred');
assert.equal(committed.actionSet[0].payload.schedule.at, '2026-08-15T08:00:00+08:00');
```

新增混合操作用例，断言 action set 同时包含 inferred create 与 explicit create，而代码确认文本只包含 explicit 标题，不包含 inferred 标题或其具体时刻。

- [ ] **Step 3: 运行测试确认红灯**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`

Expected: FAIL；纯 inferred 仍抛 `explicit time confidence is required`，真实早安 action set 仍为空。

- [ ] **Step 4: 实现最小确认分类**

在 `rolePlanOperationNeedsExplicitTime` 后加入：

```js
function rolePlanOperationUsesInferredTime(operation) {
  return isPlainRolePlanObject(operation)
    && rolePlanOperationNeedsExplicitTime(operation)
    && operation.timeConfidence === 'inferred';
}

function rolePlanOperationNeedsVisibleConfirmation(operation) {
  return !rolePlanOperationUsesInferredTime(operation);
}
```

把 `validateRolePlanConfirmationOperation` 的时间置信度校验改为：

```js
if (rolePlanOperationNeedsExplicitTime(operation)) {
  if (!['explicit', 'inferred'].includes(operation.timeConfidence)) {
    rolePlanConfirmationConflict('time confidence is invalid');
  }
  const schedule = operation.op === 'create'
    ? operation.schedule
    : operation.schedule ?? operation.patch?.schedule;
  rolePlanScheduleValue(schedule);
}
```

在 `requiresUserConfirmation` 完整验证所有 user-authorized operations 后返回：

```js
return operations.some(rolePlanOperationNeedsVisibleConfirmation);
```

删除 `runCanonicalReleaseTurn` 当前过滤 inferred operations 的分支。在渲染前建立显式确认子集：

```js
const confirmationEntries = rolePlanBundle.actions.map((action, index) => ({
  action,
  targetSnapshot: rolePlanBundle.targetSnapshots[index]
})).filter(entry => rolePlanOperationNeedsVisibleConfirmation(entry.action.payload));
```

`requiresUserConfirmation` 继续接收完整 operations 做验证；返回 true 时，只把 `confirmationEntries` 传给 `renderRolePlanConfirmationSet`。action set 与 generation fingerprint 继续使用完整 `resolvedActionBundle.actions`。

- [ ] **Step 5: 运行聚焦门**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs`

Expected: 该文件全部 PASS，明确时间原测试文本不变，推测早安保留自然回复与一个 action。

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/visible-result-commit.test.mjs yuqi-runtime/test/release-executor.test.mjs yuqi-runtime/test/turn-dispatcher.test.mjs`

Expected: 全部 PASS，canonical action、commit fingerprint、release execution 和恢复无回归。

- [ ] **Step 6: 重启本机运行时并检查健康状态**

Run: `powershell -ExecutionPolicy Bypass -File scripts/stop-yuqi-background.ps1`

Run: `powershell -ExecutionPolicy Bypass -File scripts/start-yuqi-background.ps1`

Expected: `/v1/health` 返回 `ok: true`，cloud relay connected，无第二个 17891 listener。

- [ ] **Step 7: 提交实现**

```bash
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "fix: allow Yuqi to schedule inferred times"
```
