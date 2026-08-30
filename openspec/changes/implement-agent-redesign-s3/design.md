## Context

S1 已建立 `formal_agent_runs`、个人上下文三接口、会话经历记录、运行/租约/幂等机制与保守资格基线；S2 已建立多配置档案 Agent 模型接入层、不可变模型运行绑定、十轴预算定义与 main-owned exact IPC。两片都尚未形成新的正式 Agent 执行宿主：当前 `src/agent/execution-host/` 只有 S1 的 `context.ingest.session` 确定性前段和调度骨架，`model-access` 仍接受已经废止的 `single_shot`，正式交互与工具调用也没有 v7 存储事实。

S3 必须把这些前置事实组合成一个可实施的 Core，而不能复用 ADR 0015 锁定的旧 `AgentPluginHost`、旧三项自动任务、旧配置表、旧凭据入口或 SEM-F29 隔离 Agent 内核开发入口。冲突优先级是 semantic contract > ADR > 其它文档 > 当前代码；ADR 0016 取代 ADR 0013 的执行二分，ADR 0018 冻结两层意图收敛，2026-08-30 修订说明取消 `estimated` 用量来源。

S3 对 J22/J24 只形成 Core 子边界。它必须使用真实 v7、storage worker/SQLite、个人上下文模块、模型接入层、运行/租约/幂等机制、执行宿主、main 资格组合与 exact IPC，只替代外部 Agent 模型 provider。真实 Agent Bar renderer、完整 `read_sources` 与工具预算、单交互导出和正式设置/历史汇合仍由 S4/S5-Integration 验收。

## Goals / Non-Goals

**Goals:**

- 冻结 migration v7 的三张 `STRICT` 表、删除计数、分页/全序索引、级联与隐私不变量。
- 让 `src/agent/contracts/recipes.js` 成为十一个 recipe 的唯一静态登记点，并让登记表可驱动模型用途、轮次、工具授权、输出校验、持久化和失败收束。
- 用 Pi `agentLoop()` 实现唯一执行路径，以 `shouldStopAfterTurn` 承载登记轮次上限和预算停止条件。
- 冻结每个 recipe 的输入范围、模型用途、输出 Schema、持久化、产物类型与失败策略。
- 实现模型优先、规则兜底的两层意图收敛，并保证收敛没有失败态。
- 复用 S1 的运行、租约、claim/reply 幂等、调度和两段式摄取前段，复用 S2 的不可变模型运行绑定与凭据边界。
- 冻结取消、重试、迟到消息、可空用量、comparison group、报告自动呈现回执、会话删除与分页读取语义。
- 冻结六个 `agent-run:*` exact IPC、`agent/history` 权限、九值资格顺序与脱敏 UI/UX fixture。
- 以 tracer bullet 安排未来实现，使 core/integration/evidence 三条 lane 都能指出 SEM-F16/F28/F30-F35/T10/T15 与 J22/J24 的独立风险。

**Non-Goals:**

- 不实现动态插件、manifest、发现、热重载、递归委派、第三方 recipe 或完整 coding Agent。
- 不恢复 `single_shot/agent_loop` 二分、四条件升级、70% 阈值、`execution_form` 运行期判定或 `escalation_reason`。
- 不让 renderer、recipe 或 Agent utility 直接访问 SQLite、凭据、文件系统、任意网络、音频采集、ASR 或字幕写入。
- 不实现 S4 才拥有的 `read_sources` 完整 adapter、七值工具错误收束与十轴工具预算全量执法；S3 只冻结其授权和审计 schema，并先接入 0 工具与 `search_context`。
- 不实现正式 Agent Bar renderer、单交互导出、保存对话框、真实公网模型调用或完整 J22/J24/J26。
- 不写入或读取 ADR 0017 已废案的四张 `recognition_*` 表，不让任何个人上下文条目影响识别 provider。
- 不保存完整提示历史、工具外中间 assistant 文本、内部思维过程、provider 原始事件、凭据、现场音频、音频路径、本地绝对路径或金额字段。

## Decisions

### 1. Agent 执行宿主拥有一个执行入口与三个内部阶段

执行宿主的公开运行入口接收已经冻结的 `formal_agent_runs` 身份、recipe 登记快照、个人上下文包引用与模型运行绑定引用。内部按固定次序执行：

1. 验证 run/recipe/version、资格、冻结范围与登记表快照；
2. 对 `context.ingest.*` 执行 recipe 内部的零模型确定性输入准备，其余 recipe 无该阶段；
3. 对所有 recipe 调用同一个 Pi `agentLoop()`，按登记的 `maxTurns` 与 `toolGrants` 执行并校验最终输出；
4. 经受控 writer 原子提交交互、工具调用记录与对应个人上下文或产物事实。

这四步是一个运行协议，不是四个公开接口，也不是多条执行路径。运行期不得根据输入长度、范围、模型表现、confidence 或工具结果改变轮次上限与授权。`manage(command)` 等确定性用户控制继续只属于个人上下文模块，不包装成 recipe。

选择该形状是因为 Pi 底层本来只有一段 loop；保留产品层执行二分会重新引入 ADR 0016 已消除的循环依赖与双测试矩阵。

### 2. `recipes.js` 是十一 recipe 的唯一登记点

`src/agent/contracts/recipes.js` 导出冻结的登记对象与 exact lookup/validator，不允许 execution host、model-access、storage、IPC 或 renderer 复制第二套 recipe 字面量。每项登记 exact 包含：

```text
recipeId, recipeVersion, inputScopes, modelPurpose,
maxTurns, toolGrants, outputSchemaId,
persistence, artifactType, failurePolicy
```

登记表如下；所有版本首版固定为 `'1'`：

| recipe | 输入范围 | 模型用途 | 轮次 / 工具 | 持久化与产物 |
|---|---|---|---|
| `intent.route` | 用户提示 + 已冻结选区/会话/日期范围/项目的最小范围身份 | 默认 | 1 / `[]` | 写运行/绑定/交互审计；不进用户历史列表；无产物 |
| `context.ingest.session` | 单个终态会话完整提交水位；`raw` 或整场 `N=M` 的 `refined` | 信息提取 | 3 / `search_context` | 原子写会话经历记录与个人记忆；无产物 |
| `context.ingest.interaction` | 一条终态正式 Agent 交互、结果版本与交互记忆信号闭集 | 信息提取 | 3 / `search_context` | 原子写交互经历记录与个人记忆；无产物 |
| `qa.answer` | 选区 / 终态会话 / 日期范围 / 项目 | 默认 | 3 / `search_context` | 只存交互 `result_json`；无报告产物 |
| `extract.items` | 选区 / 单个终态会话 | 信息提取 | 3 / `search_context` | 只存交互 `result_json`；不新增产物类型 |
| `summary.minutes` | 单个终态会话完整提交水位 | 摘要与总结 | 3 / `search_context` | 保存 `meeting-minutes` |
| `report.analysis` | 选区 / 终态会话 / 日期范围 / 项目 | 分析与规划 | 6 / `search_context,read_sources` | 版本化保存新产物 `analysis-report` |
| `plan.proposal` | 选区 / 终态会话 / 日期范围 / 项目 + 用户约束 | 分析与规划 | 6 / `search_context,read_sources` | 保存新产物 `planning-proposal` |
| `text.enhance` | 单个终态会话完整 `raw` 或整场 `N=M` 的 `refined` | 摘要与总结 | 3 / `search_context` | 保存 `enhanced-transcript` |
| `text.rewrite` | 用户明确选区 | 默认 | 1 / `[]` | 只存交互 `result_json` |
| `text.translate` | 用户明确选区或单个终态会话 | 默认 | 1 / `[]` | 只存交互 `result_json`；整场翻译产物后置 |

`analysis-report` 与 `planning-proposal` 加入正式产物类型闭集。`extract.items` 不创建产物类型，尤其不能复用只属于隔离 Agent 内核开发入口的 `reference-output`。

### 3. 输出 Schema 使用共享引用与逐 recipe exact validator

所有结果对象必须是 exact JSON object，带 `schemaVersion: 1`。共享 `sourceRef` 固定为 `{sessionId, transcriptVersion, fromEventOrder, throughEventOrder}`，共享 `memoryRef` 固定为 `{memoryId, revisionId}`，交互信号引用固定为 `{interactionId, signalKind}`。数组项、枚举、code point 长度、条目数与 UTF-8 总字节均在进入 writer 前验证；unknown/extra/missing 字段均以 `AGENT_OUTPUT_INVALID` 收束，不提交部分产物。

逐 recipe 的完整 Schema 写在 `specs/agent-execution/spec.md`，登记表只引用 `outputSchemaId`，不复制 validator。`context.ingest.*` 的模型输出不含权威 `semanticKey`；storage worker 必须从可展示正文按 data architecture §5 的规则派生。这样 renderer、模型与 recipe 都不能选择数据库去重键。

### 4. migration v7 只追加四组已登记内容

v7 不编辑 v1-v6 的 SQL 或 checksum，且只追加：

1. `formal_agent_interactions`、`formal_agent_tool_calls`、`formal_agent_report_presentations` 三张 `STRICT` 表；
2. `session_deletion_tombstones.deleted_report_presentation_count` 一列；
3. `formal_agent_interactions_page` 与 `formal_agent_tool_calls_order`；
4. `personal_context_items_page` 与 `personal_context_episodes_page`。

`formal_agent_interactions.run_id` 唯一并外键指向 v5 `formal_agent_runs`，不新增 `model_binding_id`；v6 绑定仍以同一个 `run_id` 关联。交互保存 recipe 登记快照与 `routing_mode`，没有 `execution_form` 或 `escalation_reason` 列。成功必须有 `result_json`，失败必须有 error code，取消允许结果为空。`usage_json` 可空，非空必须通过 exact `ModelUsageV1`。

`formal_agent_tool_calls` 用 `UNIQUE(interaction_id, attempt, call_order)` 保留全序；args/result 分别由 `CHECK(length(CAST(... AS BLOB)) <= 8192/65536)` 直接执法，不静默截断。`formal_agent_report_presentations.session_id` 为主键，`run_id` 唯一并级联到 run，使每个终态会话至多存在一次自动报告请求/呈现事实。

### 5. `bind()` 与预算只消费静态登记事实

S2 的 `assertRunRequest()` 继续保持 exact 四字段，但 `executionForm` 只接受 `'agent_loop'`。`agent_model_run_bindings.execution_form` 保留为 v6 既有常量列，不进入交互表、UI 或导出。工具授权非空的 recipe 才要求模型 `supportsToolCalling=true`；0 工具 recipe 不要求该能力。

`deriveBudget()` 改为消费 recipe 的 `maxTurns/toolGrants` 与模型能力、请求来源，不再从 execution form 推导第 1 轴。其它九轴沿用 S2 唯一定义。S3 让 `shouldStopAfterTurn` 至少守住登记轮次；S4 再闭合两个工具的完整预算账本。任何预算超限都以 `AGENT_BUDGET_EXCEEDED` 收束且不写产物。

### 6. 两层意图收敛产生两个可审计运行

用户经 Agent Bar 提交自然语言意图时，main 先冻结范围，再创建 `intent.route` 的真实 run/binding/interaction。模型返回 `{recipeId, confidence}` 且 `recipeId` 位于其它十项时，面向用户的运行使用该结果并写 `routing_mode='model'`。confidence 只作为 route 输出事实，首版不设阈值、不投票、不向界面展示。

下列五类触发确定性规则，并让面向用户运行写 `routing_mode='rules'`：

1. `intent.route` Agent 处理资格不为 `ready`；
2. 运行以任一 `AGENT_PROVIDER_*` 收束；
3. 运行以 `AGENT_OUTPUT_INVALID` 或 `AGENT_BUDGET_EXCEEDED` 收束；
4. 运行以 `AGENT_WORKER_EXITED` 或 `AGENT_INTERNAL_FAILURE` 收束；
5. 成功结果的 `recipeId` 不在其它十项闭集内。

规则只消费冻结范围种类与受控关键词，按固定优先级返回一项；全部不匹配时返回 `qa.answer`。因此收敛没有失败态。用户取消 `intent.route` 不触发规则，也不创建后续运行。`context.ingest.*` 与自动纪要请求直接使用已知 recipe，写 `preset` 且不创建 route run。

界面只显示产品语言。用户改选等价于取消当前面向用户运行并创建新 `runId`/绑定/交互/产物版本，不修改原运行或 route 审计。

### 7. 取消、重试与迟到消息都以 SQLite 终态为准

取消信号贯穿模型请求、Pi loop 与工具执行。确认取消后不再开始新 turn、新模型请求或新工具调用；当前调用在下一个检查点收束，运行、interaction 与 runtime 整体进入取消终态并释放租约。取消 `error_code` 为空，允许 `result_json=NULL`，不得补造空结果对象或部分产物。

每个 provider/utility/storage 回执都携带 run/attempt/generation 身份。writer 在同一事务内再次验证 run 与 interaction 尚未终态；迟到成功、失败或工具结果在取消/失败/成功终态后全部拒绝，不能改写 result、usage、duration、binding、attempt 记录或报告呈现回执。

自动重试保留同一 `runId`、模型运行绑定、冻结输入与 recipe 登记快照，递增 attempt 并保留旧工具调用记录。Loop 不做中途恢复，不使用 `agentLoopContinue()`；恢复总是从冻结输入整体重跑。S1 的 claim receipt、租约、reply-loss 与 scheduler wake 机制继续使用，不建立新任务表或第二幂等协议。

### 8. 两段式摄取复用 S1 事实而不双写

`context.ingest.session` 与 `context.ingest.interaction` 在同一 recipe runner 内先执行零模型确定性前段：建立或重放经历记录骨架的来源范围、水位、digest 与幂等身份。随后才取得模型运行绑定并进入统一 Agent Loop，让模型提炼候选。

模型输出经 exact Schema、噪声闭集、范围、冲突、置信、生命周期与预算规则后，由个人上下文模块在原子事务内更新经历记录与个人记忆。storage worker 从候选可展示正文派生 `semantic_key`；明确内容不能被自动候选覆盖，被忘记条目不能由自动摄取静默恢复，suppression 命中的旧来源不能重建。任何模型或提交失败都保留可重放骨架与原运行身份，不复制第二条经历记录，不推倒 S1 的租约与幂等机制。

### 9. 用量未知是 `NULL`，comparison group 只比较同源同 recipe

`ModelUsageV1` 的 `usageSource` 恒为 `provider`。provider 未返回完整可用 usage 或 model 的 `usageReporting=false` 时，interaction 的 `usage_json` 整体为 SQL `NULL`；UI fixture 投影“用量未知”，不估算 input/output token，也不把未知缓存显示为 0%。此时累计计费输入/输出两轴不评估，其余八轴照常执法。

provider usage 非空时保存 exact input/output/cache token；cache hit/miss 只有同时非负、和大于零且等于 input token 时保留，命中率查询时派生而不持久化。任何表、contract、fixture、历史或导出都不建立 amount/price/cost/currency/pricing 字段。

`comparison_group_id` 固定为 RFC 8785 canonical JSON tuple `[recipe_id, recipe_version, scope_digest, input_digest]` 的 UTF-8 字节经 SHA-256 得到的小写十六进制。模型身份不进入该 digest，使用户主动换模型的新 `runId` 可落在同一比较组；recipe/version/range/input 任一不同都会分组。

### 10. 报告自动呈现与历史投影由结构性事实去重

`summary.minutes` 既可由用户请求，也可在报告自动呈现偏好开启后由未来合格终态会话预置创建。自动路径先插入 `formal_agent_report_presentations(session_id PRIMARY KEY, run_id UNIQUE, presented_at NULL)`；重复停止、重复通知、启动扫描、renderer reload 或 reply loss 只能恢复同一行。实际非模态呈现后原子填充 `presented_at`，关闭偏好不删除旧行。

`intent.route` 照常写 run/binding/interaction，但历史与导出的列表查询排除它。删除面向用户交互时，在同一删除事务内删除配套 route interaction/run；这是一项投影与生命周期规则，不是 route 的存储特例。

### 11. 会话删除事务覆盖三张 v7 表并累计回执

删除会话先写 tombstone，再删除直接或范围引用该会话的 formal runs/interactions、由 interaction 级联的 tool calls、报告呈现回执、个人上下文经历记录/证据及已登记孤儿条目。v5 已有 `deleted_interaction_count` 与 `deleted_tool_call_count`；v7 只新增 `deleted_report_presentation_count`，不得重复加旧列。

同 deletion idempotency key + digest 重放返回原计数，不再次删除。删除后的迟到运行、interaction、tool call、presentation 或摄取提交全部 fail closed；四张废案 `recognition_*` 表不读不写。tombstone 只保存标识、计数与时间，不保存正文、设备名或路径。

### 12. 六个 exact IPC 与九值资格只由 main 组合

版本化 Agent run UI contract 冻结六个频道：

| channel | 方向 / 角色 | 作用 |
|---|---|---|
| `agent-run:get-eligibility` | renderer → main；`agent`/`history` | 对冻结请求读取九值资格与下一动作 |
| `agent-run:submit` | renderer → main；`agent`/`history` | 提交自然语言意图或预置 recipe 请求 |
| `agent-run:cancel` | renderer → main；`agent`/`history` | 请求取消一个可见运行 |
| `agent-run:get-history` | renderer → main；`agent`/`history` | keyset 读取最小终态交互历史 |
| `agent-run:get-interaction` | renderer → main；`agent`/`history` | 读取一个终态交互与折叠工具调用记录 |
| `agent-run:changed` | main → renderer；`agent`/`history` | 单调 revision invalidation event |

所有 request/result/event 都是 exact object 并携带 contract identity；未知版本、角色、枚举、额外键或缺字段在进入 controller 前拒绝。renderer 不提交 URL、model、purpose、budget、tool grants、routing mode、eligibility、路径或凭据。

main 按固定优先级计算九值：`session_not_terminal` → `no_committed_transcript` → `outside_automatic_window`（只对自动请求）→ `agent_disabled` → `provider_not_configured` → `cloud_disclosure_required` → `credential_unavailable` → `local_model_not_ready` → `ready`。用户请求跳过自动处理时间边界，但不绕过其它项。该顺序只定义组合，不扩张九值闭集；fixture、IPC 成功或 renderer 状态都不能伪造 `ready`。

### 13. UI/UX fixture 与证据目录严格隔离

S3 签发版本化脱敏 fixture，至少覆盖四种范围、九值资格、route model/rules/preset、pending/cancelling/cancelled/failed/succeeded、1/3/6 轮登记、0 工具空记录、provider usage、用量未知、cache known/unknown、最小历史、工具折叠、reload 与 unknown-value fail closed。

fixture 与生产 contract 使用同一 exact validator，带 `previewOnly=true`，存放在 `src/agent/contracts/fixtures/` 而不是 `.artifacts/` 或 `docs/validation/`。fixture、renderer 局部回归和旧隔离入口都不构成 J22/J24 证据。

隐私负扫描同时覆盖 SQLite schema/rows、IPC、fixture、stdio、日志与 evidence JSON：工具外中间 assistant 文本零持久化；提示终态信号提取后只留 digest；禁止 reasoning/provider 原始事件、凭据、现场音频、PCM/WAV、音频路径、本地绝对路径、设备名、绝对单调时刻、时钟偏移和金额字段。

### 14. S3 Core 验证只提升实现状态

Core 测试负责 exact 枚举/Schema/canonicalization/状态转换；storage 测试负责 v7、CHECK/UNIQUE/外键/删除/分页；runtime 测试负责登记、统一 Loop、route、取消、重试、两段式摄取；main/contracts 测试负责资格、IPC、权限与 fixture；integration 用一条表驱动 J22/J24 S3 Core 子边界组合真实内部模块，只替代外部 provider。

S3 必须先证明 0 工具与 `search_context` 两档，且 1 轮 recipe 不进入第二轮、0 工具 recipe 的工具记录为空。`read_sources` 的真实执行与完整工具预算留给 S4；Agent Bar renderer/导出汇合留给 S5-Integration。即使三条 lane 返回 0，S3 也最多记录为「实现完成·尚未验收」。

## Risks / Trade-offs

- **[recipe 登记被多模块复制后漂移]** → 只导出 `recipes.js` 的冻结 lookup/validator，storage 快照保留创建时事实，测试逐项对照全部十一项。
- **[1 轮 recipe 的 Schema 修复请求意外形成第二轮]** → 输出 invalid 直接以 `AGENT_OUTPUT_INVALID` 收束；provider retry 是新 attempt 的整体重跑，不在同一 attempt 增加超过登记上限的 turn。
- **[S1 确定性摄取前段被误写成第二执行路径]** → 前段只建立经历记录骨架且零模型调用，所有模型提炼仍进入同一个 Loop，并沿用同一个 run/attempt。
- **[取消与迟到结果竞态写入部分结果]** → writer 在 SQLite 事务内复核 terminal state、attempt 与 generation，终态后所有结果拒绝。
- **[provider 不报告用量导致预算看似失控]** → 不评估两条累计计费用量轴，但仍用静态轮次上限乘单次请求输入预算和其余八轴形成确定性上界。
- **[自动报告重复呈现]** → `session_id PRIMARY KEY` 先登记请求、`run_id UNIQUE` 绑定运行、`presented_at` 原子填充，所有通知只恢复同一行。
- **[工具正文变成第二知识库或泄漏到证据]** → args/result 只在本地交互审计表有界保存，默认折叠；日志、报告、个人记忆与证据 JSON 零复制。
- **[S3 Core 被误称为完整 Agent Bar]** → testing strategy 明确子边界与状态上限，fixture 带 `previewOnly`，S5-Integration 才能晋级 J22/J24。
- **[旧 Agent 源码被顺手接回]** → 新实现只依赖 `src/agent/**` 新模块与 S1/S2 facts；旧四树继续按 ADR 0015 作为不可达迁移素材。

## Migration Plan

1. 先冻结 `agent-execution` contract、十一 recipe 表、逐 recipe 输出 Schema、错误/终态/route/IPC/fixture 闭集；不得先改 runtime。
2. 用临时 v6 数据库写 v7 red test，冻结 v1-v6 SQL/checksum、三表、一列与具名索引，再只追加 v7。
3. 逐条实现 interaction/tool/presentation store、keyset query、删除事务和 storage worker protocol；每条一个 red → green → 定向回归。
4. 收窄 S2 `bind()` 与预算推导，建立 `recipes.js`，再接唯一 Agent Loop、输出 validator、usage/comparison、取消/迟到守卫。
5. 在 S1 runner 上加入两段式模型提炼，保持 run/lease/idempotency 与经历记录骨架不变；随后实现 interaction ingest。
6. 实现 route model/rules/preset、五类兜底、改选、历史投影与报告呈现回执。
7. 签发 exact IPC/access policy/preload facade 与脱敏 fixture，不实现正式 Agent Bar renderer。
8. 以真实内部模块运行 J22/J24 S3 Core 联合子边界，再依次运行 core、integration、evidence；Windows Electron GPU 环境失败与新增 S3 产品断言分开记录。
9. 只有 S5-Integration 把 S3/S4 Core、正式 Agent Bar/历史/导出组合后，才可晋级完整 J22/J24/J26。

数据库回退只允许停止发布并恢复升级前备份；已经发布的 v7 SQL/checksum 不得原地修改或降 `user_version`，修复必须用后续追加 migration。代码回退可以停止 S3 composition，但必须继续识别已发布 v7，并保持字幕 storage/history 不依赖 Agent runtime。

## Open Questions

当前无阻断待裁定项。v7 的四条具名 `CREATE INDEX` 与 `docs/data-architecture.md` §5、执行计划和本 spec 一致；三张表的 `UNIQUE`/主键仍由 SQLite 自动建立约束索引，但不计入显式 v7 `CREATE INDEX` 清单。
