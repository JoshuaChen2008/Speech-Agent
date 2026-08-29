# ADR 0014：Agent 模型接入层改为多档案 OpenAI-compatible 与按档案 safeStorage

- 状态：已决定
- 日期：2026-08-29
- 决策者：项目负责人
- 依赖：ADR 0002、ADR 0005、ADR 0013
- 取代：[ADR 0011](0011-configured-agent-provider-bootstrap.md)（整体）
- 修订：[ADR 0005](0005-separate-recognition-and-agent-providers.md) 第 8 项、[ADR 0007](0007-isolated-agent-core-mvp.md) 第 4 项中关于正式 Agent 首版 provider 的表述

## 背景

ADR 0011 把正式 Agent 首版的 provider 事实定为「一张 exact 配置表恰好一个 DeepSeek 条目 + 启动环境变量 `DEEPSEEK_API_KEY`」。它当时解决的是「没有真实凭据也要把冻结、资格与降级闭合」这个问题，并成功产出了 D9/D10/D11/D14 四段可靠性实现。

该形状在产品语义确定后不再成立，原因有三。

第一，产品已确定用户可以保存多个模型配置档案、为同一供应商保存多个模型、并把「默认、信息提取、摘要与总结、分析与规划」四个用途各自绑到不同 `(档案, model)`（SEM-F33、J25）。摘要用便宜小模型、分析与规划用更强模型是首要支持场景。而 `validateAgentProviderConfigCatalog()` 在**启动期**硬断言 `providers.length === 1`、`providerId === 'deepseek'`、`providerKind === 'cloud'`、`baseUrl === 'https://api.deepseek.com'` 并 fail closed；只要它还在启动路径上，多档案就无法存在。

第二，把 API key 只从启动环境变量读取，要求用户在启动器或终端设置环境变量才能使用 Agent。对一个 Win11 桌面应用的普通用户，这不是可用的凭据入口；而产品已确定凭据由 renderer 明确写入、由主进程按档案用 `safeStorage` 加密保存、只回布尔存在性与作用域枚举。

第三，把 `model` 当作不透明字符串、把 `maxChunkInputBytes` / `maxResultBytes` / `timeoutMs` 混在 provider 配置里，无法表达「同一档案下不同模型有不同上下文窗口与是否支持工具调用」，也无法支撑十轴预算与升级阈值的推导。

## 决策

1. Agent 模型接入层对外恰好三个接口，全部 main-owned：`catalog()` 只读公开投影、`configure(command)` 闭集命令、`bind(runRequest)` 运行创建期一次性冻结。renderer 经 exact IPC 只能读公开投影与提交闭集命令；recipe 与 Agent utility 都不得调用 `catalog()` 或 `configure()`；`bind()` 只由 Agent 执行宿主在运行创建期调用一次。`catalog()` 是纯读操作，不触发网络、不刷新目录、不解密凭据。
2. **一个配置档案 = 一个受信任连接 + 一份凭据 + 一组 model。** 连接由档案 ID、adapter、API 风格、受信任 HTTPS origin（只含 scheme+host+port）和基础路径（默认 `/v1`）标识；模型清单独立于档案行，`(档案 ID, model ID)` 是精确二元组。取代 ADR 0011 第 2 项的单条目配置表。DeepSeek 降级为**可修改的预置档案**，不是产品绑定。
3. `https_origin` 与 `base_path` 分离。origin 只做 exact 匹配校验并拒绝 redirect，必须是 `https:`；`base_path` 是不含查询、片段与 `..` 的绝对路径。取代 ADR 0011 第 7 项写死 `https://api.deepseek.com` 的适配器约束——约束方式保留（exact origin、固定拼接、拒绝 redirect、漂移即 `provider_not_configured`），被写死的厂商取消。
4. 能力是**六字段闭集**，按 model 声明：`maxInputTokens`、`maxOutputTokens`、`supportsToolCalling`、`supportsStructuredOutput`、`supportsStreaming`、`usageReporting`。只有 `supportsToolCalling` 是硬性绑定条件且只对 Agent Loop 成立。接入层不猜测、不探测；能力由用户在档案内声明或由静态预置目录给出默认值。取代 ADR 0011 第 3 项的「`model` 是不透明字符串、预算由 provider 配置表给出」——「不得从模型名称推断能力」这条**保留**，改为必须显式声明。
5. 能力不匹配是**配置问题，不是瞬时故障**：在资格投影为 `provider_not_configured`，若绕过资格直接运行则收束为 `AGENT_REQUEST_INVALID` 且不重试；不得使用 `AGENT_PROVIDER_UNAVAILABLE` 冒充可重试。
6. 凭据改为**按档案的主进程 `safeStorage` 槽**，一档案一槽、不跨档案共享（即使两个档案指向同一 origin），删除档案在同一事务内删除其槽。renderer 只能写入新凭据、只能读取布尔存在性加作用域枚举，永不读回明文。`safeStorage` 不可用时作用域为 `session_only`，只允许本次应用会话，重启后显式回落为 `absent` 并要求重新输入。取代 ADR 0011 第 4 项与第 6 项。
7. **环境变量作为凭据来源删除，作为环境净化规则保留。** ADR 0011 D9 的「启动环境中大小写等价于 `DEEPSEEK_API_KEY` 的键无条件全部删除、多个等价键视为歧义输入、child environment 只从删除后的启动快照复制」继续作为纯加固不变量；变化在于此后不再有任何代码把它读成凭据。Pi 的 `envApiKeyAuth()` 明确禁用——它从 `process.env` 发现凭据，与本条直接冲突。
8. 保留 ADR 0011 第 5 项的凭据借用生命周期：Agent utility 只取得本次调用的有界副本，收束（成功、异常、取消、超时）后尽力 `fill(0)` 清零；副本不得经环境变量、argv、日志、报告或普通事件传入。稳定鉴权失败使该槽失效；408/429/网络/5xx、取消、预算耗尽与无效结构化输出**不得**清除凭据。「尽力缩短明文驻留，不宣称内存可被绝对清零」的表述不变。变化在于失效范围从「全局主凭据」收窄为「该档案的槽」，恢复方式从「以新的启动环境重启应用」改为「用户重新输入该档案凭据」。
9. `configure()` 命令闭集恰好 9 条（`createProfile`、`updateProfile`、`deleteProfile`、`addModel`、`updateModel`、`removeModel`、`setCredential`、`clearCredential`、`assignPurpose`），全部要求 `expectedRevision`，失败一律**零写入**，只使用独立于任务错误码的配置错误码 `MODEL_CONFIG_INVALID` / `MODEL_CONFIG_REVISION_CONFLICT`。首版 adapter 与 API 风格固定，不接受命令写入；不存在任意第三方动态注册 adapter 的路径。取代 ADR 0011 第 2 项「修改配置表只在应用重启后影响新建任务」——配置改动即时生效于**未来运行**，既有绑定与产物不变，不再需要重启。
10. 不实现自动远端模型目录刷新。只提供用户明确触发的一次性拉取动作，结果仅作为**建议列表**呈现，用户勾选后才写入档案并推进模型目录 revision；失败零写入。
11. 费用**只在 main 计算**。价格目录是随应用发布的静态目录并带单调递增整数 revision，允许按档案覆盖；Agent utility 只回传原始用量与用量来源，不持有价格目录。token 用量优先取 provider 返回，缺失时用保守高估的确定性估算 `ceil(canonicalUtf8Bytes / 2)` 并标记为估算，估算永不伪装成 provider 返回。历史与导出只读取冻结值，任何时候都不重算；缺少单价时估算为 `null`，不显示 0。
12. `providerKind` 不再由配置直接给出，而由档案的受信任 HTTPS origin 是否为本地环回**推导**，并随模型运行绑定冻结。仍只有 `cloud` / `local` 两值，继续服务本地资源让行与云端披露门禁（SEM-F25）。
13. Pi 依赖边界：允许实例级 `createModels()` / `setProvider()` / `getModel()`、`createProvider({...})` 形状、OpenAI-compatible provider factory 的独立子路径导入、请求取消、以及采用 Pi loop 时只注入 `models.streamSimple.bind(models)`。明确禁用 `providers/all` 的 `builtinModels()`、将被移除的 `/compat` 全局 API、`pi-coding-agent` 的 `ModelRuntime`/`ModelRegistry`/`models.json`/`auth.json`/OAuth/home-dir 约定、`envApiKeyAuth()`、`prepareNextTurn` 的运行中模型替换路径、以及 provider-specific 的网关 routing 字段。Pi 仓库为 MIT，移植 substantial portions 必须保留版权与许可声明。
14. 保留 ADR 0011 第 8 项：Agent 总开关、个人记忆开关、两个自动处理边界、云端披露与设置 revision 仍是 `ConfigStore` 的产品设置事实，不写入 provider 配置；renderer patch 白名单不得包含 provider、URL、model 或凭据；`SETTINGS_REVISION_CONFLICT` 语义不变。
15. 保留 ADR 0011 第 9 项的替身原则并收紧其形状：CI 只在 Agent 模型 provider 这个外部边界使用**一个**确定性替身，替身必须经过真实接入层、真实执行宿主与真实 Loop 路径，不得让测试直接提交最终产物；替身**只在测试构建注册，生产构建不存在动态 adapter 注册路径因此不可达**。真实公网调用仍只作为另建的手动/实机证据，不反向改变任务、产物或输入身份 schema。
16. 保留 ADR 0011 D9/D10/D14 中与形状无关的可靠性不变量作为迁移素材：`exactObject()` 精确键校验风格、`withCredential()` 的有界借用与借出记账、稳定鉴权失败触发失效、`operationControl()` 的取消与超时合流、冻结的 exact `{ model, streamFn }` 句柄、registry 拒绝 duck typing 替身、`getChildEnvironment()` 的净化快照、以及 generation 同步失效加迟到消息忽略。

## 取舍

- 相比保留单一 DeepSeek 配置表，本方案让用途分离与性价比比较成为可能；代价是配置面从一张 exact 表变成三张表加一个凭据槽集合，验收必须覆盖 revision 冲突、级联删除与凭据槽生命周期。
- 相比从环境变量读凭据，`safeStorage` 让普通用户能真正配置 Agent；代价是引入了本地密文与「加密不可用」这条降级分支，且必须证明 renderer 永不读回明文。
- 相比让 `model` 保持不透明，六字段能力闭集使十轴预算与升级阈值可推导；代价是用户或预置目录必须为每个模型声明能力，声明错误会表现为绑定拒绝而不是运行失败——这被判定为更安全的方向。
- 相比支持自动目录刷新，本方案在用户无动作时永不改变配置事实，也不在设置阶段动网络与凭据；代价是新模型上线后用户必须手动拉取或手填。
- 相比直接依赖 Pi 的完整 provider 生态与凭据发现，本方案只依赖公开小接口；代价是需要自己实现 auth resolver、能力校验、预算推导与价格计算，换来凭据边界与配置持久化完全由本产品拥有。
- 相比同时保留旧启动期 provider 引导，本方案要求它先从启动路径摘除（见 [ADR 0015](0015-retire-old-agent-implementation.md)）；代价是新接入层的可用性依赖那一片先完成。

## 未选择

- 在 provider 配置、SQLite、renderer、日志或报告中保存 API key 明文。
- 从环境变量、argv 或 Pi 默认凭据发现读取凭据。
- 自动远端目录刷新，或让刷新失败写入部分配置。
- 在 Agent utility 内持有价格目录或计算费用。
- 运行中替换模型，或在同一 `runId` 内静默切换供应商。
- 两个档案共用一个凭据槽。
- 把能力不匹配当作可重试的瞬时故障。
- 让确定性替身在生产构建可达。

## 关联

- 语义：SEM-F25、SEM-F28、SEM-F33、SEM-T15
- 旅程：J25（OpenAI-compatible 配置与模型性价比比较）、J22、J26
- 数据：`agent_model_profiles`、`agent_model_profile_models`、`agent_model_purpose_assignments`、`agent_model_run_bindings`（见 [`../data-architecture.md`](../data-architecture.md)）
- 设计留档：[`../research/model-access-interface-freeze-draft.md`](../research/model-access-interface-freeze-draft.md)、[`../research/agent-harness-reference-notes.md`](../research/agent-harness-reference-notes.md)
- 实现 SPEC：[`../agent-redesign-execution-plan.md`](../agent-redesign-execution-plan.md)
