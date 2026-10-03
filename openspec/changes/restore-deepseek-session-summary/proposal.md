## Why

正式会话总结缺少明确的 JSON 输出合同，并受旧的小容量限制阻挡。需要在现有执行链内恢复窗口内完整会话的生成、保存和重开。

2026-09-29 轻量方案已决定；任务1及review修订为实现完成·尚未验收，任务2–4待实施。百万/256k 指模型上下文 token 窗口，不是 MiB 响应体。总顺序见 [推进计划](../../../docs/agent-refactor-roadmap.md)。

## What Changes

- 以 256,000 token 为应用上下文目标，受实际模型能力约束并预留输出空间；完整输入能放入就直接交给既有 Agent Loop，超限明确拒绝。
- 补齐受控 JSON 指令和结构示例，单次输出独立按 8,192 token 目标及现有预算取小值；沿用严格校验、取消和事务提交。
- 对齐 runner、Loop、adapter 输入限制，覆盖短会话成功及 173,827 字节规模合成会话的明确拒绝；少量边界测试加一条正式旅程，真实 DeepSeek 单独留证。

## Capabilities

### New Capabilities

- `deepseek-summary-recovery`: 窗口内完整会话的直接总结与失败边界。

### Modified Capabilities

无已归档主 spec 修改。实现前在相关 SEM 行与既有旅程矩阵登记新容量及兼容解释，权威要求仍为 semantic-contract.md。

## Impact

主要涉及 src/agent/contracts、execution-host、model-access 和既有总结旅程。复用现有模型运行绑定、版本机制、SQLite 和诊断；不预设新增表或迁移，不搬迁目录，不引入新框架。分块归并由 B 承接；响应体和产物正文扩到 1 MiB 不属于需求。
