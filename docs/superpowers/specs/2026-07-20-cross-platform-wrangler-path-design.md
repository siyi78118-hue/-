# Wrangler 跨平台路径修复设计

## 目标

让 `resolveWranglerInvocation` 按目标平台生成 Wrangler CLI 路径，使模拟 Windows 的测试在 Windows 与 Linux 构建机上得到相同结果，并恢复正式签名 APK 的 GitHub 构建。

## 范围

- 修改 `scripts/wrangler-invocation.mjs` 的路径拼接方式。
- 保留现有 Windows 行为：优先使用本地 `node_modules\wrangler\bin\wrangler.js`，通过当前 Node 可执行文件启动且不启用 shell。
- 保留非 Windows 行为及现有回退逻辑。
- 不修改聊天、记忆、角色预设、前端界面、移动端数据结构或 APK 包名。

## 设计

函数已经接收可注入的 `platform`，因此路径实现也应服从该目标平台，而不是服从运行测试的宿主平台：

- `platform === 'win32'` 时使用 `node:path` 的 `win32.join`。
- 其他平台使用 `node:path` 的 `posix.join`。
- `fileExists` 继续接收最终生成的路径，现有依赖注入和回退行为保持不变。

## 错误处理

若目标平台对应的本地 Wrangler CLI 不存在，继续执行原有的 `WRANGLER_CMD` 或系统 Wrangler 回退；本次修复不新增静默降级。

## 验证

1. 先使用 GitHub 第 69 次构建中已经失败的 Windows 路径测试作为 RED 证据。
2. 完成最小实现后单独运行部署契约测试。
3. 运行完整 `npm test`。
4. 推送后等待 GitHub 正式签名构建成功。
5. 下载 APK，确认包名为 `com.siyi.al`、版本高于 68，且签名 SHA-256 与现有 1.0.68 的 `5761277e3bdf4a64236c3bad569de6a07666581f643167d01e37f13e9e832b2b` 完全一致。

## 成功标准

新 APK 能在保留 1.0.68 应用数据的情况下直接覆盖安装，并包含已提交的新 UI 与重试修复。
