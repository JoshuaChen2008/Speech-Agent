## Context

2026-09-29 轻量方案已决定，依据 SEM-F28/F33/F36/F38/F39/F40、J25/J29/J30/J31-SIZE/J12。正式请求缺少受控 JSON 指令，输出直接取模型能力，输入在多层有旧的小上限；AGENT_REQUEST_INVALID 尚不能证明具体服务端拒绝原因。保留工作树已有重试、取消、恢复和长输入改动。

## Goals / Non-Goals

**Goals:** 当前架构内让窗口内完整会话直接生成四栏纪要，保存后可重开，取消和失败不产生纪要。

**Non-Goals:** 分块归并、三层搬迁、新诊断体系、Schema 生成框架、响应体或纪要正文扩到 1 MiB。不承诺任意模型支持 256k，也不替代 B 的完整长输入验收。

## Decisions

### 1. 一处容量计算，沿现有链路传递

应用上下文目标为 **256,000 token**，包含系统指令、完整会话、工具声明/消息和输出预留。模型上下文窗口、最大输入和最大输出分别解释，不能把现有 maxInputTokens 未经核对就当成总窗口。模型能力较小时取更严格者，未知能力不猜测；使用适配的 tokenizer 或有依据的保守上界，不作为 provider 计费用量。

新运行单次输出目标为 **8,192 token**，再受模型输出能力、剩余输出预算和上下文余量约束；旧策略累计输出若仅剩 8,000，就不能请求 8,192。usage 未知继续沿用既有“用量未知”语义。

在现有预算模块集中计算，runner、Loop、adapter 消费同一结果。核对 15,000 字节、16 KiB、256 KiB、HTTP 请求上限和 120,000 token 限制；新总结路径中与目标冲突的旧限制一起调整，实际序列化字节仍有内存保护上限。具体字节值及计数方式在任务 1 登记，不把 256k token 换成 256 KiB。完整输入适配才外发，超限不截断；工具消息增长后的请求也需检查。其它 recipe 输入容量不随之扩大。

### 2. 小型输出描述，复用严格校验

在既有 recipe 合同附近维护受控输出描述与合法示例，由 Loop 传入 systemPrompt。总结覆盖 schemaVersion、四栏及嵌套字段、长度、可空值和来源规则；用少量样例核对 exact validator，不做通用 Schema 生成器。字幕作为不可信数据。共享接线影响 intent.route、摄取时使用各自结构，不强加总结字段或改变业务授权。

adapter 沿登记策略处理 JSON/思考模式。检查 finish_reason：length、空白、非法 JSON、Schema 或来源错误均拒绝；工具中间消息继续既有循环，不作为纪要。错误、取消和迟到结果复用既有终态与事务屏障，诊断仅保留允许的指标和稳定分类。

#### 2.1 输出描述的职责与接线

状态：已决定；任务2–3实现完成·尚未验收（2026-09-29）。修改点为 contracts/recipes.js 附近的小型静态描述（`src/agent/contracts/recipe-output-directives.js`）、execution-host/agent-loop.js、formal-agent-run-runner.js、model-access/runtime.js 与 openai-compatible-adapter.js。只扩展宿主内部参数，不扩展 renderer IPC 或 bind 的四字段合同，不增加依赖或通用 Schema 生成器。

描述按 recipeId/recipeVersion 查找，正文作为不可信输入，模型不得执行字幕中的指令。systemPrompt 明确只输出一个 JSON 对象、不得 Markdown 包裹，不输出 reasoning；示例必须经过现有 validateRecipeOutput。summary.minutes 顶层为 schemaVersion=1、overview、conclusions、todos、risks；overview≤2000，结论/风险各≤30项，待办≤50项，条目text≤300，sourceRefs≤4，ownerHint/dueHint为null或≤64字符。来源身份只允许复制当前输入授权引用，不能从静态示例编造。最终仍由 exact validator 执法，字段/长度以其现有定义为准。

intent.route 保留现有可选目标与路由说明，context.ingest 使用自己的 ContextIngest 结构；其余 recipe 使用各自输出结构。工具声明、轮次和业务授权不因说明接线变化。连接测试继续独立的 ok 对象合同，不拿连接测试作为总结证据。

#### 2.2 请求额度与用量边界

runner 从冻结绑定取得容量；Loop 接收受校验的内部参数，Model Access 只转交该参数，adapter 在每次外发前使用同一 budget-axes 规则，不再将 summary.minutes@2 的 capabilities.maxOutputTokens 直接写入 max_tokens。v2 不允许缺字段时回落到模型输出能力；其它 recipe/@1 保持原版本容量解释。

v2 输出额度=min(8192、模型输出能力、已知运行剩余输出预算、上下文余量)，必须为正整数；为零时 AGENT_BUDGET_EXCEEDED，零额外外发。模型能力81920/4096分别得到8192/4096，已知余额4000则请求4000。已知消耗按每轮实际provider usage累加，工具后续轮重算；任何用量缺失后整体保持未知，不把请求上限写作实际消耗。

现有 session-summary-budget 主要持久化墙钟与请求预留，不能假设它已有跨attempt token账本。实施2.3时先核对现有可信用量来源：仅完整可证的累计值约束余额；跨重启或失败请求缺用量则传null并保留“用量未知”，不得将缺失值重置为0。现有请求数/attempt/期限上限继续执法。本切片默认不新增账本或迁移；若要求精确跨重启token执法，需要另走存储路由先登记。

#### 2.3 每次外发的输入检查

沿用review后的UTF-8字节保守输入单位，禁止恢复字节÷2。首轮prompt预检之外，实际system/user/assistant/tool消息和工具声明的增长必须进入同一预算检查；固定envelope仅预留包装余量，不能用它替代无限增长的工具正文。每次构造候选请求后、预留实际请求和网络外发前校验，重试亦不能绕过；完整HTTP≤512KiB、prompt≤256KiB、systemPrompt原有16KiB上限不变。

首轮输入容量拒绝沿专用 AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED，证明零总结模型调用；已有模型调用后工具消息增长超限用 AGENT_BUDGET_EXCEEDED，不向用户谎称模型未调用。工具结果不截断；旧绑定JSON逐字节不变，额度不回写模型配置。173,827字节在当前120,000注册轴且无tokenizer时作为拒绝样本；成功边界样本采用86,914字节及95,106/95,105输入能力。

#### 2.4 结束原因与提交顺序

| provider结果 | 处理 |
|---|---|
| finish_reason=stop，无tool_calls，非空正文 | 返回runner，JSON解析→exact结构→来源授权→事务提交 |
| finish_reason=tool_calls，非空且合法tool_calls | 按已有授权执行工具，再进入下一轮；附带content只作有界内存上下文，不作为纪要 |
| length，即使正文是合法JSON或附工具调用 | AGENT_OUTPUT_INVALID，不执行工具、不提交、不自动重试 |
| content_filter、缺失/未知finish_reason、stop与工具调用矛盾、tool_calls却为空 | AGENT_OUTPUT_INVALID，fail closed |
| 空白、非法JSON、结构或来源错误 | AGENT_OUTPUT_INVALID，不补字段、不剥离文本强行修复、不截断 |
| 取消/失效attempt后迟到结果 | 沿取消和事务屏障拒绝，不覆盖已落库终态 |

adapter先校验结束原因和响应形状，再执行工具或返回正文；runner负责recipe结构和来源语义，storage负责最终提交与取消竞态。复用既有稳定码和重试分类；更新受控网络fixture，使每个响应显式提供对应finish_reason，不能通过宽松兼容缺失字段掩盖错误。成功先提交则取消返回已成功事实，取消先提交则迟到结果零纪要。

#### 验证命令与退出条件

先红测再逐项实现，优先复用以下文件：

~~~bash
npm run test:focus -- test/contracts/agent-recipes-contract.test.js test/contracts/budget-axes-s3.test.js test/runtime/agent-loop.test.js test/runtime/formal-agent-run-runner.test.js test/main/model-access-vault-runtime.test.js
npm run test:focus -- test/integration/model-access-s2-core-journey.test.js test/integration/agent-redesign-s5-target-journey.test.js test/integration/session-summary-j29-memory-journey.test.js test/integration/session-summary-budget-recovery-journey.test.js
~~~

生产runner→Loop→Model Access→adapter→SQLite链路必须至少覆盖一个成功与一个拒绝场景，网络替身捕获实际请求以断言systemPrompt/max_tokens/完整输入；不用mock内部模块替代该证据。涉及路由/摄取说明时追加对应现有journey定向文件。第2–3步退出条件：这些边界成立、失败无纪要、旧绑定不变、进程自然退出，实际命令/结果写入testing-strategy；状态只记实现完成·尚未验收。任务4再执行verify:renderer及正式Electron旅程；完整三条lane与真实DeepSeek另验。

### 3. 兼容复用既有机制

优先使用现有 recipe/policy 版本及模型运行绑定表达新运行，不为输出额度另建策略表。先核对既有版本是否已创建持久运行；不能因版本仍在开发就改变已冻结语义，也不能直接启用尚未接通的 v2 分块链路。旧运行“继续”沿用旧绑定与预算，明确新建才采用新容量。只有现有机制确实无法表达时才按存储路由提出最小追加变更，禁止改旧 binding JSON 或 migration checksum。

### 4. 少量边界回归加一条正式旅程

复用生产 runner→Loop→adapter，只替代 provider/网络等外部边界。局部覆盖 JSON 指令、输出额度、窗口临界值、截断/非法结果和取消迟到；复用已有恢复测试，不重建 J30/J31 全矩阵。

正式 Electron 旅程覆盖生成→保存→重开、取消/失败零纪要及下一字幕会话；加入窗口内合成会话验证完整事件范围与 digest 进入请求，173,827 字节规模合成会话在当前无 tokenizer 策略下验证明确拒绝和零模型调用，不把字节规模当 token 数或质量保证。真实 DeepSeek 独立验证，报告只含指标与哈希。阶段联合验收仍由当前 revision 完整 CI 或本地三条 lane 承担。

## Risks / Trade-offs

窗口不足或无法证明适配 → 明确拒绝，B 再提供分块归并。输入扩大 → 保留字节保护、取消检查及相关回归。公网/凭据阻塞 → 记录未验证范围，不用连接测试替代正式模型证据。

## Migration Plan

先登记容量与兼容语义，再逐项红测→实现→定向回归。默认不增加数据库迁移；回退停止创建新策略运行，保留既有历史及旧运行解释。

参考 tau 的 [架构文档](https://raw.githubusercontent.com/huggingface/tau/main/website/content/internals/architecture.md) 与 [模型目录](https://raw.githubusercontent.com/huggingface/tau/main/src/tau_coding/data/catalog.toml)：借鉴清晰职责和 context_window/max_tokens 分离，不迁入其会话持久化或完整框架。
