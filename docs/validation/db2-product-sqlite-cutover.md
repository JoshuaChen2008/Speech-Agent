# DB2 默认产品 SQLite 切换资格

> 状态：**本报告阶段实现完成；后续开发态与 packaged 产品联合验收已完成，发布实机 I4 待验**
>
> 日期：2026-07-31
>
> 规范：SEM-F02 / SEM-F03 / SEM-F04 / SEM-F07 / SEM-F12 / SEM-F14 / SEM-T02 / SEM-T04 / SEM-T08 / DB2 / J1 / J2 / J10 / J12

## 结论

默认 `main.js` 不再创建 `TranscriptStore` 或
`SessionTranscriptRecorder`。`SubtitleApplicationRuntime` 是唯一产品组合根，
启动顺序固定为：

1. 取得 Electron 单实例锁，避免两个产品实例同时持有字幕库。
2. 启动 `StorageGateway` 的唯一 storage worker。
3. 把上次进程遗留的 `active` 会话原子收束为 `interrupted`。
4. 从只读 `userData/sessions/*.jsonl` 幂等迁移旧档。
5. 创建 `SqliteSessionRecorder` 并作为 `SessionCoordinator.persistenceSink`。
6. 新会话只写 `userData/data/speech-agent.sqlite3`。

`before-quit` 会阻止应用立即退出，先停采集、接受 stop 边界字幕、等待
caption/close ACK、关闭 storage worker，再二次 `app.quit()`。超过有界时限时只
终止该运行时精确持有的 worker，不按 `electron.exe` 进程名批量结束；下次冷启动
会把未能关闭的活动会话标记为 `interrupted`。

## 联合旅程证据

`test/integration/product-sqlite-lifecycle-journey.test.js` 使用真实生产模块：

`SubtitleApplicationRuntime → JsonlSqliteMigrator → StorageGateway →`
`WorkerService → SqliteSubtitleStore → 文件 SQLite → SqliteSessionRecorder →`
`SessionCoordinator → FakeRuntimeAdapter`

只把 Electron `utilityProcess` 替换为 service-backed host；设备与 ASR 文本属于
已有 I2/CaptionEvent 契约边界。旅程围绕同一 userData 连续运行两次冷启动：

- 预置 crash 遗留 active 会话与旧 JSONL；先恢复 interrupted，再迁移。
- mic 会话只激活 mic，partial 不落盘，final/refined 留下一个当前投影。
- 活动会话随应用退出写成 interrupted，数据库不留 active 会话。
- 第二次启动对同一 JSONL 返回 `already_processed`，再单独运行 loopback。
- 最终只有一条 migration audit；没有新 JSONL、PCM、WAV 或音频路径。

局部失败回归另覆盖 stale recovery 事务回滚、未知 ACK 的 Gateway 重放、迁移
失败时终止唯一写者，以及退出超时时强制终止并 dispose coordinator。

## 本报告阶段尚未证明（后续状态）

- 默认产品窗口通过真实 Electron `utilityProcess` 执行冷启动 import 与退出屏障：后续开发态
  与 packaged 首启/离线复启旅程已关闭。
- 当前用户截图中的 `electron.exe 0x80000003` 属于本项目的哪一个进程角色；现有
  Windows 事件与 dump 没有匹配证据。
- SQLite 历史列表、带时间戳文本复盘与 txt/md/srt 导出 UI：后续 205 段有界分页与三格式
  完整导出已关闭；真实 OS 保存弹窗仍归 I4。
- packaged Electron 内旧 JSONL import/二次启动：后续已关闭。I3 非音频 3,600 段预资格已
  通过；真实两小时声源与 I4 干净 Win11 安装旅程仍待。

因此原阶段结论只限制该时点；当前 J1/J2/J10 的确定性产品/打包门禁已通过，但真实音频
I2/I3 与干净机 I4 未通过前，仍不能标记字幕 MVP 发布验收完成。
