# Agent 重设计实现执行计划

> 状态：已决定 · 2026-08-29
> 权威要求：[SEM-F00](semantic-contract.md)、SEM-F15、SEM-F26、SEM-F28、SEM-F30、SEM-F31、SEM-F32、SEM-F33、SEM-F34、SEM-F35、SEM-T15
> 用户旅程：[J3、J21、J22、J24、J25、J26、J27](testing-strategy.md)
> 架构决策：[ADR 0013](adr/0013-agent-deep-modules-and-execution-host.md)（两个深模块与执行宿主）、[ADR 0014](adr/0014-multi-profile-model-access-layer.md)（多档案模型接入层）、[ADR 0015](adr/0015-retire-old-agent-implementation.md)（旧实现锁定在启动路径之外）
> 本文是 Agent 重设计第三轮的实现 SPEC：它把 ADR 0013–0015 的决策落成切片、迁移、接口与 todo list。它**不重新定义语义**；与 `semantic-contract.md` 冲突时以语义合同为准。
> 冻结理由留档见 [`research/fixed-recipe-and-tool-freeze-draft.md`](research/fixed-recipe-and-tool-freeze-draft.md)（第一轮：固定 recipe 与工具）与 [`research/model-access-interface-freeze-draft.md`](research/model-access-interface-freeze-draft.md)（第二轮：模型接入接口）。两份草案已回填，不再是权威来源。
> 2026-08-29 项目负责人已确认：S1 的三个测试 seam 与保守无模型分流基线；S5 使用新 `agent` 窗口角色；十轴预算只在 `src/agent/contracts/budget-axes.js` 定义；S3/S4 复用 J22/J24 子边界；`runtime-architecture.md` §11.2 延至 S3/S4 形成真实运行时后重写。
> 2026-08-29 项目负责人进一步确认：Agent 重设计采用 Core 与 UI/UX 两条工作线；UI/UX 设计可与 S1–S4 并行，但正式 renderer 只在对应 Core contract 与 fixture 冻结后接入，并于 S5 与真实 preload/IPC/SQLite 汇合。正式交接见 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md)，contract request 台账见 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md)。

## 1. 目标结果

实施完成后必须同时取得以下用户可观察结果：

1. 用户在设置里管理**多个** OpenAI-compatible 模型配置档案，每个档案是一个受信任连接加一份凭据加一组 model；DeepSeek 只提供可修改、可删除的空 model provider 模板，不是唯一选项或默认绑定。
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

### 2.1 实施所有权：一条权威主干、两条工作线

`semantic-contract.md`、本 SPEC 与 `testing-strategy.md` 继续构成唯一产品权威。工作按所有权分成两条线，不形成第二套语义，也不新增同义用户旅程：

| 工作线 | 拥有内容 | 不拥有内容 |
|---|---|---|
| **Core** | S1–S4、S6；S5 的 BrowserWindow、`agent` 角色、preload、exact IPC、存储、导出、失败隔离与联合旅程 | 视觉语言、信息层级、组件外观与动效取舍 |
| **UI/UX** | 设置、历史与 Agent Bar 的信息架构、状态矩阵、文案、renderer DOM/CSS、可访问性、深浅色/高对比/reduced motion | `src/agent/**` 深模块、main/preload、SQLite、凭据、预算、错误分类、窗口安全和打包 |

Core 负责签发 renderer-facing contract 与合成 fixture；UI/UX 只消费这些事实并经 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md) 提出缺口。fixture 只用于设计预览和局部渲染测试，不构成 J21/J22/J24/J25/J26 的确定性联合旅程证据。

### 2.2 UI/UX 交接门

下列 `UX-*` 只是工作流标签，不是用户旅程 ID、状态或新的实现切片：

| 门 | 进入条件 | UI/UX 交付 | 退出条件 |
|---|---|---|---|
| `UX-0` 交接复位 | 本 SPEC 与 SEM-F30–F35 已决定 | 读取当前 handoff，明确正式 Agent 与隔离 Agent 内核开发入口的边界 | 不再引用 2026-08-09 旧 Agent 信息架构或 `src/agent-mvp/**` 作为正式产品实现 |
| `UX-1` 流程设计 | S1/S2 contract 方向已登记 | 个人上下文管理、模型配置档案与四个模型用途的流程、状态矩阵和 contract requests | 每个展示事实都能映射到已决定 contract 或一个登记请求 |
| `UX-2` Agent Bar 设计 | S3/S4 contract 方向已登记 | 范围选择、提交、取消、结果、交互历史、工具调用记录和报告呈现流程 | 所有 recipe 共用同一产品语言，不暴露 recipe ID、轮次上限、工具授权、内部思维过程或调试入口 |
| `UX-3` renderer 实现 | 对应 Core contract、错误码与 fixture 已冻结 | 只在获批 renderer 路径实现 DOM/CSS/view-model 与可访问性 | fixture 矩阵覆盖正常、空、pending、取消、失败、reload、深浅色、高对比与 reduced motion |
| `UX-4` S5 汇合 | S1–S4 Core 子边界与 UI renderer 均可组合 | 用真实 preload/exact IPC/SQLite 替换预览 adapter并关闭已接受 contract requests | J21/J22/J24/J25/J26 以真实内部模块组成确定性联合旅程；预览 fixture 不计作证据 |

UX 设计稿、截图、fixture preview 或局部 renderer 回归都不晋级任何 J 旅程。只有 S5 汇合后的真实产品路径可以晋级相应旅程。

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
| 固定 recipe ID 闭集 | 只在冻结草案里 | 唯一定义点 `src/agent/contracts/recipes.js`，静态注册（ID、版本、输入/输出 Schema、用途、轮次上限、工具授权） |
| 凭据 | 旧实现从环境读取 | 按档案 main-owned `safeStorage` 槽；renderer 只写新凭据、只读布尔加 scope 枚举；Agent utility 每次调用拿有界副本并尽力清零 |

## 4. 实施阶段

### 阶段 A：跨切片 TDD 清单

阶段 A 只负责把测试责任分配给 S1–S6，**不形成独立的批量红测阶段**。每个 tracer bullet 都按「一个已确认 seam 的行为测试变红 → 最小实现转绿 → 定向回归」闭合后，才进入下一条；红测不单独提交，也不允许 J21–J27 骨架长期留红。

| 切片 | 随该片进入 red → green 的测试责任 |
|---|---|
| S1 | `context.ingest.session`、十值任务错误码、九值 Agent 处理资格、个人上下文 exact 命令；RFC 8785 JCS digest；v1–v4 SQL/checksum；个人上下文三接口、调度生命周期、J21 的 S1 子边界与隐私负扫描 |
| S2 | 四个模型用途、九条 `configure()` 命令、六字段能力、两个 `MODEL_CONFIG_*` 错误；固定绑定解析顺序、凭据槽和 J25 的 S2 Core 子边界 |
| S3 | 十一个已登记 recipe 的 ID/版本/轮次上限/工具授权快照、两层意图收敛与 `routing_mode`、输入输出 Schema、取消终态、`ModelUsageV1`；统一 Agent Loop 生命周期与静态授权检查；J22/J24 的执行宿主子边界。两个工具的 exact Schema、范围校验、adapter 与十轴执法归 S4 |
| S4 | 七值工具错误码与任务码隔离；`budget-axes.js` 十轴数值唯一定义、`maxTurns` 取自 recipe 登记、十轴执法；两个只读工具的 exact Schema 与 `maxResultBytes`；J22/J24 的工具与预算子边界 |
| S5 | S5-Core 的新 `agent` 角色、preload/exact IPC 与 J26 导出；S5-UX 的 Agent Bar/settings/history renderer；S5-Integration 对 J21/J22/J24/J25/J26 的真实产品组合 |
| S6 | J27 require 图、四棵旧树的打包排除、`src/agent/**` 正向存在与注入式反证 |

所有切片都沿用同一条隐私负证据：`.artifacts/` 与 `docs/validation/` 的 JSON 不含字幕正文、本地绝对路径、设备名、绝对单调时刻或时钟偏移；现场音频、PCM、WAV 与音频路径零持久化。每个切片交接时三条 lane 必须全绿；局部 red 只存在于正在处理的单个 TDD 循环中。

### 阶段 B（S1）：个人上下文模块骨架

**目标**：`ingest`/`resolve`/`manage` 三接口成立，新执行宿主具备 `FormalAgentJobScheduler.start()` / `wake(reason)` / `stop()` 调度 seam，且会话经历记录与明确用户控制产生的个人记忆分流落库。本片**不接模型**：在 S2 提供真实模型接入事实前，产品资格保持 `provider_not_configured`，不得伪造 `ready` 或声称完整 J21。

1. migration **v5**：`formal_agent_runs`（identity/recipe/scope/state/lease/attempt/error/requested_by/时间戳；**不含** provider/model——模型事实归 S2 的绑定表）、`formal_agent_run_claim_receipts`、`personal_context_scopes`、`personal_context_items`、`personal_context_revisions`、`personal_context_evidence`、`personal_context_suppressions`、`personal_context_episodes`、`personal_context_deletion_receipts`；`ALTER TABLE session_deletion_tombstones ADD COLUMN deleted_interaction_count / deleted_tool_call_count / deleted_episode_count / deleted_context_evidence_count / deleted_orphan_context_item_count INTEGER NOT NULL DEFAULT 0`。
2. v5 的两处「外键不可用」必须写成事务不变量并各配一条测试，因为追加 migration 无法事后加外键：`personal_context_episodes.interaction_id` 在 v5 时目标表尚不存在（v7 才建），只有 `CHECK` 保证 `source_kind` 与两个来源列恰好一对一；`formal_agent_runs` 与 `agent_model_run_bindings`（v6）之间的「用模型的 recipe 必须有绑定行」同样是事务不变量。
3. v1–v4 逐字节不变断言：SQL 与 checksum 快照比对，任一字节变化即红。
4. `src/agent/personal-context/`：`ingest(source)`、`resolve(request)`、`manage(command)` 三接口 + 内部范围解析、来源引用、水位/digest、去重、冲突 revision、置信、生命周期、预算与省略标记。调用者拿不到 SQLite、不拼条件、不传自由文本。
5. 跨会话范围资格在模块内解析：剔除粒度是会话内的完整提交水位；未定稿尾部按 `not_committed_tail` 剔除；精修覆盖不完整（`N ≠ M`）回落权威原始转写；一个会话内不混合 `raw` 与 `refined`；整会话排除只在 `session_not_terminal`、`no_committed_transcript` 或命中冻结包内部上界（`budget`）时发生。每个剔除都以省略标记进入上下文包。
6. 保守无模型分流：非空终态会话最多形成一条不复制整场正文的有界会话经历记录；只有用户经 `manage` 提交的 exact「记住」/修改命令可以建立或修订个人记忆。S1 不从任意字幕正文发明关键词、正则或模糊分类规则，也不自动产生个人记忆条目；寒暄、填充、明显识别噪声、无来源推断和无效结构化输入进入丢弃/拒绝路径。`loopback` 无说话人身份时默认只形成会话或项目范围。
7. 为后续真实 `ready` 产品路径建立幂等创建合同：同一冻结来源身份至多创建一个 `context.ingest.session` 工作，不创建第二、第三个工作或任何报告。S1 的产品组合只证明 `provider_not_configured` 时零自动运行；调度正路径通过真实新 store 中的受控运行 fixture 验证，不向产品资格组合器注入假 `ready`。
8. ADR 0012 调度机制是**新实现**而非旧代码接线：新 `FormalAgentJobScheduler` 放在 `src/agent/execution-host/`，同一 logical claim attempt 复用冻结请求身份、不接管 receipt 返回的租约、`wakeEpoch` 推进、idle 前临界点复核、`start` 一次、`stop` 终态推进 generation。仓库当前没有该实现；旧 `FormalAgentRuntime`、旧 `AgentJobRunner` 与旧三任务 store 不得复用、改造或适配。
9. 频道 `agent-context:get-overview`、`agent-context:manage`、`agent-context:changed`；角色 `settings`、`history`。`manage` 命令闭集含查看、修改、删除、休眠、记住、忘记，全部要 `expectedRevision`，失败零写入。
10. 删除语义：删除会话级联删除其经历记录与上下文证据，仅由该会话支持的条目退出检索；删除单条条目是幂等事务（先写不含正文的 suppression，再物理移除条目/revision/evidence），重复用同一 deletion key 只重放计数。
11. 门禁：`test:core` → `test:integration` → `test:evidence`，登记并阻断 J21 的 S1 子边界，同时证明字幕系统零回归（`open/append/close/history` 不加载新 store）。该子边界不提升完整 J21；S1 状态最多为「实现完成·尚未验收」。

### 阶段 C（S2）：模型接入层

**目标**：`catalog()`/`configure(command)`/`bind(runRequest)` 三接口成立，多档案可配、四用途可绑、凭据按档案入 `safeStorage`。

1. migration **v6**：只追加 `agent_model_profiles`、`agent_model_profile_models`（`UNIQUE(profile_id, model_id)`）、四行常驻的 `agent_model_purpose_assignments`、`agent_model_run_bindings`（`run_id` 外键指向 v5 `formal_agent_runs`，写入后不可改写）；v1–v5 字节不变，v6 执行失败回滚并只降级 model-access。
2. `src/agent/model-access/`：三接口 main-owned。`catalog()` 返回档案、模型、用途投影与凭据布尔；`configure(command)` 九命令闭集（`createProfile`、`updateProfile`、`deleteProfile`、`addModel`、`updateModel`、`removeModel`、`setCredential`、`clearCredential`、`assignPurpose`），全部要 `expectedRevision`，失败零写入，错误只用 `MODEL_CONFIG_INVALID` / `MODEL_CONFIG_REVISION_CONFLICT`，且都不需要重启。
3. `https_origin` 只存 scheme+host+port，exact 校验并拒绝 redirect；`base_path` 独立，默认 `/v1`，不含查询、片段与 `..`。`providerKind` 由 loopback origin 推导，不由厂商名判断。
4. 六字段能力闭集只由用户完整确认并经 `addModel/updateModel` 写入；模板/远端目录只返回可空建议。只有 `supportsToolCalling` 是硬绑定条件，且只对 Agent Loop 生效；能力不匹配是配置问题，返回 `provider_not_configured`（资格）或 `AGENT_REQUEST_INVALID`（运行），**永不**返回 `AGENT_PROVIDER_UNAVAILABLE`。
5. 凭据：一档案一槽，即使两档案指向同一 origin 也不共享；删除档案在同一事务内删除模型清单与凭据槽。`safeStorage` 不可用时 scope 记为 `session_only`，重启后回落 `absent`。renderer 只写新凭据、只读布尔加 scope 枚举。Agent utility 每次调用拿有界副本并尽力清零。子进程环境只从启动期净化快照构建；启动期无条件删除所有大小写等价的 `DEEPSEEK_API_KEY` 环境键；Pi 的 `envApiKeyAuth()` 禁用。
6. `bind(runRequest)` exact 只含 `runId/recipeId/recipeVersion/executionForm`；它在同一 SQLite 事务验证一个既有真实 v5 formal run 的 recipe/version，按固定顺序解析并插入或逐字段重放一行不可变 binding，不负责创建 run。
7. `budget_json` 承载十轴全部数值，单次请求输入 token 轴由 `capability_json.maxInputTokens` 推导，累计输出 token 轴受 `maxOutputTokens` 约束。产品不建立 price/cost/currency/pricing 字段；`ModelUsageV1` 只保留 input/output token、恒为 `provider` 的用量来源与可空 cache-hit/cache-miss input token（用量未知时整体为 `null`），缓存命中率满足一致性条件时派生且不持久化。
8. 无自动远端目录刷新；`agent-model:pull-remote-catalog` 是三接口外的 main application adapter，只返回瞬时建议和 `success/revision_conflict/invalid_request/credential_unavailable/redirect_rejected/remote_unavailable` 六值状态，零写入、零 revision、零 changed。
9. 频道 `agent-model:get-catalog`、`agent-model:configure`、`agent-model:pull-remote-catalog`、`agent-model:changed`；角色只 `settings`。get-catalog 使用 exact `{ok,snapshot,error}` envelope，初始化降级唯一读取错误为 `MODEL_ACCESS_UNAVAILABLE`；snapshot revision 单调并显式标注 direct/fallback_default/unconfigured。
10. 首次 v6 只播种 `deepseek-openai-template@1`：官方 origin 与 `/`、空 model/用途、凭据 absent；当前 alias 与四个布尔能力只作瞬时建议，两个 token 上限为 null，用户删除模板后不重建。向 UI/UX 签发上述状态、九命令、revision、credential scope、用途回落、六值 remote pull 和 token/cache fixture；全部 `previewOnly=true` 且不构成 J25 证据。
11. 确定性替身：`fauxProvider()` 形状的第一方替身，只在测试构建可达，生产不可达并有断言。
12. 门禁：三道全绿，登记并阻断 J25 的 S2 Core 子边界，字幕系统零回归。设置 renderer 尚未在 S5 汇合前，S2 状态最多为「实现完成·尚未验收」。

### 阶段 D（S3）：执行宿主与统一 recipe 执行路径

**目标**：十一个已登记 recipe 的统一执行路径端到端成立，交互与工具记录落库。执行差异只来自登记表的轮次上限与工具授权（[ADR 0016](adr/0016-unified-agent-execution-path.md)）；S3 建立路径、0 工具运行与静态授权快照，但不拥有任一工具的参数/返回值 Schema、范围读取或 adapter。`search_context`、`read_sources` 与完整工具预算执法都留给 S4。

1. migration **v7**，恰好四组内容（详见 [`data-architecture.md`](data-architecture.md) §5）：`formal_agent_interactions`（`run_id` 唯一并外键指向 v5 `formal_agent_runs`，**不引入 `model_binding_id`**——模型事实经同一 `run_id` 关联 v6 绑定表；含 `max_turns`/`tool_grants_json` 登记快照，**无 `execution_form`、无 `escalation_reason`**）、`formal_agent_tool_calls`（`UNIQUE(interaction_id, attempt, call_order)`，args ≤8 KiB / result ≤64 KiB 由 `CHECK (length(CAST(... AS BLOB)) <= N)` 直接执法）、`formal_agent_report_presentations`（`session_id` 作主键，使「每个终态会话至多自动呈现一次」成为结构性不变量）、以及一列 tombstone 计数与四条分页/全序索引。v1–v6 SQL/checksum 逐字节不变。
2. `src/agent/execution-host/`：静态 recipe 注册（ID、版本、输入/输出 Schema、所属用途、**轮次上限**、**工具授权**），以及包裹 Pi `agentLoop()` 的唯一执行路径；S3 只把登记快照交给该路径，S4 才提供工具 contract、adapter 与 `config.shouldStopAfterTurn` 所需的完整十轴执法。recipe 不是插件，没有清单、发现或热重载。
3. 意图收敛（[ADR 0018](adr/0018-two-tier-intent-convergence.md)，两层机制）：先创建第十一个已登记 recipe `intent.route` 的运行（`maxTurns=1`、`toolGrants=[]`、默认用途、输出 Schema 恰好 `{ recipeId, confidence }`）由模型判定；资格不为 `ready`、以 `AGENT_PROVIDER_*`/`AGENT_OUTPUT_INVALID`/`AGENT_BUDGET_EXCEEDED`/`AGENT_WORKER_EXITED`/`AGENT_INTERNAL_FAILURE` 收束、或返回闭集外 `recipeId` 时，回落到按范围与受控关键词判定的确定性规则，全部不匹配收敛到 `qa.answer`——收敛没有失败态。用户取消不触发兜底。`routing_mode`（`model/rules/preset`）写入交互行。`context.ingest.*` 与自动纪要请求记 `preset`，不创建 `intent.route` 运行，自动路径运行数不变。收敛结果对用户可见为产品语言并允许改选，改选按「取消当前运行 + 新建运行」处理；界面不暴露 recipe ID、confidence 或 `routing_mode`。
4. 不存在执行形态判定与升级理由。`max_turns` 与 `tool_grants_json` 在运行创建期从登记表快照进交互行，使审计在登记表未来变更后仍可复现；`bind()` 的 `executionForm` 只提交 `'agent_loop'`，`agent_model_run_bindings.execution_form` 因此恒为常量。`context.ingest.session` 与 `context.ingest.interaction` 的 runner 采用两段式：先以零模型调用建立会话经历记录的时间范围、来源引用、输入水位与 digest，再进入同一循环由模型提炼个人记忆条目；确定性前段位于 recipe 内部，不构成第二条执行路径，S1 已有的运行/租约/幂等机制不推倒重来。
5. 输出 Schema 校验失败为 `AGENT_OUTPUT_INVALID`；模型在工具调用之外产生的中间 assistant 文本零持久化，只在内存中作为本次运行上下文。
6. 取消是终态：协程式取消，`terminal_reason` 覆盖成功、失败与取消，取消允许结果为空但不补造。取消后迟到的模型结果被拒绝且不改写已收束快照。
7. `usage_json` 可空，非空时必须通过 `ModelUsageV1` 且用量来源恒为 `provider`。**provider 未返回可用 usage、或 model 的 `usageReporting` 为 false 时写 `NULL`——不估算、不补造 token 数**，界面与导出显示「用量未知」。`MODEL_USAGE_SOURCES` 相应从 `['provider','estimated']` 收窄为 `['provider']`；这是把合同拉回既有实现，`normalizeDeepSeekUsage()` 本就在 usage 缺失或 `usageReporting=false` 时返回 `null`，仓库内没有任何代码产生过 `estimated`。缓存字段仍只在 hit+miss 大于零且等于 input token 时非空。不计算金额。
8. `comparison_group_id` 对同一 `(scope_digest, input_digest)` 稳定，用于同源换模型比价。
9. 交互摄取：交互收束且交互记忆信号提取完成后触发 `context.ingest.interaction`；提示正文在此时删除，只留 digest。信号闭集只含用户提示、用户对结果的明确编辑、接受、拒绝、记住、忘记；点击、停留、滚动、浏览、焦点、复制、内部工具事件与未被采纳的模型输出不形成信号。
10. 频道 `agent-run:get-eligibility`、`agent-run:submit`、`agent-run:cancel`、`agent-run:get-history`、`agent-run:get-interaction`、`agent-run:changed`；角色 `agent`（新增）与 `history`。资格按九值闭集固定顺序在 main 计算，renderer 不自行推断。
11. 向 UI/UX 工作线签发范围、九值资格、pending/取消/失败/终态、最小交互历史、token/缓存未知等 fixture；不在 fixture 中保存金额、提示正文、内部思维过程或 provider 原始事件。
12. 门禁：三道全绿，复用 J22 与 J24 的执行宿主 Core 子边界，不新增同义旅程，字幕系统零回归。`runtime-architecture.md` §11.2 仍不在本片开始前预写；待 S3/S4 真实运行时形成后一次性重写。

### 阶段 E（S4）：受控只读工具与十轴预算执法

**目标**：两个只读工具、七值工具错误码、全序审计与十轴预算执法完整，`report.analysis` 与 `plan.proposal` 的 6 轮双工具档位成立。本片**无新 migration**。

S4 可以先签发纯 `src/agent/contracts/` 的 exact validator、预算判断与 preview fixture；该准备层不拥有 tool adapter、Pi 接线、storage 写入、IPC 或 renderer，不能冒充本片完整运行时证据。

1. 受控只读工具闭集为 `search_context` 与 `read_sources`：只读、Schema exact、无 shell/文件/网络/写能力。`search_context` 的 `aliasKeys` 是等值别名匹配，未命中的键以 `unmatchedAliasKeys` 显式回报，不退化为模糊搜索、不扩大范围。
2. 工具错误码闭集七值，独立于任务错误码；`(attempt, call_order)` 全序，自动重试建新 attempt，旧 attempt 记录一律保留。
3. 三档轮次上限与工具授权由登记表静态给出，运行期零判定：1 轮 0 工具（`intent.route`、`text.rewrite`、`text.translate`）；3 轮 `search_context`（`qa.answer`、`extract.items`、`summary.minutes`、`text.enhance`、`context.ingest.session`、`context.ingest.interaction`）；6 轮 `search_context`+`read_sources`（`report.analysis`、`plan.proposal`）。`supportsToolCalling` 只对工具授权非空的 recipe 是硬绑定条件，工具授权为空的 recipe 不要求该能力，使不支持工具调用的 model 仍可用于文本变换用途。越权调用未授权工具以 `TOOL_NOT_AVAILABLE_FOR_RECIPE` 拒绝且不执行。
4. 十轴预算执法：轮次上限（取自 recipe 登记，1 / 3 / 6）；单次请求输入 token；累计计费输入 ≤120k；累计计费输出 ≤8k；墙钟 60 s 交互 / 180 s 后台；工具调用总数 ≤12；单工具超时 5 s；并行度 1；累计工具结果字节 ≤256 KiB；累计来源正文字节 ≤128 KiB。任一轴触顶为 `AGENT_BUDGET_EXCEEDED`。
5. Pi 接入面：实例级 `Models`（`createModels()`），按 `provider.id` 键入，`setProvider()` 按 id upsert，`getModel(providerId, modelId)`，`createProvider({...})`，`models.streamSimple.bind(models)` 注入 `@earendil-works/pi-agent-core`。禁用面：`providers/all` 的 `builtinModels()`、`/compat`、coding-agent 的 `ModelRuntime`/`ModelRegistry`/`models.json`/`auth.json`/OAuth/home-dir、`envApiKeyAuth()`、`prepareNextTurn` 的换模型路径、gateway routing 字段。MIT 许可声明必须保留。
6. 「一次运行内模型固定」由不实现 `prepareNextTurn` / `prepareNextTurnWithContext` 换模型路径实现，并配一条断言运行中绑定不被改写的测试。恢复不使用 `agentLoopContinue()`：按 SEM-F28 保留旧 attempt 的工具调用记录后，在同一 `runId`、同一绑定、同一冻结输入下整体重跑并递增 attempt。
7. 向 UI/UX 工作线签发 Agent Loop、预算耗尽、多 attempt、工具调用记录折叠/展开、工具失败和取消终态 fixture；工具正文只使用合成内容，fixture preview 不进入 `.artifacts/` 或 `docs/validation/`。
8. 门禁：三道全绿，复用 J22 与 J24 的工具与预算 Core 子边界，不新增同义旅程，字幕系统零回归；本片收束时与 S3 一并重写 `runtime-architecture.md` §11.2。

### 阶段 F（S5）：Agent Bar 与单交互导出

**目标**：Core 安全边界、UI/UX renderer 与真实产品旅程在本片汇合，正式产品表面成立且导出确定性。本片**无新 migration**。

#### S5-Core：窗口、契约与导出

1. 按已确认裁决新增 `agent` 角色窗口：可聚焦、不穿透、非模态。理由是字幕窗锁定时恒穿透、工具条窗是窄控制条，二者都不能承载文本输入。窗口生命周期复用现有 `src/main/` 控制器约定。
2. `src/preload/agent.js` + `channels.js`/`access-policy.js` 的 `agent` 角色接线；exact 频道、exact 载荷键。窗口角色、preload 和 sender 校验由 Core 拥有，不交给 UI/UX 模型修改。
3. `agent-run:export-interaction`：main-owned 保存对话框；storage worker 从同一 SQLite 快照读取绑定、recipe/input/终态身份、`ModelUsageV1`、可空缓存命中率、相对时长、最终结果与全序工具调用；main 重校验 Schema/digest 后写 canonical 带版本 JSON。用户取消零写入；目标已存在时只有完整新文件可替换；读取/校验/编码/磁盘失败保留旧目标并清理临时文件。同一交互重复导出字节与 SHA-256 相同，且不包含金额字段。
4. 导出不含提示、reasoning、provider 原始事件、凭据、现场音频、音频路径、本地绝对路径或目标路径。

#### S5-UX：正式 renderer

5. UI/UX 模型只依据 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md)、已冻结 contract 与 fixture 实现设置、历史和 Agent Bar renderer；生产路径使用新的正式 renderer 根，`src/agent-mvp/**` 保持隔离 Agent 内核开发入口，不作为模板、adapter 或正式依赖。
6. Agent Bar：范围选择（当前选区、终态会话、日期范围、项目）+ 一次自然语言意图；资格不为 `ready` 时显示后端给出的下一动作。界面不暴露 recipe ID、adapter、factory、IPC channel、内部思维过程或调试聊天。
7. 报告自动呈现偏好：默认关闭，只影响以后终态会话，开启后每个满足资格的终态会话至多自动请求并非模态呈现一次会后结构化纪要。无已读/未读、无标记、无角标、无计数；关闭偏好不删除旧报告。renderer reload、重复停止或重复通知不得重复呈现同一 run。
8. 交互历史：时间戳、范围与模型身份、最终结果、默认折叠的完整工具调用记录；终态详情在导出动作旁提示文件含完整工具输入与结果。不展示提示历史、中间 assistant 文本或内部思维过程。

> 2026-08-30 追加记录（不提升本阶段状态）：设置 renderer 的「Agent 模型配置档案」类别已按第 5 条接入 `agent-model-ui@1.0.0` exact contract 与既有 `src/preload/settings.js` facade，覆盖配置档案增删改、model 增删改、凭据设置/清除、四用途分配、远端目录建议预填及其失败/冲突/隐私负路径；未新增 IPC channel，未改动 main/preload/SQLite。详见 `agent-ui-ux-handoff.md` §12 与 `testing-strategy.md` 的 J25 S2 Core 子边界追记。Agent Bar（第 6–7 条）与交互历史/导出（第 8 条）仍未实现；本记录不构成 S5-Integration，也不提升 S2 或完整 J25。

#### S5-Integration：真实产品汇合

9. 由 Core owner 用真实 preload/exact IPC/个人上下文模块/Agent 模型接入层/执行宿主/storage worker/SQLite 替换 UI 预览 adapter；UI fixture 继续只服务视觉预览，不进入联合证据。
10. settings renderer 闭合 J21 的管理 UI 与 J25 的多档案/四用途路径；Agent Bar/history renderer 闭合 J22/J24；保存对话框与同一 SQLite 快照闭合 J26。
11. 门禁：三道全绿，J21/J22/J24/J25/J26 阻断，字幕系统零回归。任何单独的 S5-Core 或 S5-UX 结果最多写「实现完成·尚未验收」；只有 S5-Integration 的真实内部模块组合才可晋级对应旅程。

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
| S1 个人上下文模块 | v5 | J21 子边界 | 三接口、保守会话经历记录、调度生命周期、水位级剔除与省略标记、明确用户控制产生的个人记忆、幂等删除 | `provider_not_configured` 时零自动运行、不伪造 `ready`、不从任意正文自动臆测个人记忆、不创建报告、字幕路径不加载新 store、v1–v4 逐字节不变 |
| S2 模型接入层 | v6 | J25 Core 子边界 | 多档案、四用途独立绑定、九命令 revision 守卫、按档案凭据槽与 renderer fixture | 凭据不入档案行/SQLite/renderer/日志/报告、fixture 不冒充 J25、无自动远端刷新、能力不匹配不报 `AGENT_PROVIDER_UNAVAILABLE`、环境不再是凭据来源 |
| S3 执行宿主与统一执行路径 | v7 | J22/J24 执行宿主 Core 子边界 | 两层意图收敛（模型判定 + 规则兜底 + `routing_mode`）、十一 recipe 登记表（轮次上限/工具授权）快照进交互行、Schema 校验、取消为终态、两段式摄取、`ModelUsageV1` 与 renderer fixture | 无执行形态判定与 `escalation_reason`、中间 assistant 文本零持久化、提示正文终态后删除只留 digest、fixture 不含金额或提示正文、取消不补造结果 |
| S4 受控只读工具与预算执法 | 无 | J22/J24 工具与预算 Core 子边界 | 工具全序与多 attempt 保留、三档轮次上限与工具授权按登记表执法、`maxResultBytes` 与字节子预算、十轴执法与 renderer fixture | 无写类工具、别名不退化为模糊搜索、工具授权为空的 recipe 留下空工具记录、fixture preview 不进入证据、运行中绑定不被改写 |
| S5-Core / S5-UX / S5-Integration | 无 | J21、J22、J24、J25、J26 | 新 `agent` 角色、正式 renderer、默认零报告、偏好只影响以后会话、真实模块汇合与确定性重导出 | 不接旧 `agent-mvp`、无未读角标/系统通知/模态/抢焦点、导出不含提示与内部思维过程、重复通知不重复呈现同一 run |
| S6 旧 Agent 锁定 | 无 | J27 | require 闭包守卫、四棵树打包排除、`src/agent/**` 正向存在 | 注入式反证必须变红、v3/v4 checksum 不变、隔离入口仍可手动启动 |

每片都必须依次通过 `npm run test:core` → `npm run test:integration` → `npm run test:evidence`，并附字幕系统零回归证明。任一片不得因后续片未完成而提升状态。

2026-08-30：S1 个人上下文模块与 S2 Agent 模型接入层 Core 子边界的状态均为「实现完成·尚未验收」。S2 已追加 v6，建立 main-owned 三接口、九命令、四用途、每档案 vault、不可变 binding、exact IPC/preload、token/cache 合同与 test-only `fauxProvider()`；DeepSeek 仍只是空 model 模板，零真实公网推理。最终 core 694/694、evidence 233/233；integration 的 S1/S2 联合测试自身返回 0，整条 lane 为 69/77，8 项失败均位于既有 Electron/utility 子进程旅程并伴随 Windows GPU `exit_code=-1073741515` 或子进程报告缺失；完整 `npm test` 因同一 integration 环境问题停止。此记录不升级完整 J21/J25；正式 settings renderer、Agent Bar、S3/S4、S5 历史/导出与真实公网能力仍未实现。

## 6. 风险与回退

| 风险 | 触发形态 | 回退 |
|---|---|---|
| 新旧同类表并存被误用 | 有人往 `agent_jobs`/`memory_evidence` 写新设计行，或往新表写旧设计行 | 各写一条断言：旧表在产品路径上行数恒为 0；新 store 不引用旧表名 |
| v5 的两处外键缺口退化成脏数据 | `personal_context_episodes` 出现 `source_kind` 与来源列不一致的行；用模型的 recipe 没有绑定行 | 事务不变量 + 各一条测试；发现后以追加 migration 加校验表或重建，不静默修数据 |
| 追加 migration 无法事后加外键 | S3 建出交互表后想给 v5 的 `interaction_id` 加外键 | 不加。保持事务不变量，并在 data-architecture 明确标注这是 append-only 的已知代价 |
| 阶段 A 被误做成批量红测 | J21–J27 骨架同时常红，或测试只断言“当前无实现” | 阶段 A 只分配责任；每片一个 tracer bullet 立即 red → green，旅程状态只由对应片的真实 `test:integration` + `test:evidence` 证据晋级 |
| 十轴预算出现第二处字面量 | 有人在执行宿主里硬编码超时或字节上限 | 唯一定义点断言（阶段 A 第 3 条）；违反即红 |
| S6 打包排除误伤新树 | 排除规则写成 `!src/agent*` 一类前缀 | 排除规则逐树精确列出，并配 `src/agent/**` 必须存在的正向断言 |
| 隔离入口被顺手删掉 | 有人认为「废案就该删」 | ADR 0015 未选择项明确禁止；J27 断言其仍可手动启动 |
| 2026-08-09 UI handoff 被继续执行 | UI 模型恢复旧三任务、调试聊天、单一 provider 或修改 `src/agent-mvp/**` | 当前 [`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) 明确替代旧版；正式 renderer 只消费 SEM-F30–F35 与新 contract fixture |
| UI 与 Core contract 漂移 | renderer 自造字段、错误可重试性、成功状态或直接修改 preload/IPC | 所有缺口进入 [`agent-ui-contract-requests.md`](agent-ui-contract-requests.md)；Core 签发 exact contract 与 fixture 后 UI 再消费 |
| Agent 失败反传字幕 | 新 store、新 utility 或新窗口异常导致字幕降级 | 每片的零回归证明；SEM-F00 是硬边界，违反即回退该片 |

## 7. 状态晋级与提交边界

- 状态词只用：已决定 / 实现完成·尚未验收 / 联合验收完成 / 实机验收完成 / 发布验收完成。
- 阶段 A 只提供跨切片清单；每个 tracer bullet 与使其转绿的最小实现归入对应切片，**红测不单独提交**。
- 每片按功能单独提交，subject-only，格式 `type(scope): 中文描述（SEM-xx/Jxx）`。
- 提交时逐路径显式 `git add`，不使用 `git add .`；仓库内仍有来源未逐一归属的未跟踪文件。
- migration 提交必须同批包含 v1–v4 逐字节不变断言的证据。
- 旅程状态晋级到「联合验收完成」需要该片的 `test:integration` + `test:evidence` 双证据；只有单元测试时最多写「实现完成·尚未验收」。
- UX 设计稿、截图、fixture preview、视觉回归和单独 renderer 回归都不构成用户旅程；S2–S4 的 Core 子边界及 S5-Core/S5-UX 单独交付最多写「实现完成·尚未验收」。
- J23 的既有通过状态不计入本轮任何证据（ADR 0015 第 7 项）。
- `PLAN.md` 只记排期与状态，不重新定义语义。

## 8. 设计依据

- 语义：[`semantic-contract.md`](semantic-contract.md) SEM-F00/F15/F26/F28/F30/F31/F32/F33/F34/F35/T15
- 本轮架构决策：[ADR 0013](adr/0013-agent-deep-modules-and-execution-host.md)（取代 0003）、[ADR 0014](adr/0014-multi-profile-model-access-layer.md)（取代 0011）、[ADR 0015](adr/0015-retire-old-agent-implementation.md)（取代 0007）
- 保留生效的既有决策：[ADR 0001](adr/0001-sqlite-authoritative-event-store.md)、[ADR 0002](adr/0002-separate-subtitle-and-agent-systems.md)、[ADR 0004](adr/0004-immutable-first-pass-and-optional-refinement.md)、[ADR 0005](adr/0005-separate-recognition-and-agent-providers.md)、[ADR 0006](adr/0006-local-structured-personal-memory.md)（第 10 项已由 ADR 0013 第 5 项取代，其余全部不变）、[ADR 0008](adr/0008-terminal-session-agent-job-reconciliation.md)、[ADR 0009](adr/0009-deterministic-agent-input-planning.md)（宿主命名与输入预算来源已由 ADR 0013 修订）、[ADR 0010](adr/0010-separate-isolated-and-formal-agent-migration-catalogs.md)、[ADR 0012](adr/0012-main-owned-agent-job-scheduler.md)
- SQLite 约束：[`data-architecture.md`](data-architecture.md)
- 测试层级与旅程：[`testing-strategy.md`](testing-strategy.md)
- 正式 Agent UI/UX 交接：[`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md)
- UI → Core contract request：[`agent-ui-contract-requests.md`](agent-ui-contract-requests.md)
- 术语：[`../CONTEXT.md`](../CONTEXT.md)
- 冻结理由留档（非权威）：[`research/fixed-recipe-and-tool-freeze-draft.md`](research/fixed-recipe-and-tool-freeze-draft.md)、[`research/model-access-interface-freeze-draft.md`](research/model-access-interface-freeze-draft.md)、[`research/personal-context-agent-design-draft.md`](research/personal-context-agent-design-draft.md)
- 已整体失效、只作历史留档：[`agent-plugin-architecture.md`](agent-plugin-architecture.md)、[`agent-mvp-todo.md`](agent-mvp-todo.md)、[`agent-mvp-interface-contract.md`](agent-mvp-interface-contract.md)、[`runtime-architecture.md`](runtime-architecture.md) 第 11.2 节的 Agent 部分
