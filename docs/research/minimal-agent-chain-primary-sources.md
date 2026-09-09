# 最小可用 Agent 链路：一手资料调研与设计映射

> 调研日期：2026-08-31
>
> 范围：只研究“会话分析 + 记忆沉淀”所需的最小链路。本文是证据与设计映射，不替代 `CONTEXT.md`、`docs/semantic-contract.md`、`docs/testing-strategy.md` 或 `docs/agent-redesign-execution-plan.md`，也不改变其中已决定的语义。
>
> 资料优先级：官方文档、官方 GitHub 仓库/源码、官方 API 参考。每条外部结论均附来源；框架能力不等于本项目采用决定。

## 结论摘要

最小可用链路应收窄为一条可恢复但有界的路径：

```text
终态会话越过字幕提交边界
  → 冻结 sessionId + inputWatermark + transcriptVersion + digest
  → 个人上下文模块 ingest（会话经历 + 记忆候选）
  → 用户从 Agent Bar 指定会话/日期范围/项目并输入意图
  → resolve 生成有界 Personal Context Bundle
  → 由固定 recipe 的静态 `maxTurns` 与 `toolGrants` 驱动统一 Agent Loop
  → 结果携带 sourceRef / memoryRef / gaps，失败或取消不影响字幕系统
```

这个收窄方向与现有语义合同一致，也符合一手实现的共同规律：低层 loop 只负责“模型响应—工具调用—工具结果—下一轮”，而权限、预算、持久化、重试和产物提交必须由产品宿主持有（Pi、DeepSeek Harness、OpenAI Agents SDK）。

## 一手资料对照

| 资料 | 官方可确认的机制 | 对本项目的可迁移边界 |
|---|---|---|
| Pi `@earendil-works/pi-agent-core` [README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[`agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts) | 流式模型响应；有工具调用则执行并把 `toolResult` 回填；无工具调用、错误或 abort 时收束；`AbortSignal` 传给模型和工具；`shouldStopAfterTurn` 由宿主决定。 | 作为低层循环内核；recipe、工具闭集、十轴预算、SQLite 状态、取消终态与迟到结果拒绝仍由 Agent 执行宿主负责。Pi 工具 hook 不是沙箱。 |
| Pi `pi-ai` [models API](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts)、[provider factories](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#provider-factories) | `Models` 实例按 provider ID 管理；`getModel(providerId, modelId)` 精确取模型；`createProvider()` 支持 OpenAI-compatible 端点；凭据 store 与持久化由宿主注入。 | 只注入所需 provider factory 与调用级凭据副本；不引入 coding-agent 的 `auth.json`、环境变量发现、OAuth、全量 provider 注册或热加载设置。 |
| DeepSeek Tool Calls [官方指南](https://api-docs.deepseek.com/guides/tool_calls/)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) | API 只返回函数名/JSON 参数；应用执行函数，再以同一 `tool_call_id` 回传结果；`tool_choice`、`max_tokens`、`strict` 是单次协议约束，不是权限、取消、恢复或总预算。 | `search_context`/`read_sources` 必须由宿主执行并校验范围；模型不能直接访问 SQLite、网络、文件或凭据。 |
| DeepSeek Harness [README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)、[agent loop](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/agent-loop)、[session](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session) | LLM、tool registry、approval、sandbox、session、persistence 和 telemetry 是 capability seam；session 采用追加事件与恢复投影；取消是 cooperative；官方明确 loop 没有内建 turn budget。 | 借鉴“单一宿主 + 追加事实 + 冷启动修复”边界；本项目自行冻结轮次/时间/token/工具/字节预算，不搬 coding-agent 沙箱或插件生态。 |
| OpenAI Agents SDK for TypeScript [running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)、[tools](https://openai.github.io/openai-agents-js/guides/tools/)、[sessions](https://openai.github.io/openai-agents-js/guides/sessions/)、[`RunState`](https://openai.github.io/openai-agents-js/openai/agents-core/classes/runstate/) | `maxTurns` 默认安全阀；`AbortSignal`；函数工具 schema、timeout、guardrail/approval；Session 与可序列化 `RunState` 可由应用替换。 | 采用“应用拥有 Session/RunState”的原则；本项目需要更窄的固定 recipe 和本地 SQLite 事实，不把通用 handoff、动态工具或 tracing 内容带入正式交互。 |
| LangGraph [durable execution](https://docs.langchain.com/oss/python/langgraph/durable-execution)、[persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | 通过 checkpointer 持久化 graph state；按 `thread_id` 恢复；副作用应包在 task/node 中并保持幂等；恢复可能重放步骤，因此幂等是应用责任。 | 只借鉴“冻结输入身份 + 幂等边界 + 重放安全”。不引入 graph runtime；本项目恢复采用同一 `runId`/binding/input 的整体重跑并递增 attempt，旧工具记录保留。 |
| LangMem [conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | 将记忆分为后台提取/更新与运行时读取；强调 hot path 与 background processing 分离，并以命名空间隔离记忆。 | 对应 `ingest` 与 `resolve` 两个不同节奏；本项目改用 SQLite 结构化来源、revision、suppression 和范围预算，不引入其 runtime 或向量索引。 |
| Letta [memory concepts](https://docs.letta.com/concepts/memory/)、[GitHub](https://github.com/letta-ai/letta) | Agent 可区分始终在上下文中的 core memory 与按需检索的 archival memory；记忆由 Agent 读写并可持久化。 | 借鉴“热上下文/按需上下文”分层，但本项目禁止模型直接写个人记忆；写入只经 `ingest`，用户控制只经 `manage`，每条记忆必须有来源引用。 |
| Mem0 [memory operations](https://docs.mem0.ai/core-concepts/memory-operations)、[GitHub](https://github.com/mem0ai/mem0) | 官方 API 覆盖 add/update/delete/history；记忆更新可保留历史并按 user/agent/session scope 隔离。 | 借鉴可审计的 revision、scope、删除历史；不照搬默认向量检索或让模型自由覆盖明确内容。 |

## 设计推导

### 1. 统一 Agent Loop，不在运行期升级

Pi、DeepSeek Harness 与 OpenAI Agents SDK 都把“继续下一轮”建立在模型是否返回工具调用/是否达到宿主安全阀，而不是让模型自由创建新 Agent。最小链路因此采用：

1. 十一项固定 recipe 都走同一个 Agent Loop；`maxTurns` 与 `toolGrants` 在 recipe 登记期冻结，而不是根据输入、模型或运行期条件改变。
2. 静态三档分别是 1 轮/零工具、3 轮/`search_context`、6 轮/`search_context` + `read_sources`；工具授权为空仍是统一 Loop 的一次有界运行，不是第二条单次请求路径。
3. Loop 内只允许两个只读工具：`search_context`（等值 alias/semantic key）和 `read_sources`（已授权 sourceRef）。没有 shell、任意文件/网络、SQLite 直连、外部写入或递归子 Agent。
4. `maxTurns`、累计 token、wall-clock、工具调用数、单工具 timeout、并行度和字节预算均在宿主执行；任一轴触顶以 `AGENT_BUDGET_EXCEEDED` 收束。

### 2. 记忆提取与来源追溯

LangMem 的后台提取/运行时读取分离、Letta 的 core/archival 分层、Mem0 的 scope 与 history 共同支持以下最小模型：

- `ingest(source)` 只接受已冻结的终态会话或终态正式 Agent 交互；输出会话经历记录和低权重记忆候选。
- 每个候选至少带 `semanticKey`、scope、confidence/salience、一个 `sourceRef` 或交互信号引用；模型自评不能直接决定当前投影。
- 宿主按 canonical key 去重，冲突建立新 revision，不覆盖明确内容；删除写 suppression 并保留删除回执。
- `resolve(request)` 只返回与当前范围相关的 Personal Context Bundle，带 input watermark/digest、来源引用、预算和省略标记；绝不返回完整个人记忆表。
- 交互记忆信号仅来自用户提示、明确编辑、接受、拒绝、“记住”和“忘记”；点击、停留、滚动、调试聊天、工具记录和未采纳模型输出不进入记忆。

### 3. 恢复、取消与失败边界

LangGraph 官方文档明确指出恢复会重放节点/任务，副作用须幂等；DeepSeek Harness 官方文档则采用追加事件、冷启动把未闭合 turn 标为 interrupted 的策略。对本项目的具体约束是：

- 运行创建时冻结 `runId + recipeId/version + Model Run Binding + inputWatermark/transcriptVersion/digest + maxTurns/toolGrants`；运行中不得换模型、扩大范围或改变工具授权。
- 中途恢复不尝试拼接不可确定的模型上下文：在同一 `runId` 下整体重跑并递增 `attempt`；旧 attempt 工具记录按 `(attempt, call_order)` 全序保留。
- 用户取消是终态 `cancelled`：贯穿模型与工具的 `AbortSignal`，不再开新 turn/工具，不重试、不换模、不写产物；迟到结果一律拒绝。
- provider 鉴权失败、预算耗尽、Schema 无效、工具越权、worker 退出分别映射稳定任务错误码；所有失败都不得改变字幕显示、SQLite 字幕历史或导出。
- 失败重试只在允许的 provider/网络/临时 worker 类错误上进行，沿用同一绑定；达到 `max_attempts` 后终态失败，不静默 fallback。

### 4. 本地优先与隐私

Letta/Mem0 的可持久化记忆能力并不自动满足本地隐私边界；DeepSeek API 的 tool call 也只定义协议。因此本项目继续采用：

- 字幕系统在 Agent 不可用时独立工作；Agent 只读取字幕提交边界后的文字快照。
- 本地 SQLite 是记忆、会话经历、交互和工具审计的事实存储；模型 provider 只拿一次调用所需的有界上下文和凭据副本。
- 不保存现场音频、PCM、WAV、音频路径、provider 原始事件、reasoning 或中间 assistant 文本。
- 工具返回的字幕正文只作为有界审计证据，随交互级联删除，不建立第二个可检索知识库，不进入日志、报告或个人记忆。
- 当 Agent provider 未配置、云端披露未确认、凭据不可用或个人记忆处于关闭边界时，资格 fail closed；不创建自动任务、不调用模型。

## 最小可用实现 SPEC（供 S3–S5 评审）

### 固定对象

```text
InputReference = {
  sessionId,
  transcriptVersion,      // raw；refined 仅整场完整覆盖时允许
  throughEventOrder,
  inputDigest
}

PersonalContextBundle = {
  scopeRefs,
  episodes[], memories[], sourceRefs[],
  inputWatermark, inputDigest,
  omitted[], budget, hasMore
}
```

### 运行阶段

1. `create`: 主进程校验请求与资格，调用模型接入层 `bind()`，登记 recipe/version、绑定快照、冻结输入与静态 `maxTurns/toolGrants`。
2. `prepare`: `resolve()` 生成有界上下文包；校验输入 digest 与版本；范围不可扩大。
3. `execute`: 统一 Pi Agent Loop；每轮检查取消、wall-clock、token 与工具预算；仅执行 recipe 静态授权工具。
4. `validate`: canonical JSON Schema 校验；失败最多一次同绑定结构化修复重试，仍失败则 `AGENT_OUTPUT_INVALID`。
5. `commit`: 仅在完整结果、来源引用和预算事实通过校验后原子提交；任何分块/归并失败不写部分产物。
6. `finalize`: 释放租约/凭据副本，写入终态与稳定错误码；对取消或迟到结果保持零写入。

### 失败/边界矩阵

| 场景 | 必须结果 |
|---|---|
| 会话未终态或无已提交字幕 | 资格 `session_not_terminal` / `no_committed_transcript`；不调用模型 |
| 精修覆盖不完整 | 整会话回落 raw；标记省略/版本事实，不混合 raw/refined |
| provider 未配置、披露未确认、凭据不可用 | `provider_not_configured` / `cloud_disclosure_required` / `credential_unavailable`；不入队 |
| 只读工具请求越权 | 返回 `TOOL_SCOPE_DENIED` 或 `TOOL_NOT_AVAILABLE_FOR_RECIPE`；工具不执行 |
| 预算达到任一轴 | `AGENT_BUDGET_EXCEEDED`；不写产物；已有工具审计保留 |
| 用户取消 | `cancelled` 终态；不重试、不产物；迟到结果拒绝 |
| provider 超时/断网/5xx | 在 `max_attempts` 内同绑定重试；旧 attempt 记录保留；耗尽后稳定失败 |
| 输出 Schema 无效 | 至多一次结构化修复；仍无效则 `AGENT_OUTPUT_INVALID`，不写部分产物 |
| Agent utility/worker 退出 | 标记运行失败并可恢复重试；字幕显示、SQLite 字幕历史和导出继续可用 |

### 可验收最小旅程

- **J21 子路径**：终态会话 → 一次 `context.ingest.session` → 会话经历记录 + 带 sourceRef 的记忆候选/丢弃事实；重复唤醒不重复写入。
- **J22 子路径**：选定 ≥2 个终态会话 → `report.analysis` 触发 `search_context`/`read_sources` → 带 sourceRef/memoryRef/gaps 的分析报告；越权、预算、取消和迟到结果各有负断言。
- **J24 子路径**：个人记忆关闭/重新开启、冲突 revision、删除 suppression、范围不足和不完整精修覆盖均保持可追溯且不补跑关闭期间来源。
- **J25/J26 汇合前置**：模型绑定固定、用量未知不估算、交互工具审计可导出且重复导出字节一致；正式 Agent Bar 与导出仍需 S5 真实 IPC/SQLite 汇合。

## 对 S3–S6 当前实现检查的提示

现有执行计划已经把上述边界拆为 S3（统一执行宿主）、S4（只读工具与十轴预算）、S5（Agent Bar/导出/真实汇合）、S6（旧 Agent 启动路径与打包隔离）。本研究的新增价值是给出外部一手证据的“为什么”：

1. Pi/DeepSeek/OpenAI 的 loop 都需要宿主安全阀，故 S3/S4 不能把 `maxTurns` 或工具授权交给模型提示词。
2. LangGraph 的恢复重放与 DeepSeek Harness 的追加事件说明 S3 必须保留 attempt/幂等事实，而不是拼接不可重现的中间上下文。
3. LangMem/Letta/Mem0 的记忆分层说明 S3 的 `ingest` 与 `resolve` 必须是两个节奏不同但共享来源模型的接口；S5 不应让 UI 直接读记忆表。
4. 所有外部资料都没有替本项目解除 `SEM-F14`、单路字幕系统独立性、recipe 闭集或本地优先要求；S6 的旧树不可达与打包排除仍是产品边界而非“清理工作”。

## 来源完整列表

- Pi agent core：<https://github.com/earendil-works/pi/tree/main/packages/agent>
- Pi agent loop source：<https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts>
- Pi model/provider API：<https://github.com/earendil-works/pi/tree/main/packages/ai>
- DeepSeek Tool Calls：<https://api-docs.deepseek.com/guides/tool_calls/>
- DeepSeek Chat Completions：<https://api-docs.deepseek.com/api/create-chat-completion/>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- OpenAI Agents SDK running agents：<https://openai.github.io/openai-agents-js/guides/running-agents/>
- OpenAI Agents SDK tools：<https://openai.github.io/openai-agents-js/guides/tools/>
- OpenAI Agents SDK sessions：<https://openai.github.io/openai-agents-js/guides/sessions/>
- LangGraph durable execution：<https://docs.langchain.com/oss/python/langgraph/durable-execution>
- LangGraph persistence：<https://docs.langchain.com/oss/python/langgraph/persistence>
- LangMem conceptual guide：<https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>
- Letta memory concepts：<https://docs.letta.com/concepts/memory/>
- Mem0 memory operations：<https://docs.mem0.ai/core-concepts/memory-operations>
