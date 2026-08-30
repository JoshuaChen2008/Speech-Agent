# ADR 0018：意图收敛采用模型优先加确定性规则兜底的两层机制

- 状态：已决定
- 日期：2026-08-30
- 决策者：项目负责人
- 依赖：ADR 0013、ADR 0014、ADR 0016
- 修订：[ADR 0013](0013-agent-deep-modules-and-execution-host.md) 第 2 项的 recipe 闭集规模（十项扩为十一项）；[ADR 0016](0016-unified-agent-execution-path.md) 第 3 项的档位清单（`intent.route` 加入 1 轮 0 工具档）
- 保留不变：ADR 0013 第 1、3、5、6、7、8、10 项；ADR 0016 第 1、2、4–9 项与三档划分本身

## 背景

Agent Bar 只向用户提供一个自然语言输入框，用户不知道也不该知道内部 recipe ID。但 recipe ID 决定模型用途、轮次上限、工具授权、输出 Schema 与持久化策略，这些全部必须在运行创建期冻结，因此「这句话属于哪个 recipe」必须在创建运行**之前**得到一个闭集内的确定答案。

`agent-redesign-execution-plan.md` S3 第 3 条只写了「收敛到已登记 recipe ID 闭集中的一个」，没有指定判定主体。冻结 S3–S5 总规格时必须回答它，否则实现期会各自发挥。

两种单一方案各有明确缺陷。纯模型判定灵活但不可靠：provider 不可达、凭据缺失、超时、结构化输出不合法或返回闭集外的值时，用户会得到一个没有下一步的死路。纯确定性规则永远可用但不够聪明：它只能靠关键词与所选范围判断，「帮我把上周三个会的结论理一下」这类自然表达很容易落到错的 recipe。

## 决策

1. **意图收敛采用两层机制：模型判定优先，确定性规则兜底。** 两层的输出都必须是十一项已登记 recipe ID 闭集中的一个，且都不向用户暴露 recipe ID。

2. **模型判定层实现为第十一个已登记 recipe `intent.route`，不是执行宿主里的特例路径。** 它按 ADR 0016 的档位登记为 `maxTurns = 1`、`toolGrants = []`，映射到默认模型用途，输出 Schema 恰好是 `{ recipeId, confidence }` 且 `recipeId` 必须落在其余十项之内。选择把它做成 recipe 而不是 `bind()` 之前的裸模型调用，是因为 `bind()` 已冻结为「只在既有 `formal_agent_runs` 行上写入绑定」，任何运行前的模型调用都必须自己解析档案、model、预算与凭据，直接违反 ADR 0014 第 1 项对调用方的限制。做成 recipe 后它复用既有的运行、绑定、预算、取消、用量与审计机制，不新增任何机制。

3. **兜底触发条件是闭集，不是「模型效果不好」。** 以下任一成立即回落确定性规则：`intent.route` 的 Agent 处理资格不为 `ready`；运行以 `AGENT_PROVIDER_*`、`AGENT_OUTPUT_INVALID`、`AGENT_BUDGET_EXCEEDED`、`AGENT_WORKER_EXITED` 或 `AGENT_INTERNAL_FAILURE` 收束；返回的 `recipeId` 不在其余十项闭集内。用户取消不触发兜底——取消是终态，不再创建后续运行。

4. **确定性规则必须永远给出答案。** 规则按所选范围与受控关键词判定，全部不匹配时收敛到 `qa.answer`。因此意图收敛没有失败态，用户永远不会因为收敛而卡住。

5. **收敛结果必须以产品语言呈现并允许改选。** 界面显示「将为你生成会后纪要」这类产品语言，旁边提供改选入口；不展示 recipe ID、confidence、`routing_mode` 或模型判定过程。用户改选按「取消当前运行 + 新建运行」处理，产生新 `runId` 与新产物版本，不改写既有运行——与用户主动换模型重跑的既有语义一致。

6. **收敛方式作为审计事实持久化。** `formal_agent_interactions` 增加 `routing_mode`，闭集为 `model`（`intent.route` 成功）、`rules`（兜底）、`preset`（无需收敛）。它使「这次为什么选了这个 recipe」可复现，也让模型收敛的实际命中率可被离线评估。它是审计字段，不进入界面呈现。

7. **只有用户经 Agent Bar 发起的运行才收敛。** `context.ingest.session`、`context.ingest.interaction` 与用户开启报告自动呈现偏好后的自动纪要请求，recipe 在创建时已知，`routing_mode` 记为 `preset`，不创建 `intent.route` 运行。因此收敛只对用户主动请求产生第二个运行，自动路径运行数不变。

8. **`intent.route` 的运行与交互不进入用户可见的交互历史。** 它照常写入 `formal_agent_runs`、绑定与 `formal_agent_interactions`（不设存储特例），但交互历史与单交互导出的列表投影只包含面向用户的 recipe。这是显示规则，不是存储例外；删除一个用户交互时，其配套的 `intent.route` 交互一并级联删除。

## 取舍

- 相比纯模型判定，两层机制让 provider 不可达、凭据缺失或输出不合法时仍有确定的下一步；代价是必须同时维护一套确定性规则，且两条路径都要有验收证据。
- 相比纯确定性规则，模型判定让自然表达能被正确路由；代价是用户主动请求会产生两个运行、两次绑定与两份用量事实。这被判定为可接受，因为 `intent.route` 是 1 轮 0 工具、输出极小的调用，且自动路径完全不受影响。
- 相比把模型判定做成 `bind()` 之前的裸调用，做成 recipe 复用了全部既有机制；代价是 recipe 闭集从十项扩为十一项，SEM-F16 的冻结清单必须同步更新。
- 相比在收敛结果上强制用户确认后才运行，本方案直接运行并允许改选；代价是收敛错误时会浪费一次运行。选择它是因为强制确认会给每一次提交增加一步交互，而改选路径已由「取消 + 新建运行」的既有语义免费提供。
- 相比引入 confidence 阈值决定是否询问用户，本方案只用「成功 / 失败」二值触发兜底；代价是低置信但合法的判定不会被拦截。选择它是因为阈值需要真实数据才能调，而首版没有这份数据，过早引入会变成一个没有依据的魔数。

## 未选择

- 让 `bind()` 之前存在任何裸模型调用，或让执行宿主自行解析档案、model、URL、预算或凭据。
- 为意图收敛在 Agent 模型接入层增加第四个接口。
- 把 confidence 阈值、重试或多候选投票引入首版收敛。
- 向用户暴露 recipe ID、confidence、`routing_mode` 或模型判定过程。
- 在收敛失败时让用户卡住，或用「无法理解」这类没有下一步的提示收场。
- 让 `intent.route` 获得工具授权、多轮或产物写入权限。

## 关联

- 语义：SEM-F16、SEM-F28、SEM-F31、SEM-T10、SEM-T15
- 旅程：J22（Agent Bar 与固定 recipe）、J24（正式 Agent 正常使用边界组合）
- 数据：`formal_agent_interactions.routing_mode`（v7，见 [`../data-architecture.md`](../data-architecture.md)）
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)
