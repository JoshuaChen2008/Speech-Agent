## ADDED Requirements

### Requirement: runtime 独占循环
Agent 执行宿主 SHALL 独占消息追加、工具执行和下一轮判定，全部 recipe 复用同一 Agent Loop。

#### Scenario: 工具后续调用
- **WHEN** 合法工具请求经过权限与预算检查并返回观察
- **THEN** runtime 追加工具结果并按静态轮次发下一次 exchange，provider 不执行循环

### Requirement: 持久预算统一
runtime SHALL 在外发前预留请求，并跨 attempt 保留冻结的重试、工具、时间和用量预算。

#### Scenario: 局部重试耗尽
- **WHEN** 同一模型操作达到其冻结次数上限
- **THEN** 停止该操作且外层不得无条件重放，旧 attempt 工具审计保留

### Requirement: 终态与取消屏障
runtime SHALL 在取消、失租或旧代次后禁止新请求、工具和产物提交。

#### Scenario: 迟到成功
- **WHEN** 用户取消已登记后 provider 返回成功
- **THEN** 拒绝产物写入且持久取消状态不变

### Requirement: 长输入节点共享约束
runtime SHALL 对所有计划节点使用同一绑定和共享累计预算，不改变来源覆盖或归并顺序。

#### Scenario: 后段预算耗尽
- **WHEN** 前段已产生中间结果而后段触及预算
- **THEN** 不提交部分纪要，释放中间正文并记录无正文诊断
