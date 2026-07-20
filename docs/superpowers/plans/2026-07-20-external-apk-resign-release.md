# AL 1.0.74 External APK Resign Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 GitHub Actions 中现有 AL 正式密钥重签用户提供的 1.0.74 APK，并安全发布到应用内更新通道。

**Architecture:** 原 APK 作为临时草稿 Release 的 `source.apk` 传入，不进入 Git 历史。一个仅支持 `workflow_dispatch` 的工作流验证原文件、在临时 Runner 内重签、验证内容与目标证书、发布 `android-v74`，最后更新 `update-channel/android-update.json`。

**Tech Stack:** GitHub Actions、GitHub CLI、Android `aapt`/`zipalign`/`apksigner`、Node.js `node:test`、PowerShell 7。

## Global Constraints

- 原 APK SHA-256 必须等于 `358FC28355725B4DDE625E8BEC5122A1D0042F7DEE360E02AF0426141CA15425`。
- 包名必须是 `com.siyi.al`，版本必须是 `versionCode 74 / versionName 1.0.74`。
- 最终证书 SHA-256 必须等于 `5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B`。
- 正式密钥只在 GitHub Runner 内使用，不进入日志、Git、Release 或 Artifact。
- 更新清单必须在正式 Release 与资产可用后才更新。
- 不修改、不暂存工作区中其他窗口留下的文件。

---

### Task 1: 建立重签工作流契约测试

**Files:**
- Create: `tests/external-apk-release-workflow.test.mjs`
- Test: `tests/external-apk-release-workflow.test.mjs`

**Interfaces:**
- Consumes: `.github/workflows/publish-external-android-apk.yml` 文本。
- Produces: 对输入校验、签名校验、内容不变和发布顺序的静态契约。

- [ ] **Step 1: 写失败测试**

测试读取目标 YAML，断言：只允许手动触发；包含固定输入哈希、包名、74 版本和目标证书；原包校验发生在恢复密钥之前；正式证书校验发生在 Release 发布之前；更新清单发生在 Release 发布之后；存在 ZIP 条目内容对比。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --test tests/external-apk-release-workflow.test.mjs`

Expected: FAIL，因为 `.github/workflows/publish-external-android-apk.yml` 尚不存在。

### Task 2: 实现受保护的重签发布工作流

**Files:**
- Create: `.github/workflows/publish-external-android-apk.yml`
- Test: `tests/external-apk-release-workflow.test.mjs`

**Interfaces:**
- Consumes: 手动输入 `source_tag=android-v74-source-20260720`、`version_code=74`、`source_sha256=358FC...15425`，以及既有 Android 签名 Secrets。
- Produces: `android-v74/app-release.apk` 和 1.0.74 更新清单。

- [ ] **Step 1: 添加输入与远端版本门禁**

工作流只定义 `workflow_dispatch`，验证版本只能为 `74`、哈希只能为规格中的固定值，并读取更新清单阻止 `latestBuild >= 74` 时意外覆盖。

- [ ] **Step 2: 下载并验证原 APK**

从草稿 Release 下载 `source.apk`；运行 SHA-256、`aapt dump badging` 和 `apksigner verify --print-certs`，校验包名、版本和原证书。

- [ ] **Step 3: 恢复密钥并重签**

只在验证原包后解码 `ANDROID_KEYSTORE_BASE64`；执行 `zipalign -f -p 4`，再使用 PKCS12、别名和密码 Secrets 执行 `apksigner sign`，输出 `app-release.apk`。

- [ ] **Step 4: 验证重签结果与内容一致性**

再次运行 `aapt` 和 `apksigner`，要求目标证书完全匹配；使用 Python `zipfile` 对原包与重签包的条目名称和解压后内容 SHA-256 逐项比较，忽略签名元数据条目。

- [ ] **Step 5: 发布并最后更新清单**

创建或修复 `android-v74` Release，上传 `app-release.apk` 并设为 Latest；随后更新 `update-channel/android-update.json`；成功后删除临时草稿 Release。

- [ ] **Step 6: 运行专项测试确认 GREEN**

Run: `node --test tests/external-apk-release-workflow.test.mjs`

Expected: PASS。

### Task 3: 提交工作流并执行远端重签

**Files:**
- Create: `.github/workflows/publish-external-android-apk.yml`
- Create: `tests/external-apk-release-workflow.test.mjs`
- Create: `docs/superpowers/plans/2026-07-20-external-apk-resign-release.md`

**Interfaces:**
- Consumes: 已验证原 APK 与 Task 2 的工作流。
- Produces: 可从 AL “检查更新”发现的正式 1.0.74。

- [ ] **Step 1: 检查并提交目标文件**

Run: `git diff --check -- .github/workflows/publish-external-android-apk.yml tests/external-apk-release-workflow.test.mjs docs/superpowers/plans/2026-07-20-external-apk-resign-release.md`

Expected: 无空白错误；只暂存三个目标文件。

- [ ] **Step 2: 快进推送到 main**

先拉取 `origin/main` 并验证它是本地 HEAD 的祖先，再运行 `git push origin HEAD:main`。不得强推。

- [ ] **Step 3: 上传临时源 APK**

复制原文件为临时 `source.apk`，创建草稿 Release `android-v74-source-20260720` 并上传该资产；通过 GitHub API 验证资产摘要。

- [ ] **Step 4: 手动触发并监视工作流**

使用 `gh workflow run publish-external-android-apk.yml --ref main` 传入固定三个参数；使用 `gh run watch --exit-status` 等待完成。

### Task 4: 验证线上覆盖更新

**Files:**
- Read: GitHub Release `android-v74`
- Read: `update-channel/android-update.json`

**Interfaces:**
- Consumes: Task 3 的正式 Release。
- Produces: 对应用内更新可用性和签名兼容性的最终证明。

- [ ] **Step 1: 验证 Release 与清单**

确认 Latest 标签为 `android-v74`，资产名为 `app-release.apk`，清单为 `latestBuild=74`、`version=1.0.74`，URL 以 `/android-v74/app-release.apk` 结尾。

- [ ] **Step 2: 下载最终 APK 再验证**

下载正式资产，运行 SHA-256、`aapt dump badging`、`apksigner verify --print-certs`；确认包名、版本号和正式证书。

- [ ] **Step 3: 清理临时资源并记录结果**

确认草稿 Release 已删除；保留正式 Release、更新清单和本地测试记录。
