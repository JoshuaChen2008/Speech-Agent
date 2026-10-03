## Context

依赖 centralize-agent-runtime-loop；落实操作层 → Agent 执行宿主 runtime → 模型接入层 provider 的单向依赖。SEM-F31/F33/F38/F40、J22/J25/J29/J30/J12。

## Goals / Non-Goals

**Goals:** UI 只使用稳定操作与快照；runtime 与厂商协议对 UI 隐藏。
**Non-Goals:** 新交互设计、后台自动扩大授权、通用聊天、JSONL 历史或任意工具。

## Decisions

1. 复用现有 submit/getSnapshot/cancel/resume 及诊断/导出能力，不仅新增透传门面。先盘点 AgentRunService 与 SessionSummaryRunService 的所有调用者；合并重复资格、终态通知和错误映射，同时保留各自确有差异的业务行为。
2. renderer 只传闭集动作、范围和幂等键；main 操作层冻结输入、记忆政策和模型绑定，创建持久受理身份后调度 runtime。配置管理仍由模型接入层负责，renderer 不指定 URL、预算、凭据或任意 recipe。
3. 操作层通过已存在的个人上下文模块读取来源，SQLite 仍由 storage worker 单写者管理；runtime 只经受控接口调用。
4. 统一事件作为加速通知，SQLite 快照是权威；revision/generation/请求身份拒绝迟到结果。关闭窗口不取消，重启恢复等待明确继续，未知回执重放复用同键。
5. 取消先发信号并登记持久请求；持久终态竞争保持原语义，无法落库显示未确认。结果与成功状态同事务提交，诊断写失败不改变结果。
6. 导出不改旧编码器；内部思维过程、原始 provider 事件和现场音频不持久化。明确界定这里是三个职责层而非三个独立 Agent；术语登记先于接口重命名。

## Risks / Trade-offs

整理接口损坏恢复/取消 → 正式 Electron 跨进程旅程作为出口。层数增加但重复逻辑未减 → 删除旧入口及重复实现是必做任务。

## Migration Plan

现有 IPC 作为兼容门面转入唯一操作实现，依调用清单迁移并删除未使用路径；需要新字段时版本化 exact 合同，更新 access policy/preload/main/renderer。保留字幕系统脱离 Agent 的独立旅程。

## Open Questions

无需预先决定新目录名称；以依赖约束、删除重复逻辑和真实用户旅程为验收，目录移动最后进行。
