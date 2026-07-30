# AL 1.0.107 原生交付收敛补丁设计

## 目标

修复 `1.0.106` 中“原生已经生成或通知已经显示，但聊天 WebView 仍停留在认真想”的不可观测
和不可恢复窗口，并把 `1.0.107` 发布为可覆盖安装、可被应用内更新检测的正式版本。

## 权威状态

每个完成 turn 在 Room 中持久化四阶段时间：

1. `nativeCompletedAt`：沿用 `completedAt`，原生结果已经原子提交。
2. `notificationShownAt`：Android `NotificationManager.notify()` 成功返回。
3. `uiAppliedAt`：WebView 已找到该 turn 的确定性气泡或朋友圈落点，并完成原生 ack。
4. `cloudConfirmedAt`：UI ack 之后的 delivery receipt 已被 PC/relay 接受。

`cloudConfirmedAt` 为空不等于失败。没有 bridge receipt 的本地 turn 标记为
`cloudConfirmationRequired=false`，诊断显示“不适用”；需要 receipt 且时间为空才显示“待确认”。

## 收敛路径

- `COMPLETED` 继续通过 Capacitor `executionCompleted` 主动唤醒。
- 3 秒轮询、完成事件、foreground restore 和页面重载全部调用同一个
  `reconcileNativeExecutionTurns()` single-flight。
- single-flight 和 per-turn apply lock 都有单次硬超时；超时只释放 Web 锁，不删除 Room
  结果、不推进 cursor、不写 `uiAppliedAt`。
- unapplied inbox 是快速路径；最近 50 条 completed replay 是自愈路径。
- 只有 `nativeTurnHasUiLanding()` 确认确定性 turn/part 已落地后才调用
  `acknowledgeUiApplied()`。
- 事件和轮询同时到达时，通过 per-turn lock、确定性 bubble ID、source turn ID 和原生 ack
  幂等保证只渲染一次。

## 诊断

`nativeDiagnostics()` 同时返回：

- 原始 diagnostics；
- 最近完成 turn 的 `deliveryStages`，包含四阶段布尔值、时间戳、
  `cloudConfirmationRequired` 和 turn/kind/character 标识。

设置页将四阶段分别显示，不再用单个“完成”概括整个链路。

## 测试矩阵

自动化覆盖：

1. 通知先显示、WebView 后打开；
2. 原生插件调用永久悬挂；
3. Capacitor 完成事件丢失但轮询恢复；
4. 页面重载后 replay 已完成结果；
5. 事件与轮询同时投递同一 turn；
6. 相同完成结果重复投递；
7. `uiAppliedAt` 仅在确定性 UI landing 后写入；
8. Room 9→10 非破坏迁移与四阶段诊断序列化。

## 发布

- Android：`versionCode=107`，`versionName=1.0.107`。
- Web：`APP_BUILD_VERSION=2026-07-30.107`。
- Service Worker：cache 从 `rpchat-v97` 升为 `rpchat-v98`。
- Actions、发布契约和仓库内 `android-update.json` 同步为 107。
- 正式证书流水线生成 APK；随后创建 `android-v107` Release，并将
  `update-channel/android-update.json` 指向该正式 APK。

