# 用户向虞栖发送图片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven development and execute each task with red-green verification.

**Goal:** 在现有 AL 私聊、Android 桥接和 Codex 三窗口链路中加入用户单向图片输入。

**Architecture:** 图片在手机 WebView 内缩放压缩为受限 data URL，作为普通批次消息的附件进入 Android 原生执行链；PC 运行时验证并落到任务临时目录，再把同一张本地图片作为 Codex turn 输入交给三个角色窗口。现有 turn/message/batch 标识继续承担幂等与重试。

**Tech Stack:** HTML/CSS/JavaScript、Capacitor Android、Java、Node.js ESM、Codex app-server protocol。

## Global Constraints

- 不实现虞栖发图。
- 不新增第四个小g窗口。
- 不新增 R2 或新的云端绑定。
- 单条加密中继载荷保持在现有 512KB 上限以内。
- 必须保留文字、语音、支付、引用、主动消息和朋友圈现有行为。
- 从 1.0.97 升版，正式 APK 使用项目固定证书。

### Task 1: 图片消息 UI 和本地压缩

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `tavern-app/warm-modern.css`
- Test: `tests/yuqi-ui-contract.test.mjs`

- [ ] 先加入契约测试，要求“图片”入口、隐藏文件输入、压缩函数、图片气泡和附件批次字段存在。
- [ ] 运行测试并确认因功能缺失失败。
- [ ] 实现选择、方向安全解码、Canvas 缩放、质量递减压缩及图片消息渲染。
- [ ] 运行 UI 契约测试并确认通过。

### Task 2: Android 附件协议透传

**Files:**
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- Modify: `android/app/src/main/java/com/siyi/al/execution/bridge/BridgeClient.java` only if envelope validation requires it
- Test: `android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`

- [ ] 先加入附件解析和大小/类型校验的失败测试。
- [ ] 运行目标 Java 测试并确认失败。
- [ ] 最小实现附件字段保留与非法附件拒绝。
- [ ] 运行目标测试并确认通过。

### Task 3: PC 运行时图片落盘和 Codex 图像输入

**Files:**
- Modify: `yuqi-runtime/src/codex-client.mjs`
- Create: `yuqi-runtime/src/image-attachments.mjs`
- Modify: `yuqi-runtime/src/orchestrator.mjs`
- Test: `yuqi-runtime/test/codex-client.test.mjs`
- Create: `yuqi-runtime/test/image-attachments.test.mjs`
- Modify: `yuqi-runtime/test/orchestrator.test.mjs`

- [ ] 先加入 data URL 校验、稳定临时文件、Codex `localImage` 输入和清理测试。
- [ ] 运行目标 Node 测试并确认失败。
- [ ] 实现解码、签名校验、任务目录及 Codex 多模态输入。
- [ ] 将相同附件输入传给 memory、brain、supervisor，文字协议保持不变。
- [ ] 运行目标测试并确认通过。

### Task 4: 回归、版本和正式 APK

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tests/android-unsigned-release-contract.test.mjs`

- [ ] 运行 Node、Android 单元测试和 UI 契约测试。
- [ ] 将 versionCode/versionName 三处一致升级。
- [ ] 构建 unsigned release 并核对包名与版本。
- [ ] 按 `docs/AL-android-signing-runbook.md` 生成固定证书正式 APK。
- [ ] 用 `aapt` 和 `apksigner` 核验包名、版本、v2 签名及证书 SHA-256。
