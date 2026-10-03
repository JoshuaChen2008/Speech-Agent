## Why

UI 操作与运行编排需要一个稳定入口，避免 renderer 依赖厂商协议或内部循环。需要在已验证运行内核上整理正式产品链路。

本文件为待评审规划；不构成产品实现或验收证据。总顺序见 [推进计划](../../../docs/agent-refactor-roadmap.md)。

## What Changes

- 整理受理、查询、取消、继续、事件订阅和结果导出接口；由操作层组合个人上下文、模型绑定和 SQLite；保持重启、幂等和字幕独立。
- 实施前登记 CONTEXT、相关 SEM 行及 J25/J29/J30/J31；保留工作树既有改动和旧模型运行绑定。

## Capabilities

### New Capabilities

- `agent-operation-facade`: 本切片的执行与验证合同。

### Modified Capabilities

无已归档主 spec 修改；与既有在途变更的分工见推进计划，权威要求仍为 semantic-contract.md。

## Impact

formal-run、main/preload、Agent Bar 与持久化接线；依赖 centralize-agent-runtime-loop。
SQLite 单写者、无现场音频保存、诊断仅指标与哈希、个人记忆政策和模型身份冻结保持约束。
