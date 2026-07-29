# 虞栖前台认知与后台记忆巩固系统实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 在保留 AL 当前全部功能、协议和降级能力的前提下，把虞栖的
`memory -> brain` 链路升级为“前台认知 -> 表达 -> 必要时监督”，并增加不阻塞回复的
后台记忆巩固，使虞栖形成连续的自我状态、关系判断和行为决定，而不是只对用户字面内容
做局部应答。

**权威设计：**
`docs/superpowers/specs/2026-07-29-yuqi-cognitive-runtime-design.md`

**总架构：** 保留现有 turn 状态机、动作提交层、Android 执行层、LAN/CLOUD 传输和
legacy fallback。新建严格 schema 的 cognition packet，由认知模型负责理解、状态和
结构化行为意图；表达模型只生成可见文字；确定性适配器把两者装配成现有 brain draft。
每个 turn 固定记录 `legacy | shadow | active`。长期记忆改为提交后的独立队列，不进入
用户可见延迟。

**技术栈：** Node.js ESM、`node:test`、SQLite、Capacitor Web UI、Android Java/Room/
WorkManager、Cloudflare Worker/D1、Codex structured output。

---

## 0. 执行规则

这不是“重写聊天系统”。执行窗口必须按以下顺序推进，不能跳过基线、影子模式或单功能
启用阶段。

1. 先锁定现有能力，再新增代码。
2. 新增接口必须先写失败测试，再写最小实现。
3. 每个任务只提交本任务列出的文件；工作区中的其他修改属于用户，不得覆盖或清理。
4. 每个任务完成后运行该任务的精确测试；每个阶段结束后运行全量测试。
5. `legacy` 始终可用；本计划不授权删除旧管线。
6. 模型永远不能直接写数据库、支付状态、朋友圈、安排、阶段或生活时间线。
7. 不改变非虞栖角色的本地聊天路径。
8. 不把 Codex 对话、开发日志或整份人工批注直接放进运行时 prompt。
9. 任何失败不得把已成功的可见 turn 改成失败，也不得重复发送消息或动作。
10. 普通回合以 60 秒为软目标、300 秒为硬上限；记忆巩固不计入可见回复时间。

每次提交前执行：

```powershell
git diff --check
git status --short
```

只暂存任务明确列出的文件，并用以下命令确认没有夹带用户修改：

```powershell
git diff --cached --name-only
git diff --cached
```

---

## 1. 不得回归的能力总表

下面不是文档清单，而是 Task 1 要生成的机器可读测试矩阵。任何 rollout 晋级 active 前，
对应整行必须通过 legacy、shadow 和 active 三种模式测试。

| 能力域 | 必须保持的行为 | 权威状态/边界 | 必测模式 |
|---|---|---|---|
| 被动私聊 | 一次提交的全部气泡按顺序理解并回复 | `currentBatch`，直接回复不能 skip | legacy/shadow/active |
| 主动私聊 | 按骰子、计划或手动触发，允许有证据的结构性沉默 | 主动 skip 预算、等待用户、明确边界 | legacy/shadow/active |
| 主动朋友圈 | 有生活触发才公开发布，不泄漏私聊信息 | trigger、life state、公共边界 | legacy/shadow/active |
| 朋友圈点赞/评论 | 只能操作 trigger 指定的朋友圈 | momentId/action target | legacy/shadow/active |
| 朋友圈回复 | 保留目标评论线程，只回复指定 comment | momentId/commentId | legacy/shadow/active |
| 安排私聊 | 到点执行、重试、完成一次且不暴露后台任务 | plan occurrence | legacy/shadow/active |
| 安排朋友圈 | 到点发布、目标和完成状态幂等 | plan occurrence | legacy/shadow/active |
| 私密安排私聊 | 与普通安排分开，保持私密目标语义 | private occurrence | legacy/shadow/active |
| 私密安排朋友圈 | 与公开安排分开，仍受公共内容边界约束 | private occurrence | legacy/shadow/active |
| 安排表操作 | 创建、编辑、暂停、恢复、取消、立即执行、完成、删除 | role-plan domain validator | legacy/shadow/active |
| 角色日程 | 当前日程影响人物状态，不被当作用户发言 | role schedule snapshot | legacy/shadow/active |
| 生活时间线 | 可独立推进；聊天可产生合法调整 | life episode/adjustment validator | legacy/shadow/active |
| 长期关系阶段 | `base` 单独复核、写回、留历史、可回退 | Android scene + 状态图 | legacy/shadow/active |
| 当前关系阶段 | `phase` 的冲突/冷却/修复独立于 `base` | Android scene + 状态图 | legacy/shadow/active |
| 阶段专属人设 | 当前 base/phase 对应用户编辑内容进入模型 | 手机 snapshot 是权威 | legacy/shadow/active |
| 红包/转账 | 同时理解关系意义与确定性支付对象 | payment messageId/type/amount/status | legacy/shadow/active |
| 主动支付 | 不放宽钱包和频率约束 | 现有 action/wallet validator | legacy/shadow/active |
| 图片 | 当前批次每张唯一图片供需要的模型读取 | messageId/attachment ownership | legacy/shadow/active |
| 语音 | 有转写则理解 transcript；无转写不得编造内容 | type/duration/transcript | legacy/shadow/active |
| Unicode 表情 | 作为正文保留，不按表情建立固定情绪映射 | message content | legacy/shadow/active |
| 引用 | 保留原说话人、原文和目标，不当作新事实 | quote target messageId | legacy/shadow/active |
| 多气泡 | 当前批次零截断；历史按完整组截取 | batch/group boundary | legacy/shadow/active |
| 删除/重试 | 保留 canonical message 与 retry lineage | existing message/turn lineage | legacy/shadow/active |
| LAN | 签名、去重、结果查询和 receipt 不变 | local protocol | legacy/shadow/active |
| CLOUD | 端到端加密、先持久化再 ack、重复投递幂等 | relay protocol/outbox | legacy/shadow/active |
| Android fallback | PC 不可用时仍可 Memory AI + Chat AI | snapshot v1/v2 dual read | legacy/v2 fallback |
| Android 后台 | 闹钟、WorkManager、重启恢复、通知和未读不回归 | Room turn/attempt/reply parts | all automatic kinds |
| Rollout 权威 | 每类模式只由 PC SQLite revision 决定 | cognition_kind_rollouts | restart/concurrency |
| 离线回放 | fixture/local_history 不计入 live shadow | cognition_replay_runs | 270 + 30 direct |
| 双向对照 | shadow 与 active canary 方向相反且都无副作用 | pinned comparison_mode | both directions |
| 自动回退 | critical finding 只回退对应 kind | PromotionController transaction | crash/restart |
| 备用记忆 | fallback 结果不重写；恢复后只复核证据 | provisional/suppressed facts | fallback/reconcile |
| 手机 MemoryDB | 手工记忆、资料、事件、摘要和向量召回继续可用 | structured localMemoryHints | PC/fallback/import |
| 角色卡与玩家资料 | 当前有效角色设定、额外设定和玩家昵称进入 scene | phone snapshot | legacy/shadow/active |
| 界面会话状态 | 置顶、免打扰、未读、通知不因新管线改变 | phone/Room state | legacy/shadow/active |
| 语音/API/云设置 | 不增加必填模型配置，不覆盖转写或云闹钟绑定 | phone settings | upgrade/import |
| 导入导出 | 旧备份可导入；新字段可缺省 | snapshot schema compatibility | old/new backup |
| 清理/删除 | 按操作类型清理正确的新旧状态 | lifecycle policy | every destructive action |
| 诊断 | 可查模式、阶段和耗时；不泄漏密钥、图片或隐藏预设 | redacted diagnostics | all modes |

九种 `TurnKind` 必须逐字使用现有枚举：

```text
DIRECT_REPLY
ROLE_PLAN_CHAT
ROLE_PLAN_MOMENT
ROLE_PLAN_CHAT_PRIVATE
ROLE_PLAN_MOMENT_PRIVATE
PROACTIVE_CHAT
PROACTIVE_MOMENT
MOMENT_INTERACTION
MOMENT_REPLY
```

---

## Task 1：冻结基线并建立机器可读功能矩阵

**文件：**

- 新建：`tests/fixtures/yuqi-cognition-feature-matrix.json`
- 新建：`tests/yuqi-cognition-feature-matrix.test.mjs`
- 修改：`package.json`

- [ ] **步骤 1：记录实施前基线**

在未改生产代码前运行并保存终端结果：

```powershell
npm.cmd test
Set-Location android
.\gradlew.bat testDebugUnitTest --no-daemon --max-workers=1 --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --max-workers=1 --no-problems-report
Set-Location ..
```

若基线已有失败，只记录现有失败、文件和错误，不得通过删除测试开始实施。

- [ ] **步骤 2：先写矩阵失败测试**

fixture 顶层必须是：

```json
{
  "schemaVersion": 1,
  "turnKinds": {},
  "crossCuttingCapabilities": {}
}
```

测试必须逐项断言：

- 九种枚举全部出现且没有额外名称；
- 每个 kind 声明 `requiredContext`、`allowedActions`、`forbiddenActions`、
  `legacyTests`、`activeTests`；
- 跨域能力至少包含：
  `fullCurrentBatch`、`quotes`、`images`、`voiceMessages`、`unicodeEmoji`、`payment`、
  `baseStage`、`phaseStage`、
  `stagePersona`、`rolePlans`、`roleSchedule`、`lifeTimeline`、`deliveryReceipt`、
  `fallback`、`phoneMemoryDb`、`roleAndPlayerProfile`、`chatUiState`、`settingsCompatibility`、
  `rolloutAuthority`、`replayIsolation`、`liveShadow`、`activeCanary`、`automaticRollback`、
  `staleCompareIsolation`、`canaryBackpressure`、`activeFailureRollback`、
  `lifePlanningTwoPhase`、
  `serviceWorkerUpdate`、`backupRestore`、`clearDelete`；
- 每个能力至少关联一个现有测试和一个本计划中的 cognition-v2 测试；
- `implemented` 测试文件必须真实存在；`planned` 路径必须与本计划某个新建文件逐字一致。

先运行：

```powershell
node --test tests/yuqi-cognition-feature-matrix.test.mjs
```

预期：因 fixture 为空或缺失而失败。

- [ ] **步骤 3：填写矩阵**

为九种 kind 填入第 1 节中的边界。测试路径必须指向实际文件，不能写概念名称。新增测试
暂时可以指向本计划明确将创建的路径，但矩阵测试要区分：

```json
{
  "path": "yuqi-runtime/test/cognitive-pipeline.test.mjs",
  "status": "planned"
}
```

后续 Task 23 会在全部测试文件建立后要求 `planned` 数量为零且每条路径真实存在。

- [ ] **步骤 4：接入总测试**

给 `package.json` 增加独立脚本：

```json
"cognition:matrix": "node --test tests/yuqi-cognition-feature-matrix.test.mjs"
```

并把它放到 `test` 脚本的前段，使缺失能力在耗时测试之前失败。

- [ ] **步骤 5：验证并提交**

```powershell
npm.cmd run cognition:matrix
git add tests/fixtures/yuqi-cognition-feature-matrix.json tests/yuqi-cognition-feature-matrix.test.mjs package.json
git commit -m "test: freeze Yuqi cognition feature matrix"
```

---

## Task 2：把人工批注编译成有条件的认知资产

**文件：**

- 新建：`preset-references/yuqi-social-experience-catalog.json`
- 新建：`yuqi-runtime/presets/cognition-core.md`
- 新建（生成物）：`yuqi-runtime/presets/social-experience.json`
- 新建：`scripts/compile-yuqi-cognition-assets.mjs`
- 新建：`tests/cognition-assets-contract.test.mjs`
- 修改：`scripts/sync-yuqi-preset-assets.mjs`
- 修改：`package.json`

运行时不能直接读取三轮批注。它只读取短核心和已批准经验。

- [ ] **步骤 1：先写资产契约测试**

测试导出接口：

```js
export function validateSourceCatalog(catalog, { rootDir })
export function compileCognitionAssets({ rootDir, checkOnly = false })
```

断言：

- `lessonId` 唯一且匹配 `^lesson_[a-z0-9_]+$`；
- `status` 只能是 `approved | provisional | retired`；
- `approved` 条目至少有一个真实 `sourceRefs.path` 和非空 `section`；
- 每条包含 `priority`、`scenes`、`relationshipStages`、`appliesWhen`、
  `principle`、`counterSignals`、`forbiddenInference`；
- `principle` 不含可复制台词；
- 编译物只含 `approved`；
- 编译物按 `priority desc, lessonId asc` 稳定排序；
- core 不超过 12,000 字符，编译经验不超过 36,000 字符；
- `--check` 在生成物不一致时退出码非零。

先运行：

```powershell
node --test tests/cognition-assets-contract.test.mjs
```

预期：模块或生成物缺失。

- [ ] **步骤 2：编写短核心**

`cognition-core.md` 只写经过第一、二轮批注和已确认讨论支持的规则，固定包括：

1. 先形成虞栖此刻状态和态度，再选择话语；
2. 状态跨轮连续，并被现实时间、身体和生活事件改变；
3. 区分字面行为、关系动作与可能动机；
4. 保留一个主解释和必要的次解释，不把推测升级成事实；
5. 缺点和情绪需要可追溯原因，不能随机表演；
6. 人物有自己的生活、注意力、边界和未完成事项；
7. 回复以当下关系动作自然收束，不追求功能闭环；
8. 记忆通过态度和细节隐性体现，不展示档案；
9. 纠正后的解释短期降权，不能换句话重复；
10. 表面清楚、内在有因；禁止分析腔、客服腔和流程腔；
11. 纯网聊边界；
12. 社会经验只改变关注点，不提供固定台词。

- [ ] **步骤 3：建立经验目录**

目录首批至少覆盖以下通用情境，不把“红包”设为唯一中心：

```text
emotion_before_function
gift_as_relationship_action
explicit_boundary_over_inference
recent_correction_suppresses_repetition
mood_requires_cause
time_changes_state
character_has_own_agenda
ambiguity_without_interrogation
natural_stopping
repair_after_conflict
public_private_boundary
initiative_is_not_service
quoted_text_is_not_new_claim
silence_can_be_relational
commitment_requires_evidence
```

`gift_as_relationship_action` 必须同时声明反信号，禁止推导“红包必然等于示爱”。
未被用户确认的第四轮具体潜台词标为 `provisional`，不得进入生成物。

- [ ] **步骤 4：实现编译器**

编译物格式固定为：

```json
{
  "schemaVersion": 1,
  "generatedFrom": "preset-references/yuqi-social-experience-catalog.json",
  "sourceChecksum": "<sha256>",
  "lessons": []
}
```

`sync-yuqi-preset-assets.mjs` 调用同一个编译函数，不能复制一套校验逻辑。

- [ ] **步骤 5：接入脚本并验证**

`package.json` 增加：

```json
"cognition:sync": "node scripts/compile-yuqi-cognition-assets.mjs",
"cognition:check": "node scripts/compile-yuqi-cognition-assets.mjs --check"
```

把 `cognition:check` 接入 `presets:check`。

```powershell
npm.cmd run cognition:sync
npm.cmd run cognition:check
node --test tests/cognition-assets-contract.test.mjs
```

- [ ] **步骤 6：提交**

```powershell
git add preset-references/yuqi-social-experience-catalog.json yuqi-runtime/presets/cognition-core.md yuqi-runtime/presets/social-experience.json scripts/compile-yuqi-cognition-assets.mjs scripts/sync-yuqi-preset-assets.mjs tests/cognition-assets-contract.test.mjs package.json
git commit -m "feat: compile approved Yuqi cognition assets"
```

---

## Task 3：扩展预设注册表，同时兼容旧角色名和旧版本

**文件：**

- 修改：`yuqi-runtime/presets/manifest.json`
- 新建：`yuqi-runtime/presets/expression.md`
- 新建：`yuqi-runtime/presets/consolidation.md`
- 修改：`yuqi-runtime/presets/supervisor.md`
- 修改：`yuqi-runtime/src/preset-registry.mjs`
- 修改：`yuqi-runtime/test/preset-registry.test.mjs`
- 修改：`tests/rp-preset-contract.test.mjs`

`yuqi-core.md` 继续作为 foundation 来源；现有 `al-combined-rp.md` 和
`memory-manager.md` 在发布迁移完成前不得删除。

- [ ] **步骤 1：先写兼容失败测试**

要求注册表导出并测试：

```js
export const PRESET_ROLES
export const PRESET_ROLE_ALIASES
export function normalizePresetRole(role)
export function resolvePresetBundle({ role, version, annotations })
```

新角色：

```js
["cognition", "expression", "consolidation", "supervisor"]
```

兼容映射：

```js
{
  brain: "expression",
  memory: "consolidation"
}
```

测试必须证明：

- 旧 turn 中保存的 `brain`/`memory` 仍能恢复；
- 旧 `1.9.1` manifest 可读；
- schema 2 manifest 中 `1.9.1` 与 `2.0.0` 都写入 `preset_versions`，但当前指针仍是
  `1.9.1`；
- `resolvePresetBundle({ version: "2.0.0" })` 精确取得候选，不能偷偷使用当前指针；
- 新 bundle 的 cognition 组合顺序固定为
  `foundation -> cognition-core -> matching approved lessons -> cognition annotations`；
- expression 不包含 consolidation 指令；
- consolidation 不包含可发送台词指令；
- 未知角色仍明确失败，不静默回落。

- [ ] **步骤 2：拆分 expression 与 consolidation**

- `expression.md` 继承现有 RP 的口语和微信表达要求，但删除关系决定、事实写库和动作授权；
- `consolidation.md` 继承 `memory-manager.md` 的证据规则，只输出事实候选、关键词、
  冲突和取代关系；
- `supervisor.md` 增加“表达不得发明 cognition 未授权动作”的检查；
- foundation 保持纯网聊、人物基础和世界观。

- [ ] **步骤 3：更新 manifest**

把 manifest 升为可同时保存旧版和候选版的 schema 2：

```json
{
  "schemaVersion": 2,
  "currentVersion": "1.9.1",
  "candidateVersion": "2.0.0",
  "characterId": "yuqi",
  "versions": {
    "1.9.1": {
      "modules": {
        "foundation": "al-combined-rp.md",
        "brain": "yuqi-core.md",
        "memory": "memory-manager.md",
        "supervisor": "supervisor.md"
      }
    },
    "2.0.0": {
      "modules": {
        "foundation": "al-combined-rp.md",
        "cognition": "cognition-core.md",
        "socialExperience": "social-experience.json",
        "expression": "expression.md",
        "consolidation": "consolidation.md",
        "supervisor": "supervisor.md"
      }
    }
  }
}
```

Task 3 只建立 `2.0.0` 候选，`currentVersion` 仍为 `1.9.1`。Task 23 全部闸门通过后才把
`currentVersion` 切换为 `2.0.0`。注册表启动时把 `versions` 中每一项按 checksum 幂等写入
Store，但只按 manifest 的 `currentVersion` 移动当前指针。注册表仍须读取升级前 schema 1
manifest fixture。

- [ ] **步骤 4：验证与提交**

```powershell
node --test yuqi-runtime/test/preset-registry.test.mjs
node --test tests/rp-preset-contract.test.mjs
npm.cmd run presets:check
git add yuqi-runtime/presets/manifest.json yuqi-runtime/presets/expression.md yuqi-runtime/presets/consolidation.md yuqi-runtime/presets/supervisor.md yuqi-runtime/src/preset-registry.mjs yuqi-runtime/test/preset-registry.test.mjs tests/rp-preset-contract.test.mjs
git commit -m "feat: add cognition expression and consolidation presets"
```

---

## Task 4：定义 cognition-v2、expression-v2 与旧 brain draft 的确定性边界

**文件：**

- 新建：`yuqi-runtime/src/cognition-contract.mjs`
- 新建：`yuqi-runtime/test/cognition-contract.test.mjs`
- 修改：`yuqi-runtime/src/role-schemas.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`

- [ ] **步骤 1：先写 schema 和非法权限测试**

接口固定为：

```js
export function normalizeCognitionResult(
  value,
  { validMessageIds, envelope, scene, allowedActionTargets }
)

export function normalizeExpressionResult(value)

export function compileCognitionPacket({
  envelope,
  scene,
  interactionState,
  effectiveRelationshipStage,
  cognitiveState,
  cognitionResult
})

export function materializeBrainDraft(cognitionPacket, expressionResult)
```

失败测试至少包含：

- cognition 引用了不存在的 messageId；
- `DIRECT_REPLY` 返回 `shouldRespond=false`；
- moment 动作指向非 trigger 的 moment/comment；
- payment 动作改写金额、类型或 messageId；
- role-plan operation 不符合现有 domain；
- expression 自行新增 payment/moment/rolePlan/life action；
- base 和 phase 混成一个字段；
- expression 返回隐藏推理或额外字段；
- `rolePlanOperationsJson` 不是合法 JSON 数组。

- [ ] **步骤 2：增加四个 schema**

`role-schemas.mjs` 必须导出：

```js
COGNITION_SCHEMA_V2
EXPRESSION_SCHEMA_V2
CONSOLIDATION_SCHEMA_V2
LIFE_PLANNING_SCHEMA_V2
```

`COGNITION_SCHEMA_V2` 字段严格对应权威设计第 6 节。全部 object 使用
`additionalProperties: false`。证据 ID、action target 和状态转换由 JS 二次校验，不能只
相信 JSON Schema。

- [ ] **步骤 3：实现适配器**

`materializeBrainDraft()` 只做：

- 把 expression 的 `reply` 和 `action` 放回旧 draft；
- 从 cognition packet 复制 payment、moment、rolePlan、life、relationship review；
- 保留 `usedFactIds` 和 rewrite metadata；
- 计算 packet/draft checksum；
- 不调用模型、不查询数据库、不自行补动作。

它的输出必须继续通过当前 `normalizeBrainDraft()`，确保现有 commit 分支不重写。

- [ ] **步骤 4：验证与提交**

```powershell
node --test yuqi-runtime/test/cognition-contract.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
git add yuqi-runtime/src/cognition-contract.mjs yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/src/role-schemas.mjs yuqi-runtime/test/orchestrator.test.mjs
git commit -m "feat: define Yuqi cognition pipeline contracts"
```

---

## Task 5：建立有预算的前台认知上下文与经验召回

**文件：**

- 新建：`yuqi-runtime/src/social-experience.mjs`
- 新建：`yuqi-runtime/test/social-experience.test.mjs`
- 新建：`yuqi-runtime/src/cognition-context.mjs`
- 新建：`yuqi-runtime/test/cognition-context.test.mjs`
- 修改：`yuqi-runtime/src/conversation-context.mjs`
- 修改：`yuqi-runtime/test/conversation-context.test.mjs`
- 修改：`yuqi-runtime/src/image-attachments.mjs`
- 修改：`yuqi-runtime/test/image-attachments.test.mjs`

- [ ] **步骤 1：先写经验召回测试**

接口：

```js
export function loadSocialExperienceCatalog(filePath)

export function selectSocialExperience({
  catalog,
  turnKind,
  currentBatch,
  trigger,
  relationshipStage,
  routeReasons,
  limit = 5
})
```

评分只使用可解释信号：

```text
scene match + stage match + appliesWhen term match + route reason match
- counterSignal match
+ normalized priority
```

同分按 `lessonId` 排序。最多 5 条。禁止通过模型先分类再召回，以免增加一次关键路径调用。

- [ ] **步骤 2：先写上下文预算测试**

接口：

```js
export const COGNITION_CONTEXT_LIMITS = Object.freeze({
  recentMessages: 20,
  combinedMemoryItems: 8,
  openThreads: 3,
  socialLessons: 5
})

export async function buildCognitionContext({
  store,
  envelope,
  scene,
  localMemoryHints,
  currentBatch,
  interactionState,
  cognitiveState,
  lifeContext,
  catalog
})
```

测试固定以下裁剪顺序：

1. 低分经验；
2. 低分自动提取的手机记忆提示；
3. 低分 PC 长期事实；
4. 最旧完整历史组。

永不裁剪：

- 当前完整 batch 的任何气泡；
- trigger 目标；
- 当前 base、phase 和阶段专属人设；
- active explicit boundary；
- quote/payment/image 的所属 messageId。

PC verified facts 与 `localMemoryHints` 合计最多 8 条。手机手工记忆优先于自动提取提示；
PC verified fact 和手工记忆均保留 provenance，不把两者拼成无来源总结。`localMemoryHints`
格式：

```json
{
  "recordId": "",
  "sourceType": "manual|profile|event|summary|vector",
  "text": "",
  "createdAt": 0,
  "importance": 1,
  "score": 0
}
```

PC 只把它用于本轮认知。除 `sourceType=manual` 或存在原始 messageId 的提示外，不允许直接
写成 verified fact。

当前不可裁剪内容自身超过模型上限时返回
`CognitionContextOverflowError`，并携带各区域字符数；不得静默只取最后一个气泡。

- [ ] **步骤 3：保持分组语义**

修改 `conversation-context.mjs`，让“最近 20 条”继续按完整用户批次和完整角色回复组截取。
增加测试：第 20 条边界落在一个三气泡批次中时，整组保留或整组移除，不能切半。

- [ ] **步骤 4：统一图片 materialization**

为 `image-attachments.mjs` 增加：

```js
export async function materializeRoleImages({
  messages,
  role,
  dedupeByChecksum = true
})
```

cognition、expression 和必要的 supervisor 都使用这一入口。相同图片只传一次，但每个
原 messageId 仍保留引用。base64 不进入持久 prompt JSON、日志或诊断。

- [ ] **步骤 5：验证与提交**

```powershell
node --test yuqi-runtime/test/social-experience.test.mjs
node --test yuqi-runtime/test/cognition-context.test.mjs
node --test yuqi-runtime/test/conversation-context.test.mjs
node --test yuqi-runtime/test/image-attachments.test.mjs
git add yuqi-runtime/src/social-experience.mjs yuqi-runtime/test/social-experience.test.mjs yuqi-runtime/src/cognition-context.mjs yuqi-runtime/test/cognition-context.test.mjs yuqi-runtime/src/conversation-context.mjs yuqi-runtime/test/conversation-context.test.mjs yuqi-runtime/src/image-attachments.mjs yuqi-runtime/test/image-attachments.test.mjs
git commit -m "feat: build bounded Yuqi cognition context"
```

---

## Task 6：迁移 SQLite，保存每回合模式、认知状态和巩固队列

**文件：**

- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/test/protocol-store.test.mjs`
- 新建：`yuqi-runtime/test/store-cognition-migration.test.mjs`
- 修改：`scripts/backup-yuqi-memory.mjs`
- 修改：`scripts/audit-yuqi-memory.mjs`
- 新建：`tests/yuqi-memory-backup.test.mjs`

- [ ] **步骤 1：先写旧数据库迁移测试**

测试先创建只含升级前 schema 的临时 DB，插入：

- 一个 `memory_done` pending turn；
- 一组 raw messages；
- verified/suppressed facts；
- preset version；
- annotation；
- life state。

再用新 `Store` 打开两次，证明迁移幂等且所有旧数据仍在。

- [ ] **步骤 2：增加 turn 固定模式**

给 turns 增加：

```sql
pipeline_mode TEXT NOT NULL DEFAULT 'legacy',
preset_version TEXT NOT NULL DEFAULT '1.9.1',
annotation_snapshot_json TEXT NOT NULL DEFAULT '{}'
```

允许值只在程序层为 `legacy | shadow | active`。turn 首次创建时同时固定 pipeline mode、
preset version 和当时启用的 role annotation IDs/checksums；重试、恢复和服务重启都读取
保存值，不重新查看全局开关或后来更新的批注。旧 pending turn 迁移为
`legacy + 1.9.1 + {}`，按旧 checkpoint 恢复。

- [ ] **步骤 3：增加认知状态表**

```sql
CREATE TABLE IF NOT EXISTS cognitive_states (
  role_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  last_turn_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

方法：

```js
getCognitiveState(roleId)
putCognitiveStateInternal(state)
deleteCognitiveStateInternal(roleId)
```

写入必须 compare revision/checksum；同一 turn 重试幂等，旧 revision 抛
`CognitiveStateConflictError`。

- [ ] **步骤 4：增加巩固队列和 backfill cursor**

```sql
CREATE TABLE IF NOT EXISTS consolidation_jobs (
  job_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  turn_id TEXT,
  role_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  payload_json TEXT NOT NULL,
  payload_checksum TEXT NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, job_type),
  CHECK(subject_type IN ('turn', 'role_history', 'life_planning')),
  CHECK(
    (subject_type = 'turn' AND turn_id IS NOT NULL)
    OR (subject_type <> 'turn' AND turn_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS consolidation_backfill_cursors (
  role_id TEXT PRIMARY KEY,
  last_completed_group_key TEXT,
  last_checksum TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cognition_shadow_runs (
  run_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  turn_id TEXT,
  rollout_key TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source = 'live'),
  comparison_direction TEXT NOT NULL,
  evidence_epoch INTEGER NOT NULL,
  shadow_epoch INTEGER,
  canary_epoch INTEGER,
  canary_slot INTEGER,
  rollout_revision INTEGER NOT NULL,
  pipeline_checksum TEXT NOT NULL,
  state TEXT NOT NULL,
  authoritative_result_checksum TEXT,
  comparison_result_checksum TEXT,
  metrics_json TEXT,
  critical_findings_json TEXT,
  latency_ms INTEGER,
  error_code TEXT,
  stale_for_rollout INTEGER NOT NULL DEFAULT 0,
  source_deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(subject_type, subject_id, comparison_direction),
  CHECK(subject_type IN ('turn', 'life_planning'))
);
```

队列方法：

```js
createConsolidationJobInternal(job)
claimDueConsolidationJob({ workerId, jobTypes, now, leaseMs })
completeConsolidationJob({ jobId, workerId, now })
failConsolidationJob({ jobId, workerId, now, errorCode, nextDueAt })
listRecoverableConsolidationJobs({ now })
putCognitionShadowRunInternal(run)
getCognitionShadowRun(runId)
listLiveShadowRuns({ rolloutKey, direction, since })
countOutstandingComparisonSubjects({
  rolloutKey,
  direction,
  evidenceEpoch,
  shadowEpoch = null,
  canaryEpoch = null,
  now
})
advanceConsolidationBackfillCursor(cursor)
```

所有 `*Internal` 写方法沿用现有 Store 约定：只能在调用方建立的
`store.transaction(...)` 回调中使用，自身不开始、提交或回滚事务。跨表原子操作由外层
Controller/Store 方法持有唯一事务，避免 better-sqlite3 嵌套事务。

状态固定为 `queued | running | retry_wait | completed | failed | cancelled`。`job_type` 固定为
`turn_consolidation | history_backfill | shadow_cognition | active_canary_compare`。turn
consolidation/compare 使用 `subject_type=turn`；历史补提取使用
`subject_type=role_history, subject_id=<roleId>:<cursor>`；独立生活规划 compare 使用
`subject_type=life_planning`。worker 只能 claim 自己声明的 jobTypes；巩固和 compare job
都不得写 turn 的可见状态。
`payload_json` 必须是 canonical JSON；创建时由 Store 自己计算 `payload_checksum`，调用者
不能自报 checksum。claim/recover 后先重算并核对，损坏时将 job 置 failed 并写
`JOB_PAYLOAD_CHECKSUM_MISMATCH`，不得用当前 rollout 或当前 preset 猜测重建。唯一键冲突时
只有 payload checksum 相同才可幂等返回，否则抛 `ConsolidationJobConflictError`。
`cognition_shadow_runs.source` 只能是 `live`；Task 14 的任何离线或本机历史回放都不得写入
此表。

`countOutstandingComparisonSubjects()` 统计的是当前 evidence/window 中尚未完成权威管线或
后台 compare 的 subject，不是只统计已经创建的 job。Task 6 先覆盖 foreground turn 和
queued/running/retry_wait compare job；Task 19 建 attempt 表后扩展同一查询，把
created/running/retry_wait life attempt 纳入。completed/failed/cancelled 和 stale epoch
不算。canary 熔断统计已分配 slot 的 cognition-authoritative subject；shadow 晋级闸门
统计当前 shadow epoch 的所有 legacy-authoritative subject。

- [ ] **步骤 5：覆盖备份**

现有 SQLite 文件级快照应自然包含新表；`tests/yuqi-memory-backup.test.mjs` 创建临时旧库、
迁移、快照并重新打开快照，逐表核对行数。为兼容
`tests/yuqi-deployment-contract.test.mjs`，现有 `createMemorySnapshot()` 继续返回 snapshot
路径字符串。新增：

```js
export function inspectMemorySnapshot(snapshotPath)
```

返回：

```js
{
  snapshotPath,
  sha256,
  schemaVersion,
  tableCounts
}
```

命令行仍输出 JSON。审计脚本只输出表行数、schema version 和 SHA-256，不打印
`state_json`、prompt 或图片。

- [ ] **步骤 6：验证与提交**

```powershell
node --test yuqi-runtime/test/store-cognition-migration.test.mjs
node --test yuqi-runtime/test/protocol-store.test.mjs
node --test tests/yuqi-memory-backup.test.mjs
git add yuqi-runtime/src/store.mjs yuqi-runtime/test/protocol-store.test.mjs yuqi-runtime/test/store-cognition-migration.test.mjs scripts/backup-yuqi-memory.mjs scripts/audit-yuqi-memory.mjs tests/yuqi-memory-backup.test.mjs
git commit -m "feat: persist cognition state and consolidation jobs"
```

---

## Task 7：实现独立的认知管线并先以 shadow 运行

**文件：**

- 新建：`yuqi-runtime/src/cognitive-pipeline.mjs`
- 新建：`yuqi-runtime/test/cognitive-pipeline.test.mjs`
- 新建：`yuqi-runtime/src/shadow-dispatcher.mjs`
- 新建：`yuqi-runtime/test/shadow-dispatcher.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`yuqi-runtime/src/codex-client.mjs`
- 修改：`yuqi-runtime/test/codex-client.test.mjs`
- 修改：`yuqi-runtime/src/main.mjs`
- 修改：`yuqi-runtime/config.example.json`

- [ ] **步骤 1：先写管线状态测试**

构造器和入口：

```js
export class CognitivePipeline {
  constructor({
    store,
    codexClient,
    presetRegistry,
    routePolicy,
    clock,
    diagnostics
  })

  async runForeground({
    turn,
    envelope,
    scene,
    currentBatch,
    routeDecision
  })

  async runShadow(input)
}
```

测试：

- fast cognition 可请求一次 deep escalation；
- deep escalation 不重复构造或截断 currentBatch；
- cognition 成功、expression 失败后重试只跑 expression；
- supervisor 重写只重跑 expression，不改 cognition action；
- 直接消息永不 skip；
- turn 的 pipeline mode 在配置改变后仍固定；
- turn 的 preset version/annotation snapshot 在候选发布或批注更新后仍固定；
- shadow 的 visible result 完全来自 legacy；
- shadow 失败不改变 visible turn；
- checkpoint 仍落在旧 `memory_*`/`brain_*` 状态，并通过 packet type 区分；
- 同一 turn 不会同时跑 legacy active 和 cognition active。

- [ ] **步骤 2：显式传递 turnId**

把 `runStructuredRole()` 改成显式参数：

```js
runStructuredRole({
  turnId,
  role,
  task,
  schema,
  prompt,
  images,
  modelProfile,
  sessionKey
})
```

删除从 prompt 正则猜 turnId 的逻辑。所有现有调用点和测试一起更新。

- [ ] **步骤 3：实现 foreground**

固定步骤：

```text
load pinned pipeline mode
-> build cognition context
-> run fast/deep cognition
-> normalize and persist cognition-v2 packet at memory_done
-> run expression
-> materialize legacy-compatible brain draft
-> optional supervisor/rewrite
-> return existing approved draft shape
```

不在此类中提交支付、朋友圈、安排或 stage；仍交给现有 orchestrator commit。

- [ ] **步骤 4：实现持久 shadow 队列**

只有测试中已显式固定为 `pipeline_mode=shadow`（Task 13 完成后同时固定
`comparison_mode=cognition_compare`）的 turn，才在 legacy 可见结果提交事务创建唯一
`job_type=shadow_cognition` job；普通 legacy 不创建。Task 7 不自行判断哪些 TurnKind 应
进入 shadow。`ShadowDispatcher` 单并发运行，并且只在 TurnDispatcher 没有正在执行的可见
turn 时 claim；服务重启后可恢复，但 shadow job 不能抢占新可见 turn。接口：

```js
export class ShadowDispatcher {
  constructor({ store, cognitivePipeline, foregroundActivity, clock, workerId })
  start()
  stop()
  async runOnce()
}
```

shadow job 完成后保存：

- legacy route/action 摘要；
- cognition 决定摘要；
- action 一致性；
- base/phase 差异；
- 是否遗漏 currentBatch 中的 messageId；
- latency；
- error code。

不得保存完整隐藏 prompt 或图片。shadow 失败按 5 分钟、30 分钟两次退避；第三次失败标记
failed，不影响 visible turn，也不进入 Android fallback。

- [ ] **步骤 5：加入配置**

`config.example.json`：

```json
{
  "cognitionRuntime": {
    "presetVersion": "2.0.0",
    "softDeadlineMs": 60000,
    "hardDeadlineMs": 300000,
    "rolloutBootstrap": {
      "schemaVersion": 1,
      "defaultMode": "legacy",
      "defaultPhase": "stable"
    }
  }
}
```

Task 7 只定义 bootstrap 格式，不让配置成为运行时模式权威。Task 13 建表时读取一次，表
存在后忽略其模式字段。shadow/active turn 创建时固定 `presetVersion`；legacy turn 继续
使用当前 `1.9.1` 指针。候选不存在或 checksum 冲突时，shadow 不运行，active 拒绝创建并
进入现有 fallback，不能静默换成另一版本；Task 15 接入后，已固定 active 的此类失败还要
通过 PromotionController 自动回退对应 rollout。

- [ ] **步骤 6：验证与提交**

```powershell
node --test yuqi-runtime/test/cognitive-pipeline.test.mjs
node --test yuqi-runtime/test/shadow-dispatcher.test.mjs
node --test yuqi-runtime/test/codex-client.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
git add yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/src/shadow-dispatcher.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/src/codex-client.mjs yuqi-runtime/test/codex-client.test.mjs yuqi-runtime/src/main.mjs yuqi-runtime/config.example.json
git commit -m "feat: run Yuqi cognition pipeline in shadow mode"
```

---

## Task 8：使被动私聊具备 active 能力，同时保留全部结构化行为

**文件：**

- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`yuqi-runtime/src/route-policy.mjs`
- 修改：`yuqi-runtime/test/route-policy.test.mjs`
- 修改：`yuqi-runtime/src/current-user-batch.mjs`
- 修改：`yuqi-runtime/test/current-user-batch.test.mjs`
- 修改：`tests/payment-batch-bridge-contract.test.mjs`

- [ ] **步骤 1：先写 DIRECT_REPLY 集成失败测试**

一个表驱动测试必须覆盖：

1. 三个普通气泡，决定引用前两条而不是只看最后一条；
2. 普通文字 + quote；
3. 普通文字 + 一张图片；
4. 两张分属不同 messageId 的图片；
5. 有 transcript 的语音，保留类型、时长和转写；
6. 无 transcript 的语音，禁止虚构语音内容；
7. 含 Unicode 表情的普通正文，不作固定情绪映射；
8. 普通文字 + 红包；
9. 普通文字 + 转账；
10. 最近纠正仍有效；
11. base 保持、phase 变化；
12. base 和 phase 同时提出合法变化；
13. expression 首次非法、第二次修复；
14. hard deadline；
15. 服务重启后从 cognition checkpoint 恢复；
16. 用户撤回后该消息不进入重试上下文；
17. 删除消息后对应证据不再召回；
18. 玩家昵称、虞栖角色卡、会话额外设定和阶段人设同时存在且装配顺序稳定。

每例同时断言旧 commit 输出字段不变：reply parts、payment action、moment action、
rolePlan operations、life adjustment、relationship stage review、outbox metadata。

- [ ] **步骤 2：保持路由语义**

route policy 仍根据完整 batch、关系风险、支付、纠正、冲突和上下文缺失决定 fast/deep。
新增 `requiresDeepCognition` 只能把 fast 升 deep，不能把现有 deep 降 fast。

- [ ] **步骤 3：只服从 turn 已固定的 pipeline mode**

只有满足以下条件才走新管线：

```js
turn.pipelineMode === "active"
```

Orchestrator 不再查看配置、当前 rollout 或 kind allowlist。Task 13 负责在创建 turn 时决定
并固定模式；Task 8 的测试直接构造固定 active/legacy turn。`currentBatch` 只由已有
canonical builder 构造一次，新旧管线共享同一对象或深冻结副本，不能各自重新从“最后消息”
推导。

- [ ] **步骤 4：支付回归**

支付的金额、类型、状态和 messageId 仍来自协议。模型只可选择现有允许动作。重复 turn、
重试和云重复投递不得二次领取/拒绝或产生第二条回复。

- [ ] **步骤 5：验证与提交**

```powershell
node --test yuqi-runtime/test/current-user-batch.test.mjs
node --test yuqi-runtime/test/route-policy.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
node --test tests/payment-batch-bridge-contract.test.mjs
git add yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/src/route-policy.mjs yuqi-runtime/test/route-policy.test.mjs yuqi-runtime/src/current-user-batch.mjs yuqi-runtime/test/current-user-batch.test.mjs tests/payment-batch-bridge-contract.test.mjs
git commit -m "feat: support cognition for direct Yuqi replies"
```

---

## Task 9：实现连续但受控的角色认知状态

**文件：**

- 新建：`yuqi-runtime/src/cognitive-state.mjs`
- 新建：`yuqi-runtime/test/cognitive-state.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`yuqi-runtime/src/life-simulation.mjs`
- 修改：`yuqi-runtime/test/life-simulation.test.mjs`

- [ ] **步骤 1：先写 reducer 测试**

接口：

```js
export function normalizeCognitiveState(value)

export function reduceCognitiveState({
  previous,
  cognitionPacket,
  committedTurn,
  lifeState,
  now
})
```

测试必须证明：

- 没有前态时生成合法初始状态；
- 同一 turn 重放得到相同 checksum；
- 未提交、监督否决或 failed turn 不更新；
- 合法 proactive skip 可以更新；
- mood 不每轮清零；
- 长时间经过和 life event 可以降低/改变强度；
- `openThreads` 最多 3 个并有 source turn；
- `recentCorrection` 最多经过两个新用户 batch 后过期；
- direct turn 不允许用 state 让回复 skip；
- state 不写 `base`/`phase`，也不覆盖手机 scene；
- 并发旧 revision 被拒绝。

- [ ] **步骤 2：定义归一化状态**

除设计文档字段外，每个 open thread 必须包含：

```json
{
  "threadId": "stable_hash",
  "summary": "",
  "waitingOn": "user|yuqi|none",
  "sourceTurnId": "",
  "lastTouchedAt": 0
}
```

`activeBoundaries` 每项包含来源 messageId 和过期策略；无来源的模型边界不得持久化为用户
明确边界。

- [ ] **步骤 3：事务内提交**

在现有 `commitApproved()` 事务中：

```text
commit existing messages/actions/stage result
-> write cognitive state with compare revision
-> enqueue consolidation job
-> commit once
```

任一步失败，事务整体回滚；不能出现动作已提交但 cognitive state 假装更新成功。

- [ ] **步骤 4：生活事件影响**

`life-simulation.mjs` 只把当前 episode、时间流逝、身体和注意力信号提供给 reducer，不直接
生成对用户的态度，不自行写台词。

- [ ] **步骤 5：验证与提交**

```powershell
node --test yuqi-runtime/test/cognitive-state.test.mjs
node --test yuqi-runtime/test/life-simulation.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
git add yuqi-runtime/src/cognitive-state.mjs yuqi-runtime/test/cognitive-state.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/src/life-simulation.mjs yuqi-runtime/test/life-simulation.test.mjs
git commit -m "feat: persist Yuqi cognitive continuity"
```

---

## Task 10：把 base、phase、阶段人设和原子写回固定为不可破坏契约

**文件：**

- 修改：`yuqi-runtime/src/relationship-stage.mjs`
- 修改：`yuqi-runtime/test/relationship-stage.test.mjs`
- 修改：`yuqi-runtime/src/cognition-contract.mjs`
- 修改：`yuqi-runtime/test/cognition-contract.test.mjs`
- 修改：`tests/yuqi-ui-contract.test.mjs`
- 修改：`tavern-app/index.html`

本任务主要增加契约和兼容处理。若现有 UI 已满足，不得为“架构整洁”重写阶段编辑器。

- [ ] **步骤 1：先写阶段组合测试**

覆盖矩阵：

| 输入 | 允许结果 |
|---|---|
| base 不变，normal -> conflict | 只写 phase |
| base 升级，phase 保持 conflict | base 升级且 conflict 保留 |
| phase conflict -> repair，base 不变 | 只写 phase |
| base 降级但证据不足 | 拒绝 base，合法 phase 可独立处理 |
| base 合法、phase 状态图非法 | 两个动作都不部分应用 |
| 手机 scene revision 已更新 | 返回冲突，不覆盖手机新值 |

现有阈值和状态图必须原样锁定：

```text
base new <-> acquainted: 0.78
base acquainted <-> familiar: 0.80
base familiar <-> close: 0.84
base close <-> committed: 0.88，且 committed 必须 explicitMutualChange
普通 base 变化至少 2 个真实 evidenceMessageIds，explicit mutual change 至少 1 个
非 explicit base 每次最多移动相邻一级

phase normal -> conflict
phase conflict -> cooling | repair
phase cooling -> conflict | repair
phase repair -> normal | conflict | cooling
phase 普通变化阈值 0.80 且至少 2 个真实证据
phase explicitAcknowledgedChange 阈值 0.78 且至少 1 个真实证据
```

cognition 只能提出 review，不能修改这些阈值。

- [ ] **步骤 2：保持手机 scene 权威**

cognition input 使用手机 snapshot 的：

```text
relationshipStage
stageCatalog
phaseCatalog
currentPhase
effectiveStagePersona
stagePersonaRevision
```

PC 认知状态没有这些字段的覆盖权。

- [ ] **步骤 3：原子结果**

结果继续分别携带 `baseAction` 和 `phaseAction`，同时带 expected scene revision。前端应用时：

1. 先校验两个动作；
2. 再一次事务写入当前值和历史；
3. 任一失败则都不写；
4. 回复正文可按现有语义落库，但明确显示/记录 stage writeback failure；
5. 用户可从原有版本历史回退。

- [ ] **步骤 4：保持阶段专属人设编辑**

UI contract 必须断言：

- base 和 phase 各阶段内容仍可编辑；
- active scene 只装配当前有效内容；
- 版本历史和回退按钮仍存在；
- import/export 包含全部 stage persona；
- 新 cognitive state 不覆盖用户编辑文本。

- [ ] **步骤 5：验证与提交**

```powershell
node --test yuqi-runtime/test/relationship-stage.test.mjs
node --test yuqi-runtime/test/cognition-contract.test.mjs
node --test tests/yuqi-ui-contract.test.mjs
git add yuqi-runtime/src/relationship-stage.mjs yuqi-runtime/test/relationship-stage.test.mjs yuqi-runtime/src/cognition-contract.mjs yuqi-runtime/test/cognition-contract.test.mjs tests/yuqi-ui-contract.test.mjs tavern-app/index.html
git commit -m "test: preserve atomic relationship stage behavior"
```

---

## Task 11：实现提交后运行的后台记忆巩固 Worker

**文件：**

- 新建：`yuqi-runtime/src/consolidation-worker.mjs`
- 新建：`yuqi-runtime/test/consolidation-worker.test.mjs`
- 修改：`yuqi-runtime/src/evidence-memory.mjs`
- 修改：`yuqi-runtime/test/evidence-memory.test.mjs`
- 修改：`yuqi-runtime/src/main.mjs`
- 修改：`yuqi-runtime/src/reconcile.mjs`
- 修改：`yuqi-runtime/test/reconcile.test.mjs`

- [ ] **步骤 1：先写 worker 生命周期测试**

接口：

```js
export class ConsolidationWorker {
  constructor({
    store,
    codexClient,
    presetRegistry,
    clock,
    workerId,
    pollIntervalMs = 5000
  })

 start()
  stop()
  async runOnce()
  async runBackfillOnce({ roleId, maxGroups = 10 })
}
```

`runOnce()` 只 claim `turn_consolidation`；`runBackfillOnce()` 只 claim
`history_backfill`。它们不得取走 `shadow_cognition`。

测试：

- 单并发 lease；
- 同一 turn 每种 job_type 只能有一个 job；shadow 与 consolidation 可以各有一个；
- 崩溃后 lease 过期可恢复；
- 失败退避依次为 1 分钟、5 分钟、30 分钟、2 小时；
- 第五次仍失败进入 `failed`，可被审计工具手动重新排队；
- job 失败不改变 turn 的 `completed/delivered`；
- 自动 trigger 不当作用户事实；
- 未送达虞栖草稿只生成 suppressed/provisional；
- 已送达消息可支持 verified character fact；
- 重跑不产生重复 fact；
- backfill 按完整 batch/reply group，不切断；
- worker 不产生 typing、通知或未读。

- [ ] **步骤 2：复用现有证据校验**

巩固结果必须继续经过：

```js
validateFactCandidate()
commitVerifiedFacts()
```

新增 source 类型：

```text
user_visible_message
yuqi_delivered_message
fallback_provisional
```

不能新增绕过 evidence rule 的“模型总结事实表”。

- [ ] **步骤 3：接入主进程**

`main.mjs` 在 Store 和 TurnDispatcher 就绪后启动一个 worker；优雅停止时先停止领新 job，再
等待当前 job 到安全 checkpoint。TurnDispatcher 和 ConsolidationWorker 使用不同 lease
owner 和队列。

- [ ] **步骤 4：改造 reconcile**

PC 恢复后的备用日志：

- 不重发 fallback 回复；
- 不改已显示正文；
- 只把 provisional 证据交给 consolidation；
- 发现手机已经删除/抑制的消息时取消对应候选；
- 用 delivery receipt 决定虞栖侧证据是否可检索。

- [ ] **步骤 5：验证与提交**

```powershell
node --test yuqi-runtime/test/consolidation-worker.test.mjs
node --test yuqi-runtime/test/evidence-memory.test.mjs
node --test yuqi-runtime/test/reconcile.test.mjs
git add yuqi-runtime/src/consolidation-worker.mjs yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/src/evidence-memory.mjs yuqi-runtime/test/evidence-memory.test.mjs yuqi-runtime/src/main.mjs yuqi-runtime/src/reconcile.mjs yuqi-runtime/test/reconcile.test.mjs
git commit -m "feat: consolidate Yuqi memory after visible turns"
```

---

## Task 12：为 LAN 和 CLOUD 增加精确、幂等的送达回执

**文件：**

- 修改：`yuqi-runtime/src/protocol.mjs`
- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/src/local-server.mjs`
- 修改：`yuqi-runtime/test/local-server.test.mjs`
- 修改：`yuqi-runtime/src/cloud-relay-pump.mjs`
- 修改：`yuqi-runtime/test/cloud-relay-pump.test.mjs`
- 修改：`yuqi-relay-worker.js`
- 修改：`tests/yuqi-relay-worker.test.mjs`
- 修改：`tavern-app/index.html`
- 修改：`tests/yuqi-ui-contract.test.mjs`

- [ ] **步骤 1：先写 receipt 协议测试**

请求：

```json
{
  "protocolVersion": 1,
  "turnId": "turn_x",
  "deliveredAt": 0,
  "items": [
    {
      "kind": "message",
      "id": "message_x",
      "checksum": "sha256"
    },
    {
      "kind": "action",
      "id": "action_x",
      "checksum": "sha256"
    }
  ]
}
```

断言：

- turnId 和 item 必须属于同一结果；
- checksum 与 PC approved result 一致；
- 重复 receipt 幂等；
- 部分 receipt 不把未确认 item 标为送达；
- 乱序 receipt 可合并；
- 未知 item 明确拒绝；
- LAN 继续校验现有签名；
- CLOUD 继续走现有端到端加密信封；
- relay 先持久化再 ack；
- receipt 不包含正文。

- [ ] **步骤 2：统一 Store 接口**

```js
recordDeliveryReceipt({ turnId, deliveredAt, items })
getDeliveryState(turnId)
```

本地和云端必须调用同一 Store 方法，不能各维护一套“已送达”判断。

- [ ] **步骤 3：手机精确落库后发送**

`tavern-app/index.html` 在以下对象真正写入 IndexedDB/MemoryDB/原生桥后才发 receipt：

- 所有 reply parts；
- payment action；
- moment post/like/comment/reply；
- role-plan operation；
- life adjustment；
- stage base/phase result。

如果只落库了一部分，发送部分 receipt，重启恢复后补齐。发送失败不回滚手机已显示内容，
由现有重试机制补发。

- [ ] **步骤 4：将 receipt 接到事实可见性**

用户消息事实不依赖虞栖回复 receipt；任何由虞栖正文或动作支撑的事实在 receipt 前保持
suppressed/provisional，receipt 后由 worker 幂等提升。

- [ ] **步骤 5：验证与提交**

```powershell
node --test yuqi-runtime/test/local-server.test.mjs
node --test yuqi-runtime/test/cloud-relay-pump.test.mjs
node --test tests/yuqi-relay-worker.test.mjs
node --test tests/yuqi-ui-contract.test.mjs
git add yuqi-runtime/src/protocol.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/local-server.mjs yuqi-runtime/test/local-server.test.mjs yuqi-runtime/src/cloud-relay-pump.mjs yuqi-runtime/test/cloud-relay-pump.test.mjs yuqi-relay-worker.js tests/yuqi-relay-worker.test.mjs tavern-app/index.html tests/yuqi-ui-contract.test.mjs
git commit -m "feat: confirm exact Yuqi result delivery"
```

---

## Task 13：建立逐 TurnKind 的唯一 rollout 权威与晋级控制器

**文件：**

- 新建：`yuqi-runtime/src/promotion-controller.mjs`
- 新建：`yuqi-runtime/test/promotion-controller.test.mjs`
- 新建：`tests/yuqi-rollout-authority-contract.test.mjs`
- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/test/store-cognition-migration.test.mjs`
- 修改：`yuqi-runtime/src/turn-dispatcher.mjs`
- 修改：`yuqi-runtime/test/turn-dispatcher.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`yuqi-runtime/config.example.json`

**接口：**

- 消费：Task 6 的 turn 固定字段、background job 和 shadow run 表。
- 产出：`PromotionController`、rollout 持久表、原子 turn pinning，供 Task 14–23 使用。

- [ ] **步骤 1：先写 rollout 迁移和唯一权威失败测试**

测试必须证明：

- 空数据库初始化九种 TurnKind 和 `LIFE_PLANNING` 共十个 rollout key；
- 配置只在表为空时 bootstrap；
- 表已有数据后修改配置并重启，不覆盖数据库当前模式；
- `cognition_promotion_history` 只能追加，不能决定当前模式；
- 两个进程用相同 expected revision 晋级，只有一个成功；
- 内存缓存 revision 落后时必须重新读 Store；
- 旧数据库迁移后所有 key 默认 `legacy + stable`；
- 首次初始化 revision=1、evidence_epoch=1、shadow_epoch=0、canary_epoch=0；
- 重启时实际 evidence manifest 任一组成变化，会在接收新 turn 前原子开启新 epoch；只改
  无关 UI/文档不会变化；
- manifest 读取中途变化或批量刷新失败时，十个 key 不得出现半数新 checksum、半数旧
  checksum；
- 重复迁移不重复 history。

先运行：

```powershell
node --test yuqi-runtime/test/promotion-controller.test.mjs
node --test yuqi-runtime/test/store-cognition-migration.test.mjs
```

预期：表和控制器尚不存在。

- [ ] **步骤 2：增加 rollout、history 和报告表**

`pipeline_checksum` 不是调用者自报版本号，而是以下 canonical evidence manifest 的
SHA-256：

```json
{
  "cognitionPresetChecksum": "",
  "expressionPresetChecksum": "",
  "supervisorPresetChecksum": "",
  "schemaAdapterBundleChecksum": "",
  "modelProfileChecksum": "",
  "approvedAnnotationCatalogChecksum": "",
  "comparisonEvaluatorChecksum": "",
  "legacyBaselineChecksum": ""
}
```

PresetRegistry 按 rollout key 从实际文件和已加载模块清单重算：共享 preset/model/evaluator
进入所有 key，kind-specific schema/adapter 只进入受影响 key，LIFE_PLANNING 使用自己的
adapter 清单。无关 UI/文档改动不改变它，任何会改变该 key 管线行为或比较结论的组件改动
都会改变它。配置、CLI 和 Android 都不能直接提供任意 checksum。

```sql
CREATE TABLE IF NOT EXISTS cognition_kind_rollouts (
  rollout_key TEXT PRIMARY KEY,
  current_mode TEXT NOT NULL,
  rollout_phase TEXT NOT NULL,
  revision INTEGER NOT NULL,
  preset_version TEXT NOT NULL,
  pipeline_checksum TEXT NOT NULL,
  evidence_epoch INTEGER NOT NULL DEFAULT 1,
  shadow_epoch INTEGER NOT NULL DEFAULT 0,
  live_shadow_first_at INTEGER,
  live_shadow_last_at INTEGER,
  live_shadow_success_count INTEGER NOT NULL DEFAULT 0,
  live_shadow_failure_count INTEGER NOT NULL DEFAULT 0,
  canary_epoch INTEGER NOT NULL DEFAULT 0,
  canary_target_count INTEGER NOT NULL DEFAULT 10,
  canary_max_outstanding INTEGER NOT NULL DEFAULT 3,
  canary_compare_deadline_ms INTEGER NOT NULL DEFAULT 900000,
  canary_started_count INTEGER NOT NULL DEFAULT 0,
  canary_completed_count INTEGER NOT NULL DEFAULT 0,
  canary_failure_count INTEGER NOT NULL DEFAULT 0,
  canary_started_at INTEGER,
  canary_observe_until INTEGER,
  active_transient_failure_count INTEGER NOT NULL DEFAULT 0,
  active_transient_window_started_at INTEGER,
  last_report_id TEXT,
  last_report_checksum TEXT,
  activated_at INTEGER,
  rolled_back_at INTEGER,
  last_reason_code TEXT NOT NULL DEFAULT 'bootstrap',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(current_mode IN ('legacy', 'shadow', 'active')),
  CHECK(rollout_phase IN ('stable', 'collecting', 'canary', 'rolled_back'))
);

CREATE TABLE IF NOT EXISTS cognition_promotion_history (
  event_id TEXT PRIMARY KEY,
  rollout_key TEXT NOT NULL,
  from_mode TEXT NOT NULL,
  to_mode TEXT NOT NULL,
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  from_revision INTEGER NOT NULL,
  to_revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  report_id TEXT,
  report_checksum TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS cognition_promotion_history_no_update
BEFORE UPDATE ON cognition_promotion_history
BEGIN
  SELECT RAISE(ABORT, 'promotion history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS cognition_promotion_history_no_delete
BEFORE DELETE ON cognition_promotion_history
BEGIN
  SELECT RAISE(ABORT, 'promotion history is append-only');
END;

CREATE TABLE IF NOT EXISTS cognition_evaluation_reports (
  report_id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL,
  rollout_key TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_checksum TEXT NOT NULL,
  artifact_state TEXT NOT NULL DEFAULT 'pending',
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  materialized_at INTEGER,
  last_artifact_error_code TEXT,
  CHECK(report_type IN ('replay', 'live_shadow', 'active_canary', 'active_failure', 'promotion')),
  CHECK(source_type IN ('comparison_run', 'active_subject', 'replay_batch', 'aggregate_gate', 'promotion_snapshot')),
  CHECK(artifact_state IN ('pending', 'materialized'))
);
```

`summary_json` 必须使用固定字段顺序和 UTF-8 canonical JSON；`artifact_checksum` 是这组精确
字节的 SHA-256。数据库行是自动判定和自动回退的权威证据，`artifact_path` 下的文件只是
同一组字节的可重建验收产物。事务内先以 `artifact_state='pending'` 写入；文件原子落盘且
回读 checksum 一致后才改为 `materialized`。磁盘故障不得阻止 critical finding 触发回退，
但人工晋级必须拒绝使用尚未 materialize 或 checksum 不一致的报告。

rollout key 固定为：

```text
DIRECT_REPLY
ROLE_PLAN_CHAT
ROLE_PLAN_MOMENT
ROLE_PLAN_CHAT_PRIVATE
ROLE_PLAN_MOMENT_PRIVATE
PROACTIVE_CHAT
PROACTIVE_MOMENT
MOMENT_INTERACTION
MOMENT_REPLY
LIFE_PLANNING
```

- [ ] **步骤 3：为 turn 增加 rollout pin**

给 `turns` 幂等增加：

```sql
rollout_key TEXT,
comparison_mode TEXT NOT NULL DEFAULT 'none',
rollout_revision INTEGER NOT NULL DEFAULT 0,
rollout_evidence_epoch INTEGER NOT NULL DEFAULT 0,
pipeline_checksum TEXT NOT NULL DEFAULT '',
shadow_epoch INTEGER,
canary_epoch INTEGER,
canary_slot INTEGER,
CHECK(comparison_mode IN ('none', 'cognition_compare', 'legacy_compare'))
```

旧 turn 的 `rollout_key` 根据 envelope kind 回填，`comparison_mode=none`，
`rollout_revision=0`。旧 pending turn 保持 Task 6 固定的 legacy 模式。

Store 接口：

```js
getCognitionRollout(rolloutKey)
listCognitionRollouts()
initializeCognitionRolloutsInternal({ rows, now })
createTurnWithRolloutInternal({
  envelope,
  presetVersion,
  annotationSnapshot,
  now
})
transitionCognitionRolloutInternal({
  rolloutKey,
  expectedRevision,
  toMode,
  toPhase,
  actor,
  reasonCode,
  reportId,
  reportChecksum,
  metadata,
  now
})
appendPromotionHistoryInternal(event)
putEvaluationReportInternal(report)
markEvaluationReportMaterialized({ reportId, expectedChecksum, now })
```

`createTurnWithRolloutInternal()` 必须在同一个 SQLite transaction 中重新读取 rollout，不接收
调用者传入的 mode：

```text
legacy/stable     -> pipeline_mode=legacy, comparison_mode=none
legacy/rolled_back -> pipeline_mode=legacy, comparison_mode=none
shadow/collecting|rolled_back
                  -> pipeline_mode=shadow, comparison_mode=cognition_compare
active/canary     -> pipeline_mode=active, comparison_mode=legacy_compare,
                     canary_slot=canary_started_count + 1
active/stable     -> pipeline_mode=active, comparison_mode=none
```

shadow turn 同时固定当前 `shadow_epoch`。每次进入新的 shadow 收集窗口（首次
`legacy -> shadow` 或 `active -> shadow` 回退）都把 `shadow_epoch` 加一，清零 live
shadow 计数和时间窗；每次进入新的 canary 时 `canary_epoch` 加一并把三个 canary count
清零，设置 `canary_started_at=now`、`canary_observe_until=now+48h`。分配 slot、增加
`canary_started_count` 和 rollout revision 必须与插入 turn 同一事务。shadow turn 虽然
没有 canary slot，只要 `comparison_mode=cognition_compare`，成为 outstanding 时也必须
推进 rollout revision；这样此前形成的 promotion report 会失效。唯一约束增加：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_rollout_canary_slot
ON turns(rollout_key, canary_epoch, canary_slot)
WHERE canary_slot IS NOT NULL;
```

`canary_target_count=10` 是晋级所需的最低成功完成数，不是 slot 分配上限。只要 phase 仍是
canary，每个新 active turn 都继续分配 legacy compare；因此被取消或删除的 source 不会让
canary 永久卡死，48 小时观察期内也不会出现未对照的 active turn。`remaining` 计算为
`max(0, target-completed)`，started 可以大于 10。

`PromotionController.createTurn()` 仅在当前状态为 `active/canary` 时，在同一个
`BEGIN IMMEDIATE` 事务调用 `countOutstandingComparisonSubjects()` 执行积压熔断。统计从
canary slot 分配时就开始：foreground 尚未产出权威结果的 turn 也算 outstanding，不能等
compare job 创建后才计数。若已有 3 个，或最老 subject 从创建起超过 15 分钟，则先写
`CANARY_COMPARE_BACKLOG` canonical report，把该 key 回退到新的
`shadow/rolled_back` 窗口，再把当前新 turn 固定为 shadow；不能先创建第 4 个未验证
active turn。Task 19 增加的 `createLifePlanningAttempt()` 必须对 LIFE_PLANNING 复用同一
canary 规则，把尚未产生权威 life result 的 attempt 也计入。legacy、shadow 和
active/stable 不执行这个 3 个/15 分钟熔断；shadow outstanding 只在晋级报告时用于阻止
过早晋级。阈值来自 rollout 行，不能由 Android 或请求参数放宽。

所有 pin、transition、计数和回退事务使用 `BEGIN IMMEDIATE`，先在事务内读取当前行，再以
`WHERE rollout_key=? AND revision=?` 更新；affected rows 不是 1 就回滚并抛 revision
conflict。SQLite busy 只按现有 Store 策略做有界退避，不能转用内存状态。即使误启动两个
PC runtime，job lease、唯一索引和 revision CAS 也必须保证只分配一次 slot、只计一次 run、
只发生一次状态转换。

- [ ] **步骤 4：先写旧 turn 与新 turn 的并发测试**

构造：

1. rollout revision 4、canary epoch 2 为 active/canary；
2. 创建 turn A，固定 revision 4、active + legacy_compare + slot 1；分配 slot 后 rollout
   revision 变成 5；
3. controller 以 expected revision 5 回退到 shadow revision 6；
4. 重启 Store/Dispatcher；
5. 恢复 turn A；
6. 创建 turn B。

断言：

- A 仍按创建时固定的 active、rollout revision 和 canary epoch 恢复；
- A 不重新分配 canary slot；
- B 固定 revision 6 shadow + cognition_compare（legacy 可见），登记 outstanding 后 rollout
  revision 变为 7；
- A 的失败/重试不会改用 revision 6/7；
- B 不能错误使用进程内旧缓存。

若重启后实际 registry 已没有 A 固定的 pipeline checksum：A 已有 cognition checkpoint 时
只在 schema/preset 仍兼容的前提下继续 expression；尚未开始 cognition 时进入既有安全
fallback，不得用新管线冒充旧 checksum，也不得把 A 重分类为 shadow。对应 compare job
写 `PINNED_PIPELINE_UNAVAILABLE + stale_for_rollout=true`，不计数、不回退新 epoch。

再分别构造同 canary epoch 三个尚未产出权威结果的 active turn、三条已排队 compare，以及
一个最老 subject 已超过 15 分钟。三种情况下创建下一 turn 都必须在同一事务先记录 backlog
report、回退该 key，再把新 turn 固定为 shadow；此前已经创建的 active turn 不改。并发
创建测试证明不能用“延迟提交结果/延迟创建 job”突破 3 个 outstanding。

- [ ] **步骤 5：实现 PromotionController**

```js
export class PromotionController {
  constructor({ store, clock, presetRegistry, bootstrap })

  initialize()
  getStatus(rolloutKey)
  listStatus()
  createTurn({ envelope, presetVersion, annotationSnapshot, now })
  refreshEvidenceManifest({ reasonCode, now })

  transition({
    rolloutKey,
    expectedRevision,
    toMode,
    toPhase,
    actor,
    reasonCode,
    reportId,
    reportChecksum,
    metadata = {}
  })

  startEvidenceEpoch({
    rolloutKey,
    expectedRevision,
    presetVersion,
    reasonCode
  })

  recordComparisonOutcome({
    jobId,
    workerId,
    run,
    report,
    criticalFindings,
    now
  })

  recordActivePipelineFailure({
    subjectType,
    subjectId,
    errorCode,
    failureClass,
    report,
    now
  })

  recordActivePipelineSuccess({ subjectType, subjectId, now })
}
```

`transition()` 校验：

- report 行存在、`artifact_state='materialized'`，且 DB canonical checksum、文件 checksum
  和命令传入 checksum 三者相同；
- `legacy -> shadow` 允许 bootstrap/manual；
- 只有 `DIRECT_REPLY` 可凭 fixture 30/30 + local_history 30/30 的初始 promotion report 从
  legacy 直接进入 active/canary；
- `shadow -> active/canary` 必须由 Task 14/15 的 promotion report 支持；
- `active/canary -> active/stable` 必须 canary completed>=10、没有未完成权威 subject 或
  compare job 且观察满 48 小时；
- 自动回退 active 只能到 shadow；shadow 连续资源故障可到 legacy；
- expected revision 不匹配抛 `RolloutRevisionConflictError`；
- 写当前行和 history 必须同一事务。

`startEvidenceEpoch()` 用于 cognition/expression/supervisor preset、正式批注、evaluator、
legacy baseline 或模型 profile
改变：`evidence_epoch` 加一并清零 live/canary 计数。当前为 active 或 shadow 时进入新的
`shadow/collecting` 窗口并递增 `shadow_epoch`；当前为 legacy 时仍保持 legacy/stable，
等待显式初始 shadow promotion。转换追加 history；旧 epoch 报告保留但不能支持新 epoch
晋级。控制器调用 PresetRegistry 重算 manifest；若文件在读取期间变化或 checksum 与实际
加载模块不一致，事务失败，不能写入半新半旧版本。

`initialize()` 在接受任何新 turn 前调用 `refreshEvidenceManifest()`：重算实际 manifest，
与十行 rollout 比较；checksum 相同不写库，任何不同时在一个 `BEGIN IMMEDIATE` 事务更新
全部受影响 key 的 evidence epoch/history。热更新 preset、批注或 model profile 也必须先
走此入口，成功后才交换进程内 registry 指针。若刷新失败，active/shadow 新 turn 暂停并走
现有 legacy/fallback，不能继续使用“文件已变、rollout 未变”的混合状态。

`recordComparisonOutcome()` 在同一事务写 shadow run、canonical evaluation report 行和计数；
critical finding 非空时同时回退该 rollout 并追加 history，不能出现“报告已发现严重错误但
进程崩溃前尚未回退”。事务提交后再 materialize 报告文件；失败时保留 pending 行并由报告
命令按 checksum 重建，不撤销已经完成的安全回退。

该方法不能拿 job 固定的旧 `rolloutRevision` 覆盖当前行。它在事务中重读当前 rollout，
按以下规则决定结果是否仍可改变当前状态：

- cognition shadow 结果仅在 `evidence_epoch/pipeline_checksum` 与当前行一致、当前仍为
  `shadow/collecting` 或 `shadow/rolled_back`，并且 `shadow_epoch` 相同时计数；
- active canary 结果还必须 `canary_epoch` 相同，且当前仍为 `active/canary`；
- 不满足时仍幂等保存 run/report，标记 `stale_for_rollout=true`，但不增加计数、不改
  revision、不晋级也不回退；
- 相同 run 重投只返回第一次结果，不能重复计数或重复追加 history。

`recordActivePipelineFailure()` 从 turn 或 `cognition_life_planning_attempts` 读取固定
snapshot，处理 active 权威管线在提交前确定失败的情况，包括候选 preset
或 pipeline checksum 不可用、cognition/expression 在允许的重试后最终失败、hard
validator/supervisor 在允许的 rewrite 后仍发现确定性越权。它只接受已经固定为 active 的
subject：canary subject 必须 evidence、pipeline checksum 和 canary epoch 都仍匹配当前
`active/canary`；stable subject 必须 evidence 和 pipeline checksum 匹配当前
`active/stable`，否则只记 stale 审计。

回退强度：

- active/canary 的任何最终管线失败立即回退；
- active/stable 的 preset/checksum 缺失或 deterministic pre-commit critical 立即回退；
- active/stable 的 provider timeout/rate-limit 等 transient failure 在滚动 15 分钟内连续
  3 次才回退；一次成功的 matching active turn 通过 `recordActivePipelineSuccess()` 清零；
- 触发时同事务写 `active_failure` report、递增新 `shadow_epoch` 并只回退本 key。

PC 尚未创建 turn/planning attempt 就整体不可达、纯 LAN/CLOUD 中断或 Android 自主
fallback 不属于模型失败，不能误触发 rollout 回退。

- [ ] **步骤 6：把配置降为一次性 bootstrap**

替换 Task 7 中运行时权威配置为：

```json
{
  "cognitionRuntime": {
    "presetVersion": "2.0.0",
    "softDeadlineMs": 60000,
    "hardDeadlineMs": 300000,
    "rolloutBootstrap": {
      "schemaVersion": 1,
      "defaultMode": "legacy",
      "defaultPhase": "stable"
    }
  }
}
```

删除运行时根据 `activeKinds`/`shadowKinds` 直接选模式的代码。配置仍可用于首次建表，但不能
在表存在后自动晋级或回退。

- [ ] **步骤 7：接入 turn 创建与恢复**

`TurnDispatcher` 创建 turn 必须走 `PromotionController.createTurn()`，后者在事务内调用
`createTurnWithRolloutInternal()`；不得直接调用 Store internal。恢复已有 turn 只读：

```text
pipelineMode
comparisonMode
rolloutRevision
rolloutEvidenceEpoch
pipelineChecksum
shadowEpoch
canaryEpoch
canarySlot
presetVersion
annotationSnapshot
```

Orchestrator 禁止在处理中再次调用 `PromotionController.getStatus()`。

增加源码契约测试：`UPDATE cognition_kind_rollouts` 只能出现在 Store 的
`transitionCognitionRolloutInternal`、turn/planning pin 和 outcome 事务实现中；CLI、
Dispatcher、Orchestrator、Android bridge 与配置加载器都不得直接写该表。

- [ ] **步骤 8：验证并提交**

```powershell
node --test yuqi-runtime/test/promotion-controller.test.mjs
node --test yuqi-runtime/test/store-cognition-migration.test.mjs
node --test yuqi-runtime/test/turn-dispatcher.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
node --test tests/yuqi-rollout-authority-contract.test.mjs
git add yuqi-runtime/src/promotion-controller.mjs yuqi-runtime/test/promotion-controller.test.mjs tests/yuqi-rollout-authority-contract.test.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/src/turn-dispatcher.mjs yuqi-runtime/test/turn-dispatcher.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/config.example.json
git commit -m "feat: control Yuqi rollout state transactionally"
```

---

## Task 14：建立 270 例离线回放、本机历史回放和正式报告

**文件：**

- 新建：`tests/fixtures/yuqi-cognition-replay-v1/manifest.json`
- 新建：`tests/fixtures/yuqi-cognition-replay-v1/cases.jsonl`
- 新建：`yuqi-runtime/src/replay-runner.mjs`
- 新建：`yuqi-runtime/test/replay-runner.test.mjs`
- 新建：`scripts/run-yuqi-cognition-replay.mjs`
- 新建：`scripts/report-yuqi-cognition-replay.mjs`
- 新建：`tests/yuqi-cognition-replay-contract.test.mjs`
- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/test/store-cognition-migration.test.mjs`
- 修改：`package.json`
- 修改：`.gitignore`

**接口：**

- 消费：Task 7 的 legacy/cognition pipeline、Task 13 的 report 表。
- 产出：严格独立于 live shadow 的 replay run、270 例报告和 DIRECT_REPLY 本机历史报告。

- [ ] **步骤 1：先写 dataset 完整性失败测试**

fixture manifest：

```json
{
  "schemaVersion": 1,
  "datasetId": "yuqi-cognition-replay-v1",
  "caseCount": 270,
  "requiredPerTurnKind": 30,
  "turnKinds": [
    "DIRECT_REPLY",
    "ROLE_PLAN_CHAT",
    "ROLE_PLAN_MOMENT",
    "ROLE_PLAN_CHAT_PRIVATE",
    "ROLE_PLAN_MOMENT_PRIVATE",
    "PROACTIVE_CHAT",
    "PROACTIVE_MOMENT",
    "MOMENT_INTERACTION",
    "MOMENT_REPLY"
  ]
}
```

每个 JSONL case 必须包含：

```json
{
  "caseId": "",
  "turnKind": "DIRECT_REPLY",
  "sourceType": "approved_fixture",
  "sourceRef": "",
  "clock": 0,
  "envelope": {},
  "seedState": {},
  "expected": {
    "mustNoticeMessageIds": [],
    "allowedActions": [],
    "forbiddenActions": [],
    "stageConstraints": {},
    "publicPrivateConstraints": []
  }
}
```

测试断言恰好九种、每种恰好 30 例、caseId 唯一、无真实用户姓名/密钥/base64、所有
message/action target 可解析、fixture checksum 与 manifest 一致。

- [ ] **步骤 2：定义案例来源配额**

每种 30 例必须同时覆盖：

```text
12 个正常路径
6 个边界/歧义路径
4 个重试/恢复/重复投递路径
4 个结构化动作越权反例
2 个阶段组合
2 个上下文容量或附件路径
```

DIRECT_REPLY 的附件路径覆盖多气泡、quote、image、voice、payment。朋友圈覆盖 public/private
泄漏反例。role-plan 覆盖 occurrence、暂停/恢复和重复完成。来源只能是已批准测试、
第一/二轮批注的脱敏结构或人工构造协议反例；第四轮 provisional 潜台词不能作为标准答案。

- [ ] **步骤 3：增加 replay 持久表**

```sql
CREATE TABLE IF NOT EXISTS cognition_replay_batches (
  run_id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL,
  dataset_checksum TEXT NOT NULL,
  preset_version TEXT NOT NULL,
  model_profile_checksum TEXT NOT NULL,
  source_type TEXT NOT NULL,
  state TEXT NOT NULL,
  requested_concurrency INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  artifact_path TEXT,
  artifact_checksum TEXT,
  CHECK(source_type IN ('fixture', 'local_history'))
);

CREATE TABLE IF NOT EXISTS cognition_replay_runs (
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  rollout_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  input_checksum TEXT NOT NULL,
  legacy_result_checksum TEXT,
  cognition_result_checksum TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  critical_findings_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  error_code TEXT,
  source_deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, case_id),
  CHECK(source_type IN ('approved_fixture', 'annotation_derived', 'synthetic', 'local_history'))
);
```

不得向这两张表写原始正文、图片或 prompt，只保存 ID、checksum、指标和 finding。

- [ ] **步骤 4：先写 dry-run 无副作用测试**

`ReplayRunner`：

```js
export class ReplayRunner {
  constructor({
    store,
    legacyPipeline,
    cognitivePipeline,
    sandboxFactory,
    clock,
    concurrency = 2
  })

  async runFixtureBatch({ runId, datasetPath, presetVersion })
  async runLocalHistoryBatch({
    runId,
    rolloutKey = 'DIRECT_REPLY',
    limit = 30,
    beforeTurnId = null
  })
  async resume(runId)
}
```

`sandboxFactory` 为每个 case 创建临时 SQLite 和：

```js
{
  actionSink: DryRunActionSink,
  notificationSink: DryRunNotificationSink,
  cloudSink: DryRunCloudSink,
  clock: FixedClock
}
```

测试在生产 Store 预置聊天、支付、朋友圈、安排、stage 和 life checksum，运行 replay 后逐项
核对 checksum 完全未变；只允许 replay 表新增记录和 `artifacts/qa/cognition/replay/`
新增报告。

- [ ] **步骤 5：实现 fixture 和本机历史回放**

每个 case 对同一固定输入执行：

```text
legacy dry-run
-> cognition-v2 dry-run
-> deterministic evaluator
-> persist checksums/metrics/findings
```

本机历史回放：

- 只选 canonical、已提交的真实 turn；
- 不把正文复制到 fixture 或 report；
- `source_type=local_history`；
- 默认只运行 DIRECT_REPLY 最近 30 个合格 turn；
- 数量不足时报告实际数量并失败，不使用 synthetic 补齐；
- 绝不计入 `cognition_shadow_runs` 或 live count。

runner 并发固定上限 2，支持按 `(dataset checksum, preset version, model profile checksum)`
断点续跑。任一 checksum 改变必须开启新 runId，不能复用旧结果。

- [ ] **步骤 6：生成正式脱敏报告**

命令：

```json
"cognition:replay": "node scripts/run-yuqi-cognition-replay.mjs",
"cognition:replay-report": "node scripts/report-yuqi-cognition-replay.mjs"
```

使用：

```powershell
npm.cmd run cognition:replay -- --dataset tests/fixtures/yuqi-cognition-replay-v1 --run-id prerelease-1.0.106 --concurrency 2
npm.cmd run cognition:replay-report -- --run-id prerelease-1.0.106
npm.cmd run cognition:replay -- --source local-history --kind DIRECT_REPLY --limit 30 --run-id direct-history-1.0.106
npm.cmd run cognition:replay-report -- --run-id direct-history-1.0.106
```

报告路径：

```text
artifacts/qa/cognition/replay/<run-id>/summary.json
artifacts/qa/cognition/replay/<run-id>/summary.md
artifacts/qa/cognition/replay/<run-id>/case-results.jsonl
```

报告写入 `cognition_evaluation_reports`，artifact SHA-256 与 DB 一致。`.gitignore` 忽略整个
运行报告目录；正式验收记录可复制脱敏 summary，不提交 case 私密内容。

- [ ] **步骤 7：固定离线闸门**

fixture report 只有同时满足才 `eligible=true`：

- 九种 TurnKind 各 30/30 completed；
- critical finding 总数为 0；
- schema 最终失败为 0；
- 生产数据 checksum 变化为 0；
- dataset/preset/model checksum 完整。

DIRECT_REPLY 首版 canary 另要求 `local_history` report：

- completed 恰好 30；
- critical finding 为 0；
- 不计入 live shadow。

全量 replay 预计需要至少 540 次模型管线执行。以并发 2 规划 4–12 小时，允许隔夜续跑，
但不得因时长减少案例或把失败 case 换成容易样本。

- [ ] **步骤 8：验证并提交**

```powershell
node --test tests/yuqi-cognition-replay-contract.test.mjs
node --test yuqi-runtime/test/replay-runner.test.mjs
node --test yuqi-runtime/test/store-cognition-migration.test.mjs
git add tests/fixtures/yuqi-cognition-replay-v1/manifest.json tests/fixtures/yuqi-cognition-replay-v1/cases.jsonl yuqi-runtime/src/replay-runner.mjs yuqi-runtime/test/replay-runner.test.mjs scripts/run-yuqi-cognition-replay.mjs scripts/report-yuqi-cognition-replay.mjs tests/yuqi-cognition-replay-contract.test.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/store-cognition-migration.test.mjs package.json .gitignore
git commit -m "test: replay all Yuqi turn kinds without side effects"
```

---

## Task 15：实现真实 shadow、反向 active canary 和自动按类回退

**文件：**

- 新建：`yuqi-runtime/src/comparison-evaluator.mjs`
- 新建：`yuqi-runtime/test/comparison-evaluator.test.mjs`
- 修改：`yuqi-runtime/src/shadow-dispatcher.mjs`
- 修改：`yuqi-runtime/test/shadow-dispatcher.test.mjs`
- 修改：`yuqi-runtime/src/promotion-controller.mjs`
- 修改：`yuqi-runtime/test/promotion-controller.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/src/main.mjs`

**接口：**

- 消费：turn/life subject 固定的 `comparisonMode`、权威结果 checksum 和 Task 13 rollout
  revision。
- 产出：两种 compare job、critical evaluator、原子计数和自动回退。

- [ ] **步骤 1：先写两种相反方向的失败测试**

表驱动测试：

| turn 固定状态 | 可见结果 | 后台 job | 后台绝不提交 |
|---|---|---|---|
| shadow + cognition_compare | legacy | shadow_cognition | cognition 动作 |
| active + legacy_compare | cognition | active_canary_compare | legacy 动作 |
| active + none | cognition | 无 | 无 |
| legacy + none | legacy | 无 | 无 |

每例断言后台 job 不增加消息、支付动作、朋友圈、role plan、stage、life、通知或未读。
active canary 在可见提交前仍必须通过全部现有 hard validator 和必要 supervisor。后台
legacy compare 不能撤回已送达内容，自动回退只保护后续新 turn，不能被实现成事后删除或
重写用户已经看到的消息。

- [ ] **步骤 2：只在权威结果提交事务中创建 compare job**

turn 的权威结果是已经通过确定性校验并准备提交的可见 draft/action；Task 19 的 life
planning 权威结果是准备写入 `life_episodes` 的规范化 plan。两者都只能在权威结果形成
canonical checksum 后，和该结果提交同一事务创建 compare job。attempt/turn 创建阶段绝不
预建 compare job。payload 固定：

```json
{
  "subjectType": "turn",
  "subjectId": "",
  "turnId": "",
  "rolloutKey": "",
  "rolloutRevision": 0,
  "rolloutEvidenceEpoch": 0,
  "shadowEpoch": null,
  "canaryEpoch": null,
  "canarySlot": null,
  "comparisonDirection": "legacy_authoritative_cognition_compare",
  "authoritativePipeline": "legacy",
  "comparisonPipeline": "cognition",
  "authoritativeResultChecksum": "",
  "pipelineMode": "shadow",
  "comparisonMode": "cognition_compare",
  "presetVersion": "",
  "pipelineChecksum": "",
  "annotationSnapshotChecksum": "",
  "inputChecksum": ""
}
```

turn 的 `inputChecksum` 是完整固定 envelope/context 的 canonical checksum；life planning
则是 attempt `input_snapshot_json` 的 checksum。worker 必须先从权威 Store 重新加载并
校验，payload 本身不携带可被篡改的原始输入。

`comparisonDirection` 只允许：

```text
legacy_authoritative_cognition_compare
cognition_authoritative_legacy_compare
```

turn/life result commit、compare job 和相应状态更新必须在一个事务。重复 commit 在
authoritative checksum 相同时幂等返回；需要 compare 的 subject 还必须核对原 job
存在且 ID 相同，不需要 compare 的 subject 则必须继续保持无 job。checksum 不同一律抛
conflict，永远不得创建第二个相同 job。

- [ ] **步骤 3：让 ShadowDispatcher 同时处理两类 compare**

`ShadowDispatcher` claim：

```text
shadow_cognition
active_canary_compare
```

自动监测和回退只由 PC runtime `main.mjs` 启动的单实例 ShadowDispatcher 执行；Android、
Cloud Worker 和 UI 都没有 rollout 写权限。main 重启后先恢复过期 lease，再启动新 poll。
claim life-planning compare 时，job 从 queued/retry_wait 变为 running 与 attempt 的
`comparison_state=running` 必须处于同一 Store 事务；lease 过期恢复时两者一起回到 queued。

优先级始终低于任何可见 turn。处理步骤：

```text
load pinned subject/input/version
-> verify pinned pipeline bundle/checksum is actually loadable
-> load committed authoritative result and verify checksum
-> build isolated dry-run sandbox
-> run non-authoritative pipeline
-> normalize result
-> evaluate against authoritative result and fixture-independent invariants
-> write outcome through PromotionController.recordComparisonOutcome()
```

服务重启后恢复 job；它不得根据 rollout 当前 revision 改写 job 方向。若固定 checksum 已
不可加载，禁止用当前模块继续；直接通过 `recordComparisonOutcome()` 写
stale/unavailable 审计并完成 job。

`active_canary_compare` 失败按 1 分钟、5 分钟、30 分钟重试；第四次仍失败时记录
`CANARY_COMPARE_UNAVAILABLE` 并自动回退该 key。`shadow_cognition` 沿用 Task 7 的
5 分钟、30 分钟退避，单个最终失败不影响权威结果。life-planning 每次 retry 时，job 的
retry_wait 与 attempt 的 `comparison_state=queued` 同事务；最终失败则 attempt 标为
`comparison_state=failed`。

- [ ] **步骤 4：实现 deterministic ComparisonEvaluator**

```js
export function evaluatePipelineComparison({
  subjectType,
  subject,
  authoritativeResult,
  comparisonResult,
  currentBatch,
  scene,
  allowedActionTargets
})
```

返回：

```js
{
  metrics: {
    messageCoverage: 1,
    actionAgreement: true,
    stageAgreement: true,
    schemaValid: true
  },
  criticalFindings: [],
  warnings: []
}
```

critical code 固定：

```text
CURRENT_BATCH_OMISSION
ACTION_TARGET_ESCALATION
DIRECT_REPLY_SKIP
PAYMENT_OBJECT_MUTATION
ILLEGAL_STAGE_TRANSITION
PRIVATE_TO_PUBLIC_LEAK
DUPLICATE_VISIBLE_EFFECT
ACTIVE_FAILED_LEGACY_SUCCEEDED
ACTIVE_PIPELINE_UNAVAILABLE
ACTIVE_PRECOMMIT_CRITICAL
CANARY_COMPARE_UNAVAILABLE
CANARY_COMPARE_BACKLOG
PINNED_PIPELINE_UNAVAILABLE
```

自由文本风格差异只能 warning，不得自动回退；权限、目标、证据和重复副作用才是
deterministic critical。

可见 active 管线若在结果提交前最终失败，Orchestrator 必须调用
`recordActivePipelineFailure()`，而不是等待一个不会产生的 reverse compare job。该事务
先完成该 turn 的既有失败/fallback checkpoint，再按 canary/stable 与 failure class 更新
健康窗口；达到上述条件时才写 critical report 并回退对应 key。成功提交 matching
active/stable turn 时，在同一可见提交事务调用 `recordActivePipelineSuccess()`；只有计数
非零时才清零并增加 revision。turn checkpoint 与健康状态恢复时都必须幂等。若 PC 根本未
接到请求或只发生传输故障，则不调用这些入口。

- [ ] **步骤 5：原子记录和自动回退**

`recordComparisonOutcome()` 单事务：

1. 校验 job 仍由 `workerId` 持有、payload checksum 与固定 subject 一致；
2. 写 `cognition_shadow_runs(source='live')`；
3. 把单次 evaluator 结论序列化为 canonical JSON，写
   `cognition_evaluation_reports(artifact_state='pending')`；
4. 重读当前 rollout，校验 job 固定的 evidence epoch、pipeline checksum、comparison
   direction、shadow epoch 和 canary epoch 是否仍属于当前收集窗口；
5. 若已经 stale，只保存带 `stale_for_rollout=true` 的 run/report，不改变 rollout；
6. 若仍有效，按方向增加 live shadow 或 canary 完成/失败计数；
7. 若 critical 非空：
   - active/canary：回退该 key 到 `shadow + rolled_back`；
   - shadow：保持 legacy 可见；只记录失败；
8. 若 subject 是 life planning，evaluator 已产出结论（即使含 critical）则把 attempt
   `comparison_state` 更新为 completed；只有 compare 基础设施最终不可用才为 failed；
9. 按相同语义把 compare job 更新为 completed/failed 并清空 lease；
10. 发生状态转换时追加 promotion history，并引用刚写入的 report id/checksum；
11. 有效计数或状态发生变化时 revision 加一；
12. commit。

事务提交后才把 canonical JSON 原子写到固定 `artifact_path`，回读 checksum 相同后将
`artifact_state` 改为 `materialized`。若写盘失败，回退仍然有效；Task 22 的报告命令扫描
pending 行并从 `summary_json` 重建同 checksum 文件。晋级命令只接受 materialized 报告，
自动回退则直接接受事务内 canonical 报告，绝不等待文件系统。

shadow cognition 在滚动 24 小时内连续 3 个基础设施失败时，自动转
`legacy + rolled_back`，reason=`SHADOW_RESOURCE_INSTABILITY`。内容差异不能触发此规则。

- [ ] **步骤 6：固定晋级计数和时间窗**

非 DIRECT_REPLY 的 `shadow -> active/canary`：

```text
live_shadow_success_count >= 30
live_shadow_first_at 距当前 >= 72 小时
critical count = 0
schema success rate >= 98%
promotion report checksum valid
当前 evidence/shadow epoch 不存在未完成权威 subject 或 pending/retry/running compare
```

DIRECT_REPLY 首次可使用 Task 14 的：

```text
fixture replay 30/30
local_history replay 30/30
critical count = 0
```

但历史 replay 仍不增加 `live_shadow_success_count`。

`active/canary -> active/stable`：

```text
canary_started_count >= 10
canary_completed_count >= 10
canary_failure_count = 0
首次 canary 距当前 >= 48 小时
active canary report checksum valid
当前 canary epoch 不存在未完成权威 subject 或 pending/retry/running compare
```

- [ ] **步骤 7：验证重启、并发与旧 turn**

测试在 compare 模型调用完成、事务写入前模拟进程退出；job lease 到期后重跑，只产生一个
run、一次计数，并且 job/attempt 不会出现一个 completed、另一个仍 running。再在自动回退
后恢复旧 active turn，断言旧 turn 仍 active，新 turn 已固定 shadow + cognition compare
（legacy visible）。

另测三个晚到结果：旧 evidence epoch 的 cognition shadow、同 evidence 但旧 shadow epoch
的 cognition shadow、旧 canary epoch 的 legacy compare。三者都必须写入带 stale 标记的
审计记录，但当前 rollout revision、计数和模式完全不变。

最后分别模拟 active/canary 与 active/stable 的 pre-commit 管线失败，断言都会只回退本
kind。stable transient failure 测试还必须证明“一次失败、一次成功、再两次失败”不回退，
而 15 分钟内连续三次才回退；纯网络断开和 PC 未创建 turn 的 Android fallback 不改变
任何 rollout。

- [ ] **步骤 8：验证并提交**

```powershell
node --test yuqi-runtime/test/comparison-evaluator.test.mjs
node --test yuqi-runtime/test/shadow-dispatcher.test.mjs
node --test yuqi-runtime/test/promotion-controller.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
git add yuqi-runtime/src/comparison-evaluator.mjs yuqi-runtime/test/comparison-evaluator.test.mjs yuqi-runtime/src/shadow-dispatcher.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/src/promotion-controller.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/src/store.mjs yuqi-runtime/src/main.mjs
git commit -m "feat: compare and roll back Yuqi pipelines by turn kind"
```

---

## Task 16：使朋友圈互动与朋友圈回复具备 active 能力

**文件：**

- 修改：`yuqi-runtime/src/cognitive-pipeline.mjs`
- 修改：`yuqi-runtime/test/cognitive-pipeline.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`tests/yuqi-ui-contract.test.mjs`

- [ ] **步骤 1：先写两个 TurnKind 的表驱动测试**

覆盖：

- `MOMENT_INTERACTION` 点赞；
- 对目标朋友圈评论；
- `MOMENT_REPLY` 回复指定评论；
- cognition 决定不动作；
- trigger 指向不存在目标；
- expression 试图改成另一评论；
- 私聊秘密试图进入公共文字；
- 同一 trigger 重复投递；
- 评论已删除；
- public thread context 与 private chat context 同时存在。

- [ ] **步骤 2：固定动作所有权**

cognition 只能在 trigger 的 allowed target 中选择：

```text
none
like(momentId)
comment(momentId, textRequired)
reply(momentId, commentId, textRequired)
```

expression 只在 `textRequired` 时生成正文，不能改变 action 或 target。

- [ ] **步骤 3：公共/私聊上下文隔离**

表达 prompt 可知道“哪些私聊信息不能公开”，但不能收到无需使用的完整私聊原文。程序先
把明确 private facts 加入 forbidden set；监督检查泄漏。失败时重写，不擅自删改动作目标。

- [ ] **步骤 4：验证 active 能力但不在本任务晋级**

本任务只证明以下 rollout key 在 pipelineMode 被测试固定为 active 时可以正确执行：

```text
MOMENT_INTERACTION
MOMENT_REPLY
```

不得修改配置或 rollout 当前模式。真实晋级只能由 Task 13 的 `PromotionController` 在
Task 15 的 live shadow 闸门满足后执行。

```powershell
node --test yuqi-runtime/test/cognitive-pipeline.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
node --test tests/yuqi-ui-contract.test.mjs
git add yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs tests/yuqi-ui-contract.test.mjs
git commit -m "feat: support cognition for moment interactions"
```

---

## Task 17：使主动私聊和主动朋友圈具备 active 能力

**文件：**

- 修改：`yuqi-runtime/src/interaction-state.mjs`
- 修改：`yuqi-runtime/test/interaction-state.test.mjs`
- 修改：`yuqi-runtime/src/interaction-contract.mjs`
- 修改：`yuqi-runtime/test/interaction-contract.test.mjs`
- 修改：`yuqi-runtime/src/cognitive-pipeline.mjs`
- 修改：`yuqi-runtime/test/cognitive-pipeline.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`test-sw-automatic-task-guard.mjs`

- [ ] **步骤 1：先写主动私聊测试**

输入必须含：

- 最近主动消息是否仍未获用户回应；
- 当前主动 skip 计数；
- explicit boundary；
- open threads；
- current life episode；
- 触发来源（骰子、计划、手动、恢复）；
- 真实当前时间。

测试：

- 等待用户时结构性沉默；
- 明确边界下沉默；
- 有自己生活进展时自然联系；
- 用户发言不重置“每四次主动私聊最多一次普通 skip”的计数；
- trigger 不进入用户事实；
- 合法 skip 更新状态但不生成空消息或通知；
- 同一 proactive job 重试不重复发送。

- [ ] **步骤 2：先写主动朋友圈测试**

测试：

- life event 支持公开发布；
- 无真实触发时 skip；
- 私聊秘密、支付详情、阶段后台字段不得公开；
- 表达使用朋友圈正文格式而不是私聊气泡；
- 原调度、去重、通知策略不变；
- 相同 job 恢复不重复发朋友圈。

- [ ] **步骤 3：保持调度器只决定唤醒**

骰子、时间表、云端 wake、service worker 和 Android alarm 只能创建/唤醒 turn，不能预写
正文或替 cognition 决定必须联系。

- [ ] **步骤 4：验证 active 能力但保持 rollout 不变**

测试用固定 active turn 覆盖可见路径；生产 rollout 的
`PROACTIVE_CHAT/PROACTIVE_MOMENT` 不在本任务中晋级。提交前读取 rollout 状态，证明没有
因运行测试或启动 runtime 改变 revision。

```powershell
node --test yuqi-runtime/test/interaction-state.test.mjs
node --test yuqi-runtime/test/interaction-contract.test.mjs
node --test yuqi-runtime/test/cognitive-pipeline.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
node test-sw-automatic-task-guard.mjs
git add yuqi-runtime/src/interaction-state.mjs yuqi-runtime/test/interaction-state.test.mjs yuqi-runtime/src/interaction-contract.mjs yuqi-runtime/test/interaction-contract.test.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs test-sw-automatic-task-guard.mjs
git commit -m "feat: support cognition for proactive Yuqi turns"
```

---

## Task 18：使四类安排回合具备 active 能力，保留安排表和角色日程

**文件：**

- 修改：`yuqi-runtime/src/cognitive-pipeline.mjs`
- 修改：`yuqi-runtime/test/cognitive-pipeline.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 修改：`tavern-app/lib/role-plan-domain.js`
- 修改：`tests/role-plan-domain.test.mjs`
- 修改：`tavern-app/lib/role-plan-repository.js`
- 修改：`tests/role-plan-repository.test.mjs`
- 修改：`tests/yuqi-ui-contract.test.mjs`
- 修改：`android/app/src/test/java/com/siyi/al/execution/RolePlanRecoveryPolicyTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/RolePlanScheduleTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/AutomaticTaskRecoveryPolicyTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/bridge/BridgeRolePlanResultTest.java`
- 修改：`android/app/src/androidTest/java/com/siyi/al/execution/YuqiAutomaticTriggerTest.java`
- 修改：`android/app/src/androidTest/java/com/siyi/al/execution/YuqiProcessRecoveryTest.java`

- [ ] **步骤 1：先为四类 TurnKind 写表驱动测试**

```text
ROLE_PLAN_CHAT
ROLE_PLAN_MOMENT
ROLE_PLAN_CHAT_PRIVATE
ROLE_PLAN_MOMENT_PRIVATE
```

每例提供精确：

- planId、occurrenceId、plan type；
- 原定时间、当前时间、时区；
- 当前状态和执行历史；
- role schedule context；
- 是否恢复/重试；
- public/private channel。

断言成功、skip、重试、永久失败、完成各状态均与旧实现一致。

- [ ] **步骤 2：固定 cognition 与 expression 权限**

cognition 可以决定：

- 本 occurrence 是否仍适合执行；
- 合法结构化 plan operations；
- 当前关系动作；
- 是否需要可见文字。

expression 不可：

- 创建或修改 operation；
- 提到任务、计时器、安排表、occurrence；
- 把 private plan 发到 public moment；
- 把 moment plan 写成私聊。

- [ ] **步骤 3：保持对话内安排操作**

继续支持三种 plan domain：

```text
private_message
moment_post
role_schedule
```

创建、编辑、暂停、恢复、取消、立即执行、完成和永久删除仍经过
`role-plan-domain.js` 校验和 repository 原子写入。cognition 输出与可见承诺冲突时不提交，
进入 supervisor/rewrite。

- [ ] **步骤 4：Android 恢复测试**

运行并补齐现有测试，至少覆盖：

```text
RolePlanCoordinator
RolePlanRecoveryPolicy
RolePlanAlarmScheduler
AutomaticTaskCoordinator
AutomaticTaskRecoveryPolicy
AlPlanAlarmReceiver
```

上述没有独立 JVM test 的组件通过 `YuqiAutomaticTriggerTest` 和
`YuqiProcessRecoveryTest` 的真实 Room/receiver 流程覆盖。不得因 prompt 角色更名改变
Room occurrence 状态机或闹钟身份键。

- [ ] **步骤 5：验证 active 能力但保持四个 rollout 不变**

四类安排测试使用固定 active turn，不修改生产 rollout。安排出现频率低，不能用 fixture
replay 代替 Task 15 要求的 30 次 live shadow。

```powershell
node --test yuqi-runtime/test/cognitive-pipeline.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
node --test tests/role-plan-domain.test.mjs
node --test tests/role-plan-repository.test.mjs
node --test tests/yuqi-ui-contract.test.mjs
Set-Location android
.\gradlew.bat testDebugUnitTest --no-daemon --max-workers=1 --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --max-workers=1 --no-problems-report
Set-Location ..
```

只暂存本任务文件清单中产生差异的文件，使用 `git diff --cached --name-only` 核对后：

```powershell
git commit -m "feat: support cognition for Yuqi role plans"
```

---

## Task 19：让独立生活规划使用同一认知核心而不污染实时聊天

**文件：**

- 新建：`tests/fixtures/yuqi-life-planning-replay-v1/manifest.json`
- 新建：`tests/fixtures/yuqi-life-planning-replay-v1/cases.jsonl`
- 新建：`yuqi-runtime/test/life-planning-attempt.test.mjs`
- 修改：`yuqi-runtime/src/life-simulation.mjs`
- 修改：`yuqi-runtime/test/life-simulation.test.mjs`
- 修改：`yuqi-runtime/src/cognitive-pipeline.mjs`
- 修改：`yuqi-runtime/test/cognitive-pipeline.test.mjs`
- 修改：`yuqi-runtime/src/orchestrator.mjs`
- 修改：`yuqi-runtime/test/orchestrator.test.mjs`
- 新建：`yuqi-runtime/src/life-planning-dispatcher.mjs`
- 新建：`yuqi-runtime/test/life-planning-dispatcher.test.mjs`
- 修改：`yuqi-runtime/src/main.mjs`
- 修改：`tests/yuqi-deployment-contract.test.mjs`
- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/test/store-cognition-migration.test.mjs`
- 修改：`yuqi-runtime/src/promotion-controller.mjs`
- 修改：`yuqi-runtime/test/promotion-controller.test.mjs`
- 修改：`yuqi-runtime/src/shadow-dispatcher.mjs`
- 修改：`yuqi-runtime/test/shadow-dispatcher.test.mjs`
- 修改：`yuqi-runtime/src/comparison-evaluator.mjs`
- 修改：`yuqi-runtime/test/comparison-evaluator.test.mjs`

**接口：**

- 消费：Task 13 的固定 rollout/epoch/canary slot，Task 15 的 authoritative compare job。
- 产出：两阶段 `LIFE_PLANNING` attempt、原子 life result commit、可恢复的权威执行与
  compare 状态。

- [ ] **步骤 1：先写两阶段 attempt 失败测试**

`yuqi-runtime/test/life-planning-attempt.test.mjs` 必须先固定以下状态矩阵：

| 固定模式 | 权威管线 | 创建 attempt 时 | 权威结果提交事务 | 最终状态 |
|---|---|---|---|---|
| legacy/stable | legacy | 不建 compare | 提交 life result，不建 compare | completed/not_applicable |
| shadow/collecting 或 rolled_back | legacy | 不建 compare | 提交 result + 建 shadow_cognition | result_committed/queued |
| active/canary | cognition | 不建 compare | 提交 result + 建 active_canary_compare | result_committed/queued |
| active/stable | cognition | 不建 compare | 提交 life result，不建 compare | completed/not_applicable |

失败测试逐项证明：

- `createLifePlanningAttempt()` 只固定 input、mode、revision、checksum、epoch 和 canary slot，
  `consolidation_jobs` 行数仍为 0；
- created/running/retry_wait attempt 都计入 canary outstanding，不能通过尚未创建 job 绕过
  3 个/15 分钟熔断；
- 权威管线失败时 life episodes 不变、compare job 不存在、canary compare 数不增加；
- 权威管线失败时，compare 必要的 attempt 收束为 `failed/cancelled`，comparison mode 为
  none 的 attempt 收束为 `failed/not_applicable`，不能破坏状态不变量；
- 同一 request 并发创建只得到一个 planning ID/revision/canary slot；
- 权威结果 commit 崩溃时不能出现“episodes 已写但 attempt 无 checksum”或“job 已建但
  authoritative result 不存在”；
- `result_committed` 后同 checksum 重提幂等，不同 checksum 抛
  `LifePlanningResultConflictError`；
- compare worker 不能 claim `comparison_state=not_ready` 的 attempt；
- 服务重启只恢复固定 attempt/input，不重新读取 rollout 或重新分配 slot；
- 同一角色已有未完成 attempt 时，即使当前 rollout 或时钟已经变化也先恢复旧 attempt，
  不并发创建第二份 life plan；
- runtime 启动会恢复过期 life lease 并领取 due attempt；只有表没有 dispatcher 的实现
  不算通过；
- 部署契约测试固定 `main.mjs` 的 dispatcher import/构造、recover-before-start 以及
  stop-before-store-close 顺序；
- life provider 故意挂起时，实时 turn 仍在自身 deadline 内继续，且只留下一个可恢复
  attempt；Orchestrator 没有第二次 life 模型调用；
- 两个 dispatcher 实例竞争、重复 poke 和重启恢复都只能 claim 同一个 attempt 一次；
- provider 运行期间若 life episode/adjustment 改变，旧结果以 `LIFE_BASIS_STALE` 原子取消，
  不写 episode、不建 job、不触发 active rollback，下一次 poll 使用新 basis；
- active attempt 最终失败只回退 `LIFE_PLANNING`，其他九个 key 不变；
- compare outcome、job terminal state、attempt state、rollout count/rollback 同一事务。

- [ ] **步骤 2：增加可恢复 attempt schema**

不用一个含糊的状态同时表示前台执行和后台 compare；使用两个正交状态：

```sql
CREATE TABLE IF NOT EXISTS cognition_life_planning_attempts (
  planning_id TEXT PRIMARY KEY,
  request_base_key TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  role_id TEXT NOT NULL,
  planning_revision INTEGER NOT NULL,
  planning_window_start_at INTEGER NOT NULL,
  planning_window_end_at INTEGER NOT NULL,
  life_basis_checksum TEXT NOT NULL,
  context_checksum TEXT NOT NULL,
  rollout_key TEXT NOT NULL DEFAULT 'LIFE_PLANNING',
  pipeline_mode TEXT NOT NULL,
  comparison_mode TEXT NOT NULL,
  authoritative_pipeline TEXT NOT NULL,
  comparison_direction TEXT,
  rollout_revision INTEGER NOT NULL,
  rollout_evidence_epoch INTEGER NOT NULL,
  pipeline_checksum TEXT NOT NULL,
  shadow_epoch INTEGER,
  canary_epoch INTEGER,
  canary_slot INTEGER,
  preset_version TEXT NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  input_checksum TEXT NOT NULL,
  execution_state TEXT NOT NULL,
  comparison_state TEXT NOT NULL,
  authoritative_result_json TEXT,
  authoritative_result_checksum TEXT,
  compare_job_id TEXT UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  result_committed_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(role_id, planning_revision),
  CHECK(pipeline_mode IN ('legacy', 'shadow', 'active')),
  CHECK(comparison_mode IN ('none', 'cognition_compare', 'legacy_compare')),
  CHECK(authoritative_pipeline IN ('legacy', 'cognition')),
  CHECK(comparison_direction IS NULL OR comparison_direction IN (
    'legacy_authoritative_cognition_compare',
    'cognition_authoritative_legacy_compare'
  )),
  CHECK(execution_state IN (
    'created', 'running', 'retry_wait', 'result_committed', 'completed', 'failed', 'cancelled'
  )),
  CHECK(comparison_state IN (
    'not_ready', 'not_applicable', 'queued', 'running', 'completed', 'failed', 'cancelled'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_life_planning_canary_slot
ON cognition_life_planning_attempts(rollout_key, canary_epoch, canary_slot)
WHERE canary_slot IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_life_planning_request_base
ON cognition_life_planning_attempts(request_base_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_life_planning_one_open_per_role
ON cognition_life_planning_attempts(role_id)
WHERE execution_state IN ('created', 'running', 'retry_wait', 'result_committed');
```

创建时 `input_snapshot_json` 保存经过 canonical JSON 的有界结构：role ID、固定规划锚点、
planning window、current/recent/upcoming life、cognitive state、relationship scene 和允许
动作；不得保存完整聊天、隐藏 prompt 或模型推理。
`life_basis_checksum` 只覆盖允许影响 domain CAS 的生活依据：未取消 life episode 的
ID/checksum、life state revision 和 planning window；`context_checksum` 覆盖输入中的
cognitive state、relationship scene 与允许动作集合。两者都不能把每分钟变化的
`Date.now()` 直接放进去。没有既有 horizon 时，
`planning_window_start_at` 使用配置固定的 10 分钟 planning bucket 起点；有 horizon 时使用
horizon end，`planning_window_end_at` 由固定 target duration 得出。输入里的
`planningAnchorAt` 等于这个稳定起点，不使用每次 poll 的瞬时时间。
`request_base_key=hash(roleId, planningWindowStartAt, planningWindowEndAt,
lifeBasisChecksum, contextChecksum)`，
用于辨认同一个业务请求；
`request_key=hash(requestBaseKey, presetVersion, pipelineMode, pipelineChecksum,
evidenceEpoch, shadowEpoch, canaryEpoch)`，用于辨认这个请求在某个最终固定 rollout 身份下
的 attempt。不能只用输入和 preset：否则 evidence epoch、晋级或回退后会错误复用旧
attempt；也不能把 poll 时间直接放进 request base，否则每分钟都会制造“新请求”。
`planning_revision` 在同一角色内由 Store 事务单调分配，调用者不能自报。

字段不变量：

- 权威结果提交前，`authoritative_result_json/checksum` 和 `compare_job_id` 必须全为空；
- `comparison_state=queued|running|completed|failed` 时，权威结果和 compare job ID 必须
  全部存在；
- `execution_state=failed|cancelled` 时不得存在权威结果或 compare job；
- `comparison_mode=none` 固定 `comparison_state=not_applicable`；
- compare 必要时创建初始为 `not_ready`，只能由权威结果提交事务改为 queued；
- `authoritative_result_json` 只保存验证后的规范化 life plan，不保存 prompt 或原始输出。

- [ ] **步骤 3：实现只固定身份、不创建 job 的第一阶段**

Task 13 的 `PromotionController` 增加：

```js
createLifePlanningAttempt({ roleId, planningContext, now })
commitLifePlanningAuthoritativeResult({
  planningId,
  workerId,
  validatedResult,
  now
})
failLifePlanningAttempt({
  planningId,
  workerId,
  errorCode,
  failureClass,
  report,
  now
})
```

Store 提供读取、claim、retry、恢复和只允许 Controller 在既有 `store.transaction(...)`
回调中调用的 `*Internal` 写入口。沿用当前 better-sqlite3 同连接事务约定：Internal 方法
直接使用 Store 的连接，但自己绝不 `BEGIN/COMMIT/ROLLBACK`，不虚构一个现有代码没有的
`tx` 参数：

```js
getLifePlanningAttempt(planningId)
getOpenLifePlanningAttempt(roleId)
claimDueLifePlanningAttempt({ workerId, now, leaseMs })
retryLifePlanningAttempt({ planningId, workerId, errorCode, nextDueAt, now })
recoverExpiredLifePlanningAttempts({ now })
countOutstandingComparisonSubjects({
  rolloutKey,
  direction,
  evidenceEpoch,
  shadowEpoch = null,
  canaryEpoch = null,
  now
})
```

`PromotionController.createLifePlanningAttempt()` 使用 `BEGIN IMMEDIATE`：

1. 先查询同角色 `created/running/retry_wait/result_committed` 的 open attempt；存在就
   原样返回。这个检查忽略当前 rollout，保证旧 attempt 固定模式并防止两份计划同时写
   同一生活时间窗；
2. 由 Controller 依据稳定 planning window 构造 canonical input，分别计算 life basis、
   context 和完整 input checksum，固定 `planningAnchorAt`，再计算 request base key；
   调用者传入的瞬时 `computedAt` 不能参与 key；
3. 读取当前 rollout；若已有相同 request base key、preset、mode、pipeline/evidence 以及
   shadow/canary epoch 的 attempt，原样返回，不能把同一调用重试误当成新 subject；
4. 仅当当前 rollout 为 active/canary 时调用
   `countOutstandingComparisonSubjects()` 做 backlog 熔断，其中
   created/running/retry_wait attempt 从 slot 分配时起就算 outstanding；
5. active/canary 已达 3 个或最老 subject 超过 15 分钟时，先原子回退
   LIFE_PLANNING 到新 shadow epoch；legacy、shadow 和 active/stable 跳过这一步，shadow
   outstanding 只由 promotion gate 查询；
6. 回退检查后重新读取最终 rollout，以它计算完整 request key；再次查询该 key，存在则
   原样返回；
7. 从最终 rollout 固定 mode、revision、evidence/pipeline/shadow/canary epoch、preset；
8. active/canary 原子分配 canary slot 并增加 started count/revision；shadow attempt 不分配
   slot，但因成为 comparison outstanding 同样增加 rollout revision；
9. 以 `planning_id=lifeplan:<roleId>:<planningRevision>` 插入
   `execution_state=created`；compare 必要时为 not_ready，否则 not_applicable；
10. commit。这个事务禁止插入任何 consolidation job。

open/exact 查询必须早于 backlog 检查，避免同一个 API 重试把既有 attempt 当成“新的第
4 个”而错误触发回退；最后一次查询必须在可能的回退之后，避免用回退前 rollout 生成
attempt。整个过程持有同一个写事务，因此两个并发请求不能跨过这些查询各插一行。

`claimDueLifePlanningAttempt()` 原子领取最早 due 的 created/retry_wait 或 lease 已过期的
running attempt，设置 running、attempt count 和 lease。重试始终读取保存的 input snapshot
与固定管线，不重新构造上下文。进程重启先恢复过期 lease；不得把 running 直接当作
result_committed。现有 `lifePlanningPromises` 只能保留为单进程 join 性能优化，
`lifePlanningRetryAfter` 的权威职责改由 attempt `due_at/execution_state` 承担；清空 Map
或重启不得改变是否可恢复。

新增单并发 `LifePlanningDispatcher`，只负责 attempt 的权威管线，不处理 compare：

```js
class LifePlanningDispatcher {
  start()
  recover()
  poke()
  runOnce()
  stop()
}
```

`main.mjs` 在接受周期性规划前先执行 `recover()` 再 `start()`；现有每分钟
`checkLifePlanning()` 负责创建/复用 attempt 并 `poke()`。现有
`orchestrator.ensureLifePlan()` 改为只做 context advance、创建/复用 attempt、poke 后立即
返回 planning ID/state；实时 turn 不等待 life provider，也绝不自己另跑 life 模型，继续
使用当时已提交的 life context。这样 LIFE_PLANNING 不占用实时回复的 60 秒软时限或 300 秒
硬上限。`runOnce()` 只供 dispatcher loop、测试和运维显式 drain 使用。
Dispatcher 优先级低于 TurnDispatcher；stop 时先停止新 claim，当前执行能在关闭期限内完成
则正常提交，否则保留 lease 由下次启动按 expiry 恢复，然后才关闭 Store。比较任务仍只由
ShadowDispatcher 在权威结果提交后领取。

- [ ] **步骤 4：运行固定的权威管线，失败时不建 compare**

```js
await cognitivePipeline.runLifePlanning({
  planningId,
  roleId,
  inputSnapshot,
  pipelineMode,
  presetVersion,
  pipelineChecksum
})
```

固定映射：

```text
legacy/stable                  -> legacy authoritative
shadow/collecting|rolled_back  -> legacy authoritative
active/canary                  -> cognition authoritative
active/stable                  -> cognition authoritative
```

输出只允许规范化 life episodes/adjustment 字段，继续经过时间窗、数量、重叠、动作权限和
base/phase/支付/安排表禁写校验。此阶段只产生内存中的 validated result，不写
`life_episodes`，也不创建 compare job。

模型不能决定持久 episode 主键。validator 按排序后的 ordinal 生成
`episodeId=life:<planningId>:<ordinal>`，再计算 authoritative checksum；重试得到相同 ID，
不同 planning attempt 不可能碰撞。

可重试的 provider/timeout 失败把 attempt 置 retry_wait 并保留同一 input/slot。legacy
资源故障使用有上限的长退避继续同一 attempt，不靠创建新行重试；shadow/active 达到配置
重试上限时先按 Task 15 的资源失败规则决定是否回退，回退后才把旧 attempt 收束为 failed。
确定性校验在允许的 rewrite 后仍失败时也收束为 failed：

- 调用 `PromotionController.failLifePlanningAttempt()`；由它开启唯一写事务，把
  execution_state 置 failed、清 lease；compare 必要时把 comparison_state 置 cancelled，
  comparison mode 为 none 时保持 not_applicable；
- 断言不存在 compare job，life state checksum 不变；
- active attempt 在该事务内复用 `recordActivePipelineFailureInternal()` 更新健康窗口和
  必要回退，禁止从事务中再调用会自行 `BEGIN IMMEDIATE` 的公开方法；
- legacy/shadow attempt 只记录失败，不增加 live shadow/canary completed 或 failure count。

- [ ] **步骤 5：在权威 life result 提交事务创建 compare**

`PromotionController.commitLifePlanningAuthoritativeResult()` 通过 Store 使用一个
`BEGIN IMMEDIATE` 外层事务，所有 Store 写入都走不会自行开事务的 `*Internal` 入口，禁止
嵌套事务：

1. canonicalize validated result，在 Store 内计算 authoritative result checksum；
2. 重新读取 attempt；若已有 result，checksum 相同则直接返回旧结果，checksum 不同则抛
   `LifePlanningResultConflictError`。这个幂等分支必须早于 lease 校验，因为首次成功提交
   已经清除了 lease；
3. 仅在尚无 result 时校验 worker lease、固定 checksum/input 和
   execution_state=running；
4. 在同一事务重算当前 life basis；不相等则不写 domain、不建 job，把 attempt 收束为
   `execution_state=cancelled`，comparison 必要时 cancelled、none 时 not_applicable，写
   `LIFE_BASIS_STALE` 并清 lease。它是输入并发变化，不调用 active failure/rollback；
5. basis 仍相等时，在这个外层事务中调用现有
   `putLifePlanInternal(roleId, episodes, {sourceTurnId: planningId})` 提交 episodes；
6. 保存 immutable `authoritative_result_json/checksum` 和 `result_committed_at`；
7. 根据固定 comparison mode：
   - shadow/cognition_compare：插入唯一 `shadow_cognition` job，direction 为
     `legacy_authoritative_cognition_compare`；
   - active/canary/legacy_compare：插入唯一 `active_canary_compare` job，direction 为
     `cognition_authoritative_legacy_compare`；
   - legacy/stable 或 active/stable/none：不插 job，直接
     `execution_state=completed, comparison_state=not_applicable`；
   - active/stable 成功还在本事务调用
     `recordActivePipelineSuccessInternal({subjectType:'life_planning',
     subjectId:planningId})`；
8. 需要 compare 时保存 job ID，设
   `execution_state=result_committed, comparison_state=queued`；
9. 清 attempt lease 并 commit。

job payload 必须包含：

```json
{
  "subjectType": "life_planning",
  "subjectId": "lifeplan:<roleId>:<planningRevision>",
  "turnId": null,
  "rolloutKey": "LIFE_PLANNING",
  "rolloutRevision": 0,
  "rolloutEvidenceEpoch": 0,
  "shadowEpoch": null,
  "canaryEpoch": null,
  "canarySlot": null,
  "comparisonDirection": "legacy_authoritative_cognition_compare",
  "authoritativePipeline": "legacy",
  "comparisonPipeline": "cognition",
  "authoritativeResultChecksum": "",
  "inputChecksum": "",
  "pipelineChecksum": "",
  "presetVersion": ""
}
```

job insert、episodes、attempt result/checksum/state 必须全成或全不成。重复 commit 依靠
`UNIQUE(subject_type, subject_id, job_type)` 和 result checksum 幂等，不能产生第二组 episode
或第二个 compare。

- [ ] **步骤 6：实现 compare、恢复和最终状态**

ShadowDispatcher claim life job 时，在同一事务把 job 设 running、attempt comparison state
设 running。worker 从 attempt 读取固定 input snapshot 与 immutable authoritative result，
分别校验 input/result checksum，再运行非权威管线：

```text
shadow_cognition       -> cognition dry-run
active_canary_compare  -> legacy dry-run
```

dry-run 只能返回 life plan，不得写 episodes、通知、消息、朋友圈、stage、支付或 role-plan
operation。ComparisonEvaluator 对比时间覆盖、重叠、允许动作、状态连续性和 schema；不把
自由文本风格差异当 critical。

`recordComparisonOutcome()` 在同一事务：

- 写 shadow run/report；
- 更新当前有效 rollout 计数或按 critical 回退；
- 把 job 置 completed/failed 并清 lease；
- evaluator 正常完成时把 attempt 置
  `execution_state=completed, comparison_state=completed`，即使结果含 critical；
- compare 达最终基础设施失败时把 attempt 置
  `execution_state=completed, comparison_state=failed` 并记录 error code；
- stale epoch 仍完成 attempt/job 审计，但不改变当前 rollout。

重启测试覆盖四个断点：创建后未运行、running lease 过期、life result commit 前退出、
result/job 已同事务提交但 compare 未开始。任何断点都不得提前 claim compare、重复提交
episode、重复建 job 或重复累计 canary。删除角色/来源时按 Task 21 把未完成 attempt/job
一起 cancelled；已提交结果只保留既有 domain 数据和脱敏审计语义。

- [ ] **步骤 7：保留生活规划质量和 replay 闸门**

功能测试继续覆盖：

- 没有用户消息也能推进 life timeline；
- 使用 `LIFE_PLANNING_SCHEMA_V2`，不经过 expression；
- 使用独立 session key `yuqi:{roleId}:life-planning:{presetVersion}`；
- 读取共享 cognitive state，但不把 life task 输出当用户事实；
- 计划合法、无重叠，模型失败保留原 life state；
- 重试不重复 episode，life episode 改变下一次 cognition 的身体/注意力输入；
- 聊天中的 `lifeAdjustment` 仍通过现有 validator；
- 专用 replay fixture 恰好 30 例，且不计入九种 TurnKind 的 270 例。

```powershell
node --test yuqi-runtime/test/life-planning-attempt.test.mjs
node --test yuqi-runtime/test/life-planning-dispatcher.test.mjs
node --test tests/yuqi-deployment-contract.test.mjs
node --test yuqi-runtime/test/life-simulation.test.mjs
node --test yuqi-runtime/test/cognitive-pipeline.test.mjs
node --test yuqi-runtime/test/orchestrator.test.mjs
node --test yuqi-runtime/test/store-cognition-migration.test.mjs
node --test yuqi-runtime/test/promotion-controller.test.mjs
node --test yuqi-runtime/test/shadow-dispatcher.test.mjs
node --test yuqi-runtime/test/comparison-evaluator.test.mjs
npm.cmd run cognition:replay -- --dataset tests/fixtures/yuqi-life-planning-replay-v1 --run-id life-planning-prerelease-1.0.106 --concurrency 2
npm.cmd run cognition:replay-report -- --run-id life-planning-prerelease-1.0.106
git add tests/fixtures/yuqi-life-planning-replay-v1/manifest.json tests/fixtures/yuqi-life-planning-replay-v1/cases.jsonl yuqi-runtime/test/life-planning-attempt.test.mjs yuqi-runtime/src/life-planning-dispatcher.mjs yuqi-runtime/test/life-planning-dispatcher.test.mjs yuqi-runtime/src/life-simulation.mjs yuqi-runtime/test/life-simulation.test.mjs yuqi-runtime/src/cognitive-pipeline.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/src/orchestrator.mjs yuqi-runtime/test/orchestrator.test.mjs yuqi-runtime/src/main.mjs tests/yuqi-deployment-contract.test.mjs yuqi-runtime/src/store.mjs yuqi-runtime/test/store-cognition-migration.test.mjs yuqi-runtime/src/promotion-controller.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/src/shadow-dispatcher.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/src/comparison-evaluator.mjs yuqi-runtime/test/comparison-evaluator.test.mjs
git commit -m "feat: commit life planning before comparison"
```

---

## Task 20：升级 Android fallback snapshot，但同时读取 v1

**文件：**

- 修改：`tavern-app/index.html`
- 修改：`tests/yuqi-ui-contract.test.mjs`
- 修改：`android/app/src/main/java/com/siyi/al/execution/DirectorCardCodec.java`
- 修改：`android/app/src/main/java/com/siyi/al/execution/NativeModelGateway.java`
- 修改：`android/app/src/main/java/com/siyi/al/execution/bridge/BridgeInput.java`
- 修改：`android/app/src/main/java/com/siyi/al/AlExecutionPlugin.java`
- 修改：`android/app/src/main/java/com/siyi/al/execution/AlExecutionService.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/DirectorCardCodecTest.java`
- 新建：`android/app/src/test/java/com/siyi/al/execution/NativeModelGatewayTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/bridge/BridgeInputTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/LiveReplyQualityGateTest.java`
- 修改：`android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- 修改：`android/app/src/androidTest/java/com/siyi/al/execution/YuqiProcessRecoveryTest.java`

- [ ] **步骤 1：先写 v1/v2 双读测试**

fixture A：现有 `memory-v1/chat-v1` snapshot。  
fixture B：新 `cognition-v2/expression-v2` snapshot。  
fixture C：v2 缺少可选 cognitive state。  
fixture D：未知 major version。

要求：

- A 行为与升级前一致；
- B 先 cognition 后 expression；
- C 使用空初始 state，不崩溃；
- D 明确失败并走现有可恢复路径，不错误解释成 v1；
- 不新增第三套 API Key/endpoint/model 配置；
- 用户现有 Memory AI 映射 cognition，Chat AI 映射 expression；
- Android 不保存或推断逐 TurnKind rollout mode；PC runtime 是唯一权威；
- fallback 回复照常送达并进入 FallbackJournal；
- PC 恢复不重写 fallback 回复。

- [ ] **步骤 2：扩展 snapshot**

v2 至少包含：

```json
{
  "packetType": "cognition-v2",
  "cognitionConfigId": "",
  "cognitionSystem": "",
  "cognitionMessages": [],
  "expressionConfigId": "",
  "expressionSystem": "",
  "expressionMessages": [],
  "cognitiveState": {},
  "localMemoryHints": [],
  "playerProfile": {
    "displayName": ""
  },
  "relationshipStage": {},
  "stageCatalog": [],
  "phaseCatalog": [],
  "currentPhase": {},
  "rolePlanCatalog": [],
  "roleScheduleContext": {},
  "momentContext": {}
}
```

保留旧字段：

```text
memoryConfigId
memorySystem
memoryMessages
chatConfigId
chatSystem
chatMessages
```

直到一次独立迁移明确移除。

- [ ] **步骤 3：保持 BridgeInput 完整**

`BridgeInput` 必须继续保留 full batch、quote、image metadata、payment、trigger、scene 和
retry lineage，并把经过手机召回的结构化 `localMemoryHints` 放入 context。语音气泡必须
保留 `type=voice`、`voiceDuration` 和可选 `transcript`；不得传原始音频 blob。禁止为了
v2 新增“lastMessage”捷径，也不得把 `memorySystem`/`memoryMessages` 整段当作结构化记忆
传给 PC。

Android 提交只携带 kind、输入和 snapshot，不携带 `activeKinds` 或 rollout revision。PC
创建 turn 后返回的状态可以包含已固定 `pipelineMode/rolloutRevision` 供诊断，但 Android
不得用它决定下一 turn。PC 不可用时仍按本机 fallback 执行，不修改 PC rollout。

- [ ] **步骤 4：固定原生收件、通知与 WebView 落地的收敛协议**

先写失败测试，覆盖：

- Android Room 已 COMPLETED 且系统通知已显示，但 WebView 尚未打开；
- 原生 COMPLETED 事件丢失后，轮询或 recent-completed replay 能补齐正文；
- 一次 Capacitor reconcile 调用永久不返回时，超时会释放 promise，下一 turn 仍可落地；
- 原生事件与轮询同时返回同一 turn 时，只渲染一次、只确认一次 `uiAppliedAt`；
- WebView/Android 进程重启后，未应用 turn 会恢复，已应用 turn 不重复；
- `cloudConfirmedAt`、`nativeCompletedAt` 和 `uiAppliedAt` 分开记录和诊断，通知不得提前确认
  UI applied。

实现要求：

- `AlExecutionService` 在完整结果写入 Room 后主动通知 `AlExecutionPlugin` 发 Capacitor
  COMPLETED 事件；事件只携带 turn identity/checksum，不携带秘密或整段隐藏预设；
- `index.html` 监听事件并立即 drain；现有三秒轮询保留为兜底；
- 所有 reconcile bridge 调用有有限超时，陈旧全局 promise 必须在 `finally` 清除；
- recent-completed replay 不依赖可能已悬挂的旧 promise；
- DOM 持久化成功后才调用 `acknowledgeUiApplied`，以 turnId + result checksum 幂等；
- “正在认真想”只在 native completed 尚未成功应用时存在；应用完成立即收敛；
- 端到端诊断能区分 native、cloud 和 UI 三个检查点。

- [ ] **步骤 5：验证与提交**

```powershell
node --test tests/yuqi-ui-contract.test.mjs
Set-Location android
.\gradlew.bat testDebugUnitTest --no-daemon --max-workers=1 --no-problems-report
Set-Location ..
```

只暂存本任务修改后：

```powershell
git commit -m "feat: support cognition v2 in Android fallback"
```

---

## Task 21：固定备份、导入、清理、删除和角色生命周期

**文件：**

- 修改：`tavern-app/index.html`
- 修改：`tests/yuqi-ui-contract.test.mjs`
- 修改：`yuqi-runtime/src/store.mjs`
- 修改：`yuqi-runtime/test/store-cognition-migration.test.mjs`
- 修改：`yuqi-runtime/src/reconcile.mjs`
- 修改：`yuqi-runtime/test/reconcile.test.mjs`
- 修改：`android/app/src/test/java/com/siyi/al/execution/BridgeReceiptCheckpointTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/AutomaticTaskRecoveryPolicyTest.java`
- 修改：`android/app/src/test/java/com/siyi/al/execution/bridge/FallbackJournalTest.java`
- 修改：`android/app/src/androidTest/java/com/siyi/al/execution/RoomExecutionStoreTest.java`
- 修改：`android/app/src/androidTest/java/com/siyi/al/execution/YuqiProcessRecoveryTest.java`

- [ ] **步骤 1：先写数据生命周期表驱动测试**

行为固定为：

| 用户操作 | cognitive state | consolidation/compare jobs | rollout 与评估证据 | facts | persona/stage | plans/tasks |
|---|---|---|---|---|---|---|
| 清空自动任务 | 保留 | 取消尚未执行的自动 turn compare；保留已提交证据 job | 保留 rollout/history/replay/live 报告 | 保留 | 保留 | 清主动/安排唤醒及 snapshot |
| 清空当前聊天 | 删除该角色短期状态 | 取消依赖已清聊天的未完成 job | rollout 保留；已完成脱敏 run 保留并标记 source deleted | 保留已验证事实和手机 MemoryDB | 保留 | 保留 |
| 清空当前角色记忆 | 删除该角色短期状态 | 取消该角色未完成 consolidation；compare 按 turn 状态处理 | rollout 和代码质量报告保留 | 删除该角色 facts 和手机 MemoryDB | 保留 | 保留 |
| 删除单条消息 | 重算受影响 open thread/纠正 | 取消或重排依赖 job | 未完成 compare 取消；已完成 run 标记 source deleted | 抑制依赖 fact | 保留 | 保留 |
| 删除角色 | 删除 | 取消角色相关 job | 全局 rollout 保留；角色来源 run 脱敏保留 | 删除该角色 | 删除该角色 | 删除该角色 |
| 清空全部聊天记录 | 删除全部角色短期状态 | 取消依赖已清聊天的未完成 job | rollout/history 保留；历史来源 run 标记 source deleted | 保留已验证 facts 和各角色 MemoryDB | 保留 | 取消主动任务，保留角色安排定义 |
| 导入旧备份 | 缺省为空 | 缺省为空 | 不从旧手机备份覆盖 PC rollout | 恢复旧 facts | 恢复 | 恢复 |
| 导入新备份 | 校验后恢复 | 只恢复可安全重跑 job | 手机备份不导入 PC rollout/replay/history | 恢复 | 恢复 | 恢复 |

这些语义与当前 UI 分开的“清空聊天记录”“清空当前角色记忆”“删除这个角色”操作一致。
本次不合并按钮，也不借升级扩大删除范围。PC 的清理请求必须带 operation enum，不能只传
布尔值：

```text
CLEAR_ROLE_CHAT
CLEAR_ROLE_MEMORY
DELETE_MESSAGE
DELETE_ROLE
CLEAR_ALL_CHATS
CLEAR_AUTOMATIC_TASKS
```

- [ ] **步骤 2：删除消息后的证据处理**

删除 canonical message 后：

- 依赖它的 verified fact 进入 suppressed；
- 未运行 consolidation job 取消；
- 已完成 job 不直接删除审计记录；
- 已完成 replay/shadow run 只保留 checksum 和脱敏指标，并写 `sourceDeletedAt`；
- 删除来源后，该 run 不再计入下一次 promotion check，但不倒推回滚已稳定 active 的历史
  决定；若当前仍在 canary/collecting，控制器重新计算有效计数；
- backfill cursor 回退到该完整组之前；
- cognitive state 中只移除明确依赖该消息的 boundary/correction/open thread；
- 不自动重写历史回复。

`cognition_life_planning_attempts` 随角色生命周期处理：清聊天、清自动任务或清角色记忆只
取消尚未完成且依赖被清来源的 attempt：权威结果尚未提交时把 execution 设为 cancelled；
compare 必要时 comparison 设为 cancelled，comparison mode 为 none 时仍为
not_applicable。权威结果已经提交时保留 result/checksum 和 life timeline，把 execution
收束为 completed；只有 queued/running compare 才设为 cancelled 并取消 job，none 继续
保持 not_applicable。删除角色时先取消该角色 job，再删除其 attempt 行。由这些 attempt
产生的已完成脱敏 run/report 只保留 checksum 并标记 source deleted，后续不再计入
promotion。全局 rollout/history 永远不随单个角色删除。

- [ ] **步骤 3：兼容导入导出**

新 snapshot 字段都可缺省。导入 job 时重新计算 payload checksum 和 due time；不恢复过期
lease owner。导入完成不得自动发送旧回复或执行过期动作。

手机备份继续包含 `summaries/events/profiles/vectors/meta`。导入后用现有索引重建方法校验
每条记录的 charId，不把一个角色的 `localMemoryHints` 泄漏给另一角色。手工新增、编辑、
删除记忆后，下一次 snapshot 必须使用新 revision；已排队 turn 继续使用创建时固定的旧
snapshot，避免执行中上下文漂移。

设置恢复继续保留当前设备绑定和接口密钥的现有安全规则。v2 不覆盖语音转写地址、模型、
置顶、免打扰、通知权限或云闹钟绑定。

- [ ] **步骤 4：Android 清理回归**

现有测试至少覆盖：

```text
AutomaticTaskCleanupResult
RoomExecutionStore
FallbackJournal
RolePlanCoordinator
BridgeReceiptCheckpoint
```

- [ ] **步骤 5：验证与提交**

```powershell
node --test tests/yuqi-ui-contract.test.mjs
node --test yuqi-runtime/test/store-cognition-migration.test.mjs
node --test yuqi-runtime/test/reconcile.test.mjs
Set-Location android
.\gradlew.bat testDebugUnitTest --no-daemon --max-workers=1 --no-problems-report
.\gradlew.bat assembleDebugAndroidTest --no-daemon --max-workers=1 --no-problems-report
Set-Location ..
```

只暂存本任务修改后：

```powershell
git commit -m "test: preserve Yuqi data lifecycle during cognition upgrade"
```

---

## Task 22：建立角色质量回归、晋级报告和 rollout 运维命令

**文件：**

- 新建：`tests/fixtures/yuqi-cognition-regression.json`
- 新建：`scripts/evaluate-yuqi-cognition.mjs`
- 新建：`scripts/report-yuqi-live-shadow.mjs`
- 新建：`scripts/check-yuqi-cognition-promotion.mjs`
- 新建：`scripts/promote-yuqi-cognition.mjs`
- 新建：`scripts/rollback-yuqi-cognition.mjs`
- 新建：`scripts/show-yuqi-rollout-status.mjs`
- 新建：`tests/yuqi-cognition-evaluator.test.mjs`
- 新建：`tests/yuqi-rollout-cli.test.mjs`
- 修改：`scripts/inspect-yuqi-turn.mjs`
- 修改：`scripts/inspect-yuqi-latest.mjs`
- 修改：`package.json`

质量测试不固定“标准台词”，而固定认知和行为约束，避免把角色训练成模板。

- [ ] **步骤 1：先写 evaluator 失败测试**

接口：

```js
export function evaluateCognitionCase({ input, cognition, expression, approvedDraft })
export function compareShadowRun({ legacy, cognition })
export function redactCognitionDiagnostic(value)
```

每个回归 case 包含：

```json
{
  "caseId": "",
  "source": "",
  "turnKind": "DIRECT_REPLY",
  "input": {},
  "mustNoticeMessageIds": [],
  "allowedIntentHypotheses": [],
  "forbiddenInferences": [],
  "requiredStateContinuity": [],
  "allowedActions": [],
  "forbiddenActions": [],
  "publicPrivateConstraints": [],
  "stageConstraints": {},
  "mustNotContainStyles": []
}
```

- [ ] **步骤 2：建立回归集**

至少 60 例：

- 第一、二轮人工批注提炼 20 例；
- 多气泡、quote、image、payment 10 例；
- normal/conflict/cooling/repair 与 base 独立组合 10 例；
- 主动、沉默、生活变化 8 例；
- 朋友圈公开/私密边界 6 例；
- 安排和角色日程 6 例。

第四轮未确认潜台词只可作为 `provisional` 评估，不得成为必须命中的答案。

- [ ] **步骤 3：实现来源隔离的 report 与 promotion check**

导出：

```js
export function buildReplayGate({ replayBatch, replayRuns })
export function buildLiveShadowGate({ rollout, shadowRuns, outstandingSubjects, now })
export function buildCanaryGate({ rollout, shadowRuns, outstandingSubjects, now })
export function buildPromotionReport({ rolloutKey, targetPhase, evidence, now })
```

过滤规则：

- replay gate 只读 `cognition_replay_runs`；
- replay batch 的 preset/model profile checksum 必须等于 rollout 当前 candidate；fixture
  report 还必须匹配 manifest dataset checksum，两个 DIRECT_REPLY 报告必须来自同一
  candidate；
- live gate 只读 `cognition_shadow_runs.source=live` 且
  `comparison_direction=legacy_authoritative_cognition_compare`；
- canary gate 只读 `source=live` 且
  `comparison_direction=cognition_authoritative_legacy_compare`；
- `source_deleted_at IS NOT NULL` 的 run 不计数；
- run 的 `evidence_epoch/pipeline_checksum` 必须等于 rollout 当前值；
- live shadow run 的 `shadow_epoch`、canary run 的 `canary_epoch` 必须分别等于当前窗口；
- live gate 必须确认当前 evidence/shadow epoch 没有未完成权威 subject 或
  `shadow_cognition` job；canary gate 必须确认当前 canary epoch 没有未完成权威 subject
  或 `active_canary_compare` job；
- 同一 `(subject_type, subject_id, direction)` 只计一次；
- `stale_for_rollout=true` 的 run 只展示，不计入任何闸门；
- fixture、local_history、live、canary 数量分别显示，永不相加。

`outstandingSubjects` 必须由 Store 在形成 promotion report 的同一只读快照调用
`countOutstandingComparisonSubjects()` 得出并列出 subject IDs/state；随后若有新 subject
创建，rollout revision 会变化，使旧 promotion report 在 `promote` 时 CAS 失败。

promotion report 包含 DB 查询窗口、run IDs、rollout revision、preset/model/dataset checksum、
critical code 计数和 artifact SHA-256。报告路径固定：

```text
artifacts/qa/cognition/live/runs/<run-id>.json
artifacts/qa/cognition/live/<report-id>/summary.json
artifacts/qa/cognition/live/<report-id>/summary.md
artifacts/qa/cognition/promotions/<rollout-key>-<revision>.json
```

`promotion-check` 在同一只读快照中形成 canonical JSON，随后通过 Store 写入
`cognition_evaluation_reports`，原子落盘并回读校验后标记 `materialized`。若存在 pending
单次报告，报告命令先按 DB `summary_json` 重建；重建失败则 promotion check 非零退出。

性能闸门：

- 记录 cognition、expression、supervisor 和 total latency；
- 普通 direct reply 的 total p50/p90 分别报告；
- 超过 60 秒标记 slow；
- 300 秒强制停止并进入既有恢复/fallback；
- shadow 不计入 visible latency。

- [ ] **步骤 4：诊断脱敏**

输出允许：

```text
turnId
pipelineMode
turnKind
presetVersion
route
stage names/revisions
selected lessonIds
selected factIds
messageId coverage
action types/targets
latency
error codes
checksums
```

禁止：

```text
API key
pairing secret
cloud token
image base64
完整隐藏预设
完整用户私聊正文
模型隐藏推理
```

- [ ] **步骤 5：实现七个正式命令**

所有命令先打开 Store，再构造同一个 `PromotionController`。不得直接执行 SQL update。

```text
cognition:replay
cognition:replay-report
cognition:shadow-report
cognition:promotion-check
cognition:promote
cognition:rollback
cognition:rollout-status
```

具体调用：

```powershell
npm.cmd run cognition:shadow-report -- --kind PROACTIVE_CHAT --report-id proactive-chat-2026-08-01
npm.cmd run cognition:promotion-check -- --kind PROACTIVE_CHAT --target canary
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/PROACTIVE_CHAT-7.json
npm.cmd run cognition:rollback -- --kind PROACTIVE_CHAT --target shadow --expected-revision 8 --reason MANUAL_SAFETY_ROLLBACK
npm.cmd run cognition:rollout-status -- --all
```

`promotion-check` 只读并以非零退出码表示不合格，并把 `expectedRolloutRevision` 写进
promotion report。`promote` 只接受 report 路径，从报告读取 expected revision，并校验
report 文件 SHA-256 和 DB report 行；不得提供 `--force`。`rollback` 允许 active->shadow，
只有 reason=`SHADOW_RESOURCE_INSTABILITY` 时允许 shadow->legacy。`rollout-status` 输出每类：

报告生成使用同目录临时文件 + 原子 rename，已经存在的 report path 不得覆盖。`promote`
先把规范化到 `artifacts/qa/cognition/promotions/` 内的文件完整读入内存并计算 checksum，
再开启 `BEGIN IMMEDIATE`；事务中只使用这份不可变字节，校验 DB row/state/checksum 和
expected revision 后转换。拒绝目录穿越、符号链接越界、文件缺失及 checksum race。

`promotion-check --target shadow` 只允许 `legacy -> shadow/collecting`，生成
reason=`INITIAL_SHADOW_COLLECTION` 的报告，不要求 live 样本；它不能用于 active。
DIRECT_REPLY 的初始 `--target canary` 必须显式提供
`--fixture-report <summary.json> --history-report <summary.json>`；其他 kind 的 canary check
必须显式提供 `--live-report <summary.json>`。缺少或来源类型错误时失败。

```text
current mode/phase/revision
shadow epoch and live success/failure and 72h window
canary started/completed/failure and 48h window
canary outstanding/oldest age and backlog limits
stable active transient failure count/window
last report/checksum
last transition
next unmet gate
```

`package.json`：

```json
"cognition:eval": "node scripts/evaluate-yuqi-cognition.mjs",
"cognition:shadow-report": "node scripts/report-yuqi-live-shadow.mjs",
"cognition:promotion-check": "node scripts/check-yuqi-cognition-promotion.mjs",
"cognition:promote": "node scripts/promote-yuqi-cognition.mjs",
"cognition:rollback": "node scripts/rollback-yuqi-cognition.mjs",
"cognition:rollout-status": "node scripts/show-yuqi-rollout-status.mjs",
"cognition:test": "node --test tests/cognition-assets-contract.test.mjs tests/yuqi-cognition-evaluator.test.mjs tests/yuqi-cognition-replay-contract.test.mjs tests/yuqi-rollout-authority-contract.test.mjs tests/yuqi-rollout-cli.test.mjs yuqi-runtime/test/cognition-contract.test.mjs yuqi-runtime/test/cognition-context.test.mjs yuqi-runtime/test/cognitive-pipeline.test.mjs yuqi-runtime/test/cognitive-state.test.mjs yuqi-runtime/test/comparison-evaluator.test.mjs yuqi-runtime/test/consolidation-worker.test.mjs yuqi-runtime/test/promotion-controller.test.mjs yuqi-runtime/test/replay-runner.test.mjs yuqi-runtime/test/shadow-dispatcher.test.mjs yuqi-runtime/test/social-experience.test.mjs"
```

```powershell
node --test tests/yuqi-cognition-evaluator.test.mjs
node --test tests/yuqi-rollout-cli.test.mjs
npm.cmd run cognition:eval
npm.cmd run cognition:test
git add tests/fixtures/yuqi-cognition-regression.json scripts/evaluate-yuqi-cognition.mjs scripts/report-yuqi-live-shadow.mjs scripts/check-yuqi-cognition-promotion.mjs scripts/promote-yuqi-cognition.mjs scripts/rollback-yuqi-cognition.mjs scripts/show-yuqi-rollout-status.mjs tests/yuqi-cognition-evaluator.test.mjs tests/yuqi-rollout-cli.test.mjs scripts/inspect-yuqi-turn.mjs scripts/inspect-yuqi-latest.mjs package.json
git commit -m "feat: report and control Yuqi cognition rollouts"
```

---

## Task 23：完成全链路验证、DIRECT_REPLY canary、回退演练和正式 APK

**文件：**

- 修改：`yuqi-runtime/presets/manifest.json`
- 修改：`yuqi-runtime/config.example.json`
- 修改：`YUQI_RUNTIME.md`
- 修改：`ANDROID_APP.md`
- 修改：`docs/memory-follow-up.md`
- 修改：`tests/fixtures/yuqi-cognition-feature-matrix.json`
- 修改：`tavern-app/sw-v11.js`
- 修改：`android/app/build.gradle`
- 修改：`android-update.json`
- 修改：`tests/android-unsigned-release-contract.test.mjs`
- 修改：`tests/yuqi-deployment-contract.test.mjs`
- 生成：`artifacts/` 下正式安装包和验收记录

- [ ] **步骤 1：清零矩阵中的 planned**

`tests/fixtures/yuqi-cognition-feature-matrix.json` 中所有测试状态改为 `implemented`。矩阵测试
增加最终规则：`planned` 数量必须为零。

- [ ] **步骤 2：运行完整 Node/Web/Cloud/runtime 测试**

```powershell
npm.cmd run cognition:check
npm.cmd run cognition:matrix
npm.cmd run cognition:test
npm.cmd test
```

任何失败都修实现，不能放宽能力矩阵或删除旧回归。

- [ ] **步骤 3：运行完整 Android 验证**

```powershell
Set-Location android
.\gradlew.bat testDebugUnitTest assembleDebugAndroidTest --no-daemon --max-workers=1 --no-problems-report
.\gradlew.bat connectedDebugAndroidTest --no-daemon --max-workers=1 --no-problems-report
Set-Location ..
npm.cmd run android:copy
```

另外执行已有：

```powershell
node test-cloud-device-cleanup.mjs
node test-cloud-quota-recovery.mjs
node test-cloud-role-plans.mjs
node test-cloud-task-singleton.mjs
```

- [ ] **步骤 4：生成离线证据并原子建立首版 rollout**

先完成固定 fixture 与本机历史回放：

```powershell
npm.cmd run cognition:replay -- --dataset tests/fixtures/yuqi-cognition-replay-v1 --run-id prerelease-1.0.106 --concurrency 2
npm.cmd run cognition:replay-report -- --run-id prerelease-1.0.106
npm.cmd run cognition:replay -- --source local-history --kind DIRECT_REPLY --limit 30 --run-id direct-history-1.0.106
npm.cmd run cognition:replay-report -- --run-id direct-history-1.0.106
```

两个报告任一不合格则停止，不能构建“正式”包。报告通过后：

1. 使用 PromotionController 把其他八种 TurnKind 从 legacy 转为 `shadow + collecting`；
2. 使用 fixture report + local_history report 生成 DIRECT_REPLY promotion report；
3. 以 expected revision 把 DIRECT_REPLY 转为 `active + canary`；
4. `LIFE_PLANNING` 保持 `legacy + stable`；
5. 输出 rollout status 和 promotion history。

必须使用正式命令，不直接改 DB：

```powershell
npm.cmd run cognition:promotion-check -- --kind MOMENT_INTERACTION --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/MOMENT_INTERACTION-1.json
npm.cmd run cognition:promotion-check -- --kind MOMENT_REPLY --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/MOMENT_REPLY-1.json
npm.cmd run cognition:promotion-check -- --kind PROACTIVE_CHAT --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/PROACTIVE_CHAT-1.json
npm.cmd run cognition:promotion-check -- --kind PROACTIVE_MOMENT --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/PROACTIVE_MOMENT-1.json
npm.cmd run cognition:promotion-check -- --kind ROLE_PLAN_CHAT --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/ROLE_PLAN_CHAT-1.json
npm.cmd run cognition:promotion-check -- --kind ROLE_PLAN_MOMENT --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/ROLE_PLAN_MOMENT-1.json
npm.cmd run cognition:promotion-check -- --kind ROLE_PLAN_CHAT_PRIVATE --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/ROLE_PLAN_CHAT_PRIVATE-1.json
npm.cmd run cognition:promotion-check -- --kind ROLE_PLAN_MOMENT_PRIVATE --target shadow
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/ROLE_PLAN_MOMENT_PRIVATE-1.json
npm.cmd run cognition:promotion-check -- --kind DIRECT_REPLY --target canary --fixture-report artifacts/qa/cognition/replay/prerelease-1.0.106/summary.json --history-report artifacts/qa/cognition/replay/direct-history-1.0.106/summary.json
npm.cmd run cognition:promote -- --report artifacts/qa/cognition/promotions/DIRECT_REPLY-1.json
npm.cmd run cognition:rollout-status -- --all
```

报告文件名和内部 `expectedRolloutRevision` 必须来自同一次 promotion-check；若期间 revision
变化，promote 明确失败并要求重新生成报告，不能自动使用新 revision。首版最终状态必须是：

```text
DIRECT_REPLY = active/canary
其他八种 TurnKind = shadow/collecting
LIFE_PLANNING = legacy/stable
```

APK 交付不宣称其他八种已经 active。它们以后按每类真实 30 次、72 小时、canary 至少 10 次和
48 小时分别晋级，不需要重新安装 APK。

- [ ] **步骤 5：在隔离克隆库逐类回退、反向 compare 和重启演练**

关闭写入后用 SQLite backup API 建立脱敏 QA 克隆库，复制当时 rollout、job 和 checksum
状态，但将所有消息/动作/通知 sink 替换为 dry-run。演练只连接克隆库，不使用生产 Store，
不使用“全局模式”。创建以下现场状态：

- 一个 cognition 已完成、expression 待重试的 direct turn；
- 一个 DIRECT_REPLY active/canary turn，固定 `legacy_compare + canary_slot=1`；
- 一个故意产生 `ACTION_TARGET_ESCALATION` 的 canary compare；
- 一个同 kind 在自动回退后创建的新 turn；
- 一个已送达但 consolidation 未完成的 turn；
- 一个 retry_wait consolidation job；
- 一个已分配 LIFE_PLANNING canary slot、仍 running 且尚无权威 result/job 的 attempt；
- 一个 life result 已提交、compare queued 的 attempt；
- 一个待执行 role-plan occurrence；
- 一个 cloud inbox 重复投递；
- 一个 fallback provisional log。

证明：

- critical finding 的 shadow run、rollout 回退和 promotion history 同一事务提交；
- 只回退 DIRECT_REPLY，其他八种 rollout revision 不变；
- 已固定 active 的旧 pending turn 继续按 active checkpoint 和原 canary slot 恢复；
- 自动回退后创建的新 DIRECT_REPLY 固定 shadow + cognition compare（legacy visible）；
- 服务重启后 canary started/completed/remaining、72/48 小时时间窗和 report checksum 不变；
- active 回退产生新 shadow epoch，回退前的 shadow 样本不能计入新一轮 30 次；
- running life attempt 重启后仍无 compare job，权威结果提交后才原子出现唯一 job；
- 重启时由 LifePlanningDispatcher 先恢复旧固定 attempt；即使 rollout 已变也不另建同角色
  open attempt；
- result_committed life attempt 不重复写 episode/job，且从固定 input/checksum 恢复 compare；
- life basis 在 provider 运行中变化时旧 result 只产生 `LIFE_BASIS_STALE`，不产生 episode、
  compare job 或 rollout failure；
- active canary 的 legacy 对照没有提交消息、支付、朋友圈、安排、stage 或 life；
- consolidation 继续或可安全暂停；
- 不重复消息、支付、朋友圈或安排动作；
- 数据库无需回滚；
- Android v1 fallback 仍可用。

演练结束后重新读取生产 Store，证明全部 rollout revision、mode、phase、计数和 checksum
与克隆前快照一致；正式库最终仍保持步骤 4 的首版状态。克隆库和报告留在
`artifacts/qa/cognition/rollback-drill/<drill-id>/`，不得包含用户正文。

- [ ] **步骤 6：版本与文档**

全部闸门通过后才把 preset manifest 当前版本升到 `2.0.0`。文档必须写明：

- 三种 pipeline mode；
- SQLite rollout 唯一权威、revision 和逐 kind 启用顺序；
- replay、live shadow、active canary 的来源隔离；
- 270 fixture、30 local history、30 live/72h、10 canary/48h 闸门；
- promotion-check/promote/rollback/rollout-status 命令；
- 首版 DIRECT_REPLY canary、其他八种 shadow、life legacy 的准确状态；
- 60 秒/300 秒时限；
- shadow 诊断查看方法；
- consolidation 重试/手动恢复；
- v1/v2 Android fallback；
- stage 的 base/phase 权威和原子写回；
- 备份、导入、清理和删除语义；
- legacy 回退步骤。

本次发布从当前基线 `versionCode 105 / versionName 1.0.105` 升为
`versionCode 106 / versionName 1.0.106`。把 `tavern-app/sw-v11.js` 的 cache name 从
`rpchat-v97` 升为 `rpchat-v98`，保持 APP_SHELL 完整，确保升级后的 WebView 不继续命中旧
`index.html`。`android-update.json` 只能在正式 APK 生成并计算 SHA-256 后填写 1.0.106 的
下载元数据。两个 release/deployment contract 测试同时锁定 version、cache 和 update
manifest 一致性。

`docs/memory-follow-up.md` 中“200 条之外的历史补提取”标记为本次 backfill 已实现，并保留
仍未完成的向量/语义召回事项；不要把未实现项写成已完成。

- [ ] **步骤 7：正式签名 APK**

严格遵循：

```text
docs/AL-android-signing-runbook.md
```

本机没有正式私钥时，按 runbook 使用已有 GitHub 凭据和 REST API 触发固定证书构建；
不得交付调试签名、未签名或临时证书 APK 冒充正式包。

交付前记录：

```text
package name
versionCode
versionName
APK signature validity
formal certificate SHA-256
APK file SHA-256
full test command results
feature matrix result
fixture replay report ID/SHA-256
DIRECT_REPLY local-history report ID/SHA-256
rollout status snapshot ID/SHA-256
DIRECT_REPLY promotion history event ID
rollback drill result
```

旧 APK 移到 `artifacts/legacy-installers/`，当前正式包只放 `artifacts/`。

- [ ] **步骤 8：最终提交**

```powershell
git add yuqi-runtime/presets/manifest.json yuqi-runtime/config.example.json YUQI_RUNTIME.md ANDROID_APP.md docs/memory-follow-up.md tests/fixtures/yuqi-cognition-feature-matrix.json tavern-app/sw-v11.js android/app/build.gradle android-update.json tests/android-unsigned-release-contract.test.mjs tests/yuqi-deployment-contract.test.mjs
git commit -m "docs: release Yuqi cognition runtime v2"
```

APK 和验收记录是否提交 Git 以项目现有产物策略为准；不得把密钥、签名材料或含用户正文的
诊断加入仓库。

---

## 2. 最终验收清单

执行窗口在宣告完成前必须逐项给出证据，不得只说“测试通过”。

### 人物与对话

- [ ] 虞栖先形成自己的状态、态度和关系动作，再表达。
- [ ] 同一状态跨轮连续，但会被时间、生活和新证据改变。
- [ ] 能保留合理歧义，不把一个猜测强行当事实。
- [ ] 有自己的生活、边界、注意力、未完成事项和主动性。
- [ ] 不出现分析腔、客服腔、流程腔和功能闭环强迫。
- [ ] 人工经验是条件化关注点，不是固定台词库。
- [ ] 当前完整多气泡无遗漏。

### 全功能

- [ ] 九种 TurnKind 在测试中 legacy/shadow/active 全覆盖；不把“可 active”误报为“已生产 active”。
- [ ] 私聊、主动聊天、主动朋友圈、朋友圈互动/回复均通过。
- [ ] 三类安排 domain 和四类安排 TurnKind 均通过。
- [ ] 角色日程、生活时间线和生活调整均通过。
- [ ] base、phase、阶段专属人设、版本历史和回退均通过。
- [ ] 红包、转账、主动支付、图片、引用、删除和重试均通过。
- [ ] 语音转写、无转写语音、Unicode 表情、撤回和退款语义均通过。
- [ ] 玩家昵称、虞栖角色卡、会话额外设定和手机 MemoryDB 召回均通过。
- [ ] 手工记忆增删改、向量召回、置顶、免打扰、未读和通知均无回归。
- [ ] service worker cache、应用版本和 `android-update.json` 指向同一正式版本。
- [ ] LAN、CLOUD、重复投递、receipt、outbox 和通知均通过。
- [ ] Android fallback v1/v2、后台执行和进程重启均通过。
- [ ] 导入导出、清理单项、删除消息、删除角色和全清均通过。
- [ ] 非虞栖角色路径未改变。

### 数据与失败

- [ ] 旧数据库自动、幂等迁移，无 turn/fact/preset/plan 丢失。
- [ ] cognition checkpoint 可恢复，expression 失败不重跑 cognition。
- [ ] consolidation 失败不阻塞、不改变可见 turn。
- [ ] receipt 前的虞栖草稿不成为可检索事实。
- [ ] 重复 job、重复 receipt、重复云投递不产生重复事实或动作。
- [ ] 60 秒慢回合可诊断，300 秒硬停止可恢复。
- [ ] legacy 回退无需数据库回滚。
- [ ] SQLite rollout 是唯一权威，配置和 Android 不能覆盖它。
- [ ] replay/local_history/live shadow/active canary 数量严格分表、分方向统计。
- [ ] 自动回退只改变目标 kind，新旧 turn 由固定 revision 正确分流。
- [ ] 旧 evidence/shadow/canary epoch 的晚到结果只归档，不改变当前 rollout。
- [ ] canary 对照积压达到 3 个或超过 15 分钟时，新任务创建前原子回退到 shadow。
- [ ] LIFE_PLANNING attempt 创建阶段没有 compare job；权威 life result、checksum、attempt
  状态和唯一 compare job 在同一事务提交。
- [ ] life authority 失败、重启和重复提交不会残留无基准 job、重复 episode 或错误 canary
  计数。
- [ ] 诊断和提交中没有密钥、token、图片 base64、完整隐藏预设或用户正文。

### 交付

- [ ] 全量 Node/Web/Cloud/runtime 测试通过。
- [ ] Android unit 与 instrumentation APK 构建通过。
- [ ] 270 fixture 与 DIRECT_REPLY 30 条 local_history 离线闸门通过；DIRECT_REPLY 具备进入
  canary 的合格 promotion report；其他八种已进入 live shadow 收集态。
- [ ] live shadow 和 active canary 的来源隔离、计数、重启恢复及后续晋级闸门已由自动化
  测试和隔离回退演练验证；不虚构尚未在真实时间窗中产生的生产样本。
- [ ] 分阶段 active 与 legacy 回退演练通过。
- [ ] 首版状态为 DIRECT_REPLY active/canary、其他八种 shadow/collecting、LIFE_PLANNING legacy/stable。
- [ ] 正式 APK 的包名、版本、签名证书和 SHA-256 已核对。
- [ ] 当前安装包在 `artifacts/`，旧包在 `artifacts/legacy-installers/`。

只有上面全部完成，才能把本次代码重构和首版受控启用判定为交付完成。其他八种 TurnKind
只有在后续各自满足真实 shadow 与 canary 闸门后，才可以称为生产 active；APK 交付本身
不能提前宣称全 active。
