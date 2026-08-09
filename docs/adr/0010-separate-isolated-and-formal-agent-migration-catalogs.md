# ADR 0010：隔离候选库与正式 Agent 库使用独立迁移 catalog

- 状态：已决定
- 日期：2026-08-10
- 决策者：项目负责人
- 关联：[ADR 0001](0001-sqlite-authoritative-event-store.md)、[ADR 0007](0007-isolated-agent-core-mvp.md)、[ADR 0008](0008-terminal-session-agent-job-reconciliation.md)

## 背景

SEM-F29/J23 的隔离 Agent 内核开发入口已经用独立 userData、候选 SQLite 和候选 migration v3 形成联合证据。该 migration 只允许 `reference-structured-output` 插件、`reference-output` 任务和参考结构化产物，并已由既有数据库中的 migration checksum 锁定。正式 Agent 首版则需要 SEM-F28/J21/J24 的会后结构化纪要、个人记忆、增强文本、调试聊天、识别配置和确认关键词；直接修改候选 v3 会让既有候选数据库 fail closed，直接把候选 v3 追加到正式库又会把隔离参考语义带入产品数据模型。

## 决策

1. 字幕 schema v1/v2 抽成不可变的共享基础 migration catalog。
2. 隔离 Agent 内核开发入口继续使用“字幕基础 v1/v2 + 候选 Agent v3”；候选 v3 SQL、checksum、受限插件/任务/产物映射保持不变。
3. 正式产品数据库使用“字幕基础 v1/v2 + 正式 Agent v3”。正式 v3 只登记正式任务、产物、个人记忆、调试聊天、识别配置和确认关键词，不登记隔离入口的参考任务或参考产物。
4. 两个 catalog 可以各自拥有版本号为 3、但 checksum 不同的 migration，因为它们位于不同 userData/数据库根且从不互相打开。任一 catalog 打开另一 catalog 的数据库时必须因 checksum 不一致 fail closed；不得自动转换、跳过或重写 migration 历史。
5. 隔离开发数据不迁移到正式 userData。正式产品后续 schema 变化继续在正式 catalog 中追加 v4、v5；候选入口若仍需演进，则只在候选 catalog 中追加自己的后续版本。

## 结果

- 既有 SEM-F29/J23 候选证据和数据库保持可复现，正式 Agent 数据模型不继承参考任务的语义限制。
- 字幕 v1/v2 的 SQL 与 checksum 仍只有一份定义，正式 Agent migration 不改变字幕事实或字幕系统独立运行能力。
- catalog 身份成为数据库兼容边界；测试必须覆盖两个 catalog 各自升级成功和交叉打开失败。
- 正式 Agent 表由同一 storage worker、同一正式 SQLite 连接拥有；网络请求和 Agent 模型 provider 推理继续在事务外执行。

## 未选择的方案

- **修改候选 v3**：会破坏已存在的 migration checksum 和 J23 可复现性。
- **让正式库先执行候选 v3 再追加 v4**：把 `reference-output` 隔离语义永久带入正式产品，并增加无业务价值的表约束与迁移负担。
- **为正式 Agent 建第二个数据库**：制造字幕输入、任务和产物之间的跨库一致性问题，违反 ADR 0001 的单一权威和单写者方向。

## 验证

- DB7、J21、J24：真实 storage worker 与 SQLite migration 覆盖 v2 → 正式 v3 升级、字幕事实保留、正式表完整性和交叉 catalog fail closed。
- J23：既有候选 catalog 的 checksum、参考任务限制和隔离 userData 证据不得变化。
