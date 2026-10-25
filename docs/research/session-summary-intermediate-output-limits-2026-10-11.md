# 会话总结中间结果超限与质量优先方案调研

调研日期：2026-10-11。范围：本次超限原因、DeepSeek V4.1 Flash 能力、会话总结内容组织、容量与运行边界。本文件记录研究事实和待评估建议，不改写已决定的语义合同、ADR、OpenSpec 或旅程矩阵，不构成产品实现或验收证据。

## 当前建议

结合用户传来的“内容质量优先、显著提高中间容量、按话题组织、目标为 DeepSeek V4.1 Flash”偏好，建议改为：**协调提高总结链路容量，优先让模型读取完整冻结输入；话题用于组织纪要，只有实际请求预算无法容纳时才对执行输入分块。**

前版“保留 8 KiB，压到 6 KiB，再压缩修复”的建议不再作为首选。8 KiB 是本次失败的直接原因，也是当前版本的已决定边界；它不是这款模型的输出能力上限。提高到更大的有界容量应通过新版本登记，既有冻结运行保持原解释。

建议先比较两种质量方案：完整输入的一次生成，以及完整输入的“话题组织→撰写→核对”三阶段生成。多次调用、思考模式或更长上下文本身都不能证明纪要质量更好；以关键事实保留、否定与较晚修订、重要数字、待办责任与来源为判断依据。三阶段是候选，不预先承诺采用。

## 本地诊断事实

本节沿用本次会话诊断确认的指标；没有向搜索服务或任何模型发送真实字幕正文。

| 指标 | 已确认事实 |
|---|---|
| 会话输入 | 约 93 分钟、789 个字幕段、原始文本合计 57,016 UTF-8 字节；canonical 事件序列为 99,407 字节 |
| Agent 输入计划 | 2 个叶分块、3 个计划节点 |
| 两次失败的中间结果 | canonical JSON 为 8,520 / 13,183 字节，超过 8,192 字节 |
| provider 输出用量 | 2,383 / 3,630 token；单请求输出目标为 8,192 token |
| 校验位置 | 输出已经过 JSON 解析、业务 Schema 与来源校验，再被中间结果字节检查拒绝；尚未进入后续归并 |
| 当次模型运行绑定 | model ID 为 deepseek-v4-flash；确认快照的输入侧能力 1,280,000 token，输出能力 81,920 token |
| 当前默认预设 | deepseek-openai@1，资料快照日期 2026-08-30；输入侧能力 128,000 token、输出能力 8,192 token |

默认预设与当次运行绑定是不同事实，不能用默认值解释本次运行，也不能用最新官网覆盖旧绑定。默认值参见 [preset-registry.js](../../src/agent/model-access/preset-registry.js)。官方目前的总上下文数据与当次确认的输入侧数值口径不同；当次 1,280,000 不是已核验的 V4.1 总上下文容量。

直接检查位于 [summary-plan-executor.js](../../src/agent/execution-host/summary-plan-executor.js)：

    Buffer.byteLength(canonicalize(output), 'utf8') > INTERMEDIATE_LIMIT

本次失败不是“输出 token 达到 8,192”的证据。现有持久记录未提供原始 finish_reason，不能为旧记录补造 stop 或 length。provider 原始响应、模型中间正文和内部思维过程不应写入诊断。

[summary-input-plan.js](../../src/agent/execution-host/summary-input-plan.js) 的叶节点用户 JSON 已说明 8,192 字节约束。当前所有节点仍使用 summary.minutes@2 的最终结果说明，包含概要最多 2,000 Unicode code point、结论/风险各 30 项、待办 50 项和阅读排版要求。因此同时存在中间总字节偏小、节点说明与额度未充分区分的问题。

## 已核验的外部资料

### V4.1 的模型身份与容量

2026-09-10 官方公告给出的正式 API model ID 是 **deepseek-flash**，旧 deepseek-v4-flash 等别名暂时路由到 V4.1。新配置可按正式 ID 建立版本化预设；旧冻结绑定不能静默替换。供应商当前别名路由也不能证明历史请求当时实际执行了哪个模型版本。[DeepSeek V4.1 发布公告](https://api-docs.deepseek.com/news/news260910/)

官方模型说明标注 V4.1 Flash 为 1M 上下文、最大 384K 输出。模型元数据文档示例具体给出 context_window=1,048,576、max_output_tokens=393,216，并明确上下文容量包含输入与输出。**文档示例不是用户当前连接的 API 探测结果，也不是用户已经确认的模型运行绑定。** 新运行应依照模型接入层的受信任能力资料与用户确认冻结配置，另做总上下文适配检查；不能把总上下文窗口直接填作输入侧能力并同时预留最大输出。[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)、[List Models](https://api-docs.deepseek.com/api/list-models/)

### 思考模式与工具协议

当前官方支持思考模式及 low/high/max 强度，默认开启且默认 high；OpenAI 格式可显式设置 thinking enabled 与 reasoning_effort。思考模式下 temperature 不生效，因此“降低温度保证准确”不适用于这一方案。[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)

官方要求：请求只要带 tools，后续请求就必须完整回传前面相关轮次的 reasoning_content，即使某轮没有实际调用工具；遗漏会产生 400。当前 [provider-exchange.js](../../src/agent/contracts/provider-exchange.js) 的 deepseek-openai@1 显式关闭思考，响应归一化不返回 reasoning，assistant 消息白名单也没有该字段。**直接打开开关不足以适配。** 新策略若启用思考，应在同一 Agent Loop 中加入有界内存协议处理、预算核对和取消释放，保持零持久化；需要按静态工具授权确定是否携带 tools，不能为绕过协议静默删除已授权工具。[Thinking Mode：Tool Calls](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)

当前 API 把 max_tokens 定义为生成的 completion token 上限，usage 又将 reasoning_tokens 列为 completion 用量分项。基于当前规格，容量规划应保守按思考与正文共同占用输出额度处理；65,536 token 不能承诺同量正文。这是规格推断，不把历史 R1 的参数数值套给 V4.1。[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

### JSON、长度与内容质量

JSON Output 要求提示包含 JSON 与示例，并应合理设置 max_tokens 避免输出中途截断，也可能返回空内容。JSON 模式不能保证业务字段、来源或 UTF-8 字节边界。[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)

Buffer.byteLength 返回编码后的字节数；JSON Schema 的 maxLength 约束字符数，maxItems 约束数组项数。token、字段字符数、canonical JSON 字节、嵌套 HTTP 响应字节需要分别约束。结构、来源字段与 JSON 转义都会占空间，思考内容还会占用外层响应容量；这一容量判断结合规格与当前序列化方式得出。[Node.js Buffer](https://nodejs.org/api/buffer.html#static-method-bufferbytelengthstring-encoding)、[JSON Schema Validation](https://json-schema.org/draft/2020-12/json-schema-validation)

Summ^N 研究了受限输入下的多阶段粗摘要与最终摘要，可以参考其执行分块思路；它不能证明本项目必须分块或 8 KiB 合理。[Summ^N，ACL 2022](https://aclanthology.org/2022.acl-long.112/)

Lost in the Middle 在多文档问答与键值检索中发现信息位置影响表现，支持将首、中、尾事实纳入评估。其研究对象和任务不是 V4.1 会话总结，不能据此声称 V4.1 全量读取一定漏内容，或分块一定更好。[Lost in the Middle，TACL 2024](https://aclanthology.org/2024.tacl-1.9/)

## 建议如何修改

当前要求以 [语义合同的会话总结运行与长输入增量](../semantic-contract.md#会话总结运行与长输入增量2026-09-27) 为准；执行边界见 [ADR 0016](../adr/0016-unified-agent-execution-path.md)、[ADR 0021](../adr/0021-summary-lifecycle-and-long-input.md) 及 [既有 OpenSpec 设计](../../openspec/changes/fix-session-summary-lifecycle-and-long-input/design.md)，验收边界见 [旅程矩阵](../testing-strategy.md)。以下为新版本建议，不能据此改变旧运行解释。

### 1. 先登记总结专用的新版本，协调提高容量

实施前按 SEM-T06 修订 SEM-F38/F39/F40 的相关登记、ADR 和 J31 旅程，再建立新的总结 recipe/policy、模型预设与请求策略版本。冻结 summary.minutes@2、summary-long-input@1、deepseek-openai@1 的旧数值及恢复解释，不把总结容量扩大到会话问答或个人上下文摄取。实际版本号由实施规格确定。

可以将 **中间 canonical JSON 128 KiB、最终 canonical JSON 256 KiB** 列为第一轮容量试验值；话题组织阶段的生成额度 **16,384 token**、撰写/核对阶段 **65,536 token**、thinking high 同样是候选参数。它们是用户质量偏好下的工程建议，外部资料没有证明这些值最优，也不是本轮新增的已决定要求。

这些额度必须一起设计：

- 输入侧能力、输入预算轴、输入估算、固定 envelope、完整消息与工具增长、总上下文输出预留。
- 中间和最终 Schema 的字符/数组/整体字节上限；当前最终结构整体上限为 64 KiB，扩大整体值而保留原有很小字段额度未必能改善信息保留。
- 归并扇入、每节点保留信息、最坏 JSON 转义、完整 HTTP 请求/响应及思考内容的有界保护。
- 计划节点与实际请求数量、思考输出的用量、每 Loop 和整个运行的时间、累计输入/输出预算、未知 usage。
- renderer/IPC、SQLite 结果、正式 Agent 交互导出、取消与迟到提交、正文缓冲峰值及释放。

当前应用还受输入注册轴 120,000、prompt 256 KiB、完整 HTTP 请求/响应各 512 KiB、每 Loop 180 秒及最终 Schema 64 KiB 等约束。语义合同甚至明确旧版响应不扩到 1 MiB。因此新容量不是改一个常量或更新模型能力即可获得；响应保护若需提高，也属于新登记的语义变化。256 KiB 最终 JSON 在外层转义或叠加思考后并不保证能放入 512 KiB 响应，不能提前承诺适配。

有受控且匹配模型的 tokenizer 时使用精确输入计数；没有时继续采用已登记的 UTF-8 保守输入单位并留余量，不用“字节÷2/3”或历史 token 比例证明这次适配。每次外发都检查真实序列化载荷与冻结预算。

### 2. 容量内优先完整读取，话题作为组织辅助

Agent 执行宿主仍按冻结字幕身份、输入水位与确定性覆盖规则读取完整提交内容。能证明完整请求适配时，优先把完整输入交给模型；界面上的话题章节与执行输入分块分别处理。

候选三阶段：

1. **话题组织**：完整原始转写生成话题目录、来源范围、重要事实与跨话题的较晚修订。
2. **撰写**：完整原始转写加话题目录生成会后结构化纪要，允许直接从原文补回目录遗漏。
3. **核对**：完整原始转写加纪要检查日期、数字、否定、条件、责任归属及后文撤销，纠正后只提交一份最终结果。

每阶段的完整载荷包含上一阶段结果，因此“原文能放入”不等于三阶段都能放入；计划形成时要证明各阶段适配并预留最坏额度。阶段数量、工具授权和输出结构静态登记，计划及模型运行绑定在首个调用前冻结，继续经同一 Agent Loop 与共享预算执行。模型不得自行增加无界阶段。

宿主可核验来源范围存在且输入传递覆盖完整，但无法仅凭引用范围证明每条摘要事实正确。话题目录是派生辅助，不成为新的事实权威；不得让模型挑选少量片段后声称读过完整会话，也不得只用目录替代撰写/核对阶段的原始输入。只有真实预算不能容纳时，采用确定性输入分块、保留足够中间事实并归并；中间正文仅在有界内存中存在。

### 3. 用内容边界组织话题，保留修订关系

建议在提示中明确：同一问题的解释、例子、追问与反驳归在同一话题；表达尚未结束时不强行拆开。讨论对象或问题明显变化时再建立新话题，停顿、口头转场只作线索。

回到先前议题时关联原话题，允许来源范围不连续并保留发生顺序。后文的决定修订、撤销或条件变化必须覆盖旧说法的当前状态；不把两者写成同时成立。边界不确定时不要强行划为等长块；话题大小可以不同。来源核验须检查各范围实际内容，不能用一个宽泛起止范围掩盖跨话题混杂。

用户展示仍可保留“主要内容 / 决定 / 待办 / 需要注意”：主要内容按话题成段，其它条目关联对应话题。这是展示建议，不替换 CONTEXT.md 的概要、结论、待办、风险内部术语。若新增机器可读的话题字段、非连续来源结构或内部中间 Schema，应登记新的 exact Schema/recipe 版本；当前 SummaryMinutesV1 不接受任意附加字段或个人记忆引用字段。会话总结记忆参考偏好与个人记忆授权继续执法，不为提高质量自动读取全部记忆。

### 4. 改善超限反馈，保留有界失败

界面应根据稳定错误码和 outputValidation 闭集字段说明实际原因。例如：“中间结果超过处理上限：13,183 / 8,192 字节。”同时区分 JSON、Schema、来源、响应协议或传输预算错误。旧记录没有真实 finish_reason 时继续显示未知；不能反推模型达到 token 上限。

提高容量后仍保留严格整体字节检查，不自动裁切正文或数组。可另行评估对“JSON、Schema、来源都已合法，仅中间尺寸超限”的节点最多一次再生成；是否采用以质量评估决定，压短不是默认首选。新修复需登记 SEM-F28/J30 与政策身份，因为现有 AGENT_OUTPUT_INVALID 非重试。来源越权与协议错误不能混入尺寸修复。

修复、工具后续轮和网络重试都使用同一冻结绑定及共享累计预算，不能每阶段重置；取消、来源失效、缺额和后段失败保持零部分纪要。诊断只保存阶段/节点计数、闭集原因、实际/上限、实际用量和相对耗时，不保存中间正文、内部思维过程或原始响应。

## 为什么不能单改中间上限

当前 planner 的预留公式为：

    fanIn = min(4, floor((promptLimit - 4096 - wireBytes(userPrompt))
                         / (2 * INTERMEDIATE_LIMIT)))

当前最大输入轴对应 promptLimit≤111,808 字节；基准模型 maxInputTokens=65,536 对应 promptLimit=57,344 字节。共享常量升到 32 KiB 后，即使最大输入轴扇入也至多为 1；16 KiB 在基准模型下也至多为 1。多叶计划要求至少 2 项扇入，结果会在规划期拒绝。更长用户提示只会减小余量。[现有 planner](../../src/agent/execution-host/summary-input-plan.js)

新策略应协调输入窗口、序列化预留与分组规则，按已确认能力在首个请求前证明适配；较小模型保留各自真实容量，不强行承诺 128 KiB 中间结果。需要拆分的超大输入继续保证完整覆盖、来源顺序、有效扇入和零部分提交。

## 实施验证与方案选择

至少扩展 J31-SIZE/J31-COVERAGE/J31-MERGE/J31-BUDGET/J31-COMPAT、J29 与 J30-DIAG/CANCEL/RECOVERY：

- 新旧边界的减一、等于、加一；中文、emoji、引号、反斜杠、换行及嵌套 JSON 转义；较大思考响应。
- 完整原文能适配与仅后续阶段超界；确需分块时的全部事件/code point 范围覆盖；非连续话题来源与较晚修订。
- 思考加工具的协议回传、用量分项、未知 usage、请求/响应有界保护、时间和累计预算。
- 后段失败、取消、来源撤销、迟到输出、应用重启继续、零部分提交、旧绑定和旧导出不被升级。

质量评估比较完整输入一次生成、完整输入三阶段、现有分块归并；采用相同受控会话与事实清单，检查首/中/尾关键信息、跨话题关系、数字、否定、较晚撤销、未决定事项、待办责任与期限，以及事实的引用依据。记录事实保留率、无依据陈述、正确修订、总请求数、实际用量和相对耗时。输入覆盖与模型自我核对不能替代人工内容评估。先看质量再选默认流程，不以输出更长或调用更多作为胜出依据。

本轮仅修订研究笔记，未修改产品代码、语义合同、旅程矩阵或模型配置，也未发起真实模型请求。纯文档验证按 testing-strategy §2.1 核对术语、事实/建议区分、引用与差异；本文关联 SEM-F38、SEM-F39、SEM-F40、SEM-F28 和 J29/J30/J31，不声明相关产品旅程验收。

