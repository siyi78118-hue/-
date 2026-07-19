# 虞栖专属线程失效自愈设计

## 问题与证据

手机消息已经通过云桥接进入电脑运行时，但最近任务在 `memory_running` 阶段失败。Codex App Server 对保存的记忆角色线程返回：

```text
thread/resume failed: no rollout found for thread id ...
```

这表示网络、云信箱和电脑运行时均已接通，失效点是本地数据库保存的 Codex 线程已经不存在。现有客户端只会恢复旧线程，不会在这个明确错误后创建替代线程，因此手机最终使用了内置聊天 AI 兜底。

## 选择的方案

采用自动自愈，并保留最后兜底：

1. 每个角色仍优先恢复数据库中保存的线程。
2. 只有 App Server 明确返回 `no rollout found for thread id` 时，才把该线程判定为永久失效。
3. 客户端立即为同一角色调用 `thread/start`，把新线程 ID 覆盖保存到同一角色会话记录。
4. 原消息继续在新线程执行，不要求用户重新发送。
5. 若新建线程或后续角色调用仍失败，沿用现有失败与手机聊天 AI 兜底机制。

## 安全边界

- 网络超时、App Server 未启动、登录失败、权限错误、模型错误和额度错误不得触发线程重建。
- 单个角色失效只替换该角色的线程，不修改另外两个角色。
- 现有 `roleThreadPromises` 继续合并同角色的并发恢复，避免一次故障创建多个新窗口。
- 不删除聊天、事实、预设、记忆、诊断或设备同步记录。
- 已经向用户显示过的兜底回复不再生成第二条可见回复；它仍按现有恢复流程补入专属记忆。
- 不改变 `gpt-5.6-sol`、`high` 思考强度和三个角色的严格输出结构。

## 代码边界

### Codex 客户端

在 `yuqi-runtime/src/codex-client.mjs` 中增加一个只识别明确失效响应的判断，并把“创建并保存角色线程”收敛为单一内部流程。`ensureThreadInternal(role)` 的外部接口保持不变。

### 测试 App Server

在 `yuqi-runtime/test/fixtures/fake-app-server.mjs` 中提供两种可重复响应：

- `thr_missing`：`thread/resume` 返回 `no rollout found for thread id thr_missing`。
- `thr_denied`：`thread/resume` 返回权限错误，用于证明非失效错误不会自动重建。

### 自动化测试

在 `yuqi-runtime/test/codex-client.test.mjs` 中证明：

1. 缺失线程会按 `thread/resume → thread/start → turn/start` 自愈，原请求成功，新线程 ID 被持久化。
2. 权限错误只执行 `thread/resume` 并向上抛出，不创建线程、不覆盖保存的 ID。
3. 现有正常恢复、新建、三角色隔离、模型与结构测试继续通过。

## 部署与恢复

1. 运行专属客户端测试和完整 `npm test`。
2. 在重启前调用现有记忆备份脚本，保留数据库快照。
3. 重启电脑端虞栖运行时，使新代码生效。
4. 通过一次受控角色调用验证缺失线程已自动替换，并确认 `/v1/health` 仍报告三个角色就绪、预设版本为 `1.1.0`。
5. 继续使用手机上已经安装的 1.0.70 进行端到端测试，并以回复来源记录确认结果为 `lan` 或 `cloud`，而不是 `fallback`。本次修复只改变电脑运行时，不需要再次更新 APK。

## 成功标准

- 旧 Codex 线程被清理后，用户发送的同一条消息可以自动转入新建的专属角色线程。
- 手机不因 `no rollout found` 直接调用聊天 AI。
- 无关错误不会造成线程风暴或丢失既有会话映射。
- 下一次手机测试的回复来源明确为桥接链路。
