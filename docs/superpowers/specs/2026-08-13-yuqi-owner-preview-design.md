# 虞栖第一版 Owner Preview 内测设计

## 1. 目标

将已经完成并经用户明确批准的 `2.1.1`“看懂但不说破”行为真实接入虞栖 Android 直接私聊，同时保留现有正式记忆、可一键回退，并且不把本人内测冒充成正式 shadow / canary 发布证据。

本轮交付是用户本人使用的第一版内测，不是面向其他用户的正式发布。

## 2. 已确认的数据事实

- 正式电脑记忆库位于 `C:\Users\PC\Documents\虞栖AL记忆库备份\database\yuqi-runtime.sqlite`。
- 只读核验时，库内存在 `1649` 条 `yuqi` 消息和 `1086` 条 `yuqi` 长期事实。
- 在临时克隆上执行 v14 → v15 后，两表数量不变，逐行 JSON SHA-256 也不变。
- Web 启动和每次直接/主动提交前会运行 `syncYuqiVisibleHistory()`；旧可见消息以稳定消息 ID、原角色和原时间写入 Android Room，FallbackJournal 再按游标同步给 PC，重复同步按消息 ID/checksum 去重。
- 内测安装必须是相同包名、相同正式证书的覆盖安装；不得卸载、清应用数据或更换签名。
- 用户已说明停机期间的空白无需虞栖解释；系统不补造消息，也不强迫虞栖主动提及时间间隔。

## 3. 方案比较

### A. 直接把全部十种功能切到新候选

体验覆盖最广，但会同时改变主动私聊、朋友圈、安排表和生活规划；本次修复只经过直接聊天人工判断，风险过大，不采用。

### B. 继续全量 shadow 72 小时

最符合正式发布闸门，但用户无法体验新回复，不能满足“第一版内测实装”，不采用。

### C. 独立 Owner Preview 通道（采用）

只允许 `DIRECT_REPLY` 使用候选 `2.1.1`。复用现有 active-canary 数据结构和前十次旧版后台 dry-run 对照，但增加明确的 `owner_preview` 证据类别和专用晋级入口。该证据不能用于正式晋级；正式发布仍必须走原 quality/shadow gate。

## 4. 模型与行为版本

Owner Preview 候选固定为：

```json
{
  "cognitionFast": "gpt-5.6-sol/medium",
  "cognitionDeep": "gpt-5.6-sol/xhigh",
  "expression": "gpt-5.6-sol/medium",
  "supervisor": "gpt-5.6-sol/medium"
}
```

预设固定为 `2.1.1`，cognition / expression schema 固定为 v3，supervisor 固定为 `lived-quality-supervisor-v3`。运行时必须从权威 release row 解析这四项，不能继续使用源码里的硬编码默认值；非法、缺失或超出闭集的模型/effort 必须在模型调用前失败并触发回退。

## 5. Owner Preview 权威合同

### 5.1 权限边界

- 仅 `DIRECT_REPLY` 可进入 Owner Preview。
- 只有候选处于 `shadow` 且报告为 materialized `promotion`、`sourceType=promotion_snapshot`、`summary.evidenceClass=owner_preview_v1` 时可进入。
- 报告必须绑定：用户授权标识、授权时间、源 git HEAD、稳定 release ID/checksum、候选完整 release/checksum、预设版本、四模型配置和内测范围。
- 专用方法把该 kind 原子转成现有 `active/canary`；其他九种 kind 不变。
- 原正式 `promoteCognitionCandidateInternal()` 必须拒绝 owner-preview 报告，防止内测记录冒充正式质量证据。

### 5.2 运行与回退

- 前十个 Owner Preview 私聊：候选结果可见，稳定版只做后台 dry-run 对照，绝不提交第二份消息或动作。
- 任何确定性/preset/pipeline 错误立即只回退 `DIRECT_REPLY`；新 turn 使用稳定版，已创建 turn 保持固定 release。
- 手工 rollback 继续使用现有 revision-CAS；不得直接 SQL 改 rollout。
- owner-preview 的 compare 结果只用于诊断和后续人工复盘，不计入正式 live-shadow 成功数。

## 6. 记忆与同步保护

内测部署按固定顺序执行：

1. 确认 PC runtime 已停止；
2. 对正式库做 SQLite `VACUUM INTO` 验证快照，并记录源库/WAL/快照 SHA-256；
3. 在快照克隆上先执行完整迁移、preset seed、candidate 注册和 preview 晋级；
4. 对克隆核对 messages/facts 的数量与逐行摘要；
5. 克隆通过后，才对正式库执行同一事务序列；
6. 正式库重开 invariant 通过后启动 runtime；
7. 真机覆盖安装后，先同步旧 Web 聊天，再允许第一条新消息；
8. 对比 Web 可见消息数、Android 新增/待同步数、PC 消息 ID/时间与重复数。

任何一步失败都停止，不安装 APK、不启动 runtime、不修改 rollout；已有快照保留用于恢复。

## 7. Android 内测包

- 版本升为 `1.0.109 (109)`，Web build 与 Service Worker cache 同步升版。
- 包名保持 `com.siyi.al`。
- 只接受正式证书签名；证书 SHA-256 必须与 1.0.108 的正式证书一致。
- 交付方式是覆盖安装；安装前后分别读取 package/version/cert，禁止 uninstall。
- 无真机时只能完成构建和静态验收，不能宣称旧 WebView 数据已在真机迁移成功。

## 8. 验收

1. 正式库迁移克隆前后 `1649` 条消息、`1086` 条事实逐行一致（若部署前有新增，以部署时重新读取的基线为准）。
2. `DIRECT_REPLY` 的新 turn 固定 candidate `2.1.1` release；其他九种 kind 仍固定原 stable release。
3. 四个模型调用与 release model profile 精确一致。
4. 2.1.1 expression brief 含 disclosure policy，2.1.0/旧 stable 不含。
5. 前十次 candidate 可见、stable dry-run，不产生双消息或双动作。
6. 确定性失败与手工 rollback 后，新 direct turn 回到 stable。
7. APK 包名、109 版本、正式证书、APK SHA-256 全部通过。
8. 真机覆盖安装后，旧聊天仍可见；同步不改变原时间、不重复插入；第一条新聊天的 cognition 输入可检索到旧消息与长期事实。

## 9. 非目标

- 不启用主动聊天、朋友圈、安排表、关系阶段写入或生活规划的新候选；
- 不跳过正式质量闸门，不把 owner-preview 计作正式发布证据；
- 不解释停机空白；
- 不清空或重新生成旧记忆；
- 不在无设备证据时宣称真机迁移完成。

