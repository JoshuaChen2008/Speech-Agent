## Context

S1 已经建立新的 `src/agent/**` 方向、个人上下文模块与 `provider_not_configured` 的保守产品基线，但正式 Agent 还没有新的模型配置事实、凭据入口、用途解析或不可变模型运行绑定。旧实现中的单一 DeepSeek catalog、启动环境凭据、`DEEPSEEK_API_KEY` 产品入口和旧 provider registry 只可作为可靠性迁移素材，不能继续定义 S2。

本 change 受以下权威边界约束：

- 字幕系统必须在 Agent 系统不存在、配置错误、鉴权失败、网络失败或 worker 退出时继续独立工作（SEM-F00、SEM-F09）。
- Agent 模型 provider 与识别 provider 完全分离；DeepSeek 只提供一个可修改的 OpenAI-compatible provider 模板，不冻结具体 model，也不是产品绑定（SEM-F25 的预置档案方向由本轮负责人决定进一步收紧）。
- Agent 模型接入层统一拥有非敏感配置档案、模型清单、凭据槽、四个模型用途和模型运行绑定，对正式调用者只暴露三类能力。项目负责人本轮进一步决定删除当前 SEM-F33/J25/ADR 0014 中的价格目录与费用金额，只保留 token 与缓存命中率；实施前必须先同步这些权威文档。
- ConfigStore 继续只拥有 Agent 总开关、个人记忆开关、两个自动处理边界、云端披露与 `agentSettingsRevision` 等产品偏好。它不得保存或修改 profile、origin、base path、model、凭据、用途指派或模型运行绑定。
- S2 只闭合 J25 的 S2 Core 子边界；正式 settings renderer、真实 preload 往返和用户主动换模型后的交互历史比较延后到 S5-Integration。S2 即使三条 lane 均返回 0，状态上限仍是「实现完成·尚未验收」。
- 本 change 只写 OpenSpec 产物，不修改 `src/**`、`test/**`、migration、main/preload 或 renderer 产品代码。

## Goals / Non-Goals

**Goals:**

- 冻结 main-owned `catalog()`、`configure(command)`、`bind(runRequest)` 三接口，以及 renderer-facing exact IPC 的边界。
- 冻结九条配置命令、统一 `expectedRevision`、零写入失败与两个 `MODEL_CONFIG_*` 配置错误码。
- 冻结多配置档案、每档案多 model、四个模型用途、显式回落默认、六字段能力与不可变模型运行绑定。
- 冻结 v6 的四表关系、revision 模型、档案删除、凭据槽删除及既有模型运行绑定的复现语义。
- 冻结每档案 `safeStorage` vault、`persistent/session_only/absent` 公开状态、稳定鉴权失败失效和明文隔离。
- 冻结 exact HTTPS origin、base path、redirect 拒绝、loopback `providerKind` 推导、环境净化与 `envApiKeyAuth()` 禁止规则。
- 冻结 input/output token、用量来源、provider 明确返回的 cache-hit/cache-miss input token 与缓存命中率派生规则；明确不设计价格目录、单价覆盖、pricing revision、费用估算或金额展示。
- 冻结首次初始化时的 DeepSeek provider 模板；它只减少填写 API base URL 的步骤，具体 model、六字段能力、用途和凭据全部由用户确认，且绝不构成运行中 provider/model 自动 fallback。
- 冻结脱敏公开 snapshot、版本化 contract、单调 revision、changed invalidation、renderer reload 和 UI/UX fixture 门槛。
- 定义 S2 如何提供非敏感 readiness 事实，以及如何只验证 bind 本身而不提前实现 S3 固定 recipe 运行时。
- 以一个 seam 一个 tracer bullet 的方式安排后续 red → green → 定向回归，并登记 core/integration/evidence 三条 lane 与 J25 S2 Core 子边界。

**Non-Goals:**

- 不实现正式 settings renderer、Agent Bar、交互历史、用量展示或单交互导出。
- 不实现 S3 的正式 recipe 执行、模型推理或结果持久化，也不实现 S4 Agent Loop 与工具；token/缓存用量在 S2 只冻结下游合同，正式持久化与展示留给 S3/S5。
- 不发起真实公网请求或真实模型推理；远端目录与 adapter 协议只经测试专用 `fauxProvider()` 验证。
- 不引入 Gemini、Anthropic 或第二种原生协议 adapter，不提供动态第三方 adapter 注册。
- 不把 Pi 的设置文件、home-dir、OAuth、`auth.json`、`models.json`、环境凭据发现或交互式设置搬进产品。
- 不修改 ConfigStore v2 的六个 Agent 产品偏好字段，也不把模型接入事实双写进 ConfigStore。
- 不修改正式 migration v1–v5 或其 checksum；S2 后续实施只允许追加 v6。

## Decisions

### 1. ConfigStore 与 Agent 模型接入层是两个事实域

ConfigStore 只回答“产品是否允许 Agent/个人记忆、自动处理从何时生效、云端披露是否已接受”。Agent 模型接入层只回答“有哪些档案与模型、凭据是否可借用、各用途解析到什么、某次运行冻结了什么”。两者通过资格组合器组合，不互相存储字段，也不共享 revision。

| 事实 | 唯一 owner | revision |
|---|---|---|
| `agentEnabled`、`memoryEnabled`、两个自动处理边界、`cloudDisclosureAccepted` | ConfigStore | `agentSettingsRevision` |
| profile、连接、model、六字段能力、用途指派 | Agent 模型接入层 / SQLite v6 | `configurationRevision`、`profileRevision`、`catalogRevision` |
| 凭据密文或会话内明文 | main-owned credential vault | 只通过槽状态参与 `configurationRevision`；不进入 ConfigStore/SQLite 明文字段 |
| 某次运行的模型身份、能力、预算与凭据槽 ID | Agent 模型接入层 / `agent_model_run_bindings` | 写入后不可改写 |

资格组合器同时读取 ConfigStore 当前产品偏好和 `catalog()` 的非敏感 readiness 投影。它不得让 renderer、插件或 provider 覆盖任一事实。

### 2. 深模块公开接口恰好为 `catalog/configure/bind`

正式导出面固定为：

```text
catalog() -> ModelAccessCatalog
configure(command) -> ModelConfigureResult
bind(runRequest) -> ModelRunBinding
```

- `catalog()` 是纯读：不得访问网络、刷新远端目录、解密或借出凭据，也不得推进任何 revision。
- `configure(command)` 是唯一配置写入口，命令闭集恰好九条。任何配置、vault 或 revision 失败都返回零写入结果。
- `bind(runRequest)` 只由 Agent 执行宿主在运行创建期调用一次。它解析并原子写入一个 `runId` 的绑定；同 `runId` 再次绑定只能返回逐字段相同的既有行，否则 fail closed。

`agent-model:pull-remote-catalog` 不构成第四个模型接入层接口。它是 main-owned application adapter `RemoteModelCatalogPullController`：

1. 经 `catalog()` 取得当前非敏感 profile 投影并校验 `expectedRevision`；
2. 通过同一包内未导出的 credential-borrow port 借用该 profile 的一次性凭据副本；
3. 通过固定 OpenAI-compatible adapter 请求建议；
4. 返回瞬时建议列表，绝不写配置、不推进 revision、不发 `changed`；
5. 只有用户随后提交九命令中的 `addModel` / `updateModel`，建议才成为配置事实。

recipe、Agent utility 与 renderer 都不能取得 `RemoteModelCatalogPullController` 的内部 port。renderer 只能经已登记的 settings IPC 动作触发它。

### 3. `configurationRevision` 是所有配置命令的统一乐观锁

九条命令全部携带一个顶层整数 `expectedRevision`，其含义固定为调用者最后观察到的 `configurationRevision`，不是 ConfigStore revision、profile revision 或 catalog revision。成功命令在一个逻辑事务内把 `configurationRevision` 恰好加一；失败保持所有 revision 不变。

为保持 v6 只有权威文档列出的四张表，`agent_model_purpose_assignments` 在 migration v6 初始化时建立且始终保留四个用途行。每行保存相同的 `configuration_revision`；任何成功配置事务同时把四行更新为同一个新值。约束测试必须证明四行 revision 始终相等。这样即使最后一个 profile 被删除，公开 revision 也不会丢失或倒退。

其它 revision 的职责：

- `profileRevision`：profile 的非敏感连接、model 清单或凭据状态发生成功修改时推进；用途指派变化不推进无关 profile。
- `catalogRevision`：只有用户通过 `addModel`、`updateModel`、`removeModel` 实际改变该 profile 的 model 清单或能力时推进。远端拉取成功但用户未采纳不推进。
- `configurationRevision`：任一九命令成功，或稳定鉴权失败导致凭据公开状态从 present 变为 absent 时均推进，供 IPC snapshot、changed 事件和全部 `expectedRevision` 使用。后者是 main-owned 内部 vault 状态转换，不是第十条 configure 命令。

`createProfile` 建立初始 `profileRevision=1`、`catalogRevision=0`；后续 revision 只增不减，不因删除重用旧 revision。profile ID 即使以后允许复用，也必须生成新的不可预测 `credentialSlotId`，旧绑定绝不能借到新 profile 的凭据。

### 4. 九条 `configure()` 命令使用 exact schema

所有命令都使用 exact object，拒绝额外键、缺键、错误类型和未登记枚举。adapter 与 API 风格首版固定为内部常量，renderer 不得提交。

| `type` | exact 业务字段（另含 `expectedRevision`） | 成功影响 |
|---|---|---|
| `createProfile` | `profileId, label, httpsOrigin, basePath` | 建空 model 清单、独立槽 ID；推进全局 revision |
| `updateProfile` | `profileId, label, httpsOrigin, basePath` | 更新用户定义的 API base URL；推进 profile/global revision |
| `deleteProfile` | `profileId` | 删除 live profile、model、用途直接指派与 live 凭据槽；既有 run binding 不变 |
| `addModel` | `profileId, modelId, capabilities` | 新增精确二元组；推进 profile/catalog/global revision |
| `updateModel` | `profileId, modelId, capabilities` | 替换该 model 的已登记能力；推进 profile/catalog/global revision |
| `removeModel` | `profileId, modelId` | 删除 live model，清除指向它的直接用途；推进 profile/catalog/global revision |
| `setCredential` | `profileId, credential` | 写入该 profile 独立槽；推进 profile/global revision；结果不回显明文 |
| `clearCredential` | `profileId` | 清除该槽并投影 `absent`；推进 profile/global revision |
| `assignPurpose` | `purpose, target`，其中 target 为 exact `{profileId, modelId}` 或 `null` | 设置直接指派或清空；推进 global revision |

四个 `purpose` exact 值固定为 `default`、`information_extraction`、`summary`、`analysis_planning`。renderer 文案仍使用“默认、信息提取、摘要与总结、分析与规划”，不得展示内部值。

命令失败码只允许：

- `MODEL_CONFIG_INVALID`：schema、ID、连接、能力、用途目标、vault、删除约束或其它配置不变量失败。
- `MODEL_CONFIG_REVISION_CONFLICT`：`expectedRevision !== configurationRevision`。

结果可附带非敏感的 `nextAction: 'correct_input' | 'reload'`，但不得附带 raw Error、safeStorage 错误、SQL、URL 解析轨迹、redirect location、header、stack 或凭据片段。两个错误码独立于 `AGENT_*` 任务错误码。

### 5. v6 四表保存 live 配置与不可变绑定

#### `agent_model_profiles`

保存 `profile_id`、`profile_revision`、label、不可由 renderer 写入的可空 `template_id`、固定 adapter/API style、canonical `https_origin`、`base_path`、`catalog_revision`、不可预测 `credential_slot_id` 与非敏感凭据状态。表内没有 API key、header、环境变量名或 provider SDK 配置。

#### `agent_model_profile_models`

以 `(profile_id, model_id)` 为主键/唯一键，保存 exact 六字段 `capability_json`。profile 删除级联删除 live model；model ID 只在同一 profile 内唯一。v6 不建立 price、cost、currency、pricing override 或 pricing revision 字段。

#### `agent_model_purpose_assignments`

始终有四行。每行保存 purpose、可空 `(profile_id, model_id)`、指派时 profile revision 事实、全局 `configuration_revision` 和更新时间。删除 profile/model 时受影响用途清为空：专用用途随后显式回落默认；默认清空则变为未配置。

#### `agent_model_run_bindings`

以 `run_id` 为唯一身份并外键指向 v5 `formal_agent_runs`。绑定冻结 purpose、是否回落、profile ID/revision、固定 adapter/API style、exact origin/base path、model ID、六字段能力、十轴预算、providerKind、credential slot ID 与创建时刻。禁止 UPDATE/replace；只允许随 owning formal run 的显式生命周期删除，profile/model 删除不得级联到绑定。绑定不含 price、cost、currency 或 pricing revision。

profile 删除后的关系固定为：

- live profile、live model、用途直接指派与 live credential slot 被删除；未来 `catalog()`/`bind()` 不再解析到它。
- 既有 `agent_model_run_bindings` 继续保留完整非敏感模型身份、能力、预算与 providerKind，可用于历史、导出和比较。
- 因 live credential slot 已不存在，既有未终态运行若再次请求凭据，稳定收束为 `AGENT_PROVIDER_AUTH_FAILED` 且不重试；不得借用后来新建 profile 的凭据。
- “可复现”在此表示模型身份和绑定事实可重读，不承诺已删除凭据后仍能再次调用 provider。

### 6. vault 使用按 profile 的 prepare/commit/rollback 协议

`safeStorage` 只负责加密/解密，不被当作数据库。main-owned vault 使用独立于 SQLite 的受控文件，并以 `credentialSlotId` 定位；磁盘只出现 `safeStorage` 密文和不含凭据的元数据。`session_only` 只存在当前 main 进程内存，零落盘。

为了满足配置失败零写入与 profile 删除逻辑原子性，credential vault 必须提供 prepare/commit/rollback/recover：

- `setCredential` 先准备新的密文 generation；SQLite 配置事务成功前旧 generation 仍是权威；任何失败回滚准备文件。
- `clearCredential` / `deleteProfile` 先把旧槽移动到不可借用的 quarantine generation，SQLite 事务失败时恢复，成功后擦除；启动恢复只根据非敏感 journal 和 SQLite 已提交事实决定恢复或擦除。
- journal 只含 slot ID、operation ID、generation 与阶段，不含 profile label、origin、credential、header、路径投影或 raw Error。
- 命令只有在 vault 与 SQLite 都已进入可恢复一致状态后才返回成功并广播 `changed`。

公开凭据状态 exact 为：

- `{ present: false, scope: 'absent' }`
- `{ present: true, scope: 'persistent' }`
- `{ present: true, scope: 'session_only' }`

`safeStorage` 不可用时 `setCredential` 可以在本次 main 会话内成功为 `session_only`；应用重启后内存槽消失，公开状态必须是 `absent`，不得从 SQLite 的旧状态伪造 present。

HTTP 401/403 或 adapter 明确归类的稳定鉴权拒绝使**该 profile 槽**失效并清除；该 main-owned 内部状态转换推进该 profile revision 与 `configurationRevision`、发布 `changed`，但不扩张九命令闭集。408、429、网络错误、5xx、取消、预算耗尽、输出 Schema 失败和 worker 退出不得误清凭据。Agent utility 只得到一次调用的有界副本，成功、失败、取消、超时或退出后均尽力 `fill(0)`。

### 7. 连接 canonicalization 与网络边界 fail closed

profile 连接由 renderer 提交且公开回读的字段只有：

- `httpsOrigin`：必须解析为 `https:`，只含 scheme + host + 可选 port；拒绝 userinfo、query、fragment 与 origin path。保存 URL parser canonical origin。
- `basePath`：普通新档案默认 `/v1`，用户可编辑；必须是以 `/` 开头、不含 query、fragment 或 `..` path segment 的绝对路径。它与 `httpsOrigin` 共同表达用户定义的 API base URL；OpenAI-compatible Chat Completions 的固定 endpoint segment 仍由 adapter 拥有，不由 renderer 提交。

renderer 不提交 adapter、API style、providerKind、header、credentialSlotId、redirect policy、请求 endpoint 或 timeout。公开 snapshot 可以回显 canonical `httpsOrigin` 与 `basePath` 供用户编辑，但隐藏 canonicalization 中间值、DNS/IP 解析、allowlist predicate、adapter factory 与 auth header 形状。

固定 OpenAI-compatible adapter 只向 safe-join 后的 `httpsOrigin + basePath + '/chat/completions'` 发模型请求，并向对应 models endpoint 拉取目录建议；它关闭自动 redirect，任何 3xx 都拒绝，不能跟随到同 origin 或不同 origin。响应中出现的 provider URL 也不能改写受信任 origin。这样用户可以配置 `https://host`、`https://host/v1` 或其它 OpenAI-compatible base path，而 recipe/utility 仍不能自行拼 URL。

`providerKind` 只由 canonical hostname 是否为 loopback 推导：`localhost`、IPv4 `127.0.0.0/8` 和 IPv6 `::1` 为 `local`，其它为 `cloud`。它随绑定冻结；厂商名、profile label、model ID 或端口都不能影响分类。

启动时对环境执行纯净化：大小写不敏感等价于 `DEEPSEEK_API_KEY` 的所有键无条件删除，child environment 只从净化快照复制。环境、argv、Pi home-dir 和 `envApiKeyAuth()` 永远不是凭据来源；运行中注入环境不能改变 catalog/readiness/bind。

### 8. DeepSeek 只提供 provider 模板，model 与能力由用户定义

首次建立 v6 模型接入事实时，系统一次性写入 `deepseek-openai-template@1`：

- 稳定 `profileId='deepseek'`、可展示 label、内部固定 OpenAI-compatible adapter/API style；
- 官方当前 OpenAI base URL `https://api.deepseek.com` 被规范化为 `httpsOrigin='https://api.deepseek.com'` 与 `basePath='/'`；固定 Chat Completions endpoint segment 为 `/chat/completions`，最终请求是 `httpsOrigin + basePath + endpointSegment`；
- model 清单为空、四个用途全部没有直接指派、credential 为 `{ present:false, scope:'absent' }`；因此全部 readiness 为 `provider_not_configured`，不是 `credential_unavailable` 或 `ready`；
- 用户可以修改 label、origin 与 base path，以支持 DeepSeek-compatible gateway 或未来端点变化；exact HTTPS origin、base path、redirect 拒绝与 loopback 推导规则保持不变。

模板不写入 `deepseek-v4-flash` 或任何其它 model。DeepSeek 官方文档当前列出 `deepseek-v4-flash`、`deepseek-v4-pro` 与实验 vision model，其中稳定别名会指向持续更新的后端版本；因此当前 model ID 只能进入用户触发的目录建议。用户必须通过 `addModel` 明确提交 model ID 与六字段能力，再通过 `assignPurpose` 指派用途并通过 `setCredential` 写入凭据，之后才可能形成 readiness/binding。

模板身份由 profile 行上不可由 renderer 写入的可空 `template_id` 标记；普通 `createProfile` 不能伪造。显式删除后系统不得在重启或 catalog 读取时静默重建；只有首次 v6 初始化播种一次。模板也不允许同一 `runId` 在失败时自动改用 DeepSeek；运行选择仍只服从已冻结用途与模型运行绑定。

版本化的 `deepseek-openai-template@1` 还可向 UI 提供**非权威能力建议**，但不能写入 model 行：

- 官方当前模型文档支持 JSON Output、Tool Calls、streaming，并从 API response 的 `usage` 提供 token 使用事实，所以相应布尔建议为 `true`；
- 官方当前页面以 `1M` context 与 `384K` max output 展示上界，但未给出可直接写入 exact integer 字段的数值定义，且 context 是输入与输出总上限，因此 `maxInputTokens` / `maxOutputTokens` 建议保持 `null`，必须由用户确认 exact 正整数；
- `deepseek-v4-flash` 可作为当前目录建议的 model ID 初值，但用户必须明确采纳，未来模型名变化不修改模板身份或静默改写既有 model。

### 9. 六字段能力与用途回落是显式事实

每个 model 的能力恰好为：

```text
maxInputTokens: positive integer
maxOutputTokens: positive integer
supportsToolCalling: boolean
supportsStructuredOutput: boolean
supportsStreaming: boolean
usageReporting: boolean
```

写入 model 行的能力只来自用户明确提交的六字段 exact 值。随应用发布的 provider 模板或用户触发的远端目录可以返回 `capabilitySuggestion`，但建议不是配置事实：每个字段可为具体建议值或 `null`，并带 `source='official_docs' | 'remote_catalog'` 与版本/抓取日期元数据。renderer 在调用 `addModel` 前必须要求用户确认并补齐全部六字段；Core 不从 model 名、厂商名或响应特征猜测，也不把建议自动落库。

DeepSeek 模板 v1 的官方文档建议为：`supportsToolCalling=true`、`supportsStructuredOutput=true`、`supportsStreaming=true`、`usageReporting=true`；`maxInputTokens=null`、`maxOutputTokens=null`，因为当前公开页面只给出缩写上界且没有为两个 exact 字段提供无歧义整数语义。用户仍可按其实际 model 与 provider 文档改写全部建议值。

模板建议元数据固定为 `{ templateVersion: 1, source: 'official_docs', sourceSnapshotDate: '2026-08-30' }`。依据仅来自 DeepSeek 官方文档：[Your First API Call](https://api-docs.deepseek.com/)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)、[Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)、[Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) 与 [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。未来官方事实变化必须发布新的 template/suggestion version；不得原地改写 `deepseek-openai-template@1`、已保存 model 或既有模型运行绑定。

用途解析固定为：专用用途有直接指派就使用它；专用用途为空时解析默认用途；默认也为空、目标不存在、凭据 absent、连接不合法或所需能力不满足时为未配置。公开投影必须标注 `assignmentMode: 'direct' | 'fallback_default' | 'unconfigured'`，不能把回落显示成单独配置。

只有 `supportsToolCalling` 是绑定硬条件，且只在 `executionForm='agent_loop'` 时要求为 true。single-shot 不因 `supportsStructuredOutput=false` 被拒绝；执行宿主仍负责结果 Schema 校验并在以后 S3 收束为 `AGENT_OUTPUT_INVALID`。首版不依赖 streaming。

### 10. `bind(runRequest)` 固定解析顺序并可在 S2 独立验证

`runRequest` exact 只含：

```text
runId
recipeId
recipeVersion
executionForm: 'single_shot' | 'agent_loop'
```

它不得含 profile、model、purpose、origin、base path、header、预算或凭据。接入层经项目自有、静态、不可由 renderer/provider 修改的 recipe-to-purpose policy 解析：

1. recipe identity/version 必须已登记；
2. 映射到一个模型用途；
3. 读取用途直接指派；
4. 必要时显式回落默认；
5. 解析 live profile 与 exact model；
6. 校验六字段能力与 execution form；
7. 从唯一十轴预算定义点推导并裁剪预算；
8. 解析非敏感 credential slot 状态；
9. 与 v5 `formal_agent_runs` 在同一 storage transaction 写入一行不可变 binding。

任一步失败都不执行后续步骤、不借出凭据、不写 binding。资格阶段把配置/能力不足投影为 `provider_not_configured`；若调用者绕过资格直接 bind，则返回 `AGENT_REQUEST_INVALID`。凭据不存在使用 `credential_unavailable` readiness；已有绑定的槽后来被删或稳定鉴权失效，运行阶段收束为 `AGENT_PROVIDER_AUTH_FAILED`。这些情况都不得变成 `AGENT_PROVIDER_UNAVAILABLE`。

S2 不实现正式 recipe runtime。bind 的确定性联合验证使用 S1 已登记的真实 `context.ingest.session` recipe identity 与项目自有静态映射，将其映射到“信息提取”并以 `single_shot` 验证一个已经存在的真实 v5 formal run，再在同一 SQLite 事务内插入或重放唯一 v6 binding；四字段 `runRequest` 不扩张为 run 创建载荷。测试只断言绑定解析、原子写入、重放和失败零写入，不调用模型、不创建 interaction/result，也不把该测试称为 J21/J22/J24。Agent Loop 的完整 recipe/工具组合延后到 S4；S2 core 只对 bind 的纯能力守卫做局部穷举。

### 11. readiness 作为 `catalog()` 的非敏感派生事实

为避免增加第四接口，`catalog()` 同时返回配置公开投影和按用途派生的 readiness：

```text
readinessByPurpose[purpose] = {
  assignmentMode,
  providerKind: 'cloud' | 'local' | null,
  singleShot: 'ready' | 'provider_not_configured' | 'credential_unavailable',
  agentLoop: 'ready' | 'provider_not_configured' | 'credential_unavailable'
}
```

readiness 只基于当前已提交配置、六字段能力和凭据存在性元数据，不解密凭据、不发网络、不探测 provider。`ready` 只表示接入层配置足以建立相应用途/执行形态的未来绑定，不表示公网可达、鉴权真实成功、模型推理成功或完整 Agent 处理资格为 ready。

Agent 处理资格组合器再与 ConfigStore 的 Agent 总开关、自动处理边界、云端披露及其它会话事实按既有优先级组合。对 `context.ingest.session`，它读取 `information_extraction.singleShot`；任何缺失都保持 `provider_not_configured` 或 `credential_unavailable`，不得由 IPC 成功、fixture、`fauxProvider()` 注册或测试参数覆盖为 ready。

### 12. 只保留 token 与缓存命中事实，不计算价格金额

S2 冻结供 S3/S5 消费的 `ModelUsageV1`，不在 v6 模型配置表或模型运行绑定中保存运行用量：

```text
inputTokens: non-negative integer
outputTokens: non-negative integer
usageSource: 'provider' | 'estimated'
cacheHitInputTokens: non-negative integer | null
cacheMissInputTokens: non-negative integer | null
```

- provider 返回可信 exact usage 时，adapter 保存规范化 input/output token，`usageSource='provider'`。
- provider 没有返回 input/output token，或模型能力声明 `usageReporting=false` 时，后续运行层可按权威文档登记的确定性规则估算，并标记 `usageSource='estimated'`；估算值不得伪装成 provider 返回。
- 两个缓存字段只接受 provider 明确返回的缓存 input token，绝不估算。DeepSeek adapter 分别映射官方 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。
- 缓存命中率是展示层派生值，不单独持久化：只有 `usageSource='provider'`、两个缓存字段都是非负整数、两者之和大于零且 `cacheHitInputTokens + cacheMissInputTokens === inputTokens` 时，`cacheHitRate = cacheHitInputTokens / (cacheHitInputTokens + cacheMissInputTokens)`；其它情况为 `null`，界面显示未知而不是 0%。
- 若 provider 任一缓存字段缺失、类型错误、总和为零或与 input token 不一致，不影响已验证的模型内容结果，但两个缓存事实与命中率一并 fail closed 为 `null`，并只发布不含原始响应的受限诊断。

产品不建立 price、cost、currency、pricing catalog、pricing override、pricing revision 或费用估算字段；settings catalog、模型运行绑定、交互历史与导出都不得展示金额。模型比较只使用模型运行身份、input/output token、用量来源、缓存命中率和相对时长。S2 只冻结该合同与 `fauxProvider()` 场景；正式运行用量持久化由 S3，renderer 展示由 S5-Integration 完成。

### 13. exact IPC、公开投影与 renderer reload

首个 renderer-facing contract 固定为 `contractId='agent-model-ui'`、`contractVersion='1.0.0'`。已签发版本不得原地修改；breaking/additive/metadata-only 变化分别发布新的 major/minor/patch fixture 目录。

频道与权限：

| channel | sender | exact request | exact result/event |
|---|---|---|---|
| `agent-model:get-catalog` | `settings` | `{ contractId, contractVersion }` | `{ ok, snapshot, error }`；读取/初始化降级只用 `MODEL_ACCESS_UNAVAILABLE` |
| `agent-model:configure` | `settings` | `{ contractId, contractVersion, command }` | success/revision 或两个 `MODEL_CONFIG_*` 结果 |
| `agent-model:pull-remote-catalog` | `settings` | `{ contractId, contractVersion, profileId, expectedRevision }` | 瞬时 suggestions 或受限失败状态；永不写配置 |
| `agent-model:changed` | main → `settings` | 无 renderer request | `{ contractId, contractVersion, revision }` invalidation event |

公开 `CatalogSnapshotV1` 包含：

- `revision`；
- profile 的 `profileId/label/profileRevision/catalogRevision/httpsOrigin/basePath`；
- model ID 与六字段能力；
- credential `{present, scope}`；
- 四用途的 direct/fallback/unconfigured 解析与非敏感 readiness；
- DeepSeek provider 模板标记与官方文档建议版本只作为展示事实，不构成 model、用途或独立产品入口。

公开投影隐藏：adapter/API style 内部常量、provider factory、credentialSlotId、密文/明文/header、SQL identity、vault generation/journal、URL canonicalization 轨迹、redirect location、raw HTTP/provider 错误、stack、内部 recipe ID 映射与十轴预算数值来源。catalog 不包含每次运行的 token 或缓存命中率；这些事实属于后续交互投影。

reload 固定流程为“先订阅 changed，再 get-catalog”。renderer 只接受 revision 大于当前值的事件；收到新 revision 后重新读取 snapshot，拒绝旧 snapshot。configure 成功只表示命令已提交；renderer 仍以返回 revision 或后续权威 snapshot 呈现成功，不能从等待时长或本地 optimistic state 推断。pull suggestions 是瞬时 UI 状态，reload 后消失并重新由用户触发，不能进入 catalog snapshot。

### 14. 远端目录建议只走显式用户动作

`pull-remote-catalog` 只读取当前 profile 的 canonical connection 与一次凭据副本，调用 OpenAI-compatible models endpoint；它不调用模型推理 endpoint。公开状态闭集固定为 `success`、`revision_conflict`、`invalid_request`、`credential_unavailable`、`redirect_rejected`、`remote_unavailable`。任何 redirect、非 exact response、超预算建议数、重复/空 model ID、凭据 absent 或外部失败都返回零建议/受限失败结果，配置、vault 和全部 revision 不变。

建议项 exact 为 `modelId` 加可空 `capabilitySuggestion`。远端响应本身不能被当作六字段能力事实；DeepSeek 模板可把官方当前 model alias 与官方文档能力建议合并为瞬时建议，但用户必须确认 model ID 并补齐六字段后，再通过九命令采纳。每个采纳事务独立受 `expectedRevision` 守卫。

### 15. `fauxProvider()` 只存在于测试构建

生产 OpenAI-compatible registry 是闭合、只读的项目自有 registry，没有 `registerAdapter()`、插件 hook、duck typing 或运行时动态加载路径。`fauxProvider()` 位于 test-only 构建入口，提供：

- exact models 建议响应；
- redirect 响应；
- 401/403 稳定鉴权失败；
- 408/429/网络/5xx 非失效失败；
- 原始 input/output usage、cached input token 的合法/缺失/不一致响应；
- 调用 barrier 与凭据副本清零观察。

S2 测试经由真实 catalog/configure/bind/controller/vault/storage 路径抵达该外部边界，不允许测试直接写 binding、提交产物或伪造 readiness。生产 package/module graph 必须证明 test-only factory 不可达；测试不以源码关键词正则代替可达性证明。

## Risks / Trade-offs

- **[SQLite 与 safeStorage vault 不是同一事务介质]** → 使用 prepare/commit/rollback/recover 和非敏感 journal；命令回执与 changed 只在可恢复一致点之后发布，启动先收束未完成 vault operation 再开放 catalog/configure/bind。
- **[全局 revision 被最后一个 profile 删除带走]** → 由始终存在的四个 purpose 行共同保存同一 `configurationRevision`，并用 CHECK/行为测试守住相等不变量。
- **[档案删除后同 ID 重建导致旧绑定借错凭据]** → credential slot ID 不可预测且不复用；旧 binding 只引用旧槽，槽不存在即稳定鉴权失败。
- **[公开 snapshot 泄露内部安全细节]** → renderer 只取得用户输入的连接字段、能力、用途、凭据布尔/scope 与粗粒度 readiness；vault、header、slot、redirect、raw HTTP 与内部校验原因不投影。
- **[readiness 被误解为公网/模型已验证]** → 名称与 contract 明确为配置充分性事实；不得网络探测，完整 Agent 处理资格仍由组合器决定。
- **[S2 bind 测试误冒充 S3 运行]** → 只使用真实 v5 run identity 和 v6 binding，不调用 provider inference、不写 interaction/result、不晋级 J22/J24。
- **[远端 models 响应缺少能力]** → suggestions 允许 capabilitySuggestion 的任意字段为 null；采纳前必须由用户明确确认并补齐六字段，Core 零猜测。
- **[fixture 被当成 J25 证据]** → fixture 固定 `previewOnly=true`，不进入 `.artifacts/`、`docs/validation/` 或旅程报告；J25 只由真实内部模块联合测试登记 S2 Core 子边界。
- **[配置变化影响活动运行]** → binding 写入后不可改写；配置只影响未来 bind，自动重试复用同一 run/binding。
- **[缓存命中率被误报为 0%]** → 只在 provider 明确返回一致的 hit/miss input token 且总和等于 input token 时计算；缺失、估算或不一致一律为 `null`，不猜测、不钳制。
- **[DeepSeek 模板被误解为 model 预置、运行 fallback 或已就绪]** → 模板只在首次 v6 初始化播种空 model 档案与官方 base URL；全部 readiness 保持 `provider_not_configured`，运行失败不切换绑定，用户删除后不静默重建。

## Migration Plan

1. 实施前先把项目负责人本轮决定同步到 SEM-F33、J25/S2 Core、ADR 0014、data architecture、执行计划与 UI/UX handoff：删除价格/费用语义，登记 token/缓存命中事实、用户自定义 API base URL/model/能力与 DeepSeek 空 model provider 模板；随后重新逐字核对 `CONTEXT.md` 及全部相关权威段落。
2. 先冻结版本化 model-access core contract、九命令、六字段能力、四用途、错误码、readiness 与 UI contract/fixture；不接 main/preload/renderer。
3. 在临时 v5 数据库上以 tracer bullet 追加 v6，证明 v1–v5 SQL/checksum 逐字节不变、升级失败保留原库并 fail closed。
4. 逐条实现 storage/configure、vault、catalog/readiness、bind、remote pull application adapter 与 exact IPC；每条都先红测、最小实现、定向回归，再进入下一条。
5. 用真实临时 SQLite、真实 model-access 模块和 test-only `fauxProvider()` 运行 J25 S2 Core 确定性联合子边界；不调用公网和模型推理。
6. 依次运行 `npm run test:core`、`npm run test:integration`、`npm run test:evidence`，并验证字幕 open/append/close/history 路径不加载 model-access store/vault。
7. 只有 S5-Integration 用真实 settings renderer/preload 与交互历史组合后，才可晋级完整 J25；S2 单独交付状态最多为「实现完成·尚未验收」。

数据库回退只允许停止发布并恢复升级前备份；已经发布的 v6 SQL/checksum 不得原地修改或降 `user_version`，修复必须使用后续追加 migration。代码回退可移除 model-access composition，但必须继续识别已发布 v6，不能让字幕系统因 Agent 表存在而失去独立运行能力。

## Open Questions

价格相关待裁定项已由项目负责人收束为“不计算或展示价格金额”，因此全部删除。DeepSeek 模板的播种与删除生命周期也冻结为“首次 v6 初始化播种一次空 model 档案，用户可修改/删除，显式删除后不静默重建”。

DeepSeek provider 模板版本固定为 `deepseek-openai-template@1`。它不需要裁定精确 model ID，也不把六字段建议变成配置事实：当前官方 `deepseek-v4-flash` 只作为瞬时目录建议；四个布尔能力建议来自官方文档，两个 token 上限保持 `null` 并由用户确认。当前无阻断项。

## UI/UX handoff

### 版本化公开 contract

- 首版：`agent-model-ui@1.0.0`。
- 频道：`agent-model:get-catalog`、`agent-model:configure`、`agent-model:pull-remote-catalog`、`agent-model:changed`，只授权 `settings`。
- 初始加载：先订阅 changed，再读取 catalog；只接受单调递增 revision，旧事件/旧 snapshot 丢弃。
- fixture 与生产 request/response/event 使用同一 exact validator；已签发 fixture 目录只读。

### 状态矩阵

UI/UX fixture 至少覆盖：首次初始化 DeepSeek 空 model 模板、官方 base URL、当前 model alias 建议、布尔能力建议与两个 token 上限未知、用户确认自定义 model/能力、显式删除后不重建、空档案、两个以上档案、四用途 direct、专用用途 fallback default、默认未配置、凭据 `persistent/session_only/absent`、重启后 session-only → absent、pending、成功、`MODEL_CONFIG_INVALID`、`MODEL_CONFIG_REVISION_CONFLICT`、目录建议成功、目录失败零写入、redirect 拒绝、能力缺失、credential unavailable、renderer reload、重复/陈旧 changed。运行用量 fixture 另覆盖 provider token + cache hit、provider token 无 cache、estimated token，以及不一致 cache 字段 fail closed 为未知；不包含任何金额字段。

### fixture 清单

- catalog：empty、deepseek-template-empty-models、deepseek-current-alias-suggestion、user-defined-model、multi-profile、four-purpose-direct、fallback-default、unconfigured-default。
- credential：persistent-present、session-only-present、restart-absent、stable-auth-invalidated。
- configure：九命令各一成功、一代表性 invalid、统一 revision conflict、删除档案后旧 binding identity 保留。
- remote catalog：suggestions-known-capabilities、suggestions-capabilities-null、redirect-rejected、credential-unavailable、transport-failed-zero-write。
- bind/readiness：single-shot-ready、agent-loop-capability-mismatch、missing-default、deleted-slot-auth-failure。
- usage（供 S3/S5）：provider-cache-hit、provider-cache-unknown、estimated-cache-unknown、invalid-cache-unknown；只含 token、用量来源和缓存命中派生输入，不含金额。
- privacy：所有 fixture 不含 credential/header/slot ID/raw URL query/redirect location/正文/本地路径/设备名/绝对单调时刻。

所有 preview envelope 必须带 `previewOnly=true`，不能进入 `.artifacts/`、`docs/validation/` 或 J25 证据。

### 未知值 fail-closed

renderer 遇到未知 contract version、purpose、assignment mode、credential scope、readiness、命令结果、remote pull 状态、额外键或缺字段时必须停止该表面的写动作，显示 Core 提供的通用不可操作状态并要求 reload/update；不得根据 ID、异常字符串、等待时长、缺字段或 DOM 状态自行推断。未知能力值不得默认 true，未知 cache token 不得显示为 0% 命中。

### renderer 允许开始的门槛

正式 renderer implementation 只有在以下条件全部成立后才能开始：

1. `agent-model-ui@1.0.0` exact validator、四频道 request/result/event 和所有枚举冻结；
2. 九命令、统一 `expectedRevision`、两个 `MODEL_CONFIG_*` 结果及 next action fixture 冻结；
3. catalog 公开字段、隐藏字段、四用途回落、credential scope、readiness 与 remote suggestions fixture 冻结；
4. 未知值 fail-closed 行为和 reload 协议冻结；
5. DeepSeek provider 模板、官方文档建议字段、用户确认 model/六字段能力的交互，以及 token/缓存用量 contract 已同步到 S3/S5 的消费边界。

在此之前 UI/UX 只能做明确标记的 fixture preview；S5-Integration 之前任何 renderer 截图、局部回归或预览 adapter 都不构成 J25 证据。
