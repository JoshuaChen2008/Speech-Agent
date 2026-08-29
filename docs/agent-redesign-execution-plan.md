# Agent 重设计实现执行计划

> 状态：已决定 · 2026-08-29
> 权威要求：[SEM-F00](semantic-contract.md)、SEM-F15、SEM-F26、SEM-F28、SEM-F30、SEM-F31、SEM-F32、SEM-F33、SEM-F34、SEM-F35、SEM-T15
> 用户旅程：[J3、J21、J22、J24、J25、J26、J27](testing-strategy.md)
> 架构决策：[ADR 0013](adr/0013-agent-deep-modules-and-execution-host.md)（两个深模块与执行宿主）、[ADR 0014](adr/0014-multi-profile-model-access-layer.md)（多档案模型接入层）、[ADR 0015](adr/0015-retire-old-agent-implementation.md)（旧实现锁定在启动路径之外）
> 本文是 Agent 重设计第三轮的实现 SPEC：它把 ADR 0013–0015 的决策落成切片、迁移、接口与 todo list。它**不重新定义语义**；与 `semantic-contract.md` 冲突时以语义合同为准。
> 冻结理由留档见 [`research/fixed-recipe-and-tool-freeze-draft.md`](research/fixed-recipe-and-tool-freeze-draft.md)（第一轮：固定 recipe 与工具）与 [`research/model-access-interface-freeze-draft.md`](research/model-access-interface-freeze-draft.md)（第二轮：模型接入接口）。两份草案已回填，不再是权威来源。

## 1. 目标结果

实施完成后必须同时取得以下用户可观察结果：

1. 用户在设置里管理**多个** OpenAI-compatible 模型配置档案，每个档案是一个受信任连接加一份凭据加一组模型；DeepSeek 只是可修改的预置档案，不是唯一选项。
2. 用户为「默认、信息提取、摘要与总结、分析与规划」四个模型用途各自绑定一个 `(档案, 模型)`；界面不出现 recipe ID、adapter、factory 或工厂参数。未单独配置的用途显式显示这是回落到默认，而不是静默等同。
3. 用户在 Agent Bar 选择当前选区、终态会话、日期范围或项目，输入一句自然语言意图，得到问答、分析报告、规划建议或派生文本；不需要知道背后是哪个 recipe。
4. 终态会话结束后默认**不生成任何报告**，只静默做一次个人上下文摄取；只有用户开启报告自动呈现偏好后，每个满足资格的终态会话才至多自动呈现一次会后结构化纪要，且非模态、无未读角标。
5. 用户能查看、修改、删除、休眠个人上下文条目，并能对一条结果说「记住」或「忘记」；个人记忆与会话经历记录是两类可分别查看的事实。
6. 交互历史每条给出时间戳、范围与模型身份、最终结果和默认折叠的完整工具调用记录；终态详情能导出成一份确定性 JSON，同一交互重复导出字节与 SHA-256 相同。
7. 取消是终态：用户取消后运行有界收束，历史里标明终态理由并保留已发生 attempt 的工具记录，不补造结果。
8. Agent 任何一环失败（未配置、凭据不可用、限流、断网、超时、预算耗尽、worker 退出）都不改变字幕显示、SQLite 字幕历史与导出。
9. 打包安装包不含 `src/agent-core/**`、`src/agent-mvp/**`、`src/agent-provider/**`、`src/agent-runtime/**`；产品入口的模块图不到达其中任何文件。

## 2. 明确不做

- 不做通用 Agent 聊天、任务面板首页或调试聊天作为正式入口。
- 不做插件清单、动态插件发现、第三方插件、权限声明文件或热重载。
- 不做自动远端模型目录刷新；只做用户触发的建议列表拉取，失败零写入。
- 不做环境变量凭据来源；`DEEPSEEK_API_KEY` 一类环境键在启动期无条件删除，只作为加固不变量存在。
- 不做写类工具、shell、任意文件读写、任意网络、外部待办执行、跨机同步。
- 不做 FTS5、embedding、向量库、图数据库或任何不可重建语义索引；个人上下文只做等值匹配。
- 不做流式增量呈现的产品承诺（`supportsStreaming` 只是能力字段，首版不据它改变 UI 契约）。
- 不删除旧 Agent 源码、旧 Agent 表、隔离入口或候选 migration catalog；不建立新旧兼容层、适配器或双写。
- 不修改 v1–v4 的 migration SQL 与 checksum。
- 不在本轮删除 `agent_jobs`、`agent_artifacts`、`memory_*`、`agent_debug_*` 等旧表，也不向它们写入任何新设计的行。

## 3. 现状基线与缺口

### 3.1 启动与打包

| 位置 | 实施前事实 | 目标 |
|---|---|---|
| `package.json` `main` → `src/main.js` | 产品入口**零** Agent 接线；文件内 `Agent` 只出现在三处设备/应用名字符串（`src/main.js:214`–`216`） | 保持为零，并由 J27 守卫断言模块图不到达四棵 Agent 树；新 `src/agent/**` 是唯一被产品入口引用的 Agent 代码 |
| `src/agent-runtime/formal-agent-runtime.js` | 仅被 `scripts/formal-agent-storage-utility-smoke.js` 引用 | 不变；不进入打包 |
| `src/agent-provider/provider-bootstrap.js` | 仅被该脚本、`src/agent-runtime/agent-utility/*` 与三个 `test/integration/formal-*` 引用；启动期断言 `providers.length === 1` 且 `providerId === 'deepseek'` 且 `baseUrl === 'https://api.deepseek.com'` | 不变；新接入层不复用它，也不依赖启动期存在任何 provider 配置 |
| `src/agent-mvp/main.js` | 只能经 `npm run start:agent-mvp` 手动启动，独立 userData/SQLite | 不变；保留手动启动能力（ADR 0015 未选择项） |
| `electron-builder.config.cjs` `files` | 只排除 `src/agent-core/**`、`src/agent-mvp/**`；`src/agent-provider/**` 与 `src/agent-runtime/**` 被打进 asar，而它们 require 的 `src/agent-core/**` 已被排除，是打进包里且一旦加载即失败的死文件 | 四棵树全部排除；`src/agent/**` 显式包含 |
| `scripts/verify-package-layout.js:159` | 前缀白名单只覆盖 `agent-core`、`agent-mvp` | 覆盖四棵树；新增 `src/agent/**` 必须存在的正向断言 |
| `src/main/ipc/channels.js` / `access-policy.js` | 42 个频道，角色闭集 `['caption','toolbar','settings','history']` | 追加 Agent 频道；角色闭集追加 `agent`（Agent Bar 需要可聚焦、不穿透的输入窗，字幕窗锁定时恒穿透、工具条窗是窄控制条，二者都不能承载文本输入） |

### 3.2 SQLite：旧表可复用性逐表结论

这是本轮最硬的基线。`FORMAL_AGENT_MIGRATIONS` 的 v3/v4 把旧 Agent 的三插件闭集写进了 `CHECK` 约束，而 SQLite 的 `ALTER TABLE` 无法放宽 `CHECK`，这些表又是 `STRICT`。逐表结论：

| 旧表 | 能否承载新设计 | 硬阻塞 |
|---|---|---|
| `sessions` / `caption_events` / `segments` / `refinement_session_results` / `legacy_imports` | **可** | 字幕系统权威事实，本轮不动 |
| `session_deletion_tombstones` | **可，需追加列** | 计数列是 `NOT NULL` 的旧五项（job/artifact/debug_thread/memory_evidence/orphan_memory）；新设计删除的是交互、工具记录、经历与个人上下文证据 |
| `agent_claim_receipts` | 技术上可（无外键指向 `agent_jobs`） | 无技术阻塞，但与 ADR 0015 第 4 项「不共享注册表」相悖，且会让新旧共用一个 `claim_idempotency_key` 命名空间 |
| `agent_jobs` | **不可** | `plugin_id IN ('meeting-minutes','memory-extraction','enhanced-transcript')`；`artifact_kind` 三值闭集；强制 `plugin_id`/`artifact_kind`/`recipe_version` 三元组的 `CHECK`；`session_id NOT NULL` 只能表达单会话，而新范围可含 ≥2 会话；`provider`/`model` `NOT NULL`，而模型事实已移到独立绑定表；`error_code` 闭集只有 9 值，缺新增的 `AGENT_BUDGET_EXCEEDED` |
| `agent_artifacts` | **不可，且不需要** | `plugin_id`/`type` 两值闭集 + 十列复合外键指向旧 `agent_jobs`；新设计的报告就是交互结果（`formal_agent_interactions.result_json`），不新增产物副本表 |
| `memory_scopes` / `memory_items` / `memory_suppressions` | 技术上可 | `memory_items.kind` 七值闭集恰好覆盖新设计所需，无插件锁 |
| `memory_revisions` | **降级可用** | `run_id` 外键指向旧 `agent_jobs(run_id)`；新运行不在该表，只能写 `NULL`，丢失运行归属 |
| `memory_evidence` | **不可** | `plugin_id = 'memory-extraction'`、`recipe_version = 'memory-extraction@1'` 是等值 `CHECK`；`provider`/`model` `NOT NULL`（S1 的摄取无模型）；九列复合外键指向旧 `agent_jobs` |
| `agent_debug_threads` / `agent_debug_messages` | 不需要 | 旧调试聊天为废案 |
| `recognition_terms` / `recognition_term_sets` / `recognition_term_set_members` / `recognition_session_configs` | 可 | 属 J20，不属本轮 |

**结论与取舍。** 五张个人记忆表里有两张（`memory_evidence` 全废、`memory_revisions` 降级）无法无损承载新设计。v4 已有先例证明「新版本内做建新表→搬数据→删旧表」的重建是这个仓库允许的手法（它就是这样把 `memory_suppressions` 从单列主键改成复合主键的），因此技术上可以重建 `agent_jobs` 与 `memory_evidence`。本 SPEC **不这样做**，理由三条：

1. ADR 0015 第 10 项明确「旧 Agent 相关的既有正式表不在本轮删除」，重建包含 `DROP TABLE`。
2. 重建会把新设计的正确性绑在旧表历史上；`agent_jobs.session_id NOT NULL` 与「范围可含多个会话」是结构性冲突，不是约束松紧问题。
3. 用户裁决是「新旧俩套」。让新设计写进旧表就是隐式兼容层。

因此新设计使用**一整套新表**，旧表在生产库里保持为空（旧 Agent 从未在产品路径上运行过，见 3.1）。代价是数据模型里长期并存两组同类表，必须由文档与守卫明确标注哪一组是现行的。

### 3.3 迁移缺口

| 位置 | 实施前事实 | 目标 |
|---|---|---|
| `src/runtime/storage-worker/schema.js` | `FORMAL_AGENT_MIGRATIONS = [...SUBTITLE_BASE_MIGRATIONS(v1,v2), v3 FORMAL_AGENT_SCHEMA_SQL, v4 FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL]` | 追加 v5/v6/v7；v1–v4 的 SQL 与 checksum 逐字节不变；checksum 不匹配继续 fail closed |
| `src/runtime/storage-worker/worker-service.js:28` | 产品 storage worker 选用 `FORMAL_AGENT_MIGRATIONS`；`FormalAgentStore` 惰性 require（第 30–34 行） | 不变（ADR 0015 第 11 项）；新增的新设计 store 同样惰性 require，字幕 `open/append/close/history` 不加载它 |
| `docs/data-architecture.md` | 已登记 `agent_model_profiles`/`..._models`/`..._purpose_assignments`/`agent_model_run_bindings`/`formal_agent_interactions`/`formal_agent_tool_calls`/`session_episodes`（目标） | 补登记 `formal_agent_runs`、`personal_context_*` 七表；把 `session_episodes` 更名为 `personal_context_episodes`；把 `agent_jobs`/`agent_artifacts`/`memory_*` 行标为旧实现留存 |

### 3.4 尚未落地的实现面

| 位置 | 实施前事实 | 目标 |
|---|---|---|
| `src/agent/`（不存在） | 无新树 | 新设计唯一代码根：`personal-context/`、`model-access/`、`execution-host/`、`contracts/` |
| 十轴预算常量 | 分散在 ADR 与 data-architecture 文字里，代码中无定义 | 唯一定义点 `src/agent/contracts/budget-axes.js`，冻结导出；`bind()` 填 `budget_json`、执行宿主执法都从它读；测试断言仓库内没有第二处字面量 |
| 固定 recipe ID 闭集 | 只在冻结草案里 | 唯一定义点 `src/agent/contracts/recipes.js`，静态注册（ID、版本、输入/输出 Schema、用途、可用工具、执行形态候选） |
| 凭据 | 旧实现从环境读取 | 按档案 main-owned `safeStorage` 槽；renderer 只写新凭据、只读布尔加 scope 枚举；Agent utility 每次调用拿有界副本并尽力清零 |

## 4. 实施阶段

### 阶段 A：先写会红的契约与旅程

先把契约与旅程写成会红的测试，再写实现。**红测不单独提交**，与对应实现同批提交。

1. `src/agent/contracts/`：recipe ID 闭集、四个模型用途、十轴预算、九命令 `configure()` 闭集、六字段能力闭集、四个错误码闭集（10 项任务码、7 项工具码、2 项 `MODEL_CONFIG_*`、9 项处理资格）写成冻结导出，并逐个闭集写「不可扩充、不可跨用」的断言。
2. 四个错误码闭集互不相交的断言：`MODEL_CONFIG_*` 不得出现在 `formal_agent_runs.error_code`；`TOOL_*` 不得出现在任务错误码；任务码不得出现在 `formal_agent_tool_calls.error_code`。
3. `budget-axes.js` 唯一定义点断言：仓库内十个数值各自只有一处字面量。
4. 绑定解析顺序断言：recipe → 用途 → 用途指派 → 回落默认 → 档案 + model → 能力校验 → 预算推导 → 价格解析 → 凭据槽解析；任一步失败即 fail closed 且不进入下一步。
5. Agent digest 断言：RFC 8785 JCS 的 UTF-8 字节做 SHA-256 小写十六进制；键序、Unicode 转义与数字规范化各有向量。
6. 隐私负证据断言：`.artifacts/` 与 `docs/validation/` 的 JSON 不含字幕正文、本地绝对路径、设备名、绝对单调时刻或时钟偏移；现场音频、PCM、WAV 与音频路径零持久化。
7. J21、J22、J24、J25、J26、J27 六条旅程各写一条会红的骨架，断言当前无实现。
8. `test:core` → `test:integration` → `test:evidence` 三道全绿（红测按上一条只在骨架层面红）。

### 阶段 B（S1）：个人上下文模块骨架

**目标**：`ingest`/`resolve`/`manage` 三接口成立，终态会话后只创建一个摄取工作，会话经历记录与个人记忆分流落库。本片**不接模型**：摄取用确定性分流，模型接入留给 S2。

1. migration **v5**：`formal_agent_runs`（identity/recipe/scope/state/lease/attempt/error/requested_by/时间戳；**不含** provider/model——模型事实归 S2 的绑定表）、`formal_agent_run_claim_receipts`、`personal_context_scopes`、`personal_context_items`、`personal_context_revisions`、`personal_context_evidence`、`personal_context_suppressions`、`personal_context_episodes`、`personal_context_deletion_receipts`；`ALTER TABLE session_deletion_tombstones ADD COLUMN deleted_interaction_count / deleted_tool_call_count / deleted_episode_count / deleted_context_evidence_count / deleted_orphan_context_item_count INTEGER NOT NULL DEFAULT 0`。
2. v5 的两处「外键不可用」必须写成事务不变量并各配一条测试，因为追加 migration 无法事后加外键：`personal_context_episodes.interaction_id` 在 v5 时目标表尚不存在（v7 才建），只有 `CHECK` 保证 `source_kind` 与两个来源列恰好一对一；`formal_agent_runs` 与 `agent_model_run_bindings`（v6）之间的「用模型的 recipe 必须有绑定行」同样是事务不变量。
3. v1–v4 逐字节不变断言：SQL 与 checksum 快照比对，任一字节变化即红。
4. `src/agent/personal-context/`：`ingest(source)`、`resolve(request)`、`manage(command)` 三接口 + 内部范围解析、来源引用、水位/digest、去重、冲突 revision、置信、生命周期、预算与省略标记。调用者拿不到 SQLite、不拼条件、不传自由文本。
5. 跨会话范围资格在模块内解析：剔除粒度是会话内的完整提交水位；未定稿尾部按 `not_committed_tail` 剔除；精修覆盖不完整（`N ≠ M`）回落权威原始转写；一个会话内不混合 `raw` 与 `refined`；整会话排除只在 `session_not_terminal`、`no_committed_transcript` 或命中冻结包内部上界（`budget`）时发生。每个剔除都以省略标记进入上下文包。
6. 三层分流：高价值原子信息 → `personal_context_items`；一次性但有意义的轨迹 → `personal_context_episodes`；寒暄、填充、明显识别噪声、无来源推断 → 丢弃。`loopback` 无说话人身份时默认只形成会话或项目范围。
7. 终态会话后**只创建一个** `context.ingest.session` 工作；断言不创建第二、第三个工作，且不创建任何报告。
8. ADR 0012 调度机制原样接线：同一 logical claim attempt 复用冻结请求身份、不接管 receipt 返回的租约、`wakeEpoch` 推进、idle 前临界点复核、`start` 一次、`stop` 终态推进 generation。任务来源改为「一个摄取工作 + 用户请求」。
9. 频道 `agent-context:get-overview`、`agent-context:manage`、`agent-context:changed`；角色 `settings`、`history`。`manage` 命令闭集含查看、修改、删除、休眠、记住、忘记，全部要 `expectedRevision`，失败零写入。
10. 删除语义：删除会话级联删除其经历记录与上下文证据，仅由该会话支持的条目退出检索；删除单条条目是幂等事务（先写不含正文的 suppression，再物理移除条目/revision/evidence），重复用同一 deletion key 只重放计数。
11. 门禁：`test:core` → `test:integration` → `test:evidence`，J21 阻断，并证明字幕系统零回归（`open/append/close/history` 不加载新 store）。

### 阶段 C（S2）：模型接入层

**目标**：`catalog()`/`configure(command)`/`bind(runRequest)` 三接口成立，多档案可配、四用途可绑、凭据按档案入 `safeStorage`。

1. migration **v6**：`agent_model_profiles`、`agent_model_profile_models`（`UNIQUE(profile_id, model_id)`）、`agent_model_purpose_assignments`、`agent_model_run_bindings`（`run_id` 外键指向 v5 的 `formal_agent_runs`，写入后不可改写）。
2. `src/agent/model-access/`：三接口 main-owned。`catalog()` 返回档案、模型、用途投影与凭据布尔；`configure(command)` 九命令闭集（`createProfile`、`updateProfile`、`deleteProfile`、`addModel`、`updateModel`、`removeModel`、`setCredential`、`clearCredential`、`assignPurpose`），全部要 `expectedRevision`，失败零写入，错误只用 `MODEL_CONFIG_INVALID` / `MODEL_CONFIG_REVISION_CONFLICT`，且都不需要重启。
3. `https_origin` 只存 scheme+host+port，exact 校验并拒绝 redirect；`base_path` 独立，默认 `/v1`，不含查询、片段与 `..`。`providerKind` 由 loopback origin 推导，不由厂商名判断。
4. 六字段能力闭集由用户声明或静态预置目录提供，接入层不猜测、不探测、不从模型名推断。只有 `supportsToolCalling` 是硬绑定条件，且只对 Agent Loop 生效；能力不匹配是配置问题，返回 `provider_not_configured`（资格）或 `AGENT_REQUEST_INVALID`（运行），**永不**返回 `AGENT_PROVIDER_UNAVAILABLE`。
5. 凭据：一档案一槽，即使两档案指向同一 origin 也不共享；删除档案在同一事务内删除模型清单与凭据槽。`safeStorage` 不可用时 scope 记为 `session_only`，重启后回落 `absent`。renderer 只写新凭据、只读布尔加 scope 枚举。Agent utility 每次调用拿有界副本并尽力清零。子进程环境只从启动期净化快照构建；启动期无条件删除所有大小写等价的 `DEEPSEEK_API_KEY` 环境键；Pi 的 `envApiKeyAuth()` 禁用。
6. `bind(runRequest)` 按阶段 A 第 4 条的固定顺序解析，产出一行不可变 `agent_model_run_bindings`；调用方只给 recipe 身份与已判定的执行形态，拿不到档案、model、URL、header、预算或凭据。
7. `budget_json` 承载十轴全部数值，单次请求输入 token 轴由 `capability_json.maxInputTokens` 推导，累计计费输出 token 轴受 `maxOutputTokens` 约束。价格：`pricing_source` 与 `pricing_revision` 成对，只允许 `static_catalog` / `profile_override` / 同时为空；同时为空表示无已登记单价，费用估算为空并标记为估算，不显示 0。费用只在 main 计算，Agent utility 只回原始用量与用量来源。
8. 无自动远端目录刷新；`agent-model:pull-remote-catalog` 只在用户触发时拉建议列表，失败零写入，`catalog_revision` 只由用户编辑推进。
9. 频道 `agent-model:get-catalog`、`agent-model:configure`、`agent-model:pull-remote-catalog`、`agent-model:changed`；角色只 `settings`。投影 revision 单调，且必须显式标注用途是「回落默认」还是「单独配置」。
10. 确定性替身：`fauxProvider()` 形状的第一方替身，只在测试构建可达，生产不可达并有断言。
11. 门禁：三道全绿，J25 阻断，字幕系统零回归。

### 阶段 D（S3）：执行宿主单轮 recipe

**目标**：单轮 recipe（问答、信息提取、摘要与总结、文本转换）端到端成立，交互与工具记录落库。

1. migration **v7**：`formal_agent_interactions`（`model_binding_id` 外键指向 v6）、`formal_agent_tool_calls`（`UNIQUE(interaction_id, attempt, call_order)`）。
2. `src/agent/execution-host/`：静态 recipe 注册（ID、版本、输入/输出 Schema、所属用途、可用工具、执行形态候选），单轮路径。recipe 不是插件，没有清单、发现或热重载。
3. 意图收敛：Agent Bar 的自然语言意图收敛到已登记 recipe ID 闭集中的一个；收敛结果对用户可见为产品语言，不暴露 recipe ID。
4. `execution_form` 与 `escalation_reason` 在运行创建期冻结；本片只产生 `single_shot`。
5. 输出 Schema 校验失败为 `AGENT_OUTPUT_INVALID`；模型在工具调用之外产生的中间 assistant 文本零持久化，只在内存中作为本次运行上下文。
6. 取消是终态：协程式取消，`terminal_reason` 覆盖成功、失败与取消，取消允许结果为空但不补造。取消后迟到的模型结果被拒绝且不改写已收束快照。
7. `usage_json` 必带用量来源：provider 返回为 `provider`，否则 `ceil(canonicalUtf8Bytes / 2)` 并标记 `estimated`。`cost_estimate_json` 在运行收束时按绑定的 `pricing_revision` 计算一次并冻结，历史与导出一律不重算。
8. `comparison_group_id` 对同一 `(scope_digest, input_digest)` 稳定，用于同源换模型比价。
9. 交互摄取：交互收束且交互记忆信号提取完成后触发 `context.ingest.interaction`；提示正文在此时删除，只留 digest。信号闭集只含用户提示、用户对结果的明确编辑、接受、拒绝、记住、忘记；点击、停留、滚动、浏览、焦点、复制、内部工具事件与未被采纳的模型输出不形成信号。
10. 频道 `agent-run:get-eligibility`、`agent-run:submit`、`agent-run:cancel`、`agent-run:get-history`、`agent-run:get-interaction`、`agent-run:changed`；角色 `agent`（新增）与 `history`。资格按九值闭集固定顺序在 main 计算，renderer 不自行推断。
11. 门禁：三道全绿，J22 与 J24 的单轮部分阻断，字幕系统零回归。

### 阶段 E（S4）：受控只读工具、Agent Loop 与十轴预算

**目标**：`report.analysis` 与 `plan.proposal` 走有界 Agent Loop，工具与预算执法完整。本片**无新 migration**。

1. 受控只读工具闭集（含 `search_context`、`read_source` 一类）：只读、Schema exact、无 shell/文件/网络/写能力。`search_context` 的 `aliasKeys` 是等值别名匹配，未命中的键以 `unmatchedAliasKeys` 显式回报，不退化为模糊搜索、不扩大范围。
2. 工具错误码闭集七值，独立于任务错误码；`(attempt, call_order)` 全序，自动重试建新 attempt，旧 attempt 记录一律保留。
3. 四条件 AND 升级到 Agent Loop，在运行创建期冻结进 `execution_form` + `escalation_reason`：recipe 是 `report.analysis` 或 `plan.proposal`；冻结范围 ≥2 个终态会话；冻结上下文包命中内部上界；`estimatedInputTokens ≥ 70%` 的预算轴 2。四条件缺一即单轮。
4. 十轴预算执法：轮次上限（单轮 1 / Loop 6）；单次请求输入 token；累计计费输入 ≤120k；累计计费输出 ≤8k；墙钟 60 s 交互 / 180 s 后台；工具调用总数 ≤12；单工具超时 5 s；并行度 1；累计工具结果字节 ≤256 KiB；累计来源正文字节 ≤128 KiB。任一轴触顶为 `AGENT_BUDGET_EXCEEDED`。
5. Pi 接入面：实例级 `Models`（`createModels()`），按 `provider.id` 键入，`setProvider()` 按 id upsert，`getModel(providerId, modelId)`，`createProvider({...})`，`models.streamSimple.bind(models)` 注入 `@earendil-works/pi-agent-core`。禁用面：`providers/all` 的 `builtinModels()`、`/compat`、coding-agent 的 `ModelRuntime`/`ModelRegistry`/`models.json`/`auth.json`/OAuth/home-dir、`envApiKeyAuth()`、`prepareNextTurn` 的换模型路径、gateway routing 字段。MIT 许可声明必须保留。
6. 「一次运行内模型固定」由不实现 `prepareNextTurn` 换模型路径实现，并配一条断言运行中绑定不被改写的测试。
7. 门禁：三道全绿，J22 与 J24 完整阻断，字幕系统零回归。

### 阶段 F（S5）：Agent Bar 与单交互导出

**目标**：正式产品表面成立，导出确定性。本片**无新 migration**。

1. 新 `agent` 角色窗口：可聚焦、不穿透、非模态。理由是字幕窗锁定时恒穿透、工具条窗是窄控制条，二者都不能承载文本输入。窗口生命周期复用现有 `src/main/` 控制器约定。
2. `src/preload/agent.js` + `channels.js`/`access-policy.js` 的 `agent` 角色接线；exact 频道、exact 载荷键。
3. Agent Bar：范围选择（当前选区、终态会话、日期范围、项目）+ 一次自然语言意图；资格不为 `ready` 时显示下一动作而不是灰按钮无解释。
4. 报告自动呈现偏好：默认关闭，只影响以后终态会话，开启后每个满足资格的终态会话至多自动请求并非模态呈现一次会后结构化纪要。无已读/未读、无标记、无角标、无计数；关闭偏好不删除旧报告。renderer reload、重复停止或重复通知不得重复呈现同一 run。
5. 交互历史：时间戳、范围与模型身份、最终结果、默认折叠的完整工具调用记录。不展示提示历史、中间 assistant 文本或内部思维过程。
6. `agent-run:export-interaction`：main-owned 保存对话框；storage worker 从同一 SQLite 快照读取绑定、recipe ID/版本、input digest、执行形态与升级理由、终态理由、用量及来源、冻结费用估算、最终结果与全序工具调用；main 重校验 Schema/digest 后写 canonical 带版本 JSON。用户取消零写入；目标已存在时只有完整新文件可替换；读取/校验/编码/磁盘失败保留旧目标并清理临时文件。同一交互重复导出字节与 SHA-256 相同，价格目录 revision 变更后仍不变。
7. 导出不含提示、reasoning、provider 原始事件、凭据、现场音频、音频路径、本地绝对路径或目标路径。
8. 门禁：三道全绿，J22/J24/J26 阻断，字幕系统零回归。

### 阶段 G（S6）：旧 Agent 锁定在启动路径之外

**目标**：把「旧 Agent 不可达」从偶然状态变成被守住的契约。**无新 migration**，**无运行时行为变更**。

1. J27 守卫：解析产品入口 `src/main.js` 的 require 闭包，断言不到达 `src/agent-core/**`、`src/agent-mvp/**`、`src/agent-provider/**`、`src/agent-runtime/**` 中任何模块；对四棵树各做一次注入式反证（人为 require 后守卫必须变红）。
2. `electron-builder.config.cjs` `files` 追加 `!src/agent-provider/**/*`、`!src/agent-runtime/**/*`；`scripts/verify-package-layout.js` 的前缀白名单同步扩到四棵树，并新增 `src/agent/**` 必须存在的正向断言；`test/validation/b5-packaging-contract.test.js` 同步。
3. 断言产品 storage worker 仍选用 `FORMAL_AGENT_MIGRATIONS`、v3/v4 checksum 逐字节不变、字幕 `open/append/close/history` 不触发 `formal-agent-store` 加载（ADR 0015 第 11 项：这不是启动接线，不得在本片改动）。
4. 断言隔离入口仍可经 `npm run start:agent-mvp` 手动启动，且其 userData 与正式 userData 不相交。
5. 门禁：三道全绿，J27 阻断，字幕系统零回归。

## 5. 验收矩阵

| 切片 | 新 migration | 阻断旅程 | 正证据 | 负证据 |
|---|---|---|---|---|
| S1 个人上下文模块 | v5 | J21 | 一个摄取工作、三层分流、水位级剔除与省略标记、幂等删除 | 不创建第二个自动工作、不创建报告、字幕路径不加载新 store、v1–v4 逐字节不变 |
| S2 模型接入层 | v6 | J25 | 多档案、四用途独立绑定、九命令 revision 守卫、按档案凭据槽 | 凭据不入档案行/SQLite/renderer/日志/报告、无自动远端刷新、能力不匹配不报 `AGENT_PROVIDER_UNAVAILABLE`、环境不再是凭据来源 |
| S3 执行宿主单轮 | v7 | J22（单轮）、J24（单轮） | 意图收敛、Schema 校验、取消为终态、用量来源、冻结费用 | 中间 assistant 文本零持久化、提示正文终态后删除只留 digest、取消不补造结果 |
| S4 工具与 Agent Loop | 无 | J22、J24 | 工具全序与多 attempt 保留、四条件 AND 升级冻结、十轴执法 | 无写类工具、别名不退化为模糊搜索、`envApiKeyAuth()` 与换模型路径不存在、运行中绑定不被改写 |
| S5 Agent Bar 与导出 | 无 | J22、J24、J26 | 默认零报告、偏好只影响以后会话、确定性重导出 | 无未读角标/系统通知/模态/抢焦点、导出不含提示与内部思维过程、重复通知不重复呈现同一 run |
| S6 旧 Agent 锁定 | 无 | J27 | require 闭包守卫、四棵树打包排除、`src/agent/**` 正向存在 | 注入式反证必须变红、v3/v4 checksum 不变、隔离入口仍可手动启动 |

每片都必须依次通过 `npm run test:core` → `npm run test:integration` → `npm run test:evidence`，并附字幕系统零回归证明。任一片不得因后续片未完成而提升状态。

## 6. 风险与回退

| 风险 | 触发形态 | 回退 |
|---|---|---|
| 新旧同类表并存被误用 | 有人往 `agent_jobs`/`memory_evidence` 写新设计行，或往新表写旧设计行 | 各写一条断言：旧表在产品路径上行数恒为 0；新 store 不引用旧表名 |
| v5 的两处外键缺口退化成脏数据 | `personal_context_episodes` 出现 `source_kind` 与来源列不一致的行；用模型的 recipe 没有绑定行 | 事务不变量 + 各一条测试；发现后以追加 migration 加校验表或重建，不静默修数据 |
| 追加 migration 无法事后加外键 | S3 建出交互表后想给 v5 的 `interaction_id` 加外键 | 不加。保持事务不变量，并在 data-architecture 明确标注这是 append-only 的已知代价 |
| 阶段 A 的红测被当成实现证据 | 骨架红测变绿但无真实链路 | 旅程状态只由对应片的 `test:integration` + `test:evidence` 晋级；骨架绿不晋级 |
| 十轴预算出现第二处字面量 | 有人在执行宿主里硬编码超时或字节上限 | 唯一定义点断言（阶段 A 第 3 条）；违反即红 |
| S6 打包排除误伤新树 | 排除规则写成 `!src/agent*` 一类前缀 | 排除规则逐树精确列出，并配 `src/agent/**` 必须存在的正向断言 |
| 隔离入口被顺手删掉 | 有人认为「废案就该删」 | ADR 0015 未选择项明确禁止；J27 断言其仍可手动启动 |
| Agent 失败反传字幕 | 新 store、新 utility 或新窗口异常导致字幕降级 | 每片的零回归证明；SEM-F00 是硬边界，违反即回退该片 |

## 7. 状态晋级与提交边界

- 状态词只用：已决定 / 实现完成·尚未验收 / 联合验收完成 / 实机验收完成 / 发布验收完成。
- 阶段 A 的契约与旅程骨架合并进各自实现片提交，**红测不单独提交**。
- 每片按功能单独提交，subject-only，格式 `type(scope): 中文描述（SEM-xx/Jxx）`。
- 提交时逐路径显式 `git add`，不使用 `git add .`；仓库内仍有来源未逐一归属的未跟踪文件。
- migration 提交必须同批包含 v1–v4 逐字节不变断言的证据。
- 旅程状态晋级到「联合验收完成」需要该片的 `test:integration` + `test:evidence` 双证据；只有单元测试时最多写「实现完成·尚未验收」。
- J23 的既有通过状态不计入本轮任何证据（ADR 0015 第 7 项）。
- `PLAN.md` 只记排期与状态，不重新定义语义。

## 8. 设计依据

- 语义：[`semantic-contract.md`](semantic-contract.md) SEM-F00/F15/F26/F28/F30/F31/F32/F33/F34/F35/T15
- 本轮架构决策：[ADR 0013](adr/0013-agent-deep-modules-and-execution-host.md)（取代 0003）、[ADR 0014](adr/0014-multi-profile-model-access-layer.md)（取代 0011）、[ADR 0015](adr/0015-retire-old-agent-implementation.md)（取代 0007）
- 保留生效的既有决策：[ADR 0001](adr/0001-sqlite-authoritative-event-store.md)、[ADR 0002](adr/0002-separate-subtitle-and-agent-systems.md)、[ADR 0004](adr/0004-immutable-first-pass-and-optional-refinement.md)、[ADR 0005](adr/0005-separate-recognition-and-agent-providers.md)、[ADR 0006](adr/0006-local-structured-personal-memory.md)（第 10 项已由 ADR 0013 第 5 项取代，其余全部不变）、[ADR 0008](adr/0008-terminal-session-agent-job-reconciliation.md)、[ADR 0009](adr/0009-deterministic-agent-input-planning.md)（宿主命名与输入预算来源已由 ADR 0013 修订）、[ADR 0010](adr/0010-separate-isolated-and-formal-agent-migration-catalogs.md)、[ADR 0012](adr/0012-main-owned-agent-job-scheduler.md)
- SQLite 约束：[`data-architecture.md`](data-architecture.md)
- 测试层级与旅程：[`testing-strategy.md`](testing-strategy.md)
- 术语：[`../CONTEXT.md`](../CONTEXT.md)
- 冻结理由留档（非权威）：[`research/fixed-recipe-and-tool-freeze-draft.md`](research/fixed-recipe-and-tool-freeze-draft.md)、[`research/model-access-interface-freeze-draft.md`](research/model-access-interface-freeze-draft.md)、[`research/personal-context-agent-design-draft.md`](research/personal-context-agent-design-draft.md)
- 已整体失效、只作历史留档：[`agent-plugin-architecture.md`](agent-plugin-architecture.md)、[`agent-mvp-todo.md`](agent-mvp-todo.md)、[`agent-mvp-interface-contract.md`](agent-mvp-interface-contract.md)、[`runtime-architecture.md`](runtime-architecture.md) 第 11.2 节的 Agent 部分
