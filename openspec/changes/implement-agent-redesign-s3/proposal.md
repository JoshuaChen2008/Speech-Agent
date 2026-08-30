## Why

S1/S2 已建立个人上下文与 Agent 模型接入事实，但正式 Agent 仍缺少一份可直接实施的统一执行宿主合同：十一个 recipe 尚未由同一有界 Agent Loop 运行，交互、工具调用、意图收敛、取消与用量事实也尚未形成可审计的 SQLite 边界。S3 需要把 ADR 0016/0018 与 SEM-F16/F28/F30-F35 收敛成一个不依赖 Agent Bar renderer 的 Core 实施切片，并保持字幕系统独立运行。

## What Changes

- 追加 migration v7，且只包含三张 `STRICT` 表、一列会话删除 tombstone 计数与四条分页/全序索引；v1-v6 SQL/checksum 逐字节不变。
- 在 `src/agent/contracts/recipes.js` 建立十一个 recipe 的唯一静态登记点，固定输入范围、模型用途、1/3/6 轮上限、工具授权、输出 Schema、持久化、产物类型与失败策略。
- 让所有固定 recipe 只走同一个有界 Agent Loop；删除运行期执行形态判定与升级理由，`bind()` 的 `executionForm` 只接受 `'agent_loop'`。
- 实现 `intent.route` 模型优先、确定性规则兜底的两层意图收敛，持久化 `routing_mode=model/rules/preset`，并把用户改选处理为取消当前运行后新建运行。
- 规定取消为终态、迟到结果拒绝、同 `runId` 重试、可空 `usage_json`、canonical `comparison_group_id`、两段式个人上下文摄取与 S1 运行/租约/幂等机制复用。
- 冻结六个 exact `agent-run:*` IPC 频道、`agent/history` 角色、main-owned 九值资格顺序、交互/工具读取投影与脱敏 UI/UX fixture。
- 登记 `analysis-report` 与 `planning-proposal` 两个新产物类型；`extract.items` 不新增产物类型且不得复用隔离 Agent 内核开发入口的 `reference-output`。
- 以 J22/J24 的 S3 Core 子边界组织后续 tracer bullets；S3 先接入 0 工具与 `search_context`，`read_sources` 与完整十轴工具预算执法留给 S4，真实 Agent Bar 与导出汇合留给 S5-Integration。

## Capabilities

### New Capabilities

- `agent-execution`: 覆盖 S3 的 v7 交互审计事实、十一 recipe 静态登记与输出 Schema、统一 Agent Loop、两层意图收敛、取消/重试/恢复、两段式摄取、用量事实、会话删除、exact IPC、资格顺序、UI/UX fixture、隐私边界与字幕系统独立降级。

### Modified Capabilities

无现存 OpenSpec capability 被修改。`model-access` 的 v6 `execution_form` 列保持既有 schema，只把 `bind()` 的 accepted value 按 ADR 0016 收窄为常量 `'agent_loop'`；该行为由本 capability 的跨模块合同消费，不修改 S2 已签发 capability 文件。

## Impact

- 当前 change 新增 `openspec/changes/implement-agent-redesign-s3/` 下的 proposal、design、delta spec 与 tasks，并在 `docs/testing-strategy.md` 登记 J22/J24 的 S3 Core 子边界；交付状态最多为「实现完成·尚未验收」。
- 后续实施将影响 `src/agent/contracts/recipes.js`、`src/agent/execution-host/`、S1/S2 runtime 接线、storage worker 的 v7 schema/store/protocol、main/preload/access policy、版本化 fixture，以及既有 `test/{contracts,main,runtime,storage,integration,validation}` lane。
- renderer、recipe 与 Agent utility 均不得直接访问 SQLite、凭据、文件系统或任意网络；字幕系统的音频采集、ASR、字幕事实、停止与退出路径不依赖 S3。
- S3 不实现正式 Agent Bar renderer、`read_sources` 完整执行与十轴工具预算、单交互导出或真实公网 Agent 模型调用；这些分别由 S4/S5-Integration 后续汇合。
