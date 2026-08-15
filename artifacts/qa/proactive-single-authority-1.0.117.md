# AL 1.0.117 主动消息单一权威验收记录

生成日期：2026-08-15（Asia/Shanghai）

## 修复结论

- Android Room 是主动私聊与主动朋友圈计划的唯一写权威；Web、Service Worker、Alarm、WorkManager 和 D1 只持有受代数与校验和约束的投影。
- 旧 Web、旧 Room 和旧 D1 候选在首次 Android 权威认领时一次性退休；状态刷新为只读，不再重排 `generation`、`jobId` 或 `dueAt`。
- 云 Worker 的正式自动 FCM 现在携带 `owner`、`authorityEpoch`、`generation` 和 `jobId`。这是修复“云端显示到期、Android 因缺少权威令牌而拒绝执行”的关键变更。
- 手动云闹钟测试使用独立测试任务，不修改正式主动消息计划，也不等待不存在的模型执行 ACK。

## 代码与测试

- Task 7 commit：`e52fdace`（cross-layer convergence）
- 1.0.117 release input commit：`d5bb1a5d`
- focused Node gate：102/102 通过。
- Android：`:app:testDebugUnitTest :app:assembleDebugAndroidTest`，187 tasks，成功。
- 全项目：`npm.cmd test` 通过；其中 `yuqi-runtime` 段 1415/1415 通过，0 fail，0 skipped，外层矩阵、`test-basic.mjs` 与 Service Worker guard 也全部通过。
- `git diff --check`：通过。

## 压力与反例

- 报告：`artifacts/qa/proactive-single-authority-soak.json`
- 转换次数：100（chat 与 moment 交替）
- 单调唯一 generation：100
- stale overwrite：0
- duplicate terminal advancement：0
- no-op status write：0
- 覆盖：terminal+event+poll、四种终态、Web/D1 stale 写入、Alarm+FCM 竞争、进程重启、迟到回复、clear/delete/disable、三份 legacy 候选退休、60 次只读状态刷新。

## Cloudflare 生产切换

- 迁移前 D1 本地备份：`artifacts/qa/al-cloud-timer-before-v117.sql`（不提交 Git；含生产推送订阅资料），SHA-256 `9e55d12418c5548f565efdb25f632223d1dad040ac4b5e0f7bec446bc2e2cbc6`。
- D1 migration：`0003_automatic_schedule_authority.sql`，远端成功执行 8 条命令。
- Worker：`al-cloud-timer`，版本 `2026-08-15.1`。
- Worker deployment version ID：`76bab1d2-7e45-4307-8d5f-a162c2bf6c9c`。
- Health：`ok=true`，Cron 正常，最近一次执行无失败。
- v2 status smoke：`{ok:true, exists:false}`。
- 迁移后只读 D1：`authority_count=0`、`event_count=0`、`rows_written=0`；证明部署后仍处于逐 stream 认领前的旧版兼容模式。

## Android 正式包

- 目标：`com.siyi.al`，versionCode `117`，versionName `1.0.117`。
- GitHub Actions run：`31856045343`，`success`。
- 正式 release：`android-v117`，已发布 `app-release.apk` 与兼容包 `app-debug.apk`。
- 自动更新通道：`update-channel/android-update.json` 已核验为 build `117`、version `1.0.117`，下载地址指向 `android-v117/app-release.apk`。
- 本地交付：`artifacts/AL-1.0.117-release.apk`，5,771,404 bytes。
- APK 校验：包名 `com.siyi.al`、versionCode `117`、versionName `1.0.117`、APK Signature Scheme v2 通过、signer 数量 1。
- 正式证书 SHA-256：`5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b`，与 `AL-1.0.116-release.apk` 完全一致，可覆盖安装。
- APK 文件 SHA-256：`0685a7ce6e98901374d1112337e03027b14f9a59c9f76247f933d71b7b02c650`。

## 尚未伪称通过的设备门

- `adb devices -l` 没有连接设备，因此未执行 `connectedDebugAndroidTest`，不宣称实机 Room 升级或 FCM/Alarm 竞态已经通过。
- 24 小时真实待机不聊天验收尚未完成。自动化 100 次加速 soak 已通过，但不能替代真实 Android 待机、进程被杀、重启和网络切换。
- 正式包安装后应记录起止 `authorityEpoch/generation/jobId/dueAt`；到期前四者不得改变，到期后只允许一个终态和一个下一代 generation。
