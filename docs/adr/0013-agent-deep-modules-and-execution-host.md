# ADR 0013：Agent 系统改为两个深模块加一个执行宿主

- 状态：已决定
- 日期：2026-08-29
- 决策者：项目负责人
- 依赖：ADR 0001、ADR 0002
- 取代：[ADR 0003](0003-project-owned-agent-plugin-host.md)（整体）
- 修订：[ADR 0006](0006-local-structured-personal-memory.md) 第 10 项、[ADR 0009](0009-deterministic-agent-input-planning.md) 的宿主命名与输入预算来源
- 保留不变：[ADR 0012](0012-main-owned-agent-job-scheduler.md)

## 背景

ADR 0003 冻结了 `AgentPluginHost` 加八个显式端口加五个第一方插件的微内核结构，并把首版触发语义定为 `MeetingStopped` 后三项并列自动任务（结构化纪要、增强文本、个人记忆提取）。按该结构实现后暴露三个问题。

第一，插件与端口是浅模块。每个插件都要自己知道 recipe 批准了哪些端口、自己组装输入、自己解释记忆规则；`MemoryReader` 把「读取记忆表」而不是「解决一次运行需要什么上下文」暴露给调用方，导致记忆范围、预算、冲突与省略标记的规则在多个插件里重复出现。

第二，三项并列自动任务与后来确定的产品语义直接冲突。SEM-F28 与 SEM-F31 已确定纪要与增强文本默认不生成，只在用户明确请求、或用户明确开启报告自动呈现偏好后才对未来终态会话自动请求一次；ADR 0003 第 6 项要求的「每次会话停止后三项都跑」会在用户未请求时消耗模型费用并抢占界面。

第三，「动态插件生态后置」这个理由在首版不成立。首版能力全部是第一方、随应用发布、静态登记的，manifest 的 `apiVersion/kind/requires/permissions/activationEvents/contributes/failurePolicy/timeoutMs` 没有对应的真实可变性；它只增加一层需要维护和验收的间接层，而不换来任何当前需要的扩展点。

## 决策

1. Agent 系统由**两个深模块加一个执行宿主**构成：个人上下文模块（`ingest` / `resolve` / `manage`，SEM-F30）、Agent 模型接入层（`catalog` / `configure` / `bind`，SEM-F33，见 [ADR 0014](0014-multi-profile-model-access-layer.md)）、Agent 执行宿主（固定 recipe 闭集、受控工具、权限、预算、取消、错误隔离、产物提交）。
2. 取消 manifest / 插件 / 端口机制。执行宿主直接持有**静态封闭的已登记 recipe ID 闭集**；recipe 不是插件，不声明 manifest，不动态注册，不获得端口集合。recipe 的输入范围、可用工具、模型用途、输出 Schema、是否持久化与失败策略由产品静态登记并随应用发布，不可配置、不向用户展示 recipe ID。
3. `MemoryReader` 取消。个人上下文模块通过 `resolve` 返回一次固定 recipe 运行的**个人上下文包**——有界只读投影，含明确范围、会话经历记录、相关个人记忆、字幕来源引用、输入水位/版本/digest、预算与省略标记。调用方不取得完整个人记忆表，也不重复实现记忆规则。
4. 单轮结构化请求与 Agent Loop 分开。默认不进入 Agent Loop；只有 `report.analysis` 与 `plan.proposal` 同时满足四条件（recipe 属于这两者、冻结范围跨两个及以上终态会话、冻结个人上下文包命中内部上界、确定性估算输入达到模型运行绑定输入预算的 70%）时，才在运行创建期一次性升级，并把 `execution_form` 与 `escalation_reason` 冻结写入，运行中不得改变。
5. 取消 `MeetingStopped` 后三项并列自动任务。终态会话后默认只创建**一个个人上下文摄取工作**；纪要、增强文本、分析报告与规划建议一律由用户经 Agent Bar 明确请求，或在用户明确开启报告自动呈现偏好后对未来终态会话自动请求一次并以非模态方式呈现。
6. 受控工具是执行宿主拥有的**只读内容型工具闭集**，随应用发布，按 recipe 静态授权。工具错误码是独立于任务错误码的闭集；工具调用记录按 `(attempt, call_order)` 全序保留（SEM-F34），重试后旧 attempt 的记录一律保留。模型在工具调用之外产生的中间 assistant 文本与内部思维过程零持久化，只在内存中作为本次运行上下文。
7. 保留 ADR 0003 的两条边界：跨字幕边界仍是**端口与适配器**——字幕上下文适配器只读，按 `sessionId + inputWatermark + transcriptVersion + digest` 读取，不启动采集、不运行 ASR、不拥有或改写字幕会话；权限仍是**基于能力的设计**——但能力现在由 recipe 的静态登记直接给出，不再经「manifest 声明 + 宿主批准」两段。
8. ADR 0012 的 main-owned 单 owner 调度机制**整体保留**：logical claim attempt 复用同一冻结请求身份、不接管 receipt 返回的租约、`wakeEpoch` 推进与 idle 前的临界点复核、`start` 只允许一次、`stop` 为终态并推进 generation、字幕会话不等待调度器、`AGENT_SCHEDULER_FAILED` 仅为 observer 诊断。变化只在**任务来源**：从三项自动任务变为一个摄取工作加用户明确请求（含用户开启偏好后的自动报告请求）。
9. ADR 0009 的确定性输入规划继续有效，两点修订：宿主名称从 `AgentPluginHost` 改为 Agent 执行宿主；单次请求输入预算不再由 provider 配置表的 `maxChunkInputBytes` 给出，而由**模型运行绑定十轴预算的第 2 轴**给出（由 capability 的 `maxInputTokens` 推导）。其余不变——不静默截断超长终态会话、不让模型自行决定读取哪些字幕段、优先在字幕段边界按 `event_order` 切分、单段超预算时按 Unicode code point 确定性切分且不切断 surrogate pair、任一分块或归并失败不提交部分产物、不持久化分块正文或模型中间输出、worker 中断后沿用同一 `runId` 从冻结输入重新执行。
10. ADR 0006 第 10 项（纪要、增强文本与记忆提取为并列后台任务、直接读取同一输入快照）由本 ADR 第 5 项取代。ADR 0006 其余各项**全部不变**：单个 SQLite 与 storage worker、权威原始转写为唯一完整正文、四类筛选、明确偏好与推断倾向分开、结构化范围检索不启用向量或图查询、关闭与自动处理边界语义、删除单条记忆时先写 suppression 再物理移除。

## 取舍

- 相比保留 manifest 插件机制，本方案去掉一层没有对应可变性的间接层；代价是未来真要做第三方生态时需要重新引入注册与信任模型。这被判定为正确的时机取舍——首版没有第三方，提前建生态骨架只会同时承担骨架成本与业务成本。
- 相比让每个 recipe 自行读取 SQLite 与记忆表，深模块把「解决上下文问题」而不是「读取数据」暴露给调用方；代价是个人上下文模块自身接口更宽、内部更复杂，验收必须覆盖范围、预算与省略标记的确定性。
- 相比默认每次会话停止都生成纪要与增强文本，本方案默认零可见产物；代价是用户必须明确请求才看到价值。这与「Agent 系统可选、其失败不得降级字幕显示、SQLite 历史与导出」一致，也避免了未请求即产生云端费用。
- 相比让所有 recipe 都跑 Agent Loop，单轮与 Loop 分开省掉大部分运行的工具预算与轮次预算；代价是升级判定必须在运行创建期一次性冻结且不可变，事后无法根据模型表现改判。
- 相比一次性重写，本 ADR 把旧实现的处置单独交给 [ADR 0015](0015-retire-old-agent-implementation.md)；代价是仓库内会在一段时间里同时存在新旧两套源码。

## 未选择

- 保留 `AgentPluginHost`、`MemoryReader` 或八端口能力集合作为新实现的一部分。
- 动态插件、热重载、第三方 recipe 市场、扩展进程、递归委派或任意 `spawn_subagent`。
- 让 LLM 决定是否运行某项能力、读取哪些字幕段、使用哪个模型或升级为 Agent Loop。
- 为未来生态在首版暴露 manifest、激活事件或扩展进程抽象。
- 把普通单轮模型请求称为 Agent Loop，或在运行中途改变执行形态。

## 关联

- 语义：SEM-F00、SEM-F28、SEM-F30、SEM-F31、SEM-F32、SEM-F34、SEM-F35
- 旅程：J21（个人上下文摄取与管理）、J22（Agent Bar 与固定 recipe）、J26（单交互导出）
- 设计留档：[`../research/fixed-recipe-and-tool-freeze-draft.md`](../research/fixed-recipe-and-tool-freeze-draft.md)
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)
