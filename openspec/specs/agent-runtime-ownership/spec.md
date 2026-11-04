# agent-runtime-ownership Specification

## Purpose

定义 Agent 执行宿主对唯一 Agent Loop、串行受控工具、持久预算与重试、取消和终态屏障的所有权；全部固定 recipe 与 Agent 输入计划节点通过 Agent 模型接入层的单次 exchange 外发。

本规格对应 SEM-F28/F31/F33/F39/F40、SEM-T15，验证边界为 J22/J24 的固定 recipe 与工具旅程、J30 的取消与恢复、J31 的长输入预算和归并；中间正文与诊断的隐私边界继续遵循 SEM-F14/J12。要求、测试边界与验收口径以 [语义合同](../../../docs/semantic-contract.md) 为唯一权威，术语以 [CONTEXT.md](../../../CONTEXT.md) 为准，证据分层见 [测试策略](../../../docs/testing-strategy.md)。

2026-10-09 状态为 **实现完成·尚未验收**。真实 Pi、模型接入层、scheduler、runner、受控工具与 SQLite 的确定性证据不替代真实公网 Agent 模型 provider、Win11 系统凭据、物理音源、正式包或适用实机门禁，也不提升完整 J31 或正式 Agent Bar 产品链路的联合验收状态。

## Requirements

### Requirement: 唯一且受控的 Agent Loop
Agent 执行宿主 SHALL 按 ADR 0016 使用经版本资格验证的 Pi 低层核心，统一全部固定 recipe 的消息循环、输出校验和下一轮判定；所有模型外发必须经过 Agent 模型接入层的单次 exchange。

#### Scenario: 请求准备试图改变模型
- **WHEN** 循环钩子产生与冻结模型运行绑定不一致的请求
- **THEN** 宿主在外发前拒绝，不能由 Pi 默认配置或模型选择覆盖绑定

### Requirement: 工具串行与执行前校验
宿主 SHALL 将工具并发固定为 1，逐个核验授权、参数 Schema、取消、失租和预算，按返回顺序执行并保留 (attempt, call_order) 工具调用记录。

#### Scenario: 两个工具之间取消
- **WHEN** 第一个工具返回后取消已成立，第二个工具尚未执行
- **THEN** 不执行第二个工具、不发下一轮请求；保留已有审计，不能等轮次结束钩子才检查

### Requirement: 持久预算与唯一重试决策
宿主 SHALL 独占重试决策，保留冻结政策、持久预留和跨 attempt 耗尽保护；每次 HTTP 尝试须先取得预留确认，关闭底层隐式重试。新政策 SHALL 有界处理 Retry-After 或指数退避加抖动，旧运行继续原政策。

#### Scenario: 预算预留回执未知
- **WHEN** 请求次数预留未获持久确认
- **THEN** 不外发，按既有恢复规则核对账本，不能猜测剩余次数

#### Scenario: 限流等待超过剩余期限
- **WHEN** 有效 Retry-After 指示的最早重试时间已超出运行剩余期限
- **THEN** 不提前重试、不延长总期限，按冻结政策收束；等待可被取消

#### Scenario: 同一操作重试耗尽
- **WHEN** 同一模型操作达到冻结次数上限
- **THEN** 停止该操作，外层不得通过新 attempt 无条件重放；旧 attempt 审计保留

### Requirement: 终态和取消屏障
宿主 SHALL 在请求前、工具前和提交前核验取消、租约与代次，沿用持久终态竞争规则，禁止迟到结果覆盖已成立终态。

#### Scenario: 取消后迟到成功
- **WHEN** 持久取消已成立后 provider 返回成功
- **THEN** 不提交产物，不改写取消终态，释放有界内存中的中间正文

### Requirement: 长输入节点共享约束
所有 Agent 输入计划节点 SHALL 复用唯一循环和同一模型运行绑定，遵循既有 run/attempt/Loop 预算作用域、来源覆盖与归并顺序，不持久化中间正文。

#### Scenario: 后段预算耗尽
- **WHEN** 后段触及预算而前段已有中间结果
- **THEN** 不提交部分纪要并释放中间正文；恢复仍须显式继续并按冻结输入重执行

#### Scenario: 某节点用量未知
- **WHEN** 某次模型交换缺失 usage
- **THEN** 累计用量保持未知，不估算填充，也不重置已有请求计数与预算消耗
