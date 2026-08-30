# 正式 Agent UI → Core contract request 台账

> 状态：已决定 · 2026-08-29
>
> 适用范围：正式 Agent 的设置、字幕历史与 Agent Bar。隔离 Agent 内核开发入口 `src/agent-mvp/**` 不使用本台账。
>
> 权威顺序：[`semantic-contract.md`](semantic-contract.md) → ADR 0013–0015 → [`agent-redesign-execution-plan.md`](agent-redesign-execution-plan.md) → [`testing-strategy.md`](testing-strategy.md) → 本台账。
>
> 本文件只协调 renderer 需要的事实与动作，不定义新的产品语义。新增功能或改变语义时先按 SEM-T06 更新语义合同和用户旅程，再在这里登记 exact contract。

## 1. 使用方式

UI/UX 模型只从冻结 snapshot、CommandResult、事件和 fixture 取得事实。需要 Core 尚未提供的事实或动作时，新增一条 `AUI-CR-*`；renderer 保持显式不可用或省略该入口，直到 Core 签发 contract 与 fixture。

处理流程：

1. UI/UX 写清用户意图、所需事实或动作、缺失时的 fail-closed 表现和受影响 SEM/J。
2. Core owner 判断它是既有语义的投影，还是语义变更。
3. 语义变更先更新 `semantic-contract.md` 与 `testing-strategy.md`；纯投影直接冻结 exact Schema、权限、错误和 revision 规则。
4. Core 提供脱敏 fixture 与负例；UI/UX 消费 fixture，不自行扩展字段。
5. S5-Integration 用真实 preload/exact IPC/SQLite 替换预览 adapter，并在对应 J 旅程中关闭请求。

请求处理值只用于本台账，不代表产品状态：

- `open`：等待 Core 判断。
- `accepted`：需求已决定，exact contract 或 fixture 尚未签发。
- `contract-ready`：exact contract、权限、错误和 fixture 已可消费。
- `consumed`：正式 renderer 已消费，仍等待或已经进入 S5-Integration。
- `rejected`：不符合权威语义；记录理由后停止实现。

## 2. 已决定的交接依赖

这些 seam 已由总体 SPEC 决定，不需要 UI/UX 重复申请；其 exact 字段仍由对应 Core 切片签发。

| Core 切片 | renderer 需要的公开投影/动作 | UI/UX 消费面 | 联合旅程 |
|---|---|---|---|
| S1 | personal-context overview；查看、修改、删除、休眠、记住、忘记；revision conflict；changed revision | 设置、字幕历史 | J21 |
| S2 | 多配置档案、模型清单、凭据存在性与 scope、四用途及回落、九命令结果、用户触发目录建议 | 设置 | J25 |
| S3 | 九值 Agent 处理资格、范围投影、submit/cancel、运行中/终态状态、最小交互历史、结果、`ModelUsageV1`（input/output token，用量来源恒为 `provider`；未返回时整体为 `null` 且界面显示「用量未知」）、可空缓存命中率、相对时长 | Agent Bar、字幕历史 | J22/J24/J25 |
| S4 | 预算耗尽、多 attempt、完整工具调用记录及七值工具错误 | Agent Bar 交互详情 | J22/J24 |
| S5-Core | `agent` 窗口生命周期、正式 preload、changed 订阅、单交互导出结果与保存对话框取消/失败 | Agent Bar、字幕历史 | J21/J22/J24/J25/J26 |

每个切片的 fixture 必须使用合成身份与合成文本，只表达枚举、布尔、计数、相对时长、短 digest 和受控展示内容；不得含凭据、现场音频、音频路径、设备名、本地绝对路径、绝对单调时刻或时钟偏移，也不得含 price/cost/currency/pricing 或任何金额字段（SEM-F33、[ADR 0014](adr/0014-multi-profile-model-access-layer.md) 第 11 项）。

> **2026-08-30 执行路径修订对本台账的影响**：按 [ADR 0016](adr/0016-unified-agent-execution-path.md)，`single_shot` / `agent_loop` 二分、升级理由与运行期形态判定全部取消，UI 不再需要、也不得呈现执行形态或升级理由；所有 recipe 共用同一产品语言，轮次上限与工具授权是内部登记事实，不进入任何投影。按 [ADR 0017](adr/0017-retire-confirmed-recognition-terms.md)，确认关键词退出首版范围，设置界面不得出现任何把个人记忆转换成识别关键词的入口。fixture preview 不是 `.artifacts/` 或 `docs/validation/` 证据。

## 3. 请求模板

复制下面模板，并保持一条请求只解决一个用户意图：

```markdown
### AUI-CR-000 · 简短标题

- 处理值：open
- 提出面：settings / history / agent
- 用户意图：
- 需要的事实或动作：
- 缺失时的 fail-closed 表现：
- 受影响语义/旅程：SEM-__ / J__
- 建议的成功 fixture：
- 建议的失败 fixture：
- Core 判断：待填写
- exact contract：待填写
- S5-Integration 证据：待填写
```

## 4. 当前请求

下列请求由 2026-08-29 的 UX-1 交付（[`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) §11，设置 · 个人上下文管理）提出。Core 已于 2026-08-30 以 `speech-agent.personal-context.ui@1.0.0` 签发 exact contract 与 preview-only fixture；请求进入 `contract-ready`，但仍未构成正式 renderer 消费或 J21 联合证据。

### AUI-CR-001 · 个人记忆条目的有界浏览投影

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想看看我现在有哪些个人记忆，并从列表里选一条来修改、停用或删除。
- 需要的事实或动作：`查看` 命令返回一页有界个人记忆条目，每条至少含稳定标识、范围类型（全局/会话/主题/项目）、条目类型（七值闭集）、来源（明确内容/自动推断）、生命周期、来源引用条数、更新时间、可展示正文，以及该条目当前 revision（供写动作携带 `expectedRevision`）；页级含固定排序与 `hasMore`。若允许按闭集维度筛选，需在载荷中冻结允许的枚举字段。
- 缺失时的 fail-closed 表现：个人记忆分区只显示通用不可用说明，不显示任何条目行，不提供修改/停用/删除动作。
- 受影响语义/旅程：SEM-F30 / SEM-T15 / J21
- 建议的成功 fixture：合成条目跨四种范围类型与多个条目类型；一页触达上界且 `hasMore=true`；一页为空。
- 建议的失败 fixture：载荷含额外键被拒；`settings` 之外角色被拒；返回值含未登记枚举值。
- Core 判断：既有 S1 语义的 projection 扩展；本版本冻结 `MemoryItem`、20 条上界、opaque cursor 与 Core-owned 稳定排序，不增加筛选或任意排序。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5–§6；`src/agent/contracts/agent-context-ui.js`；`manage-view-ready.json` / `overview-empty.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-002 · 会话经历记录的有界浏览与省略标记投影

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想知道某段时间、某个会话或某个项目发生了什么，而不是只看一堆原子事实。
- 需要的事实或动作：`查看` 命令返回一页有界会话经历记录，每条至少含稳定标识、来源种类（会话 / 正式 Agent 交互）、来源范围标识、发生时间范围（相对偏移，不含绝对单调时刻）、有界结构化轨迹的可展示投影、来源引用条数、生命周期，以及是否存在省略标记（首个需要的值是未提交尾部 `not_committed_tail`）；页级含固定排序与 `hasMore`。
- 缺失时的 fail-closed 表现：会话经历记录分区只显示通用不可用说明；不用个人记忆条目冒充经历记录，也不由缺少字段推断"没有省略"。
- 受影响语义/旅程：SEM-F26 / SEM-F30 / J21
- 建议的成功 fixture：会话来源与交互来源各一条；一条带省略标记；一页触达上界；一页为空。
- 建议的失败 fixture：轨迹超出有界预算被拒；来源种类与来源标识不一致；返回值含未登记省略标记值。
- Core 判断：既有 SEM-F26/SEM-F30 的 projection 扩展；公开值只含相对偏移、有界 `title + bullets`、来源计数与 `budget` / `not_committed_tail`，不复制整场正文。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §6.2–§6.3；`manage-view-episodes-ready.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-003 · 个人记忆处理状态与自动处理边界的可读投影

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想知道现在还在不在处理个人记忆，以及重新开启后哪些会话会被处理、哪些不会。
- 需要的事实或动作：overview snapshot 含当前处理档位（处理中 / 休眠）的枚举，以及个人记忆自动处理边界的可展示投影，用于说明"休眠期间与更早的会话不会补处理"。`休眠` 命令的 CommandResult 需返回收束后的同一档位。边界只需相对表达，不需要绝对时刻。
- 缺失时的 fail-closed 表现：处理状态区只显示由 `休眠` 命令回执得到的当前档位，不显示任何边界说明，也不声明关闭期间会不会补处理。
- 受影响语义/旅程：SEM-F30 / SEM-F31 / J21
- 建议的成功 fixture：处理中；休眠；休眠后重新开启并携带新的边界投影。
- 建议的失败 fixture：切换命令 revision conflict 零写入；档位为未登记值。
- Core 判断：既有 SEM-F30/SEM-F31 projection；公开档位为 `enabled` / `suspended`，自动处理边界只用 `current_effective_cycle` / `not_established` 相对表达，不公开 scheduler 状态。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §4、§5、§7；`overview-suspended.json` / `manage-set-processing-result.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-004 · 「忘记」与「删除」的作用对象差异

- 处理值：contract-ready
- 提出面：settings
- 用户意图：界面给我两个动作时，我需要知道它们分别对我的数据做了什么不同的事。
- 需要的事实或动作：明确 `忘记` 与 `删除` 的作用对象差异。当前权威文档只把两者并列在 `manage` 闭集里，没有区分二者对正文保留、来源引用、生命周期、抑制事实与经历记录的影响。UI/UX 的读法是：`忘记` 使条目退出检索而不改写来源历史，`删除` 先写不含正文的抑制再物理移除条目、revision 与来源引用；这一读法需要 Core 确认或纠正。
- 缺失时的 fail-closed 表现：界面只保留一个已被明确定义的动作，另一个入口缺席；[`agent-ui-ux-handoff.md`](agent-ui-ux-handoff.md) §11.4 的两组候选文案不进入 renderer。不使用「清除记忆」这类同时覆盖两种语义的说法。
- 受影响语义/旅程：SEM-F30 / SEM-F14 / J21
- 建议的成功 fixture：忘记后条目仍可见且标注退出检索；删除后条目消失且不回显正文。
- 建议的失败 fixture：对同一条目先忘记再删除；对已删除条目再次忘记。
- Core 判断：已确认二者是独立动作，并按 SEM-T06 在 SEM-F30 与 J21 S1 子边界登记：`忘记` 退出检索但保留条目、revision、来源引用与会话经历记录，且自动摄取不得恢复；`删除` 先写不含正文的 suppression，再物理移除条目、revision 与 evidence。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5–§8；`manage-forget-result.json` / `manage-delete-result.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-005 · 删除与忘记回执的作用对象计数

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我删掉一条个人记忆后，想确认到底移除了什么，并且重复操作时不要让我以为又删了一遍。
- 需要的事实或动作：删除类 CommandResult 返回按作用对象分类的计数（条目、修改历史、来源引用等已登记类别），以及一个"本次为重放、计数与首次相同"的显式标志。计数只表达数量，不含被删除正文。
- 缺失时的 fail-closed 表现：回执只显示通用「已删除」，不报告任何计数，也不区分首次与重放；界面不从列表长度差推断删除了什么。
- 受影响语义/旅程：SEM-F14 / SEM-F30 / J21
- 建议的成功 fixture：首次删除返回各类计数；同一删除幂等键重放返回同一组计数并带重放标志。
- 建议的失败 fixture：删除命令 revision conflict 零写入；删除不存在的条目。
- Core 判断：删除回执返回 `items/revisions/evidence` 与 `replayed`；忘记不删除这些对象，因此不返回删除计数，而返回生命周期为 `forgotten` 且来源计数不变的 `MemoryItem`。二者不得共用成功形状。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §6.3；`manage-delete-result.json` / `manage-forget-result.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

### AUI-CR-006 · 设置内「记住」的结构化输入形式

- 处理值：contract-ready
- 提出面：settings
- 用户意图：我想在设置里直接记住一条长期上下文，而不必先跑一次 Agent 交互。
- 需要的事实或动作：`记住` 命令在 `settings` 角色下可接受的结构化输入形式。已知约束是 renderer 不得提交自由文本记忆行，且条目匹配只使用 NFKC + casefold 后全等的结构化键与已登记别名——因此需要 Core 说明用户在设置里通过哪些受控字段构造一条条目，以及这些字段的枚举与长度边界；或者裁定设置界面不承载 `记住`，该动作只从 Agent Bar 的结果上下文发起。
- 缺失时的 fail-closed 表现：设置界面不提供「记住」入口（入口缺席而非禁用按钮），也不提供任何自由文本记忆输入框。
- 受影响语义/旅程：SEM-F30 / SEM-F32 / J21
- 建议的成功 fixture：一条经受控字段构造的合成条目被接受。
- 建议的失败 fixture：自由文本命令类型被拒零写入；载荷含额外键被拒；同一结构化键与已有条目冲突。
- Core 判断：设置与字幕历史均可提供结构化 `记住`。本条已按 SEM-T06 登记；输入恰含可展示内容、七值条目类型、四值范围与 NFKC + casefold 规范化语义键。它不接受自由文本命令或数据库行，也不影响识别 provider——按 ADR 0017，产品不存在把个人记忆转换成识别关键词的入口。
- exact contract：[`agent-context-ui-contract.md`](agent-context-ui-contract.md) §5.1；`manage-remember-processing.json` / `manage-remember-result.json` / `manage-validation-error.json`。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；fixture 不构成 J21 证据。

下列三条由 2026-08-30 的正式 renderer 消费（设置 · 个人上下文）提出。Core 已于同日全部裁定并进入 `accepted`：AUI-CR-009 只需补齐 1.0.0 已声明但未实现的行为，字段形状不变；AUI-CR-007 与 AUI-CR-008 需要 `speech-agent.personal-context.ui@1.1.0`（移除 renderer 提交的 `semantic_key`、新增有界范围目录投影），随 S3 的 v7 一并签发。在新合同签发前，renderer 保持各条已登记的 fail-closed 表现。

### AUI-CR-007 · 结构化「记住」语义键的来源规则

- 处理值：accepted
- 提出面：settings
- 用户意图：我在设置里记住一条内容时，只想写下内容本身，不想再手填一个用来匹配条目的键。
- 需要的事实或动作：`StructuredEntry.semantic_key` 是必填字段，合同只约束它「非空、≤ 256 UTF-8 bytes、提交前已完成 NFKC + casefold」，没有规定它由谁产生。renderer 当前从可展示正文派生（NFKC + casefold + 首尾去空白 + 按码点边界截到 256 bytes 内），这会让匹配键随正文改写而改变，也让「已登记别名」无从表达。需要 Core 裁定三者之一：(a) 确认由 renderer 按上述规则派生，并冻结该规则；(b) 由 Core 在写入侧派生，renderer 提交的值仅作提示；(c) 语义键属于受控输入，需要单独的用户可见字段与其枚举/长度边界。
- 缺失时的 fail-closed 表现：设置界面不提供任何语义键输入或别名管理入口，也不宣称「同一条会被识别为同一条」；派生规则只在提交前生效，界面不回显该键。
- 受影响语义/旅程：SEM-F30 / SEM-F32 / J21
- 建议的成功 fixture：正文改写后语义键的期望取值（按裁定结果给出）；全角与合字正文各一条。
- 建议的失败 fixture：载荷携带 `semantic_key` 被拒零写入；与既有条目语义键全等时的收束形状。
- Core 判断：**采纳方案 (b)，由 Core 在写入侧派生。** 理由是 SEM-F30 已把「去重、冲突 revision、生命周期」划归个人上下文模块内部策略，匹配键属于该策略而不属于 renderer；方案 (a) 会让匹配键随正文改写而漂移，同一事实分裂成两条；方案 (c) 会把内部匹配机制暴露给普通用户。派生规则冻结在 storage worker：可展示正文 → NFKC → casefold → 折叠连续空白为单个 U+0020 → 首尾去空白 → 按 code point 边界截到 ≤256 UTF-8 字节且不切断 surrogate pair。`semantic_key` **从 renderer 提交载荷中移除**，界面不回显该键，也不提供别名管理入口（别名登记是模块内部事实）。正文改写走 `manage` 的修改命令并在同一事务内重算键，键改变时按既有冲突 revision 规则收束。
- exact contract：需 `speech-agent.personal-context.ui@1.1.0`——移除 `StructuredEntry.semantic_key` 是对 1.0.0 的破坏性变更；规则文本见 [`data-architecture.md`](data-architecture.md) §5。待 S3 随 v7 一并签发。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；须含「正文改写后同一条目不分裂」的正证据。

### AUI-CR-008 · 非全局范围在设置里没有可选的范围标识

- 处理值：accepted
- 提出面：settings
- 用户意图：我想记住「只在这个项目里生效」的偏好，而不是所有场合都生效。
- 需要的事实或动作：`scope.kind` 是四值闭集（`global` / `session` / `topic` / `project`），非 `global` 时需要 `scope.reference`。但 overview snapshot 与 `view` 投影都不提供一份可选的范围标识清单：条目上的 `scope.reference` 只能读，无法据此为一条新条目挑选范围。需要 Core 提供「当前可作为范围标识的有界闭集投影」（稳定 opaque 标识 + 可展示名称），或裁定设置界面只承载 `global`。
- 缺失时的 fail-closed 表现：设置界面的「记住」只构造 `global`（`scope.reference` 为 `null`），并明说这条在所有场合生效；不提供范围选择控件，也不把已有条目的 `scope.reference` 回填给新条目。
- 受影响语义/旅程：SEM-F30 / SEM-F32 / J21
- 建议的成功 fixture：一页可选范围标识（会话/主题/项目各一），含稳定标识与可展示名称；清单为空。
- 建议的失败 fixture：`scope.reference` 指向不存在的标识被拒零写入；`global` 携带非 `null` reference 被拒。
- Core 判断：**提供有界范围目录投影，且保留全部四个范围入口。** overview snapshot 增加一份有界范围目录（稳定 opaque 标识 + 可展示名称 + `kind`），`view` 与「记住」据此挑选范围。范围**只由摄取自动形成**（`personal_context_scopes.origin='automatic'`），首版不新增「创建范围」命令——SEM-F26 已规定「模型可提出主题/项目范围；名称不稳定时保留会话范围，范围合并必须由用户确认」，即范围本就是自动形成加用户确认的对象，不是用户从零创建的对象。`topic` / `project` 入口保留：清单为空时显示明确的空状态说明（例如「还没有可选的项目范围」），**不隐藏入口、不放置无法选出结果的下拉框**。同一份投影同时服务 Agent Bar 的范围选择，使「项目」这一范围在 Agent Bar 与设置页取得同一事实来源。
- exact contract：需 `speech-agent.personal-context.ui@1.1.0` 增加范围目录投影；与 AUI-CR-007 同批签发。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；须含空清单与非空清单两条正证据。

### AUI-CR-009 · `view` 的分页续读当前无法推进

- 处理值：accepted
- 提出面：settings
- 用户意图：我的记录超过一页时，我想接着往下看，而不是只被告知「还有更多」。
- 需要的事实或动作：`view` 请求含 `cursor` 与 `limit`，响应含 `next_cursor` 与 `has_more`；但把 `next_cursor` 回传并不会推进 —— S1 控制器在 `src/agent/personal-context/controller.js` 里按固定上界取一页快照，`view` 不消费 `cursor` 也不消费 `limit`，因此续读请求返回同一页。需要 Core 让 `view` 真正消费 opaque cursor 与 limit，或裁定 1.0.0 的分页字段在 S1 只作前向兼容占位。
- 缺失时的 fail-closed 表现：`has_more=true` 时只显示「还有更多记录未载入。」，不提供载入更多入口，也不用 `next_cursor` 发起第二次读取；界面不声明列表已完整。
- 受影响语义/旅程：SEM-F30 / J21
- 建议的成功 fixture：第一页 `has_more=true` + 携带其 `next_cursor` 的第二页返回不同条目；末页 `has_more=false`。
- 建议的失败 fixture：伪造或过期 cursor 被拒；`limit` 越界被拒。
- Core 判断：**采纳方案 (a)，`view` 必须真正消费 cursor 与 limit。** 方案 (b) 会让个人记忆超过 20 条后其余条目永久不可见，与 SEM-F30 对 `manage` 「查看」的承诺直接冲突。这是一处 Core 缺陷而非 renderer 缺陷：`src/agent/personal-context/controller.js` 的 `view()` 既不消费 `command.cursor` 也不消费 `command.limit`，快照固定以 `limit: 20, cursor: null` 取一页，`next_cursor` 恒为 `offset_${n}`。修复范围是 storage worker 的排序键 + 控制器 + renderer「载入更多」三处。**游标改为 keyset 而非 offset**：按 `(updated_at DESC, 稳定 ID)` 复合排序，游标是对最后一行该复合键的不透明编码，续读条件为严格小于该键；v7 追加对应索引（见 [`data-architecture.md`](data-architecture.md) §5）。offset 游标在并发写入下会跳行或重复，明确禁用。
- exact contract：`speech-agent.personal-context.ui@1.0.0` 的字段形状不变（`cursor` / `limit` / `next_cursor` / `has_more` 与 `has_more ⇔ next_cursor !== null` 的不变量已正确），只是行为必须补齐；游标编码格式改变但字段仍为不透明字符串。
- S5-Integration 证据：待真实 preload / exact IPC / SQLite 联合旅程收束；须含「第二页返回不同条目」与「并发插入不跳行不重复」两条正证据。

## 5. 关闭检查

一条请求进入 `consumed` 或在 S5-Integration 中收束前，逐项核对：

- 字段和动作存在唯一 Core 定义点，renderer 没有同义枚举或错误判断。
- access policy、preload、payload exact 校验和 observer revision 已同步。
- 成功、缺失、revision conflict、取消、失败和 renderer reload 至少各有适用 fixture。
- UI 的下一动作来自 Core 投影，不从异常字符串、等待时长、DOM 顺序或 ID 猜测。
- fixture 不被计入 J21/J22/J24/J25/J26 证据。
- 对应确定性联合旅程使用真实内部模块，只替代已登记外部边界。
