# 虞栖 Bridge 可选本地 API 设计

## 目标

虞栖专属 LAN/Cloud Bridge 已启用时，即使普通聊天 AI 和记忆 AI 没有配置，也必须能够提交并完成私聊、主动消息、朋友圈和安排表任务。

## 已确认的设计

- 虞栖 Bridge 是原生执行的主路径。
- `chat-v1` 和 `memory-v1` 只作为 Bridge 明确允许降级时的本地兜底，不是提交任务的前置条件。
- 前端同步原生 API 配置时，只保存类型受支持且字段完整的配置。
- 设置为空、字段不完整或类型不受原生兜底支持时，清除原生侧对应旧配置，不阻止任务提交。
- Bridge 不可用且本地兜底也没有配置时，由安卓执行层返回准确的 `Missing API configuration` 错误；前端不得提前误报“接口配置不完整”。

## 数据流

1. 手机前端同步可选的 `chat-v1`、`memory-v1` 配置。
2. 完整配置调用 `saveApiConfig`；不可用配置调用 `removeApiConfig`。
3. 任务照常进入安卓原生队列。
4. `ExecutionEngine` 检测到 Bridge 已启用后直接进入 `BridgeRouter`。
5. LAN/Cloud 成功时不读取任何普通 AI 配置。
6. 只有 Bridge 路由允许本地降级时，`NativeModelGateway` 才读取本地配置；不存在则返回准确错误。

## 验收

- 未配置普通 AI 时，前端不再抛出“聊天接口配置不完整”或“记忆接口配置不完整”。
- 非 OpenAI 类型也不会阻止虞栖 Bridge。
- 清空普通 AI 设置后，安卓不继续使用残留密钥。
- 现有 Bridge 优先、失败分类和本地兜底顺序保持不变。
- JavaScript 合约测试、安卓单元测试和 release APK 构建全部通过。
