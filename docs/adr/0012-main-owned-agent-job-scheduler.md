# ADR 0012：main-owned 后台 Agent 任务调度

正式 Agent 首版使用 main-owned、单 owner 的 `FormalAgentJobScheduler`，不把调度权交给 Agent utility、renderer 或 storage worker。一个 logical claim attempt 在 receipt 或空结果确定前始终复用同一冻结请求身份，包括请求 `leaseMs`，但不接管 receipt 返回的任务 lease；工作事件推进 `wakeEpoch`，idle 时只排一个 drain，drain 在空扫描转 idle 前由同一 owner 临界点复核 epoch，因此不需要固定间隔轮询。`SessionCoordinator` 通过 subscribe-first、revision 单调的公开快照投影活动会话；云端 Agent 模型 provider 任务继续且字幕会话不等待调度器，未来本地领取只接收冻结的 `localWorkAllowed`，运行中本地任务的有界停止继续后置。

这项选择以更明确的 claim/timer/退出状态机换取未知响应幂等、无丢唤醒和字幕系统独立降级。exact `{ code: 'AGENT_SCHEDULER_FAILED' }` 仅是 observer 诊断，任务租约、重试与持久错误仍由 `AgentJobRunner → storage worker/SQLite` 权威闭集管理；`start` 只允许一次，`stop` 为终态，推进 generation、使旧 timer/wake 失效并取消会话快照订阅。D15 只验证 UI-free 云端调度子边界，不构成正式 main 接线或 SEM-T15/J24 完整验收。
