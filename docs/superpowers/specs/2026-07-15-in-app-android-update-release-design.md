# AL 应用内 Android 正式更新发布设计

## 目标

把“一键清空全部自动任务”作为 AL 的正式 Android 更新发布。所有已安装正式版的用户都能在软件内点击“检查更新”发现新版本，下载后覆盖安装，并保留聊天、角色、记忆、API 配置、设备标识和云闹钟绑定。

## 现状

- Android 包名为 `com.siyi.al`。
- 软件依次读取 `ANDROID_UPDATE_MANIFEST_URLS` 中的更新清单，失败时回退到 GitHub Latest Release API。
- 正式更新清单位于 GitHub 仓库 `siyi78118-hue/-` 的 `update-channel` 分支，当前发布版本为 `1.0.13`。
- `.github/workflows/android-apk.yml` 在 `main` 分支更新后运行测试，使用 GitHub Secrets 中的固定正式签名构建 APK，创建 `android-v<build>` Release，并更新 `android-update.json`。

## 发布方案

采用现有正式更新流水线，不手工上传本地调试签名 APK，也不绕过构建流程直接修改更新清单。

1. 将包含清理功能的提交快进推送到 `main`，不包含工作区内无关的删除或未跟踪文件。
2. GitHub Actions 执行 JavaScript 测试、Android 原生测试、Capacitor 资源同步和正式 APK 构建。
3. 流水线使用已有固定正式签名，保持包名 `com.siyi.al`，并用 `github.run_number` 生成高于当前线上版本的构建号。
4. 测试和构建成功后创建新的 GitHub Release，并将正式 APK 作为 `app-release.apk` 发布。
5. 流水线最后更新 `update-channel/android-update.json`；只有此前步骤成功时，软件内更新通道才指向新版本。

## 数据流

```text
main 新提交
  -> GitHub Actions 测试与正式签名构建
  -> GitHub Release / app-release.apk
  -> update-channel/android-update.json
  -> AL“检查更新”
  -> 浏览器下载安装包
  -> Android 覆盖安装并保留应用数据
```

## 安全与失败处理

- 不更换应用 ID、正式签名、更新清单位置或下载域名。
- 不把本地调试 APK 发布到正式更新通道。
- CI 任一测试、构建、签名或 Release 步骤失败时，后续清单发布不会执行；线上 `1.0.13` 保持可用。
- 已发布的错误版本不降级覆盖；通过修复后发布更高构建号处理。
- 推送只包含已经提交的 AL 功能与版本提交，不暂存或提交用户工作区的其他改动。

## 验证标准

发布完成必须同时满足：

1. GitHub Actions 工作流成功。
2. 新 Release 的构建号高于 `13`，并包含正式签名的 `app-release.apk`。
3. `update-channel/android-update.json` 的 `latestBuild`、`version` 和 `releaseUrl` 指向同一新 Release。
4. 下载地址无需 GitHub 登录即可访问。
5. AL 内“检查更新”会判断新构建号大于旧版并打开该下载地址。
6. 新 APK 包名仍为 `com.siyi.al`，可使用原正式签名覆盖安装；应用数据不因更新流程被清除。

## 非目标

- 本次不新增静默安装、应用内直接下载进度条或自建更新服务器。
- 本次不修改自动任务清理功能本身。
- 本次不删除旧 Release 或改写现有用户数据。
