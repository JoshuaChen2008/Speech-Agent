## ADDED Requirements

### Requirement: 单次统一模型交换
provider adapter SHALL 接受统一消息、工具声明、输出合同和限制，仅执行一次模型外发，并返回统一消息、工具调用、结束原因和可空用量。

#### Scenario: 模型请求工具
- **WHEN** provider 返回两个工具调用
- **THEN** 保持 ID 与顺序并返回 runtime；adapter 不执行工具也不发第二次请求

### Requirement: 协议差异封装
adapter SHALL 实现已登记厂商的 JSON 指令、工具声明和错误映射，未知能力明确拒绝，凭据只在调用期借用。

#### Scenario: 结构化能力不足
- **WHEN** 请求要求结构化结果而绑定能力或协议不支持
- **THEN** 在外发前明确拒绝，不静默删除输出要求，不泄露凭据

### Requirement: 事件和取消保真
adapter SHALL 保持有界解码、真实活动事件和取消，不持久化 reasoning 或原始响应正文。

#### Scenario: 无响应取消
- **WHEN** 网络不配合 abort
- **THEN** 宿主期限收束，迟到响应不能生成可提交结果，未收到增量时不报告首 token
