## ADDED Requirements

### Requirement: Explicit content export
系统 SHALL 只导出用户预览并选择的当前有效已确认个人记忆，按SEM-F43实施有界快照、修订核验和原子保存。

#### Scenario: Preview becomes stale
- **WHEN** 预览后的文件正文、范围或治理状态变化
- **THEN** 复制、导出及授权被拒绝并要求重新预览

### Requirement: Scoped read-only MCP
系统 SHALL 按SEM-F44提供默认关闭、临时令牌保护的本机只读MCP，授权绑定精确条目及修订。

#### Scenario: Revocation
- **WHEN** 用户停止共享、暂停个人记忆或撤销授权条目
- **THEN** 后续及尚未发布的读取不得返回旧正文
