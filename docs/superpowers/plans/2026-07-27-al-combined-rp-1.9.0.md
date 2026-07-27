# AL 综合 RP 1.9.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将第四轮训练后的综合 RP 1.9.0 安全同步到聊天小g、监督小g和手机端，保持记忆小g事实抽取隔离，并发布可覆盖安装的 AL 1.0.100。

**Architecture:** 保持 `tavern-app/index.html` 的 `combined.prompt` 为唯一编辑源，通过现有同步脚本生成运行时基础预设。PresetRegistry 使用 `manifest.json` 的 1.9.0 版本与内容校验和发布不可变种子；固定证书流水线负责 Android 测试、签名和正式 APK 发布。

**Tech Stack:** HTML 内嵌预设、Node.js 同步与契约测试、SQLite PresetRegistry、Capacitor Android、GitHub Actions 固定证书签名。

## Global Constraints

- 1.9.0 原文精准载入，不做二次措辞改写。
- 不修改虞栖专属人格、记忆小g和监督小g的独立预设。
- 保留最近四次主动消息至多一次 `skip` 的硬约束。
- 不覆盖其他窗口已完成的 1.0.99 工作。
- 正式 APK 版本为 `versionCode 100`、`versionName 1.0.100`。

---

### Task 1: 锁定 1.9.0 预设契约

**Files:**
- Modify: `tests/rp-preset-contract.test.mjs`

**Interfaces:**
- Consumes: `tavern-app/index.html` 中 `combined.prompt`
- Produces: 1.9.0 新增规则与版本号的回归契约

- [ ] **Step 1: 写入失败测试**

增加断言，要求综合 RP 包含“完整性按整个发送回合判断”“先判断玩家未回复的前因”“skip 只是后备选项”“上一条主动消息的力度”和“角色仍会继续上课、工作、吃饭、休息”。

- [ ] **Step 2: 验证测试失败**

Run: `node --test tests/rp-preset-contract.test.mjs`

Expected: FAIL，指出当前 1.8.4 缺少第四轮主动消息规则。

- [ ] **Step 3: 不在本任务修改实现**

本任务只建立可验证边界，具体内容在 Task 2 写入。

### Task 2: 精准载入综合 RP 1.9.0

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `yuqi-runtime/presets/manifest.json`
- Generated: `yuqi-runtime/presets/al-combined-rp.md`

**Interfaces:**
- Consumes: 用户提供的 `AL综合RP预设-1.9.0.md`
- Produces: 手机端与运行时共享的 1.9.0 基础预设

- [ ] **Step 1: 替换唯一编辑源**

将用户文件完整内容写入 `combined.prompt`，不改动相邻自定义预设或虞栖专属预设。

- [ ] **Step 2: 登记不可变版本**

将 `yuqi-runtime/presets/manifest.json` 的 `currentVersion` 从 `1.8.4` 改为 `1.9.0`。

- [ ] **Step 3: 运行同步**

Run: `npm.cmd run presets:sync`

Expected: `combinedChanged: true`，生成文件与编辑源逐字一致。

- [ ] **Step 4: 验证契约通过**

Run: `node --test tests/rp-preset-contract.test.mjs yuqi-runtime/test/preset-registry.test.mjs`

Expected: PASS。

### Task 3: 发布版本与全量回归

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `.github/workflows/android-apk.yml`
- Modify: `tests/android-unsigned-release-contract.test.mjs`

**Interfaces:**
- Consumes: 当前 Android 1.0.99
- Produces: AL 1.0.100 发布契约

- [ ] **Step 1: 先更新发布测试**

将契约期望改为 `versionCode 100` 和 `versionName 1.0.100`。

- [ ] **Step 2: 验证发布测试失败**

Run: `node --test tests/android-unsigned-release-contract.test.mjs`

Expected: FAIL，当前构建仍为 1.0.99。

- [ ] **Step 3: 更新两个发布源**

同步修改 Android Gradle 默认版本和 GitHub Actions 发布环境变量为 100/1.0.100。

- [ ] **Step 4: 运行全量测试**

Run: `npm.cmd test`

Expected: 所有 Node、预设、桥接和 UI 契约测试通过。

- [ ] **Step 5: 同步 Android 资源**

Run: `npm.cmd run android:network`

Run: `npm.cmd run android:sync`

Expected: Capacitor 完成手机端资源同步。

### Task 4: 激活、正式构建与验收

**Files:**
- Create: `artifacts/AL-1.0.100-release.apk`

**Interfaces:**
- Consumes: 已测试的 `codex/al-tdd` 提交
- Produces: 固定证书签名、可覆盖安装的正式 APK

- [ ] **Step 1: 只提交本次文件**

明确暂存综合 RP、版本、测试、规格和计划文件，不纳入 `zhaxian-workbench` 删除或其他未跟踪文件。

- [ ] **Step 2: 推送并监督固定证书流水线**

Run: `git push origin codex/al-tdd`

Expected: `android-apk.yml` 的 Node 测试、Android 原生检查、构建、签名验证和 `signed-builds` 发布全部成功。

- [ ] **Step 3: 下载并验证正式 APK**

检查：

```text
package=com.siyi.al
versionCode=100
versionName=1.0.100
v2 signing=true
signer count=1
certificate SHA-256=5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b
```

- [ ] **Step 4: 重启桥接并检查预设**

运行 `scripts/stop-yuqi-background.ps1` 和 `scripts/start-yuqi-background.ps1`，再请求 `/v1/health`。

Expected: `ok=true` 且 `presetVersion=1.9.0`。
