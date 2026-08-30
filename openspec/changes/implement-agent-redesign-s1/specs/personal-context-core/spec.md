## ADDED Requirements

> 本 delta spec 只细化 S1 的可实施子边界。权威语义见 `docs/semantic-contract.md` SEM-F00/F26/F28/F30/T15，数据定义见 `docs/data-architecture.md` §3/§4.3/§5，旅程见 `docs/testing-strategy.md` J21；冲突时以这些文件为准。

### Requirement: 正式 catalog 只能追加 migration v5

系统 SHALL 通过正式 catalog 的追加 migration v5 建立 `formal_agent_runs`、`formal_agent_run_claim_receipts`、已登记的 `personal_context_*` 表及 `session_deletion_tombstones` 新计数列。系统 MUST 保持 migration v1–v4 的 SQL 与 checksum 逐字节不变，且不得删除、重建或改写旧 Agent 表。

#### Scenario: 从正式 v4 升级到 v5

- **WHEN** 一个包含既有字幕事实与正式 migration v1–v4 历史的数据库由产品 storage worker 打开
- **THEN** 系统应用且只应用 v5，保留全部既有字幕事实，并使 v1–v4 checksum 与冻结值完全一致

#### Scenario: 旧 migration 被改写

- **WHEN** 已登记的 v1–v4 SQL 或 checksum 与数据库历史不一致
- **THEN** 系统 fail closed，且不得打开或静默修复该数据库

### Requirement: 新旧 Agent 持久化必须物理隔离

新个人上下文 store SHALL 只读写 `formal_agent_runs`、`formal_agent_run_claim_receipts` 与 `personal_context_*`；旧 formal Agent store SHALL 保持只读写旧表。字幕 `open/append/close/history` 操作 MUST 不加载新旧任一 Agent store。

#### Scenario: 字幕路径独立运行

- **WHEN** Agent 系统未配置或新个人上下文 store 加载失败，而用户完成字幕会话的 open、append、close 与 history 读取
- **THEN** 字幕事实与历史按原合同工作，且新旧 Agent store factory 均未被调用

#### Scenario: 新 store 误用旧表

- **WHEN** 新个人上下文实现试图把运行、经历记录、个人记忆或证据写入 `agent_jobs`、`memory_evidence` 或其它旧 Agent 表
- **THEN** 合同测试失败，且实现不得以兼容层、适配器或双写继续

### Requirement: 个人上下文模块只有三个正式入口

个人上下文模块 SHALL 对正式调用者只提供 `ingest(source)`、`resolve(request)`、`manage(command)`。模块 MUST 在内部拥有范围解析、来源引用、输入水位与 digest、去重、冲突 revision、置信、生命周期、预算、省略标记和删除事务；调用者不得取得 SQLite、自由查询或内部 store interface。

#### Scenario: 调用者摄取冻结来源

- **WHEN** 调用者向 `ingest(source)` 提交 exact、已冻结且可复算来源身份的终态会话
- **THEN** 模块以原子事务返回结构化摄取结果，且调用者无需提供表名、SQL、内部合并策略或任意模型配置

#### Scenario: 载荷带有额外键

- **WHEN** 任一入口收到未登记键、自由查询、自由文本命令类型或不可复算 digest
- **THEN** 模块返回稳定的无敏感错误并保持零写入

### Requirement: S1 无模型摄取必须保守且幂等

S1 SHALL 不从任意字幕正文发明关键词、正则或模糊分类规则。非空终态会话可以确定性形成一条有界会话经历记录；自动个人记忆条目只有在后续真实固定 recipe 提供受信任结构化信号后才可经 `ingest` 形成。用户明确的“记住”与修改动作 SHALL 经 `manage` 建立或修订个人记忆。相同来源身份的重放 MUST 不产生第二条运行或经历记录。

#### Scenario: 非空终态会话首次摄取

- **WHEN** `ingest` 收到包含已提交正文、输入水位和可复算 digest 的终态会话来源
- **THEN** 系统最多建立一个 `context.ingest.session` 运行与一条有界会话经历记录，不复制整场正文，也不臆测个人记忆条目

#### Scenario: 同一来源重复摄取

- **WHEN** 相同来源、输入水位、正文版本和 input digest 被重复提交
- **THEN** 系统重放原摄取身份与计数，不新增运行、经历记录、个人记忆或报告

#### Scenario: 无已提交正文

- **WHEN** 会话没有任何首次稳定转写，或来源只含临时字幕
- **THEN** 系统返回 `no_committed_transcript` 或登记的丢弃结果，并保持个人上下文表零新增

### Requirement: resolve 必须返回有界个人上下文包

`resolve(request)` SHALL 按当前选区、终态会话、日期范围或项目解析有界个人上下文包。模块 MUST 以会话内完整提交水位剔除未定稿尾部并写入 `not_committed_tail`，对精修覆盖不完整的会话回落权威原始转写，且一个会话内不得混合 `raw` 与 `refined`。条目匹配 MUST 只使用 NFKC + casefold 后全等的结构化键与已登记别名。

#### Scenario: 跨会话范围含未定稿尾部

- **WHEN** 请求范围包含至少一个有非空已提交正文的终态会话以及一个未定稿尾部
- **THEN** 模块返回 `ready`，只纳入完整提交水位，并在个人上下文包中保留 `not_committed_tail` 省略标记

#### Scenario: 精修覆盖不完整

- **WHEN** 一个范围内会话的精修覆盖为 `N ≠ M`
- **THEN** 模块为该会话使用权威原始转写，不混合两个版本，也不因此排除整个会话

#### Scenario: 请求超过包预算

- **WHEN** 候选经历记录或个人记忆超过条目、来源或字节预算
- **THEN** 模块只纳入完整条目并返回确定性的 `budget` 省略标记，不截断正文或来源引用

### Requirement: manage 必须提供 revision 守卫与幂等删除

`manage(command)` SHALL 支持已登记的查看、修改、删除、休眠、“记住”和“忘记”命令。所有写命令 MUST 携带 `expectedRevision` 并在冲突时零写入。设置与字幕历史发起的“记住”必须是 exact 结构化命令，分别声明范围、条目类型、规范化语义键与可展示内容；不得提交自由文本命令类型、任意对象或数据库行形状。由此建立的“术语”个人记忆仍不属于 J20 确认关键词，不能影响识别 provider。单条“忘记”只使条目退出检索，保留条目、revision、evidence 与会话经历记录，且自动摄取不得静默恢复；只有用户后续明确“记住”或修改才可恢复。删除单条个人记忆 MUST 先写不含正文的 suppression，再物理移除该条目的投影、revision 与 evidence；相同 deletion idempotency key 的重放只能返回原计数。

#### Scenario: 用户明确记住结构化个人记忆

- **WHEN** `settings` 或 `history` 角色提交 exact、预算内且 revision 匹配的范围、条目类型、规范化语义键与可展示内容
- **THEN** 系统建立一条 `origin=explicit` 的个人记忆并推进 revision，且不创建或修改任何确认关键词集合

#### Scenario: renderer 提交自由个人记忆行

- **WHEN** renderer 提交自由文本命令类型、额外键、数据库字段或未登记条目类型
- **THEN** 系统返回稳定输入错误、保持零写入，且不得把输入转交给模型推断结构

#### Scenario: 忘记后自动摄取再次命中

- **WHEN** 用户已忘记一条个人记忆，随后自动摄取再次命中相同旧来源或规范化语义键
- **THEN** 条目继续退出检索且全部来源历史保持不变；只有用户明确“记住”或修改才可恢复

#### Scenario: revision 冲突

- **WHEN** 用户提交的 `expectedRevision` 不是当前 revision
- **THEN** 系统返回稳定冲突结果，个人上下文投影、revision、evidence 与 suppression 全部不变

#### Scenario: 删除回复丢失后重放

- **WHEN** 首次删除事务已经提交但回复丢失，调用者以同一 deletion idempotency key 重试
- **THEN** 系统返回首次删除计数，不再次删除其它条目，也不保存被删除正文

#### Scenario: 会话删除

- **WHEN** 用户删除一个字幕历史会话
- **THEN** 同一事务删除其经历记录与个人上下文 evidence，仅由该会话支持的条目退出检索，并把新增计数写入 `session_deletion_tombstones`

### Requirement: 后台调度必须遵守 ADR 0012 生命周期

新 `FormalAgentJobScheduler` SHALL 为 main-owned 单 owner 模块，只提供 `start`、`wake`、`stop`。同一 logical claim attempt 在 receipt 或空结果确定前 MUST 复用冻结请求身份；`wakeEpoch` 在 idle 交界不得丢唤醒；`stop` MUST 为终态并使旧 timer、wake 与 generation 失效。调度异常只可观察为 exact `{ code: 'AGENT_SCHEDULER_FAILED' }`。

#### Scenario: 未知 claim 结果后唤醒

- **WHEN** claim transport 结果未知且随后发生显式 `wake`
- **THEN** scheduler 复用同一 claim idempotency key、owner、请求 lease 与冻结请求摘要，直到 receipt 或空结果确定

#### Scenario: 空扫描与新工作并发

- **WHEN** 扫描准备进入 idle 时 `wakeEpoch` 已推进
- **THEN** scheduler 在同一 owner 临界点继续扫描，不依赖固定间隔轮询且不漏掉新工作

#### Scenario: stop 后迟到回调

- **WHEN** scheduler 已 `stop`，旧 generation 的 timer、微任务或订阅回调随后到达
- **THEN** 不再领取或运行任何工作，也不影响字幕系统退出

### Requirement: 自动摄取必须服从 Agent 处理资格

产品路径 SHALL 只在 Agent 处理资格为 `ready` 时创建 `context.ingest.session`。在 S2 尚未提供真实模型接入层时，系统 MUST 保持 `provider_not_configured` 并不得用内部替身伪造 `ready`。一旦真实资格成立，每个终态来源身份最多创建一个摄取工作，且默认不创建任何报告。

#### Scenario: 模型接入层尚未配置

- **WHEN** 终态会话越过字幕提交边界，但真实 Agent 模型配置档案与运行绑定能力尚未成立
- **THEN** 资格为 `provider_not_configured`，不创建运行或报告，字幕停止回执保持不变

#### Scenario: 真实资格成立后重复通知

- **WHEN** 同一终态会话在 `ready` 资格下收到重复停止通知、启动扫描或 worker replacement 唤醒
- **THEN** 系统最终只有一个 `context.ingest.session` 工作，且纪要、增强文本与分析报告工作数均为零

### Requirement: IPC 与隐私必须 fail closed

S1 的 personal-context IPC SHALL 只允许 `settings` 与 `history` 角色，并对频道和载荷使用 exact allowlist。SQLite、日志、普通报告、`.artifacts/` 与 `docs/validation/` JSON MUST 不保存凭据、现场音频、PCM、WAV、音频路径、本地绝对路径、字幕正文、设备名、绝对单调时刻或时钟偏移。

renderer-facing 投影 MUST 使用独立的 `contract_id + contract_version` 并在版本不匹配时 fail closed。已签发版本不得原地修改；breaking、additive 与 metadata-only 变更分别发布新的 major、minor 与 patch，fixture 随版本新建目录而不覆盖旧文件。调度器的 claim、lease、`wakeEpoch`、timer、generation、原始异常与 `AGENT_SCHEDULER_FAILED` 不得进入 overview、manage 结果、changed 事件或 preview fixture；技术故障只写受约束诊断并由后台幂等恢复收束。

#### Scenario: 未授权 renderer 调用管理命令

- **WHEN** `caption`、`toolbar` 或未知角色调用 personal-context 管理频道，或授权角色提交额外载荷键
- **THEN** main 在进入个人上下文模块前拒绝请求并保持零写入

#### Scenario: 证据负扫描

- **WHEN** S1 的 core、integration 与 evidence 产物完成
- **THEN** 严格扫描只发现允许的枚举、布尔、计数与哈希，不发现任何被禁止的正文、音频、设备、路径、凭据或时钟字段
