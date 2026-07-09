# AL 云闹钟部署

当前云端 Worker 版本：`2026-07-09.3`

## 部署

先在当前终端设置 Cloudflare API Token：

```powershell
$env:CLOUDFLARE_API_TOKEN="你的 Cloudflare API Token"
```

然后部署：

```powershell
npm run cloud:deploy
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
