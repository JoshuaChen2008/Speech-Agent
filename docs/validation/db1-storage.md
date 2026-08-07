# DB1 字幕事实原子与幂等门禁

> 状态：**DB1 联合验收完成**；DB6 只有 schema/RPC 局部证据，不属于本报告的验收结论
> 日期：2026-07-31
> 规范：SEM-F02 / SEM-F03 / SEM-F04 / SEM-F07 / SEM-F14 / DB1 / DB6

## 结论

生产 `StorageWorkerHost` 已在 Electron 43.2.0 中 fork 真实 utility process，
经 `WorkerService` 串行调用 `SqliteSubtitleStore` 与隔离的文件 SQLite。旅程按
顺序建立 loopback 与 mic 两个互斥会话，写入 final/refined/迟到低修订，
验证重复、冲突、关闭后写入、当前投影、会话隔离、checkpoint 与自然退出。

结构化证据：[`db1-storage-results.json`](db1-storage-results.json)

Windows CI 每次都会动态重跑同一 Electron 组合并验证生成报告，不只读取本机
证据。数据库局部测试另用真实临时文件在事件插入后、投影更新后以及 commit
后回复前注入故障，证明前两者整事务回滚，后者以稳定事件身份重试只得到一份
事实和一份投影。

## 安全与边界

- 字幕事实只接收 `final/refined`；`partial/translated` 均拒绝。
- `eventId` 由 worker 按 `sessionId/sourceId/sequence` 稳定派生，不包含正文；
  同身份不同载荷返回冲突，不能被 `ON CONFLICT DO NOTHING` 吞掉。
- `requestId` 只做传输关联；open/caption/close 使用独立业务幂等键。
- worker 协议白名单拒绝 SQL、任意数据库路径、`audioPath`、samples 等额外写入
  字段；真实 utility process 组合旅程也动态发送并拒绝带 SQL/音频字段的字幕，
  未知异常只返回固定错误，不回显正文或本地路径。
- 当前产品组合根仍使用 JSONL。SQLite 产品接线、stop/quit durable barrier、
  worker 自动恢复、JSONL 迁移/cutover 和历史 UI 分属后续阶段；本报告明确将
  它们标为 false。
