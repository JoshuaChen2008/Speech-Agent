## ADDED Requirements

### Requirement: 统一产品操作
操作层 SHALL 接受闭集用户动作并在模型请求前返回持久受理身份，renderer 不接触厂商 URL、凭据、任意 recipe 或预算。

#### Scenario: 重复提交
- **WHEN** 提交回执丢失后同一幂等键再次提交
- **THEN** 返回同一请求身份，不建立重复运行

### Requirement: 权威快照恢复
操作层 SHALL 以 SQLite 为权威状态，事件仅加速；UI 使用身份、revision 和 generation 校准。

#### Scenario: 窗口重开
- **WHEN** 运行期间关闭并重开 Agent 窗口且通知丢失
- **THEN** 读取同一请求的权威快照；关闭窗口不隐式取消

### Requirement: 取消和继续治理
操作层 SHALL 保留持久终态竞争和显式恢复语义，无法确认取消时显示未确认。

#### Scenario: 重启待继续
- **WHEN** 进程在运行期间退出后重启
- **THEN** 用户明确继续前零模型调用，继续保持原绑定和剩余预算

### Requirement: 字幕独立与隐私
操作层 SHALL 保持 Agent 故障期间字幕系统独立运行，诊断只含允许指标与哈希。

#### Scenario: 诊断写入失败
- **WHEN** Agent 等待期间诊断写入失败且用户启动下一字幕会话
- **THEN** 字幕可开始停止并写入历史，Agent 结果不被诊断故障改写，无现场音频产物
