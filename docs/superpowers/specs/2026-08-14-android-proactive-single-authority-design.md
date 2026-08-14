# Android 主动任务单一权威设计

## 1. 背景与结论

当前主动私聊和主动朋友圈并不是由一个组件管理。Web、Android、Service Worker 和云端 Worker 都能保存或改排同一条逻辑任务；云端 D1 以 `logical_key` 唯一、`INSERT OR REPLACE` 最后写入者获胜。与此同时，Web 每分钟把本地任务镜像回 Android，Android 在一次主动任务完成后也会生成下一任务。这会形成旧任务重新授权、新旧任务互相覆盖、时间反复变化而没有可见消息的反馈环。

本设计用一个明确的不变量替换现状：

> 在 Android 原生模式下，每个 `{deviceId, characterId, kind}` 主动任务流只有 Android Room 是调度权威；Web 只能提交配置或显示权威状态，Cloudflare 只能按代数条件保存和投递，Service Worker 不能改排该任务流。

`kind` 的闭集为 `chat | moment`。角色安排、手动测试闹钟和生命周期控制不进入本次主动任务流。

本设计取代 `2026-08-14-proactive-deadline-stability-design.md` 中“Web 负责在普通回复落地后生成下一任务”的实现前提。旧文档的产品规则——没有新事件时 `jobId` 和 `dueAt` 必须稳定——继续有效。

## 2. 观察到的两个独立问题

### 2.1 状态栏的假变化

Web 前台每 60 秒检查一次到期任务。即使没有任务，它也会持久化“前台检查完成”和新的 `Date.now()`，再重绘整个云闹钟状态块。FCM 事件还会触发立即、2.5 秒后和 10 秒后的状态同步。当前状态块混合展示计划时间、投递重试、前台检查、Worker 状态和 API 健康，因此“状态在变”并不等于“任务被改排”。

### 2.2 任务本身的真变化

Android 完成任务 A 后生成 B；Web 收到同一完成事件后又生成 C；Web 随后的前台检查还可能把自己保存的旧 A 写回 Android。云端没有 owner、authority epoch、generation 或 expected-current CAS，只能让最后写入者覆盖前者。`skip` 和 `action_only` 尤其危险：Android 已生成 B，而 Web 没有按普通可见结果的路径清除 A，于是旧 A 会在租约到期后再次执行。

此外还存在三条真实竞态：旧云任务的迟到重试可覆盖新任务；进程可能死在多步保存中间而重新抽签；整份 `app_state` 镜像可用旧 `pendingProactiveJob` 覆盖新值。

## 3. 备选方案

### 3.1 方案 A：Android Room 为原生模式唯一权威（采用）

Android 持久化任务流的 epoch、generation、当前 job、来源事件和云同步 outbox。Web 只提交设置，显示原生投影；云端只接受合法的下一代或完全相同的幂等重放。

优点：手机关掉 WebView 后仍能恢复；Room、AlarmManager、WorkManager 和 FCM 可在一个所有者下闭合；最符合产品主要面向 Android 的事实。缺点：需要一次 Room 和 D1 迁移，并重接 Web 状态来源。

### 3.2 方案 B：Cloudflare Worker 为唯一权威（不采用）

所有客户端只提交“已发生某事件”，由云端计算下一次时间。

优点：跨设备天然统一。缺点：离线时无法决定或恢复本地 Alarm；需要把大量角色策略放到云端；网络不确定性会直接影响本地调度。

### 3.3 方案 C：保留 Web/Android 多写者，仅增加锁（不采用）

为现有写入增加短租约或防抖。

优点：改动较小。缺点：锁只能减少同时写，不能决定冲突时谁正确；重启、迟到重试、旧镜像和 `skip` 仍会造成语义分叉。这正是此前局部修补反复失效的原因。

## 4. 权威数据模型

### 4.1 Room v16：`automatic_schedule_authorities`

每个 `{characterId, kind}` 恰好一行。设备 ID 来自应用的 store-owned 设备身份，不由调用方覆盖。

必需字段：

- `streamKey`：`{deviceId}:{characterId}:{kind}` 的规范化哈希，主键；
- `authorityEpoch`：安装迁移时生成并持久化的 128-bit 随机标识；
- `generation`：非负单调整数；
- `owner`：原生模式固定为 `android-v1`；
- `state`：`disabled | paused_for_conversation | scheduled | claimed | terminal_pending_next`；
- `activeJobId`、`dueAt`、`mode` 和闭合的任务 payload；
- `sourceType`：`bootstrap | settings_change | direct_input | direct_terminal | proactive_terminal | failure_retry | lifecycle`；
- `sourceId`、`sourceChecksum`：使同一终态重放可精确幂等；
- `conversationSequence`：阻止较早的直接回复覆盖较新的用户输入；
- `terminalDisposition`：若来源是执行结果，闭集为 `visible | action_only | skip | failed`；
- `policyRevision` 与 `policyChecksum`；
- `cloudSyncState`：`waiting | pending | synced | quarantined`；
- `createdAt`、`updatedAt`。

行的规范化 checksum 覆盖全部调度语义字段，但明确不覆盖 `cloudSyncState`、云 lease、诊断时间和普通更新时间；网络同步状态变化不能改变 schedule checksum。

### 4.2 Room v16：`automatic_schedule_outbox`

一次 generation 对应一条不可变 outbox 记录。它与 authority 行在同一个 Room 事务写入。

字段包括 `streamKey`、`authorityEpoch`、`generation`、`operation`、`jobId`、`expectedPreviousJobId`、规范 payload/checksum、状态、lease attempt/id/time、最后错误和更新时间。`operation` 的闭集为 `schedule | pause | disable`；pause/disable 没有活动 job，但仍会提升 generation 并同步云端。只有持有精确 lease 的 sender 可以 POST 或完成。重启只回收已过期 lease。

同一 stream 的 outbox 必须严格按 generation 升序发送；低 generation 未同步或未被明确合并前，高 generation 不得领取 lease。这样“用户输入先 pause、终态随后 schedule”的两个转换不会因网络线程重排而被云端误判为跳代。不同 stream 可以并行。

云端成功不是任务生成的提交点；Room 事务才是提交点。网络只是同步该已提交事实，不得重新生成时间或 job ID。

### 4.3 Room v16：`automatic_schedule_events`

保存不含聊天正文的元数据审计：事件类型、stream、epoch、generation、旧/新 job ID、旧/新 dueAt、sourceType、结果和时间。保留最近 500 条或 14 天，用于确认“是谁改了时间”。

### 4.4 D1 迁移

自动私聊/朋友圈不再把 `timer_jobs` 当作权威。新增 `timer_stream_authorities`，每个 logical stream 永久保留一行，字段包括 owner、epoch、generation、状态、可空的活动 job ID/dueAt/payload、expected previous job、checksum、投递状态和更新时间。`paused` 或 `disabled` 也保留该行与 epoch，因此删除当前任务不会让旧客户端重新获得“首次写入”资格。

旧 `timer_jobs` 继续承载手动测试和角色安排任务，避免把不同生命周期强塞进同一状态机。迁移时，现有 automatic row 只作为首次 owner claim 的候选，不直接获得新 epoch。

新增 `timer_job_events`，只记录调度元数据，不记录聊天正文。由 SQLite `AFTER INSERT/UPDATE` trigger 跟随权威行转换写入，使成功转换与审计同一原子提交；被拒绝的旧写请求可另写 metadata-only rejection event，但拒绝日志不参与正确性。

新增 `/v2/schedule-transitions`，D1 用单条条件 UPSERT 实现原子规则；旧 `/schedule` 只在尚无 owner claim 的 legacy stream 上兼容：

1. 当前不存在权威行：只接受合法 bootstrap/owner claim；
2. 当前 epoch 与请求不同：拒绝 `SCHEDULE_AUTHORITY_CONFLICT`；
3. 同 generation：只有 operation、job ID 与 checksum 全相等才幂等成功；
4. 下一 generation：必须恰为 `current + 1`，且 `expectedPreviousJobId` 等于当前可空活动 job ID；
5. `pause/disable` 清空活动 job/dueAt/payload，但保留 owner、epoch 和新 generation；
6. 跳代、旧代、同代异内容全部 409，零修改；
7. 投递 defer/ACK 只能 `WHERE logical_key + authority_epoch + generation + active_job_id` 命中当前行，迟到旧任务只能记录 stale event，不能恢复为活动任务。

完整 authority epoch 只保存在 Android 原生存储和 D1，不返回给 Web；Web 状态页最多看到短指纹。首次 owner claim 仅允许已注册的 device/push target，后续请求必须证明同一 epoch。owner rotation 必须证明旧 epoch 或经过显式设备重新绑定，不能由只知道 deviceId 的请求完成。

## 5. 唯一状态转换 API

Android 只暴露一个 store-owned `transitionAutomaticSchedule()`。所有调用方传入闭合事件，store 在事务内加载当前 authority、验证来源、决定幂等或下一代、持久化 authority/outbox/event。任何调用方不得直接 upsert stable `CharacterSnapshotEntity` 作为调度事实。暂停或关闭同样是正式 generation 转换，不允许通过删除行表达。

任务时间随机计算必须可重放：随机种子来自 `authorityEpoch + streamKey + sourceChecksum + policyRevision`。因此同一来源事件在重启后得到相同 dueAt。显式 `SCHEDULE` 使用模型给出的合法时间；无显式时间时才用该确定性抽样。

job ID 由 `authorityEpoch + streamKey + generation + scheduleChecksum` 确定性派生，不使用当前时间。

### 5.1 启用、首次安装与设置变化

- Web 调用原生 `configureAutomaticSchedule`，只传闭合策略，不生成 job ID、不 POST 云端；
- Android 计算 bootstrap 时间并提交 generation 1；
- 设置真实变化以 `policyChecksum` 为依据生成下一代；相同设置重放为 no-op；
- 关闭云闹钟写 `disabled` 下一代，取消当前 Alarm/Work，并同步云端撤销；
- 打开设置页、前台检查、应用启动不是状态转换来源。

手动测试使用单独的 `cloudTimerTestJob`/D1 test key，不得借用或覆盖角色的 `pendingProactiveJob`、Room authority 或 generation。

### 5.2 用户发出普通消息

Android 接受 DIRECT_REPLY turn 的同一事务将对应 chat stream 置为 `paused_for_conversation`，同时写入一条 `pause` outbox，使即将到期的本地和云端任务都不能与用户聊天碰撞。它记录最新 conversation sequence。较早的旧回复随后到达时，不得覆盖更高 sequence。

直接回复终态落地后，由 Android 从已持久结果与策略生成唯一下一代。若执行明确失败，使用闭合的 failure retry 策略生成一次下一尝试；如果还有更新的用户输入，则较旧终态只完成聊天，不改变调度。

### 5.3 主动任务被领取

Alarm、WorkManager 和 FCM 输入必须同时携带 `authorityEpoch + generation + jobId`。Room 只允许当前 `scheduled` 行原子变为 `claimed`。重复入口返回相同 claim；旧 epoch、旧 generation 和旧 job 只做删除安全的 stale ACK，不创建 turn、消息、诊断或新任务。

### 5.4 执行终态

`visible`、`action_only`、`skip` 和 `failed` 全部经过同一个 terminal finalizer：

1. 验证来源 job/epoch/generation 正是已 claimed 当前代；
2. 以 turn/result checksum 做幂等键；
3. 在一个事务中提交唯一下一代 authority、outbox 和 event；
4. 事务后按 authority 投影设置新 Alarm/Work；
5. 旧 Alarm/Work 尽力取消，但即使取消失败也会被 generation gate 拒绝。

Web 不再根据 terminal disposition 删除、生成或补排任务。这样 `skip` 和 `action_only` 不再与可见结果走不同调度路径。

### 5.5 清空聊天、删除角色和导入备份

- 清空聊天在生命周期控制应用后提升 schedule epoch，写入 pause/新 bootstrap 转换，旧 job 永久失效；是否重新 bootstrap 由当前开关和当前策略决定；
- role delete tombstone 使该角色所有 stream 以 `disable` 转换进入 `disabled`，旧 FCM 仅 stale ACK；
- Web/MemoryDB 备份和旧 `app_state` 中的 `pendingProactiveJob` 永远不能恢复 Room authority；
- 导入设置只能作为新 configure intent，不能携带 authority epoch、generation 或 job ID。

## 6. Web 与 Service Worker 边界

### 6.1 Android 原生模式

Web 必须移除以下写权限：

- 不再从 `ensureCloudProactiveKindScheduled()` 生成或 POST 下一任务；
- 不再由 `executionCompleted`、轮询结果、`skip` 或 `action_only` 改排；
- 不再每分钟调用 `saveProactiveSnapshot` 把本地 job 写回 Room；
- `pendingProactiveJob/pendingMomentJob` 只在迁移期间作为旧只读数据，原生 authority 建立后删除；
- `app_state` 镜像和备份恢复过滤这些旧字段；
- 前台轮询只调用 `getAutomaticScheduleStatus`，不得持久化“无变化检查完成”。

Service Worker 在 native owner 下只负责缓存/页面唤醒，不能 POST `/schedule`。任何旧 SW 的无 epoch 写入会由 D1 409 拒绝。

### 6.2 纯 Web 模式

纯 Web 模式可使用 owner `web-v1`，但仍必须经过相同 epoch/generation/CAS 协议。一个 stream 不能同时存在 `android-v1` 和 `web-v1`。owner 转移是显式控制操作，不由页面打开、FCM 注册或网络状态自动推断。

## 7. 状态界面

界面把事实分开显示：

- `计划时间`：来自 Room authority（原生）或 D1 active row（纯 Web）；
- `任务代数`：epoch 的短指纹、generation、job ID；
- `最近真实变更`：来源与时间；
- `云同步`：waiting/pending/synced/quarantined；
- `最近检查`：仅内存显示，不写 DB、不触发整页状态镜像；
- `投递重试`：与计划时间分行，绝不能覆盖“最近私聊/朋友圈”。

如果 Room、D1 和当前 Alarm 投影不同，界面显示明确的“同步中/冲突”，不能选择其中一个时间冒充成功。

## 8. 崩溃、并发与恢复

1. **Room 写后、云 POST 前崩溃**：outbox 重启续传相同 generation/job/dueAt；
2. **云已接受、响应丢失**：相同请求幂等成功，不重新抽签；
3. **旧请求迟到**：D1 generation/CAS 拒绝，不能覆盖；
4. **两个 sender 并发**：Room lease 只允许一个未过期持有者；跨崩溃允许相同幂等请求再次 HTTP，但云端只产生一个状态转换；
5. **Alarm 与 FCM 同时到达**：Room claim CAS 只创建一个 turn；
6. **event 与 Web 轮询同时到达**：Web 都只读，不产生第二个下一任务；
7. **较早直接回复迟到**：conversation sequence 阻止其重新锚定；
8. **角色删除/清空与投递竞态**：epoch/tombstone 在 claim、turn submit、terminal finalizer 和通知前都复核；
9. **全量镜像乱序**：镜像不再包含调度 authority，无法覆盖任务。

## 9. 升级与旧任务退役

部署顺序：

1. 先部署向后兼容的 D1 schema/Worker：尚未 claim 的 legacy stream 仍接受旧请求；
2. 新 APK 将 Room v15 升为 v16，建立 authority/outbox/event 表；
3. 首次启动读取旧 Room stable snapshot 与 Web 旧 pending job，仅选择一个仍未来且 identity 完整的候选作为 migration input；
4. Android 生成新的 authority epoch，以 `migration_claim` 建立 generation 1 并原子 claim 云端；
5. claim 成功后删除 Web 旧 pending 字段，取消所有非当前 job 的 Alarm/Work；
6. 此后该 stream 的无 owner/无 epoch 旧写入永久 409。

若旧三份状态互相冲突，不猜测最晚写入者：选择 D1 当前任务仅作为候选，在 Room 中建立一条明确 migration event，并向用户显示一次“已收敛到 X”；若候选已过期，则生成新的 bootstrap，而不是执行过期任务。

Web 无法被 Android 直接读取的旧 localStorage 任务只能作为不可信 migration candidate 通过插件传入；Android 必须将它与 device/character/kind、D1 当前任务和未来时间共同验证，不能接受其中的 job ID 作为新权威 ID。

首次迁移必须取消并重新创建当前候选对应的 Alarm/Work，即使 job ID 恰好相同；旧 PendingIntent/Work 输入没有 epoch/generation，升级后必须 fail-closed。所有非当前旧 job 的 Alarm/Work 同时取消。

如果应用数据被清除或设备备份恢复导致旧 epoch 丢失，普通 `/schedule` 或 transition 请求不能夺回同一 stream。必须通过显式的云闹钟重新绑定/owner-rotation 控制验证当前设备身份后换 epoch，或生成新的 deviceId；该恢复过程写独立审计事件。

回滚到不懂 authority epoch 的旧 APK 需要先运行显式的管理端 owner-release 操作；不能自动放开旧写入，否则会重新引入多权威。

## 10. 错误合同

稳定错误码：

- `SCHEDULE_AUTHORITY_CONFLICT`：owner/epoch 不符；
- `SCHEDULE_GENERATION_CONFLICT`：旧代、跳代或 predecessor 不符；
- `SCHEDULE_CHECKSUM_CONFLICT`：同代异内容；
- `SCHEDULE_STALE_DELIVERY`：旧 job 的 claim/defer/ACK；
- `SCHEDULE_POLICY_CONFLICT`：策略 revision/checksum 不闭合；
- `SCHEDULE_OUTBOX_QUARANTINED`：本地持久事实损坏。

未知 SQLite、网络和编程错误不能伪装成上述冲突。权威冲突 fail-closed 并保留元数据事件；普通网络错误保留 outbox 重试。

## 11. 测试与验收

### 11.1 单元与迁移

- Room v15→v16 populated migration、fresh v16、故障回滚和重启；
- D1 legacy→authority migration和条件 UPSERT；
- generation、epoch、checksum、deterministic dueAt/job ID 冻结向量；
- Web 原生模式不得调用 schedule POST 或 save snapshot；
- 无任务到期的 60 秒检查不得写 localStorage、MemoryDB 或状态时间。

### 11.2 跨层 TDD 门

必须新增一份真实的跨组件 harness，而不是分别 mock 成功：

1. Android 完成一次 proactive turn，同时触发 Web event 与 Web poll，最终只存在一个下一 generation；
2. `visible/action_only/skip/failed` 各自只生成一次下一任务；
3. Web 持有旧 A、Android 已生成 B 时，Web 检查后 Room/D1 仍为 B；
4. D1 在 B 生效后收到 A 的 defer/retry，B 完全不变；
5. Alarm 与 FCM 同时领取只创建一个 turn；
6. 云接受后响应丢失，重启仍重放同一 job ID/dueAt；
7. 用户连续发送两条，较早回复迟到时不能覆盖较新 conversation sequence；
8. clear、role delete、关闭闹钟后旧 job 不能复活；
9. 旧 app_state、聊天备份和 Service Worker 无 epoch 写入不能覆盖 native authority；
10. 页面状态频繁刷新时计划时间、generation 和 job ID不变。

### 11.3 设备发布硬门

- 真机 v15→v16 migration；
- 前台、后台、杀进程、重启、断网恢复、Wi-Fi/移动网络切换；
- FCM 与本地 Alarm 双到达；
- 至少 2 小时加速 soak（缩短间隔模拟 100 次转换）和 24 小时真实 idle soak；
- 24 小时无聊天且任务未到期时，generation/jobId/dueAt 必须完全不变；
- 到期后 90 秒目标内进入执行；偶发网络重试可以超过 90 秒，但不得改写原计划时间；
- 每个到期任务最终必须落入 visible/action_only/skip/failed 之一，并恰好产生一条下一代或 disabled。

## 12. 非目标

- 不改变模型如何决定是否主动说话；
- 不强制含糊时间变成固定文案，仍允许虞栖推断“明早/待会”的具体时刻；
- 不重写角色安排 recurrence；
- 不把聊天正文上传到调度审计；
- 不用更频繁轮询掩盖权威冲突。

## 13. 完成定义

只有同时满足以下条件才算修复完成：

1. 原生模式下代码搜索证明只有 Room transition API 能产生下一 generation；
2. Web、SW、云重试均无法无条件替换当前任务；
3. Room、D1、Alarm/Work 和 UI 投影在重启后收敛到同一 epoch/generation/job；
4. `skip/action_only/visible/failed` 共用终态调度路径；
5. 状态栏无任务变化时不持久化新时间；
6. 跨层、迁移、故障注入、完整项目测试和真机硬门全部通过；
7. 发布包升级后旧调度路径被 epoch 拒绝，且有可读的 writer/generation 审计证据。
