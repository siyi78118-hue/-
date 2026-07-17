# AL 后台唤醒、D1 云闹钟与安排表恢复设计

## 目标

把主动消息和角色安排从“应用进入前台才补跑”改为三层唤醒，并把容易耗尽的 Workers KV 任务存储迁移到 D1。角色安排必须能明确显示本地、云端和本期执行状态，且云推送、本地闹钟和前台补偿同时触发时只生成一次。

## 已确认的产品决定

- 后台保护不仅处理已经入队的回复，还要在后台周期扫描并补跑到期任务。
- 新云端任务和设备订阅迁移到 Cloudflare D1；KV 不再承担任务队列写入。
- FCM 到达后允许立即显示“正在生成角色消息”，生成完成后替换成正式通知。
- 不把 WebView 定时器或永久常驻线程当成可靠调度器。
- 保留聊天、角色、记忆、API 配置以及其他窗口已经提交的 1.06 基线功能。

## 唤醒架构

1. **即时路径：FCM**。Worker 到期后发送高优先级 data message。Android 立即记录原始/送达优先级、显示临时通知、把本期任务原子写入 Room，并提交 expedited WorkManager。前台服务仍可作为快速路径，但不能是唯一入口。
2. **本地到点备份：AlarmManager**。每个有效的私聊/朋友圈安排在 Android 保存下一次本地闹钟。具备精确闹钟权限时使用 `setExactAndAllowWhileIdle`；否则使用 `setAndAllowWhileIdle`，并明确显示“系统可能延迟”。闹钟只负责唤醒和入队，长任务交给 WorkManager/执行服务。
3. **常驻扫描与系统兜底**。后台保护前台服务存活时每 60 秒查询 Room 并补跑到期、待同步和中断的任务；另注册 15 分钟 WorkManager 周期任务，在服务被系统终止时兜底。启动时、应用更新后和设备重启后也运行同一协调器。这样保护服务正常时通常最多延迟约一分钟，15 分钟任务不是主要触发器。

三条路径使用同一个 `occurrenceId = planId + scheduledFor`。Room 对 occurrence 建唯一主键并原子 claim，因此重复 FCM、闹钟和扫描不会重复生成。

## D1 数据模型

- `timer_devices(device_id PRIMARY KEY, transport, target_json, background_ack, updated_at)`
- `timer_jobs(job_id PRIMARY KEY, logical_key UNIQUE, device_id, char_id, type, kind, plan_id, occurrence_id, source, due_at, payload_json, delivery_attempts, awaiting_ack, updated_at)`
- 对 `timer_jobs(due_at)` 和 `timer_jobs(device_id)` 建索引。

普通主动私聊/朋友圈的 `logical_key` 维持“设备 + 角色 + 类型”单例；安排表按“设备 + planId”单例。写入相同任务是幂等的，新一代任务事务性替换旧一代。Cron 直接查询 `due_at <= now`，不再维护 `job:`、`due:`、`active:` 三套 KV 键。

部署先创建并迁移 D1，再部署带 `AL_TIMER_DB` binding 的 Worker。旧 KV binding 暂时保留一个版本仅用于兼容检查，不接受新任务写入；确认新版本健康后可移除。

## 安排表状态

`role_plans` 增加云同步状态和错误信息；新增 `role_plan_occurrences`：

- 状态：`PENDING`、`CLAIMED`、`RUNNING`、`COMPLETED`、`FAILED`、`CANCELLED`
- 云同步：`PENDING`、`SYNCED`、`FAILED`
- 时间：`scheduledFor`、`claimedAt`、`completedAt`、`updatedAt`
- 唯一键：`occurrenceId`

安排表页面显示：下一次时间、云端状态、本地备份状态、最近一次结果、原计划时间与实际执行时间。保存操作必须等待本地持久化完成；云端失败时显示“本地已保存，云端待重试”，不能显示“云端已确认”。

前台和后台协调器均执行：恢复中断回复 → 同步待同步计划 → claim 到期 occurrence → 执行 → 先持久化结果 → 安排下一期。确定性的 400/401/403/模型不可用错误暂停本期并等待用户重试；网络、408、429、5xx 使用有上限退避。

## 时间语义

AI 提示同时包含 `scheduledFor` 和 `executedAt`。消息在中午补发时不能把原本 9 点的事件伪装成 12 点计划，也不能声称自己在 9 点准时发送；角色应根据“原计划时间 + 实际延迟”自然生成。

## 可观测性与验收

- 记录 FCM original/delivered priority、临时通知、FGS 启动结果、expedited/periodic worker、闹钟触发、occurrence claim、D1 同步和生成结果。
- 保留有界诊断，不记录聊天全文、API key 或完整提示词。
- 自动测试覆盖 D1 幂等/替换/到期/确认/清理、Android occurrence 去重、周期扫描、expedited fallback、安排表同步状态和过期补跑。
- 最终验证 JS、Worker、Android 单元测试、lint、D1 远端迁移、Worker 健康检查与 Android 更新包。
