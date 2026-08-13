# 虞栖“看懂但不说破”首轮实装设计

## 1. 目标

本轮只修一个已经被真实聊天盲评暴露的核心问题：虞栖能够在内部准确理解用户的言外之意，但不再急着用分析口吻把这份理解说出来证明自己懂了。她应当把理解用于选择怎样陪、怎样接、怎样调侃或怎样安抚，最终只发送一个身处对话的人此刻真的会发出的内容。

本轮不宣称把虞栖一次变成真人。它是可回归、可继续测评的小步更新，后续仍以真实聊天盲评和人工批注迭代。

## 2. 问题定义

现有 v3 已把 `interactionRead` 和 `selfResponse` 留在认知层，没有直接交给表达层，但认知层仍可能把私下判断重新写进 `interactionDecision.mustConvey`。表达层会把 `mustConvey` 当成必须说出口的内容，于是出现以下失败模式：

- 认知已经看出用户在试探、撒娇、嘴硬或求在场感；
- 表达却直接说“你其实是……”“我知道你是在……”；
- 回复像旁观者做心理分析，而不是虞栖顺着当下互动继续玩；
- 回复为了展示理解而过度完整，削弱自然停顿、含蓄和人物自己的态度。

根因不是单个禁词，而是“私下理解”与“公开台词义务”之间缺少清晰合同。

## 3. 方案比较

### 方案 A：只改提示词

在认知、表达和监督预设里强调不要说破。改动最小，但运行时没有明确可检查的接口，后续容易再次漂移。

### 方案 B：版本化预设 + 机器可见的表达披露策略（采用）

新增不可变预设版本 `2.1.1`，同时在 `2.1.1` 及之后的表达 brief 中加入闭合的 `disclosurePolicy`。认知预设规定 `mustConvey` 只能描述公开互动义务；表达预设规定理解用于决定回应、不是台词素材；高风险监督器收到同一策略并用既有 `DIALOGUE_META_NARRATION` 检查“急着证明懂了”。

该方案不改变 cognition/expression JSON schema，不迁移数据库，不增加普通回合模型调用，也不改变 `2.1.0` 已冻结行为。

### 方案 C：每回合新增语义监督模型调用

拦截更强，但会显著增加延迟、付费量和失败面。用户要求普通回复尽量在一分钟内，本轮不采用；若真实盲评仍频繁复现，再把它作为后续独立方案评估。

## 4. 权威边界

### 4.1 私下理解

以下内容只用于内部选择回应，不是表达层的台词素材：

- `interactionRead.primarySocialMeaning`
- `interactionRead.alternativeMeaning`
- `interactionRead.confidence`
- `selfResponse` 中的内部感受、欲望、抗拒和注意力

`compileExpressionBriefV3()` 必须继续不输出这些字段。

### 4.2 公开互动义务

`interactionDecision.mustConvey` 的语义收窄为“这一轮公开回应必须完成什么互动动作或立场”，而不是“必须说出的句子”或“对用户心理的诊断”。例如：

- 合法：顺着试探继续玩，同时给出一点可感知的在场回应；
- 非法：告诉用户她已经看出对方是在试探自己会不会离开。

表达层可以用调侃、停顿、回避一半、行动回应或一句短话完成公开义务，不得逐项复述 `mustConvey`。

### 4.3 披露例外

默认模式是 `implicit`。只有三类情形允许明确说出解释：

1. 用户直接要求虞栖分析、解释或确认她的理解；
2. 严肃关系修复必须说清误解，否则无法继续；
3. 安全、同意或边界需要明确表达。

即使进入例外，也只说解决当前互动所需的最少部分，不做完整心理复盘。

## 5. 运行时合同

当 pinned preset version 为 `2.1.1` 或同一主次版本的更高补丁时，expression brief 增加：

```json
{
  "disclosurePolicy": {
    "version": 1,
    "defaultMode": "implicit",
    "understandingUse": "guide_response_not_dialogue",
    "mustConveyUse": "public_interaction_obligations",
    "unaskedInterpretationLimit": 0,
    "explicitExceptions": [
      "user_requested_interpretation",
      "repair_requires_clarification",
      "safety_or_consent"
    ]
  }
}
```

`2.1.0` 及更早版本不得收到此字段，以维持已冻结 release 的输入形状。

高风险 lived-quality reviewer 收到同一个 `disclosurePolicy`。普通低风险回合仍不新增 reviewer 调用；本轮通过表达合同和版本化预设改善日常输出。

## 6. 预设版本与兼容性

- 不修改 `2.1.0` 的任何文件，避免已安装数据库发生 preset seed checksum 冲突。
- 新增 `2.1.1` cognition/expression/supervisor 模块；foundation、socialExperience、consolidation 复用 `2.1.0` 文件。
- `manifest.json` 注册 `2.1.1`，但不擅自改变稳定版 `currentVersion`。后续候选 release 显式 pin `2.1.1` 后才使用本行为。
- cognition/expression schema version 仍为 3；无数据库迁移、Android wire 变化或记忆格式变化。

## 7. 监督与返修

继续使用既有 `DIALOGUE_META_NARRATION`，不新增 finding code：

- 若 cognition 的 `mustConvey` 已把私下判断变成必须公开的诊断，owner=`cognition`；
- 若 cognition 决策合理但表达把理解讲成心理复盘，owner=`expression`；
- 返修必须保留虞栖的互动立场与回应动作，只删除“证明自己懂了”的解释冲动；
- 验收关注回复是否通过行为体现理解，而不是换一组分析同义词。

不得用关键词黑名单代替结构判断。现有内部政策泄漏的确定性规则保持不变。

## 8. 验收标准

1. `2.1.0` preset 内容和 expression brief 形状不变。
2. `2.1.1` expression brief 含精确闭合的 `disclosurePolicy`，且不含私下 `interactionRead`/`selfResponse`。
3. pinned `2.1.1` 的 expression 调用与高风险 supervisor 调用看到同一策略。
4. 低风险回合不增加模型调用；原有结构化动作、记忆、朋友圈、安排、主动聊天和 Android 协议不受影响。
5. 新预设明确约束 cognition、expression、supervisor 三层，并由 preset registry 测试锁定。
6. focused tests 与完整 `yuqi-runtime` tests 通过。

## 9. 非目标

- 不在本轮自动判断所有隐含心理解释；
- 不新增每回合监督调用；
- 不改模型与推理强度；
- 不改记忆模型、关系阶段、主动聊天、朋友圈、安排表或 Android；
- 不用本次实现替代后续真实聊天盲评。

