## Why
旧执行实现已不属于正式产品，但源码、操作、schema 与文档继续增加维护和上下文成本。按用户批准方案完整退役，字幕保持独立。
## What Changes
- **BREAKING** 删除旧执行入口、旧任务/记忆操作、旧专属工具与文档。
- 迁出会话删除事务，保留公开响应与历史回执。
- 既有库先验证一致性备份，再追加退役迁移；失败保留字幕并重启重试。
- 保留用户工作树已有改动，不迁移旧数据或触碰独立 MVP userData。
## Capabilities
### New Capabilities
- `legacy-agent-retirement`: 备份、退役、删除兼容及唯一现行实现门禁。
### Modified Capabilities
无既有主 spec（当前主 spec 目录为空）；相关 SEM/J27 同步修订。
## Impact
storage worker、gateway、现行 Agent 状态、测试 lane、打包与当前文档。历史迁移 SQL/checksum 不变。
