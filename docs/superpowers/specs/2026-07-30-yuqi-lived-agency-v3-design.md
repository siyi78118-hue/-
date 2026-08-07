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

证据输入同时闭合 message 与 action：message 使用原生字符串 ID 数组以及与其一一
对应、无额外字段的 `{messageId,speakerId,text}` 原句；action 使用原生字符串 ID 数组
以及 action ID、kind、target、revision、payload 与 checksum 的完整 canonical
projection。两者不得互相伪装，未知/缺失/重复/类型强转/跨 group 的引用整条候选
拒绝。候选身份、对象、置信度、承诺双方和 store-owned provenance 也必须按闭合原生
类型验证，模型不能自行填写或改写 `origin/evidenceSource/authorityContractVersion`。
`user_fact` 只能由 user message 支撑；character message 或 visible action 只有在同 group
delivery receipt confirmed 后才可作为已成立证据。`action_only` 只在动作自身能直接证明
候选时开门：生活事实仅接受同角色的 `life_episode_*` 权威动作；正式承诺动作必须携带
与 `promisedBy` 精确一致的闭合行动者证明。混合 message/action 仍逐项执行同一约束，
不能用一个合法 message 掩护无关 action；`skip` 没有任何事实证据。

不得写入潜台词、当前心情、临时立场、推测用户性格、监督评价、未送达草稿和模型推导的硬边界。

## 11. 生活系统

生活规划使用相同人物基础和状态语义，但保持独立会话、持久 attempt、固定 basis checksum 和单并发 dispatcher。

生活规划不是对既成事实的记忆抽取，模型也不是生活事实的证据来源。它的唯一输入证据权威是创建 attempt 的同一事务从数据库固定的六元组：`roleId`、`planningWindowStartAt/planningWindowEndAt`、`lifeBasisChecksum`、`contextChecksum`、`inputChecksum` 和 `requestBaseKey`；其中 `requestBaseKey = contentHash({roleId,startAt,endAt,lifeBasisChecksum,contextChecksum})`，`inputChecksum = contentHash(inputSnapshot)` 独立校验，rollout/release/epoch/canary pins 继续作为独立执行权威，不能被结果覆盖。其中 `inputSnapshot.roleId/planningWindow` 必须与 attempt 列完全相等，即使攻击者同步重算 snapshot/checksum/request key 也不能改变；`current/recent/upcoming` 中出现的每个生活 episode 都必须是当时 store 中同角色、同 ID、同 checksum 的真实行。结果不得携带或借用模型自报的 `evidenceIds/sourceMessageIds/usedFactIds` 等字段，也不得把聊天消息、未送达草稿或生成文本冒充生活 basis。

首次结果提交必须在 authoritative result 的同一个 immediate transaction 中重新闭合上述输入 tuple、重算当前 pre-write life basis、校验 result 顶层精确只有 `episodes`，然后才写 episode、可选的嵌套 `publicMomentCandidate`、compare job 和 attempt 终态。terminal exact replay 不得在新 episode 已经写入后重算 pre-write basis；它以持久 input tuple 作为历史证据 commitment，重算 input/context/request checksums，并闭合校验已存 result、每条 output episode 的 ownership/checksum/source planning ID、compare job 和终态后返回原结果。changed result、伪造 evidence 字段、损坏 input tuple 或缺失/篡改 output projection 一律零写拒绝。

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

从已持久且明确标记为 `public-moment-candidate-v1` 的 completed life episode 形成公开内容。Task 18 先把该 marker 设为 reserved key：普通 life-plan、聊天调整、导入恢复和外部 caller 一律不能写；Task 19 只有在 authoritative life result 通过闭集校验后，才由 `commitLifePlanningResultInternal()` 在同一事务使用私有 trusted writer 写入。PC 在 fresh canonical turn 的 immediate transaction 中重建并固定 `publicMomentAuthority`；调度、caller 传入的 `lifeEvents`、episode title、任意 payload、私聊记忆和模型推断都不是公共事实源。没有仍有效且未消费的 public-safe candidate，或存在明确 public-moment hard constraint 时，在模型、图片和外部调用前提交 canonical skip。

公开模型调用是一条独立的数据流：不读取私聊历史、支付、关系 base/phase、私有事实、私有 stance/preference、私有安排或普通记忆检索，只读取固定的 public candidate、public boundary、公开人格设置和公开 social lesson。public boundary 是代码生成的 exact literal `{version:'public-boundary-v1',visibility:'public',recipientId:'public_moments',allowPrivateChatContext:false,allowPaymentContext:false,allowRelationshipContext:false,allowPrivateMemoryContext:false}`，不读取或合并 caller 字段。该边界保证持久私密数据不会进入公开模型输入；它不虚假承诺能够从语义上证明模型永远不会幻觉出任意一句不当文本。结构化 payment、relationship 和 private-plan action 在 commit 前一律拒绝。

可见公开结果用 kind-specific `pc-visible-commit-v4` 保存 `publicMomentEvidenceIds`；发送引用一至三个 pinned ID，skip 引用空数组。live committed manifest 是消费事实，redacted group 不保留或重建语义 ID。

### 12.4 `MOMENT_INTERACTION` / `MOMENT_REPLY`

读取 authenticated Web/Android trigger 中闭合、规范化的 exact public target snapshot。wire-v3 只接受 `targetMoment`/`targetComment`，拒绝 generic snapshot 与旧 `moment/playerComment/replyToCommentId`，也不从它们补全或合并 canonical target；旧字段只留在 wire-v2 兼容路径。PC 将 moment、comment 和 thread 固定为 `momentTargetAuthority`，并把其 checksum 纳入 generation fingerprint；模型只能决定点赞、评论、回复或不动作，不能改变目标、作者、线程、公开边界或 action target revision。`MOMENT_REPLY` 的 target comment 必须逐字段存在于 target moment 的 comment list 且由玩家发送；同一 moment 串行，不同 moment 可并行。

like/comment/reply 是零聊天 item 的 `action_only` canonical result；skip 是零 item/零 action；主动朋友圈 post 才生成 `public_moments` visible item。wire-v3 找不到 exact UI target 时 fail closed，不创建 virtual moment，也不记录 UI-applied；legacy v1/v2 virtual fallback 保持兼容。`ROLE_PLAN_MOMENT_PRIVATE` 中的 `PRIVATE` 表示安排来自 private-decision source，公开受众语义不变，因此仍属于 public moment lane，并继续接受同一 public boundary。

### 12.5 角色安排

覆盖：

- `ROLE_PLAN_CHAT`
- `ROLE_PLAN_MOMENT`
- `ROLE_PLAN_CHAT_PRIVATE`
- `ROLE_PLAN_MOMENT_PRIVATE`
- `private_message`
- `moment_post`
- `role_schedule`

认知决定接受、修改、暂停、恢复、取消和完成。可见正文与 operation 必须一致；时间不明确时不得猜测。这里不靠正则从自由正文反推“三点还是四点”，也不接受模型自报 presentation proof。对于 `DIRECT_REPLY` 中来源为 `spoken/accepted_request/user_created`、确实会改变安排且必须向用户确认的 canonical operation，代码先完成 closed domain、target、revision、evidence 和 explicit-time 校验，再由纯 `renderRolePlanConfirmation(operation,targetSnapshot,'Asia/Shanghai')` 生成完整确认正文；模型自由 reply 不能参与或覆盖这句确认。确认正文、action set、target snapshot 和 generation fingerprint 在同一 visible commit 中固定；多 operation 按 canonical ordinal 逐条渲染。时间非 explicit、renderer 不支持、混入 private decision 或 operation 相互冲突时整组 fail closed，经正常 repair 形成不带 action 的追问，不得保留猜测后的 action 或矛盾正文。

`private_decision` 和四种 `ROLE_PLAN_*` 自动执行 lane 不属于“用户请求的安排确认”，不套用上述 renderer。尤其 `ROLE_PLAN_MOMENT`/`ROLE_PLAN_MOMENT_PRIVATE` 始终是 public-moments 语义；`PRIVATE` 仅表示计划来源，不能把公开动态改写成私聊确认。v1/v2/RA0 保持旧投影，renderer 只约束 v3 的用户可见安排变更。

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

新 APK 支持 cognition-v3 精简快照，同时读取 cognition-v2 和 memory-v1/chat-v1。fallback 读取相关硬约束、当前立场、关系阶段和最近完整对话。PC 恢复后不重写已显示结果，fallback 事实只进入待复核记录。v3 只有在请求明确没有被 PC 接受时才可 fallback；超时、丢响应和未知异常保持 receipt/replay 恢复，五分钟后转为可重试错误，不能用第二份本机生成结果掩盖权威不明。automatic fallback 的合法 skip 也必须形成本地 group identity 和 terminal receipt，但不得创建 reply part、action、通知或占位正文；direct fallback 不能 skip。

`cognition-v3` 精简快照只描述角色当轮可用的认知语义，不承载 API 配置、system prompt 或模型 messages。本机执行所需内容使用独立闭集 `cognition-v3-fallback-v1` 载荷，并随同一 turn 在 Room 中持久化；该载荷还固定包含 Web 已生成并持久化的稳定 `deviceId`，不能在 fallback 或重启时临时随机生成。若本机桥接配置中已有非空 deviceId，它必须与载荷一致，即使配置处于 disabled。本地载荷不进入 cognition snapshot 的语义 checksum，也不得进入发往 PC 的 v3 envelope、外部 receipt 或诊断。为避免新增一个会漂移的数据库列，持久化的 `snapshotJson` 是本机 submission container：它由 compact cognition 的闭集语义字段和唯一保留键 `fallbackExecution` 组成。Android 必须先拆分并分别闭集校验，不能把整个 container 当成网络快照。直聊 envelope 只保留现有闭集 currentBatch/payment/retry/cursor 与另行提供的协议合法 scene，不能把 cognition-v3 对象硬塞进 `context.scene`；自动任务可在 `trigger.context.snapshot` 携带移除 fallbackExecution 后的 compact semantic view。两条路径都在 hash/上行前移除本地 device/config/system/messages。v1/v2 的旧 `packetType` 只保留为兼容读取，所有 v3 分流以闭集 `contract` 为准。

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

PC 数据库新增 `turn_authority_lineages`。每条 lineage 由 `roleId + laneKey + rootSourceId` 唯一确定，保存 `latestTurnId`、显式整数 `revision`、`open/committed/cancelled` 状态和唯一 `committedGroupId`。首个 canonical-authority turn 创建 lineage；重试必须复用前一 turn 的 lineage，并用 compare-and-swap 把 `latestTurnId` 从被重试 turn 改为新 turn。两个 sibling retry 不能同时取得提交权；lineage 已提交时不得再生成新 retry，只返回已有 receipt。

`turns` 增加：

- `resultAuthorityVersion`：所有旧创建入口和历史 turn 为 0；只有 `createCanonicalVisibleTurnInternal()` 创建的 turn 为 1；
- `authorityLineageKey`；
- `lineageRevisionAtCreation`；
- `turnRevision`；
- `retryOfTurnId`；
- `agencySnapshotChecksum`。

`updatedAt` 只用于诊断和排序，绝不用于并发判定。result-authority-version-1 turn 的 claim、checkpoint、supersede、failure 和 commit 都必须使用显式 `turnRevision` compare-and-swap。

wire protocol 版本与 PC 内部结果权威版本是两个独立维度：

- `protocolVersion` 只描述 Android/PC 传输 payload；Task 10 实施时现有 wire 仍为 v2，Task 13 才增加 v3；
- `resultAuthorityVersion` 只描述 PC 如何提交最终可见结果，不能由 envelope 字段、客户端版本或模型输出自行选择；
- 现有 `submitTurn()`、`createTurnWithRolloutInternal()` 和 `createTurnWithReleasePinInternal()` 保持兼容语义，始终创建 `resultAuthorityVersion=0` turn；
- Task 10 新增唯一内部入口 `createCanonicalVisibleTurnInternal()`，它的调用本身才选择 `resultAuthorityVersion=1`；
- Task 11 是该入口的第一个生产调用方，只为新建、非恢复、虞栖、wire v2/v3、进入新版 release-pinned lane/atomic-commit 编排的 turn 调用；旧 turn、wire v1、非虞栖和所有旧调用方继续走 version 0；
- Task 13 的 wire v3 `authority` 只是需要被 PC 重新计算验证的客户端 claim，不是开启 canonical authority 的开关。wire v2 没有 claim 时，Task 11 仍可由 PC 内部推导同一 lineage。

`createCanonicalVisibleTurnInternal()` 必须在一个事务内完成 turn、lineage 和 lane claim；不得先调用旧创建 API 再把 turn patch 成 version 1。它只接受 store-owned release/lane/agency 参数和已标准化 envelope，拒绝任何调用方直接传入 `resultAuthorityVersion`。

创建事务还必须用 rollout revision 做 CAS，重新读取并核对 stable/candidate release pair，再从不可变 release 记录固定 checksum 与 preset；调用方不能借参数自行选择 release。`generationFingerprint` 依赖尚未生成的可见 draft/action，因此创建时必须为 null，只能在 canonical result 提交事务中根据已授权输出和 agency/context revision 重新计算，并同时写入 turn 与 visible group。

release pair 的阶段投影只有一个实现：Task 11 建立不依赖 store/controller/orchestrator 的纯 `release-pair.mjs`，`PromotionController` 只委托它，fresh turn 创建事务和 fresh life-planning attempt 创建事务也调用同一个函数重新解析。orchestrator 的预读只用于选择将要请求的 release；store 在 `BEGIN IMMEDIATE` 内用 rollout revision CAS、当前计数和不可变 release row 再次证明该 pair。resolver 只决定 visible/comparison release identity 与方向，不擅自推导兼容 `pipeline_mode`；store 还必须验证 `current_mode/rollout_phase/candidate_phase` 投影，并允许毕业后的 `active/stable/none`。retry/open attempt 恢复只认自身持久 pins，不重新解析当前 rollout。Task 23 只增加 candidate 注册、阶段迁移、晋级、熔断和回退，不能再实现第二份 phase switch。

comparison 在持久层有三个名字不同、用途不同的域，不能互相直接比较：

| 域 | fresh version-1 合法值 | 权威用途 |
|---|---|---|
| compatibility mode | `none` / `cognition_compare` / `legacy_compare` | 既有 `turns.comparison_mode` 与 life `comparison_mode` 的数据库调度投影 |
| release direction | null / `stable_authoritative_candidate_compare` / `candidate_authoritative_stable_compare` | canonical commit、comparison job payload 与 life `comparison_direction` 的 release 语义 |
| job type | null / `shadow_cognition` / `active_canary_compare` | 后台 worker 操作 |

Task 11 必须建立独立、无 store 依赖的 `comparison-contract.mjs`，以一个冻结闭集提供 `comparisonContractForDirection()` 与 `comparisonContractForMode()`。stable-visible candidate compare 的三元组固定为 `cognition_compare + stable_authoritative_candidate_compare + shadow_cognition`；candidate-visible stable compare 固定为 `legacy_compare + candidate_authoritative_stable_compare + active_canary_compare`；无对照固定为 `none + null + null`。store 创建、canonical commit、orchestrator job draft、life attempt/result 与 compare worker 全部调用这一份契约，不得各自复制 Map 或用字符串包含关系推断。

`turns` 没有也不新增 `comparison_direction` 列；v14 的唯一 schema 变化仍是 retry-safe canary slot indexes。fresh canonical turn 只在 `turns.comparison_mode` 保存 compatibility mode；release-aware direction 保存在 canonical commit semantic payload 与 comparison job descriptor。life attempt 因已有两列而同时保存 compatibility mode 与 release direction，并必须通过同一三元组自洽。`commitVisibleResult()` 的未提交路径先用持久 turn mode 解析三元组，再精确核对顶层 `comparisonReleaseId/comparisonDirection`、job type、job payload direction 与 pinned turn release；`none` 必须同时没有 comparison release、direction 和 job。任一把 `cognition_compare` 当方向、把 release direction 写进 `turns.comparison_mode`、交叉配对 job type、使用不同顶层 release，或在 version-1 路径使用历史 alias 的输入，都必须在任何结果写入前失败。已提交 exact replay 仍按既有 canonical payload checksum 验证并返回原 receipt，不建立第二套 replay 语义。

fresh version-1 authority 的 comparison direction 固定使用 release 语义：
`stable_authoritative_candidate_compare` 或
`candidate_authoritative_stable_compare`。旧
`legacy_authoritative_cognition_compare` /
`cognition_authoritative_legacy_compare` 只作为已持久化 version-0
job/attempt 的只读兼容别名。compare worker 必须联合校验
`jobType + direction + subject authority version + release IDs/checksums`；
不能仅凭字符串包含 legacy/cognition 判断 shadow/canary，也不能让新任务继续写旧别名。
canonical compare job 不因此扩大 Task 10F 已封闭的 semantic descriptor：worker
必须沿 `authority_group_id` 连接 receipt/group/turn 取得 rollout 与 release pins；
life job 则连接 `planning_id` attempt。不得要求 descriptor 中不存在的 rolloutKey/
pipelineChecksum，也不得拿兼容 rollout.pipeline_checksum 代替 stable/candidate
release checksum。旧 version-0 job 才允许继续读取历史自包含 payload。

release ID 到实际执行器也只有一个 Task 11 `ReleaseExecutor`：它以不可变 release
row 的精确 pipelineVersion 选择 legacy-v1、cognition-v2 或 cognition-v3 adapter，
authoritative turn、authoritative life planning 和后台 compare 都通过它。未知版本或
checksum 不符在 model call 前失败；compare 使用 dry-run capability，不能借旧
`comparisonPipeline` 字符串或 mode 分支绕开写权限。redaction 在 claim 前后都能使
worker 只做 metadata-only cancellation，绝不重新装载已清除正文。

“只有一个执行器”是进程级实例约束，不只是 class 或静态 Map 相同。Task 11 新增无启动副作用的 `runtime-composition.mjs`：它先构造尚未对外暴露的 orchestrator，再从 orchestrator/cognitive pipeline 的明确 draft provider 建立完整六项 production adapter set，构造一个 `ReleaseExecutor`，以一次性 `attachReleaseExecutor()` 绑定 orchestrator，然后把同一对象传给 life-planning 与 shadow dispatcher。factory 返回之前必须证明 turn/life 两张 adapter map 都精确含 `legacy-v1`、`cognition-v2`、`cognition-v3`；缺失、额外、重复或错误接口立即拒绝。`main.mjs` 只调用该 factory 一次，且只在成功返回后创建 server/cloud pump、recover、timer 与 worker；任何 consumer 内部 `new ReleaseExecutor()` 都是结构违规。

六项 adapter 的权威来源固定：legacy turn/life 从现有 orchestrator 行为中抽出“只生成并验证 draft、不到 commit”的 provider；cognition-v2 turn 使用 CognitivePipeline 的显式 v2 draft provider；cognition-v3 turn 使用已完成的 v3 envelope/contract/supervisor provider；v2/v3 life provider 使用各自 pinned release/preset/schema，而不是 `authoritativePipeline` 布尔值或 current preset。所有 provider 都收 `{release,execution,dryRun,capabilities}`。authoritative adapter 可以写 canonical attempt checkpoint，但 visible group、action、state/fact/memory/outbox/notification 仍由外部 authority transaction 提交；dry-run 连 checkpoint/legacy stage writer 都不能写。现有 `runShadow() → runForeground()` 会持久化 cognition checkpoint，不能作为 version-1 compare 实现；Task 11 必须给 v2/v3 增加显式无写 draft 入口并用 throwing write spies 证明。legacy version-0 recovery/comparison 可保留独立、明确命名的兼容入口，但只有在读取持久 authority version 后才能选中，fresh work 永远不可到达。

adapter provider 只返回规范化 draft 本体；`ReleaseExecutor` 自己附加 `{adapterId,releaseId,releaseChecksum,draft,dryRun,capabilities}`，不能信任 provider 自报 release 身份。life dispatcher 只把其中 `draft` 交给权威结果校验和提交。

由于 legacy draft provider 复用 orchestrator 的既有请求构造逻辑，composition 允许一个受控的构造环：先建 orchestrator、后建完整 executor、再一次性 attach。attach 前 canonical accept/run/life 必须 fail closed，第二次 attach 必须拒绝；factory 在 attach 完成前不返回对象，因此生产服务不存在可观察的半装配窗口。部署契约除了检查 main 使用 factory，还要做真实对象身份断言：orchestrator、life dispatcher、shadow dispatcher 持有的必须是 `===` 同一个 executor。

canary 的 `canary_started_count` 专指已经原子分配的后台对照 subject，而不是所有 candidate-visible subject。每个 rollout key 各自把前十个 subject 固定为 candidate 可见、stable 后台、slot 1–10；第十一个及以后在观察期内仍可使用 candidate 可见，但 `comparisonReleaseId/canarySlot` 为 null，不能继续增加 started count。turn 与 life planning 共用同一套 per-key 持久计数规则、最多三个 outstanding 和十五分钟 deadline，但绝不跨 TurnKind 共用一个计数器；retry 继承 parent slot/pair，不能再次占位。超时/积压使用控制器运行时钟和持久 subject/attempt 占位时间，不使用可被历史回放、延迟投递或 compare-job 延迟创建影响的消息/触发时间。deadline 过期始终阻止新的 canary subject；outstanding 上限只在本次还会占新对照 slot 时阻止，十个 slot 已满后允许无新对照的 candidate-visible subject 等待未超时旧任务收尾。

`LIFE_PLANNING` 虽不创建 chat turn/group，也必须在 attempt 创建事务中固定与其他 TurnKind 相同的 `authoritative_release_id`、`comparison_release_id` 及双方 checksum。恢复时先返回已有 open/exact attempt 及其原 pins，只有 fresh attempt 才读取当前 rollout 并占新 slot。compare job 只能在 authoritative life result checksum 已形成的提交事务内创建，并复制 attempt 已固定的 release identity；attempt 创建阶段不得先建 job。每个已占 slot 的 turn/life subject 必须最终且仅一次计入 completed 或 failure；权威管线在 compare job 建立前发生可重试失败时继续保持 outstanding，只有明确终止/取消才计 failure，不能因漏记而永久挂住。

这里的 turn canary subject 是整条 canonical lineage，不是每个 retry attempt。v13
遗留的 `UNIQUE(rollout_key, canary_epoch, canary_slot)` 索引会阻止 retry 持久化相同
slot，因此 Task 11 将 PC schema 升到 v14：不重写任何语义行，只把唯一约束限定到
`retry_of_turn_id IS NULL` 的 root turn，并增加 lineage-slot 查询索引。store 与 reopen
invariant 继续要求同 lineage 的所有 retry 精确继承 root 的 epoch/slot/release pins，
同时禁止两个 root owner 共享 slot。v13→v14 必须先验证 v13 全部语义 invariant 和
当前 canary 计数，再在单事务内换索引、验证、最后写 user version；任何故障或
不一致源都保持 v13 原样。

canary outstanding 的权威读按 rollout key/epoch 从 root lineage 与 life attempt
枚举 allocation，不能把 retry 当成第二个 subject，也不能扫描未按 rollout 过滤的
全局 compare job。`started = completed + failure + outstanding` 是 reopen/selection
共同 invariant；oldestAt 取原始 slot 占位时间。retryable failure/retry_wait 不终结
subject；lineage 取消、life terminal failure、comparison 成功/critical/permanent
failure 才在同一事务中且仅一次关闭计数。Task 11 以后 PC 最新 schema 为 v14；
Android Room 的版本号仍独立。

上述 rollout CAS 适用于 fresh original。version-1 retry 必须继承 parent turn 已固定的 rollout/release/checksum/comparison/preset，不得因期间发生晋级或回退而换模型；version-0 parent 的 retry 仍走旧兼容路径，缺失或损坏 parent 时停止而不是伪造 canonical lineage。相同未提交 turn 的 exact replay 不重复增加任何 revision；lineage 已提交时返回原 receipt，不受当前 rollout 变化影响。

retry 继承的是模型与输入的不可变 pins，不是已经过期的 agency head。若 open parent 因 `AGENCY_AUTHORITY_STALE` 失败，显式 retry 必须在同一个创建事务内重新读取当前 agency snapshot，核对调用方的乐观 checksum，并把新 checksum 固定到 retry attempt；它允许与 parent 不同。否则“新 checksum 因不等于 parent 被拒绝、旧 checksum 又因不等于当前 snapshot 被拒绝”会使 open lineage 永久不可恢复。exact same-turn replay 仍逐项核对该 attempt 自己持久化的 agency checksum；committed lineage 仍在完整 immutable input/parent/lineage 校验后直接返回原 receipt，不读取当前 agency heads。

store 必须独立重算并核对 `roleId=yuqi`、`rolloutKey`、`laneKey`、`rootSourceId` 和 `inputUserBatchId`，不能把调用方传值当作路由权威。wire v2 没有 visibility cursor 时只允许等于持久 lane snapshot，不能借一个更大的数字推进游标；wire v3 到 Task 13 验证 cursor 后才允许单调前进。retry 必须逐项复用完整 normalized current batch，包括此前气泡、attachment、顺序和时间，不能只比较最后一条正文。

canonical authority 不是一个只约束最终 commit 的新 API，而是对所有旧 mutation entrypoint 的封闭权限域。`claimTurn*`、turn stage/checkpoint、failure/requeue、lane supersession、user cancellation、failed-draft recovery 和 legacy delivery helper 遇到 version-1 turn/group 时，必须调用带 `turnRevision/lineageRevision` CAS 的 canonical API，或在写入前明确拒绝；任何旧方法都不能绕过 lineage/group authority。failure 保持 lineage open 供显式 retry，cancellation/supersession 把 open lineage CAS 为 cancelled，committed lineage 永远不可变。

“调用方传入 `expectedState=committed`”不是修改已提交 turn 的授权。所有 canonical route/stage/checkpoint/failure/state writer 必须在同一个 `BEGIN IMMEDIATE` 中同时证明 lineage 为 `open`、该 turn 是 `latestTurnId`、receipt/group 尚不存在、当前 state/revision 匹配，并且 transition 位于显式白名单。通用 advance 只允许工作流前进边：`memory_running→memory_done→brain_running→brain_done→supervisor_running→approved`；`queued→memory_running` 只由 claim，`approved→committed` 只由唯一 commit transaction，`*→failed` 只由 failure API，`failed→checkpoint` 只由专用 requeue。任何 writer 都不能把 `committed/delivered/completed/cancelled-lineage` 改回可执行状态。

`agencySnapshotChecksum` 也不是调用方自报的摘要。store 在 canonical turn 创建事务内读取该角色所有 active constraint heads、当前 cognitive state 指向且仍为 verified/retrievable 的 `stable_preference` facts、当前 active stance heads，以及 cognitive-state revision/checksum，按稳定 ID/revision 排序后形成 `agency-authority-v1` snapshot。缺失、被压制或类型不符的 preference fact 使 snapshot 构造失败，不能静默丢掉。调用方只可提交预读 checksum 作为乐观期望；store 必须重算、核对、持久化其 checksum，并把同一 snapshot 返回给本轮 agency view。open turn 恢复时若当前 snapshot 已变化，不得拿新状态冒充旧输入继续生成，而是记录 `AGENCY_AUTHORITY_STALE` 并通过显式 retry 固定新 snapshot；已 committed 的 exact replay 仍直接返回原 receipt。

current stance 使用一个稳定 `stanceId` 的 append-only revision 链。maintain/strengthen/soften/reverse 写入同一 `stanceId` 的 `revision+1` head；expire 写入同一链的 terminal head；create 才产生新 `stanceId`。下一 head 的 `supersedes` 固定写成 `<stanceId>@<previousRevision>`。旧 row 永不原地改写。`listActiveStances()` 只读取每个稳定 ID 的最大 revision，因此不能用一个新 stance ID 加“supersedes”却把旧 active head 留在查询结果中。

#### 13.3.2 唯一终态结果与 receipt

PC 数据库新增 canonical 记录：

- `visible_result_groups`：沿用既有表名，但语义是“一次 canonical terminal result group”；一条 lineage 最多一个 group，一条 authoritative turn 最多一个 group，并标明 `pc` 或 `android_fallback` authority origin。普通回复包含 item，朋友圈/结构化互动可只有 action，automatic 合法 skip 可以两者都为 0；
- `visible_result_items`：按 `groupId + ordinal` 唯一保存可见气泡；
- `visible_result_actions`：按 `groupId + ordinal` 唯一保存已授权结构化动作；
- `visible_commit_receipts`：以 `lineageKey` 为主键，唯一关联 group、authoritative turn、authority origin、`commitPayloadVersion` 和 `commitChecksum`；
- `visible_result_manifests`：以 `groupId` 为主键保存该 origin/payload version 的完整规范化语义 payload 及 checksum，作为 receipt 与所有可变查询投影之间的重启校验锚点。正常状态下 `semanticJson` 非空且 `redactedAt` 为空；执行既有“清除聊天”隐私操作后，两者必须原子变为 `semanticJson=null + redactedAt=<time>`，只保留 checksum/identity 审计壳。

group ID 和气泡/action ID 由当前合法 authority owner 按双方共享的版本化算法根据 lineage 与 ordinal 确定性生成，不接受模型输出、当前时间或临时随机 ID。PC `commitChecksum` 对规范化语义 payload 计算，包含 lineage、可见气泡、动作、状态 patch、记忆任务的 allowlisted 语义 descriptor、可选 compare release/direction/epoch descriptor、release、输入可见游标和生成时权威 checksum；Android fallback 使用另一个明确版本的规范 payload。两者都排除 attempt `turnId`，以及 job payload 内嵌的 turn/worker/job ID、due/created 时间、随机数和非语义日志。不同 retry attempt 产生完全相同的语义结果时 checksum 必须相同；真正的语义变化才改变 checksum。重复提交只有 origin、payload version 和 checksum 全部相同时才返回同一 receipt；同 lineage 的不同 payload 一律是 authority conflict。

“没有气泡”不等于失败或没有 authority。canonical version-1 turn 的唯一持久
kind anchor 固定复用现有 `turns.rollout_key`，逻辑名为 `turnKind`；不得新增一个
会与它漂移的 `turn_kind` 列，也不得在 redaction 后从
`envelope_json`、item/action remainder 或 reply projection 推断。创建事务必须由
已验证 `envelope.kind` 推导 `rollout_key`；retry 必须继承相同值；v12→v13 source
validation 必须在任何 commitment 回填前证明两者相等且属于下面九种
canonical turn kind。清除聊天保留这个非敏感 anchor。store 使用该持久 anchor 与
规范 payload 共同判定 terminal disposition：

- `DIRECT_REPLY` 只能是 `visible`，必须至少有一个非空 item；
- 任一 automatic kind 有 item 时是 `visible`，无 item但有 action 时是
  `action_only`；
- automatic kind 的 item/action 都为 0 时是 `skip`，仍必须原子形成
  group/manifest/receipt、comparison descriptor 和必要的 PC→Android terminal
  delivery，但不得形成消息、通知、可执行 action 或以未发送草稿为 evidence 的
  memory/consolidation job；允许提交本轮合法的认知状态 patch 和 dry-run compare；
- `LIFE_PLANNING` 不借零 item group 冒充生活规划提交，继续使用独立的 two-phase
  attempt/result authority。

`terminalDisposition` 是 receipt/group/turn join 后的确定性投影，不是模型可提交的新
自由字段，也不升级既有 `pc-visible-commit-v1/v2` checksum 版本。这样既能保留
automatic skip 的成功终态，又不会把 direct reply 的空输出误判为合法沉默。

`messages` 只是 group items 的聊天查询投影；`turn.replyJson` 只是兼容投影。action rows、memory/compare jobs、state/stance rows也都是 manifest 授权语义的执行或查询投影。它们都不能反推出新的 group ID、manifest 或 receipt，也不能成为第二事实源。

PC schema v12 引入 `visible_result_manifests`。v11→v12 只允许在不存在 canonical group/receipt 的数据库上自动前进，因为旧 v11 没有保存足以无损重建 state patch 与 job descriptor 的完整规范 payload；发现已有 v11 canonical 结果却缺 manifest 时必须在任何写入前隔离并报告，不能猜测、回算或悄悄给旧 receipt 盖新 checksum。Android Room 的 schema 版本独立，仍按其任务规定演进，不能因 PC user_version 变为 12 而同步改号。

manifest 不能破坏已有数据生命周期。“清除聊天”必须在取消未投递 delivery 后，同时清除 manifest semantic JSON、item/message 内容和 action payload，把 group/manifest 标成同一 redaction 时间；receipt/checksum、确定性 ID、origin 和最小审计壳保留。redacted group 不再可投递、执行 action、重放正文或参与生成上下文；reopen invariant 验证完整 redaction shape，而不是要求已清除内容仍能重算原 checksum。backup/export、角色删除和导入必须把 manifest 纳入与 group/receipt 相同的 FK 顺序与冲突规则。

Task 10E 的独立复核证明 v12 只能作为过渡格式，不能作为最终隐私生命周期格式：v12 的 item/action 语义列为 `NOT NULL`，而旧 v11 兼容 invariant 又把每个 group 错误地限定为至少一个 live item，因此既无法合法表示“保留确定性 ID、清除正文与动作 payload”的 audit shell，也无法承载后续 automatic canonical skip。PC schema 必须继续升到 v13；v13 source migration 仍可要求历史 v12 group 至少一个 item，因为 Task 11 尚未开始、v12 从未合法写入 zero-item group；迁移完成后的 v13 invariant 则必须使用上面的 per-kind terminal disposition。Android Room 版本仍然独立，不能跟随改号。

v13 重建三个含语义副本的 projection 表，并为 turn 增加统一 redaction 标记；
保留原表名、主键、唯一键和外键：

```sql
CREATE TABLE visible_result_items (
  group_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  message_id TEXT NOT NULL UNIQUE,
  item_json TEXT,
  item_checksum TEXT NOT NULL,
  redacted_at INTEGER,
  PRIMARY KEY(group_id, ordinal),
  CHECK (
    (item_json IS NOT NULL AND redacted_at IS NULL)
    OR (item_json IS NULL AND redacted_at IS NOT NULL)
  ),
  FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
);

CREATE TABLE visible_result_actions (
  group_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  action_id TEXT NOT NULL UNIQUE,
  action_kind TEXT,
  target_key TEXT,
  target_revision TEXT,
  action_json TEXT,
  action_checksum TEXT NOT NULL,
  redacted_at INTEGER,
  PRIMARY KEY(group_id, ordinal),
  CHECK (
    (
      action_kind IS NOT NULL
      AND target_key IS NOT NULL
      AND action_json IS NOT NULL
      AND redacted_at IS NULL
    )
    OR (
      action_kind IS NULL
      AND target_key IS NULL
      AND target_revision IS NULL
      AND action_json IS NULL
      AND redacted_at IS NOT NULL
    )
  ),
  FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
);

CREATE TABLE current_user_batch_items (
  turn_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  message_json TEXT,
  checksum TEXT NOT NULL,
  redacted_at INTEGER,
  PRIMARY KEY(turn_id, sequence),
  UNIQUE(turn_id, message_id),
  CHECK (
    (message_json IS NOT NULL AND redacted_at IS NULL)
    OR (message_json IS NULL AND redacted_at IS NOT NULL)
  ),
  FOREIGN KEY(turn_id) REFERENCES current_user_batches(turn_id)
);

ALTER TABLE turns ADD COLUMN authority_redacted_at INTEGER;
ALTER TABLE turns ADD COLUMN input_clear_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE turn_authority_lineages ADD COLUMN redacted_at INTEGER;
ALTER TABLE turn_authority_lineages
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE turn_authority_lineages
  ADD COLUMN attempt_commitment TEXT NOT NULL DEFAULT '';
ALTER TABLE current_user_batches
  ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0);
ALTER TABLE current_user_batches
  ADD COLUMN tombstone_commitment TEXT NOT NULL DEFAULT '';
ALTER TABLE visible_result_groups
  ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0);
ALTER TABLE visible_result_groups
  ADD COLUMN action_count INTEGER NOT NULL DEFAULT 0 CHECK(action_count >= 0);
ALTER TABLE visible_result_groups
  ADD COLUMN tombstone_commitment TEXT NOT NULL DEFAULT '';
ALTER TABLE visible_result_groups
  ADD COLUMN redaction_delivery_count INTEGER CHECK(redaction_delivery_count >= 0);
ALTER TABLE visible_result_groups
  ADD COLUMN redaction_delivery_commitment TEXT;
ALTER TABLE cloud_deliveries ADD COLUMN relay_message_id TEXT;
ALTER TABLE cloud_deliveries ADD COLUMN redaction_requested_at INTEGER;
ALTER TABLE cloud_deliveries ADD COLUMN redaction_acknowledged_at INTEGER;
ALTER TABLE interaction_lanes ADD COLUMN clear_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interaction_lanes
  ADD COLUMN cleared_through_sequence INTEGER NOT NULL DEFAULT 0;

CREATE TABLE conversation_clear_controls (
  control_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  clear_epoch INTEGER NOT NULL CHECK(clear_epoch > 0),
  cleared_through_sequence INTEGER NOT NULL CHECK(cleared_through_sequence >= 0),
  requested_at INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  UNIQUE(role_id, clear_epoch)
);
```

只保留 child row 自己的 ID/checksum 仍不足以形成合法 audit shell：删除尾部 row
后，剩余 ordinal 依然连续；原本合法为 0 的 action 也无法与“action 全被删除”
区分。因此 v13 必须在语义清除前已经持久化以下四种不含正文的 commitment，
并把它们视为 authority parent 的一部分：

```text
visible-result-tombstone-v1 = sha256(canonicalJson({
  version: 'visible-result-tombstone-v1',
  groupId,
  itemCount,
  actionCount,
  items:  [{ ordinal, messageId, itemChecksum }, ...],
  actions:[{ ordinal, actionId, actionChecksum }, ...]
}))

current-user-batch-tombstone-v1 = sha256(canonicalJson({
  version: 'current-user-batch-tombstone-v1',
  turnId,
  batchId,
  itemCount,
  items:[{ sequence, messageId, checksum }, ...]
}))

authority-lineage-attempts-v1 = sha256(canonicalJson({
  version: 'authority-lineage-attempts-v1',
  lineageKey,
  attemptCount,
  attempts:[{
    lineageRevisionAtCreation, turnId, turnKind, retryOfTurnId, inputUserBatchId,
    envelopeChecksum, batchTombstoneCommitment
  }, ...]
}))

authority-redaction-deliveries-v1 = sha256(canonicalJson({
  version: 'authority-redaction-deliveries-v1',
  groupId,
  deliveryCount,
  deliveries:[{
    peerId, recoveryAckSeq, relayMessageId, authorityCommitChecksum
  }, ...]
}))
```

所有数组按其显式 sequence/ordinal/revision/peer identity 稳定排序。hash helper
必须拒绝缺字段、重复 identity、非连续 ordinal/sequence/revision 和非 64 位小写
SHA-256；不能把数据库当前顺序当作规范顺序。delivery tuple 的
`relayMessageId` 字段必须存在，但尚未入 relay mailbox 的 waiting row 规范化为显式
null；不得把 null row 丢出集合，也不得为它伪造一个“已经入云”的 ID。

`visible_result_groups.item_count/action_count/tombstone_commitment` 在 group commit
事务中与 items/actions 一起写入。两个 count 都允许为 0；live validator 另按
turn kind、items/actions 与 two-phase life authority 判定 `visible/action_only/skip`，
不能以 `item_count >= 1` 代替产品语义。commitment 同时覆盖两个有序集合，所以删除尾项、中间项、全部 action、
交换 row 或只篡改 child checksum 都会失败。redacted item 保留
`groupId + ordinal + messageId + itemChecksum`；redacted action 保留
`groupId + ordinal + actionId + actionChecksum`。这些 checksum 只作不可逆审计
锚点，redacted 后不得再用于回算正文、target 或 payload。live row 继续逐字段
重算；redacted row 用 retained parent commitment 校验完整 cardinality、identity、
顺序和 checksum。

`current_user_batches.item_count/tombstone_commitment` 在 batch 与 batch items
同一事务中写入。redacted input batch item 同样只保留
turn/batch/message identity、顺序和原 checksum，但 validator 必须先核对 parent
count/commitment，不能仅检查剩余 row 是否连续。由 `envelope.message` 驱动的
attempt 必须有且仅有一个非空 batch；由 `envelope.trigger` 驱动的 automatic/
plan/life attempt 不创建伪造空 batch，其 attempt commitment 把
`batchTombstoneCommitment` 规范化为显式 null。live validator 用 envelope 证明
“应有/不应有 batch”；redacted 后则用保留的 lineage attempt commitment 证明原始
选择，删除一个原本存在的 batch 会把重算值从 hash 变成 null 并导致不匹配。

`turn_authority_lineages.attempt_count/attempt_commitment` 在 original 创建时从 1
开始，每次合法 retry 与 `latest_turn_id/revision` 在同一 CAS 中追加更新，commit、
cancel 和 redaction 不改变它。commitment 覆盖 original/retry 的有序 turn identity、
从 `turns.rollout_key` 读取并规范化的持久 `turnKind`、原 envelope checksum 与
各自 batch commitment，因此删除较早 attempt、篡改决定 terminal disposition 的
rollout/kind anchor、删除 batch parent 或整条 retry 链的一部分都可检测。v12
source 在计算该 commitment 以前必须证明每条 canonical turn 的
`rollout_key === normalized envelope.kind`，且 kind 属于
`DIRECT_REPLY/PROACTIVE_CHAT/PROACTIVE_MOMENT/MOMENT_INTERACTION/MOMENT_REPLY/`
`ROLE_PLAN_CHAT/ROLE_PLAN_MOMENT/ROLE_PLAN_CHAT_PRIVATE/`
`ROLE_PLAN_MOMENT_PRIVATE`；`LIFE_PLANNING` 只存在于独立 life attempt authority。
随后还必须证明
`lineage_revision_at_creation` 从 1 连续到 N、`latest_turn_id` 等于第 N 条；
open lineage revision 必须为 N，committed/cancelled 必须由 receipt/CAS 证明合法
终态 revision，不能用当前剩余 row 数猜测历史。

delivery 集合在 live group 上仍可增长，所以
`redaction_delivery_count/redaction_delivery_commitment` 在 live 时必须同时为 null。
clear-chat 事务锁定 group 后，先枚举并校验当时所有 delivery，再冻结这两个字段；
0 条 delivery 也要保存 count=0 与空集合 commitment。之后 redacted group 禁止新增
delivery；retraction worker 只改变 state/request/ack/payload，不删除 row，也不修改
commitment 覆盖的 immutable identity。这样删除 mailboxed/confirmed delivery row
不能逃过 relay 撤回。waiting/null-relay row 直接变成无远端撤回请求的 redacted
tombstone；mailboxed/confirmed row 才使用已持久化 relay ID 反复撤回。
同一 authority lineage 的所有 attempt 都写相同 `authority_redacted_at`，
lineage 自身写相同 `redacted_at`；
`envelope_json` 变为固定 `{"redacted":true}`，但保留原 `envelope_checksum`，
使 same-turn replay 仍可核对调用方原 envelope hash。retry/original replay 对完整
incoming batch 逐项重算 checksum，并与 batch tombstone 比较；不得因为存储正文已清除
就跳过 immutable input 验证。

v12→v13 是原子、非猜测迁移。源库必须先通过专用
`assertV12ToV13SourceInvariantsInternal()`：它使用修正后的 current-state
规则验证所有 non-redacted group，不调用已知会误判历史 statePatch 的旧 v12
全库入口；v12 若已有任何 `group.redacted_at`、`manifest.redacted_at` 或
`semantic_json IS NULL` 必须在写入前拒绝，因为 v12 没有合法 audit-shell
表示。通过后，在一个 `BEGIN IMMEDIATE` 中重建 current-batch-items/items/actions，
原样复制 live rows 并令新增 `redacted_at=NULL`、
`authority_redacted_at=NULL`、`input_clear_epoch=0`。同一事务必须从已经通过
source invariant 的完整 live rows 计算并回填 group count/result commitment、
batch count/commitment 与 lineage attempt count/commitment；live group 的两个
redaction-delivery 字段保持 null。禁止先按当前剩余 rows 回填 commitment、再用
新 commitment “证明”原 v12 完整。核对 row count、每行 checksum、parent
commitment、schema、index、foreign key 和 logical checksum 后才写
`user_version=13`。迁移中任何
断点都回滚到字节语义等价的 v12；`>13` 一律拒绝。fresh、populated v9/v10/v11/v12
都必须最终到 v13；已包含多个历史 statePatch 的合法 v12 也必须能够迁移。
迁移 CLI 只对 clone 操作，报告字段固定为 `v13InvariantSummary`，源库 raw hash、
schema、row count、logical checksum 和 `user_version` 均不得变化。

所有 canonical group 校验统一收口到：

```js
assertVisibleGroupAuthorityInternal(groupId, {
  purpose, // 'reopen' | 'receipt_replay' | 'delivery'
  expectedLineageKey = null,
  expectedTurnId = null,
  expectedOrigin = null,
  expectedPayloadVersion = null,
  expectedCommitChecksum = null
})
// -> { status: 'live' | 'redacted', group, receipt, manifest }
```

它只读取目标 group 及其 lineage 的所有 attempt、receipt/manifest/items/actions/
messages/current-batch tombstones/jobs/
stances/current-state/delivery 投影，不扫描其他 group。v13 全库 reopen invariant
负责验证全局 schema/cardinality/孤儿关系，再按稳定 group ID 枚举并各调用一次；
`visibleDeliveryPayload()` 只调用目标 group validator，不能在一次 outbox flush
中对同一数据库重复执行最多 50 次全库扫描。`purpose='delivery'` 遇到 redacted
必须在读取 items/actions 前抛出 `canonical visible result is redacted`。

cognitive state 是每角色一个 current row，不是每 group 一条历史 projection。
全局规则是：每个非空 `cognitive_states.last_authority_group_id` 必须指向同 role、
同 `last_turn_id` 的 live group，该 current row 的 checksum/mood/open threads 必须
与该 group manifest 的 `statePatch` 一致。历史 manifest 即使包含 statePatch，只要
其 group 已被后续合法 group 取代，就不得要求它仍拥有 current row。若未来需要逐
次历史 state projection，必须新增 append-only revision 表，不能把 current 表误当
历史表。

已有 receipt 的所有快路径共用：

```js
readCanonicalCommitOutcomeInternal({
  lineageKey,
  expectedTurnId = null,
  expectedOrigin = null,
  expectedPayloadVersion = null,
  expectedCommitChecksum = null
})
// -> { status: 'already_committed', receipt }
//  | { status: 'redacted', receipt: receipt | null, lineage }
```

对 committed lineage，该入口必须先 join lineage/turn/group/receipt/manifest，再调用 group validator，
最后核对调用方已知的 immutable identity；任一缺行、origin/version/checksum/turn
不一致都抛 authority conflict。`commitVisibleResult()` 的 exact duplicate、
same-turn create replay、committed original create 和 committed retry 都只能调用
这个入口，不能直接 `getVisibleCommitReceipt()`。live 返回
`status='already_committed'`；redacted 只返回不含正文/action 的 receipt metadata
与 `status='redacted'`，调用方不得重新排队、投递、执行或把它当作普通可见成功。
对 `state='cancelled' + redacted_at!=NULL` 且从未提交 group/receipt 的 lineage，
它必须调用 redacted-lineage validator，证明所有 attempt/batch/message/working-copy
都已 tombstone 后返回 `{status:'redacted', receipt:null, lineage}`。普通 cancelled
lineage 没有这个返回资格。create original/retry 在完整 incoming envelope/batch hash
验证后可返回该结果；一个已在运行的旧 worker 则仍必须在 commit CAS 处失败。

“清除聊天”的 canonical authority 子事务顺序固定如下，Task 20 必须在同一个
`BEGIN IMMEDIATE` 内与 stance/constraint/state/lane 生命周期变更一起调用：

1. 锁定该角色所有待清聊天 turn。对 committed lineage，锁定 live group 及同
   lineage 的全部 original/retry attempts并使用 group validator 核对 receipt/
   manifest checksum；对 open lineage，先 CAS 为 cancelled；所有 canonical lineage
   写统一 `redacted_at`。没有 lineage 的 Yuqi authority-version-0 turn 也必须进入
   turn/batch/message scrub，不能因旧架构而保留正文；
2. 清空目标 group 所有 delivery（包括 waiting/pending/retry/mailboxed/confirmed）
   前，先冻结其完整 immutable identity 集合到
   `redaction_delivery_count/redaction_delivery_commitment`；随后清空
   `payload_json/checksum`，保留 `authority_commit_checksum`。从未 enqueue、没有
   `relay_message_id` 的 row 可直接置为 `redacted`；已经 enqueue 的 row 置为
   `redaction_pending` 并写 `redaction_requested_at`，之后普通 pending 枚举不得再
   返回它。持久 retraction worker 用原 deterministic `relay_message_id` 调 relay
   `/bridge/ack`，成功或确认消息已不存在后写 `redaction_acknowledged_at` 并置
   `redacted`；
3. 删除该 group 尚可能执行的 memory/compare consolidation jobs；已产出的
   evidence 由同一 clear-chat 生命周期追加 archive/expire revision，不能继续参与检索；
4. 对关联 stance 追加 terminal revision，重建 chat-derived fast state，并保证
   current cognitive state 不再以该 redacted group 为 `last_authority_group_id`；
5. 清空同 lineage 所有 turn 的 `memory_packet_json`、`brain_draft_json`、
   `supervisor_json`、`reply_json`、`error_json`、`route_reasons_json`，把
   `annotation_snapshot_json` 改成 `{}`，把 `envelope_json` 改成固定 tombstone 并写
   `authority_redacted_at`；保留且禁止修改每个 canonical turn 的
   `rollout_key`，因为它是重算 attempt commitment 与 terminal disposition 的唯一
   非敏感 kind anchor；清空这些 turn 的 current-batch `message_json` 并写同一
   redaction 时间；清空对应 user/character message content；删除这些 turn/message
   的 annotation、diagnostic 和旧 `sync_log.payload_json` 副本，只追加
   `entity_type='authority_redaction'`、payload 仅含
   `{groupId,redactedAt,reasonCode}` 的审计行；清除该角色 `sessions` row，保证后续模型不会续接仍含
   已删除聊天的旧 Codex thread；
   item 行改为
   `item_json=NULL + redacted_at=<same time>`；action 行清空 kind/target/revision/
   payload 并写同一 redaction 时间，保留确定性 ID 与原 checksum；
6. 写 `manifest.semantic_json=NULL`，并把 group/manifest 标成同一 redaction 时间；
7. 删除或重建仍指向该 group 的 lane cursor，在提交事务前用
   `purpose='reopen'` 的 scoped validator 验证完整 redacted shell。

redacted validator 必须同时证明：同 lineage 的所有 turn 工作字段为空、
annotation snapshot 为 `{}`、route reasons 为空、
`envelope_json={"redacted":true}` 且 `authority_redacted_at` 一致；每个
version-1 attempt 的 `rollout_key` 非空、属于 canonical turn-kind 闭集，并以它作为
attempt commitment 中 `turnKind` 的唯一来源；redacted 路径不得调用
`json_extract(envelope_json,'$.kind')`；batch item
`message_json` 为空且 parent batch count/commitment、tombstone
checksum/identity/顺序完整；lineage attempt count/commitment 与全部 original/retry
turn/batch parent 完整；user/character message
content 为空；旧 sync payload 不可检索；item/action
semantic 列为空且 group count/commitment、tombstone ID/ordinal/redaction time
合法；manifest semantic 为空；
所有 delivery payload 为空，且 state 只能是带 request time 的
`redaction_pending` 或带 acknowledgement time 的 `redacted`；无 authority-group
job；delivery rows 的数量与 immutable identity 必须等于 clear-chat 时冻结的
redaction delivery commitment；无 active
stance head或 current cognitive-state/lane 指向该 group；无关联 annotation/
diagnostic 或仍连接旧对话的 session。仅检查“没有 pending
delivery”不够，因为 mailboxed/confirmed payload 同样可能保留完整回复与动作。
没有 committed group 的 redacted-cancelled lineage 使用相同 turn/batch/message/
annotation/diagnostic/sync/session 检查，并额外要求 `state='cancelled'`、无
group/receipt/delivery/job、所有 attempt 不在 recoverable state。redacted 的 Yuqi
version-0 turn 也必须满足 turn/batch/message scrub，且不得再被 legacy recovery
或 legacy outbox 枚举。

本地数据库 tombstone 不能假装撤回已经进入 relay 的密文。clear-chat 返回后，
retraction job 必须离线可恢复并优先于普通发送；relay ACK 是幂等删除，直到成功或
原消息自然过期才完成。与此同时 Android clear 操作必须先持久化
`clearedThroughSequence + clearEpoch`；PC 可见结果 payload 必须携带
`inputVisibilitySequence`，任何不高于 cleared-through cursor 的迟到 group 都只做
receipt acknowledgement，不写 Room reply、不触发通知、不渲染 DOM。这样即使旧
relay ciphertext 与撤回请求竞态，已清聊天也不会重新出现。

`inputClearEpoch` 是 canonical input authority 的一部分。v13 migration 对历史 turn
写 0；Task 11 创建新 turn 时从已验证 visibility cursor 固定它，wire v2 缺失时只能
固定 0。PC 新提交默认使用 `pc-visible-commit-v2`，canonical wire-v3
`PROACTIVE_CHAT` 使用 `pc-visible-commit-v3`，canonical wire-v3
`PROACTIVE_MOMENT/MOMENT_INTERACTION/MOMENT_REPLY` 使用
`pc-visible-commit-v4`。三者都保留 v2 canonical payload 的精确基础 key set 与
`input:{userBatchId,visibilitySequence,clearEpoch}`；v3 只增加闭合
`proactiveMotiveEvidenceIds`，v4 按 kind 只增加闭合
`publicMomentEvidenceIds` 或 `momentTargetAuthorityChecksum`，`commitChecksum` 始终
hash 对应 exact payload。Android 新 fallback 使用 `android-fallback-commit-v2` 并
包含同一 input 字段。v1 receipt/manifest 继续只按原 v1 payload 重算，且必须满足
`input_clear_epoch=0`。不能在仍名为 v1/v2 的 checksum payload 中悄悄增加新语义。
existing-receipt replay 先闭合验证存储的 origin/payload version，再选择对应
v1/v2/v3/v4 canonicalizer 重算调用方 input；旧 v1/v2 只原样回放。live v3/v4
manifest 验证完整语义；redacted group 只验证 identity/cardinality/checksum tombstone，
不得重建或消费 motive/public evidence/target prose。

private-chat lane 持久化当前 `clear_epoch + cleared_through_sequence`。fresh turn 的
input clear epoch 必须等于 lane current epoch；retry 继承 parent 的
`input_clear_epoch`，并把它加入 immutable pins。一个 clear control 使用稳定
`controlId` 和 `(roleId, clearEpoch)` 唯一键，只有 `clearEpoch > lane.clear_epoch`
且 through-sequence 不倒退时才可应用；exact duplicate 返回同一 applied record，
同 epoch 不同 checksum 一律冲突。事务只 redacts 满足
`turn.input_clear_epoch < clearEpoch` 或“epoch 相等且
`input_visibility_sequence <= clearedThroughSequence`”的 turn，绝不能因为控制消息
迟到而清除 clear 之后的新输入。事务最后推进 lane clear cursor，再写
`conversation_clear_controls`。PC 主动 turn 从 lane 固定最新 epoch；旧 wire v2
在 lane epoch 已非 0 时必须升级/失败，不能用 0 绕过 clear boundary。

#### 13.3.2.1 跨端 clear authority 与 Android Room v13

Task 20 的“清除聊天”不是 Web、本机 Room 和 PC 各自删除一次，而是一条由手机
先取得本地 authority、PC 后应用、relay 最后撤回的分布式操作。三个事实源固定为：

1. Android Room cursor 决定用户按下清除时的本地边界；
2. PC `conversation_clear_controls` 与 redacted authority shell 决定电脑侧是否已经
   应用；
3. relay message ID/retraction state 只证明远端密文的交付或撤回，不代表任一数据库
   已经清除。

Android 必须从 Room v12 升到 v13。v12 没有持久 lifecycle outbox，不能在进程重启、
LAN 超时或云端离线后证明同一 clear 仍会重试。v13 只新增：

```sql
CREATE TABLE lifecycle_controls (
  control_id TEXT PRIMARY KEY NOT NULL,
  control_kind TEXT NOT NULL CHECK(control_kind IN (
    'conversation_clear_v1', 'role_delete_v1'
  )),
  character_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  clear_epoch INTEGER,
  cleared_through_sequence INTEGER,
  requested_at INTEGER NOT NULL,
  semantic_json TEXT NOT NULL,
  semantic_checksum TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'waiting', 'pending', 'relay_accepted', 'applied', 'quarantined'
  )),
  lease_id TEXT,
  lease_attempt INTEGER NOT NULL DEFAULT 0 CHECK(lease_attempt >= 0),
  leased_at INTEGER,
  relay_message_id TEXT,
  relay_expires_at INTEGER,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK (
    (control_kind = 'conversation_clear_v1'
      AND clear_epoch IS NOT NULL AND clear_epoch > 0
      AND cleared_through_sequence IS NOT NULL
      AND cleared_through_sequence >= 0)
    OR
    (control_kind = 'role_delete_v1'
      AND clear_epoch IS NULL AND cleared_through_sequence IS NULL)
  )
);
CREATE UNIQUE INDEX idx_lifecycle_clear_epoch
  ON lifecycle_controls(character_id, clear_epoch)
  WHERE control_kind = 'conversation_clear_v1';
```

Row-state shape is also closed: `waiting` has no lease/relay/expiry/applied time;
`pending` has a positive attempt, nonempty lease and positive leased time, may
retain the stable relay ID/old expiry pair during a refresh or post-expiry
re-enqueue, and has no applied time;
`relay_accepted` has a stable relay ID, positive expiry, and no active lease or
applied time; `applied` has positive applied time, no active lease, and nullable
relay ID/expiry (both null for LAN, both present for cloud); `quarantined` has no
lease/relay/expiry/applied time. Unknown combinations fail Room open, list, claim
and completion. Exact lease CAS is required for `pending→relay_accepted`; exact
control/checksum CAS is required for LAN `waiting|pending→applied` and cloud
`relay_accepted→applied`.

Every lifecycle mutation is store-owned and matches the full persisted snapshot:
`controlId,semanticChecksum,state,leaseId,leaseAttempt,leasedAt` plus the old
`relayMessageId,relayExpiresAt` pair when present. The relay ID is recomputed
from the stable formula before every cloud mutation; LAN controls require both
relay fields to remain null. `waiting` has attempt zero. Pending lease expiry is
exactly `leasedAt+60_000`; `relay_accepted` becomes refreshable 24 hours before
its relay expiry. A stale lease may observe an already-equivalent terminal row,
but cannot write it. Relay and lease identities are frozen as:

```text
leaseId = 'ctllease_' + SHA256(canonical {
  contract:'android-lifecycle-lease-id-v1',
  controlId,semanticChecksum,leaseAttempt
})
relayMessageId = 'ctlmsg_' + SHA256(canonical {
  contract:'android-lifecycle-relay-message-id-v1',
  controlId,semanticChecksum
})
idempotencyKey = 'ctlidem_' + SHA256(canonical {
  contract:'android-lifecycle-idempotency-v1',
  controlId,semanticChecksum
})
```

The relay provides authenticated `POST /bridge/refresh-expiry` before Android
depends on refresh. It changes only `expires_at` for one live exact
device/message/idempotency/direction tuple and never replaces ciphertext/nonce.
Exact or lower expiry is idempotent; changed/foreign/expired identity is zero
write. Normal enqueue may remove an expired row only when the complete
`deviceId,messageId,idempotencyKey,direction` identity matches and
`expiresAt<=now`; a partial identity conflict is zero-write. Expired cleanup of
the envelope and its live identity index plus replacement insertion is one
atomic store operation (one D1 transactional batch/equivalent rollback unit or
one memory-store critical section). ACK removes both live envelope and live
identity index in memory, matching D1 row deletion; this index is not a durable
receipt store. A phone that was offline beyond expiry may re-encrypt and reinsert
the same semantic control with the same stable IDs. A still-live row is
immutable. A relay refresh that succeeds before the Android Room CAS is safe to
repeat after restart: the same relay identity returns the persisted expiry, and
only an exact Room snapshot CAS may record it.

`MIGRATION_12_13` 只能建表和索引。它不能从历史 cursor 猜测“用户曾发出清除”，不能
改写历史 checkpoint，也不能伪造已经送达或已应用的控制。filled v12 的所有旧字段、
UTF-8 文本、authority、receipt、cursor 与 checkpoint 必须逐字保留。

插件不再相信 JavaScript 给出的 peer/epoch/sequence。`AlExecutionPlugin` 从
`AlSecretStore.loadBridgeConfig().deviceId` 读取 store-owned peer；插件方法本身没有
peer 参数，未配置 bridge 时在任何 Room 写入前失败。`getConversationCursor` 返回
`cursorChecksum`：它 hash exact canonical JSON
`{contract:'conversation-cursor-clear-v1',characterId,nativeCompletedTurnId,`
`nativeCompletedGroupId,nativeCompletedSequence,uiAppliedTurnId,uiAppliedGroupId,`
`uiAppliedSequence,localSequence,clearedThroughSequence,clearEpoch,clearedAt,`
`chatOpen,updatedAt}`；nullable ID 保留 JSON `null`，整数与 boolean 不做字符串
强转。调用
`createConversationClear(characterId, expectedCursorChecksum)` 后，Room 在一个外层
transaction 中读取 cursor，固定
`clearEpoch=current.clearEpoch+1`、
`clearedThroughSequence=current.localSequence`，从闭合 payload 派生 control ID 与
checksum，并完成以下全部写入：

`saveBridgeConfig` 在同一进程生成或变更 device ID 后，必须立即刷新这个 native
store-owned binding；清理不能要求重启 App 才看到新 peer，也不能继续使用旧/null peer。

1. 在事务内重算并比较完整 cursor checksum，阻止两个页面/重载同时选择同一旧边界；
   updatedAt 不能单独充当 revision；
2. 验证 boundary 内每个 Task 13C bridge checkpoint 的 envelope/checksum/member set；
3. 将每个 checkpoint 替换为 `android-bridge-redacted-checkpoint-v1`。它保持 Task 13C
   v1/v2 root 的原 key set/version 和 immutable identity/pin/envelope checksum，但令
   `normalizedEnvelope=null`；redaction time 只存在于 `outcome.redactedAt`。outcome
   精确为 `{type:'redacted',route:null,relayMessageId:null,failure:null,`
   `result:{contract:'conversation-clear-redacted-v1',controlId,clearEpoch,`
   `clearedThroughSequence},redactedAt}`。本地 v2 root 保留
   `fallbackExecution/journalSyncSeq` 两个 key，但值分别为 null/0。redacted validator
   必须在读取 envelope/fallback 之前分支；非 redacted 路径继续要求原对象。禁止保留
   normalized envelope、正文、item/action、failure detail、route、relay ID、模型 memory
   或任意 extra key；
4. 清除 boundary 内 reply/raw/action/working projection；逐 turn diagnostic 与
   change-event 只可保留 cursor/row identity，并改写为同一个闭合无语义 redacted
   projection，不能残留 error detail、group/disposition、route、正文或任意旧 payload。
   只推进独立的
   `clearedThroughSequence/clearEpoch`；不得为 clear boundary 伪造 turn/group identity，
   也不得改写仍代表真实投递/UI 落地水位的 `nativeCompleted*` / `uiApplied*`；
5. 同事务闭合受影响集合：历史 v0/v2 可能没有可信 sequence，因此角色当前已有的
   legacy conversation turn 全部纳入并做 legacy redaction/cancel，不伪造 v3 checkpoint；
   v3 必须有 safe `inputVisibilitySequence`，且仅纳入 `<= boundary` 的完整 lineage。
   preflight 必须先枚举该角色所有 v3 行再做 boundary filter；null、负数或超 JS-safe
   sequence 不能因 SQL `WHERE` 排除而被静默遗留，合法 `> boundary` 行保持不变。
   每条受影响 v3 lineage 的 `ConversationAuthorityEntity` 从已验证 member set 精确推进
   一次到 `CANCELLED`，保留 latest identity，清空 group/checksum/payload version/origin/
   disposition；缺失、foreign、重复或只清半条 lineage 全部回滚；
6. 插入 `lifecycle_controls(state='waiting')`。`semantic_json` 直接保存完整十一键
   clear wire（包括其 `checksum`），而不是另存一份七键内部 DTO。wire `checksum`
   hash 其余十键，row `semantic_checksum` 再 hash 包含 `checksum` 的完整十一键对象。
   clear wire 额外闭合包含
   `inputCursorChecksum`。`controlId` 为 `ctl_` 加
   `android-lifecycle-control-id-v1` canonical basis 的 SHA-256；`semantic_json` 保存
   完整闭合 wire semantic，checksum 每次 list/claim/complete/reopen 都重算。

任一步失败全部回滚。tombstoned attempt 在所有恢复、fallback、notification、completed
event、UI inbox、receipt 入口都被稳定识别为 `REDACTED`，不能因为旧 engine、旧 mirror
或 WebView 重载恢复语义。Task 20 不复用普通 `memoryResult` 解析器生成 tombstone。
同一 plugin 请求在 commit 后丢失响应时，以 row 中保留的 pre-clear checksum 返回原
control；若 control 尚未 `applied`，page reload 携带当前 post-clear checksum也只恢复
该 row。仅 current control 已 applied 时，新的 current checksum 才能分配下一 epoch。

控制 outbox 使用 lease：`waiting` 或过期 `pending` 由 CAS 取得唯一 lease；未过期
`pending` 不被其他 worker 选中。lease ID 可随 attempt 改变，但 relay message ID 与
idempotency key 只由 `controlId + semanticChecksum` 决定，崩溃重试仍相同。LAN 的
authenticated 200 可直接证明 PC apply；云 relay 只把本地状态推进到
`relay_accepted`。PC commit 后必须另发闭合
`CONVERSATION_CLEAR_APPLIED`。relay outer wrapper 没有 semantic type，因此其解密后的
inner body 精确只有
`protocolVersion,type,controlId,controlChecksum,roleId,peerId,clearEpoch,`
`clearedThroughSequence,appliedAt,checksum`；`protocolVersion` 是原生整数 `3`，
`type` 精确等于 `CONVERSATION_CLEAR_APPLIED`，`controlChecksum` 等于持久
lifecycle semantic checksum，末尾 `checksum` hash 其余九字段的 canonical JSON。
relay message ID、direction 与 expiry 属于认证 outer wrapper，不是 inner ACK 字段。
Android 验证
control/role/peer/epoch/through/control checksum/ACK checksum 全部相等后才写
`applied`。lifecycle row 中的持久 relay ID/expiry 属于 outbound phone→PC clear
命令，Room 只把它们作为自己的 CAS 旧快照重读匹配；它们绝不与 inbound PC→phone
applied envelope 的另一组 relay ID/expiry 比较。入站 relay ID 只在 Room commit 后
用于 ACK 该 applied envelope。手机对这个 applied envelope 的 relay ACK 发生在 Room
commit 之后。relay 接受 phone→PC ciphertext 绝不能
被记成 PC apply。
`relay_accepted` 在其持久 expiry 进入 refresh window 后重新取得 lease，复用相同
message ID/idempotency key 并把 expiry 延长到不超过七天；没有 applied ACK 就不会停止。
为关闭“relay 已收、Room 未写时进程死亡”的窗口，clear control 单独使用确定性
AES-GCM nonce：取 HMAC-SHA-256(encryption key,
`android-lifecycle-gcm-nonce-v1\n<relayMessageId>`) 前 12 字节。control semantic 与
relay ID 均被同一不可变 checksum 绑定，因此同 nonce 只会重放同 plaintext；普通
turn/result 仍使用随机 nonce。首次 enqueue 返回 `idempotent=false` 时持久请求 expiry；
崩溃重试返回 `idempotent=true` 时不得猜测 relay 的旧 expiry，必须先以同一完整身份
调用 refresh-expiry，并只把返回值写入 Room。
控制发送由独立 `LifecycleControlSender`/`ControlRouteClient` 完成，绝不构造
`TurnSubmission`、调用 turn endpoint、fallback/mirror、通知或 completed event。
创建 clear 的 Room transaction 成功后立即唤醒 service。20C 只注册
`conversation_clear_v1`；`role_delete_v1` 在 20E 注册 route 前保持 waiting 且不被
误隔离。

云端的 applied ACK 不依赖一个未定义的 PC 内存队列。已提交的
`conversation_clear_controls` row 是 apply proof，尚未 ACK 的 phone→PC ciphertext
是重启触发器。PC 使用 relay `POST /bridge/ack-with-response`：relay 在同一原子存储
操作中删除该 incoming message，并写入一个正常的加密 PC→phone applied envelope。
D1 实现使用 transactional batch；memory implementation 也不得暴露中间态。PC 在
DB commit 后、relay 原子交换前崩溃时，incoming 仍会被再次 poll，exact clear replay
生成同一 response。交换已提交但 HTTP response 丢失时，incoming 已消失而 applied
envelope 保持可 poll。该 endpoint 只处理 ciphertext/nonce/idempotency/expiry 元数据，
重复现有私密字段禁令，绝不看到 clear 明文。
PC applied-response 的稳定 relay ID 也派生确定性 lifecycle-response nonce，使同一
incoming clear 被并发或重复处理时产生字节相同的加密 response；普通消息仍保留随机
nonce。

`conversation_clear_v1` wire payload 的 key 精确为：

```text
protocolVersion, type, controlVersion, controlId, roleId, peerId,
clearEpoch, clearedThroughSequence, requestedAt, inputCursorChecksum, checksum
```

其中 `protocolVersion=3`、`type='CONVERSATION_CLEAR'`、
`controlVersion='conversation_clear_v1'`，checksum 为其余十字段 canonical JSON 的
UTF-8 SHA-256。native number/string 类型必须原生正确，不能使用 `String()`、`Number()`
或 `opt*` 强转。LAN/cloud 都必须在 reconcile、store lookup、diagnostic 和 relay ACK
以前验证同一 schema；Cloud ACK phone→PC ciphertext 仅在
`applyConversationClearInternal()` 的 immediate transaction 提交后执行。

PC transaction 必须调用 13.3.2 已定义的 Task 10F redaction 顺序，并把 lane/state/
stance/evidence/session/legacy-v0 scrub 与 `conversation_clear_controls` 插入放在同一
transaction。它不能从当前 surviving child 重新“计算”历史 commitment；只能先验证
原 parent commitment，再保留它。exact control replay 返回原 applied row；同
control ID 或同 role/epoch 的 changed checksum 零写冲突。边界严格为：

```text
input_clear_epoch < clearEpoch
OR (input_clear_epoch = clearEpoch
    AND input_visibility_sequence <= clearedThroughSequence)
```

clear transaction 冻结 pre-clear delivery set 后，从未入 relay 的 waiting row可直接
成为 `redacted`；有稳定 relay ID 的 mailboxed/confirmed row 成为
`redaction_pending`。`ResultOutbox.flushRetractionsOnce()` 必须先于普通发送，用保留的
relay ID 执行幂等 ACK，然后 exact CAS 到 `redacted`。网络失败留待重试；stale outbox
snapshot 在 concurrent redaction 后只能无写停止，不能重建 payload、改成 quarantine、
写语义 diagnostic 或走 legacy delivery。

#### 13.3.2.2 Web、角色删除与备份恢复

Android 内的 Web `clearCurrentChat()` 先等待上述 Room transaction 成功，再删 Web
messages/moments/view cache。插件悬挂、事务失败或页面 reload 时，旧 UI 仍保留或明确
显示 pending；`localStorage` 为空不构成成功证据。非 native 浏览器必须等待 PC 的
authenticated clear commit。批量清理角色按 role 串行，不能用 `Promise.all` 在同一
authority DB 上并发选择 epoch。

删除角色使用另一闭合 `role_delete_v1`，但复用 Android `lifecycle_controls` 的 lease、
LAN/cloud 和 PC-applied ACK。它没有 epoch/sequence，必须携带已验证 backup receipt。
wire key 精确为
`protocolVersion,type,controlVersion,controlId,roleId,peerId,requestedAt,`
`backupReceipt,checksum`；版本/type 分别为 3、`ROLE_DELETE`、`role_delete_v1`。
`backupReceipt` 精确包含
`receiptVersion,receiptId,roleId,manifestChecksum,snapshotSha256,logicalChecksum,`
`createdAt,receiptChecksum`，其 version 为 `yuqi-backup-receipt-v1`。Android
`controlId` 必须精确等于 `ctl_` 加以下 canonical basis 的 UTF-8 SHA-256：

```text
{contract:'android-lifecycle-control-id-v1',
 controlKind:'role_delete_v1',
 roleId,peerId,requestedAt,
 backupReceiptChecksum:backupReceipt.receiptChecksum}
```

不得把整个 receipt 的序列化字节、caller 提供的别名或 row 时间戳混入该 basis。
`semantic_json` 保存完整对象。PC 只有在
`sync_log(entity_type='backup_receipt',entity_id=receiptId,operation='create')` 存在唯一
且 canonical payload/checksum 完全一致时才允许删除；该 audit 与
`role_deletion` audit 都不能被普通聊天清除删除。
Web 只有在 `POST /v3/backups/yuqi` 返回 receipt 后才调用 native
`createRoleDelete(characterId,expectedCursorChecksum,backupReceipt)`；peer 仍由
`AlSecretStore` 注入，不是 Web 参数。该 native transaction 先验证并把完整 receipt
写入 `semantic_json`，再删除/tombstone 本地角色行，同时保留 lifecycle control。
PC/backup endpoint 不可达、receipt 未持久或 cursor CAS 失败时，本地角色不删除。
PC 先执行全角色 chat redaction/retraction，再按 FK 安全顺序删除该角色的 constraint、
stance、state、memory、plan、lane、rollout 和 authority rows；全局 release definitions
保留。角色行删除后，以 `sync_log(entity_type='role_deletion', entity_id=controlId)` 的
闭合非语义 audit 作为 exact replay proof；同 control 的 changed payload 冲突。Android
在一个 transaction 中清空角色 Room 数据但保留 lifecycle audit/control proof。任何
一端都不能在没有 backup receipt 时开始物理删除。

backup 必须是 transactionally consistent SQLite snapshot，并生成 exact
`yuqi-backup-manifest-v1`：
`manifestVersion,createdAt,schemaVersion,snapshotSha256,logicalChecksum,`
`tableRowCounts,roleLifecycleHeads,redactedInvariantSummary,manifestChecksum`。数组按
table/role identity 排序，manifestChecksum 是其余字段 canonical JSON 的 SHA-256。
这是 content-addressed integrity manifest，不声称一个不存在的公钥签名；信任边界是
本机受保护数据库、authenticated bridge 与上面的 immutable backup receipt audit。
`VACUUM INTO` 成功本身不是验收。restore 只能先写 clone，对 clone 执行迁移、完整 reopen invariant、
row count/checksum 和 redaction audit，再备份当前目标并原子替换；禁止把两个独立
authority history 逐 row merge。clear 后的 snapshot 恢复并重启仍必须保持 cleared；
用户明确恢复 pre-clear snapshot 时，旧历史与旧 cursor/control state 作为一个一致
整体恢复，不能与较新的 relay/control rows 拼接。

#### 13.3.3 提交前重新校验

`commitVisibleResult()` 在一个 `BEGIN IMMEDIATE` 事务中检查：

- receipt 尚不存在；若存在，只允许 exact duplicate 返回；
- turn 的 `resultAuthorityVersion=1`，且 `turnRevision` 仍有效；
- lineage 仍为 open、revision 未变且 `latestTurnId` 正是当前 turn；
- lane revision、最新用户批次 ID 和本地 visibility sequence 未变；
- 当前 cognitive state revision 未变；
- 当前 hard constraints、preference evidence、active stance heads 和 cognitive state 组成的 `agencySnapshotChecksum` 未变；
- authoritative release pin 未变；
- 动作对象由 store-owned target resolver 重新读取数据库 row 或 turn 中持久化的、已验证 input snapshot 后仍有效且 revision 完全相等；未知 target kind 默认拒绝；Android-owned 对象还必须由手机端 action consumer 做最终本地 CAS；
- state patch 经过 agency validator。validator 只接受 cognition-v3 的 `mood/currentStances/openThreads` 三个顶层字段，以当前 schema-v2 cognitive state 为基底，只能替换 `fastState.mood/openThreadIds`，并通过 `applyStanceTransitions()` 产生同一稳定 stance ID 的下一 revision；`slowState`、`mediumState`、硬约束、preference evidence、外部角色状态和任意额外字段都不能由模型 patch；
- rollout 要求 compare 时，compare job 必须存在并精确匹配 pinned comparison release/direction；无需 compare 时不得塞入 job；
- generation fingerprint 仍有权成为该 lane 的结果。

action target registry 是封闭集合：`conversation:<roleId>:<peerId>`、`message:<messageId>`、`payment:<messageId>`、`moment:<momentId>`、`comment:<commentId>`、`role_plan:<planId>`、`role_occurrence:<occurrenceId>`、`life_episode:<episodeId>`、`relationship:<roleId>` 和 `lineage_create:<lineageKey>:<actionKind>`。PC-owned 对象从当前数据库 row 读取 revision/checksum；Android-owned 对象只能从 turn 中持久化的 validated input snapshot 读取，并以 `sha256:<canonical target hash>` 固定提交时的期望，手机 action consumer 再对 Room 当前 row 做最终 CAS。trusted orchestrator 从已验证 cognition action 构造 target descriptor，模型不能直接指定任意 key/revision。

target resolver 不得把两个不同对象拼成一条“看似有 revision”的 authority。它先从
store row 或持久化 envelope 中解析唯一权威对象及其 ID，再要求 action payload 中的
ID（若存在）与该 ID 完全相同，最后才从同一个对象计算 target key 与 revision。禁止
`payload.id || snapshot.id` 这种独立选择 ID、却对另一条 snapshot 计算 checksum 的
写法。`conversation`、`message` 和 `role_occurrence` 即使暂时没有模型可直接产生的
action kind，也必须由同一个 store-owned target-ref resolver 覆盖；action-kind registry
只能调用这些 target ref，不能另写一套较弱的查找逻辑。

canonical generation fingerprint 的 action 部分使用已经过 resolver 的稳定描述符：
`kind + targetKey + targetRevision + contentHash(semanticPayload)`。不得继续读取旧草稿
结构的顶层 `messageId/momentId/...`，否则两个 target/payload 不同的新 action 会得到
相同 fingerprint。可见 item 也必须重新校验输出身份：PC 可见回复只能是
`speakerId=turn.characterId`、`speakerType=character`、`recipientId=user`，
且正文非空；caller identity 字段不能借“之后会覆盖 ID”绕过这些角色约束。

通过后依次写入 canonical group/items/actions、聊天消息投影、认知状态/stance revisions、证据记忆任务、可选 compare job、group-based outbox、lane CAS、lineage CAS、turn CAS、完整 semantic manifest 和 commit receipt。manifest 的 canonical JSON 必须重新 hash 为 receipt 的 `commitChecksum`；任一步失败全部回滚。

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

即使已经取得本地提交权，模型返回值也只是一份未授权 draft。`BridgeRouter` 只能在明确的本地授权结果下返回这份 draft；`ExecutionEngine` 必须完成解析、质量门和结构化动作校验，最后由 `RoomExecutionStore` 的单一事务生成 canonical local receipt。任何事务前的文本、隐藏标签、解析结果或临时 `BridgeResult` 都不构成可见权威，不得通知、同步或被 Web 读取。

本机 fallback 在一个 Room 事务中 CAS 本地 lineage，写入确定性 group identity、已有 `ReplyPartEntity` 投影（其中包括 payment/moment/relationship/plan 等结构化部件）和 local receipt；规范化 action authority 列表保存在闭集 checkpoint/receipt 中，不为 Android 另造第二张 action 真相表。authority origin 为 `android_fallback`；automatic skip 允许 reply/action 都为空但仍有 group identity/receipt，direct reply 为空则拒绝。checksum 使用独立且版本化的 `android-fallback-commit-v1/v2` 规范；历史 v1 原样重放，含 clear epoch 的新提交只写 v2。PC 历史 v1 同样原样重放，含 clear epoch 的新提交只写 `pc-visible-commit-v2`。同步恢复后，PC 只能把这个 terminal receipt 作为 external canonical result 导入：按其 payload version 验证相同 lineage/group/checksum，记录消息和 receipt，不运行 PC cognition、不写 PC state、不创建 outbox/通知。导入 action 的执行所有权由 group/receipt 的 `android_fallback` origin 关闭，PC 不得二次执行，也不得修改已签名 action JSON 来伪造单行状态。若 PC 已有不同 receipt，属于必须隔离的跨设备 authority conflict，不能选择其一继续显示。

本地 receipt 不是依附于某条可见消息的附加字段。Room v12 已有的 attempt checkpoint 两列保存闭集 local-fallback checkpoint；Task 14 不再加表或迁移，`authority_receipt` 是 `FallbackJournal` 从该持久 checkpoint 生成的确定性 journal 投影。Room 在同一提交事务中通过现有 `yuqi_sync_cursors` 的独立本机 allocator row 分配全局单调且可重启恢复的 journal sequence；raw message、annotation 与 authority receipt 三类生产者全部共用该事务分配器，旧的各自 `max+1` 路径必须移除，不能用时间或 turn 内 ordinal 代替。因此零气泡的 `skip` 也能同步。`FallbackJournal` 先同步 `authority_receipt`，再同步可选的消息投影。receipt entry 本身必须包含完成 PC 单事务导入所需的 normalized envelope、input batch/cursor identity、compact semantic cognition snapshot 及其 canonical checksum、完整有序 items/actions、manifest 与 checksum；随后到达的 message entry 只能作为同一权威的 exact-idempotent 投影，不能创建第二个结果。

PC 导入 Android fallback 时必须创建一个可通过当前 v13/v14 重启不变量的完整 mirror authority：release registry row、turn、lineage、input batch、attempt commitment、group、items/actions、manifest 与 receipt 必须一起成立。Android fallback release 使用确定性 `android_fallback:<contractChecksum>` 标识和静态闭集元数据；其 `releaseChecksum` 是 `{origin:'android_fallback', contract:'cognition-v3-fallback-v1', contractChecksum, codecVersion:1}` 的 canonical hash，PC mirror turn 的 authoritative pipeline checksum 必须逐字取该值。它只证明本机 fallback contract，不伪装成 PC 模型 release，也不进入 rollout/canary 证据。相同 receipt 重放零写返回原 receipt；不同 receipt、已有 PC authority、跨设备合并或试图恢复已 redacted authority 都以独立、去重的脱敏冲突诊断拒绝，不能在失败的导入事务中把诊断一并回滚掉。只有完整导入成功后才能推进 recovery ACK。

#### 13.3.6 group-based outbox

旧 v1/v2 delivery 继续保留 `turnId + peerId` 兼容路径，但每个 legacy helper 必须以 `authorityGroupId IS NULL` 为前置条件并拒绝 canonical row。所有 `resultAuthorityVersion=1` 的新结果只按 `authorityGroupId + peerId` 读取、租约、重试、确认和恢复；`turnId` 只是指向获胜 turn 的诊断字段。投递幂等键为 `groupId + peerId + commitChecksum`。由 manifest 与 group/item/action join 生成桥接 payload 时，必须先证明投影与 manifest 完全一致，再最后覆盖确定性 `messageId/actionId/ordinal/target`，禁止 item/action JSON 中的同名字段反向覆盖权威 identity。因此 original/retry 即使有不同 turn ID，也不可能分别投递。

canonical 与 legacy 可以使用隔离的查询 API，但同一个 outbox pump 必须把两组候选按持久化 `updatedAt` 与稳定 identity 做全局排序后再应用本轮 limit；不能固定把 canonical 拼在 legacy 前面或反过来。否则持续大于 limit 的一侧会让另一侧永久饥饿，等价于更新后破坏旧消息或新消息投递。

“每个 legacy helper”包括列表入口与间接入口，而不只包括最终 `UPDATE`：
`listPendingCloudDeliveries()` 只返回 `authorityGroupId IS NULL`，canonical pump 使用独立
的 group 列表；`recordDeliveryReceipt()`、route/stage/checkpoint、failed recovery、
requeue、prepare/mark/confirm 都必须在任何写入前拒绝 version-1 turn/group。canonical
route 与 stage 需要显式 `expectedTurnRevision` CAS；输出 character message 只能由
canonical visible-result transaction 写入，不能经 `putMessageInternal()` 旁路生成。

committed retry 的恢复顺序同样属于 exactly-once 语义。系统先验证 normalized
envelope、完整 current batch、parent、derived lineage 和存储的 immutable pins；一旦
确认 lineage 已 committed，立即返回原 receipt。它不能先要求当前 lane revision、
rollout revision 或 agency heads 仍等于原生成时的值，因为这些 mutable authority
在成功 commit 后按设计已经推进。

v13 reopen invariant 是运行时恢复闸门，不只是表存在性检查。它拒绝
`resultAuthorityVersion NOT IN (0,1)`，并验证 canonical envelope/checksum、input batch、
release pin、lineage/retry chain、latest owner、committed turn/lineage 的实际 revision
等于 receipt after-revision、manifest JSON/checksum/receipt 的闭合、group/item/action/message
与 manifest 的双向且确定性 identity/semantic join，以及 stance/job/cognitive-state/delivery
的 role/turn/group/ordinal/checksum authority join。input batch 必须逐项重算 batch checksum、
item checksum、顺序和完整 message JSON，并与 normalized envelope 相等；retry 还必须证明
parent/child 的 release、rollout、comparison、preset、batch、visibility 与 annotation pins
相同，`lineageRevisionAtCreation=parent+1`，但允许 child 固定新的有效 agency checksum。
数据库中保留一条 unknown authority version、缺少按 terminal disposition 应存在的
item/action/job projection、parent count/commitment 不一致、错误
deterministic ID、manifest/receipt checksum 不一致或 committed turn revision 与 receipt
脱节，都必须在 worker 恢复前隔离，不能被 Task 11 的“非 0 即 canonical”分支接管。

### 13.4 可见游标

Android 用户批次携带：

- 最近 `nativeCompleted` 虞栖 terminal group；
- 最近 `uiApplied` 虞栖 terminal group；
- 当前聊天页是否打开；
- 引用对象；
- 本地会话 sequence。

PC 不再以“已生成或已入云信箱”推测用户已经看见。

### 13.5 竞态语义

- 主动未提交：用户消息取代主动结果；
- 主动已入 outbox 未到手机：能原子撤销则撤销，否则等待真实交付状态；
- 已 `nativeCompleted` 未 `uiApplied`：直接回复必须把 visible/action-only
  结果作为即将可见前文；skip 虽无 DOM 内容，也必须先由 Web 完成同 group 的
  no-DOM acknowledgement，不能因重载反复恢复；
- 已 `uiApplied`：按普通聊天顺序承接；
- 重启：从数据库 revision 恢复，不重新发送。

### 13.6 重复兜底

同一角色、私聊通道、相邻 authority context 和短时间内，使用正文、动作目标和上下文 revision 形成 `generationFingerprint`。legacy turn 的 authority context 沿用 lane revision；canonical version-1 turn 使用稳定的 `inputVisibilitySequence`，不能使用每次 retry 都会变化的 lane claim revision。这样同一语义 retry 保持同一 fingerprint/checksum，而真正看过新内容后的回复会变化。自动与直接结果指纹完全相同且前一条尚未稳定落地时只允许一个成为权威。不得跨普通时间窗口模糊删除合理重复短句。

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
3. DIRECT_REPLY canary：v3可见，前十个 subject 全部运行稳定版后台对照；
4. 逐 TurnKind 晋级：主动、朋友圈、安排和生活分别晋级。

每个后续 TurnKind 的 canary 也独立分配自己的前十个后台对照；`LIFE_PLANNING`
以 attempt/result subject 计数，不以聊天回合计数。十个 slot 完成后进入观察期，
candidate 可继续可见但不再创建对照，也不再递增 `canary_started_count`。

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

迁移必须事务化、幂等。现有 v10 数据库必须真实执行 10→11，不能只修改 9→10 分支。旧 turn 继续按 `resultAuthorityVersion=0` 的固定旧 schema 和旧 outbox 恢复；只有经新版内部编排显式创建的 canonical-authority turn 才使用 version 1。任何无法证明来源的历史结果不得反向合成 canonical receipt。

CLI 安全边界是强制的：任何 `--dry-run` 都必须带不同于 source 的 `--clone-out`，无论 source 来自 `--config` 还是显式 `--database`；任何 `--apply` 都必须带已批准的 `--expect-report`。这两个条件在构造 `YuqiStore` 之前检查，失败时 source SHA、`user_version` 和表计数必须完全不变。apply 先以 raw read-only 方式核对 source SHA/version/count，再通过 migration-only store 入口在同一迁移事务提交前核对 clone 报告中的 post-migration invariant checksum；不能先让普通 auto-migrating constructor 提交后才比较。重启 invariant 不是“表存在且有几行”的健康检查，而是逐条证明 turn↔lineage↔group↔receipt↔delivery、origin/payload version、revision delta、fingerprint 和 legacy isolation 的完整联结；任一损坏都必须在 runtime 开始处理 turn 之前拒绝打开。

## 17. Android 与正式发布

正式 APK 必须支持：

- v3 fallback snapshot；
- v1/v2向后读取；
- nativeCompleted/uiApplied 可见游标；
- lane revision 和权威消息组；
- `visible/action_only/skip` terminal disposition，且 skip 无气泡、无通知、
  可 exactly-once 完成；
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
