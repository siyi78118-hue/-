# AL 活人感综合预设完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两轮真人聊天训练结论写入实际运行的 AL 综合 RP 预设，并用契约测试防止分析腔与功能流水线回归。

**Architecture:** 保持现有单文件应用结构，直接重写 `RP_PRESETS.combined.prompt` 中冲突的规则段落。新增一个只读源码契约测试，从 `tavern-app/index.html` 提取综合预设并检查必需原则与废止规则，不引入运行时依赖。

**Tech Stack:** HTML 内嵌 JavaScript、Node.js `node:test`、`node:assert`。

## Global Constraints

- 第一轮与第二轮批注共同生效；冲突时以第二轮最终结论为准。
- 只修改综合预设，不改变聊天链路、后台任务、业务标签或 UI。
- 保持纯聊天输出和角色卡、阶段人设、自定义补充的现有组合方式。
- 不触碰工作区中与本目标无关的已有修改和未跟踪文件。

---

### Task 1: 建立综合预设契约测试

**Files:**
- Create: `tests/rp-preset-contract.test.mjs`
- Modify: `package.json`
- Test: `tests/rp-preset-contract.test.mjs`

**Interfaces:**
- Consumes: `tavern-app/index.html` 内 `RP_PRESETS.combined.prompt` 模板字符串。
- Produces: 可独立运行的 `node --test tests/rp-preset-contract.test.mjs` 契约测试，并接入 `npm test`。

- [x] **Step 1: 写失败测试**

测试从源码中提取综合预设，断言包含持续心情、情绪惯性自然衰减、允许无功能气泡、强禁分析骨架、纯网聊边界、隐性记忆和长中断重算状态；断言不再包含“先判断玩家这句话真正需要什么”“连续气泡必须各自带来新的信息”“每次回复至少要承接上一条的核心信息”。

- [x] **Step 2: 运行测试确认 RED**

Run: `node --test tests/rp-preset-contract.test.mjs`

Expected: FAIL，指出第二轮规则缺失或旧冲突规则仍存在。

- [x] **Step 3: 将专项测试接入完整测试命令**

在 `package.json` 的 `test` 脚本开头加入 `node --test tests/rp-preset-contract.test.mjs`，保留所有现有测试命令。

### Task 2: 手术式重写综合预设

**Files:**
- Modify: `tavern-app/index.html`
- Test: `tests/rp-preset-contract.test.mjs`

**Interfaces:**
- Consumes: 两轮训练批注和现有 `RP_PRESETS.combined.prompt`。
- Produces: 所有聊天场景通过 `buildCharPrompt()` 使用的新版综合预设。

- [x] **Step 1: 重写真人判断与气泡规则**

把功能分类式判断改为角色状态优先；加入持续心情、真实触发、允许废话与自然停顿；删除每个气泡必须有新功能的要求。

- [x] **Step 2: 重写情绪、记忆与时间规则**

加入跨轮情绪连续、随时间和生活衰减、隐性记忆、长中断重算状态、表面语义清楚和角色自身心情污染回复。

- [x] **Step 3: 加入高优先级去 AI 结构禁令**

明确禁止“先别……至少……”“那你是……还是……”、态度加理由、功能流水线、心理二选一和教材式修复，并加入训练确认的正反例。

- [x] **Step 4: 收紧能力与纯网聊边界**

禁止见面、约饭、送东西、接人、上门和线下跑腿承诺；保留线上陪伴与有限能力。

- [x] **Step 5: 运行专项测试确认 GREEN**

Run: `node --test tests/rp-preset-contract.test.mjs`

Expected: PASS。

### Task 3: 回归与差异审查

**Files:**
- Modify: `tavern-app/index.html`
- Modify: `package.json`
- Test: `tests/rp-preset-contract.test.mjs`

**Interfaces:**
- Consumes: Tasks 1-2 的预设和测试。
- Produces: 无冲突、可回归验证的最终修改。

- [x] **Step 1: 运行基础应用检查**

Run: `node test-basic.mjs`

Expected: `basic app checks passed`。

- [x] **Step 2: 运行完整测试**

Run: `npm test`

Expected: 全部测试退出码 0。

- [x] **Step 3: 检查目标差异和空白错误**

Run: `git diff --check -- tavern-app/index.html package.json tests/rp-preset-contract.test.mjs`

Expected: 无输出、退出码 0。

- [x] **Step 4: 对照两轮批注审查覆盖**

逐项确认第一轮的口语省略、独立生活、非自动共情、有限熟悉感，与第二轮的持续心情、非理性、反分析骨架、自然停顿、隐性记忆、时间流逝、能力和纯网聊边界均在实际预设中存在。
