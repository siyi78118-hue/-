# AL 1.0.120 主动消息恢复验收记录

日期：2026-08-15

## 修复目标

- FCM 已接收但手机尚未确认时，不得提前消费主动消息权威计划。
- 旧客户端留下的 `paused` 空壳只能由同一角色、类型、代次、校验和和计划时间的本地 Room 记录恢复，不能重新随机排期。
- Android 对 `CLAIMED`、`REPLAY`、`STALE` 和非法推送分别处理；合法重复推送可重新唤醒恢复，非法推送不得写入或执行。
- 本地权威计划、待发送 outbox、已领取 turn 或云端回读不一致时必须显式记为冲突，不能静默成功或覆盖其中一方。
- FCM 事件落库与 WorkManager 唤醒之间即使崩溃，也必须由持久事件在开机/服务恢复时补做，且最多三次立即重试后转延迟同步。
- 角色删除必须在同一 Room 事务中为 chat/moment 写入既有 lifecycle disable 权威；被隔离但完整的前代按代次补送，foreign/篡改前代使整笔删除回滚。
- 设置页只显示当前计划、云同步和最近阶段，不再展示会不断变化的内部 job/generation/epoch 标识。

## 已验证事实

- 意外重启后本机 `http://127.0.0.1:17891/v1/health` 返回 `ok=true`；记忆、认知、监督和云中继均在线。
- 云端计划恢复及发布契约：43/43 通过；另有 lifecycle disable 定向门 26/26 通过，覆盖 scheduled/awaiting-ack 停止、幂等和旧 ACK 不可复活。
- Android 定向单测：`AlFirebaseMessagingServiceTest` 9/9、`AutomaticScheduleSenderTest` 9/9。
- Android `assembleDebugAndroidTest`：成功。
- Web/UI 合同：74/74 通过。
- `test-basic.mjs`：通过。
- `git diff --check`：通过。
- 最后一处 Room 冲突修复后重新执行 `npm.cmd test`，完整命令退出码为 0；其中 `yuqi-runtime` 1430/1430 通过，基础应用与 Service Worker 门禁也通过。
- 中控完成三轮 TDD 返修；常务最终只读复核覆盖 claim/role-delete 竞态、FCM intent 重启、旧代 outbox、完整 20-key disable wire 和 1–6 写边界，结论为无 P0/P1、放行。

## 设备与生产边界

- `adb devices` 无在线设备，因此没有运行、也不宣称 `connectedDebugAndroidTest` 已通过。
- 本地 Worker 目标版本为 `2026-08-15.11`；生产部署须在明确外发授权后执行并再次核对 `/health`。
- 目标 Android 版本为 `1.0.120 (120)`；正式 APK 必须通过 GitHub 固定证书构建并核对包名、版本、签名证书和 SHA-256。
- 生产 D1 中原有 chat/moment 权威行在诊断期间未被人工改写。安装新版并打开应用后，才允许手机用自己的 Room 记录进行精确恢复。

## 安装后端到端硬门

1. 手机安装正式 1.0.120 并打开应用，让 Room 恢复流程运行。
2. 云端同一计划必须保持原代次、校验和和计划时间，不得继续自行漂移。
3. 到期 FCM 后必须出现手机 claim/ack 证据；PC 接到 proactive turn 后才算链路已真正打通。
4. 文本落到 WebView、通知、云端确认分别观察；任何一层失败不得冒充完整成功。
