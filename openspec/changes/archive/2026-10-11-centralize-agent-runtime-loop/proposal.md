## Why

[C](../2026-10-11-separate-agent-provider-protocol/proposal.md) 提取单次交换后，循环、工具执行和重试仍分散在旧门面与宿主。需要由 Agent 执行宿主统一控制，保留现有持久预算、取消和恢复语义。

本切片为实现完成·尚未验收。迁移前已核验并锁定 `@earendil-works/pi-agent-core@0.84.1`，同族依赖固定 0.84.1；真实核心在 Node、Electron 主进程及 utility 进程验证后接入生产入口。钩子映射、调用者清单及 E 交接见 [design](design.md)。

## What Changes

- 先锁定 Pi 兼容版本并验证请求前、工具前、轮次结束和取消钩子；按 ADR 0016 接入低层核心。
- 将消息循环、工具串行执行、输出校验和有限重试统一到宿主；每次外发先持久预留预算。
- 为新运行登记有界 Retry-After/退避策略；旧策略、旧绑定及已有重试耗尽保护继续有效。
- 全部固定 recipe 和长输入节点复用唯一循环；切换后删除 provider 中的旧控制逻辑。

## Capabilities

### New Capabilities

- `agent-runtime-ownership`: 唯一循环、串行工具、持久预算与取消屏障。

### Modified Capabilities

无已归档主 spec 修改。已在实现前登记 SEM-F28/F31/F33/F39/F40、SEM-T15 与 J22/J24/J30/J31 的受影响行为，并核对 CONTEXT 全文与 ADR 0009/0016/0021。

## Impact

涉及 execution-host、model-access 组合入口及真实 SQLite 旅程。SQLite 保持唯一持久权威；不引入 Pi 的完整应用、凭据配置或第二套恢复框架。入口：[spec](specs/agent-runtime-ownership/spec.md)、[todo](tasks.md)。
