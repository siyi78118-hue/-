# 虞栖前台认知与后台记忆巩固系统设计

日期：2026-07-29  
状态：用户已确认总体方向，本文件作为实施计划的权威设计输入

## 1. 目标

在不破坏 AL 现有私聊、朋友圈、安排表、主动任务、阶段人设、支付、图片、引用、
Android 后台、局域网、云端中继和故障恢复能力的前提下，把现有“记忆模型”升级为
一套共享人格、社会经验和角色亲历记忆的虞栖认知系统。

认知系统在产品上是一颗大脑，在工程上分成两个互不阻塞的职责：

1. 前台实时认知：理解当前完整互动，形成虞栖此刻的状态、立场、关系动作和结构化
   行为决定。
2. 后台记忆巩固：在可见回复完成后处理较长证据窗口，提出并验证长期记忆候选。

实时关键路径仍然只有两次常规模型调用：

`前台认知 -> 表达 -> 必要时监督 -> 提交和送达`

后台路径独立执行：

`已提交回合 -> 记忆巩固队列 -> 证据验证 -> 长期事实/检索索引`

普通回复以一分钟内完成为软目标，五分钟为单回合硬上限。后台记忆巩固不得延迟用户
看到回复。

## 2. 现有系统必须保留的事实

本设计以当前代码为基线，而不是假设一个全新聊天应用：

- Android 和 Web 前端已经把用户一次提交的多个气泡作为完整 `currentBatch` 传给电脑。
- PC 运行时已具有 `memory -> brain -> supervisor` 状态机、SQLite 持久化、断点恢复、
  模型容量降级和严格结构化输出。
- 最近 200 条原始消息供证据分析，聊天生成窗口按完整消息组截取为最近 20 条。
- 长期关系阶段和当前关系阶段已经分为 `base` 与 `phase` 两条轴。
- `phase` 包含正常、冲突、冷却、修复，且有受限状态图。
- 手机端支持每个阶段的专属人设编辑、版本历史和回退。
- 朋友圈、角色安排、角色日程、生活时间线、主动私聊、主动朋友圈、朋友圈互动和
  朋友圈回复都已通过不同 `TurnKind` 进入原生执行层。
- 红包/转账、图片附件、语音及转写、消息引用、重试、撤回、消息删除和失败恢复已有独立协议。
- Android 在 PC 不可用时可以使用本机配置的 Memory AI + Chat AI 降级链路。
- 手机可通过局域网或端到端加密云端信箱与 PC 连接；重复投递不能产生重复回复。
- PC 的证据事实、手机的本地 MemoryDB、备用回复日志和可见消息同步已经存在，不能
  因本次升级被替换成模型会话上下文。
- 非虞栖角色继续走原有本地聊天链路，本次不得改变它们。

## 3. 核心设计决定

### 3.1 同一认知系统，不是一个超大调用

前台认知和后台巩固使用相同的人格基础、认知经验版本和权威数据库，但使用不同任务、
不同输出 schema、不同持久会话和不同队列。

不能把“最近 200 条原文、事实抽取、关系复核、潜台词、角色心情、行为决定和最终台词”
全部塞进一次调用。这样会同时降低证据准确率和人物判断质量。

### 3.2 前台认知是主脑，表达模型是嘴

前台认知负责：

- 当前完整批次或自动触发的真实含义；
- 虞栖自己的身体/心情/注意力/关系立场；
- 主解释与合理的次解释；
- 是否需要回应、主动权和仍未解决的事情；
- 本轮应采取的关系动作；
- 支付、朋友圈、安排和生活调整等结构化意图；
- 对长期关系 `base` 和当前阶段 `phase` 的证据复核。

表达模型负责：

- 把已经形成的决定写成自然微信正文或朋友圈正文；
- 保留虞栖的口语、气泡节奏、不规整表达和情绪惯性；
- 不重新决定支付状态、朋友圈目标、安排操作、关系阶段或是否应主动联系。

表达模型不得看到后台记忆写库指令，也不得自由新增结构化动作。

### 3.3 监督只检查，不接管

监督模型仍只在深路由、结构化动作、阶段变化、重大关系风险或预设验证期运行。它检查：

- 认知决定与表达是否一致；
- 是否泄漏后台、提示词、记忆库或隐藏用户画像；
- 是否违反纯网聊、阶段人设、支付和公共朋友圈边界；
- 是否出现明显分析腔、客服腔、功能流水线或对话管理腔；
- 表达是否擅自增加认知模型没有决定的动作。

监督只返回可执行问题，重写仍由表达模型完成。

### 3.4 旧状态机先兼容，不立即重命名数据库状态

为避免部署时正在运行的 turn 无法恢复，SQLite 中现有 checkpoint 名称
`memory_running/memory_done/brain_running/brain_done` 暂时保留为兼容性状态：

- 新管线的 `memory_*` checkpoint 承载前台认知；
- 新管线的 `brain_*` checkpoint 承载表达；
- `memoryPacketJson.packetType === "cognition-v2"` 区分新旧包；
- 每个 turn 持久化 `pipelineMode`，重试和恢复不能因运行时配置变化而切换管线。

代码和诊断阶段使用 `cognition_*`、`expression_*` 名称。等所有旧 turn 清空后，是否重命名
数据库状态另开迁移，不混入本次上线。

## 4. Codex 工作记忆与人工批注怎样同步

### 4.1 不能自动复制整个维护窗口

Codex 对话、开发日志和用户对软件的批评属于幕后材料，不能原封不动进入虞栖认知。
否则会出现元信息泄漏、案例过拟合和“看过评分标准”的说话方式。

运行时只读取项目目录中明确获准的版本化认知资产。模型会话自身不是权威存储。

### 4.2 三类认知资产

1. `foundation`：现有综合 RP 与世界观，规定虞栖是谁、纯网聊边界和人物基础。
2. `cognition-core`：从已确认真人聊天规律中提炼的短核心，描述虞栖如何形成状态和判断，
   不包含可直接复制的台词。
3. `social-experience`：带来源、适用条件、反例条件和优先级的经验目录，每轮最多召回
   五条。

第一、二轮真人聊天批注属于可提炼来源；第四轮交接中的“保留多种假设、不能从回复策略
倒推动机”等方法可以进入核心，但尚未经过训练验证的具体潜台词不能成为正式规则。

### 4.3 经验条目格式

每条经验必须具有：

```json
{
  "lessonId": "lesson_emotion_before_function",
  "status": "approved",
  "priority": 90,
  "scenes": ["direct", "payment", "gift"],
  "relationshipStages": ["new", "acquainted", "familiar", "close", "committed"],
  "appliesWhen": ["行为同时承担关系表达", "字面功能不足以解释互动"],
  "principle": "先理解行为在关系中的作用，再决定怎样处理功能对象。",
  "counterSignals": ["用户明确只要求技术处理", "证据支持明确边界或拒绝"],
  "forbiddenInference": ["礼物必然等于示爱", "用户一定期待某种固定回应"],
  "sourceRefs": [
    {
      "path": "preset-references/真人聊天训练批注-第一轮.md",
      "section": "发红包"
    }
  ]
}
```

运行时只加载 `status=approved` 的条目。`provisional` 条目只进入评估工具，不进入虞栖实时
上下文。编译器验证来源文件、章节锚点、唯一 ID、字段长度、资产校验和和总字符预算。

### 4.4 更新与发布

新的人工批注先生成 proposal，不自动改运行时：

`原始批注 -> 条件化经验草案 -> 回归测试 -> 人工确认 -> 新预设版本 -> 可回退发布`

旧的 `brain` 人工批注映射到 `expression`，旧的 `memory` 人工批注映射到
`consolidation`。只有关于“如何理解和形成态度”的批注进入 `cognition`。

## 5. 前台认知输入预算

每次认知调用固定优先级如下：

1. 当前完整用户批次：全部保留，顺序、时间、引用、支付和附件归属不可丢失。
2. 自动触发：完整 trigger、目标朋友圈/评论、当前安排 occurrence 或主动任务来源。
3. 最近对话：最多 20 条，按完整发送批次或完整角色回复组截取，不能切断消息组。
4. 相关长期事实或手机本地记忆提示：合计最多 8 条。PC 事实带来源消息 ID、说话人、
   原话和时间；手机提示带 MemoryDB 记录 ID、类型、来源和时间。
5. 未解决互动：最多 3 项。
6. 社会经验：最多 5 条。
7. 当前认知状态：一份紧凑状态。
8. 当前生活状态、长期关系阶段、当前 phase、阶段专属人设、玩家昵称、角色卡中当前有效
   设定、会话额外设定、安排表、角色日程和朋友圈上下文。

最近 200 条原文不进入前台认知，只进入后台巩固或深度证据补查。手机 MemoryDB 先在手机
按当前输入召回，只把最多 8 条结构化 `localMemoryHints` 送往 PC；不得把整个手机记忆库或
拼接后的旧 memory prompt 放进 envelope。用户手工建立的记忆优先于自动提取提示，但所有
提示仍只作为本轮上下文，除非有原始证据或明确手工来源，否则不能自动升级成 PC verified
fact。

上下文超预算时依次缩减：低分社会经验、低分长期事实、最旧完整历史组。当前批次、
自动触发目标、当前 `base/phase` 和有效明确边界永远不能静默截断。若它们自身超过模型
上下文，turn 必须以可诊断错误或既有降级链路结束，不能假装已经看完。

## 6. 前台认知输出

认知输出是严格 JSON，不得包含可直接发送的完整台词：

```json
{
  "schemaVersion": 2,
  "query": "用于长期事实召回的短查询",
  "keywords": ["关键词"],
  "requiresDeepCognition": false,
  "escalationReasons": [],
  "relationshipStageReview": {
    "base": null,
    "phase": null
  },
  "conversationFrame": {
    "surfaceAct": "",
    "intentHypotheses": [],
    "interactionMode": "",
    "emotionalTone": "",
    "relationshipMove": "",
    "initiative": {
      "topicIntroducedBy": "user",
      "suggestedNextCarrier": "yuqi",
      "reason": ""
    },
    "priorTopic": {
      "status": "closed",
      "summary": "",
      "waitingOn": "none",
      "evidenceMessageIds": [],
      "reason": ""
    },
    "interruption": {
      "requiresReaction": false,
      "reactionReason": ""
    },
    "activeHooks": [],
    "ambiguities": [],
    "responseRisks": [],
    "explicitBoundaries": [],
    "recentCorrection": {
      "active": false,
      "rejectedInterpretation": "",
      "expiresAfterBatches": 0,
      "evidenceMessageIds": []
    },
    "needsNuanceReview": false
  },
  "selfState": {
    "mood": "",
    "moodCause": "",
    "bodyState": "",
    "attention": "",
    "stanceTowardUser": "",
    "ownNeed": "",
    "continuity": "",
    "intensity": 0.0
  },
  "decision": {
    "shouldRespond": true,
    "silenceReason": "",
    "relationshipGoal": "",
    "primaryAction": "",
    "initiativeOwner": "yuqi",
    "mustAddress": [],
    "forbiddenMoves": [],
    "preserveAmbiguity": false,
    "evidenceMessageIds": []
  },
  "actionIntent": {
    "channel": "chat",
    "paymentAction": null,
    "momentIntent": null,
    "rolePlanOperationsJson": "[]",
    "lifePlan": null,
    "lifeAdjustment": null
  }
}
```

AL 对输出执行确定性校验：

- 所有证据 ID 必须存在于实际输入；
- 直接回复不能 `shouldRespond=false`；
- 朋友圈动作只能指向 trigger 中的朋友圈和评论；
- 支付状态只能处理 context 中的那一笔支付；
- 安排操作必须通过现有 role-plan domain 验证；
- `base` 和 `phase` 分开走现有关系状态图与置信度阈值；
- 纯网聊限制、动作类型和时间范围继续由程序验证；
- 模型不能通过输出字段扩大权限。

## 7. 表达输出与旧动作提交层

表达模型只输出：

```json
{
  "action": "send",
  "reply": "最终可见文字",
  "usedFactIds": [],
  "rewriteResolution": null
}
```

AL 使用 `materializeBrainDraft(cognitionPacket, expressionResult)` 把认知动作和表达正文组装成
现有 `normalizeBrainDraft()` 兼容结构。这样现有以下提交逻辑不被重写：

- 支付领取、拒绝、等待；
- 朋友圈点赞、评论、回复和主动发朋友圈；
- 角色安排创建、更新、暂停、恢复、取消、完成；
- 生活计划和生活调整；
- 关系阶段 writeback；
- 主动消息 quarantine、云投递和结果 outbox；
- 回复拆分、消息 ID、去重和失败恢复。

表达结果与认知动作冲突时以认知动作和确定性规则为准，并进入监督或失败，不允许表达模型
静默改变动作。

## 8. 持久认知状态

新增每角色一份短期 `cognitive_state`，它不是用户长期事实：

```json
{
  "schemaVersion": 1,
  "revision": 12,
  "lastTurnId": "turn_x",
  "mood": "",
  "moodCause": "",
  "bodyState": "",
  "attention": "",
  "stanceTowardUser": "",
  "ownNeed": "",
  "openThreads": [],
  "activeBoundaries": [],
  "recentCorrection": null,
  "lastDecisionSummary": "",
  "updatedAt": 0
}
```

更新规则：

- 只在可见结果或合法主动 skip 提交事务中更新；
- 不能覆盖手机传来的权威 `base/phase`；
- 情绪随现实时间、生活事件和新互动变化，不按每轮清零，也不永久锁死；
- `openThreads` 最多 3 项；
- 明确纠正最多持续 2 个新用户批次；
- 模型失败、被监督否决或 turn 未提交时不能更新；
- 更新必须包含 source turn 和 checksum，重试幂等。

## 9. 后台记忆巩固

### 9.1 队列

每个已提交且含新可见证据的 turn 在同一 SQLite 事务中创建一个唯一 consolidation job。
Worker 独立于 TurnDispatcher，单并发运行，失败使用有上限的退避并保留诊断。

后台 job 不得：

- 改写或重发已送达回复；
- 把 trigger 当作用户发言；
- 把未送达的虞栖草稿提升为可检索事实；
- 因失败把可见 turn 改成 failed；
- 修改已经通过结构化动作提交的支付、安排或生活状态。

### 9.2 输入与输出

巩固模型读取：

- 当前 turn 的完整用户批次、已提交虞栖回复或动作；
- 最近最多 200 条权威原始消息；
- 已存在事实、待解决冲突和当前关系状态；
- 备用期间的 provisional 记录；
- 现有 `memory-manager` 证据规则。

它只输出证据事实候选、检索关键词和冲突/取代关系。所有候选继续经过
`validateFactCandidate()` 与 `commitVerifiedFacts()`。

### 9.3 送达确认

由虞栖回复支撑的事实只有在手机确认精确消息或动作已落库后才可检索。局域网和云端都必须
发送幂等 delivery receipt。receipt 至少包含 turnId、messageId/actionId、内容 checksum 和
手机落库时间。

用户消息可以在回复送达前成为证据；虞栖未送达草稿只能保留为 suppressed/provisional。

### 9.4 历史补提取

新增后台 backfill cursor，按完整 turn/batch 边界扫描未处理历史。它只补提取事实，不生成
回复，不改变已显示内容。每批有稳定 checksum，可暂停、恢复和重跑。

## 10. 全功能影响矩阵

### 10.1 被动私聊 `DIRECT_REPLY`

- 认知读取完整 currentBatch，而不是最后一条气泡。
- 引用、图片和支付气泡保留各自 messageId 与顺序。
- 必须回复；认知和监督均不能 skip。
- 删除/重试沿用 canonical message 和 retry lineage。
- 表达失败从 cognition checkpoint 恢复，不重复认知调用。

### 10.2 主动私聊 `PROACTIVE_CHAT`

- trigger 不是用户证据。
- 认知同时读取沉默前因、未回答主动消息、主动 skip 额度、当前心情、生活进展和开放话题。
- 明确边界或仍在等待用户时可以结构性沉默。
- 每四次主动私聊最多一次普通 skip 的现有策略继续独立累计，用户发言不能重置。
- 随机骰子、计划时间、云端唤醒和手动触发只决定何时唤醒，不决定正文。

### 10.3 主动朋友圈 `PROACTIVE_MOMENT`

- 认知决定是否有真实生活触发和是否值得公开发布。
- 表达只写朋友圈正文，不生成私聊口吻。
- 私聊中的秘密、支付详情和未公开用户事实不能进入公共朋友圈。
- 原有主动朋友圈调度、去重和通知保持不变。

### 10.4 朋友圈互动 `MOMENT_INTERACTION` / `MOMENT_REPLY`

- trigger 必须携带精确 moment/comment 目标。
- 认知决定点赞、评论、回复或不动作；表达只写被需要的文字。
- AL 确保动作只落在目标朋友圈/评论，且同一动作幂等。
- 公共评论不能泄漏私聊事实；回复评论必须保留 thread context。

### 10.5 角色安排

覆盖：

- `ROLE_PLAN_CHAT`
- `ROLE_PLAN_MOMENT`
- `ROLE_PLAN_CHAT_PRIVATE`
- `ROLE_PLAN_MOMENT_PRIVATE`
- `private_message`
- `moment_post`
- `role_schedule`

认知必须收到精确 plan、occurrence、原定时间、当前时间和执行历史。表达不得提后台安排表、
定时器或任务。已有创建、编辑、暂停、恢复、取消、立即执行、失败重试、完成和永久删除
语义保持不变。

对话中新建或修改安排由认知输出结构化 operation，并继续走现有 domain 验证。表达不能
单独创建 operation，也不能说出一个承诺却提交相反安排。

### 10.6 生活时间线

- 当前 life episode、身体/注意力状态进入认知状态。
- 聊天中的 `lifeAdjustment` 由认知决定，AL 验证时间和重叠。
- 独立生活规划任务由 cognition preset 的专用 task/schema 执行，不经过表达模型。
- 生活规划使用独立会话 key，避免计划任务污染实时聊天上下文，但共享权威 cognitive state。
- 生活时间线继续可以在无用户消息时推进，不能把角色冻结在上次聊天。

### 10.7 阶段性系统

阶段性系统包括四个不可漏掉的层次：

1. 长期关系 `base`：初识、认识、熟悉、亲近、关系确立。
2. 当前关系 `phase`：正常、冲突、冷却、修复。
3. 每个 base/phase 的用户可编辑阶段人设内容。
4. 模型复核后的 Android 原子 writeback、版本历史与手动回退。

手机 scene 是当前阶段权威输入。认知模型可以提出 review，AL 仍使用现有状态图、证据数和
置信度阈值。`baseAction` 与 `phaseAction` 必须在同一个结果事务中应用。只有 `base`
改变时不能清空仍有效的 `phase`，只有 `phase` 缓和时也不能自动升级 `base`。

### 10.8 支付

- 用户发红包/转账既是结构化支付，也是可能的关系动作；认知先理解互动，再决定
  `received/refused/pending`。
- 金额、支付类型、messageId 和当前状态来自协议，模型不能改。
- 红包和转账的退款/过期规则继续由现有确定性代码处理。
- 虞栖主动支付仍走现有动作和钱包校验，不能因为认知系统支持就提高频率。

### 10.9 图片、语音、表情、引用和多气泡

- 当前批次全部进入认知和表达，各角色只出现一次。
- 任一气泡中的唯一图片都要 materialize 给认知、表达和必要的监督，base64 不进入文本 JSON。
- 语音有转写时保留 `type=voice`、时长和 transcript；无转写时只能理解为“收到一条指定
  时长的语音”，不能编造语音内容，也不能把原始音频塞给不支持音频的模型。
- 表情面板插入的 Unicode 表情仍作为正文的一部分，不另作固定情绪分类。
- 引用保留原说话人、原文和目标 messageId，不能被当成用户新说的事实。
- 历史上下文按批次/回复组截取，不能切断组合。

### 10.10 降级、恢复和备用记忆

- PC 可用时走 cognition-v2。
- PC 不可用时 Android 继续走本机 Memory AI + Chat AI；其 Memory AI 输出升级为兼容
  cognition packet，但不得要求新 API 配置。
- 旧 snapshot `memory-v1/chat-v1` 继续可执行；新 snapshot 使用
  `cognition-v2/expression-v2`，NativeModelGateway 同时兼容两种。
- fallback 回复按原样送达，不因 PC 恢复重写。
- PC 恢复后 consolidation 只复核备用期间证据和 provisional 记忆，不重发回复。

### 10.11 网络、通知和任务恢复

- LAN/CLOUD/AUTO 路由和 HMAC/加密协议不因模型角色更名改变。
- 云中继先持久化再 ack 的语义保持。
- Android Room turn、attempt、reply parts、通知和未读计数不变。
- 进程重启后 TurnDispatcher 恢复可见 turn，ConsolidationDispatcher 恢复后台 job。
- 后台 job 状态不得显示成虞栖“正在输入”。

原生收件、系统通知和 WebView 落地是三个不同检查点，禁止用其中任意一个冒充另一个：

- `nativeCompletedAt` 表示 Android Room 已持久化完整结果；
- `cloudConfirmedAt` 只表示云端投递已由设备确认；
- `uiAppliedAt` 只能在 WebView 已把同一 turn 的全部 reply parts 幂等写入可见聊天后确认。

原生 COMPLETED 必须主动发出 Capacitor 事件唤醒前台；三秒轮询只作为事件丢失、WebView
重建和应用恢复时的兜底。每次 JS-to-native reconcile 调用必须有有限超时，并在
`finally` 清除当前 promise；一次悬挂的插件调用不得永久锁住后续 turn。最近完成 turn 的
replay 必须能绕过陈旧 reconcile 锁，在应用重启、页面重载或事件丢失后恢复。

事件、轮询和 replay 可以同时观察到同一 turn，但 DOM 应用和 `uiAppliedAt` 回执必须
exactly-once。通知可以在页面关闭时先出现，但不得提前写 `uiAppliedAt`；页面重新打开后
必须补齐正文并结束“正在认真想”。诊断分别显示 native completed、cloud confirmed 和
UI applied，不能把“通知已显示”报告成“聊天页已送达”。

### 10.12 数据生命周期

- SQLite 新表自动进入现有 PC 快照与 SHA-256 备份。
- 导出/导入继续覆盖手机聊天、朋友圈、MemoryDB、阶段人设、安排和设置；新增 snapshot
  字段必须向后兼容。
- 清空自动任务只清理主动任务、安排唤醒和 snapshot，不清理人格、长期事实或 cognitive state。
- 清空当前聊天/记忆、删除角色、清空全部历史时，必须明确对应新 cognitive state、
  consolidation job 和 shadow result 的处理策略，并以测试固定。
- 任何 schema 迁移都必须可重复运行；旧数据库打开后不能丢 turn、fact、preset 或 role plan。

### 10.13 角色卡、玩家资料、手工记忆与界面状态

- 虞栖当前角色卡、玩家昵称、聊天额外设定和阶段专属人设继续进入动态 scene；玩家头像、
  置顶和免打扰等纯界面字段不进入模型。
- 角色导入、编辑和虞栖内置资料升级不能覆盖用户已经修改的阶段人设、额外设定或手工记忆。
- 手机 MemoryDB 的资料、事件、摘要、向量和手工增删继续可用；PC cognition 使用结构化
  `localMemoryHints`，但不接管手机 MemoryDB 的编辑器。
- 撤回与删除语义保持区分。撤回的消息不再进入后续认知；删除会触发证据抑制。已发生的
  红包/转账退款仍由原有确定性逻辑处理。
- 置顶、免打扰、未读计数、通知文本、语音转写 API、聊天模型配置、云闹钟绑定和应用更新
  不因模型角色重命名改变。

## 11. 路由和模型

默认执行矩阵沿用当前成本/质量结构：

- fast cognition：`gpt-5.6-terra`, medium；可请求一次 deep escalation。
- deep cognition：`gpt-5.6-sol`, medium。
- expression：`gpt-5.6-sol`, medium。
- deep supervisor：`gpt-5.6-terra`, medium。
- consolidation：`gpt-5.6-terra`, medium；证据冲突或关系变化候选可升级到 Sol。
- life planning：`gpt-5.6-sol`, medium。

自动任务默认 deep。普通直接消息可 fast；完整批次包含关系承诺、强情绪、纠正、冲突、
支付关系风险、阶段变化或上下文缺失时进入 deep。

## 12. 失败语义

- cognition 输出非法：同一模型同一 task 修复一次；仍失败时使用备用模型或 legacy/fallback，
  不进入表达。
- expression 输出非法：保留 cognition checkpoint，只重跑表达。
- supervisor 输出非法：硬检查仍生效；按现有 direct/automatic 策略处理。
- consolidation 失败：记录后台失败并退避，不改变可见 turn。
- cognitive state checksum 冲突：停止状态更新并报警，不覆盖较新 revision。
- stage writeback 失败：回复可按现有结果处理，但关系状态动作不部分应用。
- structured action 与可见表达冲突：不提交动作，进入监督/重写，不能静默猜测。
- 五分钟硬上限到达：进入现有可恢复失败或 Android fallback，不永久卡在处理中。

## 13. 证据分层、逐类晋级和自动回退

### 13.1 代码完成不等于生产启用

本设计把验证分成四层，数量不能互相冒充：

1. 契约回归：确定性 schema、权限、迁移和幂等测试。
2. 离线回放：九种 TurnKind 各 30 个固定案例，共 270 个；同一输入运行 legacy 与
   cognition dry-run，不产生真实动作。
3. 真实 shadow：legacy 结果可见，cognition 在后台处理同一个真实 turn。
4. active canary：cognition 结果可见，legacy 在后台 dry-run；至少 10 次成功对照且观察满
   时间窗才能稳定。在 canary 结束前，后续 active turn 仍继续对照。

离线回放写 `cognition_replay_runs`，真实 shadow 和 active canary 对照写
`cognition_shadow_runs`。本机真实历史私聊回放使用 `source_type=local_history`，仍属于
replay，不能计入 live shadow 数量。

### 13.2 唯一权威来源

逐类当前模式只以 PC SQLite 的 `cognition_kind_rollouts` 为权威。配置文件只在表为空时提供
一次性 bootstrap，之后不能覆盖数据库。内存缓存只可按 revision 加速读取，不能成为权威。

rollout key 包含全部九种 TurnKind，并增加一个非消息任务键 `LIFE_PLANNING`。每行至少保存：

- `current_mode`：`legacy | shadow | active`；
- `rollout_phase`：`stable | collecting | canary | rolled_back`；
- `revision`；
- 固定 preset version、pipeline checksum 和 evidence epoch；
- shadow epoch、live shadow 首次/最近时间和成功数；
- canary epoch、目标数、积压/超时阈值、已分配数、已完成数和失败数；
- 当前报告 ID/checksum；
- 激活、观察截止和最近回退时间；
- 最近转换原因。

`cognition_promotion_history` 只追加转换记录，不作为当前状态来源。

pipeline checksum 必须由实际 cognition/expression/supervisor preset、schema/adapter、
model profile、正式批注目录、comparison evaluator 和 legacy baseline 的 checksum 组成，
由 PC 注册表按 rollout key 重算；共享组件影响全部 key，kind-specific adapter 只影响对应
key，调用者不能自报。turn 与 life-planning attempt 都固定这组 checksum，任何相关组成
变化都开启新 evidence epoch。

### 13.3 原子固定和恢复

`PromotionController` 是唯一可改变 rollout 的组件。创建 turn 时，它让 Store 在同一事务中：

1. 读取对应 rollout 行及 revision；
2. 固定 `pipelineMode`、`comparisonMode`、`rolloutRevision`、preset version 和批注快照；
3. 若处于 shadow，固定当前 shadow epoch；若处于 canary，按当前 canary epoch 原子分配
   一个 canary slot；
4. 插入 turn。

已经创建的 turn 永远按自身固定字段恢复，不再读取当前 rollout。晋级或回退只影响之后创建
的新 turn。服务重启后从 SQLite 恢复计数、时间窗和 job，不依赖进程内变量。

固定 checksum 不代表旧代码一定仍可加载。重启后若旧 bundle 已不存在，后台 compare 只能
记 stale/unavailable，不能用新代码冒充旧版本；旧前台 turn 已有 cognition checkpoint 时
按兼容 schema 继续，尚未开始时走安全 fallback，但仍不重写它固定的 mode/revision。

任何会改变 cognition/expression/supervisor 行为的 preset、模型 profile 或正式批注更新都
必须开启新的 evidence epoch 并清零该 key 的 shadow/canary 计数。当前 active/shadow key
进入新的 shadow 收集窗口；仍为 legacy 的 key 保持 legacy，等待显式进入 shadow。旧 epoch
的报告保留审计但不能支持新版本晋级。

### 13.4 两种相反方向的后台对照

- shadow：`legacy_authoritative_cognition_compare`。legacy 提交权威结果，cognition dry-run。
- active canary：`cognition_authoritative_legacy_compare`。cognition 提交权威结果，legacy dry-run。

两种 compare 都使用持久后台 job，只能读取固定输入和版本，不得写消息、支付、朋友圈、
安排、阶段、life 或通知。compare job 只写脱敏指标和 checksum。
job 自身保存 canonical payload 及由 Store 计算的 checksum；重启后必须校验原 payload，
不能根据当前 rollout/preset 猜测重建固定身份。

“权威结果”按 subject 定义：turn 是已经通过确定性校验的可见 draft/action；LIFE_PLANNING
是已经提交到 life domain 的规范化 plan。subject 创建时只固定 rollout/input，不能提前
创建 compare job。只有权威管线成功后，才在提交权威结果的同一事务创建 compare；提交前
失败则没有 compare job。

LIFE_PLANNING attempt 分离前台执行状态与后台 comparison 状态。created/running/retry_wait
只可恢复固定输入；result_committed 后才可能 queued/running compare。episodes、权威结果
checksum、attempt 状态与 compare job 必须全成或全不成，重复提交不能生成第二个 job。
它使用两级幂等身份：业务 request base 由角色、规划窗口和输入 checksum 决定；最终
request key 再包含 preset、mode、pipeline/evidence checksum 以及 shadow/canary epoch。
因此同一个 API 重试不会制造新 subject，而晋级、回退或 evidence 变化也不会误复用旧
attempt。提交成功后的同 checksum 重试先走结果幂等分支，不再要求已经清除的 worker lease。
同一角色最多一个 open attempt；runtime 由单并发 LifePlanningDispatcher 在启动时恢复过期
lease，并领取持久 due attempt。周期性 poll 只负责创建或唤醒，不能绕开 dispatcher 再跑
模型。规划窗口和 basis 使用稳定 anchor/checksum，不把每分钟变化的当前时间变成新请求；
当前 rollout 已变化时，仍先完成旧 attempt 的固定语义。
实时聊天只 enqueue/poke 生活规划并使用已经提交的 life context，不等待 life provider；
因此生活规划不占用实时回复的 60 秒软时限或 300 秒硬上限。
attempt 分别固定 life-domain basis checksum 与认知 context checksum。提交时在同一事务
重算 life basis；若期间安排或 episode 已改变，旧结果以 `LIFE_BASIS_STALE` 取消，不写
episode、不建 compare，也不算 active 模型失败。

turn 的 active canary legacy compare 在可见提交后运行，不能撤回已经送达的正文。因此所有现有
pre-commit schema、动作目标、阶段图、支付校验、公共/私密监督和 supervisor 闸门必须继续
执行；canary 自动回退是防止后续回合继续暴露，不替代提交前安全检查。

### 13.5 自动回退

后台对照完成后，确定性 evaluator 与结果写入同一事务。出现以下任一 critical finding：

- 当前 batch messageId 遗漏；
- action target 越权；
- direct skip；
- 支付对象或金额被改变；
- 非法 base/phase 转换；
- private fact 进入公开内容；
- 重复消息或结构化动作；
- cognition 可见回合失败而相同输入 legacy dry-run 成功；
- active canary 的 legacy compare 达到最终重试上限仍无法完成；

`PromotionController` 立即只把对应 rollout key 从 active 回退到 shadow，追加 history，并
保留触发报告 checksum。若后台 cognition 本身造成持续资源故障，可以进一步从 shadow
回退到 legacy。其他 kind 不受影响。

active 管线若在可见提交前因候选版本不可用、最终模型失败或确定性 pre-commit 越权而失败，
不应等待后台 compare；Orchestrator 通过同一控制器记录 critical report，并回退该 key。
纯 LAN/CLOUD 中断、PC 根本未创建 turn 或 Android 自主 fallback 不代表 cognition 质量
失败，不能误触发 rollout 回退。

canary 的最终管线失败立即回退。stable active 的版本/checksum 缺失或确定性越权也立即
回退；provider timeout/rate-limit 等瞬时故障则要求 15 分钟内连续三次，一次成功会清零，
避免一次短暂网络或供应商抖动把稳定功能误降级。

评估结论先以 canonical JSON 和 checksum 写入 SQLite，和 run、rollout 更新、history、
自动回退处于同一事务；文件系统中的 JSON/Markdown 报告是由该行生成的可重建验收产物。
因此报告落盘失败不能延迟安全回退。反过来，人工晋级必须等报告文件生成完成，并校验
数据库 checksum、文件 checksum 与命令传入 checksum 三者一致。

后台 job 固定自己的 evidence epoch、pipeline checksum、comparison direction、shadow
epoch 和 canary epoch。结果晚到时，只有这些标识仍与当前收集窗口一致，才可以更新计数或
触发状态变化；旧窗口结果仍作为审计证据保存，但标为 stale，不得回退后来已经换过 preset、
模型、shadow epoch 或 canary epoch 的运行状态。重复 job 只计一次。每次进入新的 shadow
收集窗口都递增 shadow epoch 并清零 30 次/72 小时计数，不能复用回退前样本。

### 13.6 晋级闸门与时间

离线发布闸门：

- 九种 TurnKind 各 30/30 固定案例完成；
- critical finding 为 0；
- 所有原有回归继续通过。

首版 `DIRECT_REPLY` 进入 active canary 还要求至少 30 个本机真实历史私聊 replay 通过。
它们不计入 live shadow。

仅首次 DIRECT_REPLY 允许凭“270 fixture 中 DIRECT_REPLY 的 30 例 + 30 个 local_history”
从 legacy 直接进入 active canary。其他 rollout key 必须先经过 shadow/live 闸门。

其余八种 TurnKind 从 shadow 晋级 canary 必须同时满足：

- 至少 30 次真实成功 shadow；
- 从第一条有效样本起至少 72 小时；
- critical finding 为 0；
- schema 成功率至少 98%；
- 有可校验的 promotion report checksum。
- 当前 evidence/shadow epoch 不存在未完成权威 subject 或 compare job。

canary 晋级 stable active 必须完成至少 10 次 active/legacy 对照、当前 canary epoch 不存在
未完成权威 subject 或 compare job，并从首次 canary 起观察至少 48 小时。10 是最低完成数，
不是分配上限；canary 期间每个 active subject 都继续对照。低频功能可能需要数周，不能用
固定日历期限代替样本数。

canary 不能无限积压未验证 subject：outstanding 从 canary slot 分配时开始计算，包括尚未
产出权威结果、因错误等待重试，以及已经 queued/running 的 compare。当前 epoch 已有 3 个
outstanding，或最老 subject 已超过 15 分钟时，创建新 turn/planning attempt 的事务先自动
回退该 key 到 shadow，再按 shadow 固定新任务。不能用延迟创建 compare job 绕过熔断。
任何需要 compare 的 shadow/canary subject 在固定时都会推进 rollout revision，使此前形成
的 promotion report 自动失效。

### 13.7 命令和证据

正式命令：

```text
npm.cmd run cognition:replay
npm.cmd run cognition:replay-report
npm.cmd run cognition:shadow-report
npm.cmd run cognition:promotion-check
npm.cmd run cognition:promote
npm.cmd run cognition:rollback
npm.cmd run cognition:rollout-status
```

脱敏报告保存到：

```text
artifacts/qa/cognition/replay/<run-id>/
artifacts/qa/cognition/live/<report-id>/
artifacts/qa/cognition/promotions/<rollout-key>-<revision>.json
```

### 13.8 首版 APK

Android APK 只承载 v1/v2 协议和执行兼容；逐类 rollout 发生在 PC runtime，因此后续晋级
不需要重新安装。

正式首版在 270 个离线案例和 30 个真实历史私聊 replay 全部通过后：

- `DIRECT_REPLY`：`active + canary`；
- 其他八种 TurnKind：`shadow + collecting`；
- `LIFE_PLANNING`：在专用回放通过前保持 legacy。

如果 DIRECT_REPLY 的真实历史样本不足或回放不通过，该构建只能称为候选包，不能按上述
配置宣告正式交付。删除 legacy 必须另行批准，本计划不删除。

## 14. 验收标准

### 14.1 确定性

- 所有现有 Node、runtime、Android 单元测试继续通过。
- 全部九种 TurnKind 都有 cognition-v2 回归测试。
- 支付、朋友圈、安排、life、stage、图片、语音、引用、撤回、删除和 retry 的结构化行为
  没有回归。
- 旧数据库、旧 snapshot、旧 pending turn 和旧 preset version 均可恢复。
- consolidation 重启、重复 job、乱序 receipt 和重复云投递不产生重复事实。
- replay、live shadow 和 active canary 数据来源严格分开，不能互相累计。
- rollout 事务、服务重启、并发晋级和自动回退不会改变已创建 turn 的固定模式。
- LIFE_PLANNING 创建 attempt 时不创建 compare；权威 plan、checksum、attempt 状态和唯一
  compare job 原子提交，失败/重启不产生无基准 job 或错误 canary 计数。

### 14.2 角色质量

- 当前完整批次的每个气泡都被认知模型读取。
- 认知先形成虞栖状态和关系判断，不只复述用户字面。
- 允许多种合理解释，主次有证据，不把推测写成事实。
- 虞栖具有跨轮心情、自己的生活和独立态度。
- 不出现分析腔、功能流水线、随机脾气、万能服务或无依据共同历史。
- 阶段、情绪和时间流逝共同改变反应，不能每轮重置。
- 社会经验改变关注点，不在正文展示“我记得规则/档案”。
- 手机手工记忆和召回提示能影响相关回合，但不会泄漏到错误角色或自动升级成无证据事实。

### 14.3 体验与运行

- 普通回合一分钟内完成为软目标；超过一分钟有诊断，五分钟硬停止。
- 用户看到回复不等待 consolidation。
- 后台任务不触发“正在输入”、重复通知或未读数。
- 断网、电脑重启、Android 重启和模型超时后可以恢复。
- 诊断不包含 API Key、配对密钥、云 token、图片 base64 或完整隐藏预设。
- 正式 APK 的 DIRECT_REPLY 首次 10 个 active 回合具有 legacy dry-run 对照；critical
  finding 会自动按 kind 回退且不要求重装 APK。

## 15. 明确不做

- 不把维护窗口的全部对话自动灌入虞栖。
- 不把未验证第四轮假设变成正式用户画像。
- 不训练或微调商业模型底层权重。
- 不让模型直接写数据库、钱包、安排表、关系阶段或云任务。
- 不删除现有 Android fallback、legacy 管线或本地 MemoryDB。
- 不顺带重写非虞栖角色。
- 不用关键词禁令替代情境判断，也不把正例台词做成模板库。
