# Canonical Recovery Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已部署 Android 中错误标成 legacy turn 的 canonical 用户消息 recovery 条目安全收敛，并阻止 Web 再产生该错误投影。

**Architecture:** `YuqiReconciler` 在现有消息写入前执行一个闭合的 canonical-alias 判定；判定只接受同设备 protocol-v3 authority-v1 owner 与完全相同的用户语义。Web 在创建确定性 native turn 时把该 turn 身份写回用户气泡，后续 `syncYuqiVisibleHistory` 继续使用现有 `sourceTurnId` 投影。

**Tech Stack:** Node.js、node:test、SQLite、原生 WebView JavaScript。

## Global Constraints

- 不删除或改写既有 canonical 消息。
- 不手工 ACK 当前云消息。
- 不放宽普通 message checksum 冲突。
- 所有负例必须保持 recovery cursor 不前进。

---

### Task 1: PC recovery 精确别名收敛

**Files:**
- Modify: `yuqi-runtime/src/reconcile.mjs`
- Test: `yuqi-runtime/test/reconcile.test.mjs`

**Interfaces:**
- Consumes: `store.getMessage(messageId)`、`store.getTurn(turnId)`、validated recovery message entry。
- Produces: `isCanonicalUserMessageRecoveryAlias({ store, peerId, entry }) -> boolean`，仅供 reconcile 入站使用。

- [ ] **Step 1: 写失败测试**

构造 PC 已有 `turn_msg_alias`/`msg_alias` canonical 用户消息，recovery 输入相同语义但只有 Android 实际九字段且 turn 为 `turn_legacy_msg_alias`；断言成功、`ackSeq` 前进且原行字节不变。表驱动改变正文、时间、角色、收件人、peer、增加 device pin 和改变 owner authority，断言拒绝且 cursor 不前进。

- [ ] **Step 2: 运行红灯**

Run: `node --test yuqi-runtime/test/reconcile.test.mjs`

Expected: 精确 alias 用例以 `message checksum conflict` 失败。

- [ ] **Step 3: 最小实现**

在 `reconcileFrom` 的 message 分支中，只有现有消息存在且闭合 helper 返回 true 时跳过 `putMessage`；否则保持原调用与原错误。

- [ ] **Step 4: 运行绿灯**

Run: `node --test yuqi-runtime/test/reconcile.test.mjs`

Expected: 全部通过。

### Task 2: Web 保留 canonical source turn

**Files:**
- Modify: `tavern-app/index.html`
- Test: `test-basic.mjs`

**Interfaces:**
- Consumes: `nativeTurnIdForMessage(userMessageId)`。
- Produces: `userMessage.sourceTurnId = native:<turnId>`，供 `syncYuqiVisibleHistory` 去前缀后发送。

- [ ] **Step 1: 写失败合同**

在基础合同中要求 `queueAndroidUserReply` 在聊天状态持久化之前给当前用户气泡写入 native source turn。

- [ ] **Step 2: 运行红灯**

Run: `node test-basic.mjs`

Expected: 缺少 source-turn 赋值而失败。

- [ ] **Step 3: 最小实现**

在已计算 `turnId`、写 `pendingReply` 的同一同步区段设置 `userMessage.sourceTurnId = `native:${turnId}``，继续由现有 `DB.set('chats', allChats)` 持久化。

- [ ] **Step 4: 运行绿灯与组合门**

Run: `node test-basic.mjs`

Run: `node --test yuqi-runtime/test/reconcile.test.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-runtime/test/direct-reply-v3-features.test.mjs`

Expected: 全部通过。

### Task 3: 实际队列恢复

**Files:**
- Delete after use: `scripts/.tmp-inspect-cloud-message.mjs`

**Interfaces:**
- Consumes: 当前 relay message `relay_f3c6a20a8040f41a4b72b222`。
- Produces: 正常 PC turn、正常云 ACK 与手机可接收结果。

- [ ] **Step 1: 重启常驻服务并观察正常 poll**

Run: `powershell -File scripts/stop-yuqi-background.ps1`

Run: `powershell -File scripts/start-yuqi-background.ps1`

- [ ] **Step 2: 验证实际状态**

确认 relay input 不再存在、PC 数据库出现 `turn_msg_1786621828207_c3ofkl`，且其状态不因 recovery checksum 冲突失败。

- [ ] **Step 3: 完整门禁**

Run: `npm.cmd test`

Expected: exit code 0，无 fail/skip。
