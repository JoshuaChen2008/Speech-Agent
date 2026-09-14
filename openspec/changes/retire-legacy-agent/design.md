## Context
基线 HEAD 118d77e070d458199917b8137466b4f684d5e193，用户九个修改文件与两个未跟踪 change 独立保留。基线副本与 binary diff 保存在线程工作目录 retirement-baseline，不进入产品或验证产物。正式 catalog 当前 v9。
## Goals / Non-Goals
完整退役旧链路；保留字幕独立性、现行 Agent 与删除兼容。旧数据不迁入新实现，不处理独立 MVP userData，不夹带输入样式、模型设置或记忆概览实现。
## Decisions
1. 单一 SessionDeletionStore 承担删除事务，PersonalContextStore 提供 plan/apply 原子子步骤；公开删除入参/响应不变，历史五计数新写零、旧回执原样返回。
2. 历史 schema 文件保留 SQL 字节与 checksum；schema 门面只登记目录和追加 v10。15 个旧表精确列于 spec；循环引用先清空 nullable 指针，按依赖删表，外键始终开启。
3. 在 worker 初始化接受写入前、任何待执行迁移前，既有库先 VACUUM INTO 唯一私有文件；验证可重开、integrity_check、foreign_key_check、迁移身份、表级行数与确定性摘要。失败不能删除；新库无需备份。
4. 分类错误为备份创建、备份验证、退役迁移失败，绕过通用 fallback；校验已提交版本后以原 schema 提供字幕、历史与导出。Agent/自动摄取/删除统一门控。重启后才重试，重新取得快照；成功后不再备份。
5. 备份永不自动过期、上传或进入 Git/日志/证据。恢复仅在全退出后显式进行，不能自动覆盖后续写入。
6. 逐项文件清单先登记后删除；混合文件保留现行职责，旧可靠性断言迁入正式链路；现行文档解除旧链接，保留短退役记录与历史提交。J27 验唯一实现、退役及包。
## Risks / Trade-offs
外键循环与失败重试 → 真实 SQLite 非空升级、故障注入、回滚/重复启动测试。
旧文档混有现行证据 → 逐项判断，不按文件名称批量删除。
备份含正文 → 仅私有目录留存，用户显式清理，日志固定错误码。
## Migration Plan
先登记合同/ADR/J27，迁出删除事务，补升级故障测试，追加迁移与门控，清理旧链路，执行三条 lane/renderer/smoke/release/package fresh/restart。两个独立 luna/max 审核后修复复核，阻断关闭后才提交。未形成完整证据保持实现完成·尚未验收。
## Open Questions
无产品决策待定；重试采用用户选定的重启重试。
