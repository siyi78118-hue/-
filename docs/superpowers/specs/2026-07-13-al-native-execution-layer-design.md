# AL 原生常驻执行层重写设计

## 目标

彻底替换目前由 WebView、Background Runner、WorkManager 快照和前端 `pendingReply` 共同驱动的回复执行链路。新版本必须在锁屏、按 Home、切换应用、从最近任务划掉、系统回收进程和手机重启后继续处理玩家回复与主动任务，同时消除“回复已经存在但原消息仍显示未收到回复”“旧任务瞬间失败”“永久正在输入”和回复到达瞬间闪退等状态错位。

系统设置中的“强行停止”是唯一明确不保证恢复的边界。

## 已确认的交互规则

- 每次点击发送就是一个完整、独立的玩家回合。
- 不合并连续玩家消息，不增加等待窗口，也不让模型判断玩家是否说完。
- 一个玩家气泡对应一个稳定的 `turnId`。
- 重新发送复用原气泡和 `turnId`，但必须创建新的 `attemptId` 并真实重新经过记忆 AI 与聊天 AI。
- 最近 30 条可见原文、完整 RP 规则、当前角色及阶段人设始终发送给聊天 AI。
- 记忆 AI 每轮先筛选本地记忆；筛选失败可降级为空记忆包，但必须保留诊断，不能伪装成功。

## 当前根因

1. WebView 的 `pendingReply`、用户消息 `replyState`、Background Runner 的 `state_json`、独立任务队列和最终 assistant 消息分别存储并按时间戳合并，没有一个真正的权威状态源。
2. 手动重试复用固定任务名 `reply_<messageId>`，旧 WorkManager 仍处于运行或收尾阶段时，`ExistingWorkPolicy.KEEP` 可忽略新工作；页面却已先改成待回复，随后又可能读回旧失败结果。
3. Background Runner 是临时 JavaScript 运行环境。记忆请求、聊天请求、通知和排程串联在一次 Worker 中，锁屏或进程回收会使工作中断。
4. 当前后台同步依赖完整 `state_json` 快照；WebView、本地存储和原生 SharedPreferences 之间可互相覆盖更新。
5. WebView 承担模型请求、大对象序列化、完整聊天重绘和头像解码，回复到达时容易造成主线程拥塞或渲染器崩溃。
6. 前端用固定时间推断后台超时，而不是读取真实任务阶段，造成“通知失败、界面仍正在输入”或“回复已到、气泡仍失败”。

## 方案选择

### 采用：原生常驻执行器

使用 Android 前台服务、Room 数据库、原生 HTTP 客户端、WorkManager、FCM 和开机恢复组成单一执行层。API Key、记忆和提示词保留在手机。

### 不采用：仅任务期间启动服务

通知更少，但部分 Android 厂商会在锁屏后阻止后台重新启动，无法满足用户要求的可靠性。

### 不采用：云端直接生成

可靠性高，但需要上传 API Key、完整提示词和记忆，违背本地记忆与隐私方向。

## Android 常驻服务

- 新增 `AlExecutionService`，返回 `START_STICKY`，使用低优先级常驻通知“AL 后台守护已开启”。
- Android 14 及以上声明 `specialUse` 前台服务类型，并在 Manifest 的 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 中明确说明“本地 AI 聊天任务执行与消息通知”。
- 不使用 `dataSync` 作为 24 小时常驻类型；Android 15 对 `dataSync` 和 `mediaProcessing` 设有每 24 小时累计 6 小时限制。
- 服务空闲时不持有 WakeLock。只在任务实际运行期间短时保持 CPU，并在 `finally` 中释放。
- 用户在应用前台启用守护时启动服务。`START_STICKY` 负责普通进程回收后的重建；开机接收器、WorkManager 和高优先级 FCM 作为补充唤醒路径。
- 收到 FCM 后先把任务事务性写入 Room，再请求执行服务；即使服务暂时不能启动，任务也不会丢失。
- 服务只在后台线程执行数据库、JSON 和网络操作，不阻塞 Android 主线程。

参考：

- Android 前台服务类型：<https://developer.android.com/develop/background-work/services/fgs/service-types>
- Android 15 前台服务时限：<https://developer.android.com/develop/background-work/services/fgs/timeout>
- `START_STICKY` 行为：<https://developer.android.com/reference/android/app/Service.html>

## 单一状态源

Room 是回合、尝试、回复结果、任务状态和后台记忆的唯一权威状态源。WebView 可以保留渲染缓存，但不得据此决定任务成功或失败。

### `ChatTurn`

- `turnId`
- `characterId`
- `sourceMessageId`
- `kind`: `DIRECT_REPLY | PROACTIVE_CHAT | PROACTIVE_MOMENT`
- `state`
- `activeAttemptId`
- `createdAt`、`updatedAt`、`completedAt`
- `cancelledAt`、`deletedAt`

### `ExecutionAttempt`

- `attemptId`
- `turnId`
- `sequence`
- `stage`
- `startedAt`、`heartbeatAt`、`finishedAt`
- `errorCode`、`errorDetail`
- `retryable`
- 本轮固定的角色、RP、最近 30 条和模型配置快照引用

### `ReplyPart`

- `replyPartId`
- `turnId`、`attemptId`
- `sequence`
- `type`: `TEXT | EMOJI | REDPACKET | TRANSFER`
- 已验证的内容与支付字段
- `createdAt`

### 记忆与角色

- 本地摘要、事件、资料、向量和时间信息迁移到原生记忆仓库。
- 角色、当前阶段人设和完整 RP 规则保存在原生可读仓库；每次任务创建时生成不可变快照。
- API Key 使用 Android Keystore 支持的加密存储，不以明文写入 Room，也不进入聊天备份和诊断导出。

## 状态机

正常状态：

```text
QUEUED
-> MEMORY_RUNNING
-> MEMORY_DONE
-> CHAT_RUNNING
-> CHAT_DONE
-> COMMITTED
-> NOTIFIED
-> COMPLETED
```

终止状态：

- `FAILED_RETRYABLE`: 网络不可用、429 或明确可安全重试的 5xx。
- `FAILED_FINAL`: 鉴权、无效地址、确定的响应格式错误。
- `INTERRUPTED`: 进程在结果是否产生未知的阶段死亡，等待玩家决定重试，禁止自动重复消耗 Token。
- `CANCELLED`: 玩家撤回或任务被明确取消，任何晚到结果都丢弃。

不变量：

1. 有有效 `ReplyPart` 的 Turn 不能显示失败或正在输入。
2. 只有 `activeAttemptId` 对应的 Attempt 可以提交结果。
3. 同一 `turnId + sequence` 只能存在一个 `ReplyPart`。
4. 旧 Attempt 的晚到结果不能覆盖当前 Attempt。
5. WebView 不得自行将运行中的 Turn 改成失败。

## 玩家发送流程

1. WebView 生成 `turnId` 和用户消息 ID，调用原生 `submitTurn`。
2. 原生事务保存用户消息、Turn、首个 Attempt、最近 30 条上下文快照和角色配置快照。
3. 原生确认落库后，WebView 才把气泡视为已发送；若确认前 WebView 崩溃，重启后从 Room 重建气泡。
4. 执行器调用记忆 AI，保存筛选结果和 `MEMORY_DONE`。
5. 执行器使用完整 RP 规则、阶段人设、最近 30 条和筛选记忆调用聊天 AI，采用非流式响应。
6. 模型返回后，原始结果和 `CHAT_DONE` 必须在同一事务落库；若随后崩溃，恢复时从该原始结果继续解析，禁止再次调用模型。
7. 原生验证并解析文字、Emoji、红包与转账，然后在一个事务中写入 ReplyPart 并把 Turn 标为 `COMMITTED`。
8. 后台时发送角色通知；WebView 前台通过插件事件和恢复查询增量渲染。
9. 记忆整理达到 30 条阈值时，另建低优先级记忆提取任务，不能阻塞本轮回复提交。

## 主动任务流程

- FCM 私聊与朋友圈分别创建独立 Turn，不能共享“最后一个主动任务”占位，也不能互相取消。
- 玩家回复任务优先级最高，主动私聊其次，朋友圈最后。
- 多种任务可以同时排队，但数据库提交串行化，避免覆盖聊天或朋友圈数据。
- Cloudflare 只负责计时、骰子和发送 FCM，不持有本地 API Key、记忆或完整提示词。
- 主动任务完成后 ACK 云端；排程失败不得把已经生成并提交的消息改成失败。

## 重试、撤回与删除

### 重试

- `retryTurn(turnId)` 在 Room 事务中创建新的 `attemptId`，增加 sequence，并设为 `activeAttemptId`。
- 原用户气泡不复制，旧错误保留在诊断历史但不继续显示为当前状态。
- 重试必须重新执行记忆筛选和聊天请求。
- 若 Turn 已有有效 ReplyPart，重试拒绝执行并直接返回完成状态。
- 连续点击由数据库唯一约束合并，不能启动两个当前 Attempt。

### 撤回

- 在 `CHAT_RUNNING` 前取消任务。
- 已进入聊天请求时把 Turn 标为 `CANCELLED`；不能撤回已经发往模型的网络数据，但晚到结果不得提交、不得进入以后上下文。

### 删除

- 删除状态同步写入原生仓库与 WebView 缓存。
- 删除的消息和回复不进入以后最近 30 条上下文。
- 删除没有对应回复的玩家消息时同步取消其 Turn。

## WebView 与闪退处理

- WebView 不再执行记忆 AI、聊天 AI、任务重试和整库后台快照。
- 回复以增量事件更新对应气泡，不在每个回复分片或状态变化时重建整个聊天 DOM。
- 头像与大图采用缓存和按需解码，聊天列表只渲染当前窗口所需内容。
- 模型返回值先在原生层验证；非法 JSON、异常 Emoji 或支付字段不能进入渲染链路。
- 更新检查与聊天执行完全解耦。聊天异常不能打开更新网页或自动下载 APK。
- 监听 `onRenderProcessGone`，记录渲染器崩溃并重建 Activity；重建后从 Room 恢复，不再次调用模型。
- Java 未处理异常、WebView 渲染器退出和任务阶段错误写入本地诊断；诊断导出必须移除 API Key、Authorization 和完整私密提示词。
- 同一 Attempt 连续发生 3 次可归因于本任务的执行器崩溃后停止自动恢复，标记 `FAILED_FINAL` 并提供原因和手动重试。

## 旧数据迁移

- 首次启动新执行层时，原生插件分批导入现有角色、聊天、朋友圈、设置和 IndexedDB 记忆。
- 迁移带 schema 版本、游标和幂等键；中途闪退后从游标继续。
- 已存在 `replyToMessageId` 回复的玩家消息自动清除旧 `replyState` 和 `replyError`。
- 旧 `pendingReply` 不自动重新调用模型，统一转成 `INTERRUPTED`，允许玩家手动重试。
- 迁移完成前保留旧数据只读副本；完成并校验数量后才切换读取来源。
- 聊天专用备份仍不包含 API 地址、Key 和设备设置；完整本机备份也不得导出 Keystore 私钥。

## 错误与重试策略

- 断网：保持排队，网络恢复后执行；DNS 或尚未建立连接的失败最多自动尝试 3 次，间隔 15、60、300 秒。
- 429 最多自动重试 2 次，间隔 30、120 秒。
- 仅 502、503、504 且响应明确没有模型内容时自动重试 1 次，间隔 30 秒。
- 401、403、无效地址和确定的响应格式错误：不自动重试。
- 空回复或解析错误：记录响应元数据和安全截断摘要，不盲目重复请求。
- 请求已经发出后的读取超时、连接重置或进程死亡，因无法确认服务器是否已经生成，标记 `INTERRUPTED`，避免重复 Token 消耗。
- 通知失败只记录通知阶段失败，不能回滚已经提交的聊天回复。

## 测试与验收

所有实现遵循 TDD，先写失败测试并确认失败原因，再写最小实现。

### 单元与集成测试

1. Room 状态机只允许合法迁移，并强制 Turn、Attempt 和 ReplyPart 唯一约束。
2. 重试创建新 Attempt，旧 Worker 或旧 Attempt 的晚到结果不能覆盖。
3. 有 ReplyPart 时 UI 派生状态始终为完成。
4. 玩家发送后在记忆、聊天、提交三个阶段分别模拟进程死亡并恢复。
5. 重复 FCM、重复 WorkManager、重复服务启动不生成重复回复。
6. 主动私聊和朋友圈同时到期时均保留并依次完成。
7. 撤回、删除、失败重试和支付结果保持幂等。
8. 旧数据迁移可重复执行且不复制消息。
9. 异常模型响应不会使 WebView 崩溃。
10. WebView 渲染器重建后不重复调用模型。

### 真机验收

1. 发送后立即锁屏，仍生成回复并通知。
2. 发送后按 Home、切换应用、划掉最近任务，仍生成回复。
3. 系统回收 AL 进程后，守护服务恢复并继续未完成任务。
4. 手机重启后守护恢复，排队任务不丢。
5. 回复落库后、UI 更新前杀死 Activity；重新进入后回复存在且原气泡无失败标记。
6. 旧版本失败消息点击重试，必须实际调用记忆 AI 和聊天 AI，不能瞬间返回旧失败。
7. 大量聊天、长提示词、Emoji、红包和转账下反复收发，不出现回复瞬间闪退。
8. 聊天执行异常不打开更新网站、不自动下载 APK。

## 非目标与边界

- 不绕过 Android 系统设置中的“强行停止”。
- 不承诺任何 Android 程序绝对零闪退；本设计要求移除当前高风险 WebView 工作，并保证可诊断、可恢复、不丢消息、不重复请求。
- 本轮不改变角色写作质量规则、最近 30 条要求、云端骰子概率或朋友圈业务语义。
- 本轮不恢复流式输出；后台可靠性优先。
