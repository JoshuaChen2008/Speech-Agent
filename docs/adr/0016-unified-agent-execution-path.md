# ADR 0016：取消单轮与 Agent Loop 的二分，Agent 系统只保留一条执行路径

- 状态：已决定
- 日期：2026-08-30
- 决策者：项目负责人
- 依赖：ADR 0013、ADR 0014
- 取代：[ADR 0013](0013-agent-deep-modules-and-execution-host.md) 第 4 项（整体）
- 修订：[ADR 0013](0013-agent-deep-modules-and-execution-host.md) 第 2 项的 recipe 静态登记字段、第 9 项的输入预算来源表述
- 保留不变：ADR 0013 第 1、3、5、6、7、8、10 项；[ADR 0014](0014-multi-profile-model-access-layer.md) 全部

## 背景

ADR 0013 第 4 项把固定 recipe 运行分成「单轮结构化请求」与「Agent Loop」两种执行形态，默认单轮；只有 `report.analysis` 与 `plan.proposal` 同时满足四条件（recipe 属于这两者、冻结范围跨两个及以上终态会话、冻结个人上下文包命中内部上界、确定性估算输入达到模型运行绑定输入预算的 70%）时，才在运行创建期一次性升级并冻结 `execution_form` 与 `escalation_reason`。

在为 S3–S5 冻结总规格时，这个形状暴露三个问题。

**第一，条件四与 `bind()` 存在循环依赖，无法实现。** 条件四引用的「模型运行绑定输入预算」是十轴的第 2 轴，`src/agent/contracts/budget-axes.js` 把它定义为 `min(capability.maxInputTokens, 120000)`，只有解析出精确 `(profileId, modelId)` 才能得到。但 ADR 0014 第 1 项与 S2 已实现的 `src/agent/contracts/model-access-core.js` 已把 `bind(runRequest)` 冻结为 exact `{ runId, recipeId, recipeVersion, executionForm }`——调用方必须先给出执行形态。SEM-F33 又规定接入层「恰好」三个能力，不允许加第四个接口来先取预算。实现者只剩三条出路：先写 `single_shot` 绑定再改写（违反绑定不可变）、由宿主自行解析档案与 model（违反「调用方不给档案、model、URL、header、预算或凭据」）、或把阈值写成与模型无关的常量（违反「按模型运行绑定推导」）。三条都会破坏一条已决定语义，且都不会被 Schema 层测试发现。

**第二，二分在底层没有对应物。** `@earendil-works/pi-agent-core@0.84.1` 的 `agentLoop(prompts, context, config, signal, streamFn)` 中，`AgentContext` 的 `tools` 是可选字段，`config.shouldStopAfterTurn(...)` 决定何时停止。「问一次就结束」与「反复迭代」是同一段循环在第 1 轮停下和第 N 轮停下的区别，不是两条代码路径。产品层维护的二分是自造抽象，它带来两套执行代码、两套预算推导、两套测试矩阵与一次运行期判定，而底层不需要其中任何一项。

**第三，产品判断有误。** 首版十个已登记 recipe 全部是问答、信息提取、摘要与总结、分析、规划、文本转换与个人上下文摄取，本质都需要模型带着受限上下文产出内容，其中多数还需要在个人上下文包内检索来源。真正「不需要模型思考」的操作——删除、忘记、修改一条个人记忆，切换处理档位——根本不是 recipe，而是个人上下文模块 `manage(command)` 的确定性命令，从不进入 Agent 执行宿主。因此「默认不进入 Agent Loop」保护的是一个空集合。

## 决策

1. **取消 `single_shot` / `agent_loop` 二分与运行期升级判定。** Agent 执行宿主只保留一条执行路径：所有固定 recipe 运行都由 Pi 低层 Agent 核心的同一个有界循环执行。ADR 0013 第 4 项与 SEM-F28 中的四条件 AND 升级段落整体作废。`escalation_reason` 这一概念取消，不在任何表、投影或导出中出现。

2. **执行差异改由 recipe 静态登记表达。** 每个已登记 recipe 在 SEM-F16 的闭集中额外静态声明两项：`maxTurns`（轮次上限）与 `toolGrants`（授权的只读工具，可为空数组）。二者随应用发布，不可配置、不向用户展示、不在运行期判定，也不随冻结输入、模型或范围改变。同一 `recipeId + recipeVersion` 永远给出同一 `maxTurns` 与 `toolGrants`。

3. **轮次分三档，与 recipe 的检索需求对齐。** 档位本身是登记事实而不是新枚举，产品与 UI 不暴露档位名：
   - `maxTurns = 1`、`toolGrants = []`：输入已由用户完整给定、没有检索空间的文本变换（`text.rewrite`、`text.translate`）。
   - `maxTurns = 3`、`toolGrants = ['search_context']`：需要在冻结个人上下文包内检索，但结论范围有界（`qa.answer`、`extract.items`、`summary.minutes`、`text.enhance`、`context.ingest.session`、`context.ingest.interaction`）。其中 `context.ingest.session` 与 `context.ingest.interaction` 为两段式：runner 先以确定性方式建立会话经历记录的时间范围、来源引用、输入水位与 digest（零模型调用），再进入同一循环由模型提炼个人记忆条目；确定性前段位于 recipe 内部，不构成第二条执行路径。
   - `maxTurns = 6`、`toolGrants = ['search_context', 'read_sources']`：需要跨来源比对与回溯的派生产物（`report.analysis`、`plan.proposal`）。

4. **`supportsToolCalling` 只对有工具授权的 recipe 是硬绑定条件。** `toolGrants` 非空的 recipe 在 `bind()` 解析到 `supportsToolCalling=false` 的 model 时按 ADR 0014 第 5 项收束为配置问题；`toolGrants` 为空的 recipe 不要求该能力。这保证不支持工具调用的 OpenAI-compatible model 仍可用于文本变换用途，而不是整体退出 Agent 可用范围。

5. **十轴预算保留，只改第 1 轴的来源。** `maxTurns` 从「执行形态推导」改为「recipe 登记直接给出」；其余九轴的定义、数值与执法不变，仍只在 `src/agent/contracts/budget-axes.js` 定义一次。`deriveBudget()` 的签名相应从接受 `executionForm` 改为接受 recipe 登记的 `maxTurns` 与 `toolGrants`。任一轴触顶仍以 `AGENT_BUDGET_EXCEEDED` 进入 `failed` 且不写产物。

6. **`agent_model_run_bindings.execution_form` 保留但收敛为常量。** 该列是 v6 `STRICT` 表的既有列，追加迁移无法删除；按 ADR 0015 第 10 项不重建表。`bind()` 的 `executionForm` 参数保留在 exact 四字段中，但取值收窄为只接受 `'agent_loop'`，其余值以 `AGENT_REQUEST_INVALID` fail closed。该列此后只表示「本产品只有一条执行路径」，不再表达任何运行期判断，也不进入 UI 投影或单交互导出。

7. **Pi 接入面按本决策收紧。** 用 `agentLoop()` 与 `config.shouldStopAfterTurn(...)` 承载轮次上限与十轴预算的停止条件。继续不实现 `prepareNextTurn` / `prepareNextTurnWithContext`，以此保证一次运行内模型固定。不使用 `agentLoopContinue()` 做跨 attempt 恢复——恢复仍按 SEM-F28 为「保留旧 attempt 的工具调用记录后，在同一 `runId`、同一模型运行绑定、同一冻结输入下整体重跑并递增 attempt」。ADR 0014 第 13 项的其余禁用面不变，MIT 许可声明必须保留。

8. **`tools=[]` 的禁令改为「不得把工具授权为空的 recipe 描述为具备工具能力」。** 原禁令「不得把 `tools=[]` 的单轮请求称为 Agent Loop」针对的是二分被滥用；二分取消后，该禁令的产品含义转为：`toolGrants` 为空的 recipe 不得在 UI、报告或导出中呈现为「使用了只读工具」，其工具调用记录必须为空。SEM-T10 中「只有实际调用只读工具的 recipe 才按 Agent Loop 验收」相应改为「每个 recipe 按其登记的 `maxTurns` 与 `toolGrants` 验收」。

9. **同步与异步分档由请求来源决定，不由执行形态决定。** 用户经 Agent Bar 主动请求的运行同步呈现进度并可取消，使用交互墙钟档；终态会话后的个人上下文摄取与用户开启报告自动呈现偏好后的自动纪要请求异步执行，使用后台墙钟档。两档数值沿用 `budget-axes.js` 现有的 60 s / 180 s，不新增枚举。

## 取舍

- 相比保留二分，本方案去掉一次无法实现的运行期判定、一条循环依赖和一半的执行代码与测试矩阵；代价是所有 recipe 都必须声明轮次与工具授权，登记表变宽，且新增 recipe 时必须同时裁定这两项而不能沿用默认值。
- 相比让所有 recipe 使用同一套循环预算，分三档避免了文本变换类 recipe 被授予工具与多轮而浪费 token、扩大失败面；代价是档位划分本身成为需要评审的产品判断，而不是可推导的结论。
- 相比删除 `execution_form` 列，保留并收敛为常量使 S2 的 v6 migration、checksum、`bind()` 四字段签名与既有回归全部不变；代价是数据模型里留下一列恒定值，必须在 `data-architecture.md` 明确标注其语义已收敛，以免后来者误读为仍有二分。
- 相比让 `supportsToolCalling` 成为所有 recipe 的硬条件，按 `toolGrants` 分别要求保住了不支持工具调用的 model 的文本变换用途；代价是 `bind()` 的能力校验分支多一条，且 `catalog()` 的 readiness 需要按「是否需要工具」分别派生。

## 未选择

- 保留四条件 AND 升级、`escalation_reason`，或任何在运行创建期之外改变执行形态的路径。
- 为解决循环依赖给 Agent 模型接入层增加第四个接口，或让执行宿主自行解析档案、model、URL 或凭据。
- 让 LLM 决定自己的轮次上限、工具授权或是否继续迭代（`shouldStopAfterTurn` 是产品拥有的确定性判定，不是模型输出）。
- 使用 `agentLoopContinue()` 恢复中断运行的中间状态。
- 实现 `prepareNextTurn` 的换模型路径。
- 重建 `agent_model_run_bindings` 以删除 `execution_form` 列。
- 把 `manage(command)` 这类确定性操作包装成 recipe 或模型请求。

## 关联

- 语义：SEM-F16、SEM-F28、SEM-F30、SEM-F33、SEM-F34、SEM-T10、SEM-T15
- 旅程：J22（Agent Bar 与固定 recipe）、J24（正式 Agent 正常使用边界组合）
- 数据：`agent_model_run_bindings`（v6，`execution_form` 收敛为常量）、`formal_agent_interactions` 与 `formal_agent_tool_calls`（v7，见 [`../data-architecture.md`](../data-architecture.md)）
- 上游依赖形状：`@earendil-works/pi-agent-core@0.84.1` 的 `agentLoop` / `AgentContext` / `AgentLoopConfig.shouldStopAfterTurn`
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)
