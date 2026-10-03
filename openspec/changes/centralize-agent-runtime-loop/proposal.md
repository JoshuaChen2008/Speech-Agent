## Why

循环、工具与重试控制分散在 executor 和 adapter，存在规则重复与预算叠加风险。需要由 Agent 执行宿主统一执行。

本文件为待评审规划；不构成产品实现或验收证据。总顺序见 [推进计划](../../../docs/agent-refactor-roadmap.md)。

## What Changes

- 迁移消息、工具执行、轮次、重试和取消到统一 Agent Loop；provider 仅执行一次交换；保留既有持久预算、attempt 和冻结模型身份。
- 实施前登记 CONTEXT、相关 SEM 行及 J25/J29/J30/J31；保留工作树既有改动和旧模型运行绑定。

## Capabilities

### New Capabilities

- `agent-runtime-ownership`: 本切片的执行与验证合同。

### Modified Capabilities

无已归档主 spec 修改；与既有在途变更的分工见推进计划，权威要求仍为 semantic-contract.md。

## Impact

execution-host、scheduler、预算账本和 model-access；依赖 separate-agent-provider-protocol。
SQLite 单写者、无现场音频保存、诊断仅指标与哈希、个人记忆政策和模型身份冻结保持约束。
