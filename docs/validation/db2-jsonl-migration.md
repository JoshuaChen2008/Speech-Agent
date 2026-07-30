# DB2 JSONL 迁移实现资格

> 状态：**实现完成 / 尚未产品验收**
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

## 尚未证明

- 真实 `StorageWorkerHost → Electron utilityProcess` 执行迁移操作。
- 默认 `main.js` 的冷启动迁移、stale-active 恢复、`before-quit`、一次性
  SQLite 权威切换和「切换后不双写」。
- 历史窗口/导出 UI、打包态迁移、两小时长稳和完整 DB6/I4 数据目录审计。

上述项目继续阻断完整 J10 和字幕 MVP；本阶段不实现 Agent、翻译、
原始音频保存、FTS 或向量。
