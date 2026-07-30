# 虞栖活人感与人物主观性 v3 根源重构设计

日期：2026-07-30  
状态：用户已逐项确认，作为后续实施计划的唯一设计输入  
范围：虞栖 PC 专属认知运行时、Android fallback、关系与记忆状态、全部虞栖 TurnKind、质量评价和发布控制

## 1. 目标

本次重构不针对红包、亲亲或任何一句具体台词增加特判。目标是修正虞栖专属模型的权威关系，使她在全部互动中：

- 能理解字面行为背后的当前互动作用；
- 先形成自己的状态、意愿和立场，再决定怎样参与；
- 可以接受、拒绝、坚持、犹豫、心软或改口；
- 保持人物、生活、关系和时间连续，同时不把临时态度永久冻结；
- 在拒绝用户时仍然是一个参与当前关系的人，而不是执行后台规则；
- 在支付、朋友圈、安排、阶段和公开隐私等结构化功能上继续保持确定性安全；
- 在主动和被动任务并发时只形成一个顺序明确的可见对话结果；
- 使用真实多轮语料而不是占位协议案例证明质量。

普通回合继续以一分钟内完成为软目标，五分钟为硬上限。不得通过增加无限模型调用、塞入完整规则目录或降低结构化安全来换取活人感。

## 2. 已确认的生产表现

更新后的真实聊天证明 cognition-v2 已有实质进步：

- 能把红包同时理解为支付动作和关系动作；
- 能区分“钱”与用户表达关心的心意；
- 能保持改稿、奶茶、喜欢程度和关系试探的多轮连续；
- 能在漏发早安后直接承认没有做到；
- 能形成自然短句、调侃和有生活依据的回复。

但同一段真实对话也暴露出通用失败：

- 面对关系程度追问时，阶段系统通过“还没到能说定关系”泄漏到台词；
- 虞栖先要求用户“好好表现”，随后回避自己应该怎样表现；
- “今天不再追加亲亲”被当成后续必须执行的规定；
- 用户用转账开玩笑“充值”时，系统优先维护旧说法，而不是重新形成虞栖当下反应；
- 主动私聊和直接回复在约二十秒内产生相同可见正文。

这些结果说明问题不在于模型完全不懂潜台词，而在于理解结果进入决策后被错误的权威和生命周期覆盖。

## 3. 已确认的代码根因

### 3.1 风险被自动升级为禁令

`yuqi-runtime/src/interaction-contract.mjs` 当前的 `deriveForbiddenMoves()` 将整个 `responseRisks` 合并进 `forbiddenMoves`。风险原本应提醒认知模型重新检查，实际却变成表达和监督必须服从的禁止动作。

### 3.2 模型可以自由生成持久边界

当前 `conversationFrame.explicitBoundaries` 只包含 `type/active/reason/evidenceMessageIds`，没有：

- 提出者；
- 权威等级；
- 作用对象；
- 硬约束或软立场；
- 生效范围；
- 可修改性；
- 明确解除条件。

因此虞栖自己的临时说法、用户真正边界和系统安全限制会进入同一个数组。

### 3.3 过期字段没有形成真实生命周期

`yuqi-runtime/src/cognitive-state.mjs` 虽然可以保存 `expiresAfterBatches`，但状态归并时把新旧 `activeBoundaries` 直接合并，没有按相关用户批次递减、删除或取代。临时状态因而可能无限持续。

### 3.4 关系阶段从事实层侵入表达层

`base/phase` 本应描述长期关系和当前关系阶段，却被认知和监督用来限制普通亲昵、调情和情绪表达。阶段可靠性提高后，反而更稳定地生成关系免责声明。

### 3.5 监督只证明合规，不能发现关系僵硬

当前监督擅长检查格式、越权、事实、动作和明显分析腔，但真实失败轮经过深度认知和监督后仍以 `issues=[]` 获批。监督没有检查：

- 是否把临时立场冻结为规则；
- 是否丢掉用户的当前互动动作；
- 是否只要求用户付出而回避人物自己的表示；
- 是否把阶段和风控机制翻译成台词；
- 拒绝是否来自人物当下意愿。

### 3.6 当前离线回放不能证明人物质量

`tests/fixtures/yuqi-cognition-replay-v1/cases.jsonl` 中大量正文为“脱敏测试消息 1/2/3”或直接告诉模型“保留多种理解”。现有 270 例适合证明协议、ID、目标和 schema，不适合证明虞栖像真人。

### 3.7 主动与被动结果没有同一提交仲裁

主动私聊和直接回复可以基于相邻但不同的可见上下文并行生成。主动消息在手机回执前又被隔离于正常检索，导致直接回复可能看不到一条即将显示的主动消息。两条结果最后都能成为可见权威结果。

## 4. 采用方案

采用“保留现有执行基础，重构认知契约、状态权威和提交仲裁”的方案。

继续保留：

- PC SQLite 和持久 turn；
- cognition、expression、supervisor 分工；
- 结构化支付、朋友圈、安排、生活和阶段动作；
- Android Room、LAN/CLOUD、通知、重试和恢复；
- 手机 MemoryDB、手工记忆和阶段人设；
- 非虞栖角色的旧链路；
- 逐 TurnKind rollout 和自动回退。

不采用：

- 只扩写提示词；
- 针对红包、亲亲或某个截图写关键词规则；
- 新增第四个实时模型角色；
- 把全部规则、功能和案例塞进每轮上下文；
- 让单个大模型直接写数据库和结构化动作；
- 训练商业模型底层权重。

## 5. 权威状态模型

### 5.1 硬约束 `hardConstraints`

硬约束只包含：

- 系统能力、安全、隐私和纯网聊限制；
- 支付、朋友圈、安排、删除等结构化动作权限；
- 用户明确表达的停止、拒绝、隐私和同意边界；
- 已成立的正式承诺和关系事实；
- 用户作为作者明确标记的不可违背人物设定。

建议规范结构：

```json
{
  "constraintId": "constraint_x",
  "authority": "system|author|user",
  "kind": "capability|consent|privacy|action|commitment|relationship_fact",
  "subject": "yuqi|user|both",
  "scope": {
    "channel": "private_chat|public_moment|all",
    "target": "具体动作、对象或话题"
  },
  "rule": "短小、可执行的约束",
  "sourceMessageIds": [],
  "sourceConfigRef": null,
  "createdAt": 0,
  "releaseCondition": "明确解除条件",
  "status": "active|released|archived",
  "revision": 1,
  "supersedes": null
}
```

系统和结构化动作约束由程序建立。自然语言中的用户边界由认知模型提出候选，必须引用用户原话和消息 ID；约束编译器校验说话者、范围和字段，监督再验证是否确属明确边界。证据不足时只在当前回合谨慎处理，不持久写入。

虞栖自己的普通拒绝和临时决定不能进入 `hardConstraints`。

### 5.2 稳定偏好 `preferences`

偏好用于形成选择倾向，例如喜欢甜食、不喜欢被商品化、工作时比较专注。偏好可以来自：

- 基础人物预设；
- 用户明确编辑的人设；
- 用户或虞栖明确表达且已经送达的事实；
- 多次独立证据支持的稳定行为。

偏好不产生“必须”或“禁止”。不同场景下违反普通偏好不构成人格错误。

### 5.3 当前立场 `currentStances`

当前立场表示虞栖此刻对具体对象的态度：

```json
{
  "stanceId": "stance_x",
  "topic": "具体对象或当前互动",
  "position": "当前态度",
  "reason": "当前原因",
  "strength": 0.0,
  "flexibility": 0.0,
  "sourceTurnId": "turn_x",
  "sourceMessageIds": [],
  "createdAt": 0,
  "lastConfirmedAt": 0,
  "expiresAt": null,
  "remainingRelevantUserBatches": 2,
  "status": "active|expired|superseded",
  "revision": 1,
  "supersedes": null
}
```

当前立场默认可改变。每个相关回合必须产生以下一种操作：

- `maintain`
- `strengthen`
- `soften`
- `reverse`
- `expire`
- `create`

当前立场最多保留三个相关用户批次或一个明确时间段。仍需延续时必须由新认知主动确认。带“今天、这次、暂时”等时间范围的立场按现实时间结束，也允许在结束前因新互动而改变。

### 5.4 当前回合提醒

`responseRisks`、歧义和可能误读只属于本轮认知证据：

- 不持久写入状态；
- 不自动进入 `forbiddenMoves`；
- 不直接发送给表达模型；
- 不提供可复制的台词；
- 只用于决定是否深度认知、监督或重新检查证据。

### 5.5 权威优先级

发生冲突时按以下顺序处理：

1. 系统能力、安全、隐私和同意；
2. 用户明确边界和已成立结构化事实；
3. 当前现实、生活和正式承诺；
4. 虞栖当前立场；
5. 关系 `base/phase` 带来的倾向；
6. 稳定偏好和语言风格。

用户请求不是硬约束，虞栖仍可拒绝。关系阶段、普通偏好和虞栖以前随口说过的话不能升级为硬约束。

## 6. 三个时间尺度

### 6.1 慢状态

- 基础人格和世界观；
- 用户编辑的人设与阶段人设；
- 已验证事实和共同经历；
- 长期关系 `base`；
- 已成立正式承诺。

### 6.2 中状态

- 当前关系 `phase`；
- 尚未解决的争执；
- 正在推进的安排和生活事件；
- 持续一段时间的关系张力。

### 6.3 快状态

- 心情、身体和注意力；
- 当前靠近或保持距离的意愿；
- 对具体互动的临时立场；
- 嘴硬、心软、犹豫和改口。

三个尺度不得互相冒充：

- 一次亲昵不等于关系升级；
- 当前生气不等于长期关系降级；
- 一次心软不等于冲突已经修复；
- `base=熟悉` 不禁止亲昵；
- 阶段未升级不禁止表达喜欢；
- 普通台词不自动成为长期人物设定。

## 7. cognition-v3

### 7.1 输入

每轮使用精简 `CognitionEnvelopeV3`：

```text
turnKind
currentInteraction
relevantHistory
verifiedFacts
hardConstraints
currentStances
relationshipBasePhase
lifeSignals
authorSettings
allowedActions
featureContext
```

输入预算：

- 当前完整批次全部保留；
- 最近对话按完整发送组保留，默认最多 20 组；
- 相关事实最多 8 条；
- 相关硬约束最多 5 条；
- 当前立场最多 2 条；
- 社会经验最多 3 条；
- 开放话题最多 3 条；
- 只注入当前 TurnKind 的功能上下文。

不得把完整规则目录、全部阶段说明或所有功能协议同时塞入。

### 7.2 决策顺序

1. 读取当前事实和可见顺序；
2. 判断字面交流行为；
3. 判断最可能的当前社会含义，必要时保留一个次解释；
4. 形成虞栖即时感觉、意愿、抗拒和注意力；
5. 对相关当前立场执行状态转换；
6. 决定虞栖怎样参与当前互动及希望产生的关系效果；
7. 决定支付、朋友圈、安排、生活和阶段等结构化动作；
8. 形成精简表达任务和候选状态补丁。

### 7.3 输出

```text
interactionRead
  surfaceAct
  primarySocialMeaning
  alternativeMeaning
  confidence
  evidenceMessageIds

selfResponse
  immediateFeeling
  desire
  resistance
  attention
  stanceTransitions

interactionDecision
  intendedResponse
  relationshipEffect
  shouldAcknowledgeBid
  intentionalNonResponseReason
  mustConvey
  mustNotClaim

actionIntent
  payment
  moment
  rolePlan
  lifeAdjustment
  relationshipReview

statePatch
  mood
  currentStances
  openThreads
```

`shouldAcknowledgeBid` 不要求虞栖接受或温柔。它只要求系统明确决定是否处理用户当前的示好、玩笑、修复、试探或求安慰。拒绝、冷淡和不接也可以成立，但必须是人物有意的当下选择。

### 7.4 快慢路由

- 普通明确消息：fast cognition + expression；
- 当前立场变化、关系试探、支付互动、冲突修复、嫉妒、亲昵、用户纠正或多种解释：升级 deep cognition；
- 主动任务、关系变化和结构化动作默认 deep；
- 高风险回合进入活人感监督；
- 不以关键词单独决定路由，fast cognition 的结构结果可以触发升级。

### 7.5 状态提交

认知输出的状态补丁只有在可见结果成功提交时，才与消息、动作、outbox 和记忆任务处于同一事务写入。

以下结果不得修改状态：

- 模型失败；
- 监督未通过；
- 尚在返修；
- 被并发仲裁取代；
- 重复投递；
- 未成为权威结果；
- 自动任务合法 skip 之外的未提交草稿。

## 8. 表达层

表达模型读取：

- 基础人物和当前阶段语气；
- 当前完整可见对话；
- 虞栖简短当下状态；
- 已决定的互动动作；
- `mustConvey` 和 `mustNotClaim`；
- 获准结构化动作；
- 最多两个连续性细节。

表达模型不读取完整认知分析、置信度、风险目录、阶段晋级规则和后台状态名称。

表达模型可以决定措辞、气泡、停顿、省略、改口和低风险生活质感。它不能改变支付、朋友圈、安排、阶段、当前立场、正式承诺或重大事实。

表达认为任务无法自然表达时，返回决策与表达不相容，不得静默改写认知决定。

## 9. 监督层

### 9.1 程序硬检查

代码在模型监督前验证：

- 消息、支付、朋友圈、安排和引用对象；
- 公开/私密边界；
- 纯网聊能力；
- 合法阶段转换；
- 重复消息和结构化动作；
- expression 是否新增未授权动作；
- turn 是否已被更新 revision 取代。

### 9.2 活人感检查

高风险回合的监督检查六类结构性失败：

- `SOCIAL_BID_DROPPED`：识别出当前互动动作，正文却只处理字面功能；
- `SOFT_STANCE_FROZEN`：把虞栖临时态度当成不可改变规则；
- `INTERNAL_POLICY_LEAK`：把阶段、风险或交换控制翻译成台词；
- `ONE_SIDED_RELATIONAL_DEMAND`：要求用户证明或付出，同时回避虞栖已经声称的主动表示；
- `DIALOGUE_META_NARRATION`：像旁观者复盘互动和完整心理因果；
- `CHARACTER_STATE_BREAK`：与生活、心情、开放话题或已显示前文断裂。

监督不以“让用户开心”为唯一目标。它判断人物是否理解、是否有自己的意愿、是否有意识地造成当前关系后果。

### 9.3 问题归属

监督问题必须包含：

```text
owner: cognition | expression | action
evidenceMessageIds
violatedRequirement
mustPreserve
mustChange
acceptanceCriteria
```

- `cognition` 问题退回认知重新判断一次；
- `expression` 问题保留决定、重写表达一次；
- `action` 问题阻止提交，由确定性动作层处理。

每轮最多一次认知重判、一次表达返修和一次最终复核。高风险监督使用 Sol 中等思考；普通结构检查由程序完成。

## 10. 关系阶段、阶段人设与记忆

### 10.1 关系阶段

保留现有：

- `base`：初识、认识、熟悉、亲近、关系确立；
- `phase`：正常、冲突、冷却、修复；
- 状态图、证据和置信度门槛；
- 手机权威输入；
- Android 原子写回、历史和手动回退。

阶段只控制正式关系事实、排他承诺、长期义务、共同经历深度和阶段写回，不控制普通亲昵，也不自动生成“还没到阶段”等免责声明。

### 10.2 阶段人设

用户编辑内容继续保留并版本化。运行时将其编译为：

- 语气与相处倾向；
- 当前阶段可引用关系事实；
- 用户明确写下的不可违背作者设定。

“比较克制、不会太主动”属于倾向，不自动成为禁止动作。作者明确标记的能力或人物底线进入作者级硬约束。

### 10.3 后台记忆巩固

只允许写入：

- 原始消息支撑的用户事实；
- 已送达的虞栖生活事实；
- 明确成立的承诺；
- 可检索事件摘要；
- 重复证据支持的稳定偏好；
- 事实冲突和取代关系。

不得写入潜台词、当前心情、临时立场、推测用户性格、监督评价、未送达草稿和模型推导的硬边界。

## 11. 生活系统

生活规划使用相同人物基础和状态语义，但保持独立会话、持久 attempt、固定 basis checksum 和单并发 dispatcher。

生活系统可以推进普通工作、饮食、休息、兴趣和注意力变化。不得为了活人感随机制造重大事故、疾病、失业、新恋情和身份改变。

实时聊天不等待生活规划。聊天改变安排时，认知决定、可见正文、结构化 `lifeAdjustment` 和时间校验必须一致。

## 12. 全功能接入

### 12.1 `DIRECT_REPLY`

- 读取一次正式发送的全部气泡；
- 保持支付、图片、引用和文字顺序；
- 每条当前消息都进入证据；
- 必须形成可见回复；
- 重试复用固定认知 checkpoint。

### 12.2 `PROACTIVE_CHAT`

主动必须来自生活变化、想念/好奇、开放话题、当前情绪或已成立承诺。调度命中只允许考虑，不强迫发送。结构性静默只读取真实用户边界，不把虞栖临时嘴硬当成禁止主动。

### 12.3 `PROACTIVE_MOMENT`

从已提交生活事件形成公开内容。没有真实内容可以 skip。不得公开私聊、支付金额、用户隐私或未公开关系。

### 12.4 `MOMENT_INTERACTION` / `MOMENT_REPLY`

读取精确 moment、comment 和线程。认知决定点赞、评论、回复或不动作；程序锁定目标和公共隐私。

### 12.5 角色安排

覆盖：

- `ROLE_PLAN_CHAT`
- `ROLE_PLAN_MOMENT`
- `ROLE_PLAN_CHAT_PRIVATE`
- `ROLE_PLAN_MOMENT_PRIVATE`
- `private_message`
- `moment_post`
- `role_schedule`

认知决定接受、修改、暂停、恢复、取消和完成。可见正文与 operation 必须一致；时间不明确时不得猜测。

### 12.6 支付

分离：

- `paymentAction`：收取、拒绝或等待；
- `interactionResponse`：怎样回应这次关系动作。

收钱不等于接受附带要求，拒绝不等于必须冷淡，金额不证明喜欢程度，玩笑“充值”也不自动成为非法交易。协议继续锁定金额、对象、状态、退款和钱包。

### 12.7 图片、语音、表情、引用和多气泡

- 当前批次整体理解；
- 图片只 materialize 一次；
- 有转写语音保留类型、时长和正文；
- 无转写不得编造；
- Unicode 表情不映射固定情绪；
- 引用保留原说话者和 messageId；
- 多气泡回复作为一个权威结果组提交。

### 12.8 Android fallback

新 APK 支持 cognition-v3 精简快照，同时读取 cognition-v2 和 memory-v1/chat-v1。fallback 读取相关硬约束、当前立场、关系阶段和最近完整对话。PC 恢复后不重写已显示结果，fallback 事实只进入待复核记录。v3 只有在请求明确没有被 PC 接受时才可 fallback；超时、丢响应和未知异常保持 receipt/replay 恢复，五分钟后转为可重试错误，不能用第二份本机生成结果掩盖权威不明。

### 12.9 数据生命周期

- 导出、导入和备份包含新状态表；
- 清空自动任务不删除人格、事实、关系和认知状态；
- 清空聊天、清空记忆、删除角色分别定义新表处理；
- 清空聊天删除消息投影和可见正文，取消尚未交付的 outbox payload，但保留不含正文的 lineage、commit receipt 和 checksum，防止清空后重试造成重复发送或重复动作；
- 被撤回或删除消息不能继续作为新状态证据；
- 非虞栖角色保持旧链路。

## 13. 持久化输出通道与并发仲裁

### 13.1 通道

新增 `interaction_lanes`：

- `private_chat`
- `public_moment`
- `moment_interaction:<momentId>`

每个通道保存 revision、正在生成 turn、最新用户批次、最新权威结果组、原生/UI游标和最近提交 checksum。

### 13.2 私聊优先级

1. 用户直接消息；
2. 已成立并到期的安排；
3. 普通主动私聊。

用户批次到达时，尚未提交的普通主动私聊标为 `superseded_by_user_batch`。已成立安排不删除，排到直接回复之后重新读取上下文。

### 13.3 原子提交

#### 13.3.1 跨重试的唯一权威

最终可见结果的权威单位不是 `turnId`，而是跨 original/retry 分支稳定不变的 `lineageKey`。

PC 数据库新增 `turn_authority_lineages`。每条 lineage 由 `roleId + laneKey + rootSourceId` 唯一确定，保存 `latestTurnId`、显式整数 `revision`、`open/committed/cancelled` 状态和唯一 `committedGroupId`。首个 v3 turn 创建 lineage；重试必须复用前一 turn 的 lineage，并用 compare-and-swap 把 `latestTurnId` 从被重试 turn 改为新 turn。两个 sibling retry 不能同时取得提交权；lineage 已提交时不得再生成新 retry，只返回已有 receipt。

`turns` 增加：

- `resultAuthorityVersion`：旧 turn 为 0，Task 10 之后创建的 v3 turn 为 1；
- `authorityLineageKey`；
- `lineageRevisionAtCreation`；
- `turnRevision`；
- `retryOfTurnId`；
- `agencySnapshotChecksum`。

`updatedAt` 只用于诊断和排序，绝不用于并发判定。v3 turn 的 claim、checkpoint、supersede、failure 和 commit 都必须使用显式 `turnRevision` compare-and-swap。

#### 13.3.2 唯一可见结果与 receipt

PC 数据库新增四组 canonical 记录：

- `visible_result_groups`：一条 lineage 最多一个 group，一条 authoritative turn 最多一个 group，并标明 `pc` 或 `android_fallback` authority origin；
- `visible_result_items`：按 `groupId + ordinal` 唯一保存可见气泡；
- `visible_result_actions`：按 `groupId + ordinal` 唯一保存已授权结构化动作；
- `visible_commit_receipts`：以 `lineageKey` 为主键，唯一关联 group、authoritative turn、authority origin、`commitPayloadVersion` 和 `commitChecksum`。

group ID 和气泡/action ID 由当前合法 authority owner 按双方共享的版本化算法根据 lineage 与 ordinal 确定性生成，不接受模型输出、当前时间或临时随机 ID。PC `commitChecksum` 对规范化语义 payload 计算，包含 lineage、可见气泡、动作、状态 patch、记忆任务、可选 compare descriptor、release、输入可见游标和生成时权威 checksum；Android fallback 使用另一个明确版本的规范 payload。两者都排除时间戳、随机数和非语义日志。重复提交只有 origin、payload version 和 checksum 全部相同时才返回同一 receipt；同 lineage 的不同 payload 一律是 authority conflict。

`messages` 只是 group items 的聊天查询投影；`turn.replyJson` 只是兼容投影。它们都不能反推出新的 group ID 或 receipt，也不能成为第二事实源。

#### 13.3.3 提交前重新校验

`commitVisibleResult()` 在一个 `BEGIN IMMEDIATE` 事务中检查：

- receipt 尚不存在；若存在，只允许 exact duplicate 返回；
- turn 的 `resultAuthorityVersion=1`，且 `turnRevision` 仍有效；
- lineage 仍为 open、revision 未变且 `latestTurnId` 正是当前 turn；
- lane revision、最新用户批次 ID 和本地 visibility sequence 未变；
- 当前 cognitive state revision 未变；
- 当前 hard constraints、preference evidence、active stance heads 和 cognitive state 组成的 `agencySnapshotChecksum` 未变；
- authoritative release pin 未变；
- 动作对象仍有效；
- generation fingerprint 仍有权成为该 lane 的结果。

通过后依次写入 canonical group/items/actions、聊天消息投影、认知状态/stance revisions、证据记忆任务、可选 compare job、group-based outbox、lane CAS、lineage CAS、turn CAS 和 commit receipt。任一步失败全部回滚。

#### 13.3.4 状态与任务的 authority key

由结果产生的所有附属写入都必须带 group authority：

- `cognitive_states.lastAuthorityGroupId` 并按 state revision CAS；
- `stance_records.authorityGroupId + authorityOrdinal` 唯一；
- `consolidation_jobs.authorityGroupId + authorityOrdinal` 唯一；
- `messages.authorityGroupId + groupOrdinal` 唯一；
- `cloud_deliveries.authorityGroupId + peerId` 唯一。

domain action 的外部执行不假装与 SQLite 物理事务同步；事务原子提交的是唯一授权 action row 和 outbox。消费者只按 `actionId` 幂等执行。shadow/compare worker无权调用本提交边界或任何动作消费者。

#### 13.3.5 Android fallback 的分布式权威边界

PC SQLite 与 Android Room 在断网时不能对同一 lineage 实现同步互斥；系统不得假装可以用两个独立数据库达成分布式 exactly-once。

双方共享版本化的确定性 lineage/group/message/action ID 算法和测试向量。Android 在提交 turn 时先持久化本地 lineage。PC 对协议传来的 lineage key 重新计算并要求一致，绝不直接信任客户端字段。

fallback 只在以下情况取得本地提交权：

- bridge 明确关闭，PC 请求从未发送；
- 所有远端路径都返回“明确未接受且允许 fallback”的终态。

连接超时、响应丢失和未知异常都属于“可能已被 PC 接受”，不得转成本地 fallback；它们保持 `BRIDGE_WAITING`，由 receipt/replay 恢复。这样牺牲模糊网络状态下的立即离线回复，换取不会出现 PC 与手机各生成一条的正确性。

本机 fallback 在一个 Room 事务中 CAS 本地 lineage，写入确定性 group、reply parts、结构化动作和 local receipt，authority origin 为 `android_fallback`，checksum 使用独立且版本化的 `android-fallback-commit-v1` 规范；PC 提交使用 `pc-visible-commit-v1`。同步恢复后，PC 只能把这个已可见 receipt 作为 external canonical result 导入：按其 payload version 验证相同 lineage/group/checksum，记录消息和 receipt，不运行 PC cognition、不写 PC state、不创建 outbox/通知。若 PC 已有不同 receipt，属于必须隔离的跨设备 authority conflict，不能选择其一继续显示。

#### 13.3.6 group-based outbox

旧 v1/v2 delivery 继续保留 `turnId + peerId` 兼容路径。所有 `resultAuthorityVersion=1` 的新结果只按 `authorityGroupId + peerId` 读取、租约、重试、确认和恢复；`turnId` 只是指向获胜 turn 的诊断字段。投递幂等键为 `groupId + peerId + commitChecksum`。因此 original/retry 即使有不同 turn ID，也不可能分别投递。

### 13.4 可见游标

Android 用户批次携带：

- 最近 `nativeCompleted` 虞栖消息组；
- 最近 `uiApplied` 虞栖消息组；
- 当前聊天页是否打开；
- 引用对象；
- 本地会话 sequence。

PC 不再以“已生成或已入云信箱”推测用户已经看见。

### 13.5 竞态语义

- 主动未提交：用户消息取代主动结果；
- 主动已入 outbox 未到手机：能原子撤销则撤销，否则等待真实交付状态；
- 已 `nativeCompleted` 未 `uiApplied`：直接回复必须把它作为即将可见前文；
- 已 `uiApplied`：按普通聊天顺序承接；
- 重启：从数据库 revision 恢复，不重新发送。

### 13.6 重复兜底

同一角色、私聊通道、相邻 revision 和短时间内，使用正文、动作目标和上下文 revision 形成 `generationFingerprint`。自动与直接结果指纹完全相同且前一条尚未稳定落地时只允许一个成为权威。不得跨普通时间窗口模糊删除合理重复短句。

被仲裁取消的回合不显示、不更新状态、不形成事实、不消耗普通 skip、不触发通知，也不计为模型质量失败。

## 14. 质量评价

### 14.1 两套语料

现有 270 例更名为协议回归集，只验证九种 TurnKind 的 schema、ID、目标、隐私、动作、恢复和迁移。

新增真人多轮质量集，来源：

- 真人聊天训练第一、第二、第四轮；
- 已确认真实失败；
- 相同失败结构的表面变体；
- 普通自然聊天对照。

### 14.2 规模

- 24 个核心哨兵场景，每个运行三次；
- 72 个覆盖场景，每个运行两次；
- 30 个本机真实历史场景；
- 每个新确认问题增加原场景和至少一个结构变体。

每个场景为 4—12 轮，包含时间、完整批次、base/phase、生活、立场和结构化上下文。

### 14.3 标注

```text
mustNotice
allowedDecisionRange
forbiddenFailurePatterns
requiredActionIntegrity
allowedPersonalityVariation
expectedStateTransitions
forbiddenStateTransitions
sourceAnnotation
severity
```

不固定唯一台词。

### 14.4 六个通用维度

1. 互动理解；
2. 人物主观性；
3. 关系参与；
4. 状态连续与弹性；
5. 自然表达；
6. 事实和动作完整性。

完整评价目录只用于离线评估。实时监督最多读取当前适用的三项。

### 14.5 证据层

1. 程序确定性检查；
2. 不知道版本身份的模型盲评；
3. 严重失败、评估分歧和功能抽样的人工复核。

### 14.6 离线上线门

- 270 条协议回归全部通过；
- 24 个核心哨兵无严重失败；
- 六维平均不低于 4/5；
- 不出现 1/5 的严重人物或关系错误；
- 候选相对稳定版明显更优不少于 60%；
- 明显退步不超过 10%；
- 结构化功能无回归；
- 真实历史不复现边界冻结、阶段声明和主动/被动重复。

平均分不能掩盖核心失败。

## 15. 稳定版、候选版与 rollout

### 15.1 版本化发布通道

把当前二元 `legacy/cognition` 对照升级为：

- `stablePipelineVersion`
- `candidatePipelineVersion`
- `stable`
- `shadow`
- `canary`
- `rollback`

shadow 时当前生产稳定版可见、v3后台；canary 时v3可见、稳定版后台；rollback 回到上一稳定版本。不得用更老 legacy 冒充当前稳定基线。

### 15.2 evidence epoch

cognition-v3 改变 schema、预设、适配器、状态、监督和评价器，因此全部 TurnKind 开启新 epoch。旧 shadow、canary 和报告不能支持新版本晋级。

pipeline checksum 包含：

- cognition/expression/supervisor schema 与预设；
- 状态和约束编译器；
- TurnKind adapter；
- model profile；
- 正式社会经验；
- evaluator；
- 当前稳定基线。

### 15.3 发布阶段

1. 离线候选：迁移、协议、质量、历史、竞态和 Android 兼容全部通过；
2. 真实 shadow：稳定版可见、v3后台；
3. DIRECT_REPLY canary：v3可见，前十个回合全部运行稳定版后台对照；
4. 逐 TurnKind 晋级：主动、朋友圈、安排和生活分别晋级。

低频功能没有真实样本时不能谎称稳定 active。实现完成与生产晋级分别报告。后续 PC rollout 不要求重新安装 APK。

### 15.4 自动回退

- 支付对象、公开隐私、非法阶段、重复动作等硬错误立即按 kind 回退；
- 双重评价确认的严重活人感失败进入质量熔断；
- 同一候选短窗口连续两次严重质量失败，回退对应 kind；
- 普通风格分歧只记录；
- 回退只影响新 turn。

## 16. 数据迁移

PC schema 分两步：

- 已完成的基础迁移为 `user_version 9 → 10`，提供 release、constraint、stance、lane 和 quality authority；
- 最终结果权威迁移为 `user_version 10 → 11`，提供跨 retry lineage、canonical visible group、commit receipt、显式 turn CAS 和 group outbox。

PC schema 11 与 Android Room 11 是两个彼此独立的数据库版本域，数字相同不表示共用迁移。

新增或升级：

- `constraint_records`
- `stance_records`
- `cognitive_state_v2`
- `interaction_lanes`
- `pipeline_releases`
- `quality_eval_runs`
- `quality_findings`
- `state_migration_audit`
- `turn_authority_lineages`
- `visible_result_groups`
- `visible_result_items`
- `visible_result_actions`
- `visible_commit_receipts`
- `turns.turn_revision` 与 lineage 字段
- `messages`、`cognitive_states`、`stance_records`、`consolidation_jobs` 和 `cloud_deliveries` 的 group authority 字段与唯一索引

步骤：

1. 快照数据库和配置并计算 SHA-256；
2. 事务内顺序运行历史迁移、v10 基础迁移和 v11 结果权威迁移；
3. 创建新表、nullable authority 列和 partial unique indexes，不删除旧表；
4. 所有迁移前已有 turn 标记 `resultAuthorityVersion=0`，不猜测或伪造历史 lineage/group/receipt；
5. 重新验证旧 `activeBoundaries`；
6. 用户明确边界迁移为硬约束；
7. 仍有效的虞栖态度迁移为短期立场；
8. 过期或证据不足内容进入审计；
9. 验证消息、事实、base/phase、安排、生活、turn 和 outbox 数量；
10. 验证所有 `resultAuthorityVersion=1` turn 都有唯一 lineage，所有 committed lineage 都能联结唯一 group/receipt/outbox；
11. 生成前后对照报告。

迁移必须事务化、幂等。现有 v10 数据库必须真实执行 10→11，不能只修改 9→10 分支。旧 turn 继续按 `resultAuthorityVersion=0` 的固定旧 schema 和旧 outbox 恢复；新 turn 才使用 v3 canonical authority。任何无法证明来源的历史结果不得反向合成 v3 receipt。

## 17. Android 与正式发布

正式 APK 必须支持：

- v3 fallback snapshot；
- v1/v2向后读取；
- nativeCompleted/uiApplied 可见游标；
- lane revision 和权威消息组；
- 事件、轮询和 replay exactly-once；
- v3诊断和自动回退状态。

PC 完成的结果中，Android 的 `visibleGroupId`、`commitChecksum`、`authorityLineageKey` 和 authority revisions 必须逐字来自 PC `visible_commit_receipts` 及其联结记录。本机 fallback 的同类字段必须来自 Room local receipt，并按共享版本化算法生成。Room/Web 不得从正文、当前时间或临时随机数重新生成这些字段；同一 lineage 收到不同 receipt 时必须隔离为协议冲突，而不是覆盖。

实施时读取源码、发布清单和现有产物中的最大版本，使用下一个未占用版本；按当前产物应高于 1.0.108，但不得仅凭本设计硬编码。

同步：

- Gradle versionCode/versionName；
- Service Worker cache；
- GitHub Actions；
- OTA manifest；
- 下载地址和文件 checksum；
- PC runtime 兼容范围。

遵循 `docs/AL-android-signing-runbook.md`，核对包名、覆盖安装、签名有效性、正式证书 SHA-256 和 APK SHA-256。调试、未签名或临时证书包不得交付。

## 18. 回滚

保留：

- 上一稳定认知管线；
- 上一正式 APK；
- 迁移前数据库快照；
- 每个 kind 的 rollout 状态；
- 全部 preset/schema/evaluator checksum。

回滚停止候选影响新 turn，但不删除审计记录，不撤回已合法提交的聊天和动作。

## 19. 中控停止协议

中控遇到以下任一情况必须立即停止：

- 设计字段与现有数据库不兼容；
- 某功能没有明确 adapter；
- 无法判断旧边界来源；
- v3 与 Android fallback 语义不一致；
- 当前稳定版无法成为真实对照；
- 质量语料仍为占位文本；
- 验收证据无法自动生成；
- 版本或正式签名冲突；
- 继续需要绕过质量门；
- 修改将破坏其他既有功能契约。

反馈必须包含：

- 停止任务；
- 代码和数据证据；
- 冲突的设计条款；
- 已完成和未完成状态；
- 影响功能；
- 可行修订方向；
- 是否已经修改生产代码。

中控不得自行降低标准、伪造样本或在发现结构问题后继续生成正式版本。

## 20. 最终完成标准

只有同时具备以下证据，才能宣告本次任务完成：

- 权威设计和实施计划；
- 数据迁移报告；
- 270 条协议回归报告；
- 真人多轮质量报告；
- 主动/被动竞态报告；
- 各 TurnKind rollout 状态；
- 自动回退演练；
- Android fallback 测试；
- 完整项目回归；
- 正式签名 APK；
- OTA 发布；
- 覆盖安装验证；
- 稳定版与候选版状态说明；
- 未达到 active 的功能如实列出。

首次正式 APK 可以完成协议、fallback、可见游标、并发仲裁、诊断、自动回退和 DIRECT_REPLY 候选启用。没有真实低频样本时，其他功能可以完成实现并运行 v3 shadow，但不能冒充已经稳定 active。

## 21. 明确不做

- 不针对红包、亲亲或某句原话写生产特判；
- 不把所有评价类别加入实时提示；
- 不强迫虞栖接受示好或永远温柔；
- 不把用户满意等同于人物质量；
- 不删除 legacy、当前稳定版或 Android fallback；
- 不覆盖用户编辑的人设、阶段、手工记忆和安排；
- 不顺带重写非虞栖角色；
- 不在没有真实证据时宣布全部 active；
- 不以模型自评代替人工批注和确定性检查。
