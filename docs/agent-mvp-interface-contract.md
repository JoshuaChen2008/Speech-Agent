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

type AgentEligibilityContext = {
  agentEnabled: boolean
  memoryEnabled: boolean
  automaticProcessingSince: number | null
  memoryProcessingSince: number | null
  providerId: string | null
  providerKind: 'cloud' | 'local' | null
  model: string | null
  cloudDisclosureAccepted: boolean
  credentialAvailable: boolean
  localModelReady: boolean
}

type EventRange = {
  fromEventOrder: number
  throughEventOrder: number
}

type MeetingMinutesArtifact = {
  type: 'meeting-minutes'
  content: {
    overview: string
    conclusions: Array<{ text: string, evidence: EventRange[] }>
    actionItems: Array<{ text: string, owner: string | null, due: string | null, evidence: EventRange[] }>
    risks: Array<{ text: string, evidence: EventRange[] }>
  }
}

type EnhancedTranscriptArtifact = {
  type: 'enhanced-transcript'
  content: {
    paragraphs: Array<{ text: string, evidence: EventRange[] }>
  }
}

type MemoryCandidate = {
  kind: 'decision' | 'conclusion' | 'action-item' | 'term' | 'preference' | 'project-fact' | 'experience'
  semanticKey: string
  scope: {
    kind: 'global' | 'session' | 'topic' | 'project'
    canonicalKey: string
    label: string
  }
  origin: 'explicit' | 'automatic'
  content: Record<string, JsonValue>
  evidence: EventRange[]
  confidenceBand: 'low' | 'medium' | 'high'
  salienceBand: 'low' | 'medium' | 'high'
}
```

`InputReference` 在任务创建时冻结。自动重试沿用同一 `runId`；用户主动重新生成使用新的 `runId`。`AgentEligibility` 是 Agent 处理资格，不是后台 Agent 任务状态。只有 `ready` 可以创建或领取任务；其余结果不调用 Agent 模型 provider，并由设置或历史界面显示下一动作。判定顺序固定为：`session_not_terminal → no_committed_transcript → outside_automatic_window`（仅自动请求）`→ agent_disabled → provider_not_configured → cloud_disclosure_required/credential_unavailable`（仅云端 Agent 模型 provider）`→ local_model_not_ready`（仅本地 Agent 模型 provider）`→ ready`。用户请求不受自动处理时间边界限制，但不能绕过其它条件。零条首次稳定转写没有合法 `inputWatermark`，因此不创建后台 Agent 任务，历史详情返回 `no_committed_transcript`，而不是伪造成功任务。

`AgentEligibilityContext` 只由受信任的主进程从 ConfigStore、系统凭据存储与本地模型就绪证明组合，并以 exact object 交给 storage worker；renderer、插件或 Agent 模型 provider 不得提供或覆盖该对象。storage worker 仍负责读取会话、首次稳定转写和终态事实，并按上述固定顺序复算资格。上下文只携带非敏感事实：`credentialAvailable` 是布尔值，不能携带、持久化或返回凭据；`providerId/providerKind/model` 只有三者同时形成有效配置才算已配置。`memoryEnabled` 不改变会话级 Agent 处理资格；`memoryProcessingSince` 只决定自动对账是否为该终态会话创建个人记忆任务。Agent 总开关或个人记忆从不生效转为生效时写入新边界，任一关闭时该边界为 `null`；因此自动记忆任务同时要求会话位于 `automaticProcessingSince` 与 `memoryProcessingSince` 之内。用户明确请求可忽略两个时间边界，但 `memory-extraction` 仍要求个人记忆开启。云端资格只读取披露与凭据事实，本地资格只读取模型就绪事实；无关字段不能绕过适用分支。

`transcriptVersion: 'refined'` 只表示整场精修覆盖完整的冻结精修稿。`0 < N < M` 的精修覆盖不完整只是显示/导出层的混合视图，不形成首版 Agent 输入版本；用户必须明确使用权威原始转写，或者在 `N=M` 时选择完整精修稿。storage worker 必须在调用 Agent 模型 provider 前拒绝把不完整混合正文声明为 `refined`。

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

正式 migration 必须按 ADR 0010 追加到正式 immutable catalog：共享字幕基础 v1/v2，但使用独立于隔离入口候选 v3 的正式 Agent v3。不得修改既有 migration SQL/checksum，不得把隔离入口候选数据库迁入正式 userData，两个 catalog 交叉打开必须 fail closed。

| 操作 | 请求身份 | 返回或副作用 |
|---|---|---|
| `agent.evaluateEligibility` | `{ sessionId, requestedBy: 'automatic' \| 'user', eligibilityContext }` | exact 校验受信任主进程提供的非敏感 `AgentEligibilityContext`，再按固定优先级返回闭集 `AgentEligibility`；自动请求还校验 ADR 0008 的 `automaticProcessingSince`，用户请求忽略该时间边界 |
| `agent.reconcileTerminalSession` | `{ sessionId, requestedBy: 'automatic', eligibilityContext }` | 复算终态、完整输入身份与 Agent 处理资格；只有 `ready` 幂等补建纪要与增强文本，且仅在个人记忆自动处理边界内补建记忆任务，其余只返回资格结果 |
| `agent.claimNextJob` | `{ claimIdempotencyKey, owner, leaseMs, localWorkAllowed }` | 在同一事务内按最近一次 `applyTaskPolicy` 建立的当前受信任开关、时间边界、冻结 provider/model 可执行事实和资源策略领取任务并写 claim receipt；worker replacement 后未重新应用策略时 fail closed 为空结果；未知回复以同一 key 重放时只返回原任务/租约或空结果，绝不领取下一项任务 |
| `agent.renewJobLease` | `{ runId, lease, newExpiresAt }` | 只把当前有效租约延长到调用方冻结的绝对到期时点；同一旧 lease + `newExpiresAt` 重放返回当前结果，陈旧租约 fail closed |
| `agent.markJobRetry` | `{ runId, lease, errorCode, nextAttemptAt }` | 沿用同一 `runId`，增加尝试事实；相同已提交状态转换重放返回当前任务，不形成第二次转换 |
| `agent.markJobFailed` | `{ runId, lease, errorCode }` | 只接受不可重试错误闭集并把当前租约任务置为 `failed`；不保存原始 Error/stack；相同终态重放返回当前任务 |
| `agent.markJobCancelled` | `{ runId, lease }` | 只在当前有效租约已有取消请求时收束为 `cancelled`；清空租约与错误码，后续不恢复；相同终态重放返回当前任务 |
| `agent.commitArtifact` | `{ runId, lease, artifact: MeetingMinutesArtifact \| EnhancedTranscriptArtifact }` | 重读并匹配冻结输入身份，按闭合 Schema 校验正文与事件范围，由 storage worker 计算 canonical digest；在同一事务中写产物并把 job 置为 `succeeded`。同一 `runId` 与相同产物重放返回既有结果，内容或身份不同 fail closed |
| `agent.commitMemoryCandidates` | `{ runId, lease, candidates: MemoryCandidate[] }` | 重读并匹配冻结输入身份；在同一事务中执行低价值/低置信自动推断丢弃、无身份全局偏好拒绝、suppression、范围、去重、冲突、revision 与来源提交，再把 job 置为 `succeeded`。同一 `runId` 的成功重放只返回既有计数，不二次写入 |
| `agent.requestJob` | `{ inputRef, taskKind, clientIdempotencyKey, requestDigest, eligibilityContext }` | exact 校验上下文，只接受当前终态会话且 Agent 处理资格为 `ready` 的现行输入身份；相同 key+digest 返回既有 job，相同 key+不同 digest 或陈旧输入拒绝 |
| `agent.requestCancel` | `{ runId }` | queued/retry_wait 立即取消；running 写取消请求并拒绝迟到提交 |
| `agent.applyTaskPolicy` | `{ eligibilityContext }` | 在一个 storage worker 命令内建立当前非敏感策略 generation 并执行取消：Agent 总开关关闭时取消全部 queued/retry_wait 并请求取消 running；只关闭个人记忆时仅作用于 `memory-extraction`，重新开启不复活已取消任务。worker 首启/replacement 未收到该命令前不得领取任务 |
| `agent.getSessionDetail` | `{ sessionId, eligibilityContext }` | 以当前非敏感上下文复算 eligibility，返回三项任务公开状态、当前及历史产物版本；不返回凭据、lease owner、lease 到期时点或其它 worker 控制字段 |
| `agent.deleteSessionData` | `{ sessionId, deletionIdempotencyKey }` | 在同一 storage worker 事务内写删除 tombstone，再受控删除字幕事实、任务、产物、聊天关联和记忆来源并清理仅由该会话支撑的记忆；迟到提交和后续对账 fail closed，相同 key 重放不影响其它会话 |

所有任务领取、网络推理和结果提交必须分离：SQLite 事务内不得执行网络请求或模型推理。

`applyTaskPolicy` 的 `eligibilityContext` 仍由受信任主进程提供；其 `providerId/providerKind/model` 表示当前可以执行的 Agent 模型 provider 快照。storage worker 只领取与该三元组完全相同、当前资格仍满足的 job；设置变化与 claim 通过同一 worker FIFO 线性化，凭据清除、本地模型失效、Agent/个人记忆关闭或时间边界变化必须在下一次 claim 前 fail closed。策略 generation 只存在于当前 worker 内存；replacement 后主进程必须重新应用，未应用状态不能领取任何任务。`claimIdempotencyKey` 的 receipt 只保存稳定身份、请求 digest、`runId` 与 lease 元数据，不保存正文、凭据、路径或原始错误。

## 5. 正式 IPC / preload 合同

下列名称是正式 channel 名。每个请求必须在 `src/main/ipc/access-policy.js` 注册精确 renderer role，并由 preload 收窄参数；主进程仍须重新校验，不能依赖 renderer 转型。

| Channel | Role | 精确请求 | 结果摘要 |
|---|---|---|---|
| `agent-settings:get` | `settings` | `{}` | Agent 总开关、Agent 模型 provider/模型非敏感状态、云端披露、个人记忆开关、`automaticProcessingSince`、`memoryProcessingSince`、revision |
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

增强文本是独立派生版本，固定为 `paragraphs[]`；每段只包含 `text` 与至少一个可回到冻结输入的 `EventRange`。它不能替换、删除或静默遮蔽权威原始转写。

### 6.3 个人记忆候选

候选必须是上述闭合原子结构，包含稳定 `semanticKey`、范围、来源性质、对象型 `content`、至少一个 `EventRange`、置信档与显著性档。`salienceBand=low` 的候选和 `origin=automatic && confidenceBand=low` 的推断直接丢弃；没有用户身份事实时，`origin=automatic` 的全局 `preference` 也不得写入。模型只能提出候选；宿主决定去重、冲突、revision、suppression 和当前投影。

## 7. 资源与设置变化

- 本地 Agent job 只在无活动字幕会话时领取。活动字幕会话开始后，正在执行的本地 job 有界取消并进入可重试状态；云端 Agent job 可以继续。
- Agent 总开关首次默认为关闭；个人记忆开关仍按 SEM-F26 默认为开启，但只在 Agent 总开关开启且处理资格为 `ready` 时生效。关闭 Agent 后不再创建或领取任务，queued/retry_wait job 取消，running job 请求取消并拒绝迟到提交；既有产物和个人记忆保留在本地。
- `agentEnabled`、`automaticProcessingSince` 与 `memoryProcessingSince` 由主进程 `ConfigStore.aiPreferences` 原子持久化，字段名在 IPC、运行时和持久设置中统一使用 camelCase。Agent 首次为 `false/null`，每次从关闭变为开启时写入与 `sessions.ended_at` 同一 UTC epoch-millisecond 时间基准的新 Agent 边界；`agentEnabled && memoryEnabled` 每次从不生效变为生效时写入新的个人记忆边界，任一开关关闭时该边界恢复为 `null`。启动时出现非法组合必须 fail closed 为对应能力关闭，且两个绝对时点都不得进入 SEM-F14 证据报告。
- 自动对账不处理 `automaticProcessingSince` 之前的终态会话；更早会话只能由用户从历史明确请求。
- Agent 模型 provider、模型和 recipe 在 job 创建时冻结。设置更新只影响新 job，不修改运行中或历史 job。
- 个人记忆开关关闭时，queued/retry_wait 的 memory job 取消，running memory job 请求取消并拒绝迟到提交；纪要和增强文本不受影响。重新开启只为新个人记忆自动处理边界之后结束的会话创建自动记忆任务，不复活已取消任务，也不补处理关闭期间会话；历史中的用户明确请求仍可重新提取。
- 会话删除优先于任何迟到 Agent 提交；删除后的终态会话不能被 reconciliation 再次发现。
- 应用退出先停止接单，再取消当前 Loop、持久化权威状态、关闭 Agent utility 与 storage utility；下一次启动对账恢复同一 `runId`。

## 8. 验收映射

- J13：端口白名单、插件异常/卸载/重复触发与越权。
- J20：识别 provider registry、Agent 模型 provider registry、确认关键词与会话冻结。
- J21：三项后台 Agent 任务、产物、个人记忆及设置/历史真实链路。
- J22：正式调试聊天、执行预览、确认和固定业务工具。
- J24：空/短/长输入、重复动作、丢失响应、退出恢复、删除、资源仲裁、隐私与可访问状态组合。
- SEM-T15：只有上述旅程在真实内部模块上闭合后，正式 Agent 首版才能提高验收状态。
