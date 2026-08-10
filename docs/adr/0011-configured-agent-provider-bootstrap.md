# ADR 0011：正式 Agent 首版以配置表与启动环境准备 Agent 模型 provider

- 状态：已决定
- 日期：2026-08-10
- 决策者：项目负责人
- 依赖：ADR 0002、ADR 0003、ADR 0005、ADR 0009

## 背景

正式 Agent 首版需要闭合字幕提交边界、三项后台 Agent 任务、个人记忆、调试聊天与产品 UI，但当前不提供真实 Agent 模型 provider 凭据，也不把某一家供应商的实时可用性作为开发阻塞。与此同时，若完全跳过 provider 配置与失败边界，内部模块只能依赖测试临时参数，后续接入时仍会改动任务身份、输入预算和设置语义。

DeepSeek 官方当前提供 OpenAI-compatible Chat Completions 接口，模型标识包含 `deepseek-v4-flash`。该事实只用于给初版提供一个可替换的默认配置，不把供应商价格、上下文长度、思考模式或其它可变能力写入业务语义。

## 决策

1. 正式 Agent 首版必须闭合 Agent 模型 provider 的 registry、受信任非敏感配置、启动环境凭据状态、provider/model/recipe/预算冻结、超时/取消、稳定错误分类、Agent 处理资格和降级。真实 DeepSeek 公网调用及其可用性不属于当前确定性联合验收门禁。
2. 非敏感参数只来自正式 main 专用的 `AgentProviderConfigCatalog` 配置表。初版表中只有一个 exact 条目：`providerId='deepseek'`、`providerKind='cloud'`、`apiStyle='openai-chat-completions'`、`baseUrl='https://api.deepseek.com'`、`model='deepseek-v4-flash'`。renderer 只能读取不含 URL、预算和凭据的公共投影，不能提交 provider、URL 或 model。修改配置表只在应用重启后影响新建后台 Agent 任务。
3. `model` 是可配置的不透明字符串；宿主不得从名称推断上下文窗口、输出上限、Tool Calling 或思考模式。`maxChunkInputBytes`、`maxResultBytes` 与 `timeoutMs` 由同一受信任配置表明确给出并做范围校验，只作为宿主的保守执行预算，不从供应商营销值或 renderer 输入动态推导。
4. API key 只从启动环境变量 `DEEPSEEK_API_KEY` 读取一次。正式 main 的第一段同步启动逻辑必须早于 `app.whenReady()` 后的窗口逻辑，也早于任何 `BrowserWindow`、preload、renderer、Node worker、child process 或 utility process 创建：先取得 raw 值并无条件立即删除 `process.env.DEEPSEEK_API_KEY`，再拒绝空字符串、全空白或超过 4096 个 UTF-8 字节的 raw 值；只有合法值才复制到不参与序列化的主进程 `Buffer`。随后建立明确不含该变量的子进程环境。所有子进程都使用净化后的环境；Agent utility 也不从环境继承 key，只在一次当前 Agent 模型 provider 调用的私有消息中取得有界副本。
5. 每次调用结束或 Agent utility 异常退出时，utility 内的凭据副本必须 `fill(0)` 并释放；Agent utility 异常退出、稳定鉴权失败或应用退出时，主进程副本也必须 `fill(0)`、标记 `credential_unavailable`，后续恢复一律要求以新的启动环境重启应用。运行中后来写入 `process.env` 不生效。该规则是尽力缩短明文驻留，不宣称 V8/操作系统内存可被绝对清零。
6. 应用不自动读取 `.env` 文件，不把明文 key 写入 userData，也不提供正式 renderer 的 key 写入/回读 IPC。启动时未供给或值不合法时 Agent 处理资格为 `credential_unavailable`，字幕系统照常运行。
7. 初版网络适配器只允许 exact origin `https://api.deepseek.com`，固定拼接受控 Chat Completions 路径并拒绝 redirect；任何 host、scheme、port、user-info 或路径基准漂移都返回 `provider_not_configured`，不得携带 Authorization 请求其它地址。非敏感配置缺失或不合法、云端披露未确认时也分别返回既有稳定资格，不创建或领取后台 Agent 任务。
8. Agent 总开关、个人记忆开关、两个自动处理边界、云端披露和设置 revision 仍是产品设置事实，不写入 provider 配置表。实现该正式设置切片时必须把当前平面 `ConfigStore` 从 schema v1 迁移到 v2，增加 exact 平面字段 `agentEnabled=false`、`automaticProcessingSince=null`、`memoryEnabled=true`、`memoryProcessingSince=null`、`cloudDisclosureAccepted=false`、`agentSettingsRevision=0`；迁移保留现有字幕设置。非法字段组合统一回落到 Agent 关闭、两个边界为 `null`、披露未确认。设置更新必须在同一次原子读改写中核对 `expectedRevision`、应用归一化后的六个字段并把 revision 恰好加一；不匹配返回稳定 `SETTINGS_REVISION_CONFLICT` 且不写文件。renderer patch 白名单不得包含 provider、URL、model 或凭据。
9. CI 只在 Agent 模型 provider、云网络和启动环境凭据外部边界使用确定性替身。替身必须经过真实 `AgentModelProviderRegistry → ModelGateway → Agent Loop` 请求路径；不得让测试直接提交最终产物。真实 DeepSeek 联网只在接入凭据后另建手动/实机证据，不反向改变当前任务、产物或输入身份 schema。
10. 隔离 Agent 内核开发入口继续遵循 ADR 0007 的 `safeStorage` 设计。该已验收开发入口与本 ADR 的正式产品启动配置互不替换，隔离入口数据仍不进入正式 userData 或安装包。

## D9 实现切片

D9 先实现不接公网的 main-only bootstrap/catalog 子边界。默认保守预算固定为 `maxChunkInputBytes=65536`、`maxResultBytes=16384`、`timeoutMs=60000`，不从 `deepseek-v4-flash` 名称推断能力。启动消费按 Windows 环境名大小写不敏感：先收集并删除所有等价于 `DEEPSEEK_API_KEY` 的键，再验证配置与 raw 值；多个等价键一律视为歧义凭据。child environment 从删除后的启动快照复制，避免 Node worker/child 默认复制 `process.env` 时把运行中注入重新带入。主凭据和单次调用副本均使用有界、已初始化 `Buffer`；调用副本在成功或异常后清零，主副本在稳定鉴权失败、Agent utility 异常退出或应用退出时清零。

本切片只向后续正式 main 提供闭合配置快照、公开状态、非敏感 Agent 处理资格事实、净化后的 child environment 和有界凭据借用生命周期；不修改当前冲突区内的 `src/main.js`/ConfigStore/preload/renderer，不创建 Agent utility，不实现 HTTP，也不把 bootstrap 自身称为正式 J24 产品链路。

## D10 实现切片

D10 在不接公网的前提下实现项目自有 `AgentModelProviderRegistry`，并让正式 `ModelGateway` 只接受该项目类型的实例，不再直接依赖或以 duck typing 接受测试替身。registry 只从一个 D9 `AgentProviderBootstrap` 冻结快照注册精确匹配的第一方适配器；解析结果同时冻结 provider/model、输入输出预算、超时和一个不暴露凭据的 `withModel` 调用边界。`withModel` 只输出冻结的 exact `{ model, streamFn }` 句柄，以同一受控取消信号约束模型打开和 Pi Agent Loop，并持有单次凭据借用直到逻辑调用顺利、异常、取消或超时收束；取消或超时后立即停止等待、清零借用副本并拒绝迟到结果进入 Loop。稳定 `AGENT_PROVIDER_AUTH_FAILED` 同步失效主凭据，其它稳定结果不改变启动凭据状态。

CI 的确定性适配器继续属于 Agent 模型 provider 外部边界，但必须经真实 registry、`ModelGateway` 与 Pi Agent Loop；它只接收本次调用的配置快照、请求副本和有界凭据副本，不得直接写 SQLite 或产物。D10 复用并升级既有正式纪要与三项任务联合旅程，只新增一条稳定鉴权失效场景；不实现 DeepSeek HTTP、正式 main、Agent utility、preload 或 renderer，也不证明公网可用性。

## 取舍

- 相比把 API key 写入 ConfigStore，本方案避免明文持久化与 renderer 凭据 IPC；代价是每次启动都必须由外部环境重新供给。
- 相比当前就接入并验证真实 DeepSeek，本方案允许内部产品旅程稳定推进；代价是正式 MVP 的确定性证据只证明 Agent 模型 provider 的配置、凭据、冻结和降级要求，不证明供应商公网、账户、配额或模型质量。
- 相比只在测试中临时注入 provider，本方案提前冻结了任务身份、预算、资格和 UI 状态，后续接入不需要修改 SQLite 事实模型。
- 相比自动读取项目 `.env`，只读取进程环境减少了明文文件和打包泄漏面；代价是开发者需要在启动器或终端设置变量。

## 未选择

- 在正式 renderer 中输入、保存或回读 API key。
- 把 API key 写入 SQLite、ConfigStore、日志、报告或 `.env`。
- 把真实 DeepSeek 公网调用作为当前 CI 或联合验收前置。
- 因 provider 未配置而伪造 Agent 产物，或阻止字幕系统启动。

## 关联

- 语义：SEM-F09、SEM-F15、SEM-F25、SEM-F28、SEM-T15
- 旅程：J7、J13、J21、J22、J24-B12/B23/B26/B30；D10 不覆盖配置部署 B13
- 接口：[`../agent-mvp-interface-contract.md`](../agent-mvp-interface-contract.md)
