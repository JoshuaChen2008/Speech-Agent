## ADDED Requirements

> 本 delta spec 只细化 S2 的可实施 Core 子边界。权威语义见 `docs/semantic-contract.md` SEM-F00/F09/F15/F25/F28/F33/T15，数据约束见 `docs/data-architecture.md` 的 v6/revision/delete 章节，旅程见 `docs/testing-strategy.md` J25 及其 S2 Core 子边界；冲突时以这些文件为准。

### Requirement: ConfigStore 与 Agent 模型接入层必须保持事实隔离

系统 SHALL 让 ConfigStore 只拥有 Agent 总开关、个人记忆开关、自动处理边界、云端披露与 `agentSettingsRevision` 等产品偏好。Agent 模型接入层 SHALL 独立拥有配置档案、模型清单、凭据槽状态、用途指派、模型配置 revision、目录 revision、readiness 与模型运行绑定。任一层 MUST NOT 把另一层的字段双写、镜像或纳入自身 patch 白名单。

#### Scenario: 通用产品偏好更新

- **WHEN** renderer 通过 ConfigStore 更新 Agent 总开关、个人记忆或云端披露
- **THEN** profile、model、credential、purpose、model configuration revision 与既有模型运行绑定全部不变

#### Scenario: 模型配置命令提交产品偏好字段

- **WHEN** `configure(command)` 收到 `agentEnabled`、`memoryEnabled`、自动处理边界、云端披露或 `agentSettingsRevision`
- **THEN** 系统返回 `MODEL_CONFIG_INVALID`，ConfigStore、模型配置、vault 与 revision 全部零写入

### Requirement: Agent 模型接入层只有三个正式公开接口

Agent 模型接入层 SHALL 只对正式调用者暴露 main-owned `catalog()`、`configure(command)`、`bind(runRequest)`。`catalog()` MUST 是不触发网络、不刷新目录、不解密凭据且不写 revision 的纯读操作；`configure()` MUST 是唯一配置写入口；`bind()` MUST 只在运行创建期由 Agent 执行宿主调用一次。renderer、固定 recipe 与 Agent utility MUST NOT 取得内部 store、vault、adapter registry 或 credential borrow interface。

#### Scenario: 读取公开目录

- **WHEN** main 调用 `catalog()`
- **THEN** 系统只返回当前已提交的脱敏公开投影与非敏感 readiness，不发网络、不借出凭据且不改变任何 revision

#### Scenario: 未授权调用内部能力

- **WHEN** renderer、固定 recipe、Agent utility 或测试替身试图直接访问配置 store、vault、credential borrow port 或动态 adapter 注册
- **THEN** 构建或运行合同 fail closed，且不得把该路径包装成第四个公开接口

### Requirement: configure 命令必须是九条 exact 闭集

`configure(command)` SHALL 恰好支持 `createProfile`、`updateProfile`、`deleteProfile`、`addModel`、`updateModel`、`removeModel`、`setCredential`、`clearCredential`、`assignPurpose` 九条命令。每条命令 MUST 携带顶层整数 `expectedRevision`，并以公开 `configurationRevision` 作为统一乐观锁。成功命令 MUST 把 `configurationRevision` 恰好推进一；任一失败 MUST 保持 SQLite、vault、用途、凭据状态和全部 revision 零写入。

配置失败码 SHALL 只允许 `MODEL_CONFIG_INVALID` 与 `MODEL_CONFIG_REVISION_CONFLICT`，不得复用 `AGENT_*` 任务错误码或 raw Error。首版 adapter 与 API 风格是内部固定事实，renderer MUST NOT 提交。

#### Scenario: 九命令成功推进 revision

- **WHEN** 任一已登记命令通过 exact schema、业务约束、vault 准备与 `expectedRevision` 校验
- **THEN** 系统原子提交该命令影响，把 `configurationRevision` 恰好加一，并返回不含凭据的成功结果

#### Scenario: 陈旧 expectedRevision

- **WHEN** 命令的 `expectedRevision` 不等于当前 `configurationRevision`
- **THEN** 系统返回 `MODEL_CONFIG_REVISION_CONFLICT`，profile、model、purpose、vault 和所有 revision 全部不变

#### Scenario: 载荷带额外键

- **WHEN** 任一命令带有未登记键、错误类型、未知命令、adapter、API style、providerKind、header、credential slot 或 ConfigStore 字段
- **THEN** 系统返回 `MODEL_CONFIG_INVALID` 并保持零写入

### Requirement: 配置档案必须表达受信任连接、独立凭据与一组 model

一个 Agent 模型配置档案 SHALL 由稳定 `profileId`、可展示 label、不可由 renderer 写入的可空 `templateId`、固定内部 adapter/API style、canonical `httpsOrigin`、`basePath`、`profileRevision`、`catalogRevision`、独立 `credentialSlotId` 和一组 model 组成。`(profileId, modelId)` MUST 是精确二元组；两个档案即使 origin 相同也 MUST NOT 共享凭据槽。普通 `createProfile` MUST NOT 伪造 `templateId`。

系统 SHALL 在首次建立 v6 模型接入事实时一次性播种 `deepseek-openai-template@1`：`profileId='deepseek'`、canonical `httpsOrigin='https://api.deepseek.com'`、`basePath='/'`、空 model 清单、四用途全部未指派、credential `absent`。OpenAI-compatible adapter SHALL 固定 safe-join `/chat/completions` endpoint；用户仍可修改 origin/base path，以定义实际 API base URL。

模板 MUST NOT 写入 `deepseek-v4-flash` 或任何具体 model，也不得自动写入六字段能力或用途。官方当前 model alias 与能力只能作为瞬时建议；用户 SHALL 通过 `addModel` 明确提交 model ID 与六字段能力，通过 `assignPurpose` 指派用途并通过 `setCredential` 写入凭据。模板初始全部 readiness MUST 为 `provider_not_configured`。

用户 SHALL 可通过既有九命令修改或删除该模板档案。显式删除后系统 MUST NOT 在重启、catalog 读取或运行失败时静默重建，也 MUST NOT 在同一 `runId` 中自动切换到 DeepSeek。DeepSeek MUST NOT 成为独立产品入口或识别 provider 选择。

#### Scenario: 首次初始化 provider 模板

- **WHEN** 一个尚无 v6 模型接入事实的数据库首次应用 v6
- **THEN** catalog 包含 DeepSeek 空 model 模板与官方 base URL，但没有用途指派、没有凭据、全部 readiness 为 `provider_not_configured`，且零网络请求

#### Scenario: 用户定义当前偏好 model

- **WHEN** 用户选择当前官方 alias `deepseek-v4-flash` 或输入其它未来 model ID，并确认六字段能力
- **THEN** 只有成功 `addModel` 才建立该 model 事实；模板版本、migration 与既有 model 不因官方 alias 后端更新而被静默改写

#### Scenario: 删除模板后重启

- **WHEN** 用户明确删除 DeepSeek 模板档案后重启应用
- **THEN** 系统保留该删除结果，不静默重播种、不改用其它 provider，也不伪造默认用途 ready

#### Scenario: 同一 origin 建立两个档案

- **WHEN** 用户建立两个指向相同 canonical `httpsOrigin` 的档案
- **THEN** 系统为它们分配不同且不可复用的 credential slot，并允许各自保存不同 model 清单与凭据状态

#### Scenario: 重复精确 model

- **WHEN** 同一 profile 再次 `addModel` 相同 `modelId`
- **THEN** 系统返回 `MODEL_CONFIG_INVALID` 且不改变 model 清单、catalog revision 或全局 revision

### Requirement: 四个模型用途必须独立指派并显式回落默认

系统 SHALL 只支持 `default`、`information_extraction`、`summary`、`analysis_planning` 四个模型用途。每个用途 MUST 可独立指派到一个精确 `(profileId, modelId)`。专用用途没有直接指派时 SHALL 回落到默认用途；默认用途也未配置时 SHALL 为未配置。公开投影 MUST 以 `direct`、`fallback_default`、`unconfigured` 显式区分，不得把用途回落描述为自动模型 fallback。

#### Scenario: 摘要用途使用独立小模型

- **WHEN** 默认和分析与规划指向一个模型，而摘要与总结直接指向另一个档案的小模型
- **THEN** 四用途解析保持彼此独立，摘要与总结解析到直接指派，分析与规划不受影响

#### Scenario: 专用用途清空

- **WHEN** 用户把信息提取用途的 target 指派为 `null` 且默认用途有效
- **THEN** catalog 将信息提取投影为 `fallback_default` 并返回解析后的默认 `(profileId, modelId)`，不建立隐藏的第二条指派

#### Scenario: 删除默认目标

- **WHEN** 默认用途的 profile 或 model 被删除且没有其它直接默认指派
- **THEN** 默认与依赖它回落的专用用途投影为 `unconfigured`，未来 bind fail closed

### Requirement: 模型能力必须是六字段 exact 闭集

每个 model SHALL 声明且只声明 `maxInputTokens`、`maxOutputTokens`、`supportsToolCalling`、`supportsStructuredOutput`、`supportsStreaming`、`usageReporting` 六个能力字段。写入 model 行的能力 MUST 由用户明确提交；provider 模板与远端目录只可提供非权威 `capabilitySuggestion`，其字段可为值或 `null`，并携带来源与版本元数据。接入层 MUST NOT 从 model ID、profile label、厂商名、远端响应特征或一次试调用猜测、探测或自动补全。

`deepseek-openai-template@1` SHALL 基于 2026-08-30 的 DeepSeek 官方文档快照建议四个布尔字段为 true；由于官方页面只公开 `1M` context 与 `384K` max output 的缩写，且 context 是输入输出总限制，两个 exact token 整数字段 SHALL 建议为 `null` 并要求用户确认。当前 `deepseek-v4-flash` 只作为 model ID 建议，不是配置事实。未来官方事实变化 MUST 发布新的 template/suggestion version，不得原地改写 v1、已保存 model 或既有模型运行绑定。

只有 `supportsToolCalling` SHALL 是硬绑定条件，且只在 `executionForm='agent_loop'` 时要求为 true。single-shot MUST NOT 因 `supportsStructuredOutput=false` 或 `supportsStreaming=false` 被接入层拒绝。

#### Scenario: Agent Loop 能力不匹配

- **WHEN** `bind()` 为 `agent_loop` 解析到 `supportsToolCalling=false` 的 model
- **THEN** 资格投影为 `provider_not_configured`，若绕过资格直接 bind 则返回 `AGENT_REQUEST_INVALID`，不写 binding 且不得返回 `AGENT_PROVIDER_UNAVAILABLE`

#### Scenario: 远端建议没有能力事实

- **WHEN** 用户拉取的远端 model 建议只有 `modelId`，或模板只提供部分能力建议
- **THEN** 未知能力字段保持 `null`，用户确认并补齐六字段前 `addModel` 必须 fail closed，接入层不得猜测

### Requirement: v6 必须追加四张模型接入表并保持旧 migration 不变

正式 catalog SHALL 只通过追加 migration v6 建立 `agent_model_profiles`、`agent_model_profile_models`、`agent_model_purpose_assignments`、`agent_model_run_bindings`。v1–v5 的 SQL 与 checksum MUST 逐字节不变；checksum 不匹配 MUST fail closed。migration 失败 MUST 保留可恢复的原数据库，Agent 表存在或迁移失败 MUST NOT 使字幕系统把 Agent 当作字幕启动前置。

`agent_model_run_bindings.run_id` SHALL 外键指向 v5 `formal_agent_runs`。profile/model 删除 MUST NOT 级联删除绑定；绑定写入后 MUST 禁止 UPDATE、replace 或同 `runId` 不同内容的第二次写入。

#### Scenario: v5 升级到 v6

- **WHEN** 一个含既有字幕事实、v1–v5 migration 历史和 S1 数据的数据库由 storage worker 打开
- **THEN** 系统且只应用 v6，保留既有事实，并使 v1–v5 SQL/checksum 与冻结值完全一致

#### Scenario: 修改既有 migration

- **WHEN** v1–v5 任一 SQL 或 checksum 与数据库历史不一致
- **THEN** storage worker fail closed，不静默修复、重建或降版本

#### Scenario: 试图改写绑定

- **WHEN** 任意路径对既有 `runId` 的模型运行绑定执行 UPDATE、replace 或写入不同字段
- **THEN** 数据库/领域合同拒绝该操作，原绑定逐字段保持不变

### Requirement: 删除档案必须清理 live 事实且保留既有绑定身份

`deleteProfile` SHALL 作为一个可恢复的原子配置操作删除 live profile、其 model 清单、指向它的用途直接指派和其 credential slot。该删除 MUST 只影响未来 catalog/bind；既有 `agent_model_run_bindings` 与已提交产物 SHALL 保留不可变 profile/model、连接、能力、预算与 providerKind 身份。

删除或清除 credential slot 后，引用该旧 slot 的未终态既有运行在需要凭据时 MUST 收束为 `AGENT_PROVIDER_AUTH_FAILED` 且不重试。系统 MUST NOT 让新 profile 或新 slot 复用旧 slot identity。

#### Scenario: 删除有既有绑定的档案

- **WHEN** profile 已被一个既有 run binding 引用后用户成功删除该 profile
- **THEN** live profile/model/purpose/slot 消失，未来 bind 不再解析到它，而旧 binding 仍可逐字段读取其非敏感模型身份

#### Scenario: 删除后重建同 profileId

- **WHEN** 后续允许以相同 `profileId` 建立新档案
- **THEN** 新档案取得全新 credential slot，旧 binding 无法借用新凭据并在需要旧槽时稳定鉴权失败

### Requirement: 凭据必须按档案由 main-owned safeStorage vault 管理

每个 profile SHALL 有一个独立 credential slot。持久凭据 MUST 只以 `safeStorage` 密文保存在 main-owned vault；SQLite、ConfigStore、renderer、日志、普通报告、测试证据 JSON、环境变量、argv 与 child environment MUST NOT 含凭据明文、auth header 或可读回密钥。renderer SHALL 只能写入新凭据、清除凭据并读取 `{present, scope}`，永远不能读回明文。

vault 与 SQLite 跨介质命令 MUST 使用 prepare/commit/rollback/recover 协议，使 `setCredential`、`clearCredential` 与 `deleteProfile` 的任何失败都零写入或可确定恢复到旧状态。非敏感恢复 journal MUST NOT 包含凭据、origin、header、路径投影或 raw Error。

公开 scope SHALL 恰好为 `persistent`、`session_only`、`absent`。`safeStorage` 不可用时只允许本次 main 会话的 `session_only`；重启后 MUST 回落 `absent` 并要求重新输入。

#### Scenario: safeStorage 不可用

- **WHEN** 用户在 `safeStorage` 不可用时成功设置某 profile 凭据
- **THEN** catalog 投影 `{present:true, scope:'session_only'}`，明文只存在当前 main 进程有界内存且不落盘

#### Scenario: session-only 后重启

- **WHEN** 应用在只有 `session_only` 凭据的情况下退出并重新启动
- **THEN** 该 profile 公开状态为 `{present:false, scope:'absent'}`，系统不得从 SQLite 标志或 fixture 伪造 present

#### Scenario: vault 写入失败

- **WHEN** vault prepare、safeStorage 加密、SQLite 事务、vault commit 或恢复任一步失败
- **THEN** configure 返回 `MODEL_CONFIG_INVALID`，旧凭据与全部配置/revision 保持一致，且输出不含 raw Error 或凭据片段

### Requirement: 稳定鉴权失败只失效对应 profile 凭据

HTTP 401/403 或固定 adapter 明确分类的稳定鉴权拒绝 SHALL 使当前绑定引用的 profile credential slot 失效并投影为 `absent`。该 main-owned 内部状态转换 MUST 推进该 profile revision 与公开 `configurationRevision`、发布 `changed`，但 MUST NOT 成为第十条 configure 命令。408、429、网络错误、5xx、取消、预算耗尽、输出 Schema 失败与 worker 退出 MUST NOT 清除凭据。Agent utility 以后只可取得一次调用的有界凭据副本，并在成功、失败、取消、超时或退出后尽力清零。

#### Scenario: 一个档案稳定鉴权失败

- **WHEN** 两个档案各有独立凭据，而其中一个调用得到稳定鉴权失败
- **THEN** 只有该档案的槽失效，另一个档案的凭据与 readiness 保持不变

#### Scenario: 限流或网络失败

- **WHEN** provider 返回 429、5xx 或网络错误
- **THEN** 当前凭据仍保持原 scope，运行按后续 S3 错误语义处理，不得误清 slot

### Requirement: 连接必须使用 exact HTTPS origin 与独立 base path

renderer 提交的连接字段 SHALL 只有可展示 label、`httpsOrigin` 与 `basePath`，二者共同表达用户定义的 API base URL。`httpsOrigin` MUST 是 canonical `https:` origin，只含 scheme、host 与可选 port，并拒绝 userinfo、path、query 和 fragment。`basePath` MUST 是以 `/` 开头、不含 query、fragment 或 `..` segment 的绝对路径；普通新档案默认 `/v1`，DeepSeek 官方模板使用 `/`。

OpenAI-compatible adapter MUST safe-join `httpsOrigin + basePath + '/chat/completions'` 形成模型端点，不接受 renderer 提交 endpoint segment；目录拉取使用同一 API base URL 下的 models endpoint。adapter MUST 禁用自动 redirect，任何 3xx 都 fail closed，不得跟随同 origin 或跨 origin redirect。`providerKind` MUST 只由 canonical hostname 是否为 loopback 推导：`localhost`、IPv4 `127.0.0.0/8` 与 IPv6 `::1` 为 `local`，其它为 `cloud`，并随模型运行绑定冻结。

#### Scenario: renderer 提交可接受连接

- **WHEN** renderer 提交 `https://example.test:8443` 与 `/v1`
- **THEN** 系统保存并公开 canonical origin/base path，内部固定 adapter/API style 与推导的 `providerKind='cloud'` 不由 renderer 覆盖

#### Scenario: redirect 响应

- **WHEN** 目录拉取或后续 provider 请求收到任意 3xx
- **THEN** adapter 拒绝响应，不跟随 location，不写配置、不改变受信任 origin，公开错误不包含 redirect location

#### Scenario: loopback 推导

- **WHEN** profile origin hostname 是 `localhost`、`127.0.0.2` 或 `[::1]`
- **THEN** bind 冻结 `providerKind='local'`，不依据 profile label、model ID、厂商名或端口分类

### Requirement: 环境变量与 Pi 凭据发现必须不可用

系统 SHALL 在启动环境快照中无条件删除所有大小写不敏感等价于 `DEEPSEEK_API_KEY` 的键，并只从净化后的快照构造 child environment。环境变量、argv、Pi home-dir、`auth.json`、OAuth 与 `envApiKeyAuth()` MUST NOT 成为凭据来源；运行中注入环境 MUST NOT 改变 catalog、readiness、bind 或 child environment。

#### Scenario: 启动环境含旧凭据键

- **WHEN** 启动环境包含一个或多个大小写变体的 `DEEPSEEK_API_KEY`
- **THEN** 所有等价键在 child environment 建立前被删除，catalog 仍只依据 vault 状态，且不得把环境值读入任何 profile

#### Scenario: 运行中注入环境

- **WHEN** 应用启动后进程环境被加入 provider API key
- **THEN** 既有与未来 catalog/readiness/bind 不变，后来创建的 child 也不包含该键

### Requirement: bind 必须按固定顺序冻结不可变模型运行绑定

`bind(runRequest)` SHALL 只接受 exact `runId`、`recipeId`、`recipeVersion` 与 `executionForm`，调用方 MUST NOT 提交 purpose、profile、model、URL、header、预算或凭据。接入层 MUST 在一个 SQLite 事务内验证该 `runId` 已存在于真实 v5 `formal_agent_runs` 且 recipe/version 匹配，再按以下顺序 fail closed：recipe identity → 静态 recipe-to-purpose 映射 → 用途直接指派 → 默认回落 → live profile/model → 六字段能力 → 十轴预算推导 → credential slot 状态 → 插入或逐字段重放不可变 binding。四字段请求不得扩张为 run 创建载荷。

任一步失败 MUST 不执行后续步骤、不借出凭据且不写 binding。自动重试 MUST 复用同一 `runId` 与同一 binding；用户主动换模型 MUST 建立新 `runId`。

#### Scenario: single-shot bind 成功

- **WHEN** 已登记 single-shot recipe 映射到一个有有效 profile/model/credential 的用途且 capability 满足要求
- **THEN** 系统在真实 v5 formal run 上原子写入一行 v6 binding，冻结用途、回落模式、profile/model、连接、能力、十轴预算、providerKind 与 credential slot ID

#### Scenario: 相同 runId 重放

- **WHEN** 相同 `runRequest` 在首个 bind 回复丢失后重试
- **THEN** 系统只返回逐字段相同的既有 binding，不建立第二行、不推进配置 revision且不重新解析到用户后来修改的配置

#### Scenario: 调用方绕过选择策略

- **WHEN** `runRequest` 携带 profile、model、purpose、origin、header、预算或凭据字段
- **THEN** bind 返回 `AGENT_REQUEST_INVALID`，不写 binding且不借出凭据

### Requirement: S2 必须提供非敏感 readiness 且不得伪造 ready

`catalog()` SHALL 为四用途派生 single-shot 与 Agent Loop 的非敏感配置 readiness，值只允许 `ready`、`provider_not_configured`、`credential_unavailable`。readiness MUST 只依据已提交配置、用途解析、六字段能力与 credential `{present,scope}`，不得解密凭据、发网络、探测模型或读取 fixture。

该 readiness 只表示 Agent 模型接入层足以建立未来 binding，不表示公网可达、鉴权成功、模型推理成功或完整 Agent 处理资格 ready。产品资格组合器 MUST 再与 ConfigStore、云端披露、会话及自动处理边界事实组合，且 renderer、IPC 成功、测试 adapter 或一次 provider 响应不得覆盖结果。

#### Scenario: S1 自动摄取用途配置充分

- **WHEN** 信息提取用途可解析到 credential present 且 single-shot 能力有效的 profile/model
- **THEN** catalog 的 `information_extraction.singleShot` 可为 `ready`，资格组合器仍必须应用 Agent 总开关、云端披露与其它已登记优先级

#### Scenario: 测试替身注册但没有真实配置

- **WHEN** 测试构建可达 `fauxProvider()`，但默认用途或信息提取用途没有有效 live 配置/凭据
- **THEN** readiness 保持 `provider_not_configured` 或 `credential_unavailable`，不得因替身存在伪造 ready

### Requirement: 运行比较只保留 token 与缓存命中事实

系统 SHALL 不建立或展示 price、cost、currency、pricing catalog、profile pricing override、pricing revision 或费用估算。v6 模型配置表与模型运行绑定 MUST NOT 包含任何金额或 pricing 字段；历史与导出也 MUST NOT 计算或展示金额。

S2 SHALL 冻结供 S3/S5 消费的 exact `ModelUsageV1`：非负整数 `inputTokens`、非负整数 `outputTokens`、`usageSource='provider' | 'estimated'`，以及分别为非负整数或 `null` 的 `cacheHitInputTokens` 与 `cacheMissInputTokens`。provider 未返回 input/output token，或模型能力声明 `usageReporting=false` 时，后续运行层 MAY 按权威文档登记的确定性规则估算，但 MUST 标记 `estimated`；两个缓存字段 MUST 只来自 provider 明确返回，绝不估算。DeepSeek adapter SHALL 分别映射官方 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。

缓存命中率 SHALL 只作为展示层派生值，不单独持久化：仅当 `usageSource='provider'`、两个缓存字段均为非负整数、两者之和大于零且恰好等于 `inputTokens` 时，等于 `cacheHitInputTokens / (cacheHitInputTokens + cacheMissInputTokens)`；其它情况 MUST 把两个缓存字段与命中率一并收束为 `null` 并显示未知，不得显示 0%。模型比较 SHALL 只使用模型运行身份、input/output token、用量来源、缓存命中率与相对时长。

#### Scenario: provider 返回缓存 token

- **WHEN** provider 返回 `inputTokens=1000`、`outputTokens=200`、`cacheHitInputTokens=250`、`cacheMissInputTokens=750`
- **THEN** 系统保留四个 token 事实与 `usageSource='provider'`，展示层派生缓存命中率 25%，且不存在金额字段

#### Scenario: token 为估算或缓存字段缺失

- **WHEN** input/output token 由确定性规则估算，或 provider 没有返回 cached input token
- **THEN** 两个缓存 token 字段与缓存命中率为 `null`，界面显示未知而不是 0%，且不得估算缓存命中

#### Scenario: provider 返回不一致缓存 token

- **WHEN** 任一缓存 token 类型非法、为负数、两者总和为零或不等于 input token
- **THEN** 已验证的模型内容结果不因此被伪造为失败，但两个缓存事实与命中率一并 fail closed 为 `null`，只发布不含原始响应的受限诊断

### Requirement: pull-remote-catalog 必须是三接口之外的受限 application adapter

`agent-model:pull-remote-catalog` SHALL 是 main-owned 用户动作 adapter，而不是 Agent 模型接入层第四接口。它 MUST 先通过 `catalog()`/`expectedRevision` 取得当前非敏感 profile 事实，再经同包私有 credential-borrow port 和固定 OpenAI-compatible adapter 拉取一次瞬时建议。结果状态只允许 `success/revision_conflict/invalid_request/credential_unavailable/redirect_rejected/remote_unavailable`，并 MUST NOT 写 profile/model/purpose/vault、推进任何 revision或发布 `changed`。

建议 SHALL 包含用户可编辑的 `modelId` 和可空 `capabilitySuggestion`，但不得成为配置事实。DeepSeek 模板可以把官方当前 `deepseek-v4-flash` 等 alias 与模板 v1 的官方能力建议合并显示；未来 alias 变化只影响下一次瞬时建议，不能静默改写已保存 model。

只有用户随后用九条 `configure()` 命令中的 `addModel` 或 `updateModel` 明确采纳，建议才成为配置事实。拉取失败、redirect、credential absent、响应 schema 错误、重复/空 model ID 或超预算建议 MUST 零写入。

#### Scenario: 用户拉取并采纳建议

- **WHEN** 用户明确拉取到建议列表并选择一个 model，再以当前 `expectedRevision` 提交 `addModel`
- **THEN** 拉取本身不改变 revision，只有成功 `addModel` 推进 catalog/profile/global revision

#### Scenario: 拉取失败

- **WHEN** 远端 models endpoint 超时、限流、断网、redirect 或返回 invalid schema
- **THEN** adapter 返回受限失败结果，配置/vault/revision 不变，catalog snapshot 不保存失败响应或建议

### Requirement: model-access IPC 必须 exact、脱敏并支持单调 reload

renderer-facing contract SHALL 独立版本化，首版为 `agent-model-ui@1.0.0`。已签发版本 MUST NOT 原地修改；breaking/additive/metadata-only 变更分别发布新 major/minor/patch 与新 fixture 目录。`get-catalog` 返回 exact `{contractId, contractVersion, ok, snapshot, error}` envelope；初始化或读取降级时 `snapshot=null`，唯一错误码为 `MODEL_ACCESS_UNAVAILABLE`，不得伪装为空配置或 `provider_not_configured`。

系统 SHALL 冻结以下只授权 `settings` 的频道：

- `agent-model:get-catalog`
- `agent-model:configure`
- `agent-model:pull-remote-catalog`
- `agent-model:changed`

公开 catalog SHALL 包含 revision、profile/model 可编辑字段、六字段能力、credential `{present,scope}`、四用途 direct/fallback/unconfigured 解析和非敏感 readiness。它 MUST 隐藏 adapter/API style 内部常量、provider factory、credential slot、密文/明文/header、vault journal、SQL identity、redirect location、raw provider 错误、内部 recipe 映射与预算来源。

renderer reload MUST 使用“先订阅 changed，再读取 catalog”；只接受大于当前 revision 的 changed，收到后重新读取权威 snapshot，并拒绝旧 snapshot。renderer MUST NOT 从等待时长、异常字符串、ID 形状、缺字段或 optimistic state 推断成功。

#### Scenario: renderer reload 期间配置改变

- **WHEN** renderer 订阅 changed 后、读取初始 catalog 前发生一次成功 configure
- **THEN** renderer 最终取得不小于 changed revision 的权威 snapshot，旧 snapshot 不覆盖新状态

#### Scenario: 未授权角色调用

- **WHEN** `caption`、`toolbar`、`history`、`agent` 或未知角色调用 model-access 频道
- **THEN** main 在进入 model-access/controller 前拒绝请求并保持零写入

#### Scenario: 未知 contract 值

- **WHEN** renderer 收到未知 contract version、purpose、assignment mode、credential scope、readiness、命令结果、额外键或缺字段
- **THEN** exact validator fail closed，renderer 停止该表面写动作并要求 reload/update，不把未知能力当 true 或未知缓存事实显示为 0% 命中

### Requirement: UI/UX fixture 必须与生产 contract 同源且不构成 J25 证据

S2 SHALL 为公开 catalog、九命令结果、revision 冲突、credential scope、四用途回落、readiness、远端建议和失败路径提供版本化脱敏 fixture。fixture MUST 通过与生产 request/response/event 相同的 exact validator，并带 `previewOnly=true`。

fixture MUST NOT 含凭据、header、credential slot、URL query/fragment、redirect location、正文、本地绝对路径、设备名、绝对单调时刻、时钟偏移或 raw Error。fixture、截图、设计预览与局部 renderer 回归 MUST NOT 进入 `.artifacts/`、`docs/validation/` 或被计为 J25 证据。

#### Scenario: session-only fixture

- **WHEN** UI/UX 工作线加载 `session_only` 与重启后 `absent` fixture
- **THEN** 两个 fixture 使用同一生产 validator、明确 `previewOnly=true` 且不含任何凭据或槽 identity

#### Scenario: fixture 被写入证据目录

- **WHEN** 构建或测试试图把 model-access preview fixture 复制到 `.artifacts/`、`docs/validation/` 或 J25 报告
- **THEN** evidence 分层合同失败，且不得晋级 S2/J25 状态

### Requirement: fauxProvider 必须只在测试构建可达

系统 SHALL 提供一个测试专用 `fauxProvider()` 外部协议替身，用于 models 建议、redirect、稳定鉴权失败、限流/网络/5xx、input/output usage、cached input token 的合法/缺失/不一致响应、调用 barrier 与凭据副本清零观察。测试 MUST 通过真实 catalog/configure/bind/controller/vault/storage 路径抵达该替身，不得直接写 binding、提交产物或覆盖 readiness。

生产构建 MUST 不包含动态 adapter 注册路径，且 `fauxProvider()` MUST 从生产 module graph/package 不可达。S2 MUST NOT 使用它发起或冒充真实公网模型推理。

#### Scenario: 测试构建调用替身

- **WHEN** J25 S2 Core 联合测试在测试构建中触发远端目录或鉴权失败协议
- **THEN** 请求经过真实 model-access 内部路径后到达唯一 `fauxProvider()` 边界，内部配置、vault、binding 和 SQLite 均为真实实现

#### Scenario: 生产构建可达性

- **WHEN** 生产入口与 package module graph 被枚举
- **THEN** 不存在 `fauxProvider()`、test adapter factory 或动态 `registerAdapter` 可达路径，且该证明不依赖文档关键词或单一源码正则

### Requirement: S2 bind 验证不得提前实现 S3 运行时

S2 的 bind 联合测试 SHALL 使用已登记的真实 S1 `context.ingest.session` recipe identity、静态 recipe-to-purpose 映射、真实 v5 `formal_agent_runs` 与 v6 binding store，验证解析顺序、原子写入、重放、能力拒绝与凭据槽身份。测试 MUST NOT 调用模型推理、创建正式 Agent interaction/result、提交个人上下文模型产物或运行 Agent Loop。token/缓存事实在 S2 只通过 exact contract 与 `fauxProvider()` 归一化测试冻结，不写正式 interaction。

#### Scenario: 验证真实 run 与 binding 原子性

- **WHEN** S2 测试为一个真实 v5 formal run 调用 single-shot bind 并在事务边界注入失败
- **THEN** run/binding 同成同败或按已登记创建协议保持可恢复一致，不出现无 run 的 binding、同 run 多 binding 或部分模型身份

#### Scenario: 测试试图提交模型结果

- **WHEN** S2 测试或实现试图在 bind 后直接写 interaction、artifact、个人记忆模型结果或工具调用记录
- **THEN** 分层合同失败，并把该工作留给 S3/S4/S5，不得把 S2 称为完整 J22/J24/J25

### Requirement: S2 必须登记三条 lane 与 J25 Core 子边界

S2 实施 SHALL 按 tracer bullet 逐个闭合：一个已确认 seam 的行为测试先红、最小实现转绿、定向回归后才进入下一 seam。长期红测、批量骨架、源码正则或直接写最终产物 MUST NOT 代替产品行为。

最终门禁 SHALL 依次运行 `npm run test:core`、`npm run test:integration`、`npm run test:evidence`。J25 只登记 S2 Core 子边界：真实 v6、DeepSeek 空 model provider 模板、用户自定义 API base URL/model/能力、模型配置 store、每档案 vault、三接口、main-owned exact IPC、token/缓存用量合同与 `fauxProvider()` 外部边界。正式 settings renderer、真实用户配置往返和主动换模型后的 token/缓存效率比较 MUST 延后到 S5-Integration。

#### Scenario: 三条 lane 返回 0

- **WHEN** S2 的 core、integration、evidence lane 全部返回 0，且字幕 open/append/close/history 零回归
- **THEN** S2 最多记录为「实现完成·尚未验收」，不晋级完整 J25 或真实公网模型能力

#### Scenario: Agent 模型接入失败

- **WHEN** v6 store、vault、adapter、目录拉取、bind 或 IPC 任一失败
- **THEN** 字幕系统继续采集、显示、持久化与历史，Agent 能力显式降级且不得阻塞字幕停止或启动
