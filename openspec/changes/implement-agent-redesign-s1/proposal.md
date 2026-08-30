## Why

Agent 重设计的语义、ADR 与 S1–S6 总体执行计划已经处于“已决定”，但新的 `src/agent/**`、v5 schema 和个人上下文模块仍没有实现证据。下一步应把 S1 收敛为一个可独立实施、可失败定位、且不依赖模型或 Agent Bar 的纵向切片，避免继续重复设计或一次性铺开阶段 A 的全部红测。

## What Changes

- 追加正式 migration v5，建立新设计专用的 `formal_agent_runs`、独立 claim receipt、`personal_context_*` 表和删除计数；v1–v4 SQL/checksum 逐字节不变。
- 新建个人上下文模块，对正式调用者只暴露 `ingest(source)`、`resolve(request)`、`manage(command)` 三类接口，并在模块内部拥有范围、来源、水位/digest、revision、生命周期、预算及省略标记规则。
- Agent 处理资格为 `ready` 时，终态会话的完整提交水位确定后只创建一个 `context.ingest.session` 工作；S1 不调用 Agent 模型 provider，也不创建会后结构化纪要、增强文本或其它报告。S2 尚未提供真实模型接入层前，产品路径不得伪造 `ready`。
- 将个人上下文存储命令、调度与 `settings` / `history` 角色的 exact IPC 合同接到真实 storage worker/SQLite；字幕 `open/append/close/history` 路径不得加载新 store。
- 以 TDD 纵向 tracer bullet 实施：每个已确认 seam 先写一个会红的行为测试，立即补最小实现使其转绿，再进入下一条；阶段 A 只作为跨切片测试清单，不作为批量红测阶段。
- 保留旧 Agent 源码、旧表、旧隔离入口与正式 migration v1–v4；不建立新旧兼容层、适配器、双写或迁移路径。

## Capabilities

### New Capabilities

- `personal-context-core`: 覆盖 S1 的 v5 持久化、个人上下文模块三接口、单一会话摄取工作、确定性范围/分流/删除语义，以及字幕系统独立边界。

### Modified Capabilities

无。权威要求已经登记在 `docs/semantic-contract.md`、ADR 0013–0015、`docs/data-architecture.md` 与 `docs/testing-strategy.md`；本 change 不改变既有语义，只把已决定的 S1 收敛为可实施合同。

## Impact

- 新代码根：`src/agent/contracts/`、`src/agent/personal-context/`，以及 `src/agent/execution-host/` 中只承载 ADR 0012 调度/领取生命周期的最小宿主骨架。
- 存储：`src/runtime/storage-worker/` 的追加 migration、协议、worker service 与新设计 store；既有 subtitle store 和旧 formal Agent store 保持独立。
- 运行时：沿用 ADR 0012 的 main-owned 单 owner 调度机制，只替换任务来源。
- IPC：`src/main/ipc/channels.js`、`src/main/ipc/access-policy.js` 及对应 preload 投影，仅限 `settings` / `history`；同时签发脱敏的 renderer-facing fixture，供独立 UI/UX 工作线消费。
- 测试：`test/{contracts,runtime,storage,integration,validation}` 既有 lane；J21 只登记并证明 S1 子边界，不提前宣称完整 J21 联合验收。
- UI/UX：S1 不实现 settings/history 正式管理界面；设计模型只消费 exact contract/fixture 并经 `docs/agent-ui-contract-requests.md` 提出缺口。fixture preview 不构成 J21 证据。
- 不影响 S5 的 `agent` 窗口角色决定，也不在 S1 定义或执法十轴预算数值。
