# ADR 0008：终态会话对账创建后台 Agent 任务

- 状态：已决定
- 日期：2026-08-09
- 决策者：项目负责人
- 依赖：ADR 0001、ADR 0002、ADR 0003

## 背景

字幕事实事务不能因 Agent 系统缺失、Agent 模型 provider 故障或任务表写入失败而回滚。事务 outbox 能提供紧邻字幕写入的唤醒记录，但会把可选 Agent 系统的 schema 与写放大引入字幕高优先级路径。终态会话及其完整提交水位已经是可重复查询的稳定事实，因此可以从该事实恢复遗漏任务。

## 决策

1. 自动后台 Agent 任务使用终态会话 durable reconciliation 创建，不在字幕事件事务中写 Agent outbox。
2. 正常停止取得完整输入水位后尽力运行一次对账；应用启动、Agent worker replacement 和 Agent 模型 provider 恢复时再次扫描 `state IN ('closed','interrupted') AND ended_at IS NOT NULL` 的终态会话。只有至少存在一条已持久化首次稳定转写、能够形成合法完整输入身份且 Agent 处理资格为 `ready` 的终态会话才补建缺失任务；零条首次稳定转写返回 `no_committed_transcript`，Agent 关闭或配置不满足时返回对应资格结果，均不创建任务或调用 Agent 模型 provider。`input_watermark` 等于输入快照消费到的最大 `caption_events.event_order`。
3. 自动任务的 dedupe key 由 `session_id + plugin_id + artifact_kind + transcript_version + input_watermark + input_digest + recipe_version` 生成，并受 SQLite 唯一约束保护。规范化统一使用 RFC 8785 canonical JSON 的 UTF-8 字节和 SHA-256 小写十六进制；input digest 由 storage worker 从有序字幕事实计算，任务 digest 由 `AgentPluginHost` 计算，不接受 renderer、插件或模型自行声明。
4. 用户主动重新运行不复用自动任务 dedupe key：每次明确动作生成新 `run_id`，同时保存该动作的稳定 client idempotency key 与不可变请求字段的 `request_digest`。同一 client key 重放时只有 request digest 完全相同才返回已有任务，不同时以 `AGENT_REQUEST_INVALID` fail closed。
5. `agent_jobs` 持久化固定输入引用、Agent 模型 provider/model/recipe 快照、状态、尝试预算、下一次重试时点、租约、取消请求和稳定错误码。过期租约在恢复时沿用同一 `run_id` 重新排队；用户主动重新运行使用新 `run_id`。
6. Agent 总开关从关闭转为开启时，宿主保存新的 `automaticProcessingSince`；自动对账只处理 `ended_at >= automaticProcessingSince` 的终态会话。个人记忆从不生效转为生效时另存新的 `memoryProcessingSince`，自动记忆任务还要求 `ended_at >= memoryProcessingSince`；关闭 Agent 或个人记忆时该边界失效，重新开启后不得静默补处理关闭期间或更早的会话。自动请求遇到 Agent 总开关边界之外的会话时返回 `outside_automatic_window`；只落在个人记忆边界之外时，纪要与增强文本仍可对账，但省略记忆任务。Agent 模型 provider 配置、凭据、本地模型就绪或云端披露暂不满足时不创建任务；资格恢复后只对适用时间边界内的会话重新对账。用户仍可从历史明确请求更早终态会话或明确重新提取个人记忆，且请求必须重新通过当前 Agent 处理资格和个人记忆开关校验。
7. Agent job 创建、执行或提交失败只影响 Agent 系统。字幕会话终态、权威原始转写、字幕历史和应用退出不等待 Agent 对账成功。

## 取舍

- 对账扫描比事务 outbox 更晚发现任务，但避免改变字幕事实事务，并能从终态会话权威事实恢复。
- 需要唯一 dedupe key、短租约和启动扫描；换来 worker 崩溃后不依赖内存队列或第二份事件日志。
- 删除会话时必须在同一 storage worker 内清理该会话尚未运行的 Agent 任务和派生产物，不能让后续对账复活已经删除的会话。

## 关联

- 语义：SEM-F16、SEM-F28、SEM-F29
- 旅程：J21、J22、J23、J24
- 数据：DB7
