# 虞栖旧稳定版与新版开发环境隔离设计

日期：2026-07-31
状态：用户已确认方案，等待书面规格复核
范围：PC 虞栖运行时、真实记忆库、开机自启、正式 APK 归档与新版开发数据库

## 1. 目标

建立两套物理和数据上相互隔离的程序：

1. **日常旧稳定版**：继续提供用户当前已经能够使用的虞栖功能，可随电脑关机、开机和运行时重启正常恢复。
2. **新版开发版**：继续承载 lived-agency v3 重构，但只能使用真实记忆库的克隆副本，不得迁移、写入或删除日常旧稳定版的数据。

完成隔离后，新版开发可以暂停数周，也不能影响旧版的被动回复、主动聊天、朋友圈、安排、生活、阶段、支付、媒体和手机投递。

本任务不继续 Task 10F，不启用 cognition-v3，不发布新 APK，也不改变用户当前可见的角色行为。

## 2. 已确认现状

- 当前监听 `0.0.0.0:17891` 的 Node 进程启动于 `2026-07-30 11:26:56 +08:00`。
- 该进程启动时仓库最新提交为 `6fcedec`，早于本轮 lived-agency v3 重构。
- 真实数据库路径为：
  `C:\Users\PC\Documents\虞栖AL记忆库备份\database\yuqi-runtime.sqlite`。
- 真实数据库 `PRAGMA user_version=9`。
- 真实数据库不存在 `constraint_records` 和 `visible_result_groups`，说明尚未进入 v10–v13 重构格式。
- 十个 rollout key 均为 `legacy`。
- Windows 启动目录中的 `虞栖AL自动启动.lnk` 当前指向开发工作区的
  `scripts\start-yuqi-background.ps1`。
- 当前开发工作区的 `YuqiStore` 构造器默认把 v9 数据库迁移到 v13，因此不能继续让开机自启指向该目录。

## 3. 采用方案

采用“冻结源码快照 + 独立稳定配置 + 开发克隆库 + 启动入口重定向”。

### 3.1 日常旧稳定版

本地目录：

```text
runtime-stable/
  yuqi-al-legacy-1.0.108/
    yuqi-runtime/
    scripts/
    package.json
    package-lock.json
    local/
      config.json
    stable-runtime-manifest.json
```

规则：

- 源码固定来自 Git 提交 `6fcedec`，不从当前工作树复制生产源码。
- `local/config.json` 是本机运行配置，不进入 Git，不进入可分享压缩包。
- 稳定版继续指向真实 v9 数据库。
- 稳定版启动前必须检查：
  - 源码清单与固定 checksum 相符；
  - 数据库仍为 v9；
  - v10+ 权威表不存在；
  - 端口没有被其他进程占用；
  - 配置没有指向开发克隆库。
- 检查失败时停止启动，不自动迁移或修复真实数据库。
- 稳定目录加入 Git ignore；新版任务不得修改该目录。

### 3.2 新版开发版

开发配置仍位于：

```text
yuqi-runtime/config.json
```

但其 `databasePath` 必须改为项目内的开发克隆：

```text
artifacts/yuqi-lived-agency-v3/dev-database/yuqi-runtime-dev.sqlite
```

规则：

- 开发克隆从隔离前的 v9 一致性快照产生。
- v10–v13 迁移、重放、红灯测试和调试只允许作用于开发克隆或测试临时库。
- 开发启动脚本保存一个受保护的真实数据库规范路径；发现配置仍指向真实数据库时必须拒绝启动。
- 新版代码、迁移脚本和中控任务不得接受真实数据库路径作为默认值。
- 开发版不得占用日常旧版的 `17891` 端口；需要人工运行时使用独立端口。

### 3.3 文件与 APK 备份

项目内归档目录：

```text
artifacts/stable-runtime/1.0.108/
```

包含：

- `yuqi-al-legacy-1.0.108-source.zip`：从 `6fcedec` 导出的无密钥源码归档；
- 当前正式 APK 的只读副本；
- `stable-runtime-backup-manifest.json`；
- 恢复说明。

清单至少记录：

- Git commit；
- 创建时间；
- 源码归档 SHA-256；
- APK 文件名、SHA-256、包名、versionCode、versionName；
- APK 正式证书 SHA-256；
- 真实数据库规范路径；
- 数据库备份文件名、SHA-256、schema version 和逐表 row count；
- 稳定运行时目录及启动脚本路径；
- Windows 开机快捷方式目标。

真实数据库一致性快照继续存放在现有记忆库备份区：

```text
C:\Users\PC\Documents\虞栖AL记忆库备份\snapshots\
```

使用 SQLite `wal_checkpoint(FULL)` 与 `VACUUM INTO` 生成，不直接复制打开中的 `.sqlite/.wal/.shm` 文件。

配置中的设备 token、加密密钥和云端凭据不得写入 manifest、Git、日志或源码压缩包。稳定版本地配置仅保留在本机忽略目录中。

## 4. 启动与数据流

### 4.1 开机启动

Windows `虞栖AL自动启动.lnk` 改为：

```text
runtime-stable/yuqi-al-legacy-1.0.108/scripts/start-yuqi-stable.ps1
```

启动顺序：

1. 读取稳定版本地配置。
2. 校验源码 manifest。
3. 只读检查真实数据库为 v9。
4. 对真实数据库创建启动前一致性快照。
5. 启动固定提交的 `yuqi-runtime/src/main.mjs`。
6. 等待 `/v1/health` 成功。
7. 写入稳定版 PID 和日志目录。

稳定版脚本不得引用开发工作区中的 `yuqi-runtime/src`、`store.mjs` 或 preset。

### 4.2 新版开发

新版中控与测试使用开发配置：

```text
开发代码 -> 开发 config -> 开发克隆数据库
```

旧稳定版使用：

```text
稳定快照代码 -> 稳定 local/config -> 真实 v9 数据库
```

两条路径不得共享：

- 数据库文件；
- PID 文件；
- stdout/stderr 日志；
- 端口；
- startup shortcut；
- 自动备份目的地。

## 5. 切换实施顺序

为避免先停止当前可用服务再发现稳定包无法运行，必须按以下顺序：

1. 记录当前服务 PID、端口、Git 基线、数据库 schema 和 rollout 状态。
2. 创建并验证真实数据库一致性快照。
3. 从 `6fcedec` 导出稳定源码快照和无密钥归档。
4. 复制本机运行配置到稳定版忽略目录。
5. 从数据库快照创建开发克隆，并把开发配置改指向克隆。
6. 使用开发克隆和临时端口对稳定源码执行一次 smoke start/health/stop。
7. 验证 smoke 运行没有修改真实数据库。
8. 停止当前旧进程。
9. 在正式端口启动独立稳定版。
10. 再次验证真实数据库仍为 v9、rollout 仍全 legacy。
11. 将开机快捷方式改指向稳定版。
12. 执行一次 stable stop/start 验证，并检查快捷方式目标。

在第 6 步通过前不得停止当前可用服务。

## 6. 验收条件

必须全部满足：

- 稳定源码来自 `6fcedec`，清单 checksum 可重算一致。
- 真实数据库存在一份经过只读复核的一致性快照。
- 真实数据库切换前后均为 `user_version=9`。
- 真实数据库没有 v10–v13 新表。
- 十个 rollout key 切换前后均为 `legacy`。
- 稳定版可在 `17891` 启动，`/v1/health` 成功。
- 稳定版停止后可以再次启动。
- 开机快捷方式目标位于 `runtime-stable`，不再位于开发脚本。
- 开发配置指向开发克隆数据库。
- 开发启动脚本面对真实数据库路径时明确拒绝。
- 开发 smoke test 不改变真实数据库 SHA-256、schema、table counts 或 WAL 状态。
- 正式 APK 的包名、版本、签名证书和 SHA-256 已记录。
- 日志、Git diff 和 manifest 不含 token、密钥或设备凭据。

## 7. 故障与回滚

### 稳定快照 smoke test 失败

- 不停止当前进程；
- 不修改开机快捷方式；
- 不修改真实数据库；
- 保留失败日志，修复稳定打包方式后重新 smoke。

### 正式端口启动失败

- 保持真实数据库 v9 不变；
- 使用已验证稳定目录和原本地配置重新启动；
- 若仍失败，恢复开机快捷方式备份，但禁止指回会自动迁移 v13 的开发入口；
- 用户手机可暂时使用 fallback，不能以开发版替代稳定版。

### 开发任务误指向真实数据库

- 启动 guard 在打开 SQLite 前拒绝；
- 记录不含密钥的错误；
- 不执行备份、迁移、PRAGMA 写入或 schema 检查后的修复。

### 将来正式升级

新版完成全部质量、功能、迁移和 APK 验收前，不得修改稳定版目录和真实 v9 数据库。正式升级必须另立任务，先生成新的数据库快照，再在克隆库完成迁移演练，最后由用户明确决定是否切换。

## 8. 非目标

- 不完成或修订 Task 10F。
- 不启用任何 v3 rollout。
- 不把半成品包装成正式更新。
- 不将旧数据库直接升级到 v13。
- 不删除当前 APK、旧源码、记忆快照或历史产物。
- 不改变虞栖当前人物表现。
