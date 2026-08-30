## ADDED Requirements

> 本 delta spec 只细化 S3 的 J22/J24 Core 子边界。权威语义见 `docs/semantic-contract.md` SEM-F16/F28/F30-F35/T10/T15 及 2026-08-30 修订说明，决策见 ADR 0013-0018，数据约束见 `docs/data-architecture.md` 的 v7 规则，旅程见 `docs/testing-strategy.md` J22/J24 与其 S3 Core 子边界；冲突时以这些文件为准。S3 状态最多为「实现完成·尚未验收」。

### Requirement: 字幕系统必须独立于 Agent 执行宿主

系统 SHALL 把 Agent 执行宿主作为字幕提交边界之后的可选消费者。执行宿主、recipe、Agent 模型 provider、个人上下文、interaction store、IPC 或 fixture 的缺失、初始化失败、运行失败、取消或恢复 MUST NOT 阻塞音频采集、ASR、字幕显示、首次稳定转写持久化、字幕停止、退出、下一会话、字幕历史或字幕导出。renderer、recipe 与 Agent utility MUST NOT 控制音频采集、识别 provider、字幕事件或字幕数据库写入。

#### Scenario: Agent 执行宿主初始化失败

- **WHEN** 字幕应用启动时 S3 interaction store、执行宿主或 Agent 模型接入层初始化失败
- **THEN** Agent 能力显式降级，字幕系统仍可开始互斥单路会话、显示并持久化首次稳定转写、停止和查看历史

#### Scenario: Agent 运行期间开始新字幕会话

- **WHEN** 一个云端固定 recipe 运行尚未收束而用户开始新的字幕会话
- **THEN** 字幕会话不等待 Agent；云端运行可按冻结身份继续，本地重任务按既有资源让行规则不新启动

#### Scenario: recipe 试图访问字幕写端口

- **WHEN** 任一 recipe 或模型输出试图启动采集、切换 `mic/loopback`、写字幕事件或修改首次稳定转写
- **THEN** 执行宿主以 `AGENT_PERMISSION_DENIED` fail closed，字幕事实零改写

### Requirement: migration v7 必须只追加已登记四组内容

正式 catalog SHALL 在 v1-v6 之后只追加 migration v7。v1-v6 的 SQL 与 checksum MUST 逐字节不变，checksum 漂移 MUST fail closed。v7 SHALL 且只 SHALL：新建 `formal_agent_interactions`、`formal_agent_tool_calls`、`formal_agent_report_presentations` 三张 `STRICT` 表；给 `session_deletion_tombstones` 增加 `deleted_report_presentation_count`；建立交互分页与工具全序索引；建立 `personal_context_items` 与 `personal_context_episodes` 的 keyset 分页索引。v7 MUST NOT 新建、修改、读取或写入任何 `recognition_*` 表，也 MUST NOT 删除旧 Agent 表。

当前权威数据规则逐字冻结四条具名 `CREATE INDEX`：`formal_agent_interactions_page(terminal_at DESC, interaction_id)`、`formal_agent_tool_calls_order(interaction_id, attempt, call_order)`、`personal_context_items_page(lifecycle, updated_at DESC, memory_id)`、`personal_context_episodes_page(lifecycle, updated_at DESC, episode_id)`。执行计划中的“五条索引”计数与该清单不一致；第五条索引在裁定并同步 `docs/data-architecture.md` 前 MUST NOT 由实现自行发明。

#### Scenario: v6 升级到 v7

- **WHEN** storage worker 打开一个含既有字幕、S1 personal-context 与 S2 model-access 事实的 v6 数据库
- **THEN** 系统且只应用 v7，保留全部既有事实，并使 `user_version=7`

#### Scenario: v1-v6 checksum 漂移

- **WHEN** v1-v6 任一已登记 SQL 或 checksum 与数据库历史不一致
- **THEN** storage worker fail closed，不重建、降版本、跳过或静默修复 migration 历史

#### Scenario: v7 夹带额外表列或 recognition 变更

- **WHEN** v7 候选包含已登记三表和一列以外的表/列，或触及任一 `recognition_*` 表
- **THEN** schema contract 失败，候选不得进入 S3 实施

#### Scenario: 未裁定第五条具名索引

- **WHEN** 实现者准备增加 data architecture 未登记的第五条具名索引
- **THEN** 该项保持「待裁定」，不得隐藏在 migration task 中；其余四条具名索引与 S3 非 schema 工作可继续

### Requirement: formal_agent_interactions 必须保存最小终态审计事实

`formal_agent_interactions` SHALL 以 `interaction_id` 为主键，以 `run_id` 唯一并外键指向 v5 `formal_agent_runs(run_id) ON DELETE CASCADE`。它 MUST 保存 `recipe_id/recipe_version/max_turns/tool_grants_json/routing_mode/requested_by/scope_json/scope_digest/input_digest/prompt_digest/terminal_reason/error_code/usage_json/duration_ms/attempt_count/comparison_group_id/result_json/result_digest/created_at/terminal_at`，MUST NOT 含 `model_binding_id`、`execution_form`、`escalation_reason`、provider/model 副本、金额或正文副本。模型事实 MUST 只经相同 `run_id` 关联 v6 `agent_model_run_bindings`。

`max_turns` MUST `CHECK IN (1,3,6)`，`routing_mode` MUST `CHECK IN ('model','rules','preset')`，`terminal_reason` MUST `CHECK IN ('succeeded','failed','cancelled')`。失败恰好要求非空任务错误码；成功恰好要求非空 `result_json`；取消 SHALL 允许 `result_json=NULL` 且 MUST NOT 补造。用户请求 SHALL 在交互记忆信号提取后只保留非空 `prompt_digest`，自动请求 SHALL 没有用户提示正文。`usage_json` SHALL 可空。

#### Scenario: 成功交互提交

- **WHEN** 一个已登记 recipe 在有效 run/binding/attempt 上产生通过 Schema 的最终结果
- **THEN** writer 原子写入一条成功 interaction、登记快照、结果/digest、相对时长与可空用量，且不复制模型绑定事实

#### Scenario: 取消交互没有结果

- **WHEN** 运行在产生最终结果前收束为取消
- **THEN** interaction 保存 `terminal_reason='cancelled'`、`error_code=NULL`、`result_json=NULL`，数据库约束接受该终态且不补造结果

#### Scenario: interaction 试图保存执行二分字段

- **WHEN** 任意 writer 提交 `execution_form`、`escalation_reason` 或 `model_binding_id`
- **THEN** exact storage contract 在写入前拒绝，v7 schema 也不存在对应列

#### Scenario: 同一 run 写第二条 interaction

- **WHEN** 回复丢失重放或迟到消息试图为相同 `run_id` 插入第二个 `interaction_id`
- **THEN** UNIQUE/幂等合同只返回既有 interaction，不增加计数且不改写终态快照

### Requirement: formal_agent_tool_calls 必须保存有界全序审计

`formal_agent_tool_calls` SHALL 以 `call_id` 为主键并外键指向 owning interaction，保存 `attempt/call_order/tool_name/schema_version/started_offset_ms/ended_offset_ms/status/error_code/args_json/args_digest/result_json/result_digest/source_refs_json/counts_json`。`UNIQUE(interaction_id, attempt, call_order)` MUST 形成全序，`call_order` MUST 在 1..12，`tool_name` MUST 只允许 `search_context/read_sources`，状态与七值工具错误码 MUST exact 绑定。

schema MUST 直接执法 `CHECK(length(CAST(args_json AS BLOB)) <= 8192)` 与 `CHECK(length(CAST(result_json AS BLOB)) <= 65536)`。超限 MUST 在执行或提交前显式失败，不得静默截断。自动重试 MUST 保留旧 attempt 的全部记录；模型在工具调用之外产生的中间 assistant 文本 MUST NOT 进入本表。

#### Scenario: 工具调用完整往返

- **WHEN** 已授权工具的 exact args/result 均在单次字节上限内并通过 Schema
- **THEN** interaction 按 `(attempt,call_order)` 保存完整 args/result、digest、来源引用、计数与相对时间

#### Scenario: args 超过 8 KiB

- **WHEN** canonical args JSON UTF-8 字节数为 8193
- **THEN** schema/执行宿主以工具预算错误 fail closed，不执行或不提交该调用，且不得截成 8192 字节后称为完整

#### Scenario: result 超过 64 KiB

- **WHEN** 工具准备返回 canonical result JSON UTF-8 字节数超过 65536
- **THEN** 工具以 `TOOL_BUDGET_EXCEEDED` 收束，interaction 不保存截断正文

#### Scenario: attempt 重试

- **WHEN** attempt 1 已有工具记录后同一 `runId` 进入 attempt 2
- **THEN** attempt 1 记录保持逐字段可读，attempt 2 从自己的 `call_order=1` 开始且不得覆盖/合并旧记录

### Requirement: formal_agent_report_presentations 必须结构性保证每会话至多一次

`formal_agent_report_presentations` SHALL 以 `session_id` 为主键，保存唯一 `run_id`、可空 `presented_at` 与 `created_at`。`run_id` MUST 唯一并外键指向 `formal_agent_runs ON DELETE CASCADE`。`presented_at=NULL` SHALL 表示已请求但尚未呈现；非空 SHALL 表示已非模态呈现。关闭报告自动呈现偏好 MUST NOT 删除既有行。

#### Scenario: 合格终态会话首次自动请求纪要

- **WHEN** 报告自动呈现偏好已开启且未来一个合格终态会话首次被对账
- **THEN** 系统先为该 `session_id` 建立一条 presentation receipt 和一个 `summary.minutes` run，且不建立第二行

#### Scenario: renderer reload 恢复未呈现报告

- **WHEN** receipt 已存在且 `presented_at=NULL` 时 renderer reload
- **THEN** 系统恢复同一 run 的非模态呈现，成功后填充同一行 `presented_at`，不创建新报告或未读计数

#### Scenario: 重复停止与重复通知

- **WHEN** 同一终态会话被重复停止通知、启动扫描和 reply-loss 重放命中
- **THEN** `session_id` 主键只允许恢复既有 receipt/run，自动请求与呈现均至多一次

### Requirement: 会话删除必须级联 v7 与个人上下文事实并返回计数

会话删除事务 SHALL 在 tombstone 写入后删除引用该会话的 formal runs/interactions、由 interaction 级联的 tool calls、report presentation receipt、personal-context episodes/evidence 与已登记孤儿条目，并累计 `deleted_interaction_count`、`deleted_tool_call_count`、`deleted_report_presentation_count` 及 v5 既有计数。v7 MUST 只新增 `deleted_report_presentation_count INTEGER NOT NULL DEFAULT 0 CHECK >=0`，MUST NOT 重复增加 v5 的 interaction/tool 列。

相同 deletion idempotency key 与 request digest 重放 SHALL 返回首次计数；删除后任何迟到 interaction/tool/presentation/ingest 提交 MUST fail closed。tombstone MUST NOT 保存正文、设备名、路径或绝对单调时刻。

#### Scenario: 删除含交互和自动报告的会话

- **WHEN** 一个会话关联面向用户 interaction、配套 route interaction、tool calls、presentation receipt、episode/evidence 与孤儿条目
- **THEN** 单个删除事务清理全部关联事实并返回各类精确计数，字幕删除与 tombstone 同成同败

#### Scenario: 删除回复丢失后重放

- **WHEN** 首次删除已提交但回复丢失，调用方以相同 key/digest 重试
- **THEN** 系统返回首次计数，不重新清理其它会话也不把计数归零

#### Scenario: 删除后迟到模型结果

- **WHEN** 已删除会话的旧 utility generation 返回最终结果或工具结果
- **THEN** writer 因 tombstone/run 终态拒绝提交，不重建 interaction、presentation、episode 或个人记忆

### Requirement: recipes.js 必须是 recipe 合同的唯一定义点

系统 SHALL 在 `src/agent/contracts/recipes.js` 静态登记且只登记 `intent.route`、`context.ingest.session`、`context.ingest.interaction`、`qa.answer`、`extract.items`、`summary.minutes`、`report.analysis`、`plan.proposal`、`text.enhance`、`text.rewrite`、`text.translate` 十一项。每项 MUST exact 冻结 `recipeId/recipeVersion/inputScopes/modelPurpose/maxTurns/toolGrants/outputSchemaId/persistence/artifactType/failurePolicy`；首版 `recipeVersion` MUST 为 `'1'`。同一 identity/version 的轮次与工具授权 MUST 恒定。

执行宿主、model-access、storage、main、IPC、fixture 和测试 MUST 消费同一登记模块，不得复制第二套可执行闭集。未登记 recipe 或版本 MUST 在创建期以 `AGENT_REQUEST_INVALID` fail closed，且不得扩张九值 Agent 处理资格闭集。

#### Scenario: 读取完整登记表

- **WHEN** 执行宿主启动并读取 recipe catalog
- **THEN** 恰好得到十一项冻结登记，所有 ID/version 唯一且每项字段 exact 完整

#### Scenario: 未登记 recipe 请求

- **WHEN** submit、claim 或 storage reply 携带闭集外 `recipeId` 或未知 `recipeVersion`
- **THEN** 系统在调用模型、工具或 writer 前返回 `AGENT_REQUEST_INVALID`，零运行、零绑定、零 interaction

#### Scenario: 模块复制登记后漂移

- **WHEN** model-access policy、runtime 或 fixture 自带的 recipe 字面量与 `recipes.js` 不一致
- **THEN** contract/module graph 测试失败，复制表不得成为生产路径

### Requirement: 所有 recipe 必须走唯一有界 Agent Loop

系统 SHALL 对十一个 recipe 都调用同一个 Pi `agentLoop()` 执行入口，并以 deterministic `shouldStopAfterTurn` 同时执行 recipe 登记轮次上限和已生效预算停止条件。运行期 MUST NOT 基于输入长度、范围、个人上下文包命中、confidence、模型输出或工具结果改变 `maxTurns/toolGrants`。系统 MUST NOT 实现 `single_shot` 第二路径、运行期升级、`prepareNextTurn` 换模型、`agentLoopContinue()` 中途恢复或递归委派。

`intent.route/text.rewrite/text.translate` SHALL 为 1 轮 0 工具；`context.ingest.session/context.ingest.interaction/qa.answer/extract.items/summary.minutes/text.enhance` SHALL 为 3 轮且只授权 `search_context`；`report.analysis/plan.proposal` SHALL 为 6 轮且授权 `search_context/read_sources`。

#### Scenario: 1 轮 recipe 尝试继续

- **WHEN** `text.rewrite` 完成第一轮后模型上下文仍请求下一轮
- **THEN** `shouldStopAfterTurn` 确定性停止，运行不得进入第二轮且工具记录为空

#### Scenario: 3 轮 recipe 越权 read_sources

- **WHEN** `qa.answer` 在任一 turn 请求 `read_sources`
- **THEN** 工具授权守卫以 `TOOL_NOT_AVAILABLE_FOR_RECIPE` 拒绝且不执行，不把授权扩张为双工具

#### Scenario: 6 轮 recipe 运行时降档

- **WHEN** `report.analysis` 输入只含一个短选区
- **THEN** 登记仍为 `maxTurns=6` 与双工具授权；运行可以较早自然收束，但不得重写登记快照或改判执行形态

### Requirement: bind 与预算必须只接受统一执行路径

Agent 模型接入层 `bind(runRequest)` SHALL 继续只接受 exact `runId/recipeId/recipeVersion/executionForm`，但 `executionForm` MUST 只接受 `'agent_loop'`。其它值 MUST 以 `AGENT_REQUEST_INVALID` fail closed。v6 `agent_model_run_bindings.execution_form` SHALL 保留并恒为 `'agent_loop'`，MUST NOT 进入 interaction、UI 或导出。

`deriveBudget()` SHALL 从 recipe 登记的 `maxTurns/toolGrants`、模型能力与 `requestedBy` 推导十轴；第 1 轴 MUST 等于登记 `maxTurns`，不得从 execution form 推导。只有 `toolGrants` 非空的 recipe SHALL 要求 `supportsToolCalling=true`。用量未知时累计计费 input/output 两轴不评估，其余八轴 MUST 继续执法。

#### Scenario: bind 收到 single_shot

- **WHEN** 任意调用方提交 `executionForm='single_shot'`
- **THEN** model-access 返回 `AGENT_REQUEST_INVALID`，不写 binding、不借凭据且不调用 provider

#### Scenario: 0 工具 recipe 使用不支持工具的 model

- **WHEN** `text.translate` 解析到 `supportsToolCalling=false` 但其它能力和凭据有效的 model
- **THEN** bind 可成功，因为该 recipe 的 `toolGrants=[]`

#### Scenario: search_context recipe 使用不支持工具的 model

- **WHEN** `summary.minutes` 解析到 `supportsToolCalling=false` 的 model
- **THEN** readiness 为 `provider_not_configured`，绕过资格直接 bind 时以 `AGENT_REQUEST_INVALID` 拒绝

#### Scenario: 第 1 轴登记快照

- **WHEN** `qa.answer` 建立模型运行绑定与 interaction
- **THEN** budget `maxTurns` 与 interaction `max_turns` 都为 3，并可追溯到同一 recipe 登记

### Requirement: 共享输出引用与边界必须 exact

所有 recipe 最终结果 SHALL 是带 `schemaVersion: 1` 的 exact JSON object。`SourceRefV1` MUST 恰好为 `{ sessionId, transcriptVersion, fromEventOrder, throughEventOrder }`，其中 `transcriptVersion` 只允许 `raw/refined` 且 event order 是非负有序整数。`MemoryRefV1` MUST 恰好为 `{ memoryId, revisionId }`。`InteractionSignalRefV1` MUST 恰好为 `{ interactionId, signalKind }`，`signalKind` 只允许 `prompt/edit/accept/reject/remember/forget`。

字符串上限 SHALL 按 Unicode code point 计，serialized object/array 上限 SHALL 按 canonical JSON UTF-8 字节计。额外键、缺键、错误类型、未知枚举、越界长度、重复稳定 ID、无序/重叠 source range 或 digest 不一致 MUST 以 `AGENT_OUTPUT_INVALID` fail closed。

#### Scenario: sourceRef 使用未登记 transcriptVersion

- **WHEN** 模型结果含 `transcriptVersion='current'`
- **THEN** exact validator 返回 `AGENT_OUTPUT_INVALID`，不把显示选择伪装成来源版本

#### Scenario: Unicode 边界

- **WHEN** 一个字符串正好达到 code point 上限且包含 surrogate pair
- **THEN** validator 按 code point 接受完整字符；超过上限时拒绝而不是切断 surrogate pair

#### Scenario: 引用带额外正文

- **WHEN** `sourceRef` 附带 `text`、音频路径、设备名或本地绝对路径
- **THEN** exact validator 拒绝整个结果，引用只保留身份与范围

### Requirement: intent.route 必须输出恰好 recipeId 与 confidence

`intent.route@1` SHALL 只接受用户原始提示的有界内存值与选区/终态会话/日期范围/项目的最小冻结范围身份，映射默认模型用途，固定 `maxTurns=1/toolGrants=[]`。输出 Schema MUST 恰好为 `{ recipeId, confidence }`：`recipeId` MUST 是其它十项之一，`confidence` MUST 是 0..1 的有限数。该运行 SHALL 写 run/binding/interaction 审计，但 SHALL 无产物类型且 MUST NOT 出现在用户可见历史/导出列表投影中。

输出 invalid、provider/budget/worker/internal 失败 SHALL 触发已登记规则兜底；用户取消 SHALL 直接取消且不兜底。

#### Scenario: 模型返回合法 route

- **WHEN** `intent.route` 返回 exact `{recipeId:'summary.minutes', confidence:0.83}`
- **THEN** route interaction 成功保存，面向用户的新运行选择 `summary.minutes` 并写 `routing_mode='model'`

#### Scenario: route 结果带候选数组

- **WHEN** 模型返回 `recipeId/confidence` 之外的 `alternatives` 或解释字段
- **THEN** 输出以 `AGENT_OUTPUT_INVALID` 收束，不持久化解释，并进入确定性规则兜底

#### Scenario: route 返回自身

- **WHEN** 模型返回 `recipeId='intent.route'`
- **THEN** 结果视为闭集外目标并触发规则兜底，不递归创建 route

### Requirement: context.ingest.session 必须两段式摄取终态会话

`context.ingest.session@1` SHALL 只接受单个终态会话的完整提交水位、权威原始转写，或用户明确选择且整场 `N=M` 的精修稿；映射信息提取用途，固定 `maxTurns=3/toolGrants=['search_context']`。runner MUST 先以零模型调用建立或重放 episode 骨架的时间范围、source refs、水位与 digest，再进入统一 Loop。

输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  experiences: Array<=64<{
    kind: 'decision'|'conclusion'|'todo'|'risk'|'topic'|'event',
    text: string<=300,
    evidence: SourceRefV1,
    confidence: 'low'|'medium'|'high'
  }>,
  memoryCandidates: Array<=128<{
    scopeKind: 'global'|'session'|'topic'|'project',
    scopeKeyProposal: string<=64|null,
    kind: 'decision'|'conclusion'|'todo'|'term'|'preference'|'project_fact'|'experience',
    content: string<=512,
    confidence: 'low'|'medium'|'high',
    salience: 'low'|'medium'|'high',
    evidence: SourceRefV1
  }>
}
```

输出 MUST NOT 含 `semanticKey`；storage worker SHALL 从 `content` 派生。成功 SHALL 原子更新 episode/个人记忆/revision/evidence，不产生产物。Schema、预算、provider 或提交失败 SHALL 不提交候选，但 MUST 保留可重放骨架与原 run 身份。

#### Scenario: 终态会话正常摄取

- **WHEN** 一个终态会话有非空完整提交水位且模型返回通过 Schema 的 experiences/candidates
- **THEN** 相同 run 内的确定性骨架与模型候选原子收束，重复运行身份不增加第二条 episode

#### Scenario: 精修覆盖不完整

- **WHEN** 请求选择精修稿但该会话 `N!=M`
- **THEN** runner 回落权威原始转写完整水位且单会话不混合 `raw/refined`

#### Scenario: 模型返回 semanticKey

- **WHEN** memory candidate 带 `semanticKey`
- **THEN** exact validator 返回 `AGENT_OUTPUT_INVALID`；模型不得选择 storage 去重键

#### Scenario: 零条首次稳定转写

- **WHEN** 终态会话没有首次稳定转写
- **THEN** 资格为 `no_committed_transcript`，不创建模型调用、personal-context candidate 或产物

### Requirement: context.ingest.interaction 必须只消费正式交互信号闭集

`context.ingest.interaction@1` SHALL 只接受一条终态正式 Agent 交互、其 recipe/来源范围/结果版本与 `prompt/edit/accept/reject/remember/forget` 交互记忆信号；映射信息提取用途，固定 `maxTurns=3/toolGrants=['search_context']`。普通点击、停留、滚动、浏览、窗口焦点、复制、调试聊天、内部工具事件和未被用户采纳的模型输出 MUST NOT 成为输入。

输出 Schema 与 `context.ingest.session@1` 相同，但每个 `evidence` MUST 是 exact `InteractionSignalRefV1`。成功 SHALL 原子写 interaction episode 与个人记忆候选，不产生产物；失败 SHALL 保留原正式 interaction 与可重放骨架，不写部分个人记忆。

#### Scenario: 用户明确接受结果

- **WHEN** 正式交互成功终态且用户产生 `accept` 信号
- **THEN** runner 建立 interaction episode 骨架并允许模型从该受信任信号提炼候选

#### Scenario: 普通复制动作

- **WHEN** 用户只复制结果但没有 edit/accept/reject/remember/forget
- **THEN** 零交互记忆信号、零 `context.ingest.interaction` 运行、零个人记忆变化

#### Scenario: 未采纳模型输出成为候选

- **WHEN** 模型输出未被用户接受或编辑却出现在摄取请求
- **THEN** exact source/signals contract 拒绝该来源，不把模型自己的生成物伪装成用户事实

### Requirement: qa.answer 必须返回有来源的即时回答

`qa.answer@1` SHALL 接受选区、终态会话、日期范围或项目的冻结个人上下文包，映射默认用途，固定 `maxTurns=3/toolGrants=['search_context']`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  answer: string<=4000,
  sourceRefs: SourceRefV1[<=16],
  memoryRefs: MemoryRefV1[<=16],
  unresolved: string<=300[<=5]
}
```

成功 SHALL 只保存 interaction `result_json/result_digest`，MUST NOT 自动成为报告或个人记忆。Schema/预算/provider/工具/提交失败 SHALL 按任务错误码收束且不保存部分 answer。

#### Scenario: 有来源的回答

- **WHEN** 模型在冻结个人上下文包中找到来源并返回 exact answer
- **THEN** interaction 保存回答与受限引用，不创建 report artifact

#### Scenario: 问题仍有未知项

- **WHEN** 冻结范围不足以回答全部问题
- **THEN** 模型把未知项写入 `unresolved`，不得编造来源或从范围外读取

### Requirement: extract.items 必须只保存结构化提取结果

`extract.items@1` SHALL 只接受用户选区或单个终态会话，映射信息提取用途，固定 `maxTurns=3/toolGrants=['search_context']`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  items: Array<=100<{
    kind: 'decision'|'todo'|'risk'|'term'|'entity'|'question',
    text: string<=300,
    sourceRefs: SourceRefV1[<=4],
    confidence: 'low'|'medium'|'high'
  }>
}
```

成功 SHALL 只保存 interaction result，MUST NOT 新增产物类型，也 MUST NOT 复用 `reference-output`。失败 SHALL 不提交部分 items。

#### Scenario: 提取待办与风险

- **WHEN** 用户在一个终态会话上请求提取事项且输出通过 Schema
- **THEN** interaction 保存 items 与来源引用，不创建 artifact 或个人记忆

#### Scenario: 实现试图写 reference-output

- **WHEN** writer 为 `extract.items` 指定 `artifactType='reference-output'`
- **THEN** recipe/artifact registry 以 `AGENT_REQUEST_INVALID` 拒绝，隔离开发入口产物类型不得进入正式路径

### Requirement: summary.minutes 必须生成固定栏目会后结构化纪要

`summary.minutes@1` SHALL 只接受单个终态会话的完整提交水位，映射摘要与总结用途，固定 `maxTurns=3/toolGrants=['search_context']`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  overview: string<=2000,
  conclusions: Array<=30<{text:string<=300, sourceRefs:SourceRefV1[<=4]}>,
  todos: Array<=50<{
    text:string<=300, ownerHint:string<=64|null,
    dueHint:string<=64|null, sourceRefs:SourceRefV1[<=4]
  }>,
  risks: Array<=30<{text:string<=300, sourceRefs:SourceRefV1[<=4]}>
}
```

缺少某栏目内容时 SHALL 返回空数组而不是省略键。成功 SHALL 保存 `meeting-minutes`；待办只生成文字，MUST NOT 执行或写入外部待办系统。失败 SHALL 不提交部分纪要或 presentation success。

#### Scenario: 用户明确请求纪要

- **WHEN** 用户对一个终态会话明确请求会后结构化纪要
- **THEN** 系统生成四个固定栏目并保存 `meeting-minutes` 产物版本

#### Scenario: 没有待办

- **WHEN** 来源没有可支持的待办
- **THEN** 输出 `todos=[]`，不得省略字段或编造待办

#### Scenario: 自动报告偏好关闭

- **WHEN** 报告自动呈现偏好为关闭且会话刚进入终态
- **THEN** 默认只允许 personal-context 摄取，不自动创建 `summary.minutes` run 或 presentation receipt

### Requirement: report.analysis 必须保存版本化分析报告

`report.analysis@1` SHALL 接受选区、终态会话、日期范围或项目，映射分析与规划用途，固定 `maxTurns=6/toolGrants=['search_context','read_sources']`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  title: string<=120,
  summary: string<=2000,
  findings: Array<=30<{
    text:string<=600,
    evidence:Array<=8<SourceRefV1|MemoryRefV1>
  }>,
  timeline: Array<=60<{
    label:string<=64, ref:SourceRefV1, text:string<=300
  }>,
  assumptions: string<=300[<=10],
  gaps: string<=300[<=10]
}
```

成功 SHALL 以新产物类型 `analysis-report` 版本化保存。个人上下文包中的省略标记 MUST 映射到 `gaps`，不得静默声称完整。失败 SHALL 不提交部分报告。

#### Scenario: 跨会话分析

- **WHEN** 用户对日期范围请求分析且模型按受控工具回溯多个来源
- **THEN** 系统保存一个 `analysis-report` 版本，findings/timeline 引用仍限制在冻结范围

#### Scenario: 范围含未定稿尾部

- **WHEN** 冻结个人上下文包含 `not_committed_tail` 省略标记
- **THEN** 输出在 `gaps` 如实登记该缺口，不读取 partial 或静默宣称全量覆盖

#### Scenario: 双工具授权被运行时缩减

- **WHEN** 输入较短且执行宿主准备移除 `read_sources` 授权
- **THEN** 登记快照仍保留双工具；模型可不调用该工具，但宿主不得运行期改变授权

### Requirement: plan.proposal 必须保存事实与假设分离的规划建议

`plan.proposal@1` SHALL 接受选区、终态会话、日期范围或项目的冻结个人上下文包与用户输入约束，映射分析与规划用途，固定 `maxTurns=6/toolGrants=['search_context','read_sources']`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  objective: string<=300,
  facts: Array<=20<{text:string<=300, ref:SourceRefV1|MemoryRefV1}>,
  assumptions: string<=300[<=10],
  plan: Array<=40<{
    step:integer>=1, text:string<=300,
    whenHint:string<=64|null, dependsOn:integer[<=4]
  }>,
  alternatives: Array<=5<{text:string<=300, tradeoff:string<=300}>,
  openQuestions: string<=300[<=10]
}
```

`step` MUST 从 1 连续递增，`dependsOn` 只能引用较小且存在的 step。成功 SHALL 以新产物类型 `planning-proposal` 保存。省略标记 MUST 映射到 `openQuestions`。首版 MUST NOT 写入日历、待办、邮件、预订或其它外部系统；失败 SHALL 不提交部分规划建议。

#### Scenario: 基于项目范围生成规划建议

- **WHEN** 用户为一个项目范围提供目标与约束且输出通过 Schema
- **THEN** 系统保存一个 `planning-proposal`，事实带引用、假设单列、步骤依赖有序

#### Scenario: 步骤依赖未来步骤

- **WHEN** step 2 的 `dependsOn` 引用 step 3
- **THEN** 输出以 `AGENT_OUTPUT_INVALID` 收束，不保存循环或前向依赖计划

#### Scenario: 规划输出含执行动作

- **WHEN** 模型结果请求创建日历事件或发送邮件
- **THEN** exact output/permission contract 拒绝外部写操作，只允许结构化文字草案

### Requirement: text.enhance 必须生成独立增强文本

`text.enhance@1` SHALL 只接受单个终态会话的完整权威原始转写，或用户明确选择且整场 `N=M` 的精修稿，映射摘要与总结用途，固定 `maxTurns=3/toolGrants=['search_context']`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  segments: Array<{
    segmentId:string<=160,
    enhancedText:string<=2000
  }>,
  notes: string<=500|null
}
```

`segments` MUST 对冻结水位内每个输入字幕段恰好一项、顺序一致、无遗漏/重复/新增 ID。成功 SHALL 保存 `enhanced-transcript`，并记录输入水位/digest/model；MUST NOT 覆盖首次稳定转写或精修稿。长输入的所有分块与归并都成功后才能提交；失败 SHALL 零部分产物。

#### Scenario: 完整增强终态会话

- **WHEN** 模型为冻结水位内每个字幕段返回唯一增强文本
- **THEN** 系统保存独立 `enhanced-transcript`，权威原始转写逐字节不变

#### Scenario: 缺少一个字幕段

- **WHEN** 输出 segments 少于冻结输入段集合
- **THEN** Schema/coverage 校验返回 `AGENT_OUTPUT_INVALID`，不提交部分增强文本

#### Scenario: 精修覆盖不完整

- **WHEN** 用户选择精修稿但整场 `N!=M`
- **THEN** 输入回落权威原始转写完整水位，不把混合显示正文伪装成完整精修输入

### Requirement: text.rewrite 必须在一轮内改写选区

`text.rewrite@1` SHALL 只接受用户明确选区，映射默认用途，固定 `maxTurns=1/toolGrants=[]`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  style: 'concise'|'formal'|'casual'|'bulleted',
  text: string<=4000,
  sourceRefs: SourceRefV1[<=8]
}
```

成功 SHALL 只保存 interaction result，不创建产物或修改来源。第一轮输出 invalid SHALL 直接以 `AGENT_OUTPUT_INVALID` 收束，不得以“修复 Schema”为由进入第二轮。失败 SHALL 不保存部分文本。

#### Scenario: 正式语气改写

- **WHEN** 用户选中已提交文本并请求正式语气
- **THEN** 一轮内返回 `style='formal'` 的独立文本，工具记录为空且来源不变

#### Scenario: 第一轮输出缺字段

- **WHEN** 模型第一轮没有返回 `sourceRefs`
- **THEN** 运行失败为 `AGENT_OUTPUT_INVALID`，不开始第二轮或补造字段

### Requirement: text.translate 必须保留来源修订关系

`text.translate@1` SHALL 接受用户明确选区或单个终态会话，映射默认用途，固定 `maxTurns=1/toolGrants=[]`。输出 Schema MUST 恰好为：

```text
{
  schemaVersion: 1,
  targetLanguage: string<=35,
  basedOnRevision: string<=160,
  segments: Array<{
    segmentId:string<=160,
    translatedText:string<=2000
  }>
}
```

`targetLanguage` MUST 是 canonical BCP-47 tag，`basedOnRevision` MUST 等于冻结输入版本身份，segments MUST 完整覆盖输入选区/会话段集合。成功 SHALL 只保存 interaction result；整场翻译产物类型后置。翻译 MUST NOT 修改原文。Schema/coverage 失败 SHALL 不保存部分译文，且不得进入第二轮。

#### Scenario: 翻译用户选区

- **WHEN** 用户选择已提交文本并请求 `zh-Hans`
- **THEN** 系统一轮返回基于冻结 revision 的完整译文，工具记录为空且原文不变

#### Scenario: 非 canonical 语言标签

- **WHEN** 输出 `targetLanguage` 不是可接受的 canonical BCP-47 tag
- **THEN** 运行以 `AGENT_OUTPUT_INVALID` 收束，不猜测目标语言

#### Scenario: 整场翻译试图写产物

- **WHEN** writer 为 `text.translate` 请求未登记的 translation artifact type
- **THEN** artifact registry fail closed，首版只保留 interaction result

### Requirement: 输出校验与失败策略必须对十一 recipe 一致

执行宿主 SHALL 在任何受控 writer 前使用登记 `outputSchemaId` 的 exact validator 校验最终结果与引用/digest/coverage。输出不满足 Schema MUST 以 `AGENT_OUTPUT_INVALID` 进入 `failed`；预算超限 MUST 以 `AGENT_BUDGET_EXCEEDED` 进入 `failed`；未登记/非法请求 MUST 在创建期以 `AGENT_REQUEST_INVALID` fail closed；权限失败 MUST 使用任务或工具各自独立错误码。以上失败 MUST 不提交产物、部分结果或伪造 success。

provider 鉴权、限流、不可用、超时、worker 退出与内部失败 SHALL 映射到十值任务错误码闭集。只有已登记可重试错误可在 `max_attempts` 内以同一 run/binding/input 整体重跑。`AGENT_OUTPUT_INVALID`、`AGENT_BUDGET_EXCEEDED`、权限与请求错误 MUST 不自动重试。任一失败 MUST NOT 降低字幕系统。

#### Scenario: 最终结果带未知键

- **WHEN** 任一 recipe 输出 Schema 外字段
- **THEN** exact validator 返回 `AGENT_OUTPUT_INVALID`，writer 零调用

#### Scenario: 长输入归并失败

- **WHEN** 所有输入分块都已处理但最终归并失败或缺失一块
- **THEN** run 失败且零部分 interaction success/产物，不把已完成分块持久化为模型结果

#### Scenario: provider 限流后重试

- **WHEN** attempt 1 以 `AGENT_PROVIDER_RATE_LIMITED` 收束且仍有 attempt 预算
- **THEN** attempt 2 复用同一 `runId`、binding、冻结输入和 recipe 快照整体重跑

#### Scenario: 输出 Schema 错误不重试

- **WHEN** 最终输出以 `AGENT_OUTPUT_INVALID` 收束
- **THEN** 运行直接进入失败终态，不换模型、不建立新 attempt 或产物

### Requirement: 模型判定路径必须写 routing_mode model

用户经 Agent Bar 发起自然语言意图时，系统 SHALL 先冻结范围并创建真实 `intent.route` run/binding/interaction。route 成功返回其它十项 recipe 后，系统 SHALL 创建面向用户的新 run，并在其 interaction 写 `routing_mode='model'`。route 与目标运行 MUST 使用各自 `runId`、binding、用量与终态；不得在 `bind()` 前裸调用模型。

界面 MUST 只呈现产品语言，不展示 route recipe ID、confidence、`routing_mode` 或判定过程。

#### Scenario: 模型判定问答

- **WHEN** route 在有效资格下返回 `qa.answer`
- **THEN** 系统创建独立 `qa.answer` run，目标 interaction 写 `routing_mode='model'`，route interaction 不进入用户历史列表

#### Scenario: route 与目标模型用途不同

- **WHEN** route 使用默认用途而目标为 `report.analysis`
- **THEN** 两个 run 各自通过 model-access 冻结绑定，目标使用分析与规划用途，不复用 route binding

### Requirement: 五类触发条件必须进入确定性规则兜底

系统 SHALL 在且只在以下五类条件之一成立时，从 `intent.route` 回落到确定性规则：一，Agent 处理资格不为 `ready`；二，route 以任一 `AGENT_PROVIDER_*` 收束；三，route 以 `AGENT_OUTPUT_INVALID` 或 `AGENT_BUDGET_EXCEEDED` 收束；四，route 以 `AGENT_WORKER_EXITED` 或 `AGENT_INTERNAL_FAILURE` 收束；五，成功结果的 `recipeId` 不在其它十项闭集内。规则 SHALL 只消费冻结范围类型与受控关键词，按固定优先级返回已登记 recipe；全部不匹配 MUST 返回 `qa.answer`。目标 interaction MUST 写 `routing_mode='rules'`。

用户取消 route MUST NOT 触发兜底。低 confidence 但其它字段合法 MUST NOT 作为第六类触发条件；首版无 confidence 阈值、重试、投票或确认门。

#### Scenario: 资格不为 ready

- **WHEN** route 的 Agent 处理资格为 `credential_unavailable`
- **THEN** 系统不调用 route provider，直接运行确定性规则并选择一个目标 recipe

#### Scenario: provider 系列错误

- **WHEN** route 以 `AGENT_PROVIDER_TIMEOUT` 收束且不再重试
- **THEN** 系统进入规则兜底，目标 interaction 写 `rules`

#### Scenario: output 或预算错误

- **WHEN** route 以 `AGENT_OUTPUT_INVALID` 或 `AGENT_BUDGET_EXCEEDED` 收束
- **THEN** 系统进入同一确定性规则路径，不创建第三种收敛方式

#### Scenario: worker 或内部错误

- **WHEN** route 以 `AGENT_WORKER_EXITED` 或 `AGENT_INTERNAL_FAILURE` 收束
- **THEN** 系统进入规则兜底，字幕系统和冻结范围不变

#### Scenario: 闭集外 recipeId

- **WHEN** route 成功对象的 `recipeId` 为未登记值或 `intent.route`
- **THEN** 系统按第五类条件进入规则兜底，不执行闭集外 recipe

#### Scenario: 规则全部不匹配

- **WHEN** 冻结范围和受控关键词均不命中任何特定规则
- **THEN** 结果确定为 `qa.answer`，收敛没有失败态或无下一步提示

#### Scenario: 低 confidence 合法输出

- **WHEN** route 返回闭集内 recipe 且 `confidence=0.01`
- **THEN** 系统仍采用模型判定并写 `model`，不得用未登记阈值触发兜底

#### Scenario: 用户取消 route

- **WHEN** 用户在 route 运行期间取消
- **THEN** route 进入取消终态，不运行规则也不创建目标 run

### Requirement: 预置路径与用户改选必须建立可追溯新运行

`context.ingest.session`、`context.ingest.interaction` 与报告自动呈现偏好开启后的自动 `summary.minutes` 请求 SHALL 在创建时已知 recipe，MUST 写 `routing_mode='preset'` 且 MUST NOT 创建 `intent.route`。用户改选已经呈现的收敛结果 SHALL 按“取消当前运行 + 新建运行”处理，创建新 `runId`、新模型运行绑定、新 interaction 与适用的新产物版本；原运行/interaction/tool records MUST 保持不可变。

#### Scenario: 自动摄取预置 recipe

- **WHEN** 合格终态会话创建 `context.ingest.session`
- **THEN** 只创建一个 preset run，零 route run，自动路径运行数不因意图收敛增加

#### Scenario: 用户从分析改选为规划

- **WHEN** 当前 `report.analysis` 尚在运行且用户改选规划建议
- **THEN** 系统请求取消原 run 并新建 `plan.proposal` run/binding，两个运行身份与产物版本不混写

#### Scenario: 改选试图原地修改 recipe

- **WHEN** renderer 或 main 试图把既有 run 的 `recipe_id` 从分析改成规划
- **THEN** immutable run/interaction contract 拒绝改写，必须走新 run

### Requirement: 取消必须是允许空结果的不可逆终态

取消 SHALL 是协程式终态。取消信号 MUST 贯穿当前模型请求、Pi Loop 与工具调用；确认取消后 MUST 不再开始新 turn、新模型请求或新工具调用，runtime 整体收束并释放租约。已发生 attempt 与工具调用记录 SHALL 保留。取消 interaction MUST `terminal_reason='cancelled'`、`error_code=NULL`，结果可空且 MUST NOT 补造。取消后任何恢复扫描 MUST NOT 复活 run。

writer SHALL 在同一事务内复核 run/interaction terminal state、attempt 与 utility/storage generation。取消收束后的迟到成功、失败、usage 或工具结果 MUST 拒绝，且 MUST NOT 改写 result、digest、usage、duration、attempt、binding、presentation 或个人上下文。

#### Scenario: 模型请求期间取消

- **WHEN** 用户在模型请求在途时取消可见运行
- **THEN** 同一取消 signal 传播到 provider，运行在检查点收束为 cancelled 且不发下一请求

#### Scenario: 工具调用期间取消

- **WHEN** 用户在 `search_context` 执行期间取消
- **THEN** 工具在检查点以 `TOOL_CANCELLED` 收束，已发生调用记录保留，运行取消且不调用新工具

#### Scenario: 取消后迟到成功

- **WHEN** provider 在 interaction 已取消后返回一个合法最终结果
- **THEN** writer 拒绝迟到结果，取消快照逐字段不变

#### Scenario: 重启恢复已取消 run

- **WHEN** 应用重启扫描到 cancelled run
- **THEN** scheduler 不领取、不重试、不补产物，只保留终态历史

### Requirement: 自动重试与恢复必须整体重跑同一冻结身份

可重试 provider/worker 错误的恢复 SHALL 在同一 `runId`、同一模型运行绑定、同一 recipe 登记快照、同一范围/水位/digest/个人记忆 revision 集合与同一输入下递增 attempt 并整体重跑。Loop MUST NOT 持久化或恢复中间 assistant 文本、模型上下文、turn cursor 或 continuation token，MUST NOT 使用 `agentLoopContinue()`。旧 attempt 工具记录 MUST 保留。

S3 SHALL 复用 S1 的 claim idempotency key、request digest、lease、reply-loss、wakeEpoch 与 single-owner scheduler，不新建第二任务/租约协议。storage worker replacement 后必须先重放当前 recipe 闭集/策略再领取。

#### Scenario: provider 结果前 utility 退出

- **WHEN** utility 在 attempt 内退出且错误可重试
- **THEN** run 保持同一 binding/input，旧 attempt 收束并在下一 attempt 从冻结输入起点整体重跑

#### Scenario: claim 回复丢失

- **WHEN** claim 已提交但 main 未收到 reply
- **THEN** 相同 logical claim key/digest 只返回原 run/lease，不顺序领取另一个 run

#### Scenario: 配置在重试前改变

- **WHEN** 用户修改用途或 model 后旧 run 自动重试
- **THEN** 旧 run 继续使用原 binding；只有用户主动重新运行才建立新 `runId`

### Requirement: 两段式摄取不得推倒 S1 运行租约与幂等事实

`context.ingest.session/context.ingest.interaction` 的确定性前段 SHALL 位于各自 recipe runner 内，零模型调用地建立 episode 骨架、来源范围、水位、digest 与原 run/attempt 身份。模型提炼 SHALL 随后进入统一 Agent Loop。相同来源 identity/digest 的重放 MUST 只恢复同一 episode/run，不新增计数。模型候选通过个人上下文模块现有范围、冲突、置信、生命周期、suppression 与预算规则后原子提交。

storage worker SHALL 从 candidate `content` 按“正文 → NFKC → casefold → 连续空白折叠为 U+0020 → 去首尾 → code point 边界截到 <=256 UTF-8 字节”派生 `semantic_key`。模型、recipe、renderer 与 preload MUST NOT 提交该键。任何个人上下文条目 MUST NOT 写入 `recognition_*` 或影响识别 provider。

#### Scenario: 确定性前段成功、模型失败

- **WHEN** episode 骨架已建立而模型以 provider error 收束
- **THEN** 骨架与 run 保持可重放，零个人记忆候选提交且不新建第二 episode

#### Scenario: 相同来源整体重试

- **WHEN** 同一 run/来源/digest 在新 attempt 重跑并成功
- **THEN** 原 episode 被幂等收束，个人记忆提交一次，运行/租约 identity 不变

#### Scenario: 自动候选命中被忘记条目

- **WHEN** 模型候选对应一个已被用户“忘记”的个人记忆
- **THEN** 自动摄取不得静默恢复；只有用户后续明确“记住”或修改可恢复

#### Scenario: term 候选影响 ASR

- **WHEN** 摄取产生 `kind='term'` 的个人记忆候选
- **THEN** 它只影响 Agent 产物，不写四张废案识别表、不创建会话关键词快照

### Requirement: ModelUsageV1 必须只来自 provider 或整体未知

`ModelUsageV1` SHALL 恰好包含非负 `inputTokens/outputTokens`、`usageSource='provider'` 与可空 `cacheHitInputTokens/cacheMissInputTokens`。`MODEL_USAGE_SOURCES` MUST 恰好为 `['provider']`。provider 未返回完整可用 usage 或 model 的 `usageReporting=false` 时，interaction `usage_json` MUST 为 SQL `NULL`；产品 MUST NOT 估算、补造或显示 token 数，UI/历史/fixture SHALL 显示「用量未知」。

缓存字段只有在 provider 同时返回非负 hit/miss、两者和大于零且等于 input token 时保存；否则二者均为 null。缓存命中率 SHALL 查询时派生而不持久化。用量未知时累计计费 input/output 两轴不评估，其余八轴继续执法。所有投影 MUST NOT 含金额字段。

#### Scenario: provider 返回完整 usage

- **WHEN** provider 返回 input=1000、output=200、cache hit=250、miss=750
- **THEN** interaction 保存 exact provider usage，缓存命中率可派生为 25%，且无金额字段

#### Scenario: provider 不返回 usage

- **WHEN** 模型结果合法但 provider 缺少 input/output usage
- **THEN** `usage_json=NULL`，结果仍可成功，界面显示「用量未知」而不是估算数字

#### Scenario: usageReporting false

- **WHEN** 绑定 model 声明 `usageReporting=false`
- **THEN** model 仍可运行，interaction 用量整体为空且不能参与用量比较

#### Scenario: estimated usage 输入

- **WHEN** 任意 adapter、fixture 或 writer 提交 `usageSource='estimated'`
- **THEN** exact validator 拒绝，不持久化或展示该估算

### Requirement: comparison_group_id 必须按 canonical 四元组计算

执行宿主 SHALL 从 exact `[recipe_id, recipe_version, scope_digest, input_digest]` 计算 RFC 8785 canonical JSON UTF-8 字节的 SHA-256 小写十六进制，并保存为 `comparison_group_id`。renderer、provider、recipe 或模型提交的 digest MUST NOT 成为权威值。模型身份、run ID、interaction ID、usage 与时长 MUST NOT 进入比较组 digest。

#### Scenario: 同源主动换模型

- **WHEN** 用户对相同 recipe/version/scope/input 主动换模型并创建新 run
- **THEN** 两个 interaction 的 `comparison_group_id` 相同，binding/model identity 不同

#### Scenario: 不同 recipe 使用同一输入

- **WHEN** 相同 scope/input 分别运行 `qa.answer` 与 `report.analysis`
- **THEN** comparison group 不同，不把不同能力混入同一用量比较

#### Scenario: 调用方伪造 digest

- **WHEN** renderer 或 provider 提交 `comparisonGroupId`
- **THEN** exact request 拒绝或 writer 忽略非权威值并自行复算，最终只保存 canonical digest

### Requirement: 产物类型必须与 recipe 静态绑定

正式 artifact registry SHALL 新增 `analysis-report` 与 `planning-proposal`，并继续允许 `meeting-minutes/enhanced-transcript`。`report.analysis` MUST 只写 `analysis-report`，`plan.proposal` MUST 只写 `planning-proposal`，`summary.minutes` MUST 只写 `meeting-minutes`，`text.enhance` MUST 只写 `enhanced-transcript`。`intent.route/context.ingest.*/qa.answer/extract.items/text.rewrite/text.translate` SHALL 无产物类型并只按各自持久化规则收束。

#### Scenario: 分析报告使用新产物类型

- **WHEN** `report.analysis` 成功
- **THEN** writer 只接受 `analysis-report`，结果按版本保存

#### Scenario: recipe 与产物类型错配

- **WHEN** `plan.proposal` writer 请求 `meeting-minutes`
- **THEN** 提交以 `AGENT_REQUEST_INVALID` fail closed，零产物

### Requirement: 六个 Agent run IPC 必须 exact 并受角色限制

系统 SHALL 版本化并冻结 `agent-run:get-eligibility`、`agent-run:submit`、`agent-run:cancel`、`agent-run:get-history`、`agent-run:get-interaction`、`agent-run:changed` 六个频道。请求频道 SHALL 只授权 `agent` 与 `history` 角色，changed SHALL 只向这两个角色发送。未知角色 MUST 在 controller/store/provider 前拒绝。

所有 request/result/event MUST 携带 exact contract identity 并使用同一生产 validator。renderer MUST NOT 提交 eligibility、routing mode、recipe grants、model purpose/profile/model、URL/header、budget、SQLite identity、任意文件路径或凭据。submit 只允许 exact intent 请求（冻结 scope + 原始 prompt 的有界生命周期）或受信任 preset 请求；cancel 只携带 run identity；history 使用 keyset cursor/limit；interaction 只携带 interaction identity；changed 只携带单调 revision。

#### Scenario: agent 角色提交意图

- **WHEN** Agent Bar preload 以受支持 contract 提交 exact scope 与 prompt
- **THEN** main 在冻结范围、计算资格和收敛后返回脱敏 run snapshot，不回显内部 channel/policy

#### Scenario: caption 角色调用 submit

- **WHEN** `caption` renderer 调用 `agent-run:submit`
- **THEN** access policy 在进入执行宿主前拒绝，零 run/binding/interaction

#### Scenario: submit 携带 model 与 budget

- **WHEN** renderer 载荷包含 `modelId`、`toolGrants` 或 `maxTurns`
- **THEN** exact validator fail closed，调用方不能绕过用途与 recipe 登记

#### Scenario: changed 事件陈旧

- **WHEN** renderer 已观察 revision 10 后收到 revision 9 或 10
- **THEN** renderer 忽略事件；只有更大 revision 触发重新读取权威 snapshot

### Requirement: Agent 处理资格必须由 main 按固定顺序计算

main-owned 资格组合器 SHALL 只返回九值闭集 `ready/no_committed_transcript/outside_automatic_window/agent_disabled/provider_not_configured/cloud_disclosure_required/credential_unavailable/local_model_not_ready/session_not_terminal`，并按以下固定优先级判定：`session_not_terminal` → `no_committed_transcript` → `outside_automatic_window`（仅自动请求）→ `agent_disabled` → `provider_not_configured` → `cloud_disclosure_required`/`credential_unavailable`（仅 cloud）→ `local_model_not_ready`（仅 local）→ `ready`。用户请求 SHALL 跳过自动处理时间边界，但 MUST NOT 绕过其它事实。

组合器 SHALL 只消费 main/ConfigStore、冻结会话/范围、model-access catalog/readiness 与受信任本地模型就绪事实；renderer、fixture、recipe、provider 响应或一次 IPC 成功 MUST NOT 覆盖资格。资格不为 ready 时不得创建/领取目标固定 recipe，`intent.route` 的非 ready 情况按规则兜底；该兜底不得伪造 provider ready。

#### Scenario: 非终态且 Agent 关闭

- **WHEN** 请求范围含非终态会话且 Agent 总开关也关闭
- **THEN** 固定优先级返回 `session_not_terminal`

#### Scenario: 自动范围早于边界且 Agent 关闭

- **WHEN** 自动请求的终态会话早于 `automaticProcessingSince` 且 Agent 总开关关闭
- **THEN** 返回 `outside_automatic_window`，不创建任务

#### Scenario: 用户请求早于自动边界

- **WHEN** 用户从历史明确请求边界之前的终态会话且其它资格全部满足
- **THEN** 跳过 `outside_automatic_window` 并返回 `ready`

#### Scenario: fixture 伪造 ready

- **WHEN** preview fixture 或 renderer 本地状态声称 ready，但 model-access 为 `credential_unavailable`
- **THEN** main 返回 `credential_unavailable`，不调用 provider

### Requirement: 交互历史与详情必须使用 keyset 分页和最小投影

`agent-run:get-history` SHALL 只返回面向用户 recipe 的终态 interaction，按 `(terminal_at DESC, interaction_id)` keyset 分页。cursor MUST 是最后一行复合键的不透明编码，续读条件 MUST 严格小于，MUST NOT 使用 `offset_N`。`hasMore` MUST 与 `nextCursor!=null` 严格等价，limit SHALL 按 contract 上界钳制。`intent.route` MUST 被列表投影排除。

最小历史 SHALL 只含时间、范围/模型运行身份、recipe 产品标签、终态、可空 `ModelUsageV1`/缓存命中率、相对时长与最终结果摘要。详情 SHALL 读取完整最终结果与 `(attempt,call_order)` 全序工具调用记录；工具正文默认折叠。`routing_mode`、confidence、内部 recipe ID、prompt 正文、中间 assistant 文本与 reasoning MUST NOT 进入 UI。

#### Scenario: 并发插入后的续页

- **WHEN** 用户读取第一页后有更新的 interaction 插入，再用旧 cursor 续页
- **THEN** 严格 keyset 条件不跳过或重复原结果集中的后续行

#### Scenario: offset cursor

- **WHEN** renderer 提交 `offset_20`
- **THEN** exact cursor validator 拒绝，不把 offset 解析为 keyset

#### Scenario: route interaction 列表投影

- **WHEN** 一个用户请求有 route interaction 与目标 interaction
- **THEN** 历史列表只显示目标 interaction；storage 仍保留 route 审计

#### Scenario: 工具详情默认读取

- **WHEN** 用户打开终态 interaction 详情
- **THEN** 工具调用按全序提供给受限 UI 并默认折叠，工具正文不复制进 result 或报告

### Requirement: 提示与交互信号必须在终态后收敛为 digest

为恢复活动运行暂存的原始 prompt SHALL 只存在于有界内存或受控临时事实。交互收束后，系统 SHALL 完成交互记忆信号提取，再删除 prompt 正文并只保存 canonical digest。用户提示、明确 edit/accept/reject/remember/forget 可形成信号；被动行为与未采纳输出 MUST 保持零信号。prompt 正文 MUST NOT 出现在 interaction history、tool calls、artifact、日志、fixture、报告或导出。

#### Scenario: 成功交互信号提取

- **WHEN** 用户请求成功收束且信号提取完成
- **THEN** prompt 正文被删除，interaction 只保留 `prompt_digest`，随后可预置 `context.ingest.interaction`

#### Scenario: 取消交互信号提取

- **WHEN** 用户取消正式交互
- **THEN** 取消仍为终态，系统按实际闭集信号完成必要提取后删除 prompt，不补造结果

#### Scenario: 提示正文进入 fixture

- **WHEN** fixture generator 准备保存真实或示例 prompt 正文
- **THEN** privacy contract 失败；fixture 只允许 digest、计数与状态

### Requirement: 工具外模型文本与内部思维过程必须零持久化

模型在工具调用之外产生的中间 assistant 文本 MAY 只在本次运行内存上下文存在，MUST NOT 进入 UI、SQLite、日志、stdio、artifact、报告、导出、fixture 或证据 JSON。`reasoning/reasoning_content`、内部思维过程、provider 原始 event stream 与调试对象 MUST 全程丢弃。工具 args/result 只可按已登记 exact Schema 和字节预算保存在本地 interaction audit，并 MUST NOT 复制进普通日志、报告或个人记忆。

#### Scenario: provider 流包含 reasoning_content

- **WHEN** provider event 含 `reasoning_content`
- **THEN** adapter 丢弃该字段，最终结果与 tool audit 均不保存它

#### Scenario: 中间 assistant 文本后续用于模型上下文

- **WHEN** Loop 在内存中使用中间 assistant 文本推进下一 turn
- **THEN** 该文本可影响当前运行，但收束后任何持久层和 UI 均零命中

#### Scenario: 工具正文复制到报告

- **WHEN** report writer 试图附加完整 tool result
- **THEN** artifact Schema 拒绝；报告只使用受支持的来源引用和生成结论

### Requirement: S3 fixture 必须脱敏、版本化且不构成 J22/J24 证据

S3 SHALL 签发与生产 validator 同源、带 `previewOnly=true` 的版本化 Agent run UI fixture。fixture 至少 SHALL 覆盖选区/终态会话/日期范围/项目、九值资格、route `model/rules/preset`、pending/cancelling/cancelled/failed/succeeded、1/3/6 轮登记、0 工具空记录、provider usage、用量未知、cache known/unknown、最小历史、工具折叠、reload、额外键与未知值 fail closed。

fixture MUST 存放在 `src/agent/contracts/fixtures/`，MUST NOT 进入 `.artifacts/`、`docs/validation/`、旅程报告或计为 J22/J24 证据。fixture/SQLite/log/report 负扫描 MUST 拒绝 credential/header/slot、prompt 正文、中间 assistant 文本、reasoning/provider event、现场音频、PCM/WAV、音频路径、本地绝对路径、设备名、绝对单调时刻、时钟偏移和 price/cost/currency/pricing/amount 字段。

#### Scenario: 用量未知 fixture

- **WHEN** UI/UX 工作线加载 usage unknown 场景
- **THEN** fixture 通过生产 validator、显示「用量未知」、不含 estimated 数字或金额字段

#### Scenario: fixture 被复制到证据目录

- **WHEN** 构建或测试试图把 preview fixture 写入 `.artifacts/`、`docs/validation/` 或 J22/J24 报告
- **THEN** evidence 分层合同 fail closed，状态不得晋级

#### Scenario: 未知终态枚举

- **WHEN** renderer 收到未知 contract version、资格、routing mode、terminal reason 或额外字段
- **THEN** exact validator 停止该表面动作并要求 reload/update，不自行推断

### Requirement: S3 必须登记并验证 J22/J24 Core 子边界

S3 实施 SHALL 按一个 seam 一个 tracer bullet 的 red → green → 定向回归推进，测试只能落在既有 `test/{contracts,main,runtime,storage,ui,integration,gate-0b,gate-0c,validation}` lane。Core SHALL 覆盖 canonicalization、exact Schema、recipe 登记、状态转换与错误映射；integration SHALL 使用真实 v7/SQLite、personal-context、model-access、execution host、job runner、main exact IPC，仅替代外部 provider；evidence SHALL 只验证分层、生产可达性与隐私负扫描。

S3 SHALL 先证明 0 工具与 `search_context` 两档、两层意图收敛、两段式摄取、取消/迟到拒绝、用量可空、删除/分页/IPC 与字幕独立。`read_sources` 真实执行和完整工具预算 SHALL 留给 S4；真实 Agent Bar renderer、交互导出与完整产品汇合 SHALL 留给 S5-Integration。三条 lane 返回 0 后状态仍最多为「实现完成·尚未验收」。

#### Scenario: S3 Core 联合旅程返回 0

- **WHEN** 新增 J22/J24 S3 Core 表驱动联合测试以真实内部模块覆盖正常/失败/重放/取消组合并返回 0
- **THEN** 只登记 J22/J24 的 S3 Core 子边界，不新增同义旅程 ID或晋级完整 J22/J24

#### Scenario: integration 存在既有 Electron 环境失败

- **WHEN** 新增 S3 联合测试返回 0，但整个 integration lane 因既有 Windows Electron GPU 子进程 `exit_code=-1073741515` 返回非零
- **THEN** 报告必须把 S3 产品断言与执行环境失败分开，不把环境失败记为产品成立或失败

#### Scenario: 直接调用 recipe 函数代替联合旅程

- **WHEN** 测试 mock 掉 SQLite、个人上下文、model-access 或执行宿主并直接调用 recipe 输出函数
- **THEN** 该测试只能作为局部合同，不得计为 J22/J24 S3 Core 联合证据

#### Scenario: 三条 lane 返回 0

- **WHEN** `npm run test:core`、新增 S3 integration 子边界与 `npm run test:evidence` 均返回 0
- **THEN** S3 最多记录为「实现完成·尚未验收」，S5-Integration 前不得写完整 J22/J24 已验收
