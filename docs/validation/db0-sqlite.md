# DB0 SQLite 开发态资格报告

> 状态：**本报告冻结开发态证据；B5 后 DB0 开发态与 ASAR 打包态资格均通过**
> 日期：2026-07-31  
> 规范：SEM-F07 / SEM-F14 / SEM-T03 / DB0 / DB6

## 结论

Electron 43.2.0 的 utility process 已成功加载内置 `node:sqlite`（Node
24.18.0 / SQLite 3.53.1），并在隔离的 smoke `userData` 中对真实数据库文件
验证 WAL、迁移、双连接隔离、会话来源不可变、事务回滚、事件/投影同事务提交、事件不可变触发器、checkpoint、
关闭重开和 `integrity_check`。worker 收到关闭确认后自然退出，exit code 为 0；
整个入口没有创建 `BrowserWindow`。

结构化证据：[`db0-sqlite-development-results.json`](db0-sqlite-development-results.json)

本结果只冻结开发态首选驱动与基础 schema。B5 随后已从真实 packaged exe
在 ASAR 内 fork storage utility，重跑同一 17 项资格，并取得 WAL、重开、integrity 与
exact-child `exitCode=0` 的结构化证据。因此 DB0 的开发态与 ASAR 打包态确定性资格
均已通过；精确 NSIS 在干净 Win11 中的发布环境验收仍属 I4，不反向改变驱动选择。
打包证据见 [`b5-packaged-product-results.json`](b5-packaged-product-results.json) 与
[`b5-packaged-exit-results.json`](b5-packaged-exit-results.json)。

Windows CI 不是只读取本机留档：每次运行都会执行
`scripts/db0-sqlite-smoke.js`，让 Electron main fork 真实 storage utility
process，并用 `scripts/verify-db0-report.js` 校验本次动态报告；SQLite 与进程
边界均不使用 mock。

## 验证边界

- 真：Electron utility process、真实文件 SQLite、实际 migration checksum、
  WAL、两连接读写可见性、事务与重开恢复。
- 假：没有 mock SQLite、没有内存 Map、没有 renderer SQL。
- 隔离：数据库位于 `.artifacts/db0-live` 下的独立 `userData`；不读取或修改
  正常产品用户数据。
- 隐私：schema 没有 BLOB、PCM/WAV、录音或音频路径列；报告不含绝对路径、
  现场音频或用户字幕正文。

## 安全复跑

PowerShell 必须等待 Electron 与 utility worker 自然退出，并保持窗口隐藏：

```powershell
Start-Process -FilePath .\node_modules\electron\dist\electron.exe `
  -ArgumentList 'scripts/db0-sqlite-smoke.js','--report','docs/validation/db0-sqlite-development-results.json','--work-dir','.artifacts/db0-live' `
  -Wait -PassThru -WindowStyle Hidden
```

不要用 `electron.exe --help` 或在验证仍运行时杀死 Electron 进程；它们不属于
本探针，并可能触发 Windows 应用程序错误弹窗。
