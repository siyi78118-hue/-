# Android 云信箱队列收敛设计

## 问题

WebView 在原生 `submitTurn()` 返回前就显示“正在认真想”，但这时只证明消息写入手机
Room。`AlExecutionService` 使用单线程顺序执行，而 `BridgeClient.sendCloud()` 在同一线程
完成云端 enqueue 后继续长轮询结果。前一轮等待模型时，后一轮无法 enqueue，形成队头阻塞：
手机显示思考，云端和电脑却完全看不到新消息。

## 状态语义

- `LOCAL_QUEUED`：已写入手机 Room，尚未证明云端接收。界面显示“正在把消息送过去…”。
- `CLOUD_ACCEPTED`：relay enqueue 成功，持久化为 `BRIDGE_WAITING`，立即释放执行线程。
- `PC_ACCEPTED`：电脑端状态回传时更新诊断；只有此后才能显示模型思考阶段。
- `COMPLETED`：原生已持久化最终结果。
- `UI_APPLIED`：WebView 已确定性落地并 ack。

`LOCAL_QUEUED` 和 `CLOUD_ACCEPTED` 都不是失败，也不得触发内置聊天 AI 兜底。

## 执行模型

1. 云端 enqueue 使用既有 turn id 与 idempotency key。
2. enqueue 成功后抛出专用 `BridgeAcceptedException`，路由器不得继续 fallback。
3. 执行引擎捕获该信号，将 turn 从 `MEMORY_RUNNING` 原子改为 `BRIDGE_WAITING`，记录
   `CLOUD_ACCEPTED` 诊断，然后返回处理下一条 Room turn。
4. 现有独立 recovery scheduler 继续调用 `drainCloudInbox()`；终态结果到达后，
   `RoomBridgeMirror` 必须能直接把 `BRIDGE_WAITING` 的原 turn 完成，禁止另建 backfill turn。
5. 重启时 `BRIDGE_WAITING` 不重新 enqueue；relay 结果仍由 inbox 恢复。
6. 云端 enqueue 失败仍使用原有 retry/fallback 规则。

## 幂等与故障边界

- 相同 turn 的重复 enqueue 继续依赖现有确定性 `messageId`/`idempotencyKey` 去重。
- terminal inbox 必须先写 Room，再发 receipt/ack。
- `BRIDGE_WAITING` 不属于 runnable/retryable 状态，不占用唯一 drain 线程。
- 本补丁不增加执行线程数量，避免并发修改同一 turn。
- LAN 保持当前同步协议；本次修复针对已确认发生故障的云信箱路径。

## 验证

- cloud enqueue 后不发起结果长轮询，并返回 accepted 信号；
- accepted 信号不会触发 fallback；
- 引擎把 accepted turn 持久化为 `BRIDGE_WAITING` 后可继续处理下一 turn；
- inbox 可把 `BRIDGE_WAITING` 原 turn 原子完成；
- 重启不会把 waiting turn再次作为 runnable；
- WebView 在原生/云端未接收阶段不显示“正在认真想”。
