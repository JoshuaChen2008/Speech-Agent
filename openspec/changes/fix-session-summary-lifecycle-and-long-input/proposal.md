## Why

2026-09-27 的只读诊断确认：一场包含 1,589 个字幕段的会话，拼装请求为 173,827 字节，超过 runner 的 15,000 字节限制，45 ms 后已经失败，Agent Bar 仍显示“正在生成”。取消终态任务又被映射为泛化错误，用户无法判断进展或取得诊断。用户要求覆盖 4–5 小时会议，因此需要同时修正运行闭环和长输入规划。

## What Changes

2026-09-30 P2 规划收敛（已决定）：复用现有分页、输入规划器、Agent Loop 和持久预算，先接通长输入纵向旅程，不以前置 provider/runtime/operations 重构扩大范围。窗口内直接总结沿用2026-09-29已登记策略；超窗口由完整分块归并承接。实施顺序与版本冲突入口见 design「P2 最小实施顺序」，原任务编号与验收范围保留。

- 后台状态提交后发布变更；活动详情周期校准，手动刷新、重载和窗口恢复读取权威状态；取消遇到终态返回该终态。
- 从请求受理起提供取消能力、阶段、相对耗时、最近活动及可解释的预算失败；状态未知与仍在运行分别表达。
- 将长会话容量与单次模型请求预算分开；按冻结输入完整分块、确定性归并、原子提交，覆盖 4–5 小时且不截断正文。
- 新增 `summary.minutes@2` 的版本化输入计划和运行预算；保留旧版本绑定、历史及导出字节承诺。每次模型调用仍经过同一 Agent Loop，工具授权不在运行期改变。
- 提供有界、本地、无正文的运行诊断及主动导出；不记录模型中间文本、不上传日志、不持久化分块正文。
- 扩充 SEM-F38，并登记 SEM-F39/F40、J30/J31；维护 CONTEXT 术语和 AGENTS 路由，供其它任务按需读取。

## Capabilities

### New Capabilities

- `session-summary-run-lifecycle`: 受理、状态同步、真实阶段、取消、恢复和终态一致性。
- `session-summary-long-input`: 4–5 小时场景、输入计划、分块归并、版本化预算和完整覆盖。
- `agent-run-diagnostics`: 无正文诊断、保留策略、运行中导出和隐私边界。

### Modified Capabilities

当前 `openspec/specs/` 没有已归档能力。上述能力作为新增 delta，与在途 `clarify-memory-and-session-summary/specs/session-summary-experience/spec.md` 互补；既有记忆政策、正文边界、来源撤销和导出承诺继续适用，不复制或重置该变更的任务状态。

## Impact

涉及 Agent Bar/preload/exact IPC、main 组合根、AgentRunService、scheduler/runner/Agent Loop、个人上下文分页读取、模型接入预算、storage worker/SQLite 追加迁移、诊断与导出。没有新 provider 或框架依赖，不改变字幕采集、ASR 或字幕事实。

P0 与 P1 的实现和局部回归已有证据；P1 的正式 Electron J30 联合验收仍待收尾计划执行。P2 仅有 `summary.minutes@2` 预算策略登记，其余长输入执行链尚未实施。状态和证据按阶段分别记录于[测试策略](../../../docs/testing-strategy.md)及任务表；本 change 在 P1 收尾后仍不能归档，直至 P2 范围另行实施和验收。当前不宣称支持 4–5 小时长输入，也不把本次确定性验收映射为真实模型、公网或实机结论。容量和时限承诺见[语义合同](../../../docs/semantic-contract.md)。
