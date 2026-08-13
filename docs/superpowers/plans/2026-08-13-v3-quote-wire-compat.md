# v3 引用消息传输兼容实施计划

> 设计依据：`docs/superpowers/specs/2026-08-13-v3-quote-wire-compat-design.md`

## Task 1：红灯固定真实故障

修改：
- `yuqi-runtime/test/direct-reply-v3-features.test.mjs`
- `test-basic.mjs`

加入 `quote:null`、旧 UI 引用快照、畸形引用和 Web 首次发送/重试规范投影测试；先运行并确认旧实现失败。

## Task 2：实现单一兼容与投影边界

修改：
- `yuqi-runtime/src/protocol.mjs`
- `tavern-app/index.html`

PC 将两种已部署旧形态严格归一化；Web 增加一个 UI quote → wire quote helper，无引用时省略字段，首次发送和重试共用它。

## Task 3：验证与恢复现场

依次运行：

```powershell
node --test yuqi-runtime/test/direct-reply-v3-features.test.mjs
node test-basic.mjs
npm.cmd test
```

随后使用项目已有停止/启动脚本重启 PC runtime。确认健康检查正常、云端待处理消息消失，并在本机持久库中找到原 turn；不手工删除或 ACK 云端记录。
