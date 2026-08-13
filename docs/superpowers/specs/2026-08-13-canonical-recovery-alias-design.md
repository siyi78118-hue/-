# Canonical 用户消息恢复别名兼容设计

## 问题

Android/Web 将一次已经按 v3 canonical turn 提交过的用户消息再次写入可见历史时，若网页气泡没有保存 `sourceTurnId`，`ingestVisibleMessages` 会把同一个 `messageId` 记为 `turn_legacy_<messageId>`。手机 recovery journal 随后持续携带这个旧身份投影；PC 已有同一消息的 canonical 行，因此每次 reconcile 都以 `message checksum conflict` 失败，新云消息无法进入执行管线。

## 目标与安全边界

- Web 在原生 DIRECT_REPLY 入队时立即把用户气泡绑定到 `native:<canonical turnId>`，持久化后供后续历史同步复用。
- PC 只兼容已经部署到手机中的精确九字段旧投影：同一用户 `messageId`、正文、时间、角色、收件人完全一致；手机 JSON 只能是 `characterId/content/messageId/origin/recipientId/sentAt/speakerId/speakerType/turnId`，其中 turn 为 `turn_legacy_<messageId>`，不得携带 `deviceId/deviceSeq`；PC 行必须由同一设备的 protocol-v3、authority-v1 canonical turn 持有。
- 命中精确旧投影时保留 PC canonical 行，不写第二条消息，并允许 recovery cursor 正常前进。
- 任意正文、时间、角色、收件人、消息 ID、设备或 canonical owner 不一致继续抛出 checksum/authority conflict，零覆盖。
- 不删除数据库消息、不手工 ACK 云消息、不降低通用 checksum 校验。

## 数据流

1. Web 创建确定性 `turnId` 后把 `userMessage.sourceTurnId` 写为 `native:<turnId>`，再持久化聊天状态。
2. 历史同步去掉 `native:` 前缀，Android journal 因而保留 canonical turn 身份。
3. 对已经持久化的旧 journal，PC reconcile 在调用 `putMessage` 前读取现有 message 与 owner turn。
4. 只有精确 legacy alias 满足全部闭合条件时视为已导入；否则继续走原 `putMessage` 的严格冲突逻辑。
5. 全批成功后照常推进 sync cursor，CloudRelayPump 再接收并 ACK 当前新 turn。

## 验收

- 真实形态 `turn_legacy_msg_*` 对已存在的同设备 canonical 用户消息只跳过一次并推进 cursor。
- 改正文、时间、角色、收件人、设备或 owner authority 的反例全部拒绝且不推进 cursor。
- Web 用户气泡在 native submit 前持久保存 canonical source turn。
- 当前云端消息经正常 poll/reconcile/dispatch 进入数据库并最终 ACK，不通过手工删队列完成。
