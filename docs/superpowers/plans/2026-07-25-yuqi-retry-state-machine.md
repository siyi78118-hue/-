# 虞栖消息重试状态机 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让临时模型满载自动恢复，并让人工“重新发送”创建新执行任务且始终只在原消息下显示一组权威回复。

**Architecture:** 聊天气泡使用稳定 `sourceMessageId`，每次执行使用唯一 `turnId`。Android 把重试谱系写入 `context.retry`，电脑端验证并复用原用户消息；前端以当前 `activeTurnId` 拒绝旧任务迟到结果。模型调用只对明确容量错误执行一次同角色备用模型切换。

**Tech Stack:** JavaScript/HTML、Node.js ESM、SQLite、Java/Android Capacitor、Node test runner、JUnit、Gradle。

## Global Constraints

- 不复制用户气泡，也不重复写入用户记忆。
- 人工重试后，只有新的 `activeTurnId` 可以渲染回复和执行附带动作。
- 容量错误最多切换一次备用模型；账号额度耗尽不切换。
- 保留引用、红包、转账、批次和原失败诊断。
- 正式 APK 使用现有包名和正式证书，可覆盖安装。

---

### Task 1: 模型容量故障转移

**Files:**
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Test: `yuqi-runtime/test/orchestrator.test.mjs`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Produces: `isModelCapacityError(error): boolean`
- Produces: `fallbackRoleProfile(profile): { model, effort } | null`
- Produces: `YuqiStore.requeueTransientFailedTurn(turnId)` 对超时和模型容量错误均可恢复。

- [ ] **Step 1: 写失败用例**

在 orchestrator 测试中让首个 `codex.runTurn` 抛出 `CodexTurnError("Selected model is at capacity...")`，断言第二次调用保持 role/effort、模型由 `gpt-5.6-sol` 切到 `gpt-5.6-terra` 并完成。另加额度耗尽用例，断言只调用一次。存储测试断言容量失败可回到正确 checkpoint。

- [ ] **Step 2: 运行失败用例**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/protocol-store.test.mjs`

Expected: FAIL，缺少容量故障转移且容量失败不能 requeue。

- [ ] **Step 3: 实现最小故障转移**

在 `runStructuredRole` 的单次结构化输出尝试内捕获容量错误，写入 `model_capacity_failover` 诊断后用备用模型重试一次；对 usage-limit 错误原样抛出。扩展 `requeueTransientFailedTurn` 的错误分类，使服务重启或重复送达可恢复容量失败。

- [ ] **Step 4: 运行用例**

Run: `node --test yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/test/protocol-store.test.mjs`

Expected: PASS。

### Task 2: 重试协议与规范消息复用

**Files:**
- Modify: `yuqi-runtime/src/protocol.mjs`
- Modify: `yuqi-runtime/src/store.mjs`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Create: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- Test: `yuqi-runtime/test/protocol-store.test.mjs`

**Interfaces:**
- Consumes: `context.retry = { retryOfTurnId, canonicalMessageId }`
- Produces: 新 `turnId` 可安全复用同一规范用户消息，旧 turn 与新 turn 都指向同一 `sourceMessageId`。

- [ ] **Step 1: 写协议与存储失败用例**

断言 Android envelope 保留 `context.retry`；Node 协议拒绝非法旧任务号；存储接受“新 turn + 新 deviceSeq + 同 canonical message”，消息总数不增加，并拒绝跨设备、跨角色、正文不一致及不存在的旧任务。

- [ ] **Step 2: 运行失败用例**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Run: `gradlew.bat testDebugUnitTest --tests com.siyi.al.execution.bridge.BridgeInputTest`

Expected: FAIL，协议会丢弃 retry，存储会触发 message checksum conflict。

- [ ] **Step 3: 实现协议和复用验证**

`BridgeInput.envelope` 从 input 复制 retry；`validateDirectContext` 规范化两个 ID；`submitTurn` 在 retry 分支验证旧任务与规范消息归属和正文后跳过第二次 `putMessageInternal`，仍插入独立 turn。

- [ ] **Step 4: 运行用例**

执行 Step 2 两条命令，Expected: PASS。

### Task 3: 前端新任务重试与权威回复裁决

**Files:**
- Modify: `tavern-app/index.html`
- Test: `tests/yuqi-ui-contract.test.mjs`

**Interfaces:**
- Produces: `nativeRetryTurnIdForMessage(messageId)` 每次返回新的合法 `turn_` ID。
- Produces: `pendingReply.nativeTurnId` 为当前 `activeTurnId`，`pendingReply.retryOfTurnId` 保存谱系。

- [ ] **Step 1: 写失败契约用例**

断言 `retryFailedReply` 生成新 turn、fresh `deviceSeq/createdAt`、调用 `submitTurn` 而非 `retryTurn`，input 带 retry 元数据；断言 `applyNativeExecutionTurnUnlocked` 在任何动作执行前拒绝与 pending `nativeTurnId` 不同的 direct turn 结果。

- [ ] **Step 2: 运行失败用例**

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: FAIL，当前代码沿用旧 turn 并调用 `retryTurn`。

- [ ] **Step 3: 实现新任务与裁决**

重试时保存旧 ID、生成新 ID、刷新提交时间，复用原消息和 options 后调用 `plugin.submitTurn`。Direct result 若不属于当前 active turn，则只做本地收件确认，不渲染、不清 pending、不应用关系、支付、计划或日程动作。

- [ ] **Step 4: 运行用例**

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: PASS。

### Task 4: 全量回归、当前任务恢复与正式 APK

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `android/app/src/main/assets/public/index.html`
- Delete: `scripts/requeue-current-yuqi-turn.mjs`
- Keep: `scripts/inspect-yuqi-turn-http.mjs`

**Interfaces:**
- Produces: 下一连续版本的正式可覆盖安装 APK。

- [ ] **Step 1: 同步 Web 资源并递增版本**

运行项目既有 Android Web 同步流程，确认 assets 中包含新重试逻辑；把 versionCode/versionName 递增到高于当前正式版。

- [ ] **Step 2: 全量测试**

Run: `npm test`

Run: `node --test yuqi-runtime/test/*.test.mjs tests/*.test.mjs`

Run: `gradlew.bat testDebugUnitTest`

Expected: 全部 PASS。

- [ ] **Step 3: 本地构建与 APK 静态核验**

Run: `gradlew.bat assembleRelease`

核对包名、versionCode、versionName、Web 资源和未签名/本地构建产物可安装结构。

- [ ] **Step 4: 按正式签名 runbook 发布**

按 `docs/AL-android-signing-runbook.md` 触发固定证书构建并下载到 `artifacts/`；用 `aapt` 和 `apksigner` 验证包名、版本、v2/v3 签名及证书 SHA-256 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`。

- [ ] **Step 5: 端到端验收**

提交一条测试消息，确认正常回复；模拟容量错误确认备用模型接管；模拟失败后点击重新发送，确认新 turn、同一气泡、唯一回复、云信箱确认送达。
