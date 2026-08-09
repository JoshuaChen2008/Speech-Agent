# 正式 Agent 首版接口合同

> 证据状态：已决定。本文冻结正式产品接口职责，不表示 J13/J20/J21/J22/J24 已有实现证据。

## 1. 边界与版本

本文只描述正式 Agent 首版。`src/agent-mvp/` 的隔离 Agent 内核开发入口继续受 SEM-F29/J23 约束，不直接变成正式入口，也不迁移其 SQLite 数据。

所有跨进程请求必须使用闭合对象、稳定错误码和显式版本；renderer、插件、模型和网络响应都不能声明权威 digest。字幕系统即使没有注册任何 Agent handler，仍须独立满足 J1/J2/J10/J12。

## 2. 共享值对象

```ts
type InputReference = {
  sessionId: string
  inputWatermark: number
  transcriptVersion: 'original' | 'refined'
  inputDigest: LowercaseSha256
}

type AgentTaskKind =
  | 'meeting-minutes'
  | 'memory-extraction'
  | 'enhanced-transcript'

type AgentJobState =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

type AgentEligibility =
  | 'ready'
  | 'no_committed_transcript'
  | 'outside_automatic_window'
  | 'agent_disabled'
  | 'provider_not_configured'
  | 'cloud_disclosure_required'
  | 'credential_unavailable'
  | 'local_model_not_ready'
  | 'session_not_terminal'
```

`InputReference` 在任务创建时冻结。自动重试沿用同一 `runId`；用户主动重新生成使用新的 `runId`。`AgentEligibility` 是 Agent 处理资格，不是后台 Agent 任务状态。只有 `ready` 可以创建或领取任务；其余结果不调用 Agent 模型 provider，并由设置或历史界面显示下一动作。判定顺序固定为：`session_not_terminal → no_committed_transcript → outside_automatic_window`（仅自动请求）`→ agent_disabled → provider_not_configured → cloud_disclosure_required/credential_unavailable`（仅云端 Agent 模型 provider）`→ local_model_not_ready`（仅本地 Agent 模型 provider）`→ ready`。用户请求不受自动处理时间边界限制，但不能绕过其它条件。零条首次稳定转写没有合法 `inputWatermark`，因此不创建后台 Agent 任务，历史详情返回 `no_committed_transcript`，而不是伪造成功任务。

稳定错误码沿用 `docs/data-architecture.md` 的闭集。408、429、网络/5xx 和 worker 退出可在预算内进入 `retry_wait`；鉴权、Schema、权限、参数和内部不变量错误进入 `failed`；用户取消进入 `cancelled` 且不得恢复。原始 Error、stack、凭据、正文和本地绝对路径不得进入跨进程错误或证据报告。

## 3. 宿主端口

| 端口 | 最小职责 | 禁止事项 |
|---|---|---|
| `TranscriptReader.readSnapshot(inputRef)` | 由 storage worker 复算 digest，按 `event_order` 返回冻结版本的已提交字幕段 | 不读 `partial`，不直接信任 `segments.text`，不接受模型提供的水位 |
| `AgentInputPlanner.plan(snapshot, agentProviderLimits, recipeBudget)` | 按 ADR 0009 生成覆盖全部字幕段和超长单段 Unicode code point 范围的确定性单次或分块计划 | 不静默截断，不让 LLM 选择遗漏范围，不持久化分块正文 |
| `MemoryReader.query(query)` | 按启用状态、作用域、类型、生命周期和预算返回当前个人记忆投影 | 不返回休眠、冲突、失效或被抑制正文，不复制整场正文 |
| `ModelGateway.execute(request, signal)` | 冻结 Agent 模型 provider/model/recipe，管理凭据、超时、取消、用量与结构化结果 | 不向插件暴露 API key、任意 URL 或 Agent 模型 provider SDK |
| `ArtifactWriter.commit(candidate, lease)` | 校验租约、输入身份、Schema 和取消状态后写版本化产物 | 不写 `caption_events/segments`，不接受调用方 digest 为权威 |
| `MemoryCandidateSink.commit(candidate, lease)` | 校验来源、三级筛选、范围、冲突和 suppression 后提交记忆事实 | 不从摘要二次提取，不把推断直接提升为明确偏好 |
| `JobController.request/cancel/reconcile` | 只操作 registry 中的固定任务，落实人工幂等键和终态会话对账 | 不接受任意 prompt、工具表、文件路径或 SQL |
| `RecognitionProviderRegistry` | 注册第一方识别适配器及关键词、取消、存活检测、有序事件能力 | 不与 Agent 模型 provider 共用选择或凭据 |
| `AgentModelProviderRegistry` | 注册本地/云端 Agent 模型能力、上下文窗口和输出预算 | 不扩张插件权限，不改变字幕会话状态 |

`AgentInputPlanner` 是宿主内部端口，不属于插件权限。只有所有分块及归并步骤成功后才能调用 writer；中间结果只存在于本次有界执行内存中。

## 4. Storage worker 协议

正式 migration 必须追加到既有 immutable catalog；不得修改 `INITIAL_SCHEMA_SQL`，也不得把隔离入口候选数据库迁入正式 userData。

| 操作 | 请求身份 | 返回或副作用 |
|---|---|---|
| `agent.evaluateEligibility` | `{ sessionId, requestedBy: 'automatic' | 'user' }` | 按固定优先级返回闭集 `AgentEligibility`；自动请求还校验 ADR 0008 的 `automaticProcessingSince`，用户请求忽略该时间边界 |
| `agent.reconcileTerminalSession` | `{ sessionId, requestedBy: 'automatic' }` | 复算终态、完整输入身份与 Agent 处理资格；只有 `ready` 幂等补建三项后台 Agent 任务，其余只返回资格结果 |
| `agent.claimNextJob` | `{ owner, leaseMs, localWorkAllowed }` | 短事务领取一项符合资源策略的任务并返回 lease |
| `agent.renewJobLease` | `{ runId, lease, leaseMs }` | 只延长当前有效租约；陈旧租约 fail closed |
| `agent.markJobRetry` | `{ runId, lease, errorCode, nextAttemptAt }` | 沿用同一 `runId`，增加尝试事实 |
| `agent.commitArtifact` | `{ runId, lease, artifact }` | 原子写产物并把 job 置为 `succeeded` |
| `agent.commitMemoryCandidates` | `{ runId, lease, candidates }` | 原子写候选/来源/修订并把 job 置为 `succeeded` |
| `agent.requestJob` | `{ inputRef, taskKind, clientIdempotencyKey, requestDigest }` | 只接受当前终态会话且 Agent 处理资格为 `ready` 的现行输入身份；相同 key+digest 返回既有 job，相同 key+不同 digest 或陈旧输入拒绝 |
| `agent.requestCancel` | `{ runId }` | queued/retry_wait 立即取消；running 写取消请求并拒绝迟到提交 |
| `agent.getSessionDetail` | `{ sessionId }` | 返回 eligibility、三项任务状态、当前及历史产物版本，不返回凭据 |
| `agent.deleteSessionData` | `{ sessionId }` | 与会话删除同一 storage worker 内清理任务、产物、聊天关联和记忆来源；对账不得复活 |

所有任务领取、网络推理和结果提交必须分离：SQLite 事务内不得执行网络请求或模型推理。

## 5. 正式 IPC / preload 合同

下列名称是正式 channel 名。每个请求必须在 `src/main/ipc/access-policy.js` 注册精确 renderer role，并由 preload 收窄参数；主进程仍须重新校验，不能依赖 renderer 转型。

| Channel | Role | 精确请求 | 结果摘要 |
|---|---|---|---|
| `agent-settings:get` | `settings` | `{}` | Agent 总开关、Agent 模型 provider/模型非敏感状态、云端披露、个人记忆开关、`automaticProcessingSince`、revision |
| `agent-settings:update` | `settings` | `{ expectedRevision, agentEnabled, providerId, model, memoryEnabled, cloudDisclosureAccepted }` | 新 revision；开启时建立自动处理时间边界，活动任务继续使用冻结快照，关闭 Agent 或个人记忆触发对应取消 |
| `agent-credential:set` | `settings` | `{ providerId, apiKey }` | 仅返回 `{ credentialState }`；绝不回读 apiKey |
| `agent-credential:clear` | `settings` | `{ providerId }` | 清除后 queued/running job 不静默更换 Agent 模型 provider |
| `recognition-terms:list` | `settings` | `{ limit, cursor, scopeFilter, lifecycleFilter }` | 候选与已确认词汇的有界页 |
| `recognition-terms:update` | `settings` | `{ termId, expectedRevision, action, canonicalText, aliases, scopeId }` | 新 revision；只影响下一新会话快照 |
| `agent-session:get` | `history` | `{ sessionId }` | eligibility、三项 job、当前产物和版本摘要 |
| `agent-artifact:get` | `history` | `{ artifactId }` | Schema 化会后结构化纪要或增强文本及输入身份 |
| `agent-job:request` | `history`/`agent-debug` | `{ inputRef, taskKind, clientIdempotencyKey }` | 先返回或校验 Agent 处理资格；活动会话、陈旧输入或非 `ready` 结果不创建 job，主进程计算 `requestDigest` |
| `agent-job:cancel` | `history`/`agent-debug` | `{ runId }` | 权威 job 状态 |
| `agent-debug:get` | `agent-debug` | `{ sessionId, limit, cursor }` | 冻结上下文、消息与工具事件页 |
| `agent-debug:send` | `agent-debug` | `{ sessionId, prompt, clientMessageId }` | 接受状态；流式增量只走事件通道且不持久化 |
| `agent-debug:stop` | `agent-debug` | `{ threadId, turnId }` | 停止当前聊天 turn，不取消无关后台任务 |
| `agent-debug:confirm` | `agent-debug` | `{ previewId, decision, clientIdempotencyKey }` | 拒绝或请求固定后台任务 |
| `agent-debug:clear` | `agent-debug` | `{ threadId }` | 清除本地聊天记录，不删除字幕、产物或个人记忆 |

事件通道只发布投影：`agent:job-changed`、`agent:artifact-changed`、`agent:debug-event`、`agent:capability-changed`。renderer reload 后必须先重新读取 snapshot，再订阅增量；增量丢失不能制造第二项任务或第二份当前产物。

## 6. 结构化产物

### 6.1 会后结构化纪要

```ts
type MeetingMinutes = {
  overview: string
  conclusions: Array<{ text: string, evidence: EventRange[] }>
  actionItems: Array<{ text: string, owner: string | null, due: string | null, evidence: EventRange[] }>
  risks: Array<{ text: string, evidence: EventRange[] }>
}
```

没有结论、待办或风险时使用空数组，不补写推测内容。没有说话人身份证据时 `owner` 必须为 `null`。UI 固定映射为“概要 / 结论 / 待办 / 风险”，不能把字段名直接展示给用户。

### 6.2 增强文本

增强文本是独立派生版本，包含段落化正文及可回到输入事件范围的映射；它不能替换、删除或静默遮蔽权威原始转写。

### 6.3 个人记忆候选

候选必须是原子结构，包含 `kind/scope/origin/content/evidence/confidenceBand/salienceBand`。模型只能提出候选；宿主决定去重、冲突、revision、suppression 和当前投影。

## 7. 资源与设置变化

- 本地 Agent job 只在无活动字幕会话时领取。活动字幕会话开始后，正在执行的本地 job 有界取消并进入可重试状态；云端 Agent job 可以继续。
- Agent 总开关首次默认为关闭；个人记忆开关仍按 SEM-F26 默认为开启，但只在 Agent 总开关开启且处理资格为 `ready` 时生效。关闭 Agent 后不再创建或领取任务，queued/retry_wait job 取消，running job 请求取消并拒绝迟到提交；既有产物和个人记忆保留在本地。
- `agentEnabled` 与 `automaticProcessingSince` 由主进程 `ConfigStore.aiPreferences` 原子持久化，字段名在 IPC、运行时和持久设置中统一使用 camelCase。首次为 `false/null`，每次从关闭变为开启时写入与 `sessions.ended_at` 同一 UTC epoch-millisecond 时间基准的新边界；关闭时恢复 `false/null`。启动时出现非法组合必须 fail closed 为关闭，且该绝对时点不得进入 SEM-F14 证据报告。
- 自动对账不处理 `automaticProcessingSince` 之前的终态会话；更早会话只能由用户从历史明确请求。
- Agent 模型 provider、模型和 recipe 在 job 创建时冻结。设置更新只影响新 job，不修改运行中或历史 job。
- 个人记忆开关关闭时，queued/retry_wait 的 memory job 取消，running memory job 请求取消并拒绝迟到提交；纪要和增强文本不受影响。
- 会话删除优先于任何迟到 Agent 提交；删除后的终态会话不能被 reconciliation 再次发现。
- 应用退出先停止接单，再取消当前 Loop、持久化权威状态、关闭 Agent utility 与 storage utility；下一次启动对账恢复同一 `runId`。

## 8. 验收映射

- J13：端口白名单、插件异常/卸载/重复触发与越权。
- J20：识别 provider registry、Agent 模型 provider registry、确认关键词与会话冻结。
- J21：三项后台 Agent 任务、产物、个人记忆及设置/历史真实链路。
- J22：正式调试聊天、执行预览、确认和固定业务工具。
- J24：空/短/长输入、重复动作、丢失响应、退出恢复、删除、资源仲裁、隐私与可访问状态组合。
- SEM-T15：只有上述旅程在真实内部模块上闭合后，正式 Agent 首版才能提高验收状态。
