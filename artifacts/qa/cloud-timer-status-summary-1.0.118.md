# AL 1.0.118 运行状态摘要验收记录

生成日期：2026-08-15（Asia/Shanghai）

## 用户可见变化

- 设置页“状态”最多四行：运行状态、下次私聊、下次朋友圈，以及必要时的同步提示。
- 当前正常时不再显示任务代数、epoch、jobId、变更来源、轮询检查时间、Worker 版本、接口检查和模型调用。
- 2026 年 7 月等旧失败不会再被当作当前异常；整段 HTML 错误不会再撑开设置页。
- “诊断”改为“查看完整运行信息”，主动调度的完整技术状态、历史错误和模型调用证据仍然保留并可复制。

## 行为边界

- 仅改变 Web 展示投影，没有修改 Android Room、D1、Alarm、WorkManager、Service Worker 或云 Worker 的调度权威。
- 云 Worker 继续使用已经部署并验收的 `2026-08-15.1`；本版本无需再次迁移 D1 或部署 Worker。
- 当前有效计划的 `cloudSyncState` 是设置页同步提示的唯一来源，历史聊天字段不能覆盖它。

## 测试

- TDD 红灯：旧实现输出超过四行，且不存在独立的完整调度诊断投影。
- `node test-basic.mjs`：通过，包含四行上限、历史 HTML/内部 ID 隔离、诊断证据保留和设置页不读取模型日志。
- `node --test tests/yuqi-ui-contract.test.mjs`：70/70 通过。
- `node --test tests/android-unsigned-release-contract.test.mjs`：3/3 通过。
- `npm.cmd test`：通过；其中 `yuqi-runtime` 段 1415/1415 通过，外层矩阵、基础检查与 Service Worker guard 全部通过。

## 正式发布

- 目标：`com.siyi.al`，versionCode `118`，versionName `1.0.118`。
- Release input commit：`d51509e3`。
- GitHub Actions run：`31858743062`，`success`。
- 正式 release：`android-v118`，已发布 `app-release.apk`；Release 资产大小 5,771,904 bytes。
- 自动更新通道：`update-channel/android-update.json` 已核验为 build `118`、version `1.0.118`，下载地址指向 `android-v118/app-release.apk`。
- 本地交付：`artifacts/AL-1.0.118-release.apk`。
- APK 校验：包名 `com.siyi.al`、versionCode `118`、versionName `1.0.118`、APK Signature Scheme v2 通过、signer 数量 1。
- 正式证书 SHA-256：`5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`，与 `AL-1.0.117-release.apk` 完全一致，可覆盖安装。
- APK 文件 SHA-256：`3282e853f9ab81a930cc0e06b0021b59e739f5a7982565df2f63ddc9ec700ee7`；与 GitHub Release 资产摘要一致。

## 仍需实机观察

- 当前没有连接 Android 设备，因此不宣称 `connectedDebugAndroidTest` 通过。
- 安装后应确认设置页默认摘要不超过四行；“诊断”页面仍可查看完整旧记录。
