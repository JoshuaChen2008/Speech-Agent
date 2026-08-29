# Agent 模型接入接口冻结提案

> 性质：设计对齐草案（冻结提案）。**尚未回填权威文档，因此尚未登记为“已决定”，尚未进入正式实现。** 第 2 节的 M1–M12 需要负责人逐项确认或修订；其中 M2、M7、M8、M10 是本文件发现的既有文档冲突或既有调研结论收窄，已在该项内单独标注。
>
> 依据：`docs/semantic-contract.md`（`SEM-F25/F28/F33`、`SEM-T15`、D9/D10/D11/D14 子边界）、`docs/data-architecture.md`（`agent_model_profiles`、`agent_model_purpose_assignments`、`agent_model_run_bindings`、`formal_agent_interactions`、第 4.2 节错误闭集）、`docs/testing-strategy.md`（`J25` 与第 4 节不变量）、`docs/research/fixed-recipe-and-tool-freeze-draft.md`（§4 用途映射、§5.3 十轴预算、§5.6 升级阈值、§7 前瞻）、`docs/research/agent-harness-reference-notes.md`（Pi 一手结论）、现有实现 `src/agent-provider/provider-bootstrap.js`、`src/agent-provider/model-provider-registry.js`、`src/agent-core/formal/model-gateway.js`。
>
> 日期：2026-08-29
>
> 前置：`docs/research/fixed-recipe-and-tool-freeze-draft.md` 的 13 项决定已确认并已回填权威文档。本文件是交接文档待做事项 4。

---

## 1. 冻结对象与不冻结对象

本轮冻结 Agent 模型接入层的**对外接口、身份模型、能力闭集、凭据生命周期、价格与用量事实、Pi 依赖边界**。

不在本轮冻结：具体 HTTP 请求体拼装、Pi 版本锁定、设置界面视觉布局、实现文件划分、SQL migration 语句。这些属于待做事项 5 的实现 SPEC。

本轮也不动旧 Agent 一行代码。第 12 节只登记迁移关系，不执行迁移。

---

## 2. 需要负责人裁决的开放项

| 编号 | 问题 | 接管者建议裁决 | 性质 |
|---|---|---|---|
| **M1** | `catalog()` / `configure()` / `bind()` 三个接口的精确职责与调用方 | 见第 3 节：三接口都只由 main 拥有；renderer 经 exact IPC 只能读公开投影和提交闭集命令；recipe 与 Agent utility 都不得调用 `catalog()`/`configure()` | 补齐 |
| **M2** | 一个配置档案对应一个 model 还是多个 model | **既有文档冲突**：`SEM-F33` 与 `J25` 说“分别保存多个模型”“精确 `(profileId, modelId)`”，但 `data-architecture.md` 的 `agent_model_profiles` 只有单个 `model` 列。建议裁定为**一个档案 = 一个受信任连接 + 一份凭据 + 一组 model**，另立 `agent_model_profile_models`，档案行不再持有 `model`。理由见第 4.1 节 | 冲突消解 |
| **M3** | `https_origin` 是否包含路径 | 拆成 `https_origin`（scheme+host+port，用于 exact origin 校验与 redirect 拒绝）与 `base_path`（默认 `/v1`，不含查询与片段）。现有实现只有一个 `baseUrl`，无法同时做 exact origin 校验和兼容不同厂商路径 | 补齐 |
| **M4** | 能力（capability）闭集包含哪些字段，以及能力不匹配如何收束 | 六字段闭集；只有 `supportsToolCalling` 是硬性绑定条件（仅 Agent Loop 需要），其余只记录或推导预算。见第 5 节 | 补齐 |
| **M5** | 凭据槽与档案的对应关系、`safeStorage` 不可用时的行为 | 一档案一槽，不跨档案共享；不可用时只允许本次应用会话，公开状态必须同时暴露布尔存在性与作用域枚举。见第 7 节 | 补齐 |
| **M6** | 模型运行绑定要冻结哪些字段 | 见第 6 节列清单；`budget_json` 必须承载十轴预算，`capability_json` 承载六字段能力，另增 `credential_slot_id` 以保证运行中档案被改动后借用仍可复现 | 补齐 |
| **M7** | 是否实现远端模型目录刷新（Pi `fetchModels`） | **收窄**：首版不做自动刷新。理由：自动刷新会在用户无任何动作时改变 `catalog_revision`，并要求在设置阶段就动网络与凭据。只提供用户明确触发、失败零写入的一次性“拉取候选模型”动作，结果仅作为**建议列表**呈现，用户勾选后才写入档案并推进 `catalog_revision`。注意：权威文档目前**没有**任何目录刷新相关的验收项，因此这条需要在 `J25` 新增覆盖（见第 13 节），不是既有覆盖的延续 | 收窄 |
| **M8** | 是否使用 Pi 的 `envApiKeyAuth()` | **收窄既有调研结论**：`agent-harness-reference-notes.md` 把 `envApiKeyAuth()` 列为可复用，但它从 `process.env` 发现凭据，与 `SEM-F33`（凭据只经 `safeStorage`、Agent utility 只取有界调用副本）直接冲突。建议**明确禁用**，改用只读取本次调用副本的自有 auth resolver。见第 9 节 | 收窄 |
| **M9** | 用途未配置时的回落与全空时的收束 | 专用用途为空回落到“默认”；“默认”也为空时投影为 `provider_not_configured`，不创建任务、不进入 `agent_jobs` | 补齐 |
| **M10** | 费用估算在哪个进程计算 | **在 main 计算，不在 Agent utility 计算。** Agent utility 只回传原始用量与用量来源；价格目录、`pricing_revision` 与 `cost_estimate_json` 只存在于 main。理由：utility 没有 SQLite、没有价格目录、且被设计为不拥有任何 durable 事实 | 补齐 |
| **M11** | 确定性测试替身的形状与可达性 | 采用 Pi `fauxProvider()` 形状的第一方替身，只在测试构建注册，生产构建不存在动态注册路径；`test:core`、`test:integration` 与后续 eval 共用同一个替身 | 补齐 |
| **M12** | 旧 `DEEPSEEK_API_KEY` 环境入口如何处置 | **作为凭据来源删除，作为环境净化规则保留。** D9 的“大小写等价键无条件全删、child 环境只从净化快照复制”继续作为加固不变量，只是不再有任何代码把它读成凭据 | 补齐 |

---

## 3. 三接口冻结

三个接口都由 main-owned 的 Agent 模型接入层实现。renderer 经 exact IPC 只能触达 `catalog()` 的公开投影与 `configure()` 的闭集命令；`bind()` 只由 Agent 执行宿主在运行创建期调用，renderer 与 recipe 都不可见。

### 3.1 `catalog()` — 只读公开投影

返回值不含任何凭据明文、请求 header、完整 URL 拼装结果或内部 recipe ID。

```text
catalog() → {
  schemaVersion: integer ≥ 1,
  pricingCatalogRevision: integer ≥ 0,
  profiles: [ {
    profileId: string,
    revision: integer ≥ 0,
    label: string,                       // 用户可见名称
    adapterId: "openai-compatible",
    apiStyle: "openai-chat-completions",
    httpsOrigin: string,                 // scheme+host+port
    basePath: string,                    // 默认 "/v1"
    isPreset: boolean,                   // DeepSeek 预置档案为 true
    catalogRevision: integer ≥ 0,        // 该档案已保存模型清单的版本
    credential: {
      present: boolean,
      scope: "persisted" | "session_only" | "absent"
    },
    models: [ {
      modelId: string,
      capability: <第 5 节六字段>,
      pricing: { source: "static_catalog" | "profile_override" | null,
                 revision: integer | null }
    } ]                                  // ≤ 32 条
  } ],                                   // ≤ 16 条
  purposes: [ {
    purpose: "default" | "extraction" | "summary" | "analysis_planning",
    profileId: string | null,
    modelId: string | null,
    expectedProfileRevision: integer | null,
    effective: { profileId, modelId } | null,   // 已回落解析后的实际目标
    fallbackToDefault: boolean
  } ]                                    // 恰好 4 条
}
```

固定不变量：

- `profiles` 与 `purposes` 长度上界固定；`purposes` 永远恰好四条，不因未配置而缺项。
- `pricing.revision` 为 `null` 表示该 model 无已登记单价；界面必须显示为“无单价，无法估算费用”，不得显示 0。
- 不返回 `credentialSlotId`、`pricing` 的具体数值、`process.env` 任何内容。
- 该投影是纯读操作：调用它不得触发网络、不得刷新目录、不得解密凭据。

### 3.2 `configure(command)` — 闭集命令

命令闭集恰好 9 条，全部要求 `expectedRevision` 并在冲突时零写入：

| 命令 | 语义 | 冲突/失败 |
|---|---|---|
| `createProfile` | 建立新档案（label、httpsOrigin、basePath） | 重复 `profileId` 或非 HTTPS origin → `MODEL_CONFIG_INVALID`，零写入 |
| `updateProfile` | 改 label / basePath | `expectedRevision` 不匹配 → `MODEL_CONFIG_REVISION_CONFLICT`，零写入 |
| `deleteProfile` | 删除档案及其模型清单与凭据槽 | 只影响未来运行；既有绑定与产物保留不可变模型身份 |
| `addModel` | 向档案加入一个 `modelId` 及能力 | 重复 `(profileId, modelId)` → `MODEL_CONFIG_INVALID` |
| `updateModel` | 改能力或单价覆盖 | 同上；推进 `catalogRevision` |
| `removeModel` | 移除一个 `modelId` | 若正被某用途引用，必须同一事务内把该用途清空并推进用途 revision |
| `setCredential` | 写入新凭据 | 只接受写入，永不读回；成功后只回布尔与作用域 |
| `clearCredential` | 删除凭据 | 相关档案立即显式不可运行 |
| `assignPurpose` | 把一个用途绑到 `(profileId, modelId)` 或清空 | 目标不存在 → `MODEL_CONFIG_INVALID` |

固定不变量：

- `httpsOrigin` 必须是 `https:`；`basePath` 必须是不含查询、片段与 `..` 的绝对路径。
- 首版 `adapterId`/`apiStyle` 固定，不接受命令写入；任意第三方不得动态注册 adapter。
- 所有命令都是原子替换；失败一律零写入，不留部分配置。
- `setCredential` 的入参在写入或失败后都必须尽力清零；不得进入日志、报告、错误消息或 IPC 回值。
- `configure()` 不改变任何既有 `agent_model_run_bindings` 与既有产物。

### 3.3 `bind(runRequest)` — 运行创建期一次性冻结

```text
bind({ runId, recipeId, recipeVersion, executionForm })
  → 模型运行绑定（第 6 节列清单），或按第 10 节收束为显式不可运行
```

固定不变量：

- 调用者只给 recipe 身份与已判定的执行形态，**不给** profile、model、URL、header、预算或凭据；这些一律由接入层解析。
- 一个 `runId` 至多一条绑定，写入后不可改写。自动重试复用同一绑定；用户主动换模型必须新建 `runId`。
- 解析顺序固定：recipe → 用途（静态全映射）→ 用途指派 → 回落默认 → 档案 + model → 能力校验 → 预算推导 → 价格解析 → 凭据槽解析。任一步失败即 fail closed，不进入下一步。
- `bind()` 只在 main 执行并落库。Agent utility 收到的是绑定的只读投影加本次调用凭据副本，**不含** `credentialSlotId`、价格、`pricing_revision`。

---

## 4. 身份模型

### 4.1 档案与模型的基数（M2 冲突消解）

裁定：**一个配置档案 = 一个受信任连接（origin + basePath + adapter/apiStyle）+ 一份凭据 + 一组 model**。

理由：

1. 凭据是按连接发放的，不是按模型发放的。若把档案定义成含单个 model 的三元组，同一个 DeepSeek key 在保存三个模型时会产生三份密文副本，扩大了泄露面，也让 `clearCredential` 语义变成多点删除。
2. `data-architecture.md` 的 `agent_model_purpose_assignments` 已经同时持有 `profile_id` 与 `model` 两列——只有“一档案多模型”才需要这两列同时存在。这说明目标设计原本就是本裁定，档案行上的单个 `model` 列是早期遗留。
3. `J25` 要求“精确 `(profileId, modelId)`”，与 Pi 的 `getModel(providerId, modelId)`（`model.id` 只在其 `provider` 内定位）形状一致，无需额外映射层。

因此 `agent_model_profiles` 去掉 `model` 列，另立 `agent_model_profile_models`；`(profile_id, model_id)` 唯一。这只是登记逻辑事实，物理表名与列名仍可在实现 SPEC 中收紧。

### 4.2 与 Pi 身份的对应

| 本产品 | Pi | 说明 |
|---|---|---|
| 配置档案 `profileId` | `Provider.id` | 一档案在 Pi 实例级 `Models` 中注册为一个 provider，`setProvider()` 按 id upsert |
| `(profileId, modelId)` | `getModel(providerId, modelId)` | 精确二元组，无路由、无 fallback |
| `httpsOrigin + basePath` | `Provider.baseUrl` / `Model.baseUrl` | 组合后交给 Pi；exact origin 校验在本产品侧完成 |
| `apiStyle` | `Model.api` | 首版固定单一 wire API |
| 调用级凭据副本 | 请求级 `apiKey` | 由自有 auth resolver 提供，不经环境变量 |
| 模型运行绑定 | 低层 `Agent` run 快照中的具体 `Model` | 本产品不实现 `prepareNextTurn` 的模型替换，因此“整次运行固定”成为不变量 |

Pi 的 `Models` 集合是每次运行按绑定现场组装的短生命周期对象，不是长期注册表；它不持久化，也不作为公开目录的事实来源。

### 4.3 四个用途

`purpose` 闭集恰好四值：`default`、`extraction`、`summary`、`analysis_planning`，分别对应界面上的“默认、信息提取、摘要与总结、分析与规划”。

- 四者必须能各自绑定不同 `(profileId, modelId)`；摘要与总结指向低成本小模型、分析与规划指向更强模型是首要支持场景。
- recipe → purpose 是静态全映射（见固定 recipe 冻结 §4），不可配置、不向用户展示。
- 专用用途为空时回落到 `default`，且 `catalog()` 必须以 `fallbackToDefault=true` 显式呈现，不得让用户误以为已单独配置。

---

## 5. 能力闭集（M4）

`capability_json` 恰好六字段：

| 字段 | 类型 | 用途 | 缺失/为假时 |
|---|---|---|---|
| `maxInputTokens` | integer ≥ 1 | 推导预算第 2 轴（单次请求输入 token 上限） | 必填。升级阈值的 70% 基数是**预算第 2 轴**，不是本字段本身；缺失本字段则第 2 轴无法推导、阈值无法计算，`bind` 拒绝 |
| `maxOutputTokens` | integer ≥ 1 | 推导预算第 4 轴的上界 | 必填 |
| `supportsToolCalling` | boolean | Agent Loop 的**硬性**绑定条件 | `executionForm='agent_loop'` 且为假 → `bind` 拒绝 |
| `supportsStructuredOutput` | boolean | 只影响请求构造与界面标注 | 为假时仍可运行；宿主照常做 Schema 校验，校验失败计 `AGENT_OUTPUT_INVALID` |
| `supportsStreaming` | boolean | 只记录 | 首版结果是结构化 JSON，不依赖流式；不作为绑定条件 |
| `usageReporting` | `"provider" \| "none"` | 决定用量来源 | `"none"` 时用量一律为确定性估算并标记 `usageSource="estimated"` |

固定不变量：

- 能力由用户在档案内为每个 model 声明，或由静态预置目录提供默认值；接入层不猜测、不探测。
- 能力不匹配是配置问题，不是瞬时故障：`bind` 前由资格投影为 `provider_not_configured`，让用户在设置里看到；若绕过资格直接运行，收束为 `AGENT_REQUEST_INVALID`（不重试），不得使用 `AGENT_PROVIDER_UNAVAILABLE` 冒充可重试。
- 首版不加入 Gemini、Anthropic 原生 adapter，也不加入第二种 wire API。

---

## 6. 模型运行绑定的冻结列（M6）

`agent_model_run_bindings` 目标列：

```text
run_id, purpose, profile_id, profile_revision, adapter_id, api_style,
https_origin, base_path, model_id, capability_json, budget_json,
pricing_revision, pricing_source, credential_slot_id, created_at
```

相对 `data-architecture.md` 现有登记的增量：`api_style`、`base_path`、`pricing_source`、`credential_slot_id`，并把 `model` 更名为 `model_id` 以对齐 `(profileId, modelId)`。

- `budget_json` 必须承载固定 recipe 冻结 §5.3 的十轴全部数值，包含由 `maxInputTokens` 推导的第 2 轴与由 `maxOutputTokens` 约束的第 4 轴。
- `credential_slot_id` 是不透明槽 ID，不是密文也不是密钥引用路径；它保证运行期间档案被改动或删除后，借用行为仍可复现。槽已不存在时收束为 `AGENT_PROVIDER_AUTH_FAILED`（按既有映射直接 `failed`，不重试）。
- `pricing_source` 与 `pricing_revision` 成对；两者为 `null` 表示无单价，费用估算固定为 `null`。
- 绑定行写入后不可改写。删除或修改配置档案只影响未来运行；既有绑定与产物保留不可变模型身份。

---

## 7. 凭据生命周期（M5、M12）

- **一档案一槽**，不跨档案共享，即使两个档案指向同一 origin。删除档案在同一事务内删除其槽。
- 主进程通过 `safeStorage` 加密保存。加密不可用时 `scope="session_only"`，只允许本次应用会话使用，重启后显式变回 `absent` 并要求重新输入。
- renderer 只能**写入**新凭据与**读取布尔存在性加作用域枚举**，永不读回明文。
- Agent utility 只取得当前调用的有界副本，收束（成功、异常、取消、超时）后尽力清零；副本不得经环境变量、argv、日志、报告或普通事件传入。
- 稳定鉴权失败使该槽失效；408/429/网络/5xx、取消、预算耗尽与无效结构化输出**不得**清除凭据。
- child 环境必须来自启动时已净化的快照。D9 规则完整保留：启动环境中大小写等价于 `DEEPSEEK_API_KEY` 的项无条件全部删除，多个等价键属歧义输入。**变化在于：删除后不再有任何代码把它读成凭据来源。** 环境净化从“凭据引导的一部分”降级为纯加固不变量。

---

## 8. 价格目录与用量事实（M10）

- 价格目录是**随应用发布的静态目录**，键为 `adapter + 受信任 origin 类别 + model_id`，带单调递增整数 `revision`。允许每档案可选覆盖，覆盖形成 `pricing_source="profile_override"` 并以档案 `revision` 参与复现。
- token 用量优先取 provider 返回；缺失时使用保守高估的确定性估算 `ceil(canonicalUtf8Bytes / 2)`，并标记 `usageSource="estimated"`。估算永不伪装成 provider 返回。
- **计算位置**：Agent utility 只回传原始用量与用量来源。价格目录、`pricing_revision` 与 `cost_estimate_json` 只存在于 main。费用在运行收束时由 main 一次性算出并冻结写入用量事实。
- 历史与导出只读取冻结值，**任何时候都不重算**。缺少单价时估算为 `null`，不猜测，且始终标注为估算。
- 价格目录 revision 升级后，既有交互的费用与重复导出字节必须完全不变。

---

## 9. Pi 依赖边界（M8）

**允许直接使用**：

- `@earendil-works/pi-ai` 的实例级集合接口 `createModels()` / `setProvider()` / `getModel()`；
- `createProvider({ id, baseUrl, headers?, auth, models, api })` 形状；
- OpenAI-compatible provider factory 的**独立子路径**导入；
- 请求取消；
- 采用 Pi loop 时，只把 `models.streamSimple.bind(models)` 注入 `@earendil-works/pi-agent-core`；
- `fauxProvider()` 形状的确定性替身（仅测试构建，见第 11 节）。

**明确禁用**：

- `envApiKeyAuth()`——它从 `process.env` 发现凭据，与第 7 节的 `safeStorage` 加调用级有界副本边界直接冲突。改用只读取本次调用副本的自有 auth resolver。**这一条收窄了 `agent-harness-reference-notes.md` 把它列为“可直接复用”的表述。**
- `@earendil-works/pi-ai/providers/all` 的 `builtinModels()`——官方标注的 heavy entrypoint，会注册全部内置 provider；
- 将被移除的 `/compat` 全局 API；
- `@earendil-works/pi-coding-agent` 的 `ModelRuntime` / `ModelRegistry`、`models.json` 热加载、`auth.json` / OAuth 登录 UI、home-dir 约定；
- `prepareNextTurn` 的模型替换路径（不实现即得到“整次运行固定”不变量）；
- provider-specific 的网关 routing 字段（OpenRouter / Vercel Gateway 等）。

**所有权划分**：Pi 负责 OpenAI-compatible 协议适配与请求派发。配置持久化、凭据、用途映射、运行冻结、能力校验、预算、权限、用量与审计一律由本产品拥有。Pi 仓库为 MIT，若移植 substantial portions 必须保留版权与许可声明；优先直接依赖公开小接口而非复制会漂移的 coding-agent 实现。

---

## 10. 错误与资格映射

接入层不新增任务错误码闭集。映射固定为：

| 情形 | Agent 处理资格 | 显式运行时的任务错误码 |
|---|---|---|
| 无任何档案，或“默认”用途未配置 | `provider_not_configured` | `AGENT_REQUEST_INVALID` |
| 档案存在但能力不满足（Agent Loop 缺工具调用、缺 `maxInputTokens`） | `provider_not_configured` | `AGENT_REQUEST_INVALID` |
| 凭据缺失、`session_only` 已失效、槽已删除 | `credential_unavailable` | `AGENT_PROVIDER_AUTH_FAILED` |
| 云端档案且云端披露未接受 | `cloud_disclosure_required` | 不创建任务 |
| 稳定鉴权失败 | — | `AGENT_PROVIDER_AUTH_FAILED`（失效该槽，直接 `failed`） |
| 429 / 408 / 网络与 5xx | — | `AGENT_PROVIDER_RATE_LIMITED` / `_TIMEOUT` / `_UNAVAILABLE`（`max_attempts` 内重试，保持同一绑定） |
| 任一预算轴耗尽 | — | `AGENT_BUDGET_EXCEEDED`（不重试） |

资格闭集不扩大，仍是既有 9 值。`configure()` 的失败使用独立于任务错误码的配置错误码 `MODEL_CONFIG_INVALID` / `MODEL_CONFIG_REVISION_CONFLICT`，不与任务闭集互相复用。

---

## 11. 测试替身与 eval 前瞻（M11）

- 采用 Pi `fauxProvider()` 形状的第一方确定性替身，实现同一 auth resolver 与同一 exact 模型句柄形状。
- **只在测试构建注册。** 生产构建不存在动态 adapter 注册路径，替身不可达；这与“不得让任意第三方代码动态注册 adapter”是同一条约束的两面。
- `test:core`、`test:integration` 与后续模型 eval 共用同一替身，避免第二套 mock 漂移。
- eval 的输入优先取确定性单交互导出（已含 recipe 身份、input digest、执行形态、用量来源、比较组 ID），不新建 eval 专用表；这与固定 recipe 冻结 §7 的“列现在决定、表以后可加”一致。
- 需要在首版就落地、以免二次 migration 的字段已在固定 recipe 冻结 §7 与本文件第 6 节登记齐。

---

## 12. 与现有实现的迁移关系

**保留为迁移素材（可靠性不变量，值得原样继承）**：

- `provider-bootstrap.js` 的 `exactObject()` 精确键校验风格；
- `withCredential()` 的有界借用、借出副本记账与 `fill(0)` 清零；
- 稳定鉴权失败触发 `invalidateCredential()`；
- `model-provider-registry.js` 的 `operationControl()` 取消与超时合流、`waitForOperation()`；
- 冻结的 exact 模型句柄 `{ model, streamFn }`，不携带 `apiKey` 或任意额外字段；
- registry 只接受第一方 adapter 描述，拒绝 duck typing 替身；
- `getChildEnvironment()` 的净化快照。

**必须替换**：

| 现状 | 目标 |
|---|---|
| `DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG` 硬编码单个 DeepSeek provider | 多档案 + 每档案多 model；DeepSeek 只是可修改预置档案 |
| `validateAgentProviderConfigCatalog()` 断言 `providers.length === 1`、`providerId === 'deepseek'`、`baseUrl === 'https://api.deepseek.com'` | 按第 3.2 节命令闭集校验任意 OpenAI-compatible 档案；origin 只校验 `https:` 与 exact 匹配，不写死厂商 |
| `CREDENTIAL_ENV_NAME = 'DEEPSEEK_API_KEY'` 作为凭据来源 | 每档案 `safeStorage` 槽；环境净化保留，环境读取删除（M12） |
| `getProviderConfig()` 返回单一配置 | `catalog()` 公开投影 + `bind()` 冻结绑定 |
| `resolve({ runId, providerId, providerKind, model, recipeVersion })` 与单一 configuration 逐字段比对 | `bind({ runId, recipeId, recipeVersion, executionForm })`，由接入层解析用途与档案 |
| 配置项 `maxChunkInputBytes` / `maxResultBytes` / `timeoutMs` 混在 provider 配置里 | 拆入 `capability_json`（模型固有能力）与 `budget_json`（十轴运行预算）；`maxResultBytes` 移交工具登记（上限 64 KiB） |
| `providerKind` 由 provider 配置直接给出 | 由 `httpsOrigin` 是否为本地环回**推导**并冻结，仍只允许 `cloud`/`local`，继续服务本地资源让行 |

旧 `AgentPluginHost`、`MemoryReader`、三项自动任务、隔离调试入口在负责人评审通过前不动一行。本节只是登记关系，不执行迁移。

---

## 13. 待回填的登记项

确认后需要回填：

| 目标文件 | 回填内容 |
|---|---|
| `CONTEXT.md` | 「Agent 模型配置档案」定义按 M2 改为“一个受信任连接 + 一份凭据 + 一组 model”；「模型运行绑定」补入 `api_style`/`base_path`/`credential_slot_id` 与十轴预算 |
| `docs/semantic-contract.md` | `SEM-F33` 补入三接口职责与调用方（M1）、档案↔模型基数（M2）、origin/basePath 拆分（M3）、六字段能力闭集与不匹配收束（M4）、一档案一槽与 `session_only`（M5）、费用只在 main 计算（M10）、`envApiKeyAuth()` 禁用（M8）；`SEM-F25` 补一句 `providerKind` 由 origin 推导 |
| `docs/testing-strategy.md` | `J25` 补入九条 `configure` 命令的冲突零写入、能力不匹配收束为 `provider_not_configured`/`AGENT_REQUEST_INVALID`、用户触发目录刷新失败零写入（M7）、`session_only` 重启后回落、槽删除后既有绑定收束、替身在生产构建不可达（M11） |
| `docs/data-architecture.md` | `agent_model_profiles` 去掉 `model` 列并新增 `base_path`；新增 `agent_model_profile_models`（`profile_id, model_id, capability_json, pricing_override_json`，`(profile_id, model_id)` 唯一）；`agent_model_run_bindings` 增列 `api_style, base_path, pricing_source, credential_slot_id` 并把 `model` 更名 `model_id`；登记 `MODEL_CONFIG_INVALID`/`MODEL_CONFIG_REVISION_CONFLICT` 为独立于任务错误码的配置错误码。全部通过新的追加 migration，既有 migration/checksum 逐字节不变 |
| `docs/research/agent-harness-reference-notes.md` | 在 Pi 复用清单里把 `envApiKeyAuth()` 从“可直接复用”移到“明确禁用”，并注明理由（M8） |

回填完成后进入交接文档待做事项 5（形成实现 SPEC）。
