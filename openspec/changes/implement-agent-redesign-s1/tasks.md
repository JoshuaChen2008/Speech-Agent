## 1. 决策门与权威文档登记

- [x] 1.1 由项目负责人确认 design.md 的三个 seam、S1 保守无模型分流基线，以及交接第 6 节四项建议裁决；确认前不写测试或产品代码。
- [x] 1.2 按确认结果更新 `docs/agent-redesign-execution-plan.md`：把阶段 A 改为分配到 S1–S6 的测试清单，删除“先批量铺开全部红测”的解释，并记录 `FormalAgentJobScheduler` 尚无实现这一现状缺口。
- [x] 1.3 在 `docs/testing-strategy.md` 登记 J21 的 S1 子边界、正/负证据和状态上限；保持 J21 一个用户旅程编号，不新增同义 J，也不提前晋级完整 J21。
- [x] 1.4 重新逐字核对 `CONTEXT.md`、SEM-F00/F26/F28/F30/T15、J21、ADR 0012/0013/0015 和 data-architecture §3/§4.3/§5，确认术语、错误码与表名未漂移。
- [x] 1.5 记录实施前基线：当前分支、`git status --short`、五个交接提交，以及八个 `docs/current-framework*` 未跟踪文件；运行 `npm run test:core` 并把失败区分为产品断言或已登记环境问题。

## 2. S1 合同与 digest tracer bullets

- [x] 2.1 先写会红的 core 合同测试：只冻结 S1 需要的 `context.ingest.session` recipe、十值任务错误码、九值 Agent 处理资格和 personal-context exact 命令；不提前冻结 S2–S6 合同。
- [x] 2.2 新建 `src/agent/contracts/` 的最小冻结导出，使 2.1 转绿；任务错误码必须含 `AGENT_BUDGET_EXCEEDED`，且不得修改旧 `agent_jobs` 九值 CHECK。
- [x] 2.3 先写会红的 RFC 8785/JCS digest 向量，覆盖对象键序、Unicode 转义、数字规范化、非法非有限数和循环输入。
- [x] 2.4 让 2.3 转绿：复用或迁到一个中立的 canonical JSON 唯一定义点，保持既有导入路径可读，所有 S1 digest 输出为 SHA-256 小写十六进制。
- [x] 2.5 增加合同到 schema 的映射测试，证明 `formal_agent_runs.error_code` 恰好接受新十值任务码，并与旧表九值限制相互独立。

## 3. migration v5 tracer bullets

- [x] 3.1 先写会红的 v4→v5 升级测试：既有字幕事实不变、`user_version=5`、v1–v4 SQL/checksum 冻结、预期新表与 tombstone 五个新计数列存在。
- [x] 3.2 在 `src/runtime/storage-worker/schema.js` 只追加 v5 SQL/checksum 并导出命名常量，使 3.1 转绿；不得编辑 v1–v4 字节。
- [x] 3.3 先写会红的 STRICT/CHECK 负测试：`personal_context_episodes` 与 `personal_context_evidence` 的 `source_kind/session_id/interaction_id` 必须恰好一对一，旧任务/新运行错误码闭集各守各表。
- [x] 3.4 补齐 v5 CHECK、索引、触发器和事务前置校验，使 3.3 转绿；不得给 v5 的 interaction 引用伪造无法成立的外键。
- [x] 3.5 先写会红的删除与隐私 schema 测试：新增 tombstone 计数非负，个人上下文表不含凭据、音频、音频路径、本地路径、原始 Error/stack 或正文副本列。
- [x] 3.6 使 3.5 转绿，并验证 v5 migration 失败时原库保持可恢复且开库 fail closed。

## 4. personal-context storage adapter 与惰性加载

- [x] 4.1 先写会红的 worker-service 测试：新增 personal-context 操作才加载新 store；字幕操作与旧 Agent 操作分别保持对新 store 和旧 store 的既有惰性。
- [x] 4.2 新增 `personal-context-store.js`、独立 factory 及 `requirePersonalContextStore()`，并以三个领域命令映射 `ingest/resolve/manage`，使 4.1 转绿。
- [x] 4.3 先写会红的 protocol/host/gateway exact 合同测试，覆盖额外键、缺键、未知命令、幂等键错配、业务拒绝不熔断字幕 FIFO 和未知 transport 结果同身份重放。
- [x] 4.4 扩展 storage protocol、worker host 与 `src/main/services/storage-gateway.js` 的隔离 personal-context 操作，使 4.3 转绿；不得复用旧 `AGENT_*` 操作来伪装新设计。

## 5. `ingest(source)` tracer bullets

- [x] 5.1 先写会红的模块行为测试：非空终态会话通过 `ingest` 原子建立一个 `context.ingest.session` 运行和一条有界会话经历记录，且不建立报告或自动个人记忆条目。
- [x] 5.2 新建 `src/agent/personal-context/` 与 `ingest(source)`，通过真实 storage worker/临时 SQLite 使 5.1 转绿；调用者不得传表名、SQL、模型或内部合并参数。
- [x] 5.3 先写会红的重放/失败矩阵：同 digest 重放不增行、同身份不同 digest fail closed、无首次稳定转写返回 `no_committed_transcript`、非终态来源拒绝、任一步失败整事务零写入。
- [x] 5.4 实现冻结来源重读、digest 复算、dedupe/claim receipt 与原子提交，使 5.3 转绿。
- [x] 5.5 先写会红的文本版本矩阵：`raw` 成立、完整精修 `N=M` 可选、精修覆盖不完整回落权威原始转写、同一会话不混合版本、临时字幕永不进入输入。
- [x] 5.6 实现文本版本选择与来源引用，使 5.5 转绿，并确认经历记录 `summary_json` 小于 8 KiB 且不复制整场正文。

## 6. `resolve(request)` 与 `manage(command)` tracer bullets

- [x] 6.1 先写会红的 `resolve` 单会话/跨会话测试，覆盖选区、终态会话、日期范围、项目、`not_committed_tail`、三种整场排除原因和至少一个有效会话即 `ready`。
- [x] 6.2 实现范围解析与个人上下文包投影，使 6.1 转绿；每个剔除部分必须带省略标记。
- [x] 6.3 先写会红的等值匹配与预算测试：NFKC + casefold 后全等、已登记别名全等、不得子串/分词/模糊/通配符，超预算只省略完整条目并返回 `budget`。
- [x] 6.4 实现等值匹配、稳定排序、条目/来源/字节预算和 `hasMore`/省略标记，使 6.3 转绿。
- [x] 6.5 先写会红的 `manage` 测试：查看、明确“记住”、修改、休眠、“忘记”、revision 冲突零写入，以及 renderer 不可提交自由个人记忆行。
- [x] 6.6 实现 `manage(command)` 的 exact 命令与 revision 事务，使 6.5 转绿。
- [x] 6.7 先写会红的删除矩阵：先 suppression 后物理删除、回复丢失同 key 重放计数、不同 digest 同 key 拒绝、会话删除级联经历/evidence 且只让孤立条目退出检索。
- [x] 6.8 实现单条与会话删除事务、`personal_context_deletion_receipts` 和 tombstone 新计数，使 6.7 转绿。

## 7. 调度、资格与字幕提交边界 tracer bullets

- [x] 7.1 先写会红的 `FormalAgentJobScheduler` 生命周期测试：`start` 只一次、单 owner、未知 claim 重放 exact attempt、idle 前复核 `wakeEpoch`、最早 retry timer、`stop` 终态与旧 generation 失效。
- [x] 7.2 在 `src/agent/execution-host/` 实现最小 scheduler 与 `context.ingest.session` job runner，使 7.1 转绿；scheduler 不接模型、工具、动态 recipe 或旧 Agent runner。
- [x] 7.3 先写会红的资格测试：S2 尚无真实模型接入层时终态会话稳定为 `provider_not_configured`、零运行、零报告，且不得用测试注册内部 adapter 伪造 `ready`。
- [x] 7.4 实现 S1 资格投影与 fail-closed product composition，使 7.3 转绿；只允许后续 S2 的真实模型接入层提供可晋级事实。
- [x] 7.5 先写会红的 storage/调度局部幂等测试：通过真实临时 SQLite 的受控 fixture 预置一个 `context.ingest.session` 运行，重复 `wake`、启动扫描和 worker replacement 最终只领取并收束同一运行；不得向产品资格组合器注入假 `ready`，并明确标注此测试不构成自动产品路径或完整 J21。
- [x] 7.6 实现终态 reconciliation、claim receipt 与 scheduler `wake` 接线，使 7.5 转绿。
- [x] 7.7 先写会红的字幕提交边界测试：通知只能发生在 `closeSession` 持久化 ACK 后，通知失败/调度失败不改变停止回执、不阻止下一会话或退出，诊断只含稳定 code。
- [x] 7.8 新建提交后通知 adapter 并接入新 `src/agent/**` composition，使 7.7 转绿；不得 require 旧四棵 Agent 树。

## 8. settings/history IPC adapter tracer bullets

- [x] 8.0 冻结独立版本化的 S1 UI-facing contract：先登记“记住”结构化输入、“忘记”与“删除”差异及调度技术故障不进入产品投影，再在 `src/agent/contracts/` 签发 exact validator 与 preview-only fixture，并以 `test/contracts/` 负矩阵证明缺字段、额外键、错误类型、隐私字段和版本不匹配全部 fail closed；该子任务不实现 main handler、preload、SQLite 或 renderer，也不构成 J21 证据。
- [x] 8.1 先写会红的频道与 access-policy 测试：`agent-context:get-overview`、`agent-context:manage`、`agent-context:changed` 只允许 `settings`/`history`，`caption`/`toolbar`/未知角色拒绝。
- [x] 8.2 扩展 `channels.js`、`access-policy.js`、main handler 与 settings/history preload exact 投影，使 8.1 转绿；S1 不新增 `agent` 角色。
- [x] 8.3 先写会红的 IPC 失败矩阵，覆盖额外键、缺键、陈旧 `expectedRevision`、重复删除回复、renderer reload 后 revision 单调与 observer 隔离。
- [x] 8.4 完成 main-owned personal-context controller 与 changed 广播，使 8.3 转绿；preload 不暴露 SQLite、路径、自由查询或第四个模块入口；生产 request/response/event 必须复用 8.0 已冻结的 exact validator，新增运行态 fixture 时按 contract version 建新目录而不覆盖既有 fixture，并明确标记其只供 UI/UX 预览且不构成 J21 证据。

## 9. 联合子边界、证据与提交

- [x] 9.1 在 J21 既有旅程下新增 S1 确定性联合子边界：真实字幕持久化 → 终态来源身份 → 个人上下文模块 public `ingest` seam → 新 personal-context store → `resolve/manage`；另在同一测试组合验证产品资格为 `provider_not_configured` 时自动路径零运行。只在已登记外部边界使用替身，内部模块与 SQLite 全部真实，不新增 `J21-S1` 旅程 ID。
- [x] 9.2 在同一联合测试加入失败路径：新 store 初始化失败、transaction rollback、重复通知/回复丢失、scheduler observer 抛错和 `provider_not_configured`，逐项证明字幕系统不降级。
- [x] 9.3 扩展 evidence 隐私负扫描与测试分层合同，确保新增测试只位于既有 lane 目录，JSON 不含字幕正文、凭据、现场音频、设备名、本地绝对路径、绝对单调时刻或时钟偏移。
- [x] 9.4 依次运行 `npm run test:core`、`npm run test:integration`、`npm run test:evidence`；任一失败先定位并保留可复现证据，不把受限环境 EPERM 误记为产品结论。
- [x] 9.5 用 `code-review` 复核新旧表隔离、三个入口深度、旧四树不可达、无第二套 digest/错误码字面量、失败零写入和字幕零回归。
- [x] 9.6 按实际证据更新 `docs/agent-redesign-execution-plan.md`、`docs/testing-strategy.md` 与 `PLAN.md`；只有 S1 子边界证据时状态写“实现完成·尚未验收”，不得写无修饰的“完成”或晋级完整 J21。
- [ ] 9.7 逐路径显式暂存并按功能提交合同/migration、个人上下文模块、scheduler/IPC/联合证据；每个提交 subject-only 且引用 SEM 与 J21，禁止 `git add .`。
- [ ] 9.8 提交后再次核对八个 `docs/current-framework*` 文件仍未被暂存、删除或覆盖，并确认旧 Agent 源码与 `npm run start:agent-mvp` 保持原样。
