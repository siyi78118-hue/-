# AL 手机数据完整恢复设计

## 目标

在现有 1.0.121 已恢复虞栖私聊纯文本的基础上，完成一次证据优先、可回滚的完整恢复：永久删除用户已主动删除的许弥；将仍有可靠副本的虞栖角色资料、聊天结构、记忆、安排表、朋友圈、玩家资料和设置一次性接回当前应用；明确记录确实没有副本、无法恢复的字段。

本设计不得把推测数据伪装成原数据，不得因为手机原生数据库体积较大就假定所有 Web 数据仍有副本，也不得覆盖当前已经恢复成功或后来新产生的数据。

## 已确认事实

- 手机原生 Room 数据库仍可读，盘点显示角色 `yuqi` 有 1759 条 raw message，角色 `char_1783694247588_zojx`（许弥）有 0 条 raw message。
- 1.0.121 已把可校验的原生 raw message 恢复为 Web 私聊纯文本，角色头像和完整角色卡没有恢复。
- 用户明确确认许弥是此前主动删除的角色，并要求永久删除、以后不得再次恢复。
- 当前原生恢复候选包含角色快照中的角色 ID、名称、玩家名、执行系统提示词和创建时间；现有 Web 恢复实现没有把执行系统提示词当作可编辑角色卡使用，这是正确的安全边界。
- 原生数据库另有 turn、reply part、memory record、role plan、snapshot、authority、annotation 等结构；它们是否能无损投影到 Web 必须逐类验证。
- 原始角色头像使用 `avatarData` 存在 Web 状态中，原生角色快照不保存头像图片字节。

## 恢复原则

1. **删除权威优先。** 许弥先建立正式 `role_delete_v1` 删除权威并完成清理；恢复候选、旧镜像、导入和迟到消息都不得再复活她。
2. **来源有序。** 同一字段按“当前有效 Web 状态 → 恢复前事务快照 → 旧版 Web 槽位 → IndexedDB app_state 镜像 → 原生 Room 权威记录 → 程序冻结的虞栖默认资料”选择。后级不得覆盖前级更完整数据。
3. **只恢复可证明数据。** 每个原生投影必须有闭集结构、稳定身份、来源校验值和分页一致性；无可靠来源的字段进入缺失清单。
4. **原子提交。** 先生成候选与完整性报告，再在恢复事务中合并；校验、写入或镜像更新任一步失败都回滚到恢复前状态。
5. **幂等与去重。** 重复运行恢复不得增加重复角色、消息、朋友圈、记忆、安排或动作。
6. **不破坏运行配置。** API 密钥、桥接配置、云闹钟绑定、原生游标和已恢复后的新聊天不被旧快照回写。

## 来源盘点与恢复范围

### 1. 删除权威

为许弥创建正式角色删除控制，沿现有备份、持久控制、PC 应用和原生 tombstone 链完成永久删除。若 PC 暂时不可达，角色立即进入冻结的删除等待态：不显示为可聊天角色、不接收迟到写入、不进入恢复候选；待控制完成后清理原生语义数据并保留 tombstone。

禁止用“rawMessageCount 为 0”作为通用自动删除规则。许弥的永久删除只基于本次用户明确确认及其稳定 characterId。

### 2. 虞栖角色资料与头像

角色字段分两类：

- Web 原始字段：`avatarData`、description、personality、scenario、firstMessage、mesExample、systemPrompt、postHistoryInstructions、tags、creatorNotes 和阶段展示配置。优先从当前状态、恢复前快照、旧槽位、IndexedDB 镜像读取。
- 程序内置虞栖资料：若 `characterId === "yuqi"` 且 Web 原始角色卡确无副本，可用当前冻结的 `YUQI_FIRST_PROFILE` 补齐基础 description/personality/scenario/tags；不得用原生 compiled systemPrompt 覆盖可编辑角色卡字段。

头像只接受有明确归属的原始 data URL/blob。若所有 Web 来源都没有图片字节，保持首字头像并在报告中标记 `avatar_bytes_missing`，不得生成或替换成相似图片。

### 3. 聊天与富结构

- raw message 是基础时间线，保留 1.0.121 已恢复的消息。
- reply part、turn envelope 和已验证 authority projection用于补充多气泡身份、类型、顺序、引用、附件和结构化动作；仅在能与同一角色、turn、message 或 group 权威闭合时合并。
- 同一消息以稳定 message ID 为主键；内容或来源校验值冲突时 fail-closed，不覆盖现有消息。
- 已删除、redacted、skip 或 action-only 结果遵守原终态，不被恢复成普通文本气泡。

### 4. 记忆

原生 `memory_records` 逐行输出闭集字段与 checksum，并投影到 Web 的 summaries/events/profiles/vectors。恢复器验证 characterId、sourceKey、type、时间、内容和向量结构；同一稳定身份合并，现有人工编辑记录优先。

若原生 memory 与 Web MemoryDB 不能建立无损类型映射，该行不写入 Web，只留在原生库并进入 `native_only_memory` 报告，运行时仍可继续使用原生事实源。

### 5. 安排表与生活计划

从原生 `role_plans` 和 `role_plan_history` 读取已经持久化的 `planJson/historyJson`，验证角色归属、稳定 ID、状态和时间后交给现有 RolePlanRepository 合并。恢复不得重新创建已取消、已完成或已删除计划，也不得因导入触发重复闹钟；恢复提交成功后只执行一次统一 reschedule。

### 6. 朋友圈与结构化动作

朋友圈只从仍存在的 Web/mirror 数据或原生已验证的 moment action、moment turn、annotation/projection恢复。普通私聊文本不能推导成朋友圈。评论、点赞和回复必须绑定确定的 momentId/commentId；无法闭合目标的动作列入缺失报告。

### 7. 玩家资料与全局设置

玩家头像、昵称和 Web 展示设置优先从恢复前快照、旧槽位和镜像恢复。原生 snapshot 的 playerName 只在 Web 昵称缺失时补齐。安全配置、桥接地址、密钥、云绑定和版本状态以当前原生安全存储为准，旧 Web 快照不得覆盖。

## 完整性报告

恢复前生成 metadata-only 报告，按角色和类别记录：

- 原生/镜像/旧槽位发现数量；
- 可校验候选数量；
- 已存在数量；
- 将新增、将补全、冲突、缺少副本数量；
- 头像、角色卡、消息、富结构、朋友圈、记忆、安排表、玩家资料和设置各自状态。

报告不得包含聊天正文、角色提示词、头像 data URL、API key 或向量内容。恢复后使用同一口径复算，只有所有可恢复候选均为 `restored` 或 `already_present` 才显示“完整恢复已完成”。

## 原子恢复流程

1. 只读读取所有来源并冻结普通写入。
2. 验证许弥删除目标身份并建立删除权威；把她从恢复候选中永久排除。
3. 为虞栖生成按来源优先级合并的完整候选和 metadata-only 完整性报告。
4. 将恢复前 Web 原始槽位、镜像和恢复报告写入独立 journal。
5. 分阶段写入角色、聊天/动作、朋友圈、MemoryDB、RolePlanRepository；每阶段重读并重算 checksum。
6. 更新 app_state 镜像与恢复 journal 为 committed。
7. 解除冻结，统一刷新角色目录、聊天、朋友圈、记忆、计划和闹钟。
8. 复算恢复后报告；若任何阶段失败，在解除冻结前整体回滚。

许弥的远端删除控制可能独立等待 PC 应用，但本地冻结和 tombstone 意图必须在完整恢复提交前持久化，确保她不会再次出现。

## 错误处理

- 数据冲突不静默选边，保持原数据并显示稳定错误码。
- 读取分页过程中数据库变化时整类重读，不能混合两个快照。
- 无法恢复头像等 Web-only 字节不算恢复事务失败，但必须明确计入 `no_verified_source`。
- 删除控制失败时不得把许弥恢复为正常角色；保持删除等待态并继续阻断其语义写入。
- 原生投影错误不得回退到未经验证的 raw JSON 或 compiled prompt。

## 测试与交付门

- Web 单测：来源优先级、虞栖默认资料补齐、头像只从可靠字节恢复、富消息去重、朋友圈目标闭合、恢复事务逐边界回滚、重复恢复幂等。
- 删除测试：许弥的明确删除意图持久化；当前状态、镜像、旧槽位和原生快照均不能复活；迟到 LAN/cloud/native/UI 数据被抑制。
- Android Room 测试：memory/role plan/reply part/moment evidence分页投影零写、checksum、重启稳定、角色 tombstone 过滤和并发快照检测。
- 集成测试：1759条虞栖消息基线不减少不重复；恢复后当前新消息仍保留；设置与安全配置不倒退；计划只重排一次。
- 完整项目门：Web focused、Android unit、`assembleDebugAndroidTest`、`npm test`、`git diff --check`。
- 无连接设备时可以证明代码、迁移和测试 APK 构建通过，但不得声称真实手机数据已全部恢复；最终真实验收以手机完整性报告为准。

## 完成定义

- 许弥不再显示且以后恢复不会复活，删除控制最终为 applied 或明确显示等待 PC；
- 虞栖所有有可靠副本的数据已恢复或已存在；
- 所有没有可靠副本的字段在报告中逐项列出；
- 当前聊天、原生数据库、安全配置和恢复后新数据均未损坏；
- 重启和重复执行不会改变恢复结果。
