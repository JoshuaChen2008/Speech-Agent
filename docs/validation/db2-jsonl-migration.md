# DB2 JSONL 迁移实现资格

> 状态：**联合验收完成**；本文保留 DB2 阶段证据，后续默认产品与 packaged J10 旅程已补齐验收边界
>
> 日期：2026-07-31
>
> 规范：SEM-F03 / SEM-F04 / SEM-F05 / SEM-F07 / SEM-F14 / SEM-T02 / SEM-T04 / SEM-T08 / DB2 / J10 / J12

## 结论

`test/integration/jsonl-sqlite-migration-journey.test.js` 在每次 CI 中重新创建旧
JSONL fixture 和真实文件 SQLite，经过生产
`JsonlSqliteMigrator → StorageGateway → WorkerService → SqliteSubtitleStore`
执行迁移。进程边界用 service-backed host 替代，所以这是多模块确定性
CI，不是 Electron utility-process 实机证据。

单个文件的 session、不可变字幕事实、segment 当前投影和
`legacy_imports` 共用一个事务。第二文件在 audit 前故障时，已完成的
第一文件保留，故障文件的四类行全部回滚；Gateway retry 重放保留
队首后只生成一份事实、投影和 SHA-256 审计记录。

## 联合旅程已证明

- `final/refined` 按事件顺序导入，更高 revision 成为当前原文；原文当前
  投影与 txt/md/srt 导出 digest 在 JSONL/SQLite 两侧一致。
- 同一份不可变字节快照同时产生 SHA-256 和解析记录，避免两次读取之间
  文件被替换时出现「旧 SHA / 新正文」；同一源文件 SHA-256 重跑只返回
  `already_processed`，不新增事实、segment 或审计副作用。
- 缺少 `session.close` 的有效原文会话以最后字幕时间收束为
  `interrupted`；已关闭会话后的伪字幕不会被接受。
- 完整的坏中间行与未换行截断尾分开计数；未知事件、跨会话记录和
  错乱会话生命周期 fail closed。
- 遗留 `translated` 与 `partial` 不进入 SQLite 字幕事实或任何原文 digest；
  translated-only 和空文件只留下 `skipped` 审计，原 JSONL 字节不变。
- SQLite 投影使用整数毫秒；旧事件时间必须能从「秒 → 整数毫秒 → 秒」
  精确往返，不可无损表达的亚毫秒数值 fail closed，不会先取整再用取整值伪造
  digest 一致。
- worker 白名单拒绝 SQL、绝对路径、音频字段和 translated CaptionEvent；
  返回报告不含正文或本机绝对路径。

## 本报告阶段尚未证明（后续状态）

- 真实 `StorageWorkerHost → Electron utilityProcess` 执行迁移操作：后续开发态与 packaged
  产品旅程已关闭。
- 默认 `main.js` 的冷启动迁移、stale-active 恢复、`before-quit`、一次性 SQLite 权威切换
  和「切换后不双写」：后续默认组合旅程及同 userData 离线复启已关闭。
- 历史窗口/导出 UI与打包态迁移：后续已关闭；I3 非音频数据目录/资源预资格已通过，
  真实两小时声源和完整干净机 I4 仍待。

原阶段缺口曾阻断 J10；当前 J10 确定性产品/打包门禁已关闭。Agent、翻译、
原始音频保存、FTS 或向量仍不属于字幕 MVP。
