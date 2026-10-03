## Why

用户需要把已确认个人记忆交给外部助手，并保留明确选择、范围和撤销控制。

## What Changes

- 设置中选择、预览、复制及Markdown/JSON内容导出。
- 临时本机只读MCP授权，按精确条目及修订开放列举、读取、关键词查询。

## Capabilities

### New Capabilities
- `personal-memory-sharing`: SEM-F43/F44与J28-EXPORT/MCP。

### Modified Capabilities
无。

## Impact

复用个人上下文、文件Worker与SQLite单写者；新增只读快照命令，不新增迁移。扩展现有settings-only IPC、preload校验与设置renderer。
