## Why

生产 adapter 同时承担协议、工具执行和循环，难以独立检验厂商差异。需要先建立一次模型交换的统一接口，为迁移循环提供稳定接缝。

本文件为待评审规划；不构成产品实现或验收证据。总顺序见 [推进计划](../../../docs/agent-refactor-roadmap.md)。

## What Changes

- 引入版本化单次模型请求/响应合同；将 DeepSeek JSON、工具声明、用量和错误映射放在 adapter；保留旧运行门面直到下一片切换，只有一条生产执行路径。
- 实施前登记 CONTEXT、相关 SEM 行及 J25/J29/J30/J31；保留工作树既有改动和旧模型运行绑定。

## Capabilities

### New Capabilities

- `agent-provider-exchange`: 本切片的执行与验证合同。

### Modified Capabilities

无已归档主 spec 修改；与既有在途变更的分工见推进计划，权威要求仍为 semantic-contract.md。

## Impact

model-access 与执行宿主接口；不引入 Python、tau 依赖、新供应商或动态插件。
SQLite 单写者、无现场音频保存、诊断仅指标与哈希、个人记忆政策和模型身份冻结保持约束。
