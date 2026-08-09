# ADR 0001：SQLite 作为唯一权威会话存储

- 状态：已决定
- 日期：2026-07-30
- 决策者：项目负责人
- 替代：`PLAN.md` Rev.3 中“JSONL，不上数据库”的决定
- 范围修订：[ADR 0002](0002-separate-subtitle-and-agent-systems.md) 将 `translated`、Agent outbox 和向量索引移出字幕事实与字幕 MVP；SQLite 单一权威、append-only 字幕事件、segments 投影、单写者和 JSONL 迁移决定继续有效。
- 局部替代：[ADR 0004](0004-immutable-first-pass-and-optional-refinement.md) 将首次 `final` 冻结为权威原始转写，并把 `refined` 移为独立可选派生版本；本 ADR 的 SQLite 单一权威与 append-only 原始事实决定继续有效。

## 背景

当前 B3.1 已实现 append-only JSONL，会话恢复和导出已可用。后续能力需要同时支持历史查询、会后纪要、全文检索、可选向量检索、失败重试以及多个派生视图；继续让各模块分别读取和改写 JSONL，会产生双重折叠、跨文件查询和派生产物/索引一致性问题。

选择存储方案时需要保留现有事件语义：一遍定稿不能因后续精修丢失，迟到与重试不能制造重复正文，Agent 或向量能力失败不能影响本地字幕。

## 决策

1. 以应用私有的单个 SQLite 数据库作为会话、字幕事件和派生任务的唯一权威持久化载体。
2. 字幕仍采用 append-only 事件语义；只有 `final/refined` 作为字幕不可变事实写入，当前段落由投影按修订规则得到，不把一段字幕压成可随意覆盖的单行事实。`translated/enhanced/summary` 按 ADR 0002 进入独立 Agent 派生表。
3. 使用单写者 `storage-worker` 拥有数据库连接；Electron 主进程和 renderer 不直接执行同步 SQL，也不直接加载向量扩展。
4. 使用事务将“字幕事件写入、当前段落投影更新”原子提交。Agent 可靠唤醒后续由 ADR 0008 冻结为终态会话 durable reconciliation；Agent job 创建失败不能回滚字幕事实。
5. FTS5 全文索引和后置的 `sqlite-vec` 向量索引都是可重建派生数据；它们不是字幕事实来源。`sqlite-vec` 只有 X1 启用后才固定版本、可信加载路径并执行打包门禁。
6. 原始音频现在及未来都不持久化；SQLite 不含音频 BLOB、录音路径或录音恢复元数据。
7. JSONL 在迁移后仅作为旧数据导入、显式导出和灾难恢复格式；不再与 SQLite 双写，也不构成第二权威来源。

## 结果

正向结果：

- 字幕短事务只原子提交会话/字幕事件事实与当前段落投影；Agent 输入与索引任务在提交后从这些事实按水位一致读取，不加入字幕事务。
- 历史、全文和向量检索不需要扫描多个会话文件。
- worker 崩溃后可从 SQLite 字幕事实恢复；Agent 任务按 ADR 0008 对终态会话执行 durable reconciliation，Agent/embedding 故障与实时字幕解耦。
- 向量模型或扩展升级时可以重建索引，而不触碰字幕事实。

代价与约束：

- 需要 schema migration、数据库备份/恢复和旧 JSONL 导入流程。
- SQLite 只有一个写者；所有写入必须经过 storage worker，长事务会成为全局瓶颈。
- `sqlite-vec` 尚需版本固定、Electron 打包加载、维度迁移和降级路径测试。
- SQLite 驱动属于实现选择，必须先在 Electron 43 的 utility process 中通过扩展加载、WAL、崩溃恢复和打包探针；更换驱动不改变本 ADR 的数据语义。

## 未选择的方案

- **继续只用 JSONL**：实现简单，但无法自然承担跨会话查询、事务 outbox 与多种派生索引。
- **可变 transcript 单表**：查询简单，但会丢失一遍定稿、迟到精修和审计事实，恢复时难以证明结果来源。
- **SQLite 与 JSONL 长期双写**：看似安全，实际上会产生两个权威来源以及不可判定的偏差恢复规则。
- **独立向量数据库**：增加部署、同步与隐私边界；当前本地单机规模不值得引入第二存储系统。

## 关联

- 数据设计：[`../data-architecture.md`](../data-architecture.md)
- 功能与验收语义：[`../semantic-contract.md`](../semantic-contract.md)
- 测试场景：[`../testing-strategy.md`](../testing-strategy.md)
