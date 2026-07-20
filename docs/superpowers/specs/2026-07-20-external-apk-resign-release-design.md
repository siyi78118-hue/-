# AL 1.0.74 外部 APK 重签发布设计

## 目标

将用户提供的 `AL-1.0.74-yuqi-adaptive-verified.apk.1` 在不重新编译、不改变程序内容的前提下，使用当前线上 AL 正式签名密钥重新签名，并发布到现有应用内更新通道，使正式签名版本能够覆盖安装且保留应用数据。

## 已确认输入

- 包名：`com.siyi.al`
- `versionCode`：`74`
- `versionName`：`1.0.74`
- 原文件 SHA-256：`358FC28355725B4DDE625E8BEC5122A1D0042F7DEE360E02AF0426141CA15425`
- 原签名证书 SHA-256：`383A167EB6C9264500C44C77F701C8176E15F997B726F7DD945350439B0A1A29`
- 目标正式证书 SHA-256：`5761277E3BDF4A64236C3BAD569DE6A07666581F643167D01E37F13E9E832B2B`
- 当前线上更新：`1.0.67`，目标更新：`1.0.74`

## 发布架构

1. 本机把原 APK 上传到一个临时草稿 Release，资产固定命名为 `source.apk`，不把二进制提交进 Git 历史。
2. 新增一个仅支持手动触发的 GitHub Actions 工作流。工作流从草稿 Release 下载 `source.apk`，验证输入哈希、包名、版本号和原签名。
3. 工作流在 GitHub 临时 Runner 中恢复现有 `ANDROID_KEYSTORE_BASE64` 等签名 Secret，先执行 `zipalign`，再用 `apksigner` 生成 `app-release.apk`。
4. 重签后重新验证包名、版本号、APK v2 签名和正式证书指纹。任何一项不一致都立即失败。
5. 验证通过后创建或更新 `android-v74` Release，上传 `app-release.apk`，将其标记为 Latest。
6. 仅在正式 Release 和资产均成功后，原子更新 `update-channel` 分支的 `android-update.json`：

```json
{
  "latestBuild": 74,
  "version": "1.0.74",
  "releaseUrl": "https://github.com/siyi78118-hue/-/releases/download/android-v74/app-release.apk"
}
```

7. 线上核验通过后删除临时草稿 Release；正式 Release 与更新清单保留。

## 安全边界

- 正式 PKCS12 私钥只在 GitHub Actions Runner 内短暂落盘，任务结束后由 Runner 销毁，不输出、不上传、不写入日志。
- 工作流拒绝非纯数字版本号、非 `com.siyi.al` 包、版本不是 `74 / 1.0.74`、原文件哈希不匹配或重签证书不匹配的输入。
- 工作流开始时读取当前更新清单；如果线上 `latestBuild >= 74` 且不是同一目标 Release，则停止，防止覆盖更新或降级。
- 更新清单是最后一步。此前任何失败均保持用户当前可用的 1.0.67 通道不变。
- 不修改用户提供 APK 中的 Web 资源、DEX、Manifest 或原生库；签名过程只允许 zipalign 和签名块变化。

## 测试与验收

- 先新增静态契约测试，验证工作流包含输入哈希、包名、版本、目标证书、先验证后发布、最后更新清单等门槛，并确认工作流在实现前测试失败。
- GitHub Actions 中运行 `aapt2 dump badging`、`apksigner verify --verbose --print-certs` 和 SHA-256 校验。
- 发布后通过 GitHub API 验证 `android-v74` 是 Latest、资产名为 `app-release.apk`、线上资产摘要与本地下载一致。
- 读取 `update-channel/android-update.json`，确认三个字段均指向 1.0.74。
- 下载最终 APK 再次核验：`com.siyi.al`、`versionCode 74`、`versionName 1.0.74`、正式证书 SHA-256 为 `5761277E...32B2B`。

## 不在范围内

- 不把 1.0.74 的源码合并回当前仓库。
- 不重新构建 1.0.74。
- 不发布原调试证书版本作为应用内正式更新。
- 不改变 Cloudflare、D1、云闹钟或聊天 API 配置。
