# 正式 Agent 首版接口合同

> 证据状态：已决定。D3 的正式 SQLite 与存储/生命周期子边界、D4 的会后结构化纪要后端纵切、D5 的增强文本与个人记忆 UI-free 后端纵切、D6 的 production `StorageWorkerHost` storage utility transport 子边界，以及 D8 的 `MemoryReader → StorageWorkerService/FormalAgentStore` UI-free storage-worker 子边界均为实现完成·尚未验收。D6 已经过真实 Electron utility process，覆盖策略先行、claim 后 exact-child 强制退出与退出同一性、replacement 未重放策略前拒绝领取、租约到期后同 `runId` 恢复、重复对账和三项结果各自最多提交一次，并由父测试独立复算 SQLite 身份与隐私负扫描。D8 覆盖受信任策略门控、休眠/恢复、active/current revision 投影、固定排序、完整条目字节预算和 replacement 策略重放；它仍未进入正式 `StorageGateway`、Agent utility、preload/IPC、renderer 或 recipe，不能作为正式 J21 用户读取路径。ADR 0011 另冻结正式首版的 DeepSeek 非敏感配置表、启动环境凭据、provider/model/预算冻结和降级；本文不表示真实 DeepSeek 已接入，也不表示 J13/J20/J21/J22/J24 已有完整产品证据。

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

type AgentProviderBootstrapConfig = {
  providerId: 'deepseek'
  providerKind: 'cloud'
  apiStyle: 'openai-chat-completions'
  baseUrl: 'https://api.deepseek.com'
  model: string
  maxChunkInputBytes: number
  maxResultBytes: number
  timeoutMs: number
}

type AgentProviderPublicState = {
  provider: {
    providerId: 'deepseek'
    providerKind: 'cloud'
    model: string
  } | null
  configurationSource: 'trusted_config_table'
  credentialState: 'startup_environment' | 'missing' | 'invalid'
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

type MemoryQuery = {
  scopeRefs: Array<{
    kind: 'global' | 'session' | 'topic' | 'project'
    canonicalKey: string
  }>
  kinds: Array<'decision' | 'conclusion' | 'action-item' | 'term' | 'preference' | 'project-fact' | 'experience'>
  semanticKeys: string[]
  maxItems: number
  maxSerializedBytes: number
}

type MemoryProjection = {
  availability: 'ready' | 'dormant'
  reason:
    | null
    | 'agent_disabled'
    | 'memory_disabled'
    | 'provider_not_configured'
    | 'cloud_disclosure_required'
    | 'credential_unavailable'
    | 'local_model_not_ready'
  items: Array<{
    memoryId: string
    scope: {
      kind: 'global' | 'session' | 'topic' | 'project'
      canonicalKey: string
      label: string
    }
    kind: MemoryQuery['kinds'][number]
    semanticKey: string
    content: Record<string, JsonValue>
    origin: 'explicit' | 'automatic'
    confidenceBand: 'low' | 'medium' | 'high'
    salienceBand: 'low' | 'medium' | 'high'
    revisionId: string
    updatedAt: number
    evidenceCount: number
    evidence: Array<{
      sessionId: string
      transcriptVersion: 'original' | 'refined'
      inputWatermark: number
      fromEventOrder: number
      throughEventOrder: number
      inputDigest: LowercaseSha256
    }>
  }>
  itemCount: number
  serializedBytes: number
  hasMore: boolean
}

type PluginResult =
  | { kind: 'artifact', value: MeetingMinutesArtifact | EnhancedTranscriptArtifact }
  | { kind: 'memory-candidates', value: MemoryCandidate[] }
```

`InputReference` 在任务创建时冻结。自动重试沿用同一 `runId`；用户主动重新生成使用新的 `runId`。`AgentEligibility` 是 Agent 处理资格，不是后台 Agent 任务状态。只有 `ready` 可以创建或领取任务；其余结果不调用 Agent 模型 provider，并由设置或历史界面显示下一动作。判定顺序固定为：`session_not_terminal → no_committed_transcript → outside_automatic_window`（仅自动请求）`→ agent_disabled → provider_not_configured → cloud_disclosure_required/credential_unavailable`（仅云端 Agent 模型 provider）`→ local_model_not_ready`（仅本地 Agent 模型 provider）`→ ready`。用户请求不受自动处理时间边界限制，但不能绕过其它条件。零条首次稳定转写没有合法 `inputWatermark`，因此不创建后台 Agent 任务，历史详情返回 `no_committed_transcript`，而不是伪造成功任务。

`AgentEligibilityContext` 只由受信任的主进程从 `AgentProviderConfigCatalog`、ConfigStore v2 的平面 Agent 设置、启动时从环境读取并只驻留主进程内存的凭据，以及本地模型就绪证明组合，并以 exact object 交给 storage worker；renderer、插件或 Agent 模型 provider 不得提供或覆盖该对象。正式 main 必须在创建任何 `BrowserWindow`、preload、renderer、Node worker、child process 或 utility process 之前读取并删除 `DEEPSEEK_API_KEY`，所有子进程环境显式排除该变量；storage worker 只得到 `credentialAvailable` 布尔值。storage worker 仍负责读取会话、首次稳定转写和终态事实，并按上述固定顺序复算资格。上下文只携带非敏感事实：`providerId/providerKind/model` 只有三者与合法 `AgentProviderBootstrapConfig` 同时成立才算已配置。`memoryEnabled` 不改变会话级 Agent 处理资格；`memoryProcessingSince` 只决定自动对账是否为该终态会话创建个人记忆任务。Agent 总开关或个人记忆从不生效转为生效时写入新边界，任一关闭时该边界为 `null`；因此自动记忆任务同时要求会话位于 `automaticProcessingSince` 与 `memoryProcessingSince` 之内。用户明确请求可忽略两个时间边界，但 `memory-extraction` 仍要求个人记忆开启。云端资格只读取披露与凭据事实，本地资格只读取模型就绪事实；`deepseek` 云端分支不要求 `localModelReady`，无关字段不能绕过适用分支。

初版受信任配置表默认 `providerId='deepseek'`、`providerKind='cloud'`、`apiStyle='openai-chat-completions'`、`baseUrl='https://api.deepseek.com'`、`model='deepseek-v4-flash'`。模型标识是可配置的不透明字符串；宿主不得根据名字猜测上下文、输出、Tool Calling 或思考模式能力。`maxChunkInputBytes/maxResultBytes/timeoutMs` 必须由配置表明确给出并经过范围校验。网络请求只允许 exact origin `https://api.deepseek.com`、受控路径且拒绝 redirect；应用不自动读取 `.env` 文件，renderer 不提供 API key 写入/回读接口；缺少、全空白或超过 4096 个 UTF-8 字节的凭据均返回 `credential_unavailable`。

D9 的默认受信任配置预算固定为 `maxChunkInputBytes=65536`、`maxResultBytes=16384`、`timeoutMs=60000`；它们是产品保守上限，不是从模型名推断的供应商能力。`AgentProviderBootstrap` 必须先消费并删除启动环境中所有大小写不敏感等价的 `DEEPSEEK_API_KEY` 键，再校验闭合配置表；重复等价键、非字符串、空白或 4097+ UTF-8 字节都产生 `credentialState='invalid'`，完全缺失产生 `missing`。它冻结删除后的 child environment 快照，运行中环境变化不再生效；公开投影只能包含 `providerId/providerKind/model` 与凭据来源状态，不含 URL、预算或凭据。主进程私有凭据使用有界 `Buffer`，每次调用只产生一份副本并在成功或异常后 `fill(0)`；稳定鉴权失败、Agent utility 异常退出或应用退出清零主副本且本进程不可恢复。D9 不创建窗口、worker/utility 或网络请求，也不修改 ConfigStore v1；正式 main 首行接线、ConfigStore v2、Agent utility 私有消息与 exact DeepSeek 网络适配器分别留待后续纵切。

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
| `AgentModelProviderRegistry` | 从 main-only `AgentProviderConfigCatalog` 注册 DeepSeek OpenAI-compatible 描述符及测试替身，向 `ModelGateway` 提供冻结的输入/输出预算、超时与打开模型句柄 | 不接受任意 URL，不读取 renderer key，不猜测模型能力，不扩张插件权限，不改变字幕会话状态 |

`AgentInputPlanner` 是宿主内部端口，不属于插件权限。只有所有分块及归并步骤成功后才能调用 writer；中间结果只存在于本次有界执行内存中。

D10 的 registry 描述符是闭合对象，只包含任务身份三元组、`maxChunkInputBytes/maxResultBytes/timeoutMs` 与 `withModel(request, signal, consumeModel)`。正式 `ModelGateway` 必须以 nominal instance 边界拒绝任意 duck-typed registry，再校验描述符与任务冻结身份完全一致。`withModel` 只向 `consumeModel` 提供冻结的 exact `{ model, streamFn }`，拒绝 `apiKey`、credential 与任意额外字段；它必须恰好一次调用 `consumeModel` 并原样返回该次 Pi Agent Loop 的结果，适配器不得绕过 Loop 直接返回结构化产物。registry 从配置超时和调用方取消派生同一受控信号，把它同时交给适配器的模型打开与 Pi Agent Loop；任一阶段取消或超时都立即停止等待并进入既有稳定错误分类。registry 在 `consumeModel` 完整收束前保持 D9 单次凭据借用，且不把凭据返回给 `ModelGateway`、插件、storage worker 或 renderer；迟到的适配器结果不得再进入 Loop。稳定鉴权失败使 bootstrap 主凭据失效；其它错误只按既有稳定错误分类收束。确定性适配器与未来 DeepSeek 网络适配器共用这一接口，但 D10 只实现前者的联合测试接线。

D11 把正式设置存储入口收窄为 `ConfigStore.updateAgentSettings({ expectedRevision, agentEnabled, memoryEnabled, cloudDisclosureAccepted })`。该方法拒绝缺失、多余或非法字段，revision 冲突以 `SETTINGS_REVISION_CONFLICT` 零写入；匹配时由 main-owned `now()` 产生非负安全整数边界，并按“不生效→生效时新建、持续生效时保留、不生效时置 `null`”归一化后一次原子替换。通用 `ConfigStore.update` 只服务既有字幕配置，不接受 `schemaVersion` 或六个 Agent 设置字段；provider、URL、model 与 API key 从未进入 `DEFAULT_CONFIG`、字段规则或设置更新请求。D11 只提供 main-owned 存储方法和 storage-worker 联合证据，正式 IPC/preload/renderer 接线仍后置。

固定 recipe 与模型操作闭集为：`meeting-minutes@1` 只允许 `meeting-minutes.chunk/merge`，`enhanced-transcript@1` 只允许 `enhanced-transcript.chunk/merge`，`memory-extraction@1` 只允许 `memory-extraction.chunk`。`memory-consolidation` 不创建第四项后台任务，也不再次调用模型；它在记忆任务的有界内存中按分块顺序校验并汇总候选，再由 `MemoryCandidateSink` 一次提交。`AgentPluginHost` 以 `PluginResult` 分流到唯一匹配的 writer，插件不得选择 SQLite 表或绕过宿主提交。

Agent 模型 provider registry 必须把上下文窗口、固定提示和输出预留折算成保守的 `maxChunkInputBytes`，`AgentInputPlanner` 再以 canonical JSON 的 UTF-8 字节数判定边界。该字节预算是避免超过上下文窗口的保守上限，不是对 token 数的产品展示值。规划优先保持完整字幕段；只有单段自身超过预算时才按 Unicode code point 的 `[fromCodePoint, throughCodePoint)` 分片。分片必须可按原顺序无损重建每段正文，且每个分块都保留原 `eventOrder` 作为证据身份。归并采用有界、确定性批次；如果预算不足以容纳至少两个受限中间结果，任务在调用 Agent 模型 provider 前 fail closed。宿主不得把输入分块或中间结果写入 SQLite、日志或报告。

`MemoryReader.query` 是 UI-free 的 Agent 内部读取端口，不是 renderer 的记忆管理列表。请求必须完整给出 1–16 个不重复的 `scopeRefs`、1–7 个不重复的 `kinds`、0–64 个不重复的 exact `semanticKeys`、`maxItems=1..20` 和 `maxSerializedBytes=256..65536`；它不接受自由文本、SQL、任意排序、cursor 或调用方提供的开关/资格。storage worker 只读取最近一次 `agent.applyTaskPolicy` 建立的受信任策略；worker 首启或 replacement 尚未重放策略时以 `AGENT_REQUEST_INVALID` fail closed。Agent 或个人记忆关闭，以及 Agent 模型 provider 配置、云端披露、凭据或本地模型就绪条件不满足时，返回带稳定 `reason` 的 `availability='dormant'`、零条目且不查询或改写记忆表；重新满足条件后，既有条目重新进入读取候选，不通过开关批量改写 lifecycle。

可读取候选必须同时满足 scope 为 `active`、item 为 `active`、当前 revision 属于该 item 且正文与当前投影一致。排序固定为明确内容优先、显著性高到低、置信高到低、来源证据数多到少、`updatedAt` 新到旧、`memoryId` 升序；每条最多返回最近 8 条无正文来源引用。单次查询最多读取排序后的 256 个候选；命中该上限时保守返回 `hasMore=true`，不得为精确探测第 257 条而读取其正文。条目按 canonical JSON 的完整 UTF-8 字节计入预算，只整条纳入而不截断 `content` 或来源，任一候选因条目数或字节数省略时也必须 `hasMore=true`。`serializedBytes` 是实际返回 item 对象 canonical JSON 字节数之和。首版 exact `semanticKeys` 为空表示不增加语义键过滤；不读取字幕 FTS，不创建向量或图索引。

D8 只闭合 `MemoryReader → StorageWorkerService/FormalAgentStore` 的 UI-free storage-worker 子边界，并登记 `StorageWorkerHost` 的精确 operation 映射；它没有修改并行任务负责的正式 `StorageGateway`，也没有加入 preload/IPC、renderer、Agent utility 或正式 recipe。因此本批不得宣称形成 J21 的正式用户读取路径；后续接线必须让正式 `StorageGateway` 暴露同一窄方法并以真实 gateway/utility/renderer 旅程重新验收，不能用本批自建 service client 代替。

## 4. Storage worker 协议

正式 migration 必须按 ADR 0010 追加到正式 immutable catalog：共享字幕基础 v1/v2，使用独立于隔离入口候选 v3 的正式 Agent v3，并以正式 v4 把 suppression 身份扩展为 `identity hash + source digest` 复合键、加入不含记忆正文的删除回执。不得修改既有 migration SQL/checksum，不得把隔离入口候选数据库迁入正式 userData，两个 catalog 交叉打开必须 fail closed。

| 操作 | 请求身份 | 返回或副作用 |
|---|---|---|
| `agent.evaluateEligibility` | `{ sessionId, requestedBy: 'automatic' \| 'user', eligibilityContext }` | exact 校验受信任主进程提供的非敏感 `AgentEligibilityContext`，再按固定优先级返回闭集 `AgentEligibility`；自动请求还校验 ADR 0008 的 `automaticProcessingSince`，用户请求忽略该时间边界 |
| `agent.reconcileTerminalSession` | `{ sessionId, requestedBy: 'automatic', eligibilityContext }` | 复算终态、完整输入身份与 Agent 处理资格；只有 `ready` 幂等补建纪要与增强文本，且仅在个人记忆自动处理边界内补建记忆任务，其余只返回资格结果 |
| `agent.readInputSnapshot` | `{ inputRef }` | storage worker 从首次稳定转写事实重建指定 `original` 或完整 `refined` 快照并复算完整输入身份；只在四字段逐项一致时按 `event_order` 返回正文段，否则以 `AGENT_INPUT_CHANGED` fail closed；不读取 `partial` 或把 `segments.text` 当作原始正文 |
| `agent.claimNextJob` | `{ claimIdempotencyKey, owner, leaseMs, localWorkAllowed, availableTaskKinds }` | exact 校验受信任宿主当前已装载且可执行的固定 `AgentTaskKind[]`，在同一事务内按最近一次 `applyTaskPolicy` 建立的当前受信任开关、时间边界、冻结 provider/model、插件可用性和资源策略领取兼容任务并写 claim receipt；未装载任务保持排队且不调用 Agent 模型 provider；worker replacement 后未重新应用策略时 fail closed 为空结果；未知回复以同一 key 与同一可用任务集合重放时只返回原任务/租约或空结果，绝不领取下一项任务 |
| `agent.renewJobLease` | `{ runId, lease, newExpiresAt }` | 只把当前有效租约延长到调用方冻结的绝对到期时点；同一旧 lease + `newExpiresAt` 重放返回当前结果，陈旧租约 fail closed |
| `agent.markJobRetry` | `{ runId, lease, errorCode, nextAttemptAt }` | 沿用同一 `runId`，增加尝试事实；相同已提交状态转换重放返回当前任务，不形成第二次转换 |
| `agent.markJobFailed` | `{ runId, lease, errorCode }` | 只接受不可重试错误闭集并把当前租约任务置为 `failed`；不保存原始 Error/stack；相同终态重放返回当前任务 |
| `agent.markJobCancelled` | `{ runId, lease }` | 只在当前有效租约已有取消请求时收束为 `cancelled`；清空租约与错误码，后续不恢复；相同终态重放返回当前任务 |
| `agent.commitArtifact` | `{ runId, lease, artifact: MeetingMinutesArtifact \| EnhancedTranscriptArtifact }` | 重读并匹配冻结输入身份，按闭合 Schema 校验正文与事件范围，由 storage worker 计算 canonical digest；在同一事务中写产物并把 job 置为 `succeeded`。同一 `runId` 与相同产物重放返回既有结果，内容或身份不同 fail closed |
| `agent.commitMemoryCandidates` | `{ runId, lease, candidates: MemoryCandidate[] }` | 重读并匹配冻结输入身份；在同一事务中执行低价值/低置信自动推断丢弃、无身份全局偏好拒绝、suppression、范围、去重、冲突、revision 与来源提交，再把 job 置为 `succeeded`。同一 `runId` 的成功重放只返回既有计数，不二次写入 |
| `agent.readMemoryContext` | `MemoryQuery` | 只依据最近一次受信任 `applyTaskPolicy` 返回 `MemoryProjection`；关闭或资格不足时返回休眠投影，策略尚未重放时 fail closed；不接受 renderer 设置、自由文本或分页，不产生 SQLite 写入 |
| `agent.deleteMemoryItem` | `{ memoryId, deletionIdempotencyKey }` | 在同一事务中为该条目每个既有来源 digest 写入 `identity hash + source digest` suppression，再物理删除当前条目、revision 与 evidence；回执只含稳定 ID、计数和删除时点，不含记忆正文。相同 key+请求重放同一结果，相同 key+不同请求 fail closed |
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
| `agent-settings:get` | `settings` | `{}` | Agent 总开关、`AgentProviderPublicState`、云端披露、个人记忆开关、`automaticProcessingSince`、`memoryProcessingSince`、revision；不返回 API key |
| `agent-settings:update` | `settings` | `{ expectedRevision, agentEnabled, memoryEnabled, cloudDisclosureAccepted }` | 同一次原子读改写先核对当前 `agentSettingsRevision`；不匹配返回 `SETTINGS_REVISION_CONFLICT` 且零写入，匹配时应用开关/边界归一化并把 revision 恰好加一。活动任务继续使用冻结快照，关闭 Agent 或个人记忆触发对应取消；provider 参数只来自 main-only 配置表，不接受 renderer URL/model |
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

候选必须是上述闭合原子结构，包含稳定 `semanticKey`、范围、来源性质、对象型 `content`、至少一个 `EventRange`、置信档与显著性档。`salienceBand=low` 的候选和 `origin=automatic && confidenceBand=low` 的推断直接丢弃；冻结字幕快照没有用户身份事实，因此 `memory-extraction` 返回的全局 `preference` 无论标成 `explicit` 还是 `automatic` 都不得写入。模型只能提出候选；宿主决定去重、冲突、revision、suppression 和当前投影。全局偏好以后只能由独立的用户明确确认入口建立，不能复用模型候选提交端口。

## 7. 资源与设置变化

- 本地 Agent job 只在无活动字幕会话时领取。活动字幕会话开始后，正在执行的本地 job 有界取消并进入可重试状态；云端 Agent job 可以继续。
- Agent 总开关首次默认为关闭；个人记忆开关仍按 SEM-F26 默认为开启，但只在 Agent 总开关开启且处理资格为 `ready` 时生效。关闭 Agent 后不再创建或领取任务，queued/retry_wait job 取消，running job 请求取消并拒绝迟到提交；既有产物和个人记忆保留在本地。
- 实现正式 Agent 设置时把当前平面 `ConfigStore` 从 schema v1 迁移到 v2，增加 exact 平面字段 `agentEnabled`、`automaticProcessingSince`、`memoryEnabled`、`memoryProcessingSince`、`cloudDisclosureAccepted` 与 `agentSettingsRevision`，迁移保留现有字幕设置。Agent 首次为关闭，两个边界为 `null`，个人记忆开关为开启，云端披露未确认；非法 Agent 字段组合统一回落到 Agent 关闭、两个边界为 `null`、披露未确认。每次更新在同一次原子读改写内核对 `expectedRevision`、归一化六个字段并把 revision 恰好加一，冲突时返回 `SETTINGS_REVISION_CONFLICT` 且零写入。renderer patch 只允许三个布尔设置和 expected revision，不得写 provider、URL、model 或凭据。
- `DEEPSEEK_API_KEY` 只在正式 main 最早的同步启动阶段读取一次；取得 raw 值后先无条件从 `process.env` 删除，再校验并只复制合法值，且该顺序早于任何窗口、preload、renderer、worker、child 或 utility 创建。所有子进程环境显式排除该变量。只有 Agent utility 的当前调用接收私有有界副本；单次调用结束时清零副本，Agent utility 异常退出、稳定鉴权失败或应用退出时清零主进程副本并要求重启。运行中后来设置环境变量不生效，现有 job 保持冻结 provider/model，不静默切换。
- 初版网络适配器只向 `https://api.deepseek.com` 的受控路径发送 Authorization 并拒绝 redirect；配置表任一 host/scheme/port/user-info/path 基准漂移都 fail closed 为 `provider_not_configured`。
- 自动对账不处理 `automaticProcessingSince` 之前的终态会话；更早会话只能由用户从历史明确请求。
- Agent 模型 provider、模型和 recipe 在 job 创建时冻结。设置更新只影响新 job，不修改运行中或历史 job。
- 个人记忆开关关闭时，queued/retry_wait 的 memory job 取消，running memory job 请求取消并拒绝迟到提交；纪要和增强文本不受影响。重新开启只为新个人记忆自动处理边界之后结束的会话创建自动记忆任务，不复活已取消任务，也不补处理关闭期间会话；历史中的用户明确请求仍可重新提取。
- 会话删除优先于任何迟到 Agent 提交；删除后的终态会话不能被 reconciliation 再次发现。
- 应用退出先停止接单，再取消当前 Loop、持久化权威状态、关闭 Agent utility 与 storage utility；下一次启动对账恢复同一 `runId`。

## 8. 验收映射

- J13：端口白名单、插件异常/卸载/重复触发与越权。
- J20：识别 provider registry、确认关键词与会话冻结；正式 Agent 模型 provider 的配置、凭据、冻结和降级由 J7/J13/J21/J22/J24 覆盖，真实 DeepSeek 公网后置。
- J21：三项后台 Agent 任务、产物、个人记忆及设置/历史真实链路。
- J22：正式调试聊天、执行预览、确认和固定业务工具。
- J24：空/短/长输入、重复动作、丢失响应、退出恢复、删除、资源仲裁、隐私与可访问状态组合。
- SEM-T15：只有上述旅程在真实内部模块上闭合后，正式 Agent 首版才能提高验收状态。
