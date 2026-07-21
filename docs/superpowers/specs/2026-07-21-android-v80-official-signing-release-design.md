# AL Android 1.0.80 正式签名与发布设计

## 目标

将用户提供的未签名 APK 使用现有 AL 正式私钥重新签名，发布为 `android-v80`，并更新应用内自动更新渠道，使已安装的同证书 AL 正式版本能够直接覆盖安装。

## 已核验的源包身份

- 源文件：`AL-1.0.80-unsigned.apk.1`
- 包名：`com.siyi.al`
- versionCode：`80`
- versionName：`1.0.80`
- minSdk：`24`
- targetSdk：`36`
- 文件大小：`5,557,127` 字节
- SHA-256：`9AC694FB4858B999927218CE23D2ADB4C16D516A321634DC535E323F337A7139`
- 当前签名状态：未签名，`apksigner verify` 不通过并报告缺少签名清单

## 方案

升级现有 `.github/workflows/publish-external-android-apk.yml`，将其从锁定 1.0.74 的一次性发布流程调整为锁定 1.0.80。本次不修改应用功能代码，不复用或覆盖其他窗口的未提交文件。

不把流程扩展成任意版本通用签名器。所有身份值继续硬编码并由工作流输入二次核对，以防止错误 APK 被正式私钥签名。

## 数据流

1. 本地对源 APK 计算 SHA-256，并确认包名和版本。
2. 将原 APK 作为 `source.apk` 推送到临时分支 `codex/android-v80-source`。
3. 手动触发 GitHub Actions，输入固定的临时引用、版本号和源文件哈希。
4. Actions 验证当前更新渠道版本低于 80，避免降级或重复发布。
5. Actions 从临时分支读取源 APK；若临时草稿 Release 可用，也允许从其 `source.apk` 读取。
6. Actions 验证源包 ZIP 结构、包名、版本、SHA-256，并强制要求源包尚未签名。
7. Actions 从现有 Secrets 恢复正式 PKCS12 私钥，对齐并生成正式签名 APK。
8. Actions 验证正式 APK 的包名、版本、ZIP 对齐状态和证书摘要，并比较签名前后全部非签名 ZIP 条目的内容哈希。
9. Actions 发布 `android-v80/app-release.apk`。
10. 若 GitHub Release 附件上传失败，将同一正式签名 APK 写入 `update-channel/app-release-v80.apk` 作为下载兜底。
11. 只有正式 APK 已存在于 Release 或兜底位置后，才把 `android-update.json` 更新为 build 80。
12. 成功后删除临时源分支和临时草稿 Release。

## 正式签名门禁

正式 APK 必须满足：

- 证书主体：`C=CN, O=AL, CN=AL`
- 证书 SHA-256：`5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B`
- RSA 密钥长度：3072 位
- APK Signature Scheme v2：通过
- APK Signature Scheme v3：通过

正式私钥和密码仍只存在于 GitHub Actions Secrets：

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

工作流不得把这些值写入日志、提交或发布附件。

## 内容一致性

签名前后允许发生的变化仅包括：

- ZIP 对齐方式；
- APK Signing Block；
- `META-INF/` 下的签名相关条目。

工作流必须逐项比较其余 ZIP 条目的文件名集合和 SHA-256。任一非签名内容不同都应终止发布。

## 失败处理

- 源 APK 身份、结构或未签名状态不符合预期：在恢复正式私钥前停止。
- 正式证书摘要不匹配：停止发布，不更新自动更新清单。
- Release 附件上传失败：删除空 Release，并把已验证 APK 发布到更新分支兜底路径。
- 更新清单写入失败：保留已验证 APK，但不把 build 80 宣告为当前更新版本。
- GitHub API 临时 5xx：采用幂等重试；版本门禁和串行锁防止重复发布。

## 测试与验收

### 自动测试

扩展 `tests/external-apk-release-workflow.test.mjs`，先验证旧工作流因仍锁定 1.0.74 而失败，再修改工作流使测试通过。测试至少覆盖：

- 1.0.80 的包名、版本和源哈希；
- 源包必须未签名；
- 正式证书摘要；
- 内容一致性检查；
- Release 与更新分支兜底路径均使用 v80；
- 更新清单最后写入；
- 临时源资源成功后被清理。

### 发布后验收

- GitHub Actions 运行成功；
- 最新 Release 为 `android-v80`；
- `android-update.json` 的 `latestBuild` 为 `80`、`version` 为 `1.0.80`；
- 在线 APK 大小和 SHA-256 与 Release 资产记录一致；
- 本地重新下载后 `aapt` 显示 `com.siyi.al / 80 / 1.0.80`；
- `apksigner` 显示正式证书摘要并通过 v2、v3；
- 源包与正式包的全部非签名 ZIP 条目内容一致；
- 临时源分支、草稿 Release 和临时授权目录均已清理。

## 非目标

- 不修改 1.0.80 的应用功能代码。
- 不导出或公开正式私钥、Alias 或密码。
- 不重构为任意版本都能调用的通用签名服务。
- 不删除工作区内属于其他窗口的修改或未跟踪文件。
