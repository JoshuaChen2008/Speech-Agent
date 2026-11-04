## Context（实施前基线）

C 是协议提取切片，实施顺序仍遵循 [推进计划](../../../../docs/agent-refactor-roadmap.md)。当前 adapter 持有循环和重试；响应读完整后才检查大小，凭据借用覆盖整次运行。详见 [调研](../../../../docs/research/agent-model-refactor-feasibility-2026-10-08.md)。

## Goals / Non-Goals

**Goals:** 统一单次交换合同，封装厂商格式，限制响应读取与凭据生命周期。
**Non-Goals:** 迁移 Agent Loop、修改十轴预算、增加供应商/用户能力字段、引入新进程或通用框架。

## Decisions

1. **内部合同。** exchange 接收统一消息、工具声明、输出合同、请求限制和 AbortSignal；通过受控绑定取得连接与凭据，不允许调用者自选模型或 URL。返回消息、保持 ID/顺序的工具调用、归一结束原因、可空用量及有界错误分类；禁止传递原始 Error/body。
2. **一次外发。** 每次 exchange 至多一次 HTTP 请求；预检拒绝时为零次。它不执行工具、追加下一轮、重试、选择模型或写入数据库。旧运行门面复用 exchange，保持唯一生产路径，待 D 删除旧控制逻辑。
3. **版本化请求策略。** 复用 generic、DeepSeek、Qwen 已有策略；内部区分普通文本、JSON 输出与严格 Schema，逐项映射能力、端点和参数。JSON 输出仍由宿主校验业务 Schema；不能证明所需模式的组合在外发前拒绝，不静默降低要求。六字段能力与四个模型用途不扩展；新语义先登记，旧绑定继续按冻结策略解释。
4. **凭据与连接。** 每次 exchange 单独借用同一绑定的凭据槽，保留撤销检查、受信任 origin 和 redirect 拒绝。成功、异常、取消均释放借用并清零可清零的副本；返回工具调用或进入重试等待前不保留该借用，不承诺 JavaScript 字符串可强制擦除。
5. **有界读取。** Content-Length 只能提前拒绝；实际消费响应块时累计字节，超限立即取消读取并拒绝解析，成功和错误响应共用限额。保留请求期限、宿主收束及迟到响应屏障；读取分块不等于新增 token 流式能力。
6. **事实保真。** 区分正常结束、工具请求、截断、拒绝和未知结束原因；由宿主沿用已登记失败策略，不能把截断当成功或自动扩大重试。缺失 usage 保持未知，活动事件仅来自实际观测，不保存 reasoning 或原始响应。

## Risks / Trade-offs

厂商参数组合可能变化：测试固定请求策略与代表性响应，不据通用兼容声明推断能力。缩短凭据借用可能影响撤销时序：覆盖两次 exchange 之间撤销的失败路径。读取限额限制应用消费的响应大小，不声称控制网络栈全部内存。

## Migration Plan

先核对语义与既有 A/B 接线，再建立合同及策略 fixture；提取 exchange 并切换旧门面；验证一次外发、读取限额、凭据释放和正式旅程；向 D 交付旧循环/工具/重试的删除清单。C 不新增 SQLite migration。

## Open Questions

无须新增产品决策。内部合同版本号和模块文件名在实现时沿用仓库惯例；任何超出既有能力的协议支持另行登记。

## 2026-10-09 实施接线与 D 交接（历史切片）

合同位于 `src/agent/contracts/provider-exchange.js`；HTTP、读取限额和取消位于 `src/agent/model-access/provider-exchange.js`。`ModelAccessRuntime.runWithBinding` 将冻结绑定封装进 exchange 回调，旧 `OpenAiCompatibleAdapter.run` 通过该回调执行每次外发；`exchangeWithBinding` 每次重新读取凭据治理事实并借用同一槽，借用在鉴权配置清理前已释放。无新 SQLite migration、IPC 或配置字段。

| 内部合同 | 字段与边界 |
|---|---|
| 请求 v1 | exact `schemaVersion/messages/tools/outputContract/limits`；消息使用 `role/content/toolCallId/toolCalls`，工具声明只有 `name/parameters/description`。模型、URL、凭据及请求策略由绑定外侧注入，不能放入可序列化请求。 |
| 输出与限制 | `outputContract.mode` 为 text/json；三个冻结 @1 策略拒绝严格 Schema。limits 含输出 token、请求/响应字节、期限、序列化输入字节保护与登记的输入错误分类。JSON 格式不代替 recipe Schema 校验。 |
| 响应 v1 | exact 投影为 `schemaVersion/message/finishReason/usage`。工具调用保留 ID、顺序、解析后的参数及用于下一请求的原参数字节；用量为 ModelUsageV1 或 null，未知不估算。不投影 reasoning、厂商原始响应对象或任意 Error。 |
| 观测 | 只有真实 HTTP 调用和响应头返回产生 request_started/response_received；分块读取仅为字节执法，没有首 token 或 token 流式事件。 |

策略 fixture 在 `test/main/provider-exchange.test.js`；真实配置 IPC、SQLite 冻结绑定、adapter、vault 的旅程在 `model-access-s2-core-journey.test.js`。真实总结重试等待及问答 ToolHost 调用记录前观察借用清零。已有 text/json 网络替身统一在测试网络边界转为 ReadableStream；正式 Electron 的 loopback HTTP 替身同时投影被替换的可信 HTTPS 响应 origin，生产不提供读完整正文旁路。

交给 D 迁移并删除的路径：

1. `OpenAiCompatibleAdapter.run` 的轮次循环、消息追加、maxTurns 判定和用量累计；单次协议 encode/normalize 继续留在 exchange。
2. 同文件的 `toolDeclaration` 中执行函数校验、toolByName、`executeToolBounded` 与 `toolMessage`；工具声明序列化继续归 exchange，授权、参数验证及执行归宿主/ToolHost。
3. 同文件的最多五次有限重试、退避等待、retryExhausted 标记和运行级 deadline/取消；持久请求预留、十轴预算、跨 attempt 账本及宿主收束继续使用真实实现，不在新 Loop 建立另一账本。
4. `ModelAccessRuntime.createLoopAdapter/runWithBinding` 的 run 门面接线改为绑定后的 exchange 入口；凭据、origin、撤销与鉴权失效仍留模型接入层。独立模型测试也复用同一传输，保留其既有 JSON 探测语义与 64 KiB 限额。

D 必须先按 ADR0016 验证并锁定 Pi 低层依赖及适配范围，再切换唯一生产循环。C 没有引入 Pi 或替 D 勾选任务；A/B 的缺失验收证据仍按其原任务追踪。

## 2026-10-11 当前接线与归档边界

上述旧门面是 C 实施时的历史接线。D 已固定 Pi 0.84.1 并将循环、工具与重试迁入 Agent 执行宿主，删除 `OpenAiCompatibleAdapter.run`、`ModelAccessRuntime.runWithBinding` 及旧控制分支。当前 `createLoopAdapter(binding)` 只返回冻结的 `{ binding, requestStrategy, exchange }`，`exchangeWithBinding` 继续在每次外发独立核对与借用同一凭据槽；E 已将正式 main/preload/renderer 接入唯一产品操作服务。

本片主 spec 同步为 `agent-provider-exchange` 后归档，状态保持实现完成·尚未验收。实际源码指纹、复用的全量证据与未验证范围见 [归档核对记录](../../../../docs/validation/agent-refactor-closeout-2026-10-11.md)。
