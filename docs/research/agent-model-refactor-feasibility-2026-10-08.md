# Agent 模型层重构可行性调研

调研日期：2026-10-08。范围：Agent 模型接入层、Agent 执行宿主和正式操作入口；不包含字幕识别模型重构。本文件是研究与建议，不改写 CONTEXT、语义合同、ADR 或 OpenSpec，不构成产品实现或验收证据。

## 判断

**现有 C → D → E 的职责划分可行，并且值得实施。** 当前 adapter 同时拥有 HTTP、消息循环、工具执行和局部重试，确实存在可抽取的接缝。优化重点是把一次外发与运行政策分开，并保住已有冻结身份、持久预算、取消和 SQLite 提交规则。没有证据要求迁入完整 tau、coding-agent、动态插件或第二套持久化框架。

其中，C 可以在现有代码内提取；D 需要先处理“文档要求 Pi 低层 Agent 核心，但当前生产实现没有实际 Pi 接入”的事实差异。继续采用 Pi、接入哪个固定版本，以及是否修订已决定架构，必须按 SEM-T06 先登记，不能以研究结论直接替代 ADR 0016。

## 仓库事实

| 已核对的事实 | 证据与含义 |
|---|---|
| [推进计划](../agent-refactor-roadmap.md) 明确 A → B → C → D → E；C/D/E 的 proposal/design/tasks 均写明待评审，实施任务未勾选 | 本次研究不能把规划投影为实现状态。A/B 的现有行为与相应旅程应成为迁移基线。 |
| [AgentLoopExecutor](../../src/agent/execution-host/agent-loop.js) 校验 recipe、工具授权、容量和取消，然后调用 `runAdapterBounded(adapter.run)` | 当前命名不表示循环已经位于执行宿主；真正的多轮消息和工具循环在 [OpenAiCompatibleAdapter](../../src/agent/model-access/openai-compatible-adapter.js) 中。 |
| adapter 的 `while`、请求重试和 `tool.execute` 位于同一实现；[正式 runner](../../src/agent/execution-host/formal-agent-run-runner.js) 在实际外发前持久预留，并以 `retryExhausted` 防止局部耗尽后外层无条件重放 | 已有防重复重试措施。重构应收敛所有权，不能误称当前没有预算或防双重重试机制。 |
| [模型接入 runtime](../../src/agent/model-access/runtime.js) 用 `borrowForBinding` 包裹整个 `adapter.run`；[vault](../../src/agent/model-access/credential-vault.js) 释放时尽力清零副本 | 凭据目前覆盖多轮、工具等待和退避生命周期；提取 exchange 后有机会缩短到每次外发。 |
| adapter 的 `boundedJson` 先 `response.text()`/`json()`，再检查字节；[Embedding 接入](../../src/agent/model-access/embedding-access.js) 已有逐块 reader 限额 | 缺少或不可信的 Content-Length 下，读取后的检查无法形成消费过程中的正文硬上界；这是代码可确认的优化空间，尚未复现资源故障。 |
| 对 `package.json`、`package-lock.json` 和生产 `src` 搜索 `earendil/mariozechner/pi-ai/pi-agent-core` 无匹配 | [CONTEXT](../../CONTEXT.md) 和 [ADR 0016](../adr/0016-unified-agent-execution-path.md) 对 Pi 的要求与当前树存在架构缺口。D 的既有任务 1.2 已要求盘点这种差异。 |

本地主要定位：adapter 54–70（响应读取）、300（循环）、390–437（局部重试）、453（结束原因）、518（工具执行）；model-access runtime 275–283（借用边界）；正式 runner 446–458（请求预留）、569（耗尽保护）。

## 外部事实及对本项目的推断

### tau 的分层支持当前方向

tau 第一方仓库采用 `tau_coding → tau_agent → tau_ai`：provider 层归一化模型事件，portable core 拥有消息、工具和循环，应用层组合 CLI/UI、配置与持久化。core 不依赖具体前端或文件布局。这支持本项目“操作层 → Agent 执行宿主 → 接入层内部 adapter”的单向依赖；它不要求三个进程，也不要求迁入 tau 的 Python 与 JSONL session。[tau README，固定修订](https://github.com/huggingface/tau/blob/c41aacf76b9fe20bc0a373e40f5221682b185d01/README.md)

本项目的 SQLite 单写者、正式 Agent 交互和个人上下文治理已有明确语义，因此只借鉴依赖与事件合同是成本较小的推断。原规划引用的 tau 架构网址本轮抓取失败，以上结论使用可核对的第一方仓库替代。

### Pi 需要固定版本并核对真实接入

当前 Pi 低层包仍为 `@earendil-works/pi-ai` 和 `@earendil-works/pi-agent-core`。`pi-ai` 支持实例级 `createModels()`、精确 `getModel(providerId, modelId)`、按需 provider factory 和自定义 `createProvider()`；凭据存储可由宿主注入。它不替产品定义模型用途、冻结策略、SQLite 权威或授权规则。[Pi AI README](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/ai/README.md)

Pi 在 0.87.0（2026-09-21）移除了 `shouldStopAfterTurn`，改用 `finishTurn` 返回 `{ action: "end" }`；并新增每次 provider request 前执行的 `prepareRequest`。当前 changelog 还说明实验 durable harness 已移出 agent-core，durable sessions 属于另外的 `pi-durable`。[Pi Agent changelog](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/agent/CHANGELOG.md)

源码核对显示：`finishTurn` 在 assistant 和本轮工具结果收束后执行；error/aborted 是硬退出；`length` 结束时拒绝执行可能被截断的工具调用。`prepareRequest` 可以替换 context，也可以替换 model/thinking level。**仅禁用旧 `prepareNextTurn` 换模型路径已不足以保证运行绑定冻结。** 若接入当前版本，应限制可注入更新，并在每次外发复核冻结身份；预算与取消还要在请求和工具执行前检查，不能只靠回合结束钩子。[Pi loop 固定源码](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/agent/src/agent-loop.ts) · [Pi types 固定源码](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/agent/src/types.ts)

当前 Pi 默认允许工具并行，`tool_execution_end` 事件按实际结束顺序产生，toolResult 按 assistant 原始调用顺序回填。采用时应显式设置符合 recipe 和预算的执行策略，保留本项目 `(attempt, call_order)` 审计全序；不能由框架默认并行度覆盖已登记预算。[Pi agent README](https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/agent/README.md)

上述变化意味着 [2026-08-29 的既有调研](agent-harness-reference-notes.md) 中 `shouldStopAfterTurn` 和 AgentHarness 段落只能作为历史资料。ADR 0016 基于 0.84.1 的陈述也必须按固定版本解释，不能直接对照 main 实施。

### OpenAI-compatible 不等于输出能力完全一致

DeepSeek JSON Output 要求 `response_format=json_object`，指令中包含 JSON，并建议给出输出示例；官方还说明可能出现空输出。它保证的格式目标不能替代产品输出 Schema、来源与预算校验。[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/)

DeepSeek 工具 strict 是 `/beta` 特性，要求受支持的 Schema；对象字段要求 `required` 和 `additionalProperties=false`。它和普通 JSON mode 是不同合同，应用仍负责执行工具和回传对应 ID。[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)

OpenAI 官方明确区分 JSON mode 与按 Schema 约束的 Structured Outputs；Qwen 也区分两者，Schema 模式只支持部分模型，部分 thinking 组合即使请求不报错也不会产生预期结构化行为。因此 `supportsStructuredOutput=true` 这一粗粒度声明不应被 adapter 解释成任意结构化方言都受支持。[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) · [Qwen 结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)

建议 C 将已有受控 request strategy 与 `outputContract` 的 JSON、Schema 和工具声明方言明确分开，固定到运行解释中。可以先用内部版本化策略实现，不必立即扩大用户可填写的六字段能力或新增厂商入口；若要改变公开能力语义，须先登记 SEM-F33/J25。

DeepSeek 当前结束原因包含 `stop/length/content_filter/tool_calls/insufficient_system_resource/aborted`。本地 adapter 目前只接受 stop/tool_calls，其它归为输出无效。建议 exchange 保留识别到的结束原因，运行政策再决定终态；未知值明确拒绝。新增错误分类或重试行为必须先登记，不能把资源原因、截断或取消直接当自然结束。[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

## 建议补进后续评审的六点

| 优先顺序 | 建议 | 可检查的出口 |
|---|---|---|
| 1 / C | exchange 恰好一次外发，只含声明工具；保留 toolCallId、顺序、finishReason 和 nullable usage；JSON/Schema 方言由受控策略解释 | 网络替身驱动真实 adapter，证明零工具执行、零内部重试；空输出、截断、畸形调用、能力不足有明确拒绝。 |
| 2 / D | 一个 owner 管理局部重试，操作层只管理持久 attempt；沿已有 `retryExhausted`、跨节点/attempt 同一账本，保留每次实际请求预留 | 429/临时故障/局部耗尽/重启后限额仍相同；如果以后引入 SDK，关闭或纳入其内部重试。 |
| 3 / C | 响应按块累计字节，超限立即取消 reader；Content-Length 只作预检，成功/错误响应均受界限 | 无 Content-Length、伪造长度、分块超限、取消读取覆盖；上界在消费期间生效。 |
| 4 / C→D | 凭据每次 exchange 才借用，释放后再执行工具或等待退避；绑定仍固定不透明槽位，clear/delete 后不得借用新槽 | 工具等待和退避不持有产品的凭据字节副本；401/403 只失效相应档案；旧 binding 不借后来同名档案凭据。 |
| 5 / D | 实施前登记 Pi 实际缺口，选定并固定版本；如采用新 API，显式限制模型替换和工具并行 | 真实生产组合根调用已裁定的唯一循环；每次请求身份、recipe、预算一致，存在依赖约束检查。 |
| 6 / C→D→E | C 先让旧门面调用 exchange；D 一次切换组合根并删除 adapter 循环；E 合并真实重复资格/通知逻辑后再迁移目录 | 生产始终一条执行路径；全部 recipe 和长输入节点复用；SQLite 快照权威、同事务结果提交、旧绑定/导出解释和字幕独立旅程保留。 |

重试细节可以在既有次数约束内优化：有效 `Retry-After` 优先，缺失时指数退避加 jitter，所有等待受剩余总期限约束；每次请求 timeout 与 run 总期限分别执法。OpenAI 官方建议应用自管重试时禁用 SDK 重试并遵守总限额。本地当前退避为有限指数等待，尚无 jitter 或 Retry-After，不据此断言已发生重试风暴。[OpenAI Rate limits](https://developers.openai.com/api/docs/guides/rate-limits)

响应限额建议的标准依据是 Fetch `text()` 消费整个 body 的定义；不能把读取后的长度检查当成流式内存保护。[Fetch Body 标准](https://fetch.spec.whatwg.org/#dom-body-text)

## 验证与范围

- 本轮只新增本研究文件；未修改生产代码、语义合同、旅程矩阵或 C/D/E 规划，未运行产品测试，也未调用真实模型。
- 仓库侧已核对 CONTEXT 全文、相关 SEM-F28/F31/F33/F38/F39/F40、ADR 0009/0016/0021、testing-strategy §2 和 J22/J24/J25/J29/J30/J31，以及三片规划和现行调用链。
- 实施时按 SEM-T06 先登记具体变化，再沿 SEM-T01/T02 的真实内部模块旅程验证；C 关注 J25/J29/J30，D 关注 J22/J24/J30/J31，E 关注正式 Electron J29/J30 和 J12 字幕独立。当前 revision 的阶段联合验收需完整三条 lane，真实公网、系统凭据和实机证据另验。
- 外部接口事实以本次官方资料和固定源码修订为准；性能收益、取消端到端期限、峰值内存和真实模型结构化输出兼容性尚未测量。本文件的“可行”是基于职责边界与源码的工程判断，不是联合验收结论。
