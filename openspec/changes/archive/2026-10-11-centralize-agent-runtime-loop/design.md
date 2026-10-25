## Context

依赖 C 的单次 exchange；按 ADR 0016/0021 统一全部固定 recipe 的 Agent Loop，保留持久请求预留与 retryExhausted 保护。实施前发现生产代码尚未接入 Pi。[调研](../../../../docs/research/agent-model-refactor-feasibility-2026-10-08.md) 的后续版本使用 finishTurn 且默认工具并行；本切片按 ADR 0016 核验并固定 0.84.1，使用实际导出的 shouldStopAfterTurn 与显式串行配置，未偏离 ADR。

## Goals / Non-Goals

**Goals:** 唯一循环、串行工具、单一重试决策点，保持冻结绑定及跨 attempt 预算。
**Non-Goals:** 重写输入规划、增加恢复正文库、自动换模型、增加并发 Agent 或改变 recipe 权限。

## Decisions

1. **先核对 Pi 资格。** 默认遵循 ADR 0016 接入低层核心。先固定确切包版本/源码及 lockfile，验证与 Electron/Node 构建兼容，记录四类钩子的映射。调研版本只作证据，不自动采用 latest；若必须偏离 ADR，先登记架构决策再实现。不得把未接入当作已接入。
2. **一个控制入口。** 宿主按“取消/权限/预算检查 → 持久预留确认 → exchange → 响应与工具校验 → 串行执行工具 → 追加观察 → 结束或下一轮”调度。Pi 只承载低层循环；模型交换通过 C，不能旁路模型接入层。runtime 通过受控接口使用存储与工具，不依赖 Electron、renderer 或凭据实现。
3. **请求前和工具前约束。** 每次实际外发前核验冻结模型身份、策略和剩余预算；请求准备钩子不能换模型或扩大权限。工具并发固定为 1，按返回顺序执行并形成既有 (attempt, call_order) 审计。0.84.1 的 shouldStopAfterTurn 在工具之后，只承担轮次结束，不能单独承担预算或取消屏障。
4. **预算与重试。** 沿用既有十轴、run/attempt/Loop 作用域及持久账本；预留未获确认不得外发，每次实际 HTTP 尝试都占用请求次数。同一操作耗尽继续向外层传播，不能通过新 attempt 重放。SDK/库隐式重试关闭。新重试政策先登记并版本化：有效 Retry-After 作为最早重试时间，否则指数退避加抖动；等待受取消和剩余总期限约束，无法在期限内重试则收束。旧运行保持原政策。
5. **结果与生命周期。** 取消、失租、旧代次在请求前、工具前及产物提交前都检查；提交仍由原持久竞争规则裁决，迟到成功不能覆盖已成立取消。输出 Schema 继续由宿主校验；未知 usage 保持未知，不用估算值补齐。
6. **所有 recipe 与计划节点。** 短输入、问答、摄取和长输入节点使用同一入口、冻结模型身份与各自政策作用域。保留确定性覆盖、顺序及累计预算；任何节点失败不提交部分纪要。中间正文仅在有界内存中存在，恢复沿用显式继续、新 attempt 和冻结输入重执行，不引入 Loop 中途续接。

## Risks / Trade-offs

Pi 钩子时机或自动重试可能绕过控制：先用真实核心与受控网络验证，再迁移生产入口。新旧策略混用会改变恢复成本：按冻结版本分派，补旧绑定回归。取消与成功竞争：沿用 SQLite 原子裁决，不能由内存事件覆盖持久终态。

## Migration Plan

C 行为与旅程证据成立 → Pi 版本及钩子资格 → 语义登记 → 宿主循环与预算接线 → 全部调用者迁移 → 组合入口切换 → 删除 adapter 旧循环/工具/重试 → 真实旅程验证。任一前置条件不成立时不切换生产入口。

## 2026-10-09 实施事实与 Pi 资格（实现完成·尚未验收）

直接依赖 `@earendil-works/pi-agent-core` 使用精确版本 0.84.1，package-lock 保存 registry 来源及完整 integrity，同族 pi-ai/pi-telemetry 以 overrides 固定 0.84.1。核心 tarball SHA-1 为 `a611675f289cba8c1404f6a4e78d26c0bb9625c7`；保留上游 MIT 通知 `src/agent/execution-host/PI-NOTICE.md`，使用既有打包白名单支持的扩展名。真实核心资格 fixture 在 Node、Electron 主进程及 utility 进程使用显式 streamFn，验证两工具后结果、最大并发 1、两工具间取消、固定模型指针和单次错误零隐式重试。renderer 类型检查与构建沿原脚本验证。

| Pi 边界 | 宿主映射 | 验证与约束 |
|---|---|---|
| 显式 streamFn | 固定模型与系统提示、C 编码预检、持久 beforeRequest 确认、单次 exchange | 每个实际 HTTP 占用请求；未知或重复回执零外发且不由外层自动重放。 |
| beforeToolCall + 每个 execute | 取消/总期限检查；真实 ControlledToolRuntime 与 ToolAuditRuntime 校验授权、参数、租约、来源、工具预算 | `toolExecution: 'sequential'`；保留 provider 顺序和原始结构化参数，不使用 Pi 参数强制转换代替产品校验。 |
| shouldStopAfterTurn | 致命错误、取消、有效结果或静态轮次上限结束 | 不作为请求/工具前屏障；末轮工具与工具预算预检在 execute 前拒绝。 |
| 父 AbortSignal + SQLite 提交 | 取消/失租/停机与非合作网络等待竞争，runner 在提交前复核冻结输入和请求代次 | 迟到结果不能覆盖持久取消，旧来源与旧代次不能提交产物。 |

`pi-loop-runtime.js` 只用低层 agentLoop 和显式 exchange；不安装默认 provider、模型/凭据发现、prepareNextTurn、agentLoopContinue、steering/follow-up 或完整 coding-agent。中间消息与工具观察仅在内存，退出释放；不保存现场音频。

新建运行在既有 retry_policy_version 列写入 `agent-retry@2`；null/@1 均继续 @1 解释。@1 为最多五次单操作、100ms 起/1000ms 封顶无抖动；@2 为相同次数上限、有效 Retry-After 最早时间，缺失时 0.5–1 倍指数退避抖动。逐次持久确认，等待可取消且不能延长剩余总期限；局部耗尽传播 retryExhausted。网络读取 TimeoutError 不冒充总期限耗尽；原有跨 attempt 恢复保留已知累计值与未知用量。长于 1000ms 的等待只投影阶段/次数并清除短等待元数据，不改诊断快照合同。

请求与工具继续使用既有 SQLite 账本；同一操作最多五次跨 attempt 保护覆盖 @1/@2/null。queued intent.route 通过同一内部预留命令核验 recipe、冻结绑定、取消、会话删除和请求代次。未新增迁移或回写旧模型运行绑定。

| 全部生产调用者 | 唯一入口与作用域 |
|---|---|
| IntentRouteOrchestrator | intent.route@1，queued routeRunId 请求预留。 |
| FormalAgentRunRunner | summary.minutes@1–@2、qa.answer@1–@5；总结/问答的分块、归并、检索节点逐次 invoke 同一 AgentLoopExecutor，共享绑定和持久累计账本。 |
| ContextIngestSessionRunner | context.ingest.session@1–@2、context.ingest.interaction@1–@2、context.synthesize@1–@2；每次 exchange 已预留。 |
| SessionExperienceExecutor | context.ingest.session@3 的 experience-input 范围节点，同一冻结绑定、连续提交前缀及累计账本。 |

catalog 的其余固定 recipe（extract.items@1、report.analysis@1、plan.proposal@1、text.enhance@1、text.rewrite@1、text.translate@1）由同一入口的全部 21 个 recipe 资格回归覆盖；未增加新的正式受理入口。旧 adapter.run、runWithBinding 与 adapter 循环/工具/重试分支已删除；模型测试独立执行一次 C exchange。

## 向 E 交接

E 复用 modelAccess.bind 与内部 createLoopAdapter(binding) 返回的不可变 `{ binding, requestStrategy, exchange }`，只经 AgentLoopExecutor.agentLoop 执行静态 recipe。输入已有 beforeRequest、getRunUsage、onRequestUsage、retryPolicyVersion、AbortSignal 和安全进度回调；请求必须取得真实预留确认，policy 以持久回执/领取作业为准。不得重新引入 runWithBinding、provider 循环、模型替换或第二份持久恢复状态。

组合层仍拥有 scheduler、runner、工具调用记录与提交；模型接入 facade 的 catalog/configure/bind 职责不变，主进程将 route 请求预留接到既有 gateway。renderer/preload 公共契约未增加。实际命令、结果与未验证范围见 [D 验证记录](../../../../docs/validation/agent-loop-runtime-2026-10-09.md)。
