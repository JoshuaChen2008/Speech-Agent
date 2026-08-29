# Agent Harness 一手资料调研笔记

> 调研日期：2026-08-29
>
> 只使用官方文档、官方 GitHub 仓库与源码。重点为 Pi、DeepSeek API / DeepSeek Harness；OpenAI Agents SDK for TypeScript 仅作一个补充对照。本文件不是本项目方案，也不修改语义。

## 结论

1. **Pi 低层 Agent 核心是最简洁的 loop 参考**：模型响应 → 工具调用 → 工具结果 → 下一轮，直到无工具调用、失败、取消或宿主停止。它提供消息转换、流式事件、`AbortSignal`、工具前后钩子和 provider 注入点，但不会替产品决定业务权限、后台任务持久化与产物提交。[Pi agent core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md) · [Pi `agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
2. **DeepSeek API 的 Tool Calls 只是模型协议**：模型返回函数名和 JSON 参数，应用自己执行，并用相同 `tool_call_id` 回传结果；`strict` 只约束参数 schema，不提供权限、隔离、取消或恢复。[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/) · [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
3. **DeepSeek 现在确有官方开源 Harness**，且资料充分；但官方标为 developer preview。它把 loop、LLM adapter、工具、权限、沙箱、持久化和 telemetry 做成插件化能力，适合借鉴边界，不适合把整套 coding-agent runtime 直接搬进本项目首版。[DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) · [Architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/)
4. 对本项目而言，任何内核之外都必须保留产品宿主：字幕系统独立；Agent 只读取字幕提交边界后的冻结文字快照；首版只生成内容；每次 Agent Loop 有 turn / 时间 / token / 工具调用上限；取消贯穿模型与工具；恢复与提交使用稳定身份；观测数据显式脱敏；任何 Agent 路径都不接触或保存现场音频。对应约束仍是 `SEM-F09`、`SEM-F14`、`SEM-F25`、`SEM-F28`、`SEM-T15` 与 `J24`。

## 对照表

| 关注点 | Pi 低层 Agent 核心 | DeepSeek Harness | OpenAI Agents SDK（TS，对照） |
|---|---|---|---|
| loop | assistant 有工具调用就执行并回填，否则收束 | durable turn/step 内调用模型、执行工具、再派生下一 step | final / handoff / tool call 三分支 |
| 消息与工具 | `AgentMessage` 经 `transformContext` / `convertToLlm` 变成模型消息；工具参数先校验 | typed content block；`tool/call` 与 `tool/result` 按 `callId` 配对 | Responses 风格 run items；函数工具使用 Zod / JSON Schema |
| 取消与上限 | `AbortSignal` 贯穿模型与工具；`shouldStopAfterTurn` 由宿主定义，无文档化的默认总 turn 上限 | cooperative `agent.cancel()`；每请求 token cap、每 step 并行上限；官方明确无内置 turn budget | `AbortSignal`；`maxTurns` 默认 10；模型与函数工具可设 timeout |
| provider seam | exact `model + streamFn`；`pi-ai` 注册 provider factory | `LlmAdapter` 注册 provider route；prepared call 固定 adapter 后派发 | `Model + ModelProvider`；由 `Runner` 注入 |
| 工具权限 | `beforeToolCall` 可阻止；核心不是沙箱 | guarded tool pipeline + fail-closed approval + 独立 sandbox seam | per-run enable、guardrail、approval、timeout；资源授权仍在应用内 |
| 恢复 / 观测 | 低层 loop 以消息和事件为主，更高 AgentHarness 另有持久化方向 | append-only session log、flush checkpoint、interrupted crash repair；ledger 与 live events 分开 | `RunState` 可序列化；`Session` 可替换；内置 tracing 可配置敏感数据 |

## Pi：适合作为内核，不适合作为权限边界

- Pi 把应用消息与模型消息分开：应用可保留自定义 `AgentMessage`，每次模型调用前通过 `transformContext` 和 `convertToLlm` 过滤为 `user`、`assistant`、`toolResult`。因此 UI / 业务元数据不必伪装成模型历史。[Message flow](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#agentmessage-vs-llm-message) · [`AgentLoopConfig`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)
- loop 流式取得 assistant message；`error` / `aborted` 直接结束；否则执行其中的 `toolCall`，把 `toolResult` 追加到上下文后继续。工具支持顺序或并行，但结果按模型原始调用顺序写回。[Loop source](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts) · [Tool event flow](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#with-tool-calls)
- `Agent.abort()` 与工具 `execute` 共享取消信号，但工具必须主动配合。`shouldStopAfterTurn` 只在当前模型响应和工具执行收束后决定是否再开一轮，不会中断正在运行的 provider 或工具。因此累计 turn、wall-clock、token 与工具调用预算必须由宿主记账并在超限时取消。[Control API](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#control) · [`shouldStopAfterTurn`](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#with-tool-calls)
- `beforeToolCall` / `afterToolCall` 是策略钩子，不是隔离层；`execute` 仍是普通应用代码。本项目必须由 Agent 执行宿主按 recipe 构造工具闭集和数据范围，不能靠提示词或模型自律。[Tool hooks](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#agent-options) · [Tools](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md#tools)
- loop 只依赖 exact `model` 与 `streamFn`；`pi-ai` 提供 provider factory、自定义 `createProvider()`，并支持 DeepSeek / OpenAI-compatible endpoint。产品可只装载允许的 Agent 模型 provider。[Pi providers](https://github.com/earendil-works/pi/tree/main/packages/ai#supported-providers) · [Custom providers](https://github.com/earendil-works/pi/tree/main/packages/ai#custom-providers)
- Pi 另有 `AgentHarness` / Session 持久化方向。它的 durable operation、单 writer 与恢复设计可作为不变量参考，但不应让 Pi Session 与本项目 SQLite 后台 Agent 任务同时成为业务状态权威。[AgentHarness lifecycle](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/agent-harness.md) · [Durable harness design](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness-v2.md)

## DeepSeek：API 协议与官方 Harness 分开看

### API

DeepSeek Tool Calls 使用 OpenAI-compatible 消息形状：请求携带函数 schema；assistant 返回 `tool_calls`；应用执行后追加 `role: tool` 与相同 `tool_call_id`，再请求模型。官方明确说明模型不执行函数。[Tool Calls guide](https://api-docs.deepseek.com/guides/tool_calls/)

API 的 `tool_choice` 控制是否或必须调用工具，`max_tokens` 只限制一次模型响应；Beta `strict` 校验受支持的 JSON Schema 子集。这些都不构成 Agent Loop 的总预算或权限边界。[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/) · [Strict mode](https://api-docs.deepseek.com/guides/tool_calls/#strict-mode-beta)

### 官方 Harness

- DeepSeek Harness 是官方仓库中的开源 developer preview。它基于 Cordis，插件依赖公共 `Agent` 接口而不是具体 loop；LLM、tool registry、session、agent loop、persistence、approval、sandbox、telemetry 都是可替换 capability seam。[Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md) · [Architecture](https://deepseek-harness.github.io/deepseek-harness/en/reference/)
- 默认 loop 只做“调用模型、执行工具、重复”。`LlmAdapter` 按 provider route 注册；prepared call 在 capability resolution、request header 记录和 dispatch 期间固定同一 adapter，并接收 `AbortSignal`。[Agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md) · [LLM streaming / adapter](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/llm-streaming)
- 工具经过 pre-execute、guards、execute、post-execute；approval 只有 `allowed-once` 放行，其余 fail closed。沙箱只约束文件副作用，网络与进程可见性不在其词汇内；Windows ACL backend 还可能只达到 `partial` enforcement。[Tool pipeline](https://deepseek-harness.github.io/deepseek-harness/en/reference/tool-execution-pipeline) · [Approval](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/approval) · [Sandbox](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sandbox)
- `agent.cancel()` cooperative 地中止当前活动；每请求有 output token cap，每 step 有并行工具上限，但官方明确没有内置 turn budget，失控循环要由外部策略取消。[Cancellation and limits](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md#failure-and-cancellation) · [Known limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md#known-limitations-and-deferred-work)
- Session 使用 append-only typed events，模型历史由日志投影；冷启动遇到未闭合 turn 时追加 `interrupted`，不截断既有事实。telemetry 是可替换 seam，但官方明确默认没有脱敏规则，因此本项目只能记录 `SEM-F14` 允许的字段，不能先收集完整消息再后置清洗。[Sessions](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session) · [Persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence) · [Telemetry](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session-telemetry)

## 一个补充对照：OpenAI Agents SDK for TypeScript

它与 Electron/Node 技术栈接近，主要价值是提供安全阀对照：loop 默认 `maxTurns=10` 且支持 `AbortSignal`；`ModelProvider` 可替换；函数工具有 schema、per-run enable、guardrail、approval 和 timeout；`RunState` 可序列化恢复；`Session` 支持应用自有存储；tracing 可关闭敏感内容或整体关闭。[Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/) · [Models](https://openai.github.io/openai-agents-js/guides/models/) · [Tools](https://openai.github.io/openai-agents-js/guides/tools/) · [RunState](https://openai.github.io/openai-agents-js/openai/agents-core/classes/runstate/) · [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/) · [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)

## Pi 多 provider 与模型选择：当前官方实现

当前基础包是 `@earendil-works/pi-ai`，loop 包是 `@earendil-works/pi-agent-core`。前者没有全局“智能路由器”：`createModels()` 创建一个实例级 `Models` 集合，内部以 `provider.id` 为唯一键保存 `Provider`；`setProvider()` 是按 id upsert/replace。`Provider` 拥有身份、认证、模型目录和流式实现，`Model` 是普通数据，至少包含 `provider`、`id`、`api`、`baseUrl`、能力和 token/cost 元数据。调用方以 `getModel(providerId, modelId)` 精确取模型，调用时集合再按 `model.provider` 找到唯一 provider 并派发。[`Provider` / `Models` / `MutableModels`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts#L2231-L2469) · [`Model` 数据形状](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts#L3346-L3404)

- **内置与自定义注册**：每个内置 provider 有独立子路径 factory，例如 `@earendil-works/pi-ai/providers/anthropic`；只导入需要的 factory 可保持目录和 SDK 懒加载。`@earendil-works/pi-ai/providers/all` 的 `builtinModels()` 会注册全部内置 provider，是官方明确标注的 heavy entrypoint。自定义端点使用 `createProvider({ id, name?, baseUrl?, headers?, auth, models, fetchModels?, filterModels?, api })`，其中 `api` 可是一种 wire API，也可是按 `model.api` 分派的映射，再以 `models.setProvider()` 注册。[Provider factories](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#provider-factories) · [`createProvider()`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts#L3349-L3391)
- **字段归属与覆盖**：`model.id` 只在其 `model.provider` 内定位；wire protocol 由 `model.api` 表示。Provider 可声明默认 endpoint/header 与认证规则，具体 Model 带必需的 `baseUrl` 和可选 `headers`；认证解析还能给出请求级 `apiKey`、`headers`、`baseUrl`。header 合并顺序是 provider auth → `model.headers` → 显式请求 headers → `transformHeaders`；显式 `apiKey` 优先，认证给出的 `baseUrl` 只为该次请求复制并覆盖 Model，不修改目录对象。[Auth resolution and header precedence](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#how-auth-resolves) · [`applyAuth()`](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts#L3171-L3247)
- **运行时选择与冻结点**：低层 `Agent` 在启动一次 run 时把当前具体 `Model` 放入 loop config 快照；每个 provider request 接收这个具体模型。只有宿主显式实现 `prepareNextTurn` 并返回替换 `model`，才会在上一 turn 收束后影响下一次请求；不会改变飞行中的请求。因此“整次运行固定 provider/model”不是 Pi 默认策略，而是宿主不启用中途替换并记录精确二元组得到的不变量。[Agent run snapshot](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts#L2073-L2193) · [`AgentLoopTurnUpdate`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)
- **没有通用 fallback / 按任务路由**：官方 `Models` API 只有注册、查询、可用性、认证、refresh 和按给定 Model 派发；未找到自动 fallback、按任务选模或跨 provider 负载路由。Cross-Provider Handoff 只是让宿主手工改用另一个 Model 时能重放兼容上下文。OpenRouter / Vercel Gateway 的 routing 字段属于对应网关协议的 provider-specific 选项，不是 Pi 集合层策略。[Cross-provider handoff](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#cross-provider-handoffs) · [`Models` interface](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts#L2334-L2450)
- **持久化与凭据边界**：`pi-ai` 的 registry 和默认 `CredentialStore` 都在内存；持久凭据要由应用注入 store，一份 credential 归属一个 provider。`ModelsStore` 只为动态模型目录提供可注入持久化，默认同样在内存；普通 `Context` 和 `Model` 虽可 JSON 序列化，写到哪里仍由宿主决定。Pi coding-agent 另有 `~/.pi/agent/models.json`、`auth.json` 和 `ModelRuntime`，这是 `@earendil-works/pi-coding-agent` 的产品配置层，不是 `pi-ai` 的必要组成。[CredentialStore](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#credential-store) · [Dynamic catalogs](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#custom-providers) · [coding-agent `models.json`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)

可直接复用的是 `@earendil-works/pi-ai` 的小集合接口、所需 provider factory、`createProvider()` / `envApiKeyAuth()`、精确模型查询、请求取消，以及 `fauxProvider()` 的确定性 provider 测试替身；若采用 Pi loop，则只把 `models.streamSimple.bind(models)` 注入 `@earendil-works/pi-agent-core`。不应整段复制的是全量 `builtinModels()`、将被移除的 `/compat` 全局 API、coding-agent 的 `ModelRuntime` / `ModelRegistry`、`models.json` 热加载、`auth.json` / OAuth 登录 UI 和 home-dir 约定；它们把命令行产品、文件布局与广泛凭据发现耦合在一起。[Migration away from global compat](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#migrating-from-the-old-global-api) · [coding-agent model runtime](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-runtime.ts)

Pi 仓库采用 MIT License，允许使用、复制和修改，但复制 substantial portions 时必须保留版权与许可声明。工程上优先直接依赖 `@earendil-works/pi-ai` 的公开小接口或只移植必要 factory 形状，避免复制会持续漂移的 coding-agent 设置实现。[Pi LICENSE](https://github.com/earendil-works/pi/blob/main/LICENSE)

对本项目约束的直接含义仅限边界判断：provider allowlist、运行级模型选择、失败后的是否改模、配置事实和凭据生命周期必须由 Agent 模型接入层负责，Agent 执行宿主只消费冻结的模型运行绑定；不能让工具进程通过 Pi 的默认环境变量发现绕过 `SEM-F28/SEM-F33` 的主进程调用级凭据边界，也不需要把 coding-agent 的凭据文件带入桌面字幕产品。Pi 可以负责协议适配和请求派发，但不应成为字幕事实、现场音频、recipe 策略或后台任务状态的拥有者。

## 给方案评审的七个检查项

1. 低层 loop 是否只负责消息、模型、工具结果与取消，而 Agent 执行宿主拥有 recipe、权限、预算、错误隔离和产物提交？
2. 后台 Agent 任务、输入水位、`runId`、产物版本与恢复事实是否只有一个 durable state owner？
3. 是否同时限定 max turns、累计 token、wall-clock、单工具 timeout、工具调用总数和并行度？
4. 首版工具是否按 recipe 构造内容型闭集，明确不暴露 bash、任意文件系统、任意网络、MCP 写操作或递归子 Agent？
5. provider、model、预算、超时与调用级凭据是否在一次运行内冻结，且 Agent 模型 provider 不影响识别 provider 或字幕会话？
6. 模型、工具和等待队列是否共享取消因果；自动重试是否复用原 `runId`；迟到结果是否会被拒绝？
7. 观测是否从允许字段出发，只记录状态、阶段、计数、耗时、provider/model、输入 digest / 水位与稳定错误码，而不收集现场音频、字幕正文、本地绝对路径或凭据？

## 资料边界

- Pi 当前官方仓库和包名已迁移到 `earendil-works/pi` / `@earendil-works/*`；其低层 loop 与更高 `AgentHarness` 需要分开评估。
- DeepSeek Harness 有足够官方资料，本轮未使用二手文章；但 developer preview 不构成稳定集成承诺。
- 本轮不扩大到 LangGraph、AutoGen、CrewAI 等更重框架，因为它们不能直接回答当前窄 loop 与宿主边界问题。
