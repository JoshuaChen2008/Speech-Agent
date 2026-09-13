## Context

状态：已决定；执行范围包含首次配置向导、版本化服务预设和显式模型测试。依据 [proposal](proposal.md)、[CONTEXT](../../../CONTEXT.md)、[语义合同](../../../docs/semantic-contract.md) SEM-F00/F23/F33/F36、[测试策略](../../../docs/testing-strategy.md) J25 及 [UI 交接](../../../docs/agent-ui-ux-handoff.md) §5.2/§12。

当前文案混用中文、model 与档案标识，表单默认常驻；四用途与能力字段缺少渐进说明。这里记录为展示缺口，不改写 Agent 模型配置档案的规范定义。SEM-F33 已明确 renderer 可以提交新凭据并仅读取存在性/scope；其他文档“UI 不持有 API Key”的绝对说法按“不读取既有密钥、不持久化或外泄输入草稿”理解，不能以此另建凭据流程。

参考 [CC Switch 添加供应商指南](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/zh/2-providers/2.1-add.md) 的预设填连接、设置 API Key、获取模型思路（2026-09-13 查阅）。TMSpeech 仅作为用户提出的参考方向，尚未核定具体版本的模型/API 设置表面，不据此新增需求。本项目首版只有现有 DeepSeek 模板和自定义 OpenAI-compatible 连接，不能照搬其他协议或默认模型。

## Goals / Non-Goals

**Goals:** 用户能看懂此页用途、理解服务连接与模型的关系，并沿顺序配置默认模型；已有用户可快速管理服务及用途；失败给出基于既有事实的下一步说明。

**Non-Goals:** 增加未登记的协议或任意动态 provider；自动探测并覆盖用户能力；保存时隐式联网；模型自动切换；价格比较；个人上下文或 Agent Bar 全面文案改写。预设只覆盖下文登记的三家服务，独立模型测试不等同于完整任务质量验收。

### 首次配置向导与服务预设

首次没有已保存模型时，页面进入连接→API 密钥→模型确认→测试与默认用途四步向导；测试可跳过，默认用途仍须用户明确设置。已有配置进入管理页，可主动为新服务启动同一向导。向导草稿只存在 renderer 内存，离开或取消时清除，逐步保存仍使用既有九条命令和 `expectedRevision`。

首批预设由产品随版本发布、带稳定 ID、来源日期、帮助标识、地域和策略版本。以下值是实现时必须登记的初始 registry（能力数字是本应用上限，不是厂商极限）：

| presetId@version | 服务/地域 | model | origin + base path | 固定请求策略 | 六字段应用能力 |
|---|---|---|---|---|---|
| `deepseek-openai@1` | DeepSeek（未指定地域） | `deepseek-v4-flash` | `https://api.deepseek.com` + `/` | `/chat/completions`；固定 `thinking: {type: "disabled"}`；流式 usage 按 provider 规则请求 | `128000/8192/true/true/true/true` |
| `openai-gpt-4.1-mini@1` | OpenAI（未指定地域） | `gpt-4.1-mini-2025-04-14` | `https://api.openai.com` + `/v1` | `/chat/completions`；OpenAI-compatible JSON Object、流式 usage | `128000/8192/true/true/true/true` |
| `qwen-beijing@1` | 通义千问（中国内地北京） | `qwen-plus` | `https://dashscope.aliyuncs.com` + `/compatible-mode/v1` | `/chat/completions`；固定 `enable_thinking: false`；仅北京能力声明 | `128000/8192/true/true/true/true` |

每个 registry 项还必须包含 `sourceSnapshotDate`（DeepSeek `2026-08-30`；OpenAI、Qwen `2026-09-13`）、`helpId`（`deepseek-api-key` → `https://platform.deepseek.com/api_keys`；`openai-api-key` → `https://platform.openai.com/api-keys`；`qwen-beijing-api-key` → `https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key`）、`region`（`unspecified`/`cn-beijing`）和 `strategyVersion: 1`。renderer 只读取公开投影，不提交或拼接策略字段。`@1` registry 项及其 strategyVersion 永久不可变；新增策略只能使用新的 preset ID/version。预设适用条件是精确的 origin、base path、model 和地域 metadata；不满足时回到自定义模型，不猜测能力。向导创建预设服务时使用保留的 `preset.<presetId>` 配置标识；该标识只能与登记项的服务名称和 canonical connection 一起创建，用户自定义配置即使使用相同服务商、连接和 model 也不能占用该标识。自定义 model 固定使用不可变的 `openai-compatible@1` 策略；model row 保存 `presetIdentity`（可空）与 `requestStrategy`，正式 binding 同时保存 `requestStrategy`，因此通过保存时的精确 identity 解析策略并将既有绑定视为已冻结事实，后续 registry 增补只能新增 identity，不能改写旧 identity。该元数据由追加 model-access migration 写入，既有 migration checksum 不改写。

预设能力标为“本应用配置上限”，不宣称模型极限。第一步保存服务连接，第二步显式保存 API 密钥；选择预设和填入建议在此之前都只是向导草稿。第二步提交凭据是唯一凭据写入时机；第三步确认前只禁止写入 model、能力和用途。第三步的一次确认才写入 model 与六字段；预设更新不会覆盖既有 model、用途或 binding。北京地域密钥、域名和模型能力不可与其它地域混用。选择 DeepSeek 预设不会把 `deepseek-openai-template@1` 的空 model 自动写成已配置 model。

### 独立模型测试

设置层 `agent-model-test-ui@1.0.0` 的 `testSavedModel` 精确接收 `{contractId, contractVersion, profileId, modelId, expectedRevision, testId}`；`testId` 为 renderer 生成的有界不透明标识，仅用于取消和迟到结果关联。请求不接受 endpoint、header、prompt、budget、credential slot 或 `runId`，不调用 `bind()`、不写 `changed`。独立 `cancelSavedModel` 精确接收 `{contractId, contractVersion, testId}`，窗口关闭、renderer 卸载和该取消命令都使挂起请求收束为 `cancelled`；main 必须丢弃已过期 `testId` 的迟到结果。response envelope 恰为 `{contractId, contractVersion, testId, ok, status, nextAction}`；`status` 闭集为 `success | invalid_request | revision_conflict | credential_unavailable | auth_failed | timeout | rate_limited | redirect_rejected | response_invalid | remote_unavailable | cancelled`，`nextAction` 闭集为 `none | reload | set_credential | edit_connection | check_model | retry`，映射固定为：`success→none`、`invalid_request/redirect_rejected→edit_connection`、`revision_conflict→reload`、`credential_unavailable/auth_failed→set_credential`、`response_invalid→check_model`、`timeout/rate_limited/remote_unavailable→retry`、`cancelled→none`。`expectedRevision` 比较 live catalog revision；不一致时不发网络请求。main 读取 live profile、model、预设策略和 vault 凭据后发出一次固定 JSON Object Chat Completions 请求，最多 256 输出 Token、30 秒、64 KiB 响应；不带字幕或个人上下文，不创建交互历史/记忆/报告，不保存响应正文，不自动重试或切换服务。结果只在当前页面内存保留；成功只表示收到符合协议的响应，不表示所有能力、任务质量或长期稳定性已验证。正式调用或 remote catalog 的 401/403 仍按 SEM-F33 失效对应凭据档案；独立模型测试只返回 `auth_failed`，不得清除凭据、修改 revision 或发 `changed`。

#### 测试 contract 的竞态与固定策略

`agent-model:test-saved-model` 与 `agent-model:cancel-saved-model` 是 settings-only IPC channel；`testId` 必须匹配 `/^[A-Za-z0-9._:-]{1,64}$/`。响应的 `ok` 恰为 `status === 'success'`，且 `nextAction` 必须按状态固定映射，未知字段一律拒绝。main 为每个 `testId` 保留一个有界 pending 记录；未知或已终态的取消请求按幂等规则返回 `cancelled`，同一请求中 cancel 与 provider 结果竞争时先收束者获胜，之后的结果丢弃，renderer 只等待该终态而不能用取消回执覆盖 provider 结果。请求发出前和 provider 返回后都比较 live catalog revision；后一次不一致时丢弃响应并返回 `revision_conflict/reload`，不向页面提交旧配置的成功。策略请求体固定为：三家预设沿各自登记项添加 `thinking: {type: "disabled"}`（DeepSeek）或 `enable_thinking: false`（通义千问北京），OpenAI 不添加厂商字段；基础字段只有 `model/messages/max_tokens`，独立测试固定使用 JSON Object 响应格式（自定义模型即使声明不支持也不猜测厂商字段，收到拒绝按闭集失败返回），正式调用仅在 `supportsStructuredOutput=true` 时添加 `response_format`。所有策略均拒绝 redirect、自动重试和模型切换；重复 registry identity 必须在构建校验时拒绝。正式/目录鉴权失效清理必须匹配发起时的 `credentialSlotId + profileRevision`；整个 `preset.` 标识命名空间由存储边界保留。

## Decisions

### 展示文案映射

下面是 UI 展示别名，规范文档、数据字段与测试归因仍使用 CONTEXT 术语，不作全仓术语替换。

| 规范概念或既有字段 | 界面文案 | 说明 |
|---|---|---|
| Agent 模型配置档案页面 | Agent 模型 | 导航与页面标题一致；保留现有导航 ID |
| Agent 模型 provider | 模型服务商 | 指提供推理服务的一方，不等同于一个模型 |
| Agent 模型配置档案 | 服务配置 | 一份连接和 API 密钥可配置多个模型；同一服务商可有多份配置 |
| createProfile / updateProfile | 添加模型服务 / 编辑连接 | 新建默认折叠，以明确按钮打开 |
| credential | API 密钥（API Key） | 从所选服务商控制台获取；只设置新值或清除，既有密钥不回显 |
| httpsOrigin | API 服务器地址 | 输入服务商提供的 HTTPS 服务器地址，此项不含路径 |
| basePath | API 基础路径 | 通常为 `/v1`，以服务商文档为准；现有 DeepSeek 模板保持 `/` |
| profileId | 高级设置 → 配置标识 | 自动推导，冲突/非法时展开并说明；现有标识不可改 |
| modelId | 模型名称（Model ID） | 填服务商给出的精确模型标识，不是任意显示名称 |
| 模型用途 | 按用途指定模型 | 四个槽位仍叫默认、信息提取、摘要与总结、分析与规划 |
| fallback_default | 使用默认模型 | 显示实际解析的服务配置与模型；默认未配置时不能假装已解析 |
| ready | 配置信息齐全 | 附注“尚不代表已连接服务或成功调用模型” |

页面说明固定为：“为 Agent 配置模型，用于问答、摘要和分析。实时字幕无需配置这里的模型。”服务区说明：“一个模型服务可以配置多个模型，共用该服务配置中的 API 密钥。”仅在可能发送正文的既有开关/运行入口沿用原云端披露，不用此说明代替披露或开启开关。

### 信息顺序与编辑方式

- 未配置默认模型：顶部用途说明与当前缺项 → 模型服务列表（首次保留空模型 DeepSeek 模板）和“添加模型服务” → 当前服务内的连接、API 密钥、模型列表 → 默认模型 → 折叠的“按用途指定模型”。默认配置充分时，顶部在说明后优先显示默认服务配置/模型摘要，再列服务管理。
- 点击添加才展开连接表单。保留两个地址字段，避免本切片承担 URL 拆分和规范化语义；模板预填后仍展示有效地址，用户明确保存。基础路径可放连接高级区，但摘要必须显示地址与路径组合，编辑时可达。
- 连接保存成功后才展示该档案的密钥与模型操作；密钥设置、添加模型、用途分配仍分别等待各自 CommandResult。中途失败保留已成功写入的阶段，说明本次失败对象，不把多步流程伪装为原子“一键保存”。
- 模型列表提供“获取模型列表”和“手动添加模型”。目录按钮旁说明“获取结果只用于填写，确认后才会保存”；进入页面、展开分组、切换服务、reload 均不自动请求网络。使用建议只填草稿，不自动保存。
- 添加/修改模型时单独显示“确认模型能力”，展示来源日期（若有）和所有六字段。布尔项初始未知，未知不能当作“不支持”；应用建议后仍由用户核对并点击“确认并保存模型”。不能默认接受来源不明参数。
- 默认用途独立可见；三个专用用途折叠，每项明确“使用默认模型”或具体二元组。用户必须主动设置默认；新增模型不隐式分配任何用途，不改已存在的专用用途。
- 展开/取消仅改变本地展示；折叠不提交、发网或持久化草稿。自动展开包含校验错误的区域并定位字段；可及名称、Tab 顺序和 DOM 顺序一致。取消/提交后的密钥清理遵守既有机制，不为了保留普通草稿延长敏感草稿生命周期。

### 六项能力帮助文案

| 字段 | 标签与简短说明 |
|---|---|
| maxInputTokens | 最大输入量（Token）：单次请求接受的输入上限，请按服务商说明填写。 |
| maxOutputTokens | 最大输出量（Token）：单次回复允许的输出上限，请按服务商说明填写。 |
| supportsToolCalling | 工具调用：模型能否请求应用提供的受控工具。 |
| supportsStructuredOutput | 结构化输出：模型能否按要求返回指定结构的数据。 |
| supportsStreaming | 流式输出：模型是否支持逐步返回回复。 |
| usageReporting | 用量上报：服务是否返回实际 Token 用量；选“不支持”仍可运行，但交互显示“用量未知”，不能参与用量比较。 |

### 状态与失败说明

API 密钥区区分“未设置 API 密钥”“已设置 API 密钥（保存在本机）”“已设置 API 密钥（仅本次运行有效，重启后需重新设置）”。配置充分不是连接成功；获取目录成功也不是推理成功。

六值 remote 状态保持闭集：成功显示获取事实；revision 冲突提示重新载入；invalid_request 提示检查连接配置；credential_unavailable 提示设置 API 密钥；redirect_rejected 说明跳转已拒绝；remote_unavailable 只说明暂时无法获取列表并保留手动添加。不能由最后一个状态猜测为超时、401 或服务端不支持端点。两值配置错误与读取降级也保留现有事实映射及恢复动作。

## Risks / Trade-offs

- [中文别名混淆服务商和配置档案] → 同一服务商可多配置、同一配置多模型的关系写入帮助与联合旅程；不更改内部标识。
- [折叠隐藏必填内容] → 错误区域自动展开；添加模型时六字段确认始终展示；状态提示指向具体阶段。
- [多步提交被误认为整表成功] → 分别展示回执；失败不撤销已保存连接，也不自动重发或推进用途。
- [照搬预设产生新能力] → 仅沿用 SEM-F33 冻结模板；官方帮助链接若后续提供，须先核定来源并走现有受限外链机制，不接入任意 URL 打开能力。

## Migration Plan

预设 registry 和 test contract 是随应用版本发布的只读代码数据；model row 与 formal binding 的策略元数据通过追加 model-access migration 保存，不修改 v1-v8 migration checksum。已有 profile/model/用途/binding 的可见事实原样保留；旧 model 默认采用兼容策略，新版本只在用户明确选择预设并逐步提交时写入精确 preset identity。回退仅撤销展示、registry 和 test IPC，不删除或重写用户已保存事实。输入框样式 change 仍可先行，但不是本 change 的数据前置条件。

## Open Questions

无阻断本轮文档的待决项。具体参考 TMSpeech 版本和额外供应商预设留作后续独立需求，不影响当前有界规划。
