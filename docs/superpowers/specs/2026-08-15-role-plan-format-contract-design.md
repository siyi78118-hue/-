# 角色安排新版格式闭环设计

## 问题

2026-08-15 凌晨的直接回复在生成阶段已经得到正常聊天正文和一个未来私聊安排，但最终整轮以
`role plan confirmation authority conflict: time confidence is invalid` 失败。根因不是计划时间本身
不可用，而是各层对同一安排操作采用了不同合同：

- 生成提示只列出 `timeConfidence` 字段，没有说明其合法值及选择规则；
- cognition-v2 与 cognition-v3 只解析内部 JSON 和部分身份字段，没有验证完整新版操作；
- orchestrator 到最终确认阶段才要求 `timeConfidence` 精确为 `explicit|inferred`；
- store/Android 投影继续按严格新版格式工作。

因此旧形状可以穿过前半段，在接近提交时才失败，浪费模型调用并让正常回复长时间无结果。

## 产品边界

- 真正不合法的安排操作继续使整条结果失败，不能丢弃动作后发送可能虚假声称“已经安排”的正文。
- “明早”“待会”等自然时间允许虞栖选择具体执行时间，但必须明确标记为
  `timeConfidence: "inferred"`。
- 用户明确给出具体时间时使用 `timeConfidence: "explicit"`。
- 不在 store、wire 或 Android 端猜测、补写或宽松接受字段；所有下游只接收一种规范格式。
- protocol v1/v2 authority-v0 的既有对外字节行为不变。

## 唯一合同

新增一个纯、无持久化副作用的角色安排操作合同模块，负责：

1. 解析 `rolePlanOperationsJson` 或已解析数组；
2. 校验闭集操作名、字段名、原生类型、数量上限；
3. 校验 create/update 的 schedule 形状和时间；
4. 对所有携带新时间的 create/update 强制 `timeConfidence` 为原生字符串
   `explicit|inferred`；
5. 校验 evidence IDs 和已有 plan target 时接收调用方提供的权威集合；
6. 返回深拷贝的规范数组，调用方不能在验证后修改原对象影响提交。

该模块是 cognition-v2、cognition-v3、legacy release draft、canonical action builder 的共同入口。
store 仍保留独立的最终持久化不变量，形成前置合同与落库合同的双重校验，而不是第二种格式。

## 数据流

```text
模型输出
  -> 外层结构化 schema
  -> 共享角色安排合同（完整新版格式）
  -> 监督/表达
  -> canonical action builder（同一合同复核）
  -> store 严格提交
  -> bridge projector
  -> Android 新版动作
```

任何缺字段、旧别名、字符串强转、未知字段或非法 target 都在共享合同处拒绝，不能继续流到提交阶段。

## 生成端修复

- 主预设明确写出 `timeConfidence` 的两个且仅有两个值，以及显式/推断时间的选择规则。
- supervisor 也检查安排动作是否满足同一合同，不能批准缺字段的草稿。
- legacy release 的结构化输出重试把共享合同错误视为协议格式错误，使用现有有限重试重新生成；
  不增加无限循环或新的第五次模型调用。
- cognition-v2/v3 在 cognition 结果形成后立即调用共享合同；不再等到 visible commit 才发现格式问题。

## 兼容策略

- 不把缺失 `timeConfidence` 静默猜成 `inferred`，因为这会把明确时间错误降级为推断时间并改变
  用户确认语义。
- 不接受 `approximate`、`implicit`、大小写变体等别名；生产者必须经新版提示/有限修复输出规范值。
- 旧数据库中已经提交的 authority-v0 结果不重写；历史恢复继续走原路径。
- 尚未提交的新版 turn 恢复时重新经过相同共享合同，不能使用旧进程留下的半合法草稿绕过。

## 全仓残余检查

检查并锁定以下边界：

- brain/cognition/supervisor 的提示与输出 schema；
- cognition-v2、cognition-v3 内部 JSON 解析；
- legacy-v1、cognition-v2、cognition-v3 release adapters；
- orchestrator canonical action 与确认渲染；
- store action payload、bridge projector 与 Android action parser；
- 私聊、主动私聊、朋友圈、角色安排执行四类入口；
- 重启恢复和 retry 读取已持久草稿的路径。

残余旧格式只能存在于明确标注的 authority-v0 兼容分支，不能进入 authority-v1 canonical 提交。

## 验收

- 保存凌晨故障形状：有正常正文、create/once schedule、缺 `timeConfidence`；前置合同必须红灯，
  有限格式修复输出 `inferred` 后整轮成功提交。
- 明确具体时间使用 `explicit`；模糊时间使用 `inferred`；二者都产生真实安排。
- 缺失、错误类型、别名、未知字段、非法 schedule、foreign plan target 均整条拒绝且零提交。
- 同一坏格式不得先通过 cognition、后在 orchestrator/store 才失败。
- v1/v2 authority-v0 快照不变；canonical v3 的 store/bridge/Android 合同继续严格。
- focused tests、完整 Node 测试、Android JVM/编译门通过；有设备时补 connected instrumentation 门。

