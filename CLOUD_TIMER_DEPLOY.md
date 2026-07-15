# AL 云闹钟部署

当前云端 Worker 版本：`2026-07-15.15`

## 部署

先在当前终端设置 Cloudflare API Token：

```powershell
$env:CLOUDFLARE_API_TOKEN="你的 Cloudflare API Token"
```

然后部署：

```powershell
npm run cloud:deploy
```

如果希望部署后自动检查线上版本：

```powershell
$env:AL_TIMER_ENDPOINT="https://你的-worker地址"
npm run cloud:deploy
```

如果只想直接调用 Wrangler 原始命令：

```powershell
npm run cloud:deploy:raw
```

## 检查

部署后检查 `/health` 返回版本是否一致：

```powershell
npm run cloud:health -- https://你的-worker地址
```

也可以在 AL 设置页点击“检测云端 Worker 版本”。

## 需要的 Cloudflare 配置

- KV binding：`AL_TIMER_KV`
- Secret：`VAPID_PRIVATE_JWK`
- Vars：`VAPID_PUBLIC_KEY`、`VAPID_SUBJECT`
- Cron：每分钟一次，`* * * * *`

## 任务核验

前端安排私聊/朋友圈闹钟后，会调用 `/job-status` 直查当前 `jobId`：

- `job=存在`：云端 KV 里有这个任务。
- `bucket=存在`：任务已放入对应分钟桶，Cron 才能扫到。
- `push=存在`：设备推送订阅仍在云端。

这三个任意一个缺失，设置页都会显示云端任务异常。

## 紧急清理自动任务

诊断页的“紧急清空全部自动任务”会调用：

```http
POST /cancel-device-tasks
Content-Type: application/json

{"deviceId":"当前设备 ID"}
```

Worker 只清理该设备的 `mom_` 朋友圈任务、`pro_` 主动私聊任务，以及所有 `due:` 桶中指向这些任务的引用。接口会遍历 KV 分页，因此也能清理超过单页数量的任务和已失去 `job:` 本体的孤儿引用。

以下数据不会被删除：

- `sub:<deviceId>` 推送订阅，重新开启主动消息和云闹钟时无需重新绑定。
- 其他设备的任务和到期引用。
- `test_` 开头的手动测试任务。
- 聊天、角色、记忆、API 配置等不存放在云闹钟 Worker 中的应用数据。

成功响应会分别返回已删除的朋友圈任务数、主动私聊任务数、到期引用数和空桶数，并用 `subscriptionPreserved` 明确报告订阅是否仍然存在。重复调用是安全的：没有残留任务时，各删除计数返回 `0`。

## Cron 核验

云端 Cron 每分钟运行后，会写入 `meta:lastCron`。`/health` 会返回最近一次 Cron 的执行摘要：

- `Cron：暂无执行记录`：Worker 已部署，但 Cloudflare 定时触发还没跑过，或 Cron 没配置成功。
- `任务 0`：Cron 正常跑了，但当分钟桶里没有到期任务。
- `成功 1`：Cron 找到任务并成功发出 push。
- `重试/失败`：Cron 找到任务，但推送失败或需要下次重试。
