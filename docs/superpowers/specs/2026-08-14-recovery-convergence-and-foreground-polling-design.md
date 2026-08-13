# 恢复记录收敛与前台轮询设计

## 背景

Android 已将当前 DIRECT_REPLY 安全写入云端，但其 recovery journal 同时携带了一条已经存在于 PC canonical 数据库中的用户消息。两侧的消息 ID、正文、时间、角色、收件人与 owner turn 相同，差异仅是 Android 可见历史投影使用 `<peer>:visible` 和 journal sequence，而 PC 保留 canonical device identity。现有兼容判断只接受 `turn_legacy_<messageId>` 形态，导致合法 canonical-visible 重放被误判为 `message checksum conflict`，并阻塞同一云包中的新消息。

## 目标

- 让现有云端滞留消息通过正常 poll、reconcile、dispatch 和 ACK 链路完成，不手工删除、伪造或 ACK。
- 将 recovery 的等价判断统一为明确的闭集，而不是继续添加宽松特例。
- 将 Android 前台恢复扫描从 60 秒调整为 15 秒。
- 90 秒是普通聊天的体验目标，不是模型或桥接层的强制中断线；复杂回复允许偶尔超过。
- 保持 v0/v1/v2、旧 fallback、旧 legacy-visible journal 与 v3 canonical 数据兼容。

## Recovery 等价规则

现有数据库消息 checksum 精确相同则保持原逻辑。checksum 不同时，仅对 user/phone recovery 尝试以下两种兼容投影：

1. 已部署的 legacy-visible alias：`turn_legacy_<messageId>`、`<peer>:visible`、journal sequence。
2. canonical-visible echo：`turnId` 精确等于已存在消息 owner turn，`<peer>:visible`、journal sequence。

两种投影都必须满足：

- Android payload 为已冻结的十一字段闭集；entry identity、visible device identity 与 journal sequence 精确一致。
- messageId、characterId、speaker、recipient、content、sentAt、origin 与 PC 行逐字段相同。
- PC owner 为同一 peer 的 protocol-v3、result-authority-v1 canonical turn。
- owner 的 character、device、sourceMessageId 与消息身份相符。
- canonical-visible echo 的 turnId 必须等于 owner turn；legacy alias 继续满足原有 legacy/canonical 关系。

命中时视为已导入，不修改 canonical message 行，只允许 recovery cursor 随整批成功推进。任何字段变化、foreign peer、foreign owner、错误 sequence、character projection 或未知形态继续 fail-closed 且零覆盖。

## 延迟规则

- `AlBackgroundPolicy.FOREGROUND_SCAN_SECONDS` 从 60 改为 15，并由单元测试冻结。
- 仅改变前台服务的恢复/云收件扫描频率；Android 系统杀进程后的 15 分钟 WorkManager 兜底不在本次改动范围。
- 不将 90 秒写成 turn deadline，也不缩短 cognition hard deadline。观测与验收按“普通聊天尽量 90 秒内，复杂回复允许超出”解释。

## 验收

- 用真实故障形态复现：canonical owner、相同 canonical turnId、visible device identity、journal sequence；修复前红灯，修复后 cursor 前进且消息行不变。
- legacy-visible alias 原正例保持通过。
- 两类投影对正文、时间、角色、收件人、peer、turn、owner authority、sequence 的变异全部拒绝，cursor 不前进。
- 当前云端 relay 消息无需用户重发，正常进入 PC turn 表并最终从 phone-to-PC 队列 ACK 移除。
- Android policy 测试断言 15 秒；相关 JVM 测试与 Android 测试 APK 构建通过。

