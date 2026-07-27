# Empty Image Attachment Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让纯文本直接消息省略空附件字段，并兼容已在云端滞留的 `attachments: []` 消息。

**Architecture:** 手机端在创建协议 envelope 时只条件写入非空附件；协议入口负责兼容旧客户端的空数组并保留所有非空图片校验。云中继无需改动，未确认消息会在后台重启后自动重试。

**Tech Stack:** HTML/JavaScript、Node.js、`node:test`、虞栖 protocol v2、Cloud Relay。

## Global Constraints

- 仅兼容空数组，不允许多图。
- 不修改图片 MIME、尺寸、字节数、签名和 ID 校验。
- 不手工伪造回复或删除云端滞留消息。

---

### Task 1: 协议入口兼容空附件数组

**Files:**
- Modify: `yuqi-runtime/test/protocol-store.test.mjs`
- Modify: `yuqi-runtime/src/protocol.mjs`

**Interfaces:**
- Consumes: `validateMessage(message, envelope)`
- Produces: 纯文本消息的规范化结果不含 `attachments`

- [ ] **Step 1: Write the failing test**

增加测试：给 `validV2Envelope().message.attachments` 赋值 `[]`，调用 `validateEnvelope` 后断言 `attachments` 不存在。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: FAIL，错误为 `direct message supports exactly one image attachment`。

- [ ] **Step 3: Write minimal implementation**

当 `message.attachments` 是空数组时删除该字段；其他已定义值继续调用 `validateImageAttachments`。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test yuqi-runtime/test/protocol-store.test.mjs`

Expected: PASS。

### Task 2: 手机封包省略空附件字段

**Files:**
- Modify: `tests/yuqi-ui-contract.test.mjs`
- Modify: `tavern-app/index.html`

**Interfaces:**
- Consumes: `task.options.attachments` 与 `messageAttachmentsForAI(userMessage)`
- Produces: `message` JSON；无图时无 `attachments`，有图时恰好一项

- [ ] **Step 1: Write the failing test**

增加源码合约断言：封包先生成 `wireAttachments`，再以 `...(wireAttachments.length ? { attachments: wireAttachments } : {})` 条件展开。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/yuqi-ui-contract.test.mjs`

Expected: FAIL，现有源码无条件写入 `attachments`。

- [ ] **Step 3: Write minimal implementation**

计算附件数组并用条件展开写入 `message`；保持图片消息映射及 `messageId` 归属不变。

- [ ] **Step 4: Run focused and full tests**

Run:

`node --test tests/yuqi-ui-contract.test.mjs yuqi-runtime/test/protocol-store.test.mjs`

`npm.cmd test`

Expected: 全部 PASS。

### Task 3: 恢复真实滞留消息

**Files:**
- No source change.

**Interfaces:**
- Consumes: 云中继中未确认的 `turn_msg_1785130887070_71kpb0`
- Produces: committed turn、手机可见回复、云端 ack

- [ ] **Step 1: Restart runtime**

仅停止已核验命令行为 `yuqi-runtime/src/main.mjs` 的 PID，再运行 `npm.cmd run yuqi:start`。

- [ ] **Step 2: Verify durable recovery**

用 `scripts/inspect-yuqi-turn.mjs` 确认 turn 进入 `committed`，并用 `scripts/inspect-yuqi-relay-inbox.mjs` 确认对应 relay 消息消失。
