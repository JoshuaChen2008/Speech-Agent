## Why

[D](../2026-10-11-centralize-agent-runtime-loop/proposal.md) 统一运行控制后，产品入口仍需收敛重复的受理、取消、恢复和通知逻辑。让 UI 使用稳定操作与权威快照，减少跨层接线时出现身份或终态不一致。

本切片为实现完成·尚未验收：正式 main 只组合一个操作服务，main/preload/renderer 已迁移，保留两种既有版本化协议及预设动作/自由问题的恢复差异。实际命令、失败记录和未验证范围见 [E 验证记录](../../../../docs/validation/agent-operations-2026-10-09.md)。三个切片是职责分层，不增加进程或 Agent；依据 [推进计划](../../../../docs/agent-refactor-roadmap.md) 与 [调研](../../../../docs/research/agent-model-refactor-feasibility-2026-10-08.md)。

## What Changes

- 盘点并合并 AgentRunService、SessionSummaryRunService 中确有重复的产品操作，保留预设动作与自由问题的业务差异。
- 复用 submit/getSnapshot/cancel/resume 及已有诊断、导出操作；统一持久受理、幂等、身份校准和显式恢复。
- 保留 main/preload/renderer 的闭集合同、SQLite 原子提交和字幕系统独立旅程；迁移后删除无调用旧入口。

## Capabilities

### New Capabilities

- `agent-operation-facade`: 产品操作、权威快照和取消/恢复边界。

### Modified Capabilities

无已归档主 spec 修改。实施前核对并登记 SEM-F31/F33/F38/F40、SEM-F14 与 J22/J25/J29/J30/J12 的受影响接口和行为。

## Impact

涉及 formal-run、main/preload/renderer 接线和跨进程旅程。存储、个人上下文与模型配置继续由各自模块管理；目录改名不作为任务目标。入口：[spec](specs/agent-operation-facade/spec.md)、[todo](tasks.md)。
