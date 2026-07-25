# AL Android 正式签名与交付流程

本流程用于把已经准备好的 AL Android 版本发布为可覆盖安装的正式签名 APK。正式私钥保存在 GitHub Actions 的加密 Secrets 中，本机不保存或导出私钥。

## 默认通道

默认不连接 GitHub Connector，不打开浏览器，不依赖 `gh` CLI。使用：

1. 本机 Git Credential Manager 中已有的 GitHub 凭据；
2. GitHub REST API；
3. `.github/workflows/android-apk.yml` 中的固定证书流水线；
4. `signed-builds` 分支中的正式 APK 交付物。

凭据只允许在进程内存中短暂使用。不得打印 token，不得把 Authorization Header、KeyStore、密码或 Alias 写入日志、命令输出、文档和仓库。

## 发布前检查

1. 确认目标源码已完整落盘，且没有覆盖其他窗口未完成的业务改动。
2. 确认以下版本号一致：
   - `android/app/build.gradle` 中的默认 `versionCode` 和 `versionName`；
   - `.github/workflows/android-apk.yml` 中的 `AL_RELEASE_VERSION_CODE` 和 `AL_RELEASE_VERSION_NAME`；
   - `tests/android-unsigned-release-contract.test.mjs` 中的发布契约。
3. 运行 `npm.cmd test`。
4. 视改动范围运行 Android 原生测试；正式流水线仍必须再次执行原生检查。
5. 用 `aapt dump badging` 检查用户提供的未签名 APK，确认包名和目标版本，但不直接把它当成正式包。

## API 认证

通过 `git credential fill` 从 Windows Credential Manager 读取 `github.com` 凭据，在同一个 PowerShell 进程中解析 password/token 并构造：

- `Authorization: Bearer <token>`
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2022-11-28`

只输出操作结果和提交 SHA，不输出凭据变量或请求头。

## 触发固定证书构建

### 源码已经在远端

优先通过 GitHub Actions REST API 对 `.github/workflows/android-apk.yml` 执行 `workflow_dispatch`，目标 ref 为 `codex/al-tdd`。不需要 GitHub Connector、浏览器或 `gh` CLI。

### 源码尚未在远端

使用 GitHub REST API 将边界明确、已经测试通过的文件写入 `codex/al-tdd`。提交前必须：

1. 对照当前远端文件 SHA；
2. 只上传本版本相关文件；
3. 保留其他窗口已经存在的提交和内容；
4. 确保最后一次提交命中工作流的 paths 触发范围。

若必须同步整条提交历史，优先恢复正常 Git 推送；不得 force push，不得重写或丢弃其他窗口提交。

## 监督构建

使用 Actions REST API 查询目标提交的 workflow run：

1. 记录 run ID；
2. 轮询 `status`、`conclusion` 和当前 job step；
3. 若失败，先读取 jobs、steps、check-run annotations，再本地复现失败命令；
4. 修复后重新触发，不得把失败或未完成的产物交付。

成功流水线必须至少完成：

- JavaScript 应用检查；
- Android 原生检查；
- release APK 构建；
- APK 签名验证；
- Actions artifact 上传；
- `signed-builds` 正式 APK 发布。

## 下载正式 APK

流水线成功后，从 GitHub Contents REST API 读取：

`artifacts/AL-<version>-release.apk?ref=signed-builds`

请求使用 `Accept: application/vnd.github.raw+json`，保存到：

`artifacts/AL-<version>-release.apk`

不要覆盖用户提供的未签名原文件。

## 交付验收

对下载后的正式 APK 逐项验证：

1. `aapt dump badging`：
   - package 必须为 `com.siyi.al`；
   - versionCode、versionName 必须与目标版本一致。
2. `apksigner verify --verbose --print-certs`：
   - 必须显示 `Verifies`；
   - 当前正式包必须至少通过 APK Signature Scheme v2；
   - signer 数量必须为 1。
3. 正式证书 SHA-256 必须为：

   `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`

4. 与上一正式版重新提取的证书指纹必须完全一致。
5. 计算最终 APK 文件 SHA-256。

任何一项不满足，都不得宣称“可覆盖更新”或“正式签名版”。

## 最终回复

最终交付必须包含：

- `artifacts/AL-<version>-release.apk` 的可点击本地链接；
- versionCode 和 versionName；
- 签名验证结果；
- 与上一正式版证书一致的结论；
- APK 文件 SHA-256。

## 禁止事项

- 不把旧 APK 的签名块复制到新 APK；修改 APK 后旧签名必然失效。
- 不尝试从证书摘要或旧 APK 还原私钥。
- 不使用 debug keystore、临时 keystore 或新证书冒充正式证书。
- 不打印、提交或持久化 GitHub token 与 Android 签名 Secrets。
- 不在未完成测试或流水线失败时交付正式包。
