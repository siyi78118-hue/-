# AL Model Compatibility And Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development task-by-task.

**Goal:** 修复温度兼容、主动消息上限、朋友圈正文解析和聊天分段回归。

**Architecture:** 在现有单页设置与请求构造层增加显式参数开关，在主动快照入口约束消息数量，在原生结果应用边界解析朋友圈正文，并让 JS/Java 分段规则保持一致。避免改动 Room 执行状态机和云闹钟协议。

**Tech Stack:** HTML/JavaScript、Capacitor Android/Java、Node.js assertions、JUnit 4。

## Global Constraints

- 普通聊天始终保留最近 30 条原文。
- 关闭温度开关时不得先失败再重试。
- 朋友圈不得显示 JSON 包装。
- 短回复不得机械拆分。

---

### Task 1: 写失败测试

**Files:** `test-basic.mjs`, `android/app/src/test/java/com/siyi/al/execution/api/ReplyParserTest.java`

- [ ] 测试温度请求体开关、29+1 主动上下文、朋友圈 JSON 正文提取。
- [ ] 测试中长两句拆分和短句不拆分。
- [ ] 运行测试并确认因行为缺失而失败。

### Task 2: 最小实现

**Files:** `tavern-app/index.html`, `android/app/src/main/java/com/siyi/al/execution/api/ApiConfig.java`, `android/app/src/main/java/com/siyi/al/execution/api/OpenAiCompatibleClient.java`, `android/app/src/main/java/com/siyi/al/execution/secure/AlSecretStore.java`, `android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`, `android/app/src/main/java/com/siyi/al/execution/api/ReplyParser.java`

- [ ] 增加并持久化聊天/记忆温度参数开关。
- [ ] 所有对应请求构造按开关省略参数。
- [ ] 主动快照改为 29 条历史加 1 条触发。
- [ ] 解析朋友圈 JSON 包装。
- [ ] 对齐 JS 与 Java 分段规则。

### Task 3: 验证与发布

**Files:** `tavern-app/index.html`, `test-basic.mjs`, `tavern-app/sw-v11.js`

- [ ] 运行网页和 Android 单元测试及 Worker 语法检查。
- [ ] 更新构建版本和缓存版本。
- [ ] 仅暂存本次 AL 文件，提交并推送 `codex/al-tdd` 与 `main`。
- [ ] 验证 GitHub Actions 更新通道并给出 APK 地址。
