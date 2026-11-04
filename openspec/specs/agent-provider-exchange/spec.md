# agent-provider-exchange Specification

## Purpose

定义 Agent 模型接入层内部 adapter 的单次 exchange 合同、版本化协议差异、调用级凭据与有界响应读取；Agent 执行宿主组织循环、受控工具执行和重试。

本规格对应 SEM-F14/F28/F31/F33/F40，验证边界为 J25 的协议、配置与凭据旅程，以及 J29/J30/J31 的总结、取消、恢复与长输入复用边界；J22/J24 的受控工具旅程核验 exchange 返回后凭据借用已经释放。要求、测试边界与验收口径以 [语义合同](../../../docs/semantic-contract.md) 为唯一权威，术语以 [CONTEXT.md](../../../CONTEXT.md) 为准，证据分层见 [测试策略](../../../docs/testing-strategy.md)。

2026-10-09 状态为 **实现完成·尚未验收**。确定性旅程使用真实内部产品模块，替身仅用于 provider 网络或系统权限等外部边界；真实公网 Agent 模型 provider、Win11 系统凭据、物理音源及适用实机门禁仍需各自证据，不提升完整 J31 或正式 Agent Bar 产品链路的联合验收状态。

## Requirements

### Requirement: 单次统一模型交换
provider adapter SHALL 接收统一消息、工具声明、输出合同、请求限制和取消信号；每次 exchange 至多一次外发，返回统一消息、工具调用、结束原因和可空用量，不承担循环、工具执行、重试或持久化。

#### Scenario: 模型请求两个工具
- **WHEN** provider 返回两个合法工具调用
- **THEN** adapter 保留 ID 与顺序并返回宿主，工具执行次数为零，HTTP 请求次数为一

#### Scenario: 返回限流或截断
- **WHEN** provider 返回限流错误或输出截断
- **THEN** adapter 返回有界分类信息且不自行重试；截断不得归一为正常结束，缺失用量保持未知

### Requirement: 版本化协议差异
adapter SHALL 按冻结请求策略封装 generic、DeepSeek、Qwen 的既有支持范围，区分 JSON 输出与严格 Schema；内部输出模式不新增用户能力字段，旧模型运行绑定的解释保持不变。

#### Scenario: 请求组合不能满足输出合同
- **WHEN** 绑定能力、端点或参数组合不支持所需输出模式
- **THEN** 外发前明确拒绝，不删除输出要求、不静默切换模型或策略

#### Scenario: JSON 输出不符合业务 Schema
- **WHEN** provider 返回语法有效但不符合 recipe 输出 Schema 的 JSON
- **THEN** 宿主拒绝将其作为合法产物，不能以 JSON 输出模式代替业务校验

### Requirement: 单次调用凭据与连接约束
Agent 模型接入层 SHALL 仅在单次 exchange 期间借用冻结绑定的凭据槽，保留撤销、受信任 origin 与 redirect 拒绝规则；所有退出路径释放借用，凭据不进入可序列化合同。

#### Scenario: 两次交换之间撤销凭据
- **WHEN** 前一次 exchange 已返回工具调用，随后凭据被撤销
- **THEN** 前次借用已释放，下一次 exchange 在外发前失败，不能复用旧凭据或自动换槽

### Requirement: 有界读取与取消保真
adapter SHALL 在消费响应块时执行字节限额，包括错误响应；保留期限、真实活动事件与取消，禁止持久化 reasoning 或原始响应正文。

#### Scenario: 响应长度头缺失或虚假
- **WHEN** 实际读取字节超过冻结请求限制
- **THEN** 立即取消继续读取并返回受控错误，不先读完整正文再判限额

#### Scenario: 网络不配合取消
- **WHEN** 取消后网络仍未结束或返回迟到响应
- **THEN** 宿主在既有期限内收束并拒绝迟到结果；未观测模型增量时不报告首 token
