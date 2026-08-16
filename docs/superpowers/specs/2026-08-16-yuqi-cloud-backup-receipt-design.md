# 虞栖远程备份凭证设计

## 问题

Android 1.0.122 的“一次性完整恢复”在写入恢复数据前，会为已确认删除的角色
`char_1783694247588_zojx` 请求一张 PC 持久化的备份凭证。现有
`BridgeClient.requestVerifiedBackup()` 只调用局域网
`POST /v3/backups/yuqi`。手机和电脑不在同一局域网时会抛出
`bridge network is temporarily unavailable`，恢复事务停在 prepared 状态。

## 选择

复用现有端到端加密 Cloud Relay 的 request/response 交换，不公开 PC HTTP 服务，
也不降低 backup-first 删除约束。局域网仍是首选快速路径；只有可重试的局域网传输失败
才切换云通道。字段校验、PC 备份生成、`backup_receipt` 审计和 Android receipt 校验
与局域网路径共用同一实现。

## 数据流

1. Android 构造并闭合校验现有 `YUQI_BACKUP_REQUEST`，生成稳定 relay message id 和
   idempotency key，将 AES-256-GCM 密文放入 `phone_to_pc` 队列。
2. PC `CloudRelayPump` 在解密后优先识别 backup request，调用与 LAN endpoint 相同的
   `createVerifiedYuqiBackup()`，得到已持久化的闭合 receipt。
3. PC 用现有 `ack-with-response` 原子确认请求并投递加密的
   `YUQI_BACKUP_RECEIPT`。重复请求返回同一 receipt，不重复创建备份。
4. Android 在有界等待期间轮询 `pc_to_phone`。只接受 request checksum、roleId、peerId、
   requestedAt 和 receipt 全部一致的响应；成功后 ACK relay，再继续现有本地恢复事务。
5. 等待超时保持事务 prepared、语义存储零写，UI 显示“已交给电脑处理，可稍后重试”，
   不再显示误导性的局域网英文错误。

## 安全与兼容

- 云外层只承载密文，Worker 不读取备份内容。
- 不接受 caller 提供的 receipt，不允许本地伪造成功。
- v1/v2 聊天、现有 v3 turn、conversation-clear 和 role-delete 消息不改 wire 形状。
- pending 请求重放必须幂等；伪造、foreign peer、changed checksum 和未知字段均不 ACK。
- 局域网可用时保持原有同步行为和响应内容。

## 验收

- 手机在蜂窝网络、电脑仅连接云中继时能取得真实 receipt 并完成完整恢复。
- 局域网故障后云请求、PC receipt、手机 ACK 的顺序有自动化测试。
- 超时、重复、伪造、电脑离线和两条消费路径竞争均不产生半恢复或误删除。

