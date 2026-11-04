## Context

依赖 D 的唯一运行入口。目标依赖为产品操作层 → Agent 执行宿主 → Agent 模型接入层；个人上下文与 SQLite 通过已有受控接口提供能力。关联 SEM-F31/F33/F38/F40、SEM-F14，J22/J25/J29/J30/J12。

## Goals / Non-Goals

**Goals:** 减少重复操作逻辑，UI 只消费稳定操作、受理身份与 Agent 运行快照。
**Non-Goals:** 新交互设计、通用聊天、自动恢复、模型设置重做、目录整体迁移或新数据库。

## Decisions

1. **先盘点再合并。** 建立用户请求、自动任务、恢复、诊断、导出的调用者清单；只合并两个 service 重复的资格、幂等受理、调度、错误映射和终态通知。保留预设动作与自由问题的输入/恢复差异，不加一层只有透传功能的门面。
2. **操作与运行分工。** renderer 提交闭集动作、受限用户输入、范围和幂等键；main 操作层组织资格检查、冻结输入/记忆政策/模型绑定并持久受理，之后调度宿主。模型配置仍由模型接入层负责，renderer 不指定 URL、凭据、预算或任意 recipe。
3. **快照权威。** 事件仅加速刷新；SQLite 与既有运行身份、revision、generation 校准共同决定展示。回执未知时同键查询/重放，关闭窗口不取消；重开窗口从快照恢复，迟到事件不能覆盖较新事实。
4. **取消与恢复。** 取消立即通知运行并登记持久请求；持久终态竞争规则不变，无法确认落库时显示未确认。重启后不自动调用模型；预设动作沿用冻结输入/绑定和剩余预算明确继续，自由问题按既有政策要求重新输入，不能为统一接口而持久化原始提示。
5. **提交与旁路故障。** 结果及成功状态仍在同一事务提交。诊断写入失败不改变产物终态；正式 Agent 交互导出沿用现有版本与编码器，诊断和测试证据不含正文、凭据、现场音频、本地绝对路径或原始 provider 事件。
6. **模块边界。** SQLite 保持 storage worker 单写者；个人上下文只走模块接口。Agent 等待、取消、故障或完全不存在时，字幕系统仍能独立启动会话、保存及查看历史。

## Risks / Trade-offs

过度合并会抹平输入政策：以预设动作和自由问题的成对恢复旅程约束。接口切换会遗漏调用者：逐项迁移并删除旧入口。通知先后不确定：用持久快照校准，不把 UI 计时当作模型活动。

## Migration Plan

确认 D 接口与证据 → 盘点调用者并登记接口差异 → 复用现有 IPC 转入唯一操作实现 → 同步 exact 合同、access policy、preload、main、renderer → 验证跨进程旅程 → 删除无调用入口。仅在必要时版本化合同字段，不修改既有 schema migration。

### E 调用者盘点与实现边界（2026-10-09）

| 调用者 | 操作入口 | 保留的边界 |
|---|---|---|
| `agent-view.tsx` 会话总结、会话问答与回执未知重试 | preload `operations.submit/getSnapshot/cancel` → 既有 IPC → `AgentOperationService` | 同键先读取持久受理，再复用冻结身份；提示正文只在内存 |
| Agent Bar 日期范围、项目范围问答及旧交互控制 | 既有 `agent-run.ui` IPC → 同一个操作服务的版本兼容入口 | 问答配方版本、范围与旧交互导出编码不改变 |
| 重启与明确继续 | main `recoverAfterRestart`，renderer `operations.listRecoverable/resume` | 预设动作按摘要重建固定提示；自由问题要求重新输入；均不自动调用模型 |
| 执行宿主调度与运行反馈 | `FormalAgentJobScheduler`、runner `recordProgress/notifyRunChanged` | 产品操作统一调度和快照通知；Pi 唯一循环仍在 D 的执行宿主 |
| 自动个人上下文处理 | main 的个人上下文运行时与 ingest 调度 | 属于个人上下文模块，沿用受控模块接口，不转为用户会话总结请求 |
| 诊断查询、导出与可用性通知 | `operations.getDiagnostics/exportDiagnostics`、main `setDiagnosticsAvailability` | 元数据旁路；诊断故障不改变成功终态 |
| 历史、结果导出与交互信号 | `AgentInteractionReader`、既有 exporter / signal service | 只读投影、版本化编码与用户反馈模块边界保留 |

原两个 service 的资格判断、输入冻结、记忆政策、调度和取消信号现由操作服务复用；main 只构造一个实例。只读交互投影分离到 `AgentInteractionReader`。旧模块名仅作为仍有调用者的版本兼容导出，不再持有第二份受理、取消或恢复实现。IPC 请求和响应字段不变，继续经过现有 exact 校验和窗口 access policy。

两种受理协议不能互相改写身份：`session-summary-run.ui` 的请求身份先于路由与目标；日期/项目及旧 `agent-run.ui` 交互身份沿用现有编码。预设动作冻结记忆开关并允许明确继续；自由问题不落盘提示正文，重输以 `resubmits_request_id` 关联旧请求。合法取消先停止运行再请求持久取消；generation 冲突在发出任何取消信号前拒绝，未知持久状态返回 `verify_state`。

## Open Questions

实现边界已按上述调用者清单确定；实际验证、既有全量旅程缺口及未验证范围见 [E 验证记录](../../../../docs/validation/agent-operations-2026-10-09.md)。目录与类名不作为验收依据，仍以删除真实重复逻辑、稳定操作边界和用户旅程证据检验结果。
