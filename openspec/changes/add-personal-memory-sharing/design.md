## Context

Markdown与SQLite治理已有正式实现，治理携带不含正文。

## Goals / Non-Goals

交付用户选定的已确认个人记忆内容导出与本机只读MCP；会话背景批量导出、外网服务、写入和自动授权不在本片。

## Decisions

1. 同一有界只读快照供预览、复制、导出与MCP；每次核验当前文件和SQLite有效性。精确条目快照摘要变化即拒绝旧预览/授权。
2. MCP采用Streamable HTTP 2025-06-18，仅127.0.0.1，拒绝浏览器Origin，Host精确验证；main内存令牌仅用户明确复制配置时外发。最多8会话、单请求8KiB、单并发读取。
3. 每次授权最多20条/64KiB，权限不扩展到未来新增或修订条目。关键词查询仅对授权快照；无模型调用。
4. 用户保存对话框后再读取并核验，原子写入前再次复核。复制前同样复核。候选、休眠和撤销不得导出。

## Risks / Trade-offs

客户端须支持HTTP及自定义Authorization头。授权在应用重启后重新建立。文件系统外部编辑与发送无法跨介质原子化，以每次读取与发布前的校验边界为准。

协议依据：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

## Migration Plan

无schema迁移。默认不开启监听，应用退出关闭服务。
