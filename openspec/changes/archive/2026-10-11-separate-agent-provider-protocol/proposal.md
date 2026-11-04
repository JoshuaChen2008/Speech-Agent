## Why

实施前，生产 adapter 混合 HTTP 协议、循环、工具执行和重试，厂商差异难以独立验证。先提取单次模型交换，让后续 runtime 迁移有明确边界。

2026-10-09 状态为实现完成·尚未验收；内部接线、实际命令与确定性证据见 [todo](tasks.md) 和 [测试记录](../../../../docs/testing-strategy.md)。依据：[调研](../../../../docs/research/agent-model-refactor-feasibility-2026-10-08.md)、[推进计划](../../../../docs/agent-refactor-roadmap.md)；要求以语义合同和 ADR 为准，不提升 A/B 或 Agent Bar 产品链路的联合验收状态。

## What Changes

- 建立版本化内部 exchange 合同：一次外发，返回消息、工具调用、结束原因和可空用量。
- 封装既有 generic、DeepSeek、Qwen 请求策略；区分 JSON 输出与严格 Schema，保留旧策略解释。
- 增加读取期间的响应字节限额，把凭据借用缩短到单次 exchange。
- C 实施时保留旧运行门面调用新 exchange；后续 [D](../2026-10-11-centralize-agent-runtime-loop/proposal.md) 已将循环、工具和重试迁入唯一 Agent 执行宿主并删除旧门面。

## Capabilities

### New Capabilities

- `agent-provider-exchange`: 单次模型交换、协议归一和安全边界。

### Modified Capabilities

无已归档主 spec 修改。实施前核对并登记 SEM-F28/F31/F40、SEM-F14 与 J25/J29/J30/J31 中受影响的行为。

## Impact

涉及 model-access、内部合同和真实调用旅程；不增加用户配置字段、供应商、进程或框架。入口：[spec](specs/agent-provider-exchange/spec.md)、[todo](tasks.md)。
