# v3 引用消息传输兼容设计

## 问题

已发布的 Android/Web 发送端会在普通消息中写入 `quote: null`，并在真实引用时发送 UI 展示快照。PC 的 v3 协议只接受规范引用对象，因此消息会在云端被反复轮询，却永远无法通过入站校验和 ACK。

## 目标

- 不删除、不手工 ACK 当前云端消息；修复后由正常接收流程处理。
- 已部署客户端的 `quote: null` 按“没有引用”兼容。
- 已部署客户端的旧 UI 引用快照严格投影为规范 v3 引用。
- 新发送端没有引用时完全省略 `quote`；有引用时只发送规范闭集。
- 数组、未知字段、错误角色、外部角色 ID 等畸形引用继续拒绝。

## 规范边界

规范 v3 引用只有四个字段：

```json
{
  "messageId": "msg_...",
  "speakerId": "角色 ID 或 user",
  "speakerType": "character 或 user",
  "text": "被引用正文"
}
```

兼容输入仅增加两种精确形态：

1. `quote: null`：归一化时删除，等价于未提供字段。
2. 旧 UI 快照：精确六字段 `messageId/speakerId/speakerType/speakerName/contentType/content`，其中 `speakerType` 必须为 `assistant`、`speakerId` 必须为当前角色；归一化为 `character/text` 四字段。

兼容逻辑只存在于入站归一化边界，持久化和后续认知管线只看规范形态。

## 验收

- 真实坏包形态通过并删除空引用字段。
- 旧真实引用形态投影正确。
- Web 首次发送与重试使用同一投影函数。
- 聚焦测试、基础 UI 合同和完整项目测试通过。
- 重启 PC 服务后，现有云端消息通过正常流程被 ACK，队列不再停留于“等待电脑接收”。
