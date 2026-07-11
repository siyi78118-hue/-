# AL Android App

AL 的 Android 版本使用 Capacitor 封装。`tavern-app` 中的 HTML、CSS、JavaScript、图标和 Service Worker 会被复制进 APK 的 assets，应用启动不读取 GitHub Pages，也不需要网站在线。

## 联网边界

- 角色、聊天、朋友圈、设置和向量记忆库存放在 Android WebView 的应用私有存储中。
- 聊天模型、记忆模型、语音转文字和 Cloudflare 闹钟仍需要互联网，因为它们本来就是远程 API。
- `capacitor.config.json` 不设置 `server.url`，因此生产 APK 不会加载远程网页。
- Android 禁止明文 HTTP。聊天、记忆、语音和闹钟地址应使用 HTTPS。

## 从网站迁移数据

1. 在网站的“设置 -> 备份”导出 JSON。
2. 在 Android App 的“设置 -> 恢复”选择该 JSON。
3. 云闹钟的设备推送订阅不会随备份迁移，需要在 App 中重新绑定。

备份包含 API Key，只应保存在自己的设备上。

## 构建

本机准备好 JDK 21 和 Android SDK 36 后运行：

```powershell
npm ci
npm run android:debug
```

APK 输出：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

GitHub Actions 的 `Build Android APK` 工作流也会构建同一个安装包，并以 `AL-android-debug` artifact 保存。

